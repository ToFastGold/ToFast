"""Small helpers so each tool is a few lines."""

from __future__ import annotations

from typing import Any, Callable

from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import ToolResult
from openjarvis.tools._stubs import BaseTool, ToolSpec


def result(name: str, ok: bool, message: str) -> ToolResult:
    return ToolResult(tool_name=name, content=message, success=ok)


def simple_tool(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str],
    category: str,
) -> Callable[[Callable[..., tuple[bool, str]]], type]:
    """Register a function `fn(**params) -> (ok, message)` as an OpenJarvis tool."""

    def wrap(fn: Callable[..., tuple[bool, str]]) -> type:
        class _Tool(BaseTool):
            tool_id = name

            @property
            def spec(self) -> ToolSpec:
                return ToolSpec(
                    name=name,
                    description=description,
                    parameters={"type": "object", "properties": properties, "required": required},
                    category=category,
                )

            def execute(self, **params: Any) -> ToolResult:
                missing = [k for k in required if not str(params.get(k, "")).strip()]
                if missing:
                    return result(name, False, f"Не хватает параметров: {', '.join(missing)}")
                try:
                    return result(name, *fn(**params))
                except Exception as exc:  # noqa: BLE001
                    return result(name, False, f"Ошибка: {exc}")

        _Tool.__name__ = f"{name.title().replace('_', '')}Tool"
        ToolRegistry.register(name)(_Tool)
        return _Tool

    return wrap


def string(description: str) -> dict[str, str]:
    return {"type": "string", "description": description}
