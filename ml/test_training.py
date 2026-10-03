import json
import tempfile
import unittest
from pathlib import Path

from synthetic import generate
from train import load_records, model_frame


class TrainingContractTests(unittest.TestCase):
    def test_repeated_worker_and_real_data_are_rejected(self):
        records = generate(100, 42)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshots.jsonl"

            def write(rows):
                path.write_text("\n".join(json.dumps(r) for r in rows))

            write(records)
            self.assertEqual(len(load_records(path)), 100)
            write([*records, records[0]])
            with self.assertRaisesRegex(ValueError, "repeated workers"):
                load_records(path)
            records[0]["synthetic"] = False
            write(records)
            with self.assertRaisesRegex(ValueError, "only synthetic"):
                load_records(path)

    def test_xgboost_category_mapping_is_stable_for_unseen_inference_values(self):
        training = model_frame([{"asked": [{"field": "delivery_app", "value": "yes"}], "cv": []}], "xgboost")
        inference = model_frame([{"asked": [{"field": "delivery_app", "value": "no"}], "cv": []}], "xgboost")
        for column in training.select_dtypes("category"):
            self.assertEqual(list(training[column].cat.categories), list(inference[column].cat.categories))
        self.assertFalse(inference["delivery_app"].isna().any())


if __name__ == "__main__":
    unittest.main()
