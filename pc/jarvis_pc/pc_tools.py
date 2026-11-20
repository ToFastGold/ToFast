"""Control of the Windows PC Jarvis runs on."""

from __future__ import annotations

import os
import subprocess
import sys
import webbrowser
from pathlib import Path

from jarvis_pc import approvals
from jarvis_pc._base import simple_tool, string

TOOLS = ["pc_open", "pc_list_files", "pc_run"]
RUN_TIMEOUT = 60


def _open(target: str) -> None:
    if target.startswith(("http://", "https://")):
        webbrowser.open(target)
    elif sys.platform == "win32":
        os.startfile(target)  # type: ignore[attr-defined]  # apps, files, folders, URLs
    else:
        subprocess.Popen(["xdg-open", target])


@simple_tool(
    "pc_open",
    "Open a website, file, folder or program on Omar's PC. Examples: 'https://youtube.com', "
    "'notepad', 'C:\\Users\\omarn\\Documents', 'spotify:'.",
    {"target": string("URL, path, program name or URI")},
    ["target"],
    "pc",
)
def pc_open(target: str) -> tuple[bool, str]:
    _open(target.strip())
    return True, f"Открыла: {target}"


@simple_tool(
    "pc_list_files",
    "List files in a folder on the PC (default: Desktop). Shows newest first.",
    {"path": string("Folder path")},
    [],
    "pc",
)
def pc_list_files(path: str = "") -> tuple[bool, str]:
    folder = Path(path or Path.home() / "Desktop").expanduser()
    if not folder.is_dir():
        return False, f"Папки нет: {folder}"
    items = sorted(folder.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:50]
    return True, "\n".join(f"{'[папка] ' if p.is_dir() else ''}{p.name}" for p in items) or "Пусто."


def _run(command: str) -> tuple[bool, str]:
    shell = ["powershell", "-NoProfile", "-Command", command] if sys.platform == "win32" else ["bash", "-c", command]
    proc = subprocess.run(shell, capture_output=True, text=True, timeout=RUN_TIMEOUT)
    out = (proc.stdout + proc.stderr).strip()[-3500:]
    return proc.returncode == 0, f"Код выхода {proc.returncode}\n{out or '(нет вывода)'}"


@simple_tool(
    "pc_run",
    "Run a PowerShell command on the PC (shutdown, volume, scripts and so on). "
    "Omar must confirm with /yes before it runs.",
    {"command": string("PowerShell command")},
    ["command"],
    "pc",
)
def pc_run(command: str) -> tuple[bool, str]:
    return approvals.request(f"выполнить на ПК: {command}", lambda: _run(command))
