"""Generate fictional questionnaire snapshots; labels are simulated, never assessments."""
import argparse
import csv
import json
import random
from collections import Counter
from pathlib import Path

from readiness import EQUIPMENT, LABELS, SCHEMA_VERSION, feature_columns, flatten_snapshot

GENERATOR_VERSION = "latent-readiness-v1"


def generate(rows=1000, seed=42):
    if rows < 30:
        raise ValueError("Use at least 30 rows for a three-class prototype")
    rng = random.Random(seed)
    records = []
    for i in range(rows):
        # Overlapping archetypes, rather than a direct years -> label rule.
        archetype = rng.choices((0, 1, 2), weights=(0.35, 0.40, 0.25))[0]
        skill = max(0, min(1, rng.gauss((0.18, 0.52, 0.84)[archetype], 0.13)))
        years = round(max(0, rng.gauss(skill * 7 - 1, 1.2)), 1)
        other = round(max(0, rng.gauss(1.2, 1)), 1) if rng.random() < 0.4 else 0
        warehouse = round(max(0, rng.gauss(0.7, 0.8)), 1)
        tools = [e for e in EQUIPMENT if rng.random() < 0.12 + 0.76 * skill]
        app = "yes" if rng.random() < 0.2 + 0.75 * skill else "no"
        area = rng.choice(("not_yet", "somewhat", "very_well"))  # New depot != new worker.
        license_value = rng.choices(("none", "standard", "cdl"), weights=(0.06, 0.75, 0.19))[0]
        vehicle = "box_truck" if "box truck" in tools else rng.choice(("none", "car", "cargo_van"))
        # Self-confidence is noisy: experienced-but-cautious and overconfident beginners occur.
        ratings = {k: max(1, min(5, round(rng.gauss(1 + 4 * skill, 1.0))))
                   for k in ("navigation", "scanning", "handoff")}
        cv, asked = [], []

        def fact(field, value):
            cv.append({"field": field, "value": value, "excerpt": "Fictional CV evidence", "asked": False})

        def ask(field, value):
            # Independent missingness: no missing value is replaced by zero.
            if rng.random() < 0.07:
                value = None
            asked.append({"field": field, "value": value, "raw": None if value is None else json.dumps(value),
                          "excerpt": None, "asked": True})

        cv_parcel = years > 0 and rng.random() < 0.7
        if cv_parcel:
            fact("parcel_delivery_years", years)
            ask("delivery", {"confirmed": True})
            ask("route_type", rng.choice(("residential", "business", "mixed", "rural")))
        else:
            ask("delivery", {"kind": "parcel", "years": years} if years > 0 else {"kind": "other", "years": other})
            # Explicit zero in CV gives a genuine zero without conflating an other-only answer.
            if years == 0 and rng.random() < 0.4:
                fact("parcel_delivery_years", 0)
        if other > 0 and rng.random() < 0.5:
            fact("other_delivery_years", other)
        if warehouse > 0 and rng.random() < 0.6:
            fact("warehouse_years", warehouse)
        if rng.random() < 0.6:
            fact("license_class", license_value)
        else:
            ask("license_class", license_value)
        cv_tools = bool(tools) and rng.random() < 0.65
        if cv_tools:
            for tool in tools:
                fact("equipment", tool)
        else:
            ask("equipment", tools)
        if not (cv_tools and "box truck" in tools):
            ask("largest_vehicle", vehicle)
        ask("delivery_app", app)
        ask("area_familiarity", area)
        ask("preferred_shift", rng.choice(("early", "day", "late")))
        ask("confidence", ratings)

        # Hypothetical readiness, with unobserved performance variation. Not live policy.
        readiness = skill + (0.03 if app == "yes" else -0.03) + rng.gauss(0, 0.09)
        label = LABELS[0 if readiness < 0.36 else 1 if readiness < 0.70 else 2]
        records.append({"schema_version": SCHEMA_VERSION, "generator_version": GENERATOR_VERSION,
                        "synthetic": True, "case_id": f"SYN-{i + 1:05d}", "version": 1,
                        "policy_id": "synthetic-only", "reason": "questionnaire_complete",
                        "json": {"asked": asked, "cv": cv}, "readiness_label": label})
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, default=Path("artifacts"))
    args = parser.parse_args()
    records = generate(args.rows, args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    with (args.out / "snapshots.jsonl").open("w") as f:
        for record in records:
            f.write(json.dumps(record, allow_nan=False) + "\n")
    columns = ["case_id", "synthetic", "readiness_label", *feature_columns()]
    with (args.out / "questionnaire.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for r in records:
            row = {"case_id": r["case_id"], "synthetic": True, "readiness_label": r["readiness_label"],
                   **flatten_snapshot(r["json"])}
            writer.writerow(row)
    manifest = {"synthetic": True, "schema_version": SCHEMA_VERSION, "generator_version": GENERATOR_VERSION,
                "rows": args.rows, "seed": args.seed, "class_counts": dict(Counter(r["readiness_label"] for r in records)),
                "warning": "Simulated labels. Synthetic test scores do not estimate employee readiness accuracy."}
    (args.out / "dataset.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
