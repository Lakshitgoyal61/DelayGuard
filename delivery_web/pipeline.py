"""Two-stage delivery delay pipeline, following amazn_ml_model_2026(refined).ipynb.

Stage 1: XGBoost, On-Time vs Late (threshold 0.42 by default).
Stage 2: XGBoost (and a Random Forest for comparison), At Risk vs Delayed, trained on late orders.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix,
                             f1_score, roc_auc_score, roc_curve)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder

RANDOM_STATE = 42
TARGET_SOURCE = "time_buffer_hours"
CLASSES = ["On-Time", "At Risk", "Delayed"]

# Columns that describe the outcome (or identify the row) and must never be model inputs.
OUTCOME_COLS = ["time_buffer_hours", "delivery_time_hours", "actual_delivery_timestamp",
                "expected_delivery_timestamp", "delivery_status", "delivery_id"]
PROMISED_COL = "expected_time_hours"   # promised duration: known at booking

MODES = {
    "deployable": "Deployable (no leakage)",
    "notebook": "Reproduce notebook (evaluation only)",
}

# Expected direction of each feature's effect on "Delayed" for the Stage 2 monotone constraints.
MONOTONE = {"distance_km": 1, "traffic_index": 1, "hub_dwell_minutes": 1, "driver_delay_rate": 1,
            "traffic_pressure": 1, "reliability_risk": 1, "vehicle_reliability": -1}


def read_table(data: bytes, name: str) -> pd.DataFrame:
    if name.lower().endswith((".xlsx", ".xls")):
        df = pd.read_excel(io.BytesIO(data))
    else:
        df = pd.read_csv(io.BytesIO(data))
    df.columns = df.columns.str.strip().str.lower()
    return df


def three_class(tb: pd.Series) -> pd.Series:
    return pd.Series(np.select([tb < 0, tb <= 3], [0, 1], 2), index=tb.index)


def engineer(df: pd.DataFrame, mode: str) -> pd.DataFrame:
    """Add the six engineered features. `df` must already be imputed."""
    out = df.copy()
    if mode == "notebook":
        out["sla_time_hours"] = np.abs(out[TARGET_SOURCE]) + out["distance_km"] / 40
    elif PROMISED_COL in out.columns:
        out["sla_time_hours"] = out[PROMISED_COL] + out["distance_km"] / 40
    out["order_density"] = out["order_volume"] / (out["distance_km"] + 1)
    out["cost_intensity"] = out["delivery_cost"] / (out["order_volume"] + 1)
    out["traffic_pressure"] = out["traffic_index"] * out["hub_dwell_minutes"]
    out["reliability_risk"] = out["driver_delay_rate"] * (1 - out["vehicle_reliability"])
    out["distance_cost_interaction"] = out["distance_km"] * out["delivery_cost"]
    return out


@dataclass
class Trained:
    mode: str
    raw_num: list
    raw_cat: list
    num_cols: list
    cat_cols: list
    medians: dict
    categories: dict
    ranges: dict
    encoder: OneHotEncoder
    feature_names: list
    stage1: xgb.XGBClassifier
    stage2: xgb.XGBClassifier
    rf2: RandomForestClassifier
    threshold: float
    data: pd.DataFrame
    metrics: dict = field(default_factory=dict)
    notes: list = field(default_factory=list)

    # ---------- inference ----------
    def transform(self, raw: pd.DataFrame) -> np.ndarray:
        df = raw.copy()
        df.columns = df.columns.str.strip().str.lower()
        for c in self.raw_num:
            df[c] = pd.to_numeric(df.get(c), errors="coerce").fillna(self.medians[c]) if c in df else self.medians[c]
        for c in self.raw_cat:
            df[c] = df[c].fillna("unknown").astype(str).str.strip().str.lower() if c in df else "unknown"
        df = engineer(df, self.mode)
        return np.hstack([df[self.num_cols].astype(float).values,
                          self.encoder.transform(df[self.cat_cols])])

    def predict(self, raw: pd.DataFrame, threshold: float | None = None) -> pd.DataFrame:
        thr = self.threshold if threshold is None else threshold
        X = self.transform(raw)
        p_late = self.stage1.predict_proba(X)[:, 1]
        stage2 = self.rf2 if self.metrics.get("stage2_choice") == "rf" else self.stage2
        p_del_given_late = stage2.predict_proba(X)[:, 1]
        late = p_late > thr
        label = np.where(~late, 0, np.where(p_del_given_late > 0.5, 2, 1))
        return pd.DataFrame({
            "prediction": [CLASSES[i] for i in label],
            "p_on_time": 1 - p_late,
            "p_at_risk": p_late * (1 - p_del_given_late),
            "p_delayed": p_late * p_del_given_late,
            "p_late_stage1": p_late,
        }, index=raw.index)

    def contributions(self, raw: pd.DataFrame, stage: int = 1) -> pd.DataFrame:
        """TreeSHAP contributions (log-odds), one-hot columns summed back to their source column."""
        X = self.transform(raw)
        model = self.stage1 if stage == 1 else self.stage2
        dm = xgb.DMatrix(X, feature_names=self.feature_names)
        contrib = model.get_booster().predict(dm, pred_contribs=True)[:, :-1]
        cdf = pd.DataFrame(contrib, columns=self.feature_names, index=raw.index)
        grouped = {}
        for c in self.cat_cols:
            members = [f for f in self.feature_names if f.startswith(c + "_")]
            grouped[c] = cdf[members].sum(axis=1)
        for c in self.num_cols:
            grouped[c] = cdf[c]
        return pd.DataFrame(grouped)


def evaluate_threshold(arrays: dict, threshold: float) -> dict:
    """Stage 1 and end-to-end scores for a different Stage 1 threshold, without retraining."""
    p1, y1, p2, y3 = arrays["p1"], arrays["y1"], arrays["p2_all"], arrays["y3"]
    pred1 = (p1 > threshold).astype(int)
    pred3 = np.where(pred1 == 0, 0, np.where(p2 > 0.5, 2, 1))
    return {
        "stage1": {"accuracy": accuracy_score(y1, pred1), "macro_f1": f1_score(y1, pred1, average="macro"),
                   "cm": confusion_matrix(y1, pred1, labels=[0, 1]),
                   "report": classification_report(y1, pred1, labels=[0, 1], target_names=["On-Time", "Late"],
                                                   output_dict=True, zero_division=0)},
        "end_to_end": {"accuracy": accuracy_score(y3, pred3), "macro_f1": f1_score(y3, pred3, average="macro"),
                       "cm": confusion_matrix(y3, pred3, labels=[0, 1, 2]),
                       "report": classification_report(y3, pred3, labels=[0, 1, 2], target_names=CLASSES,
                                                       output_dict=True, zero_division=0)},
    }


def _stage2_constraints(feature_names: list) -> str:
    return "(" + ",".join(str(MONOTONE.get(f, 0)) for f in feature_names) + ")"


def train(df_raw: pd.DataFrame, mode: str = "deployable", threshold: float = 0.42) -> Trained:
    if TARGET_SOURCE not in df_raw.columns:
        raise ValueError(f"The data needs a '{TARGET_SOURCE}' column to build the target labels.")
    df = df_raw.copy()
    df.columns = df.columns.str.strip().str.lower()
    notes = []

    num_all = df.select_dtypes(include=np.number).columns
    cat_all = df.select_dtypes(exclude=np.number).columns
    medians = df[num_all].median().to_dict()
    df[num_all] = df[num_all].fillna(df[num_all].median())
    df[cat_all] = df[cat_all].fillna("unknown")
    for c in cat_all:
        df[c] = df[c].astype(str).str.strip().str.lower()

    tb = df[TARGET_SOURCE]
    y1 = (tb >= 0).astype(int)
    y2 = (tb > 3).astype(int)
    y3 = three_class(tb)

    drop = list(OUTCOME_COLS)
    if mode == "notebook":
        drop.append(PROMISED_COL)
        notes.append("sla_time_hours is built from |time_buffer_hours| as in the notebook. "
                     "This reuses the target's source, so scores are optimistic and the model "
                     "cannot score new orders.")
    elif PROMISED_COL not in df.columns:
        notes.append(f"No '{PROMISED_COL}' column found, so sla_time_hours is left out.")
    else:
        notes.append("sla_time_hours = promised delivery time + distance / 40 (no outcome information).")

    raw_cols = [c for c in df.columns if c not in drop]
    raw_num = [c for c in raw_cols if c in num_all]
    raw_cat = [c for c in raw_cols if c in cat_all]
    required = {"distance_km", "order_volume", "delivery_cost", "traffic_index",
                "hub_dwell_minutes", "driver_delay_rate", "vehicle_reliability"}
    missing = required - set(raw_num)
    if missing:
        raise ValueError("Missing numeric columns: " + ", ".join(sorted(missing)))

    feats = engineer(df, mode)
    eng = [c for c in ["sla_time_hours", "order_density", "cost_intensity", "traffic_pressure",
                       "reliability_risk", "distance_cost_interaction"] if c in feats.columns]
    num_cols = raw_num + eng
    cat_cols = raw_cat

    idx_train, idx_test = train_test_split(df.index, test_size=0.30, random_state=RANDOM_STATE, stratify=y1)
    encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    encoder.fit(feats.loc[idx_train, cat_cols])
    feature_names = num_cols + list(encoder.get_feature_names_out(cat_cols))

    def mat(idx):
        return np.hstack([feats.loc[idx, num_cols].astype(float).values, encoder.transform(feats.loc[idx, cat_cols])])

    Xtr, Xte = mat(idx_train), mat(idx_test)
    y1tr, y1te = y1.loc[idx_train].values, y1.loc[idx_test].values

    stage1 = xgb.XGBClassifier(n_estimators=500, max_depth=6, learning_rate=0.04, subsample=0.9,
                               colsample_bytree=0.9, min_child_weight=10, gamma=1.0, scale_pos_weight=2.8,
                               eval_metric="logloss", random_state=RANDOM_STATE, n_jobs=-1)
    stage1.fit(Xtr, y1tr)

    late_tr, late_te = y1tr == 1, y1te == 1
    X2tr, X2te = Xtr[late_tr], Xte[late_te]
    y2tr, y2te = y2.loc[idx_train].values[late_tr], y2.loc[idx_test].values[late_te]

    rf2 = RandomForestClassifier(n_estimators=650, max_depth=18, min_samples_leaf=12, min_samples_split=20,
                                 max_features="sqrt", class_weight={0: 1.0, 1: 2.2},
                                 random_state=RANDOM_STATE, n_jobs=-1)
    rf2.fit(X2tr, y2tr)

    pos = max(int((y2tr == 1).sum()), 1)
    xgb2_params = dict(n_estimators=220, learning_rate=0.045, max_depth=3, min_child_weight=35, gamma=2.5,
                       subsample=0.65, colsample_bytree=0.65, reg_alpha=4.0, reg_lambda=8.0,
                       scale_pos_weight=int((y2tr == 0).sum()) / pos, objective="binary:logistic",
                       eval_metric="logloss", random_state=RANDOM_STATE, n_jobs=-1)
    stage2 = xgb.XGBClassifier(monotone_constraints=_stage2_constraints(feature_names), **xgb2_params)
    stage2.fit(X2tr, y2tr)

    # ---------- evaluation ----------
    p1 = stage1.predict_proba(Xte)[:, 1]
    pred1 = (p1 > threshold).astype(int)
    p2x = stage2.predict_proba(X2te)[:, 1]
    p2r = rf2.predict_proba(X2te)[:, 1]
    pred2x, pred2r = (p2x > 0.5).astype(int), (p2r > 0.5).astype(int)

    def stage_block(y, pred, prob, names):
        rep = classification_report(y, pred, target_names=names, output_dict=True, zero_division=0)
        fpr, tpr, _ = roc_curve(y, prob)
        return {"accuracy": accuracy_score(y, pred), "macro_f1": f1_score(y, pred, average="macro"),
                "auc": roc_auc_score(y, prob), "report": rep, "cm": confusion_matrix(y, pred),
                "roc": (fpr, tpr), "n": len(y)}

    s2x = stage_block(y2te, pred2x, p2x, ["At Risk", "Delayed"])
    s2r = stage_block(y2te, pred2r, p2r, ["At Risk", "Delayed"])
    choice = "rf" if s2r["macro_f1"] > s2x["macro_f1"] else "xgb"
    notes.append(("Stage 2 uses the Random Forest" if choice == "rf" else "Stage 2 uses the regularised XGBoost")
                 + ", the better of the two on the hold-out set.")

    p2_all = (rf2 if choice == "rf" else stage2).predict_proba(Xte)[:, 1]
    pred3 = np.where(pred1 == 0, 0, np.where(p2_all > 0.5, 2, 1))
    y3te = y3.loc[idx_test].values

    metrics = {
        "stage1": stage_block(y1te, pred1, p1, ["On-Time", "Late"]),
        "stage2_xgb": s2x,
        "stage2_rf": s2r,
        "stage2_choice": choice,
        "end_to_end": {
            "accuracy": accuracy_score(y3te, pred3),
            "macro_f1": f1_score(y3te, pred3, average="macro"),
            "cm": confusion_matrix(y3te, pred3, labels=[0, 1, 2]),
            "report": classification_report(y3te, pred3, labels=[0, 1, 2], target_names=CLASSES,
                                            output_dict=True, zero_division=0),
        },
        "sizes": {"train": len(idx_train), "test": len(idx_test),
                  "stage2_train": int(late_tr.sum()), "stage2_test": int(late_te.sum())},
    }

    metrics["arrays"] = {"p1": p1, "y1": y1te, "p2_all": p2_all, "y3": y3te}

    dm = xgb.DMatrix(Xte, feature_names=feature_names)
    contrib = stage1.get_booster().predict(dm, pred_contribs=True)[:, :-1]
    imp = pd.Series(np.abs(contrib).mean(axis=0), index=feature_names).sort_values(ascending=False)
    metrics["global_importance"] = imp

    ranges = {c: (float(df[c].min()), float(df[c].max())) for c in raw_num}
    categories = {c: sorted(df[c].unique().tolist()) for c in raw_cat}
    data = df.assign(delay_class=y3.map(dict(enumerate(CLASSES))))

    return Trained(mode=mode, raw_num=raw_num, raw_cat=raw_cat, num_cols=num_cols, cat_cols=cat_cols,
                   medians={c: medians[c] for c in raw_num}, categories=categories, ranges=ranges,
                   encoder=encoder, feature_names=feature_names, stage1=stage1, stage2=stage2, rf2=rf2,
                   threshold=threshold, data=data, metrics=metrics, notes=notes)
