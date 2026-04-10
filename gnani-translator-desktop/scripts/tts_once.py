#!/usr/bin/env python3
"""
TTS: one JSON line on stdin {"text":"..."} → WAV bytes on stdout.

Self-contained (lives under gnani-translator-desktop/scripts). Uses the same .env and REST
contract as main.js / gnani-translator-desktop-py Vachana TTS.

Setup: pip install -r scripts/requirements.txt  (from this folder or repo)
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Repo root: gnani-translator-desktop/scripts/tts_once.py → parents[2]
_REPO_ROOT = Path(__file__).resolve().parents[2]

try:
    from dotenv import load_dotenv
except ImportError:
    print("tts_once: install deps: pip install -r gnani-translator-desktop/scripts/requirements.txt", file=sys.stderr)
    sys.exit(127)

load_dotenv(_REPO_ROOT / ".env")

try:
    import httpx
except ImportError:
    print("tts_once: pip install httpx", file=sys.stderr)
    sys.exit(127)

try:
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _candidate_endpoints(csv_value: str, single: str, defaults: list[str]) -> list[str]:
    out: list[str] = []
    explicit = False

    def add(value: str) -> None:
        nonlocal explicit
        t = str(value or "").strip()
        if not t:
            return
        explicit = True
        if not t.startswith(("http://", "https://")):
            if not t.startswith("/"):
                t = f"/{t}"
        if t not in out:
            out.append(t)

    for part in str(csv_value or "").split(","):
        if part.strip():
            add(part.strip())
    if str(single or "").strip():
        add(str(single).strip())
    if not explicit:
        for fb in defaults:
            add(fb)
    return out


def _build_url(endpoint: str) -> str:
    base = _env("VACHANA_BASE_URL", "https://api.vachana.ai").rstrip("/")
    ep = str(endpoint or "").strip()
    if ep.startswith(("http://", "https://")):
        return ep
    if not ep.startswith("/"):
        ep = f"/{ep}"
    return f"{base}{ep}"


def _tts_payload(text: str) -> dict[str, Any]:
    return {
        "text": text,
        "model": _env("VACHANA_TTS_MODEL", "vachana-voice-v2"),
        "voice": _env("VACHANA_TTS_VOICE", "sia"),
        "audio_config": {
            "sample_rate": int(_env("VACHANA_TTS_SAMPLE_RATE", "16000") or 16000),
            "encoding": "linear_pcm",
            "container": _env("VACHANA_TTS_CONTAINER", "wav"),
            "num_channels": 1,
            "sample_width": 2,
        },
    }


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        sys.stderr.write("tts_once: empty stdin\n")
        sys.exit(2)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"tts_once: invalid JSON: {e}\n")
        sys.exit(2)
    text = str(payload.get("text") or "").strip()
    if not text:
        sys.stderr.write("tts_once: missing text\n")
        sys.exit(2)

    api_key = _env("VACHANA_API_KEY_ID", "").strip()
    if not api_key:
        sys.stderr.write("tts_once: VACHANA_API_KEY_ID missing in .env\n")
        sys.exit(3)

    endpoints = _candidate_endpoints(
        _env("VACHANA_TTS_ENDPOINTS", ""),
        _env("VACHANA_TTS_ENDPOINT", "/api/v1/tts/inference"),
        ["/api/v1/tts/inference", "/api/v1/tts/rest", "/tts/rest", "/tts"],
    )
    read_s = max(60.0, int(_env("VACHANA_TTS_REST_TIMEOUT_MS", "120000") or 120000) / 1000.0)
    timeout = httpx.Timeout(connect=30.0, read=read_s, write=read_s, pool=read_s)
    retries = max(0, int(_env("VACHANA_TTS_RETRY_COUNT", "2") or 2))
    retry_delay_s = max(0.0, int(_env("VACHANA_TTS_RETRY_DELAY_MS", "1500") or 1500) / 1000.0)
    retryable = {500, 502, 503, 504}
    body = _tts_payload(text)
    last_error = "unknown"

    with httpx.Client(timeout=timeout) as client:
        for endpoint in endpoints:
            url = _build_url(endpoint)
            attempt = 0
            while True:
                try:
                    r = client.post(
                        url,
                        headers={"Content-Type": "application/json", "X-API-Key-ID": api_key},
                        json=body,
                    )
                    if r.status_code == 404:
                        last_error = f"404 at {url}"
                        break
                    if r.is_success:
                        sys.stdout.buffer.write(r.content)
                        return
                    last_error = f"{r.status_code}: {r.text[:400]}"
                    if r.status_code in retryable and attempt < retries:
                        attempt += 1
                        time.sleep(retry_delay_s)
                        continue
                    break
                except Exception as e:
                    last_error = str(e)
                    if attempt < retries:
                        attempt += 1
                        time.sleep(retry_delay_s)
                        continue
                    break

    sys.stderr.write(f"tts_once: {last_error}\n")
    sys.exit(1)


if __name__ == "__main__":
    main()
