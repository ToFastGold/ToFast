"""Link to Omar's monthly goals tracker (separate app) over a small HTTP API.

GET  {GOALS_API_URL}/api/summary  -> {"month", "overall_percent", "reward_unlocked", "reward", "goals": [...]}
POST {GOALS_API_URL}/api/checkin  {"goal_id", "date", "done"} -> {"ok": true}
"""

from __future__ import annotations

import datetime as dt
import os

import httpx

from jarvis_pc._base import simple_tool, string

TOOLS = ["goals_status", "goals_checkin"]


def configured() -> bool:
    return bool(os.environ.get("GOALS_API_URL"))


def _headers() -> dict[str, str]:
    token = os.environ.get("GOALS_API_TOKEN", "")
    return {"Authorization": f"Bearer {token}"} if token else {}


def _url(path: str) -> str:
    return os.environ["GOALS_API_URL"].rstrip("/") + path


@simple_tool(
    "goals_status",
    "Get this month's goals, percent done for each, overall percent and whether the reward is unlocked.",
    {},
    [],
    "goals",
)
def goals_status() -> tuple[bool, str]:
    data = httpx.get(_url("/api/summary"), headers=_headers(), timeout=10).raise_for_status().json()
    lines = [f"Месяц {data.get('month')}: выполнено {data.get('overall_percent')}%"]
    for g in data.get("goals", []):
        if g.get("done_today"):
            mark = "сегодня ✓"
        elif g.get("scheduled_today", True):
            mark = "сегодня ещё нет"
        else:
            mark = "сегодня не по расписанию"
        streak = f", серия {g['streak']} дн." if g.get("streak") else ""
        lines.append(f"- {g.get('title')} (id {g.get('id')}): {g.get('percent')}%, {mark}{streak}")
    if data.get("reward"):
        state = "открыта" if data.get("reward_unlocked") else "пока закрыта"
        lines.append(f"Награда «{data['reward']}»: {state}")
    nxt = data.get("next_reward")
    if nxt:
        lines.append(f"Следующая награда при {nxt.get('percent')}%: {nxt.get('text')}")
    if data.get("days_left") is not None:
        lines.append(f"Дней до конца месяца: {data['days_left']}")
    return True, "\n".join(lines)


@simple_tool(
    "goals_checkin",
    "Mark a goal as done (or not done) for a day.",
    {"goal_id": string("Goal id or goal title, e.g. 'Спорт'"), "date": string("YYYY-MM-DD, default today"), "done": {"type": "boolean"}},
    ["goal_id"],
    "goals",
)
def goals_checkin(goal_id: str, date: str = "", done: bool = True) -> tuple[bool, str]:
    payload = {"goal_id": goal_id, "date": date or dt.date.today().isoformat(), "done": done}
    httpx.post(_url("/api/checkin"), json=payload, headers=_headers(), timeout=10).raise_for_status()
    return True, f"Отметила: {goal_id}, {payload['date']}, {'сделано' if done else 'не сделано'}."
