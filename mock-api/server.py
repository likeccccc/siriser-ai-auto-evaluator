#!/usr/bin/env python3
"""极简评分 mock：POST /evaluate → 返回演示用 scores。"""
from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8787


def mock_score(model_id: str) -> dict:
    mid = (model_id or "").upper()
    if mid in {"D", "E"}:
        return {
            "model": mid,
            "alignment": None,
            "quality": None,
            "preservation": None,
            "consistency": None,
            "realism": None,
            "notes": "no_image",
            "defects": [],
        }
    if mid in {"A", "F"}:
        return {
            "model": mid,
            "alignment": 9,
            "quality": 9,
            "preservation": 9,
            "consistency": 8,
            "realism": 9,
            "rcr": 0.92,
            "notes": "mock:执行良好",
            "defects": [],
        }
    return {
        "model": mid,
        "alignment": 5,
        "quality": 5,
        "preservation": 4,
        "consistency": 5,
        "realism": 5,
        "rcr": 0.55,
        "notes": "mock:多处问题",
        "defects": [{"dim": "preservation", "level": 3, "where": "人脸", "what": "身份漂移"}],
    }


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {}
        models = body.get("models") or []
        # 也兼容无 id 只有序号的情况
        scores = [mock_score(m.get("id") or m.get("model") or str(i)) for i, m in enumerate(models)]
        if not scores:
            scores = [mock_score(x) for x in list("ABCDEF")]
        payload = json.dumps({"scores": scores}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if re.match(r"^/health/?$", self.path or "/"):
            data = b'{"ok":true}'
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        print("[mock-api]", fmt % args)


if __name__ == "__main__":
    print(f"Siriser mock API → http://127.0.0.1:{PORT}/evaluate")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
