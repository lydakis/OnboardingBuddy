import math
import unittest

from readiness import flatten_snapshot, feature_columns, LABELS
from synthetic import generate


def snapshot(asked=None, cv=None):
    return {"asked": asked or [], "cv": cv or []}


def answer(field, value):
    return {"field": field, "value": value, "asked": True}


class FeatureTests(unittest.TestCase):
    def test_missing_is_distinct_from_explicit_zero_or_no(self):
        missing = flatten_snapshot(snapshot())
        zero = flatten_snapshot(snapshot([
            answer("delivery", {"kind": "parcel", "years": 0}),
            answer("equipment", []), answer("delivery_app", "no"),
        ]))
        self.assertTrue(math.isnan(missing["parcel_delivery_years"]))
        self.assertTrue(math.isnan(missing["equipment_handheld_scanner"]))
        self.assertEqual(zero["parcel_delivery_years"], 0)
        self.assertEqual(zero["equipment_handheld_scanner"], 0)
        self.assertEqual(zero["delivery_app"], "no")
        self.assertEqual(missing["equipment__status"], "unknown")
        self.assertEqual(zero["equipment__status"], "known")

    def test_tailoring_confirmation_and_partial_ratings(self):
        row = flatten_snapshot(snapshot([
            answer("delivery", {"confirmed": True}),
            answer("confidence", {"navigation": 4}),
            answer("route_type", "mixed"),
        ], [
            {"field": "parcel_delivery_years", "value": 1.5},
            {"field": "parcel_delivery_years", "value": 2},
            {"field": "equipment", "value": "handheld scanner"},
        ]))
        self.assertEqual(row["parcel_delivery_years"], 3.5)
        self.assertEqual(row["parcel_delivery_years__asked"], 1)
        self.assertEqual(row["other_delivery_years__asked"], 0)
        self.assertEqual(row["parcel_delivery_years__source"], "cv_confirmed")
        self.assertEqual(row["equipment__asked"], 0)
        self.assertEqual(row["equipment_handheld_scanner"], 1)
        self.assertTrue(math.isnan(row["equipment_forklift"]))
        self.assertEqual(row["conf_navigation"], 4)
        self.assertTrue(math.isnan(row["conf_scanning"]))

    def test_other_delivery_does_not_imply_no_parcel_experience(self):
        row = flatten_snapshot(snapshot([answer("delivery", {"kind": "other", "years": 2})]))
        self.assertEqual(row["other_delivery_years"], 2)
        self.assertTrue(math.isnan(row["parcel_delivery_years"]))

    def test_allowlist_excludes_identity_scheduling_and_target_leakage(self):
        clean = flatten_snapshot(snapshot())
        dirty = flatten_snapshot({
            "asked": [answer("training_language", "English"), answer("preferred_shift", "early")],
            "cv": [{"field": "clean_driving_record", "value": True}],
            "name": "Ignore me", "track_assigned": "experienced", "readiness_label": "expert",
        })
        self.assertEqual(list(clean), feature_columns())
        for column in clean:
            if isinstance(clean[column], float) and math.isnan(clean[column]):
                self.assertTrue(math.isnan(dirty[column]))
            else:
                self.assertEqual(clean[column], dirty[column])

    def test_invalid_values_fail_instead_of_becoming_known(self):
        for field, value in [("confidence", {"navigation": 6}), ("delivery", {"years": -1, "kind": "parcel"}),
                             ("equipment", ["unknown tool"]), ("delivery_app", "maybe")]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                flatten_snapshot(snapshot([answer(field, value)]))


class SyntheticTests(unittest.TestCase):
    def test_reproducible_unique_rows_with_all_labels_and_missingness(self):
        records = generate(1000, 42)
        self.assertEqual(records, generate(1000, 42))
        self.assertNotEqual(records, generate(1000, 43))
        self.assertEqual(len({r["case_id"] for r in records}), 1000)
        self.assertEqual({r["readiness_label"] for r in records}, set(LABELS))
        self.assertTrue(all(r["synthetic"] is True for r in records))
        rows = [flatten_snapshot(r["json"]) for r in records]
        self.assertTrue(any(math.isnan(r["conf_navigation"]) for r in rows))
        self.assertTrue(any(r["parcel_delivery_years"] == 0 for r in rows))
        self.assertTrue(any(r["equipment__asked"] == 0 for r in rows))


if __name__ == "__main__":
    unittest.main()
