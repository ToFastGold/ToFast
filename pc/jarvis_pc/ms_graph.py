"""Microsoft 365 mail (UVic and other school/work accounts) via Microsoft Graph.

Sign in once with `python -m jarvis_pc login-email`: it prints a code, you enter
it at https://microsoft.com/devicelogin and sign in with your UVic account. The
token is cached on the PC and refreshed automatically.
"""

from __future__ import annotations

import html
import os
import re
from pathlib import Path

import httpx

GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = ["Mail.Read", "Mail.Send"]


def configured() -> bool:
    return os.environ.get("EMAIL_PROVIDER", "").lower() == "microsoft" and bool(os.environ.get("MS_CLIENT_ID"))


def _cache_path() -> Path:
    path = Path.home() / ".openjarvis" / "friday_ms_token.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _app():
    import msal

    cache = msal.SerializableTokenCache()
    path = _cache_path()
    if path.exists():
        cache.deserialize(path.read_text())
    app = msal.PublicClientApplication(
        os.environ["MS_CLIENT_ID"],
        authority=f"https://login.microsoftonline.com/{os.environ.get('MS_TENANT', 'organizations')}",
        token_cache=cache,
    )
    return app, cache


def _save(cache) -> None:
    if cache.has_state_changed:
        _cache_path().write_text(cache.serialize())


def login() -> None:
    """Interactive device-code sign-in, run from the terminal."""
    app, cache = _app()
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise SystemExit(f"Не удалось начать вход: {flow.get('error_description', flow)}")
    print(flow["message"])
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise SystemExit(f"Вход не удался: {result.get('error_description', result)}")
    _save(cache)
    print("Готово, почта подключена:", result.get("id_token_claims", {}).get("preferred_username", ""))


def _token() -> str:
    app, cache = _app()
    accounts = app.get_accounts()
    result = app.acquire_token_silent(SCOPES, account=accounts[0]) if accounts else None
    _save(cache)
    if not result or "access_token" not in result:
        raise RuntimeError("Почта Microsoft не подключена. Запусти на ПК: python -m jarvis_pc login-email")
    return result["access_token"]


def _request(method: str, path: str, **kwargs) -> httpx.Response:
    resp = httpx.request(
        method, GRAPH + path, headers={"Authorization": f"Bearer {_token()}"}, timeout=20, **kwargs
    )
    if not resp.is_success:
        raise RuntimeError(f"Microsoft Graph {resp.status_code}: {resp.text[:300]}")
    return resp


def _sender(msg: dict) -> str:
    addr = (msg.get("from") or {}).get("emailAddress") or {}
    return f"{addr.get('name', '')} <{addr.get('address', '')}>".strip()


def list_messages(limit: int, unread_only: bool) -> list[str]:
    params = {"$top": str(limit), "$select": "id,subject,from,receivedDateTime", "$orderby": "receivedDateTime desc"}
    if unread_only:
        params["$filter"] = "isRead eq false"
    data = _request("GET", "/me/mailFolders/inbox/messages", params=params).json()
    return [
        f"[{m['id']}] {m.get('receivedDateTime', '')} | {_sender(m)} | {m.get('subject', '')}"
        for m in data.get("value", [])
    ]


def read_message(msg_id: str) -> str:
    m = _request("GET", f"/me/messages/{msg_id}", params={"$select": "subject,from,receivedDateTime,body"}).json()
    body = (m.get("body") or {}).get("content", "")
    if (m.get("body") or {}).get("contentType") == "html":
        body = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(style|script).*?</\1>", "", body)))
        body = re.sub(r"\s+\n", "\n", re.sub(r"[ \t]+", " ", body))
    return f"От: {_sender(m)}\nТема: {m.get('subject', '')}\nДата: {m.get('receivedDateTime', '')}\n\n{body.strip()[:6000]}"


def send_message(to: str, subject: str, body: str) -> None:
    payload = {
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": a.strip()}} for a in to.split(",") if a.strip()],
        }
    }
    _request("POST", "/me/sendMail", json=payload)
