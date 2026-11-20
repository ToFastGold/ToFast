"""Notes: plain Markdown files in a folder on the PC (works with an Obsidian vault too)."""

from __future__ import annotations

import datetime as dt
import os
import re
from pathlib import Path

from jarvis_pc._base import simple_tool, string

TOOLS = ["notes_add", "notes_search", "notes_read"]


def notes_dir() -> Path:
    path = Path(os.environ.get("NOTES_DIR") or Path.home() / "Documents" / "Friday Notes").expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(title: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\n\r\t]', " ", title).strip()[:80]
    return name or dt.datetime.now().strftime("Заметка %Y-%m-%d %H-%M")


def _resolve(name: str) -> Path | None:
    base = notes_dir().resolve()
    candidate = (base / (name if name.endswith(".md") else f"{name}.md")).resolve()
    if candidate.parent != base:
        return None
    return candidate


@simple_tool(
    "notes_add",
    "Save a note. If a note with this title exists, the text is appended to it.",
    {"title": string("Short title"), "text": string("Note text")},
    ["title", "text"],
    "notes",
)
def notes_add(title: str, text: str) -> tuple[bool, str]:
    path = _resolve(_safe_name(title))
    if path is None:
        return False, "Недопустимое имя заметки."
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    with path.open("a", encoding="utf-8") as f:
        f.write(f"\n## {stamp}\n{text.strip()}\n")
    return True, f"Сохранено в «{path.stem}»."


@simple_tool(
    "notes_search",
    "Find notes whose title or text contains the query. Empty query lists recent notes.",
    {"query": string("Words to look for")},
    [],
    "notes",
)
def notes_search(query: str = "") -> tuple[bool, str]:
    q = query.strip().lower()
    files = sorted(notes_dir().glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    hits = []
    for p in files:
        text = p.read_text(encoding="utf-8", errors="replace")
        if not q or q in p.stem.lower() or q in text.lower():
            idx = text.lower().find(q) if q else 0
            snippet = text[max(0, idx - 60) : idx + 120].replace("\n", " ").strip()
            hits.append(f"{p.stem}: {snippet}")
        if len(hits) >= 15:
            break
    return True, "\n".join(hits) if hits else "Ничего не нашла."


@simple_tool("notes_read", "Read a whole note by its title.", {"title": string("Note title")}, ["title"], "notes")
def notes_read(title: str) -> tuple[bool, str]:
    path = _resolve(title)
    if path is None or not path.exists():
        return False, "Такой заметки нет."
    return True, path.read_text(encoding="utf-8", errors="replace")[:8000]
