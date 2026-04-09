from __future__ import annotations

import json
from typing import Any


def extract_translated_text(payload: Any, fallback_text: str) -> str:
    """Extract the translated subtitle text from variable API payload shapes."""
    extracted = _extract_translated_text_internal(payload)
    if not extracted:
        return fallback_text
    return extracted


def _extract_translated_text_internal(payload: Any) -> str | None:
    if isinstance(payload, dict):
        translated = payload.get("translated_text")
        if isinstance(translated, str):
            return _clean_text(translated)
        if isinstance(translated, dict):
            for key in ("text", "value", "translation"):
                candidate = translated.get(key)
                if isinstance(candidate, str):
                    return _clean_text(candidate)
        return None

    if isinstance(payload, str):
        candidate = payload.strip()
        if not candidate:
            return None
        parsed = _try_parse_json(candidate)
        if parsed is not None:
            return _extract_translated_text_internal(parsed)
        return _clean_text(candidate)

    return None


def _try_parse_json(value: str) -> dict[str, Any] | None:
    if not (value.startswith("{") and value.endswith("}")):
        return None
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _clean_text(value: str) -> str:
    # Some upstream responses may serialize larger payload objects into this field.
    # If we detect a JSON object string, parse and extract only translated_text.
    parsed = _try_parse_json(value.strip())
    if parsed is not None:
        nested = parsed.get("translated_text")
        if isinstance(nested, str):
            return nested.strip()
    return value.strip()
