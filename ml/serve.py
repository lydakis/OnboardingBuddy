"""Load one immutable CatBoost artifact once; serve only on GB10 loopback."""
import argparse
import hashlib
import json
import math
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from catboost import CatBoostClassifier

from model import model_frame, preprocessor_hash
from readiness import LABELS, SCHEMA_VERSION, feature_columns, flatten_snapshot


class Predictor:
    def __init__(self, artifacts):
        manifest = json.loads((artifacts / "catboost-manifest.json").read_text())
        checksum = hashlib.sha256((artifacts / "catboost.cbm").read_bytes()).hexdigest()
        version = hashlib.sha256((checksum + preprocessor_hash()).encode()).hexdigest()
        if (manifest.get("schema_version") != SCHEMA_VERSION or manifest.get("kind") != "catboost"
                or manifest.get("labels") != list(LABELS) or manifest.get("features") != feature_columns()
                or manifest.get("preprocessor_sha256") != preprocessor_hash()
                or manifest.get("model_sha256") != checksum or manifest.get("model_version") != version
                or manifest.get("synthetic_only") is not True):
            raise ValueError("Model artifact, feature schema or preprocessing checksum mismatch")
        self.model = CatBoostClassifier()
        self.model.load_model(str(artifacts / "catboost.cbm"))
        if self.model.feature_names_ != feature_columns() or list(self.model.classes_) != [0, 1, 2]:
            raise ValueError("Model feature or class ordering mismatch")
        self.identity = {"schema_version": SCHEMA_VERSION, "model_version": version, "synthetic_only": True}

    def predict(self, request):
        if not isinstance(request, dict) or request.get("schema_version") != SCHEMA_VERSION:
            raise ValueError("Unsupported request schema")
        snapshot = request.get("snapshot")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("asked"), list) or not isinstance(snapshot.get("cv"), list):
            raise ValueError("Expected a structured feature snapshot")
        flattened = flatten_snapshot(snapshot)
        missing = [g for g in ("license_class", "conf_navigation", "conf_scanning", "conf_handoff")
                   if flattened[f"{g}__status"] != "known"]
        if all(math.isnan(flattened[g]) for g in ("parcel_delivery_years", "other_delivery_years")):
            missing.append("delivery_experience")
        probabilities = self.model.predict_proba(model_frame([snapshot], "catboost"))[0]
        return {**self.identity, "label": LABELS[probabilities.argmax()],
                "probabilities": {label: float(p) for label, p in zip(LABELS, probabilities)},
                "missing_fields": missing}


def make_server(predictor, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # No worker payloads or request paths in access logs.

        def reply(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {**predictor.identity, "ready": True})
            else:
                self.reply(404, {"error": "Not found"})

        def do_POST(self):
            if self.path != "/predict":
                self.reply(404, {"error": "Not found"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 1 or size > 262144:
                    self.reply(413, {"error": "Request exceeds snapshot size limit"})
                    return
                result = predictor.predict(json.loads(self.rfile.read(size)))
            except (ValueError, TypeError, KeyError, AttributeError):
                self.reply(400, {"error": "Invalid snapshot or feature schema"})
                return
            self.reply(200, result)

    class Server(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(5)
            return connection, address

    return Server(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    parser.add_argument("--port", type=int, default=4610)
    args = parser.parse_args()
    predictor = Predictor(args.artifacts)
    server = make_server(predictor, args.port)
    print(json.dumps({"listening": f"http://127.0.0.1:{server.server_port}", **predictor.identity}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
