import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from openjarvis.core.registry import ToolRegistry

from jarvis_pc import approvals, phone_tools
from jarvis_pc.bot import build_prompt

TOKEN = "test-token"


class FakePhone(BaseHTTPRequestHandler):
    received: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_response(401)
            self.end_headers()
            return
        FakePhone.received.append(body)
        out = json.dumps({"ok": True, "message": f"done {body['action']}"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


@pytest.fixture
def phone(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), FakePhone)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("PHONE_BRIDGE_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("PHONE_BRIDGE_TOKEN", TOKEN)
    FakePhone.received = []
    yield FakePhone
    server.shutdown()


def test_tools_registered():
    for name in phone_tools.PHONE_TOOLS:
        assert ToolRegistry.contains(name)


def test_call_sms_open(phone):
    assert ToolRegistry.get("phone_call")().execute(target="Мама").success
    assert ToolRegistry.get("phone_sms")().execute(target="+15550001", text="hi").success
    assert approvals.confirm()[0]  # SMS waits for /yes
    assert ToolRegistry.get("phone_open_app")().execute(app="YouTube").success
    assert phone.received == [
        {"action": "call", "target": "Мама"},
        {"action": "sms", "target": "+15550001", "text": "hi"},
        {"action": "open_app", "app": "YouTube"},
    ]


def test_wrong_token(phone, monkeypatch):
    monkeypatch.setenv("PHONE_BRIDGE_TOKEN", "bad")
    res = ToolRegistry.get("phone_call")().execute(target="Мама")
    assert not res.success and "401" in res.content


def test_not_configured(monkeypatch):
    monkeypatch.delenv("PHONE_BRIDGE_URL", raising=False)
    res = ToolRegistry.get("phone_open_app")().execute(app="YouTube")
    assert not res.success


def test_missing_args():
    assert not ToolRegistry.get("phone_sms")().execute(target="Мама").success


def test_build_prompt_includes_history():
    from collections import deque

    assert build_prompt(None, "привет") == "привет"
    p = build_prompt(deque([("кто ты", "Пятница")]), "позвони маме")
    assert "Омар: кто ты" in p and p.endswith("позвони маме")
