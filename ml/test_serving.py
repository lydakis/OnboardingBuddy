import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np

from readiness import SCHEMA_VERSION
from serve import Predictor
from model import preprocessor_hash


@unittest.skipUnless(os.environ.get("OB_TEST_ARTIFACTS"), "Set OB_TEST_ARTIFACTS to freshly trained artifacts")
class ServingTests(unittest.TestCase):
    def setUp(self):
        self.artifacts = Path(os.environ["OB_TEST_ARTIFACTS"])
        self.predictor = Predictor(self.artifacts)
        self.snapshot = json.loads((self.artifacts / "snapshots.jsonl").read_text().splitlines()[0])["json"]

    def test_identity_matches_content_and_predictions_ignore_non_features(self):
        checksum = hashlib.sha256((self.artifacts / "catboost.cbm").read_bytes()).hexdigest()
        self.assertEqual(self.predictor.identity["model_version"], hashlib.sha256((checksum + preprocessor_hash()).encode()).hexdigest())
        before = self.predictor.predict({"schema_version": SCHEMA_VERSION, "snapshot": self.snapshot})
        self.snapshot["name"] = "Ignored"
        self.snapshot["track_assigned"] = "expert"
        after = self.predictor.predict({"schema_version": SCHEMA_VERSION, "snapshot": self.snapshot})
        self.assertEqual(before, after)
        self.assertAlmostEqual(sum(before["probabilities"].values()), 1)
        self.assertEqual(before["label"], max(before["probabilities"], key=before["probabilities"].get))

    def test_training_and_serving_agree_on_heldout_probabilities(self):
        import pandas as pd
        predictions = pd.read_csv(self.artifacts / "catboost-test-predictions.csv").set_index("case_id")
        records = [json.loads(line) for line in (self.artifacts / "snapshots.jsonl").read_text().splitlines()]
        for record in records:
            if record["case_id"] in predictions.index:
                result = self.predictor.predict({"schema_version": SCHEMA_VERSION, "snapshot": record["json"]})
                np.testing.assert_allclose(list(result["probabilities"].values()), predictions.loc[record["case_id"], ["p_beginner", "p_okay", "p_expert"]].to_numpy(dtype=float), rtol=1e-6)

    def test_schema_invalid_values_and_tampered_artifact_are_rejected(self):
        with self.assertRaises(ValueError):
            self.predictor.predict({"schema_version": "unknown", "snapshot": self.snapshot})
        with self.assertRaises(ValueError):
            self.predictor.predict({"schema_version": SCHEMA_VERSION, "snapshot": {"asked": [{"field": "confidence", "value": {"navigation": 99}}], "cv": []}})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "catboost.cbm").write_bytes((self.artifacts / "catboost.cbm").read_bytes() + b"tampered")
            (path / "catboost-manifest.json").write_bytes((self.artifacts / "catboost-manifest.json").read_bytes())
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                Predictor(path)


if __name__ == "__main__":
    unittest.main()
