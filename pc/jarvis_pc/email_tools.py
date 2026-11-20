"""Email over IMAP/SMTP. Works with Gmail, Outlook.com, Yandex, Mail.ru via an app password."""

from __future__ import annotations

import email
import email.policy
import imaplib
import os
import smtplib
from email.header import decode_header, make_header
from email.message import EmailMessage

from jarvis_pc import approvals
from jarvis_pc._base import simple_tool, string

TOOLS = ["email_list", "email_read", "email_send"]


def configured() -> bool:
    return all(os.environ.get(k) for k in ("EMAIL_ADDRESS", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST", "EMAIL_SMTP_HOST"))


def _imap() -> imaplib.IMAP4_SSL:
    box = imaplib.IMAP4_SSL(os.environ["EMAIL_IMAP_HOST"], int(os.environ.get("EMAIL_IMAP_PORT", "993")))
    box.login(os.environ["EMAIL_ADDRESS"], os.environ["EMAIL_PASSWORD"])
    box.select("INBOX", readonly=True)
    return box


def _h(value: str | None) -> str:
    return str(make_header(decode_header(value or "")))


def _body(msg: email.message.Message) -> str:
    part = msg.get_body(preferencelist=("plain", "html")) if hasattr(msg, "get_body") else None
    if part is None:
        return ""
    text = part.get_content() if hasattr(part, "get_content") else str(part.get_payload())
    return text.strip()


@simple_tool(
    "email_list",
    "List recent emails in the inbox (newest first). Set unread_only to list only unread ones.",
    {"limit": {"type": "integer", "description": "How many, default 10"}, "unread_only": {"type": "boolean"}},
    [],
    "email",
)
def email_list(limit: int = 10, unread_only: bool = False) -> tuple[bool, str]:
    box = _imap()
    try:
        _, data = box.uid("search", None, "UNSEEN" if unread_only else "ALL")
        uids = data[0].split()[-int(limit or 10):][::-1]
        if not uids:
            return True, "Писем нет."
        lines = []
        for uid in uids:
            _, msg_data = box.uid("fetch", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            m = email.message_from_bytes(msg_data[0][1])
            lines.append(f"[{uid.decode()}] {_h(m['Date'])} | {_h(m['From'])} | {_h(m['Subject'])}")
        return True, "\n".join(lines)
    finally:
        box.logout()


@simple_tool("email_read", "Read one email by the id shown in email_list.", {"id": string("Email id")}, ["id"], "email")
def email_read(id: str) -> tuple[bool, str]:  # noqa: A002
    box = _imap()
    try:
        _, msg_data = box.uid("fetch", str(id).encode(), "(BODY.PEEK[])")
        if not msg_data or msg_data[0] is None:
            return False, "Письмо не найдено."
        m = email.message_from_bytes(msg_data[0][1], policy=email.policy.default)
        return True, f"От: {m['From']}\nТема: {m['Subject']}\nДата: {m['Date']}\n\n{_body(m)[:6000]}"
    finally:
        box.logout()


def _send(to: str, subject: str, body: str) -> tuple[bool, str]:
    msg = EmailMessage()
    msg["From"] = os.environ["EMAIL_ADDRESS"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    port = int(os.environ.get("EMAIL_SMTP_PORT", "587"))
    host = os.environ["EMAIL_SMTP_HOST"]
    smtp = smtplib.SMTP_SSL(host, port) if port == 465 else smtplib.SMTP(host, port)
    with smtp:
        if port != 465:
            smtp.starttls()
        smtp.login(os.environ["EMAIL_ADDRESS"], os.environ["EMAIL_PASSWORD"])
        smtp.send_message(msg)
    return True, f"Письмо отправлено: {to}, тема «{subject}»."


@simple_tool(
    "email_send",
    "Send an email from Omar's address. Omar must confirm with /yes before it is sent.",
    {"to": string("Recipient address"), "subject": string("Subject"), "body": string("Plain text body")},
    ["to", "subject", "body"],
    "email",
)
def email_send(to: str, subject: str, body: str) -> tuple[bool, str]:
    return approvals.request(
        f"отправить письмо на {to}, тема «{subject}»:\n{body}", lambda: _send(to, subject, body)
    )
