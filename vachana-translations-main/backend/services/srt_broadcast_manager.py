import asyncio
import json
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import azure.cognitiveservices.speech as speechsdk
from fastapi import WebSocket

from backend.llm import close_session, translate_text
from backend.utils.subtitle_writer import append_session_subtitle_row
from backend.utils.srt_stream import capture_live_audio_srt, SAMPLE_RATE, CHANNELS
from backend.utils.timeline_audio_writer import SessionTimelineAudioWriter
from backend.utils.translation_payload import extract_translated_text
from backend.vachana_tts import VachanaTTS
from backend.utils.logger_utils import get_logger
from db.mongo_helper import append_final_result, init_conversation

logger = get_logger(__name__)


def _load_target_language_config() -> dict:
    config_path = Path(__file__).resolve().parents[2] / "config.json"
    with config_path.open() as f:
        config = json.load(f)
    return config.get("TargetLanguage", {
        "name": "malayalam",
        "llm_code": "ml-IN",
        "tts_lang_code": "ml",
        "speaker_id": "alpha",
    })


_TARGET_LANG_CONFIG = _load_target_language_config()


class SRTBroadcastManager:
    def __init__(
        self,
        speech_key: str,
        speech_endpoint: str,
        *,
        recognition_language: str = "en-IN",
        frame_duration_ms: int = 20,
        frame_size_bytes: int = 320,
        segmentation_silence_ms: str = "500",
        default_port: int = 9000,
    ):
        self.speech_key = speech_key
        self.speech_endpoint = speech_endpoint
        self.recognition_language = recognition_language
        self.frame_duration_ms = frame_duration_ms
        self.frame_size_bytes = frame_size_bytes
        self.segmentation_silence_ms = segmentation_silence_ms

        self.stop_event = threading.Event()
        self.clients: set[WebSocket] = set()
        self.clients_lock = asyncio.Lock()
        self.clients_guard = threading.Lock()
        self.audio_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=200)
        self.send_lock = asyncio.Lock()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.capture_thread: Optional[threading.Thread] = None
        self.runner_task: Optional[asyncio.Task] = None
        self.running = False
        self.port = default_port
        self.source_connected = False
        self.recognition_started = False
        self.session_id: Optional[str] = None

        self.tts: Optional[VachanaTTS] = None
        self.push_stream: Optional[speechsdk.audio.PushAudioInputStream] = None
        self.conversation_transcriber: Optional[speechsdk.transcription.ConversationTranscriber] = None
        self.timeline_audio_writer: Optional[SessionTimelineAudioWriter] = None
        self.source_connected_monotonic: Optional[float] = None

    def _build_runtime(self) -> None:
        self.tts = VachanaTTS(output_sender=self._safe_broadcast)
        self.tts.start_forwarding_audio()

        speech_config = speechsdk.SpeechConfig(subscription=self.speech_key, endpoint=self.speech_endpoint)
        speech_config.set_property(
            speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, self.segmentation_silence_ms
        )
        speech_config.set_property(
            property_id=speechsdk.PropertyId.SpeechServiceConnection_LanguageIdMode,
            value="Continuous",
        )
        speech_config.set_property(
            property_id=speechsdk.PropertyId.SpeechServiceResponse_DiarizeIntermediateResults,
            value="true",
        )
        speech_config.speech_recognition_language = self.recognition_language

        audio_stream_format = speechsdk.audio.AudioStreamFormat(
            samples_per_second=SAMPLE_RATE,
            bits_per_sample=16,
            channels=CHANNELS,
        )
        self.push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_stream_format)
        audio_config = speechsdk.audio.AudioConfig(stream=self.push_stream)
        self.conversation_transcriber = speechsdk.transcription.ConversationTranscriber(
            speech_config=speech_config,
            audio_config=audio_config,
        )
        self.conversation_transcriber.transcribing.connect(self._make_recognizing_cb())
        self.conversation_transcriber.transcribed.connect(self._make_recognized_cb())
        self.conversation_transcriber.canceled.connect(self._make_canceled_cb())
        self.conversation_transcriber.session_stopped.connect(self._make_session_stopped_cb())

    def _has_clients(self) -> bool:
        with self.clients_guard:
            return bool(self.clients)

    async def _safe_broadcast(self, payload: dict) -> None:
        if not self._has_clients():
            return
        async with self.send_lock:
            async with self.clients_lock:
                targets = list(self.clients)
            disconnected: list[WebSocket] = []
            for client in targets:
                try:
                    await client.send_json(payload)
                except Exception:
                    disconnected.append(client)
            if disconnected:
                async with self.clients_lock:
                    for client in disconnected:
                        self.clients.discard(client)
                with self.clients_guard:
                    for client in disconnected:
                        self.clients.discard(client)

    async def _translate_for_subtitles(self, text: str, kind: str, speaker_id: str = "Unknown") -> None:
        if not text.strip() or self.stop_event.is_set():
            return
        try:
            if kind == "interim":
                logger.info(f"[SRT] Interim Speaker={speaker_id} | {text}")
                await self._safe_broadcast(
                    {
                        "type": "subtitle",
                        "kind": "interim",
                        "session_id": self.session_id,
                        "source_lang": self.recognition_language,
                        "text": text,
                        "speaker_id": speaker_id,
                    }
                )
                return
            else:
                logger.info(f"[SRT] Final Speaker={speaker_id} | {text}")

            lang_name = _TARGET_LANG_CONFIG["name"]
            llm_code = _TARGET_LANG_CONFIG["llm_code"]
            tts_lang_code = _TARGET_LANG_CONFIG["tts_lang_code"]

            translation_start_time = time.monotonic()
            translated_result = await translate_text(text=text, source_lang="en", target_lang=llm_code)
            llm_latency_seconds = time.monotonic() - translation_start_time

            translated_text = extract_translated_text(translated_result, text)
            logger.info(f"[SRT][Translation][Latency]: {llm_latency_seconds}s")
            logger.info(f"[SRT] Received translation ({lang_name}): {translated_text}")

            await self._safe_broadcast(
                {
                    "type": "subtitle",
                    "kind": kind,
                    "session_id": self.session_id,
                    "source_lang": self.recognition_language,
                    "text": text,
                    "speaker_id": speaker_id,
                    "subtitles": {lang_name: translated_text},
                }
            )
            if kind == "final" and self.tts is not None:
                final_timestamp = datetime.now(timezone.utc).isoformat()
                append_session_subtitle_row(
                    session_id=self.session_id,
                    english_text=text,
                    timestamp_iso=final_timestamp,
                    speaker_id=speaker_id,
                    **{lang_name: translated_text},
                )
                tts_result = await self.tts.synthesize_text(
                    text=translated_text,
                    context_id=self.session_id or "conv_1",
                    flush=True,
                    lang=tts_lang_code,
                    audio_label=lang_name,
                )
                tts_written_monotonic = time.monotonic()
                tts_generation_delay_seconds = 0.0
                tts_first_token_latency_seconds = None
                audio_b64 = ""
                if isinstance(tts_result, dict):
                    tts_generation_delay_seconds += float(tts_result.get("tts_generation_delay_s", 0.0))
                    raw_first_token_latency = tts_result.get("first_byte_latency_s")
                    if isinstance(raw_first_token_latency, (int, float)):
                        tts_first_token_latency_seconds = float(raw_first_token_latency)
                    audio_b64 = str(tts_result.get("audio", ""))

                if self.timeline_audio_writer is not None:
                    self.timeline_audio_writer.append_wav_base64(
                        language=lang_name,
                        audio_base64=audio_b64,
                        event_monotonic=tts_written_monotonic,
                    )

                if self.session_id:
                    append_meta = await append_final_result(
                        self.session_id,
                        source_text=text,
                        translated_texts={lang_name: translated_text},
                        audio_base64=audio_b64,
                        audio_base64s={lang_name: audio_b64},
                        llm_latency_seconds=llm_latency_seconds,
                        tts_generation_delay_seconds=tts_generation_delay_seconds,
                        tts_first_token_latency_seconds=tts_first_token_latency_seconds,
                        timestamp_iso=final_timestamp,
                        speaker_id=speaker_id,
                    )
                    logger.info(f"[SRT] Saved final result | session_id={self.session_id} ts={final_timestamp} meta={append_meta}")
        except Exception as exc:
            logger.exception(f"[SRT] Subtitle translation failed for text='{text}' kind={kind}: {exc}")
            await self._safe_broadcast({"type": "error", "message": f"Subtitle translation failed: {exc}"})

    def _make_recognizing_cb(self):
        def _cb(evt):
            if self.stop_event.is_set() or not evt.result.text:
                return
            if self.loop is not None:
                speaker_id = getattr(evt.result, "speaker_id", "Unknown") or "Unknown"
                asyncio.run_coroutine_threadsafe(
                    self._translate_for_subtitles(evt.result.text, "interim", speaker_id=speaker_id),
                    self.loop,
                )

        return _cb

    def _make_recognized_cb(self):
        def _cb(evt):
            if self.stop_event.is_set():
                return
            if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text and self.loop is not None:
                speaker_id = getattr(evt.result, "speaker_id", "Unknown") or "Unknown"
                asyncio.run_coroutine_threadsafe(
                    self._translate_for_subtitles(evt.result.text, "final", speaker_id=speaker_id),
                    self.loop,
                )

        return _cb

    def _make_canceled_cb(self):
        def _cb(_):
            # Do not stop the SRT service on recognizer cancel; treat it as a transient ASR/session event.
            self.recognition_started = False

        return _cb

    def _make_session_stopped_cb(self):
        def _cb(_):
            logger.info(f"[SRT][ASR] Session stopped")
            # Do not stop the SRT service on recognizer stop; source may reconnect and resume.
            self.recognition_started = False

        return _cb

    def _enqueue_audio(self, chunk: Optional[bytes]) -> None:
        if chunk is None:
            try:
                self.audio_queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
            return
        if self.stop_event.is_set():
            return
        try:
            # logger.info(f"[SRT] Enqueuing audio chunk | chunk_length={len(chunk)} {chunk}")
            self.audio_queue.put_nowait(chunk)
        except asyncio.QueueFull:
            try:
                _ = self.audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.audio_queue.put_nowait(chunk)
            except asyncio.QueueFull:
                pass

    def _audio_capture_thread(self) -> None:
        try:
            for audio_chunk in capture_live_audio_srt(
                frame_duration_ms=self.frame_duration_ms,
                srt_port=self.port,
                reconnect_on_disconnect=False,
            ):
                if self.stop_event.is_set():
                    break
                if self.loop is not None:
                    self.loop.call_soon_threadsafe(self._enqueue_audio, audio_chunk)
            if not self.stop_event.is_set():
                logger.info("[SRT] No audio data within timeout; stopping SRT broadcast manager")
                self.stop_event.set()
        except Exception as exc:
            if self.loop is not None:
                asyncio.run_coroutine_threadsafe(
                    self._safe_broadcast({"type": "error", "message": f"SRT audio capture failed: {exc}"}),
                    self.loop,
                )
        finally:
            if self.loop is not None:
                self.loop.call_soon_threadsafe(self._enqueue_audio, None)

    async def _run(self) -> None:
        self.capture_thread = threading.Thread(target=self._audio_capture_thread, daemon=True)
        self.capture_thread.start()
        await self._safe_broadcast(
            {
                "type": "status",
                "message": "srt_server_started",
                "session_id": self.session_id,
                "source": f"srt:{self.port}",
                "frame_duration_ms": self.frame_duration_ms,
                "frame_size_bytes": self.frame_size_bytes,
            }
        )
        try:
            while not self.stop_event.is_set():
                chunk = await self.audio_queue.get()
                if chunk is None:
                    self.source_connected = False
                    if self.recognition_started:
                        await self._safe_broadcast(
                            {"type": "status", "message": "source_disconnected", "source": f"srt:{self.port}"}
                        )
                    # Only shut down loop when explicitly stopped; otherwise keep waiting for source reconnect.
                    if self.stop_event.is_set():
                        break
                    continue
                if len(chunk) != self.frame_size_bytes:
                    continue

                if not self.source_connected:
                    self.source_connected = True
                    if self.source_connected_monotonic is None:
                        self.source_connected_monotonic = time.monotonic()
                        if self.timeline_audio_writer is not None:
                            self.timeline_audio_writer.set_origin_if_unset(self.source_connected_monotonic)
                    await self._safe_broadcast(
                        {
                            "type": "status",
                            "message": "source_connected",
                            "source": f"srt:{self.port}",
                            "session_id": self.session_id,
                        }
                    )

                if not self.recognition_started:
                    if self.conversation_transcriber is not None:
                        logger.info(f"[SRT] Starting conversation transcription")
                        self.conversation_transcriber.start_transcribing_async().get()
                    self.recognition_started = True

                if not self.recognition_started:
                    continue
                if self.push_stream is not None:
                    self.push_stream.write(chunk)
        finally:
            self.stop_event.set()
            logger.info(f"[SRT] Stopping SRT broadcast manager")
            if self.recognition_started:
                try:
                    if self.conversation_transcriber is not None:
                        logger.info(f"[SRT] Stopping conversation transcription")
                        self.conversation_transcriber.stop_transcribing_async().get()
                except Exception:
                    pass
                self.recognition_started = False
            try:
                if self.push_stream is not None:
                    self.push_stream.close()
            except Exception:
                pass
            try:
                if self.tts is not None:
                    await self.tts.close()
            except Exception:
                pass
            if self.timeline_audio_writer is not None:
                self.timeline_audio_writer.close()
            await close_session()
            self.tts = None
            self.push_stream = None
            self.conversation_transcriber = None
            self.timeline_audio_writer = None
            self.running = False
            await self._safe_broadcast(
                {"type": "status", "message": "srt_server_stopped", "source": f"srt:{self.port}"}
            )

    async def start(self, port: int) -> dict:
        if self.running:
            return {"status": "already_running", "port": self.port}

        self.port = port
        self.stop_event.clear()
        self.source_connected = False
        self.recognition_started = False
        self.source_connected_monotonic = None
        self.session_id = str(uuid.uuid4())
        self.loop = asyncio.get_running_loop()
        await init_conversation(
            session_id=self.session_id,
            source=f"srt:{port}",
            metadata={"recognition_language": self.recognition_language},
        )
        self._build_runtime()
        self.timeline_audio_writer = SessionTimelineAudioWriter(
            self.session_id,
            sample_rate=VachanaTTS.SAMPLE_RATE,
            channels=1,
            sample_width_bytes=2,
        )
        self.running = True
        self.runner_task = asyncio.create_task(self._run())
        return {"status": "started", "port": port}

    async def stop(self) -> dict:
        if not self.running:
            return {"status": "already_stopped", "port": self.port}
        self.stop_event.set()
        self._enqueue_audio(None)
        if self.runner_task is not None and not self.runner_task.done():
            await self.runner_task
        self.runner_task = None
        return {"status": "stopped", "port": self.port}

    async def add_client(self, websocket: WebSocket) -> None:
        async with self.clients_lock:
            self.clients.add(websocket)
        with self.clients_guard:
            self.clients.add(websocket)

        if not self.running:
            await websocket.send_json({"type": "status", "message": "srt_server_not_running"})
            return
        if self.source_connected:
            await websocket.send_json(
                {
                    "type": "status",
                    "message": "source_connected",
                    "source": f"srt:{self.port}",
                    "session_id": self.session_id,
                }
            )
        else:
            await websocket.send_json(
                {
                    "type": "status",
                    "message": "waiting_for_source_connection",
                    "source": f"srt:{self.port}",
                    "session_id": self.session_id,
                    "frame_duration_ms": self.frame_duration_ms,
                    "frame_size_bytes": self.frame_size_bytes,
                }
            )

    async def remove_client(self, websocket: WebSocket) -> None:
        async with self.clients_lock:
            self.clients.discard(websocket)
        with self.clients_guard:
            self.clients.discard(websocket)
