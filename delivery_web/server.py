"""FastAPI backend for the Delivery Delay Risk website.

Run:  python -m uvicorn server:app --port 8001   (or double-click Run_Website.bat in the ML folder)
The website is served at http://127.0.0.1:8001 and the API under /api.
"""
from __future__ import annotations

import hashlib
import io
import threading
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pipeline as pl

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE.parent
CACHE = BASE / "model_cache"
CACHE.mkdir(exist_ok=True)

app = FastAPI(title="Delivery Delay Risk API")

STATE = {"bytes": None, "name": None, "hash": None, "models": {}, "training": set(), "error": None}
LOCK = threading.Lock()

ADVICE = {
    "On-Time": "No action needed. Dispatch as planned.",
    "At Risk": "Monitor this order and consider notifying the customer about a possible short delay.",
    "Delayed": "Escalate before dispatch: re-route, re-assign the driver or vehicle, or proactively inform and compensate the customer.",
}


# ------------------------------------------------------------------ data + models
def _header(p: Path) -> list:
    """Column names only, without loading the whole file."""
    if p.suffix.lower() == ".csv":
        return [c.strip().lower() for c in pd.read_csv(p, nrows=0).columns]
    from openpyxl import load_workbook
    wb = load_workbook(p, read_only=True)
    row = next(wb.active.iter_rows(max_row=1, values_only=True), ())
    wb.close()
    return [str(c).strip().lower() for c in row if c is not None]


def find_dataset():
    preferred = DATA_DIR / "multiclasss model.xlsx"
    if preferred.exists():
        return preferred
    for p in sorted(DATA_DIR.glob("*.xlsx")) + sorted(DATA_DIR.glob("*.csv")):
        if p.name.startswith("~$"):
            continue
        try:
            if pl.TARGET_SOURCE in _header(p):
                return p
        except Exception:
            continue
    return None


def set_dataset(data: bytes, name: str):
    with LOCK:
        STATE.update(bytes=data, name=name, hash=hashlib.md5(data).hexdigest()[:12], models={}, error=None)


def _train(mode: str):
    h = STATE["hash"]
    path = CACHE / f"{h}_{mode}.joblib"
    try:
        if path.exists():
            model = joblib.load(path)
        else:
            df = pl.read_table(STATE["bytes"], STATE["name"])
            model = pl.train(df, mode=mode)
            joblib.dump(model, path)
        if STATE["hash"] == h:
            STATE["models"][mode] = model
    except Exception as e:  # surfaced through /api/status
        STATE["error"] = f"{type(e).__name__}: {e}"
    finally:
        STATE["training"].discard(mode)


def get_model(mode: str = "deployable", wait: bool = True) -> pl.Trained:
    if mode not in pl.MODES:
        raise HTTPException(400, f"Unknown mode '{mode}'.")
    if STATE["bytes"] is None:
        raise HTTPException(409, "No training data yet. Upload the dataset first.")
    if mode in STATE["models"]:
        return STATE["models"][mode]
    if mode not in STATE["training"]:
        STATE["training"].add(mode)
        t = threading.Thread(target=_train, args=(mode,), daemon=True)
        t.start()
        if wait:
            t.join()
    elif wait:
        while mode in STATE["training"]:
            threading.Event().wait(0.5)
    if mode in STATE["models"]:
        return STATE["models"][mode]
    raise HTTPException(503, STATE["error"] or "Model is still training, try again in a moment.")


@app.on_event("startup")
def startup():
    p = find_dataset()
    if p is not None:
        set_dataset(p.read_bytes(), p.name)
        STATE["training"].update({"deployable", "notebook"})

        def load_both():
            _train("deployable")
            _train("notebook")

        threading.Thread(target=load_both, daemon=True).start()


def f(x, nd=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), nd)


def roc_points(roc, n=120):
    fpr, tpr = roc
    idx = np.unique(np.linspace(0, len(fpr) - 1, min(n, len(fpr))).astype(int))
    return [[f(fpr[i], 4), f(tpr[i], 4)] for i in idx]


# ------------------------------------------------------------------ API
@app.get("/api/status")
def status():
    return {"dataset": STATE["name"], "has_data": STATE["bytes"] is not None,
            "ready": sorted(STATE["models"]), "training": sorted(STATE["training"]), "error": STATE["error"],
            "modes": pl.MODES}


@app.post("/api/dataset")
async def upload_dataset(file: UploadFile = File(...)):
    data = await file.read()
    try:
        cols = pl.read_table(data, file.filename).columns
    except Exception as e:
        raise HTTPException(400, f"Could not read the file: {e}")
    if pl.TARGET_SOURCE not in cols:
        raise HTTPException(400, f"The file needs a '{pl.TARGET_SOURCE}' column.")
    set_dataset(data, file.filename)
    get_model("deployable", wait=False)
    return status()


@app.get("/api/overview")
def overview():
    m = get_model("deployable")
    d = m.data
    counts = d["delay_class"].value_counts().reindex(pl.CLASSES).fillna(0).astype(int)
    breakdown = {}
    for c in m.raw_cat:
        tab = pd.crosstab(d[c], d["delay_class"], normalize="index").reindex(columns=pl.CLASSES).fillna(0)
        tab = tab.sort_values("Delayed", ascending=False)
        breakdown[c] = {"labels": tab.index.tolist(), **{k: [f(v, 4) for v in tab[k]] for k in pl.CLASSES}}
    tb = d[pl.TARGET_SOURCE]
    lo, hi = tb.quantile(0.01), tb.quantile(0.99)
    hist, edges = np.histogram(tb.clip(lo, hi), bins=50)
    return {
        "rows": len(d), "features": len(m.raw_num) + len(m.raw_cat), "inputs": len(m.feature_names),
        "counts": counts.to_dict(), "late_share": f(1 - counts["On-Time"] / len(d)),
        "breakdown": breakdown,
        "buffer_hist": {"counts": hist.tolist(), "edges": [f(e, 3) for e in edges]},
        "dataset": STATE["name"],
    }


@app.get("/api/metrics")
def metrics(mode: str = "deployable", threshold: float = Query(0.42, ge=0.01, le=0.99)):
    m = get_model(mode)
    M = m.metrics
    live = pl.evaluate_threshold(M["arrays"], threshold)

    def block(b, pos):
        return {"accuracy": f(b["accuracy"]), "macro_f1": f(b["macro_f1"]), "auc": f(b.get("auc")),
                "recall": f(b["report"][pos]["recall"]), "precision": f(b["report"][pos]["precision"]),
                "cm": np.asarray(b["cm"]).tolist(), "roc": roc_points(b["roc"]) if "roc" in b else None}

    s1 = live["stage1"]
    e = live["end_to_end"]
    return {
        "mode": mode, "mode_label": pl.MODES[mode], "threshold": threshold, "notes": m.notes, "sizes": M["sizes"],
        "stage1": {**block({**M["stage1"], **{k: s1[k] for k in ("accuracy", "macro_f1", "cm", "report")}}, "Late")},
        "stage2_xgb": block(M["stage2_xgb"], "Delayed"),
        "stage2_rf": block(M["stage2_rf"], "Delayed"),
        "stage2_choice": M.get("stage2_choice", "xgb"),
        "end_to_end": {"accuracy": f(e["accuracy"]), "macro_f1": f(e["macro_f1"]), "cm": e["cm"].tolist(),
                       "per_class": {c: {k: f(e["report"][c][k]) for k in ("precision", "recall", "f1-score")}
                                     | {"support": int(e["report"][c]["support"])} for c in pl.CLASSES}},
        "importance": [{"feature": k, "value": f(v)} for k, v in M["global_importance"].head(15).items()],
    }


@app.get("/api/options")
def options():
    m = get_model("deployable")
    return {"categorical": {c: m.categories[c] for c in m.raw_cat},
            "numeric": {c: {"median": f(m.medians[c], 3), "min": f(m.ranges[c][0], 3), "max": f(m.ranges[c][1], 3)}
                        for c in m.raw_num}}


@app.get("/api/sample")
def sample():
    """A random real order from the dataset (its features and what actually happened)."""
    m = get_model("deployable")
    row = m.data.sample(1).iloc[0]
    order = {c: (row[c] if c in m.raw_cat else f(row[c], 3)) for c in m.raw_cat + m.raw_num}
    return {"order": order, "actual": row["delay_class"], "time_buffer_hours": f(row[pl.TARGET_SOURCE], 2)}


class Order(BaseModel):
    order: dict
    threshold: float = 0.42


def explain(m, row: pd.DataFrame):
    contrib = m.contributions(row, stage=1).iloc[0]
    top = contrib.reindex(contrib.abs().sort_values(ascending=False).index)[:8]
    out = []
    for name, v in top.items():
        val = row.iloc[0].get(name, None)
        out.append({"feature": name, "effect": f(v), "value": val if isinstance(val, str) else f(val, 3)})
    return out


@app.post("/api/predict")
def predict(req: Order):
    m = get_model("deployable")
    row = pd.DataFrame([req.order])
    r = m.predict(row, req.threshold).iloc[0]
    cls = r["prediction"]
    return {"prediction": cls, "probabilities": {"On-Time": f(r["p_on_time"]), "At Risk": f(r["p_at_risk"]),
                                                 "Delayed": f(r["p_delayed"])},
            "late_probability": f(r["p_late_stage1"]), "recommendation": ADVICE[cls], "drivers": explain(m, row)}


@app.post("/api/predict-batch")
async def predict_batch(file: UploadFile = File(...), threshold: float = 0.42):
    m = get_model("deployable")
    try:
        orders = pl.read_table(await file.read(), file.filename)
    except Exception as e:
        raise HTTPException(400, f"Could not read the file: {e}")
    if len(orders) == 0:
        raise HTTPException(400, "The file has no rows.")
    preds = m.predict(orders, threshold).reset_index(drop=True)
    out = pd.concat([orders.reset_index(drop=True), preds], axis=1)
    accuracy = None
    if pl.TARGET_SOURCE in orders.columns and orders[pl.TARGET_SOURCE].notna().any():
        mask = orders[pl.TARGET_SOURCE].notna().values
        truth = pl.three_class(orders[pl.TARGET_SOURCE][mask]).map(dict(enumerate(pl.CLASSES))).values
        accuracy = f((truth == preds["prediction"].values[mask]).mean())
    counts = preds["prediction"].value_counts().reindex(pl.CLASSES).fillna(0).astype(int).to_dict()
    show = out.head(500).replace({np.nan: None})
    return {"rows": len(out), "counts": counts, "accuracy": accuracy, "columns": list(show.columns),
            "data": show.to_dict(orient="records"), "csv": out.to_csv(index=False)}


@app.get("/api/groups")
def groups(by: str):
    """Delay statistics per value of one categorical column (partner, weather, region, ...)."""
    m = get_model("deployable")
    if by not in m.raw_cat:
        raise HTTPException(400, f"'{by}' is not a categorical column.")
    d = m.data
    key = d[by]
    late = (d[pl.TARGET_SOURCE] >= 0).groupby(key).mean()
    delayed = (d["delay_class"] == "Delayed").groupby(key).mean()
    g = d.groupby(by)
    out = pd.DataFrame({"orders": g.size(), "late_share": late, "delayed_share": delayed,
                        "avg_buffer": g[pl.TARGET_SOURCE].mean(),
                        **{c: g[c].mean() for c in m.raw_num}}).sort_values("late_share", ascending=False)
    return {"by": by, "overall_late": f((d[pl.TARGET_SOURCE] >= 0).mean()),
            "overall_delayed": f((d["delay_class"] == "Delayed").mean()),
            "rows": [{"name": k, **{c: (int(v) if c == "orders" else f(v)) for c, v in r.items()}}
                     for k, r in out.iterrows()]}


@app.get("/api/segments")
def segments(min_orders: int = 150, top: int = 8):
    """Riskiest combinations of two order attributes, by share of orders delayed more than 3 h."""
    m = get_model("deployable")
    d = m.data[m.data[m.raw_cat].ne("unknown").all(axis=1)]
    rows = []
    cats = m.raw_cat
    for i, a in enumerate(cats):
        for b in cats[i + 1:]:
            g = d.groupby([a, b])
            stats = pd.DataFrame({"orders": g.size(), "delayed": (d["delay_class"] == "Delayed").groupby([d[a], d[b]]).mean()})
            stats = stats[stats["orders"] >= min_orders]
            for (va, vb), r in stats.iterrows():
                rows.append({"a": a, "va": va, "b": b, "vb": vb, "orders": int(r["orders"]), "delayed_share": f(r["delayed"])})
    rows.sort(key=lambda r: r["delayed_share"], reverse=True)
    base = f((m.data["delay_class"] == "Delayed").mean())
    return {"baseline": base, "segments": rows[:top]}


@app.get("/api/demo")
def demo(n: int = Query(8, ge=1, le=50), threshold: float = 0.42):
    """Score n random real orders, returning each order, its prediction and what actually happened."""
    m = get_model("deployable")
    rows = m.data.sample(n)
    preds = m.predict(rows[m.raw_cat + m.raw_num], threshold)
    out = []
    for (idx, r), (_, p) in zip(rows.iterrows(), preds.iterrows()):
        out.append({"order": {c: (r[c] if c in m.raw_cat else f(r[c], 3)) for c in m.raw_cat + m.raw_num},
                    "actual": r["delay_class"], "prediction": p["prediction"], "late_probability": f(p["p_late_stage1"]),
                    "probabilities": {"On-Time": f(p["p_on_time"]), "At Risk": f(p["p_at_risk"]), "Delayed": f(p["p_delayed"])}})
    return {"orders": out}


@app.get("/api/template")
def template():
    m = get_model("deployable")
    tmpl = pd.DataFrame([{**{c: m.categories[c][0] for c in m.raw_cat}, **m.medians}])
    buf = io.StringIO()
    tmpl.to_csv(buf, index=False)
    return {"csv": buf.getvalue()}


# ------------------------------------------------------------------ website
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")
