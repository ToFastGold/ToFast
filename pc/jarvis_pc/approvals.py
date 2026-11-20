"""Pending actions that need Omar's /yes in Telegram before they run.

Used for anything that costs money, sends something on his behalf, or runs a
command on the PC. One user, so one pending slot is enough.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable

EXPIRES_SECONDS = 600


@dataclass
class Pending:
    description: str
    run: Callable[[], tuple[bool, str]]
    created: float


_lock = threading.Lock()
_pending: Pending | None = None


def request(description: str, run: Callable[[], tuple[bool, str]]) -> tuple[bool, str]:
    """Park an action and return the text the agent should pass to Omar."""
    global _pending
    with _lock:
        _pending = Pending(description, run, time.time())
    return True, (
        f"ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ: {description}. Действие ещё НЕ выполнено. "
        "Скажи Омару, что именно будет сделано, и что нужно ответить /yes или /no."
    )


def current() -> Pending | None:
    with _lock:
        if _pending and time.time() - _pending.created > EXPIRES_SECONDS:
            return None
        return _pending


def confirm() -> tuple[bool, str]:
    global _pending
    with _lock:
        p, _pending = _pending, None
    if p is None or time.time() - p.created > EXPIRES_SECONDS:
        return False, "Нечего подтверждать."
    ok, msg = p.run()
    return ok, msg


def cancel() -> str:
    global _pending
    with _lock:
        p, _pending = _pending, None
    return f"Отменено: {p.description}" if p else "Нечего отменять."


# Untrusted content (email bodies) can carry instructions aimed at the model.
# Once such content was read while handling the current message, outbound
# actions that normally run directly also need /yes.
_untrusted_seen = False


def reset_turn() -> None:
    global _untrusted_seen
    _untrusted_seen = False


def mark_untrusted() -> None:
    global _untrusted_seen
    _untrusted_seen = True


def untrusted_seen() -> bool:
    return _untrusted_seen


def guard(description: str, run: Callable[[], tuple[bool, str]]) -> tuple[bool, str]:
    """Run now, unless untrusted content was read this turn; then ask for /yes."""
    if _untrusted_seen:
        return request(description, run)
    return run()
