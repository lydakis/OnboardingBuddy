"""Local demo inference from one {asked, cv} snapshot; never changes a worker's plan."""
import argparse
import json
from pathlib import Path

from catboost import CatBoostClassifier

from readiness import LABELS
from model import model_frame


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, help="JSON snapshot, or first record of a JSONL file")
    parser.add_argument("--model", choices=("catboost", "xgboost"), default="catboost")
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    args = parser.parse_args()
    text = args.snapshot.read_text().strip()
    try:
        record = json.loads(text)
    except json.JSONDecodeError:
        record = json.loads(text.splitlines()[0])
    snapshot = record.get("json", record)
    if isinstance(snapshot, str):
        snapshot = json.loads(snapshot)
    if args.model == "catboost":
        model = CatBoostClassifier()
    else:
        from xgboost import XGBClassifier
        model = XGBClassifier()
    filename = "catboost.cbm" if args.model == "catboost" else "xgboost.json"
    model.load_model(str(args.artifacts / filename))
    probabilities = model.predict_proba(model_frame([snapshot], args.model))[0]
    print(json.dumps({"prototype_only": True, "label": LABELS[probabilities.argmax()],
                      "probabilities": {label: float(p) for label, p in zip(LABELS, probabilities)},
                      "warning": "Synthetic-trained model. Uncalibrated probabilities; manager review required."}, indent=2))


if __name__ == "__main__":
    main()
