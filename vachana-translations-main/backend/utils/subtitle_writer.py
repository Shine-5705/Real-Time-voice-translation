from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from pathlib import Path

APP_FILES_DIR = Path("/app/files")


def _resolve_output_dir() -> Path:
    if APP_FILES_DIR.exists() and APP_FILES_DIR.is_dir():
        return APP_FILES_DIR
    return Path(".")


def append_session_subtitle_row(
    session_id: str,
    english_text: str,
    timestamp_iso: str | None = None,
    speaker_id: str | None = None,
    **lang_texts: str,
) -> Path:
    output_dir = _resolve_output_dir()
    output_dir.mkdir(parents=True, exist_ok=True)

    file_path = output_dir / f"{session_id}.csv"
    is_new_file = not file_path.exists()
    ts_value = timestamp_iso or datetime.now(timezone.utc).isoformat()

    lang_names = sorted(lang_texts.keys())
    with file_path.open("a", encoding="utf-8", newline="") as subtitle_file:
        writer = csv.writer(subtitle_file, quoting=csv.QUOTE_ALL)
        if is_new_file:
            writer.writerow(["timestamp", "speaker_id", "english_text"] + lang_names)
        writer.writerow([ts_value, speaker_id or "Unknown", english_text] + [lang_texts[k] for k in lang_names])

    return file_path
