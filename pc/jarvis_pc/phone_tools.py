"""Phone tools: OpenJarvis tools that send commands to the Android bridge app.

The bridge app runs a small HTTP server on the phone. Every request carries a
shared token. See docs/architecture.md for the protocol.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import ToolResult
from openjarvis.tools._stubs import BaseTool, ToolSpec

TIMEOUT_SECONDS = 10.0


def bridge_url() -> str:
    return os.environ.get("PHONE_BRIDGE_URL", "").rstrip("/")


def bridge_token() -> str:
    return os.environ.get("PHONE_BRIDGE_TOKEN", "")


def send_command(action: str, payload: dict[str, Any]) -> tuple[bool, str]:
    """POST one command to the phone. Returns (ok, message)."""
    url = bridge_url()
    token = bridge_token()
    if not url or not token:
        return False, "Телефон не настроен: задай PHONE_BRIDGE_URL и PHONE_BRIDGE_TOKEN в .env"
    try:
        resp = httpx.post(
            f"{url}/command",
            json={"action": action, **payload},
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        return False, f"Телефон недоступен ({url}): {exc}"
    if resp.status_code == 401:
        return False, "Телефон отклонил токен (401). Проверь PHONE_BRIDGE_TOKEN."
    try:
        data = resp.json()
    except ValueError:
        data = {}
    message = str(data.get("message") or resp.text or resp.status_code)
    return resp.is_success and bool(data.get("ok", True)), message


def _result(name: str, ok: bool, message: str) -> ToolResult:
    return ToolResult(tool_name=name, content=message, success=ok)


@ToolRegistry.register("phone_call")
class PhoneCallTool(BaseTool):
    tool_id = "phone_call"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="phone_call",
            description=(
                "Start a phone call on the user's Android phone. "
                "Pass a phone number or a contact name from the phone's contacts."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Phone number (+1...) or contact name, e.g. 'Мама'.",
                    },
                },
                "required": ["target"],
            },
            category="phone",
        )

    def execute(self, **params: Any) -> ToolResult:
        target = str(params.get("target", "")).strip()
        if not target:
            return _result("phone_call", False, "Не указано, кому звонить.")
        return _result("phone_call", *send_command("call", {"target": target}))


@ToolRegistry.register("phone_sms")
class PhoneSmsTool(BaseTool):
    tool_id = "phone_sms"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="phone_sms",
            description=(
                "Send an SMS from the user's Android phone. "
                "Pass a phone number or a contact name, and the message text."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Phone number or contact name."},
                    "text": {"type": "string", "description": "Message text."},
                },
                "required": ["target", "text"],
            },
            category="phone",
        )

    def execute(self, **params: Any) -> ToolResult:
        target = str(params.get("target", "")).strip()
        text = str(params.get("text", "")).strip()
        if not target or not text:
            return _result("phone_sms", False, "Нужны и получатель, и текст.")
        return _result("phone_sms", *send_command("sms", {"target": target, "text": text}))


@ToolRegistry.register("phone_open_app")
class PhoneOpenAppTool(BaseTool):
    tool_id = "phone_open_app"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="phone_open_app",
            description="Open an app on the user's Android phone by its name, e.g. 'YouTube'.",
            parameters={
                "type": "object",
                "properties": {
                    "app": {"type": "string", "description": "App name as shown on the phone."},
                },
                "required": ["app"],
            },
            category="phone",
        )

    def execute(self, **params: Any) -> ToolResult:
        app = str(params.get("app", "")).strip()
        if not app:
            return _result("phone_open_app", False, "Не указано приложение.")
        return _result("phone_open_app", *send_command("open_app", {"app": app}))


PHONE_TOOLS = ["phone_call", "phone_sms", "phone_open_app"]
