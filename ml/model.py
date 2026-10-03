"""Shared preprocessing used by training and the persistent GB10 inference service."""
import hashlib
from pathlib import Path

import pandas as pd

from readiness import CATEGORICAL_COLUMNS, CATEGORIES, feature_columns, flatten_snapshot


def preprocessor_hash():
    directory = Path(__file__).resolve().parent
    return hashlib.sha256((directory / "readiness.py").read_bytes() + (directory / "model.py").read_bytes()).hexdigest()


def model_frame(snapshots, kind):
    frame = pd.DataFrame([flatten_snapshot(s) for s in snapshots], columns=feature_columns())
    if kind == "xgboost":
        for column in CATEGORICAL_COLUMNS:
            levels = (
                [*CATEGORIES[column], "__unknown__"] if column in CATEGORIES else
                ["known", "unknown"] if column.endswith("__status") else
                ["unknown", "cv", "cv_confirmed", "questionnaire"]
            )
            frame[column] = pd.Categorical(frame[column], categories=levels)
    return frame
