"""Telegram bot: messages from Omar -> OpenJarvis agent (Claude) -> reply."""

from __future__ import annotations

import asyncio
import logging
import os
from collections import deque
from pathlib import Path

from openjarvis import Jarvis
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

from jarvis_pc import (  # importing registers the tools in OpenJarvis
    approvals,
    email_tools,
    goals_tools,
    notes_tools,
    pc_tools,
    phone_tools,
    twilio_tools,
)

logger = logging.getLogger("jarvis_pc")

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.toml"
HISTORY_TURNS = 6  # past exchanges sent along with each new message
EXTRA_TOOLS = ["think", "calculator", "web_search"]
TELEGRAM_LIMIT = 4000


def allowed_chat_ids() -> set[str]:
    raw = os.environ.get("TELEGRAM_ALLOWED_CHAT_IDS", "")
    return {c.strip() for c in raw.split(",") if c.strip()}


def build_prompt(history: deque[tuple[str, str]] | None, text: str) -> str:
    if not history:
        return text
    lines = ["Предыдущий разговор:"]
    for user_msg, reply in history:
        lines.append(f"Омар: {user_msg}")
        lines.append(f"Пятница: {reply}")
    lines += ["", f"Новое сообщение от Омара: {text}"]
    return "\n".join(lines)


def enabled_tools() -> list[str]:
    """Tools for integrations that are set up in .env. Unset ones stay hidden from the model."""
    tools = phone_tools.PHONE_TOOLS + notes_tools.TOOLS + pc_tools.TOOLS + EXTRA_TOOLS
    if email_tools.configured():
        tools += email_tools.TOOLS
    if twilio_tools.enabled():
        tools += twilio_tools.TOOLS
    if goals_tools.configured():
        tools += goals_tools.TOOLS
    return tools


class JarvisBot:
    def __init__(self) -> None:
        self.allowed = allowed_chat_ids()
        if not self.allowed:
            raise SystemExit(
                "TELEGRAM_ALLOWED_CHAT_IDS пуст. Узнай свой chat id у @userinfobot и впиши его в .env, "
                "иначе бот будет отвечать кому угодно."
            )
        self.token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not self.token:
            raise SystemExit("TELEGRAM_BOT_TOKEN пуст. Создай бота у @BotFather и впиши токен в .env.")
        self.jarvis = Jarvis(config_path=str(CONFIG_PATH))
        self.agent = self.jarvis.config.agent.default_agent or "orchestrator"
        self.tools = enabled_tools()
        self.history: dict[str, deque[tuple[str, str]]] = {}
        self.busy = asyncio.Lock()  # one request at a time keeps API spend predictable

    def ask(self, chat: str, text: str) -> str:
        approvals.reset_turn()
        prompt = build_prompt(self.history.get(chat), text)
        reply = self.jarvis.ask(prompt, agent=self.agent, tools=self.tools, context=False)
        self.history.setdefault(chat, deque(maxlen=HISTORY_TURNS)).append((text, reply))
        return reply

    async def on_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        msg = update.effective_message
        chat = str(update.effective_chat.id) if update.effective_chat else ""
        if msg is None or chat not in self.allowed:
            logger.warning("Ignoring message from chat %s", chat)
            return
        text = (msg.text or "").strip()
        if not text:
            return
        async with self.busy:
            await context.bot.send_chat_action(chat_id=chat, action="typing")
            try:
                reply = await asyncio.to_thread(self.ask, chat, text)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Agent failed")
                reply = f"Ошибка: {exc}"
        for i in range(0, len(reply) or 1, TELEGRAM_LIMIT):
            await msg.reply_text(reply[i : i + TELEGRAM_LIMIT] or "(пустой ответ)")

    async def on_reset(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat = str(update.effective_chat.id) if update.effective_chat else ""
        if chat not in self.allowed:
            return
        self.history.pop(chat, None)
        await update.effective_message.reply_text("Готова. Пиши, что нужно сделать.")

    async def on_yes(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat = str(update.effective_chat.id) if update.effective_chat else ""
        if chat not in self.allowed:
            return
        async with self.busy:
            try:
                ok, message = await asyncio.to_thread(approvals.confirm)
            except Exception as exc:  # noqa: BLE001
                ok, message = False, f"Ошибка: {exc}"
        await update.effective_message.reply_text(("✅ " if ok else "⚠️ ") + message)

    async def on_no(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat = str(update.effective_chat.id) if update.effective_chat else ""
        if chat not in self.allowed:
            return
        await update.effective_message.reply_text(approvals.cancel())

    def run(self) -> None:
        app = ApplicationBuilder().token(self.token).build()
        app.add_handler(CommandHandler(["start", "reset"], self.on_reset))
        app.add_handler(CommandHandler("yes", self.on_yes))
        app.add_handler(CommandHandler("no", self.on_no))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.on_text))
        logger.info("Пятница запущена. Агент=%s, инструменты=%s", self.agent, ",".join(self.tools))
        try:
            app.run_polling()
        finally:
            self.jarvis.close()
