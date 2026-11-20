"""Calls and SMS from Omar's Twilio number. Every call and SMS costs money,
so these tools are off unless TWILIO_ENABLED=1 and each use needs /yes."""

from __future__ import annotations

import os
from xml.sax.saxutils import escape

import httpx

from jarvis_pc import approvals
from jarvis_pc._base import simple_tool, string

TOOLS = ["twilio_sms", "twilio_call"]


def enabled() -> bool:
    return os.environ.get("TWILIO_ENABLED") == "1" and all(
        os.environ.get(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER")
    )


def _post(resource: str, data: dict[str, str]) -> tuple[bool, str]:
    sid = os.environ["TWILIO_ACCOUNT_SID"]
    resp = httpx.post(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/{resource}.json",
        data={"From": os.environ["TWILIO_FROM_NUMBER"], **data},
        auth=(sid, os.environ["TWILIO_AUTH_TOKEN"]),
        timeout=20,
    )
    body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if resp.is_success:
        return True, f"Готово, Twilio id {body.get('sid', '?')}, статус {body.get('status', '?')}."
    return False, f"Twilio ошибка {resp.status_code}: {body.get('message', resp.text[:300])}"


@simple_tool(
    "twilio_sms",
    "Send an SMS from Omar's Twilio number (paid, needs /yes). Use phone_sms for his own phone instead "
    "unless he asks for Twilio or the phone is unavailable.",
    {"to": string("Number in +1... format"), "text": string("Message text")},
    ["to", "text"],
    "twilio",
)
def twilio_sms(to: str, text: str) -> tuple[bool, str]:
    return approvals.request(f"SMS через Twilio (платно) на {to}: {text}", lambda: _post("Messages", {"To": to, "Body": text}))


@simple_tool(
    "twilio_call",
    "Call a number from Omar's Twilio number and read a message aloud (paid, needs /yes).",
    {"to": string("Number in +1... format"), "message": string("What to say on the call")},
    ["to", "message"],
    "twilio",
)
def twilio_call(to: str, message: str) -> tuple[bool, str]:
    lang = "ru-RU" if any("а" <= ch.lower() <= "я" for ch in message) else "en-US"
    twiml = f'<Response><Say language="{lang}">{escape(message)}</Say></Response>'
    return approvals.request(
        f"звонок через Twilio (платно) на {to}, скажу: {message}", lambda: _post("Calls", {"To": to, "Twiml": twiml})
    )
