"""Compare both models on one fixed 70/15/15 split of synthetic snapshots."""
import argparse
import hashlib
import importlib.metadata
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostClassifier
from sklearn.dummy import DummyClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score, log_loss
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier

from readiness import CATEGORICAL_COLUMNS, CATEGORIES, LABELS, SCHEMA_VERSION, feature_columns, flatten_snapshot


def model_frame(snapshots, kind):
    frame = pd.DataFrame([flatten_snapshot(s) for s in snapshots], columns=feature_columns())
    if kind == "xgboost":
        # Freeze category mappings for future inference, including unseen/missing categories.
        for column in CATEGORICAL_COLUMNS:
            levels = (
                [*CATEGORIES[column], "__unknown__"] if column in CATEGORIES else
                ["known", "unknown"] if column.endswith("__status") else
                ["unknown", "cv", "cv_confirmed", "questionnaire"]
            )
            frame[column] = pd.Categorical(frame[column], categories=levels)
    return frame


def load_records(path):
    records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not records or any(r.get("synthetic") is not True or r.get("schema_version") != SCHEMA_VERSION for r in records):
        raise ValueError("This experiment accepts only synthetic snapshots in the supported schema")
    if len({r["case_id"] for r in records}) != len(records):
        raise ValueError("One snapshot per case is required; repeated workers would leak across splits")
    counts = Counter(r["readiness_label"] for r in records)
    if set(counts) != set(LABELS) or min(counts.values()) < 7:
        raise ValueError("Need all three classes with at least 7 rows each")
    return records


def metrics(truth, probabilities):
    predicted = probabilities.argmax(axis=1)
    matrix = confusion_matrix(truth, predicted, labels=[0, 1, 2])
    return {
        "accuracy": float(accuracy_score(truth, predicted)),
        "macro_f1": float(f1_score(truth, predicted, average="macro")),
        "log_loss": float(log_loss(truth, probabilities, labels=[0, 1, 2])),
        "confusion_matrix": matrix.tolist(),
        "beginner_predicted_expert": int(matrix[0, 2]),
        "per_class": classification_report(truth, predicted, labels=[0, 1, 2],
                                            target_names=LABELS, output_dict=True, zero_division=0),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("artifacts/snapshots.jsonl"))
    parser.add_argument("--out", type=Path, default=Path("artifacts"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    records = load_records(args.data)
    y = np.array([LABELS.index(r["readiness_label"]) for r in records])
    indices = np.arange(len(records))
    train, holdout = train_test_split(indices, test_size=0.30, stratify=y, random_state=args.seed)
    validation, test = train_test_split(holdout, test_size=0.50, stratify=y[holdout], random_state=args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    split = {name: [records[i]["case_id"] for i in subset]
             for name, subset in (("train", train), ("validation", validation), ("test", test))}
    (args.out / "split.json").write_text(json.dumps(split, indent=2) + "\n")

    dummy = DummyClassifier(strategy="prior").fit(np.zeros((len(train), 1)), y[train])
    report = {
        "synthetic_only": True,
        "warning": "Scores measure this simulator, not readiness on real employees. Probabilities are uncalibrated.",
        "schema_version": SCHEMA_VERSION,
        "data_sha256": hashlib.sha256(args.data.read_bytes()).hexdigest(),
        "seed": args.seed,
        "labels_in_probability_order": LABELS,
        "features": feature_columns(),
        "categorical_features": CATEGORICAL_COLUMNS,
        "split_sizes": {name: len(ids) for name, ids in split.items()},
        "class_counts": {name: dict(Counter(records[i]["readiness_label"] for i in subset))
                         for name, subset in (("train", train), ("validation", validation), ("test", test))},
        "versions": {p: importlib.metadata.version(p) for p in ("catboost", "xgboost", "pandas", "scikit-learn")},
        "baseline": metrics(y[test], dummy.predict_proba(np.zeros((len(test), 1)))),
        "models": {},
    }
    models = {
        "catboost": CatBoostClassifier(iterations=400, depth=5, learning_rate=0.05,
                                       loss_function="MultiClass", random_seed=args.seed,
                                       thread_count=4, allow_writing_files=False, verbose=False),
        "xgboost": XGBClassifier(n_estimators=400, max_depth=4, learning_rate=0.05,
                                 objective="multi:softprob", num_class=3, tree_method="hist",
                                 enable_categorical=True, eval_metric="mlogloss",
                                 early_stopping_rounds=30, random_state=args.seed, n_jobs=4),
    }
    for kind, model in models.items():
        frame = model_frame([r["json"] for r in records], kind)
        if kind == "catboost":
            model.fit(frame.iloc[train], y[train], cat_features=list(CATEGORICAL_COLUMNS),
                      eval_set=(frame.iloc[validation], y[validation]), early_stopping_rounds=30)
            filename = "catboost.cbm"
        else:
            model.fit(frame.iloc[train], y[train], eval_set=[(frame.iloc[validation], y[validation])], verbose=False)
            filename = "xgboost.json"
        model.save_model(str(args.out / filename))
        validation_prob = model.predict_proba(frame.iloc[validation])
        test_prob = model.predict_proba(frame.iloc[test])
        report["models"][kind] = {
            "validation": metrics(y[validation], validation_prob),
            "test": metrics(y[test], test_prob),
            "best_iteration": int(model.get_best_iteration() if kind == "catboost" else model.best_iteration),
            "feature_importance": sorted(
                ({"feature": c, "importance": float(v)} for c, v in zip(frame.columns, model.feature_importances_)),
                key=lambda x: x["importance"], reverse=True),
        }
        predictions = pd.DataFrame({"case_id": [records[i]["case_id"] for i in test],
                                    "truth": [LABELS[v] for v in y[test]],
                                    "prediction": [LABELS[v] for v in test_prob.argmax(axis=1)]})
        for i, label in enumerate(LABELS):
            predictions[f"p_{label}"] = test_prob[:, i]
        predictions.to_csv(args.out / f"{kind}-test-predictions.csv", index=False)
        # Confirm the saved artifact reproduces probabilities before handing it over.
        restored = CatBoostClassifier() if kind == "catboost" else XGBClassifier()
        restored.load_model(str(args.out / filename))
        np.testing.assert_allclose(restored.predict_proba(frame.iloc[test]), test_prob, rtol=1e-6, atol=1e-7)

    report["preferred_model_by_validation_macro_f1"] = max(
        report["models"], key=lambda kind: report["models"][kind]["validation"]["macro_f1"])
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"warning": report["warning"], "split_sizes": report["split_sizes"],
                      "preferred_model": report["preferred_model_by_validation_macro_f1"],
                      "test_metrics": {kind: {k: result["test"][k] for k in ("accuracy", "macro_f1", "log_loss")}
                                       for kind, result in report["models"].items()}}, indent=2))


if __name__ == "__main__":
    main()
