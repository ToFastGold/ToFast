from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from datetime import date, datetime

import pytest

from goals_app.notifier import Notifier, change_text, month_result_text, reminder_text
from goals_app.server import make_server
from goals_app.store import BadRequest, GoalNotFound, Store


class Clock:
    def __init__(self, d: date) -> None:
        self.d = d

    def __call__(self) -> date:
        return self.d


@pytest.fixture
def clock():
    return Clock(date(2026, 11, 10))


@pytest.fixture
def store(tmp_path, clock):
    return Store(tmp_path / "goals.json", today=clock)


def test_percent_counts_days_since_goal_added(store, clock):
    clock.d = date(2026, 11, 6)
    g = store.add_goal("Спорт")
    clock.d = date(2026, 11, 10)
    for day in ("2026-11-06", "2026-11-07", "2026-11-08"):
        store.checkin(g["id"], day)
    s = store.summary()
    goal = s["goals"][0]
    # 6..9 counted (4 days), today not ticked yet so not counted
    assert goal["days_counted"] == 4
    assert goal["percent"] == 75.0
    assert goal["done_today"] is False
    store.checkin("спорт")  # by title, today
    goal = store.summary()["goals"][0]
    assert goal["days_counted"] == 5 and goal["percent"] == 80.0 and goal["done_today"]


def test_rewards_unlock_by_overall_percent(store, clock):
    clock.d = date(2026, 11, 1)
    a = store.add_goal("A")
    b = store.add_goal("B")
    store.set_rewards([{"percent": 80, "text": "кино"}, {"percent": 70, "text": "игры"}])
    clock.d = date(2026, 11, 5)
    for d in range(1, 5):
        store.checkin(a["id"], f"2026-11-0{d}")
    for d in range(1, 3):
        store.checkin(b["id"], f"2026-11-0{d}")
    s = store.summary()
    assert s["overall_percent"] == 75.0  # 6 of 8
    assert s["reward_unlocked"] and s["reward"] == "игры"
    assert s["next_reward"] == {"percent": 80, "text": "кино"}
    assert [r["unlocked"] for r in s["rewards"]] == [True, False]


def test_past_month_counts_every_day(store, clock):
    store.add_goal("Чтение", "2026-10")
    store.checkin("Чтение", "2026-10-03")
    s = store.summary("2026-10")
    assert s["goals"][0]["days_counted"] == 31
    assert s["days_left"] == 0


def test_validation(store):
    store.add_goal("A")
    with pytest.raises(BadRequest):
        store.add_goal("a")
    with pytest.raises(BadRequest):
        store.checkin("A", "2026-12-01")
    with pytest.raises(GoalNotFound):
        store.checkin("nope")
    with pytest.raises(BadRequest):
        store.set_rewards([{"percent": 120, "text": "x"}])


def test_copy_goals_and_persistence(tmp_path, clock):
    s1 = Store(tmp_path / "g.json", today=clock)
    s1.add_goal("A", "2026-10")
    s1.add_goal("B", "2026-10")
    assert s1.copy_goals("2026-10", "2026-11") == 2
    s2 = Store(tmp_path / "g.json", today=clock)
    assert [g["title"] for g in s2.goals_for("2026-11")] == ["A", "B"]


def test_texts(store, clock):
    store.set_rewards([{"percent": 70, "text": "игры"}])
    store.add_goal("Спорт")
    s = store.summary()
    assert "Спорт" in reminder_text(s)
    before = s
    store.checkin("Спорт")
    after = store.summary()
    assert "Открыта награда: игры" in change_text(before, after)
    assert "закрылась" in change_text(after, before)
    assert change_text(after, after) is None
    assert "Заработано: игры" in month_result_text(after)


def test_notifier_sends_once_per_day(store, clock):
    sent = []

    class FakeTg:
        def send(self, text):
            sent.append(text)

    n = Notifier(store, FakeTg(), "21:00")
    n.send = lambda text: text and sent.append(text)  # synchronous for the test
    store.add_goal("A")
    n.tick(datetime(2026, 11, 10, 20, 0))
    assert sent == []
    n.tick(datetime(2026, 11, 10, 21, 5))
    n.tick(datetime(2026, 11, 10, 22, 0))
    assert len(sent) == 1 and "A" in sent[0]


@pytest.fixture
def server(store):
    srv = make_server("127.0.0.1", 0, store, "secret")
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def call(url, body=None, token="secret"):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_api_flow(server):
    assert call(server + "/api/summary", token="wrong")[0] == 401
    status, r = call(server + "/api/goals", {"title": "Спорт"})
    assert status == 200 and r["ok"]
    gid = r["goal"]["id"]
    status, r = call(server + "/api/checkin", {"goal_id": "Спорт", "done": True})
    assert status == 200 and r["summary"]["goals"][0]["done_today"]
    status, s = call(server + "/api/summary")
    assert s["month"] == "2026-11" and s["overall_percent"] == 100.0
    assert {"id", "title", "percent", "done_today"} <= set(s["goals"][0])
    assert {"reward_unlocked", "reward", "next_reward", "days_left"} <= set(s)
    status, r = call(server + "/api/checkin", {"goal_id": "missing"})
    assert status == 404 and not r["ok"]
    status, r = call(server + "/api/goals/delete", {"goal_id": gid})
    assert status == 200 and r["summary"]["goals"] == []


def test_static_served_without_token(server):
    with urllib.request.urlopen(server + "/") as r:
        assert b"<title>" in r.read()
    status, _ = call(server + "/../goals.json", token="")
    assert status == 404


def test_changing_rewards_keeps_other_months(store, clock):
    store.add_goal("A", "2026-10")
    store.set_rewards([], "2026-09")
    store.set_rewards([{"percent": 90, "text": "new"}])
    assert store.summary("2026-09")["rewards"] == []
    assert [r["percent"] for r in store.summary("2026-10")["rewards"]] == [70, 80]
    assert store.summary("2026-12")["days_left"] == 31
