"""Goals data: monthly goals, daily ticks, reward tiers. Stored in one JSON file.

Percent for a goal = ticked days / counted days. Counted days run from the
later of (month start, day the goal was added) up to yesterday, plus today
once it is ticked. So an unticked morning does not drag the number down.
"""

from __future__ import annotations

import calendar
import json
import os
import threading
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Any

DEFAULT_REWARDS = [
    {"percent": 70, "text": "Вечер игр без чувства вины"},
    {"percent": 80, "text": "Покупка до 50$ на что хочу"},
]


class GoalNotFound(Exception):
    pass


class BadRequest(Exception):
    pass


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def parse_month(key: str) -> tuple[date, date]:
    try:
        year, month = (int(p) for p in key.split("-"))
        first = date(year, month, 1)
    except (ValueError, TypeError) as exc:
        raise BadRequest(f"Неверный месяц: {key!r}, нужно YYYY-MM") from exc
    last = date(year, month, calendar.monthrange(year, month)[1])
    return first, last


def parse_day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError) as exc:
        raise BadRequest(f"Неверная дата: {value!r}, нужно YYYY-MM-DD") from exc


def clean_rewards(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise BadRequest("rewards должен быть списком")
    out = []
    for item in raw:
        try:
            pct = int(item["percent"])
            text = str(item["text"]).strip()
        except (KeyError, TypeError, ValueError) as exc:
            raise BadRequest("Каждая награда: {percent: число, text: строка}") from exc
        if not 1 <= pct <= 100 or not text:
            raise BadRequest("Процент награды от 1 до 100, текст не пустой")
        out.append({"percent": pct, "text": text[:200]})
    out.sort(key=lambda r: r["percent"])
    return out


class Store:
    def __init__(self, path: Path, today=date.today) -> None:
        self.path = Path(path)
        self.today = today  # injectable for tests
        self.lock = threading.RLock()
        self.data = self._load()

    # ---------- persistence ----------

    def _load(self) -> dict[str, Any]:
        if self.path.exists():
            with self.path.open(encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = {}
        data.setdefault("goals", [])
        data.setdefault("checks", {})
        data.setdefault("rewards", {})
        data.setdefault("default_rewards", DEFAULT_REWARDS)
        data.setdefault("sent", {})
        return data

    def save(self) -> None:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)

    # ---------- goals ----------

    def goals_for(self, month: str) -> list[dict[str, Any]]:
        return [g for g in self.data["goals"] if g["month"] == month]

    def find_goal(self, ref: str, month: str | None = None) -> dict[str, Any]:
        month = month or month_key(self.today())
        ref = str(ref or "").strip()
        goals = self.goals_for(month)
        for g in goals:
            if g["id"] == ref:
                return g
        for g in goals:
            if g["title"].casefold() == ref.casefold():
                return g
        raise GoalNotFound(f"Цель не найдена: {ref!r}")

    def add_goal(self, title: str, month: str | None = None) -> dict[str, Any]:
        title = str(title or "").strip()[:100]
        if not title:
            raise BadRequest("Пустое название цели")
        today = self.today()
        month = month or month_key(today)
        first, _ = parse_month(month)
        with self.lock:
            if any(g["title"].casefold() == title.casefold() for g in self.goals_for(month)):
                raise BadRequest(f"Цель {title!r} уже есть в этом месяце")
            created = today if month == month_key(today) else first
            goal = {
                "id": uuid.uuid4().hex[:8],
                "title": title,
                "month": month,
                "created": created.isoformat(),
            }
            self.data["goals"].append(goal)
            self.data["checks"][goal["id"]] = []
            self.save()
        return goal

    def delete_goal(self, ref: str, month: str | None = None) -> None:
        with self.lock:
            goal = self.find_goal(ref, month)
            self.data["goals"].remove(goal)
            self.data["checks"].pop(goal["id"], None)
            self.save()

    def copy_goals(self, from_month: str, to_month: str) -> int:
        parse_month(from_month)
        parse_month(to_month)
        added = 0
        with self.lock:
            existing = {g["title"].casefold() for g in self.goals_for(to_month)}
            for g in self.goals_for(from_month):
                if g["title"].casefold() not in existing:
                    self.add_goal(g["title"], to_month)
                    added += 1
        return added

    def checkin(self, ref: str, day: str | None = None, done: bool = True) -> dict[str, Any]:
        today = self.today()
        d = parse_day(day) if day else today
        if d > today:
            raise BadRequest("Нельзя отметить день из будущего")
        with self.lock:
            goal = self.find_goal(ref, month_key(d))
            if d < date.fromisoformat(goal["created"]):
                raise BadRequest("Цель ещё не существовала в этот день")
            days = set(self.data["checks"].setdefault(goal["id"], []))
            if done:
                days.add(d.isoformat())
            else:
                days.discard(d.isoformat())
            self.data["checks"][goal["id"]] = sorted(days)
            self.save()
        return goal

    # ---------- rewards ----------

    def rewards_for(self, month: str) -> list[dict[str, Any]]:
        return self.data["rewards"].get(month) or self.data["default_rewards"]

    def set_rewards(self, rewards: Any, month: str | None = None) -> list[dict[str, Any]]:
        cleaned = clean_rewards(rewards)
        month = month or month_key(self.today())
        parse_month(month)
        with self.lock:
            self.data["rewards"][month] = cleaned
            self.data["default_rewards"] = cleaned  # next months start with the same list
            self.save()
        return cleaned

    # ---------- numbers ----------

    def summary(self, month: str | None = None) -> dict[str, Any]:
        today = self.today()
        month = month or month_key(today)
        first, last = parse_month(month)
        with self.lock:
            goals_out = []
            total_done = total_counted = 0
            for g in self.goals_for(month):
                start = max(first, date.fromisoformat(g["created"]))
                done_dates = [d for d in self.data["checks"].get(g["id"], []) if month_key(date.fromisoformat(d)) == month]
                done_today = today.isoformat() in done_dates
                if last < today:
                    counted = (last - start).days + 1
                elif first > today:
                    counted = 0
                else:
                    counted = max(0, (today - start).days) + (1 if done_today else 0)
                done = len(done_dates)
                pct = round(100.0 * done / counted, 1) if counted else 0.0
                total_done += done
                total_counted += counted
                goals_out.append(
                    {
                        "id": g["id"],
                        "title": g["title"],
                        "percent": pct,
                        "done_today": done_today,
                        "done_days": done,
                        "days_counted": counted,
                        "created": g["created"],
                        "done_dates": done_dates,
                    }
                )
            overall = round(100.0 * total_done / total_counted, 1) if total_counted else 0.0
            tiers = self.rewards_for(month)
            unlocked = [r for r in tiers if overall >= r["percent"]] if total_counted else []
            locked = [r for r in tiers if r not in unlocked]
            days_left = 0 if last < today else (last - max(today, first)).days + (0 if first > today else 1)
            return {
                "month": month,
                "today": today.isoformat(),
                "days_in_month": last.day,
                "days_left": days_left,
                "overall_percent": overall,
                "reward_unlocked": bool(unlocked),
                "reward": unlocked[-1]["text"] if unlocked else None,
                "reward_percent": unlocked[-1]["percent"] if unlocked else None,
                "next_reward": locked[0] if locked else None,
                "rewards": [{**r, "unlocked": r in unlocked} for r in tiers],
                "goals": goals_out,
            }

    # ---------- notifier bookkeeping ----------

    def get_sent(self, key: str) -> Any:
        return self.data["sent"].get(key)

    def set_sent(self, key: str, value: Any) -> None:
        with self.lock:
            self.data["sent"][key] = value
            self.save()


def previous_month(month: str) -> str:
    first, _ = parse_month(month)
    return month_key(first - timedelta(days=1))
