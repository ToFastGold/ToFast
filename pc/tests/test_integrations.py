import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from openjarvis.core.registry import ToolRegistry

from jarvis_pc import approvals, bot, goals_tools, notes_tools, pc_tools, twilio_tools


def tool(name):
    return ToolRegistry.get(name)()


@pytest.fixture(autouse=True)
def clean(monkeypatch, tmp_path):
    for k in ("EMAIL_ADDRESS", "EMAIL_PROVIDER", "MS_CLIENT_ID", "TWILIO_ENABLED", "GOALS_API_URL", "GOALS_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("NOTES_DIR", str(tmp_path / "notes"))
    approvals.cancel()


def test_notes_roundtrip():
    assert tool("notes_add").execute(title="Покупки", text="молоко").success
    assert tool("notes_add").execute(title="Покупки", text="хлеб").success
    found = tool("notes_search").execute(query="хлеб")
    assert found.success and "Покупки" in found.content
    full = tool("notes_read").execute(title="Покупки").content
    assert "молоко" in full and "хлеб" in full


def test_notes_no_path_escape():
    assert not tool("notes_read").execute(title="../../etc/passwd").success


def test_pc_run_waits_for_yes(monkeypatch):
    ran = []
    monkeypatch.setattr(pc_tools, "_run", lambda c: (ran.append(c), (True, "done"))[1])
    res = tool("pc_run").execute(command="Get-Date")
    assert "ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ" in res.content and ran == []
    assert approvals.confirm() == (True, "done") and ran == ["Get-Date"]
    assert approvals.confirm()[0] is False  # nothing left


def test_cancel():
    tool("pc_run").execute(command="shutdown /s")
    assert "Отменено" in approvals.cancel()
    assert approvals.confirm()[0] is False


def test_pc_list_files(tmp_path):
    (tmp_path / "a.txt").write_text("x")
    res = tool("pc_list_files").execute(path=str(tmp_path))
    assert res.success and "a.txt" in res.content


def test_twilio_needs_yes(monkeypatch):
    sent = []
    monkeypatch.setattr(twilio_tools, "_post", lambda r, d: (sent.append((r, d)), (True, "ok"))[1])
    tool("twilio_call").execute(to="+15550001", message="Привет")
    assert sent == []
    approvals.confirm()
    assert sent[0][0] == "Calls" and 'language="ru-RU"' in sent[0][1]["Twiml"]


def test_enabled_tools_follow_env(monkeypatch):
    base = bot.enabled_tools()
    assert "notes_add" in base and "email_send" not in base and "twilio_sms" not in base
    monkeypatch.setenv("GOALS_API_URL", "http://x")
    assert "goals_status" in bot.enabled_tools()
    monkeypatch.setenv("TWILIO_ENABLED", "1")
    assert "twilio_sms" not in bot.enabled_tools()  # still needs credentials


class FakeGoals(BaseHTTPRequestHandler):
    posts: list = []

    def _send(self, obj, code=200):
        out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):  # noqa: N802
        self._send({
            "month": "2026-11", "overall_percent": 75.0, "reward_unlocked": True, "reward": "Кино",
            "next_reward": {"percent": 90, "text": "Наушники"}, "days_left": 10,
            "goals": [{"id": "g1", "title": "Спорт", "percent": 80.0, "done_today": False, "streak": 3},
                      {"id": "g2", "title": "Чтение", "percent": 50.0, "done_today": False, "scheduled_today": False}],
        })

    def do_POST(self):  # noqa: N802
        FakeGoals.posts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self._send({"ok": True})

    def log_message(self, *a):
        pass


def test_goals(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), FakeGoals)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("GOALS_API_URL", f"http://127.0.0.1:{server.server_port}")
    try:
        status = tool("goals_status").execute().content
        assert "75.0%" in status and "Спорт" in status and "Наушники" in status
        assert "серия 3" in status and "не по расписанию" in status
        assert tool("goals_checkin").execute(goal_id="Спорт").success
        assert FakeGoals.posts[-1]["goal_id"] == "Спорт" and FakeGoals.posts[-1]["done"] is True
    finally:
        server.shutdown()


RAW = (
    "From: Bob <bob@example.com>\r\nSubject: =?utf-8?b?0J/RgNC40LLQtdGC?=\r\n"
    "Date: Thu, 20 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello Omar\r\n"
).encode()


class FakeImap:
    def uid(self, cmd, *args):
        if cmd == "search":
            return "OK", [b"1 2"]
        return "OK", [(b"x", RAW)]

    def logout(self):
        pass


def test_email(monkeypatch):
    from jarvis_pc import email_tools

    monkeypatch.setattr(email_tools, "_imap", lambda: FakeImap())
    listed = tool("email_list").execute().content
    assert "[2]" in listed and "Привет" in listed and "bob@example.com" in listed
    assert "Hello Omar" in tool("email_read").execute(id="2").content
    sent = []
    monkeypatch.setattr(email_tools, "_send", lambda *a: (sent.append(a), (True, "ok"))[1])
    assert "ОЖИДАЕТ" in tool("email_send").execute(to="a@b.c", subject="s", body="b").content
    assert sent == []
    approvals.confirm()
    assert sent == [("a@b.c", "s", "b")]


class FakeResp:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


def test_email_microsoft(monkeypatch):
    from jarvis_pc import email_tools, ms_graph

    monkeypatch.setenv("EMAIL_PROVIDER", "microsoft")
    monkeypatch.setenv("MS_CLIENT_ID", "cid")
    calls = []

    def fake_request(method, path, **kw):
        calls.append((method, path, kw))
        if path.endswith("/messages"):
            return FakeResp({"value": [{"id": "AAA", "subject": "Exam", "receivedDateTime": "2026-11-20",
                                        "from": {"emailAddress": {"name": "Prof", "address": "p@uvic.ca"}}}]})
        if path.startswith("/me/messages/"):
            return FakeResp({"subject": "Exam", "from": {"emailAddress": {"name": "Prof", "address": "p@uvic.ca"}},
                             "body": {"contentType": "html", "content": "<p>Room&nbsp;B12</p><style>x{}</style>"}})
        return FakeResp({})

    monkeypatch.setattr(ms_graph, "_request", fake_request)
    assert email_tools.configured()
    listed = tool("email_list").execute(unread_only=True).content
    assert "[AAA]" in listed and "p@uvic.ca" in listed
    assert calls[0][2]["params"]["$filter"] == "isRead eq false"
    body = tool("email_read").execute(id="AAA").content
    assert "Room" in body and "B12" in body and "<p>" not in body and "x{}" not in body
    tool("email_send").execute(to="a@uvic.ca", subject="Hi", body="text")
    assert approvals.confirm()[0]
    method, path, kw = calls[-1]
    assert (method, path) == ("POST", "/me/sendMail")
    assert kw["json"]["message"]["toRecipients"] == [{"emailAddress": {"address": "a@uvic.ca"}}]


def test_ms_not_logged_in(monkeypatch, tmp_path):
    from jarvis_pc import ms_graph

    monkeypatch.setenv("MS_CLIENT_ID", "00000000-0000-0000-0000-000000000000")
    monkeypatch.setattr(ms_graph, "_cache_path", lambda: tmp_path / "tok.json")
    monkeypatch.setattr(ms_graph, "_app", lambda: (type("A", (), {"get_accounts": lambda self: []})(), None))
    monkeypatch.setattr(ms_graph, "_save", lambda c: None)
    with pytest.raises(RuntimeError, match="login-email"):
        ms_graph._token()
