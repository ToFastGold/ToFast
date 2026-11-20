"""HTTP server: phone web app (static files) + JSON API for the app and for Пятница."""

from __future__ import annotations

import hmac
import json
import logging
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from goals_app.notifier import Notifier
from goals_app.store import BadRequest, GoalNotFound, Store, month_key, previous_month

logger = logging.getLogger("goals_app.server")

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY = 64 * 1024


def make_handler(store: Store, token: str, notifier: Notifier | None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Goals/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            logger.info("%s %s", self.address_string(), fmt % args)

        # ---------- helpers ----------

        def send_json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self) -> bool:
            if not token:
                return True
            header = self.headers.get("Authorization", "")
            given = header[7:] if header.startswith("Bearer ") else ""
            return hmac.compare_digest(given.encode(), token.encode())

        def read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise BadRequest("Слишком большой запрос")
            raw = self.rfile.read(length) if length else b"{}"
            try:
                data = json.loads(raw or b"{}")
            except ValueError as exc:
                raise BadRequest("Тело запроса должно быть JSON") from exc
            if not isinstance(data, dict):
                raise BadRequest("Тело запроса должно быть JSON-объектом")
            return data

        def serve_static(self, path: str) -> None:
            name = "index.html" if path in ("", "/") else path.lstrip("/")
            file = (STATIC_DIR / name).resolve()
            if STATIC_DIR not in file.parents or not file.is_file():
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
                return
            body = file.read_bytes()
            ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            if file.suffix == ".webmanifest":
                ctype = "application/manifest+json"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)

        def dispatch(self, method: str) -> None:
            url = urlparse(self.path)
            if not url.path.startswith("/api/"):
                if method == "GET":
                    self.serve_static(url.path)
                else:
                    self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "method not allowed"})
                return
            if not self.authorized():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "Нужен токен (GOALS_API_TOKEN)"})
                return
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                status, payload = self.route(method, url.path, query)
            except GoalNotFound as exc:
                status, payload = HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc)}
            except BadRequest as exc:
                status, payload = HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)}
            self.send_json(status, payload)

        def route(self, method: str, path: str, query: dict[str, str]) -> tuple[int, Any]:
            month = query.get("month") or None
            if method == "GET" and path == "/api/summary":
                return HTTPStatus.OK, store.summary(month)
            if method != "POST":
                return HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"}
            body = self.read_json()
            month = body.get("month") or month
            if path == "/api/checkin":
                day = body.get("date")
                target_month = day[:7] if isinstance(day, str) and len(day) >= 7 else None
                before = store.summary(target_month)
                store.checkin(body.get("goal_id", ""), day, bool(body.get("done", True)))
                after = store.summary(target_month)
                if notifier:
                    notifier.after_checkin(before, after)
                return HTTPStatus.OK, {"ok": True, "summary": after}
            if path == "/api/goals":
                goal = store.add_goal(body.get("title", ""), month, body.get("days"))
                return HTTPStatus.OK, {"ok": True, "goal": goal, "summary": store.summary(goal["month"])}
            if path == "/api/goals/schedule":
                goal = store.set_schedule(body.get("goal_id", ""), body.get("days"), month)
                return HTTPStatus.OK, {"ok": True, "summary": store.summary(goal["month"])}
            if path == "/api/goals/delete":
                store.delete_goal(body.get("goal_id", ""), month)
                return HTTPStatus.OK, {"ok": True, "summary": store.summary(month)}
            if path == "/api/goals/copy":
                to_month = month or month_key(store.today())
                added = store.copy_goals(previous_month(to_month), to_month)
                return HTTPStatus.OK, {"ok": True, "added": added, "summary": store.summary(to_month)}
            if path == "/api/rewards":
                store.set_rewards(body.get("rewards"), month)
                return HTTPStatus.OK, {"ok": True, "summary": store.summary(month)}
            return HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"}

        def do_GET(self) -> None:  # noqa: N802
            self.dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self.dispatch("POST")

    return Handler


def make_server(host: str, port: int, store: Store, token: str, notifier: Notifier | None = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(store, token, notifier))
