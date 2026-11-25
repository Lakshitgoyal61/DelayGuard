# DelayGuard

**Amazon Supply Chain Intelligence: Delivery Delay Risk Classification**
UML501 Machine Learning project, Group 3C25, Thapar Institute of Engineering and Technology

DelayGuard predicts whether a last-mile delivery will be **On-Time**, **At Risk** (up to 3 hours late) or **Delayed** (more than 3 hours late), and shows which factors drove the prediction.

## How it works

Two models run one after the other:

1. **Stage 1 (XGBoost)** decides on time vs late. It is weighted towards catching late orders (class weight 2.8, threshold 0.42).
2. **Stage 2** grades late orders as At Risk or Delayed (a small regularised XGBoost, compared against a 650-tree Random Forest).
3. **TreeSHAP** explains each prediction.

## Results (hold-out test set, 30% of 25,000 orders)

| | Notebook / report | Leakage-free model |
|---|---|---|
| Stage 1 accuracy | 90.2% | 84.2% |
| Late orders caught (recall) | 96% | 92% |
| Stage 1 ROC-AUC | 0.97 | 0.90 |
| Stage 2 accuracy | 94.7% | 71.8% |

The notebook builds `sla_time_hours` from `time_buffer_hours`, the same column that defines the target, so its Stage 2 score is optimistic. The website shows both versions and uses the leakage-free model for new predictions.

## Run the website

Requirements: Windows with Python 3.12.

1. Double-click **`Run_Website.bat`**.
2. The first run installs packages and trains the models (a minute or two). After that it starts in about 10 seconds.
3. Your browser opens **http://127.0.0.1:8001**. Keep the black window open while you use it.

Pages: Dashboard (predict an order), Analytics, Model Performance, Batch Upload, AI Insights, About.

To run it by hand: `cd delivery_web`, `pip install -r requirements.txt`, then `python -m uvicorn server:app --port 8001`.

## Files

| Path | What it is |
|---|---|
| `amazn_ml_model_2026(refined).ipynb` | Original Colab notebook |
| `multiclasss model.xlsx` | Dataset (25,000 orders) |
| `delivery_web/pipeline.py` | Two-stage model: features, training, prediction |
| `delivery_web/server.py` | FastAPI backend (`/api/predict`, `/api/predict-batch`, `/api/metrics`, ...) |
| `delivery_web/static/` | Website (HTML, CSS, JavaScript, Chart.js) |
| `Project_Report.pdf` | Project report |
| `DelayGuard_Presentation.pptx` | Presentation slides |

## Team

- Shreshth Garg (1024030380)
- Lakshit Goyal (1024030383)

Submitted to Akshun Sharma, Computer Science and Engineering Department, TIET Patiala, November 2026.
