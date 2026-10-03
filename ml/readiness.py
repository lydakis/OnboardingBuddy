"""Allowlisted features from src/engine/features.ts's {asked, cv} snapshot JSON."""
import math

SCHEMA_VERSION = "readiness-p0-v1"
LABELS = ("beginner", "okay", "expert")
EQUIPMENT = ("handheld scanner", "pallet jack", "hand truck", "forklift", "box truck")
NUMERIC = ("parcel_delivery_years", "other_delivery_years", "warehouse_years",
           "conf_navigation", "conf_scanning", "conf_handoff")
CATEGORIES = {
    "license_class": ("none", "standard", "cdl"),
    "largest_vehicle": ("none", "car", "cargo_van", "box_truck"),
    "route_type": ("residential", "business", "mixed", "rural"),
    "delivery_app": ("yes", "no"),
    "area_familiarity": ("not_yet", "somewhat", "very_well"),
}
GROUPS = (*NUMERIC, *CATEGORIES, "equipment")
EQUIPMENT_COLUMNS = tuple("equipment_" + e.replace(" ", "_") for e in EQUIPMENT)
CATEGORICAL_COLUMNS = (*CATEGORIES, *(f"{g}__{m}" for g in GROUPS for m in ("status", "source")))


def feature_columns():
    return [*NUMERIC, *CATEGORIES, *EQUIPMENT_COLUMNS,
            *(f"{g}__{m}" for g in GROUPS for m in ("asked", "status", "source"))]


def number(value, field):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(f"{field}: expected a finite number")
    if field.startswith("conf_"):
        if value not in range(1, 6):
            raise ValueError(f"{field}: expected an integer from 1 to 5")
    elif value < 0 or value > 60:
        raise ValueError(f"{field}: years must be between 0 and 60")
    return float(value)


def license_category(value):
    text = str(value).lower()
    if text == "none":
        return "none"
    if text in ("cdl", "cdl-a", "cdl-b", "cdl-c"):
        return "cdl"
    if text in ("standard", "class a", "class b", "class c", "class d", "class c/d"):
        return "standard"
    raise ValueError(f"Unsupported license class: {value}")


def flatten_snapshot(snapshot):
    row = {c: math.nan for c in feature_columns()}
    for c in CATEGORIES:
        row[c] = "__unknown__"
    for g in GROUPS:
        row[f"{g}__asked"] = 0
        row[f"{g}__status"] = "unknown"
        row[f"{g}__source"] = "unknown"

    def mark(field, source, known=True):
        row[f"{field}__status"] = "known" if known else "unknown"
        row[f"{field}__source"] = source

    def set_value(field, value, source):
        if field in NUMERIC:
            row[field] = number(value, field)
        elif field == "license_class":
            row[field] = license_category(value)
        elif field in CATEGORIES:
            if value not in CATEGORIES[field]:
                raise ValueError(f"{field}: unsupported category {value}")
            row[field] = value
        mark(field, source)

    def set_equipment(values, source, complete):
        if not isinstance(values, list) or any(v not in EQUIPMENT for v in values):
            raise ValueError("equipment: expected a list of allowed equipment")
        for e, column in zip(EQUIPMENT, EQUIPMENT_COLUMNS):
            # A partial CV list supports presence, never absence of other tools.
            if complete or e in values:
                row[column] = float(e in values)
        mark("equipment", source, complete or bool(values))

    cv = snapshot.get("cv", [])
    for field in ("parcel_delivery_years", "other_delivery_years", "warehouse_years"):
        values = [number(f["value"], field) for f in cv if f.get("field") == field]
        if values:
            set_value(field, round(sum(values), 4), "cv")
    licenses = [f["value"] for f in cv if f.get("field") == "license_class"]
    if licenses:
        categories = {license_category(v) for v in licenses}
        if len(categories) != 1:
            raise ValueError("Conflicting CV license classes require review")
        set_value("license_class", licenses[0], "cv")
    tools = [f["value"] for f in cv if f.get("field") == "equipment"]
    if tools:
        set_equipment(tools, "cv", complete=False)
        if "box truck" in tools:
            set_value("largest_vehicle", "box_truck", "cv")

    for item in snapshot.get("asked", []):
        field, value = item.get("field"), item.get("value")
        delivery_fields = ("parcel_delivery_years", "other_delivery_years")
        if isinstance(value, dict) and value.get("confirmed") is True:
            delivery_fields = ("parcel_delivery_years",)
        affected = (
            delivery_fields if field == "delivery" else
            ("conf_navigation", "conf_scanning", "conf_handoff") if field == "confidence" else
            (field,) if field in GROUPS else ()
        )
        for g in affected:
            row[f"{g}__asked"] = int(item.get("asked", True))
        if value is None or not affected:
            continue
        if field == "delivery":
            if not isinstance(value, dict):
                raise ValueError("delivery: expected structured answer")
            if value.get("confirmed") is True:
                if not math.isnan(row["parcel_delivery_years"]):
                    mark("parcel_delivery_years", "cv_confirmed")
            else:
                if value.get("kind") not in ("parcel", "other"):
                    raise ValueError("delivery: expected parcel or other")
                g = "parcel_delivery_years" if value["kind"] == "parcel" else "other_delivery_years"
                set_value(g, value.get("years"), "questionnaire")
        elif field == "confidence":
            if not isinstance(value, dict):
                raise ValueError("confidence: expected structured ratings")
            for key in ("navigation", "scanning", "handoff"):
                if key in value:
                    set_value("conf_" + key, value[key], "questionnaire")
        elif field == "equipment":
            set_equipment(value, "questionnaire", complete=True)
        else:
            set_value(field, value, "questionnaire")
    return row
