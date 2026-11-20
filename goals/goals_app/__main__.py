"""Entry point: `python -m goals_app` (run from the goals/ folder)."""

from __future__ import annotations

import logging
import os
import socket
import threading
from pathlib import Path

from goals_app.notifier import Notifier, Telegram
from goals_app.server import make_server
from goals_app.store import Store

ROOT = Path(__file__).resolve().parent.parent
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def load_env(path: Path) -> None:
    """Minimal .env reader. Never overrides variables that are already set."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key, value)


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "IP-компьютера"


def main() -> None:
    load_env(ROOT / ".env")
    load_env(ROOT.parent / "pc" / ".env")  # Telegram token and chat id are shared with Пятница
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    host = os.environ.get("GOALS_HOST", "0.0.0.0")
    port = int(os.environ.get("GOALS_PORT", "8787"))
    token = os.environ.get("GOALS_API_TOKEN", "")
    if host not in LOCAL_HOSTS and not token:
        raise SystemExit(
            "GOALS_API_TOKEN пуст, а сервер открыт для сети. Впиши длинную случайную строку в goals/.env "
            "или поставь GOALS_HOST=127.0.0.1."
        )
    data_path = Path(os.environ.get("GOALS_DATA", ROOT / "data" / "goals.json"))
    store = Store(data_path)

    telegram = Telegram.from_env()
    notifier = Notifier(store, telegram, os.environ.get("GOALS_REMIND_AT", "21:00"))
    if telegram:
        threading.Thread(target=notifier.run_forever, daemon=True).start()
    else:
        logging.warning("Telegram не настроен: напоминаний не будет (нужны TELEGRAM_BOT_TOKEN и TELEGRAM_ALLOWED_CHAT_IDS)")

    server = make_server(host, port, store, token, notifier)
    shown = lan_ip() if host == "0.0.0.0" else host
    logging.info("Трекер целей: http://%s:%d  (данные: %s)", shown, port, data_path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
