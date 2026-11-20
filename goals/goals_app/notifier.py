"""Telegram messages from the goals tracker: evening reminder, reward unlocked/lost, month result.

Uses Bot API sendMessage only (no polling), so it can share the bot token with
Пятница's Telegram bot without conflicts.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request
from datetime import datetime

from goals_app.store import Store, month_key, previous_month

logger = logging.getLogger("goals_app.notifier")

MONTHS_RU = [
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
]


def month_name(month: str) -> str:
    return MONTHS_RU[int(month.split("-")[1]) - 1]


class Telegram:
    def __init__(self, token: str, chat_ids: list[str]) -> None:
        self.token = token
        self.chat_ids = chat_ids

    @classmethod
    def from_env(cls) -> "Telegram | None":
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        chats = [c.strip() for c in os.environ.get("TELEGRAM_ALLOWED_CHAT_IDS", "").split(",") if c.strip()]
        if not token or not chats:
            return None
        return cls(token, chats)

    def send(self, text: str) -> None:
        for chat in self.chat_ids:
            body = json.dumps({"chat_id": chat, "text": text}).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                data=body,
                headers={"Content-Type": "application/json"},
            )
            try:
                urllib.request.urlopen(req, timeout=15).read()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Telegram send failed: %s", exc)


def reminder_text(s: dict) -> str | None:
    if not s["goals"]:
        return None
    left = [g["title"] for g in s["goals"] if g["scheduled_today"] and not g["done_today"]]
    lines = []
    if left:
        lines.append("Вечерняя проверка. Сегодня ещё не отмечено: " + ", ".join(left) + ".")
    else:
        lines.append("Всё, что было на сегодня, отмечено. Красавчик.")
    lines.append(f"За {month_name(s['month'])}: {s['overall_percent']:.0f}%.")
    if s["reward"]:
        lines.append(f"Сейчас открыто: {s['reward']}.")
    if s["next_reward"]:
        lines.append(f"До награды \"{s['next_reward']['text']}\" нужно {s['next_reward']['percent']}%.")
    return " ".join(lines)


def change_text(before: dict, after: dict) -> str | None:
    """Message when a check-in opens or closes a reward tier."""
    b, a = before.get("reward_percent"), after.get("reward_percent")
    if b == a:
        return None
    if a is not None and (b is None or a > b):
        return f"Открыта награда: {after['reward']} ({after['overall_percent']:.0f}%). Держи уровень до конца месяца."
    if b is not None:
        lost = next(r["text"] for r in before["rewards"] if r["percent"] == b)
        return f"Награда \"{lost}\" закрылась: {after['overall_percent']:.0f}%, нужно {b}%. Ещё можно вернуть."
    return None


def month_result_text(s: dict) -> str | None:
    if not s["goals"]:
        return None
    name = month_name(s["month"]).capitalize()
    if s["reward"]:
        return f"Итог за {name.lower()}: {s['overall_percent']:.0f}%. Заработано: {s['reward']}. Разрешаю."
    need = s["rewards"][0]["percent"] if s["rewards"] else 70
    return f"Итог за {name.lower()}: {s['overall_percent']:.0f}%. Порог {need}% не взят, награды в этот раз нет."


class Notifier:
    def __init__(self, store: Store, telegram: Telegram | None, remind_at: str = "21:00") -> None:
        self.store = store
        self.telegram = telegram
        hh, mm = remind_at.split(":")
        self.remind_at = (int(hh), int(mm))

    def send(self, text: str | None) -> None:
        if text and self.telegram:
            threading.Thread(target=self.telegram.send, args=(text,), daemon=True).start()

    def after_checkin(self, before: dict, after: dict) -> None:
        if before["month"] == month_key(self.store.today()):
            self.send(change_text(before, after))

    def tick(self, now: datetime) -> None:
        """Called every minute. Sends at most one reminder per day and one result per month."""
        if (now.hour, now.minute) < self.remind_at:
            return
        today = now.date().isoformat()
        if self.store.get_sent("reminder") != today:
            self.store.set_sent("reminder", today)
            self.send(reminder_text(self.store.summary()))
        prev = previous_month(month_key(now.date()))
        if self.store.get_sent("month_result") != prev:
            self.store.set_sent("month_result", prev)
            self.send(month_result_text(self.store.summary(prev)))

    def run_forever(self) -> None:
        while True:
            try:
                self.tick(datetime.now())
            except Exception:  # noqa: BLE001
                logger.exception("Notifier tick failed")
            time.sleep(60)
