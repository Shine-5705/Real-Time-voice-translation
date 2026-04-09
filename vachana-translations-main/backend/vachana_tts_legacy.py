import asyncio
import base64
import hashlib
import io
import json
import os
import time
import wave
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

import aiohttp

from backend.utils.logger_utils import get_logger
from backend.utils.number_utils import update_numbers

logger = get_logger(__name__)


def _load_legacy_config() -> dict[str, Any]:
    config_path = Path(__file__).resolve().parents[1] / "config.json"
    try:
        with config_path.open() as f:
            root_config = json.load(f)
    except Exception:
        return {}
    tts_config = root_config.get("VachanaTTS", {})
    return tts_config.get("legacy", {})


_LEGACY_CONFIG = _load_legacy_config()


class VachanaTTSLegacy:
    URL = os.environ.get("VACHANA_LEGACY_TTS_URL", str(_LEGACY_CONFIG.get("url", "http://20.198.81.38:8180/voice/tts")))
    AUTH_TOKEN = os.environ.get("VACHANA_LEGACY_TTS_AUTH_TOKEN", str(_LEGACY_CONFIG.get("auth_token", "")))
    DEFAULT_SPEAKER_ID = os.environ.get("VACHANA_LEGACY_SPEAKER_ID", str(_LEGACY_CONFIG.get("speaker_id", "alpha")))
    SAMPLE_RATE = int(os.environ.get("VACHANA_LEGACY_SAMPLE_RATE", str(_LEGACY_CONFIG.get("sample_rate", 22050))))
    READ_CHUNK = int(os.environ.get("VACHANA_LEGACY_READ_CHUNK", str(_LEGACY_CONFIG.get("read_chunk", 16 * 1024))))
    FIRST_BYTE_TIMEOUT_SECONDS = int(
        os.environ.get(
            "VACHANA_LEGACY_FIRST_BYTE_TIMEOUT_SECONDS",
            str(_LEGACY_CONFIG.get("first_byte_timeout_seconds", 15)),
        )
    )

    def __init__(
        self,
        output_socket: Optional[Any] = None,
        output_sender: Optional[Callable[[dict], Awaitable[None]]] = None,
        initial_text: str = "",
        context_id: str = "conv_1",
        speaker_id: Optional[str] = None,
        speaker_embedding: Optional[str] = None,
    ) -> None:
        del speaker_embedding
        self.output_socket = output_socket
        self.output_sender = output_sender
        self.context_id = context_id
        self.speaker_id = speaker_id or self.DEFAULT_SPEAKER_ID

        self._queue: asyncio.Queue[tuple[str, str, bool] | None] = asyncio.Queue()
        self._reader_task: Optional[asyncio.Task] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._session_lock = asyncio.Lock()

        if initial_text.strip():
            self._queue.put_nowait((initial_text, self.context_id, True))

    def _split_text(self, text: str) -> list[str]:
        text_list: list[str] = []
        if len(text) > 200:
            half_length = int(len(text) / 2)
            second_half = text[half_length:]
            preferred_punctuation_chars = ("।", ".")
            fallback_punctuation_chars = (",", "?")

            preferred_candidates = [second_half.find(ch) for ch in preferred_punctuation_chars]
            valid_preferred_candidates = [idx for idx in preferred_candidates if idx != -1]
            fallback_candidates = [second_half.find(ch) for ch in fallback_punctuation_chars]
            valid_fallback_candidates = [idx for idx in fallback_candidates if idx != -1]

            if valid_preferred_candidates:
                split_at = half_length + min(valid_preferred_candidates) + 1
            elif valid_fallback_candidates:
                split_at = half_length + min(valid_fallback_candidates) + 1
            else:
                first_half = text[:half_length]
                last_preferred_in_first_half = max(first_half.rfind(ch) for ch in preferred_punctuation_chars)
                last_fallback_in_first_half = max(first_half.rfind(ch) for ch in fallback_punctuation_chars)

                if last_preferred_in_first_half != -1:
                    split_at = last_preferred_in_first_half + 1
                elif last_fallback_in_first_half != -1:
                    split_at = last_fallback_in_first_half + 1
                else:
                    split_at = -1

            if 0 < split_at < len(text):
                text_list.append(text[:split_at])
                text_list.append(text[split_at:])
            else:
                text_list.append(text)
        else:
            text_list.append(text)
        return text_list

    @staticmethod
    def _text_hash(text: str) -> str:
        return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]

    @staticmethod
    def _chunk_id(context_id: str, text_hash: str) -> str:
        return hashlib.sha1(f"{context_id}:{text_hash}".encode("utf-8")).hexdigest()[:10]

    @staticmethod
    def _build_wav_base64(raw_audio: bytes, sample_rate: int) -> str:
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(raw_audio)
        return base64.b64encode(wav_buffer.getvalue()).decode("ascii")

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is not None and not self._session.closed:
            return self._session
        async with self._session_lock:
            if self._session is not None and not self._session.closed:
                return self._session
            timeout = aiohttp.ClientTimeout(total=None, connect=10, sock_connect=10, sock_read=300)
            connector = aiohttp.TCPConnector(limit=64, ttl_dns_cache=300, enable_cleanup_closed=True, force_close=False)
            self._session = aiohttp.ClientSession(timeout=timeout, connector=connector)
            return self._session

    async def send_text(self, text: str, context_id: Optional[str] = None, flush: bool = True, lang: Optional[str] = None) -> None:
        text = update_numbers(text, lang)
        text_list = self._split_text(text)
        effective_context_id = context_id or self.context_id
        for part in text_list:
            await self._queue.put((part, effective_context_id, flush))

    async def synthesize_text(
        self,
        text: str,
        context_id: Optional[str] = None,
        flush: bool = True,
        lang: Optional[str] = None,
        audio_label: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        text = update_numbers(text, lang)
        text_list = self._split_text(text)
        combined_raw_audio = bytearray()
        total_tts_delay = 0.0
        first_byte_latency: Optional[float] = None

        for part in text_list:
            result = await self._stream_text_to_audio(
                text=part,
                context_id=context_id or self.context_id,
                flush=flush,
                send_to_socket=False,
            )
            if not result:
                continue
            raw_audio = result.get("raw_audio")
            if raw_audio:
                combined_raw_audio.extend(raw_audio)
            part_delay = result.get("tts_generation_delay_s")
            if isinstance(part_delay, (int, float)):
                total_tts_delay += float(part_delay)
            if first_byte_latency is None:
                fb = result.get("first_byte_latency_s")
                if isinstance(fb, (int, float)):
                    first_byte_latency = float(fb)

        if not combined_raw_audio:
            return None

        audio_b64 = self._build_wav_base64(bytes(combined_raw_audio), self.SAMPLE_RATE)
        await self._send_audio_to_socket(audio_b64, audio_mime="audio/wav", audio_label=audio_label)
        return {
            "audio": audio_b64,
            "audio_mime": "audio/wav",
            "first_byte_latency_s": first_byte_latency,
            "tts_generation_delay_s": total_tts_delay,
        }

    def start_forwarding_audio(self) -> None:
        if self._reader_task is None or self._reader_task.done():
            self._reader_task = asyncio.create_task(self._forward_audio_loop())

    async def _forward_audio_loop(self) -> None:
        try:
            while True:
                item = await self._queue.get()
                if item is None:
                    break
                text, context_id, flush = item
                if text.strip():
                    await self._stream_text_to_audio(text=text, context_id=context_id, flush=flush)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._send_error_to_socket(f"TTS streaming failed: {exc}")

    async def _stream_text_to_audio(
        self,
        text: str,
        context_id: str,
        flush: bool,
        send_to_socket: bool = True,
    ) -> Optional[dict[str, Any]]:
        del flush
        if not self.AUTH_TOKEN:
            await self._send_error_to_socket("VACHANA_LEGACY_TTS_AUTH_TOKEN not set")
            return None

        session = await self._get_session()
        request_start = time.monotonic()
        text_hash = self._text_hash(text)
        chunk_id = self._chunk_id(context_id, text_hash)
        payload = {
            "text": text,
            "speaker_id": self.speaker_id,
            "sample_rate": self.SAMPLE_RATE,
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.AUTH_TOKEN}",
            "Accept": "*/*",
            "Connection": "keep-alive",
        }

        try:
            async with session.post(self.URL, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    err = await resp.text()
                    await self._send_error_to_socket(f"TTS HTTP {resp.status}: {err}")
                    return None

                raw_audio = bytearray()
                chunk_iterator = resp.content.iter_chunked(self.READ_CHUNK).__aiter__()

                try:
                    while True:
                        first_chunk = await asyncio.wait_for(
                            chunk_iterator.__anext__(),
                            timeout=self.FIRST_BYTE_TIMEOUT_SECONDS,
                        )
                        if first_chunk:
                            break
                except (asyncio.TimeoutError, StopAsyncIteration):
                    return None

                first_byte_latency = time.monotonic() - request_start
                raw_audio.extend(first_chunk)

                async for chunk in chunk_iterator:
                    if chunk:
                        raw_audio.extend(chunk)

                if not raw_audio:
                    return None

                total_tts_delay = time.monotonic() - request_start
                audio_b64 = self._build_wav_base64(bytes(raw_audio), self.SAMPLE_RATE)
                if send_to_socket:
                    await self._send_audio_to_socket(audio_b64, audio_mime="audio/wav")
                return {
                    "raw_audio": bytes(raw_audio),
                    "audio": audio_b64,
                    "audio_mime": "audio/wav",
                    "first_byte_latency_s": first_byte_latency,
                    "tts_generation_delay_s": total_tts_delay,
                }
        except Exception as exc:
            logger.exception(
                "[VACHANA_TTS_LEGACY] request_failed_exception | "
                f"context_id={context_id} | chunk_id={chunk_id} | error={exc}"
            )
            await self._send_error_to_socket(f"TTS request failed: {exc}")
            return None

    async def _send_audio_to_socket(
        self,
        audio_b64: str,
        audio_mime: str = "audio/mpeg",
        audio_label: Optional[str] = None,
    ) -> None:
        payload = {"type": "tts_audio", "audio": audio_b64, "audio_mime": audio_mime}
        if audio_label:
            payload["audio_label"] = audio_label
        if self.output_sender is not None:
            await self.output_sender(payload)
            return
        if self.output_socket is not None:
            await self.output_socket.send_json(payload)

    async def _send_error_to_socket(self, message: str) -> None:
        payload = {"type": "error", "message": message}
        if self.output_sender is not None:
            await self.output_sender(payload)
            return
        if self.output_socket is not None:
            await self.output_socket.send_json(payload)

    async def close(self) -> None:
        if self._reader_task and not self._reader_task.done():
            await self._queue.put(None)
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
        self._reader_task = None

        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None
