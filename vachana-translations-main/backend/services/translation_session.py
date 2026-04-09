import asyncio
import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import azure.cognitiveservices.speech as speechsdk
from fastapi import WebSocket, WebSocketDisconnect

from backend.llm import close_session, translate_text
from backend.utils.translation_payload import extract_translated_text
from backend.utils.timeline_audio_writer import SessionTimelineAudioWriter
from backend.utils.subtitle_writer import append_session_subtitle_row
from backend.utils.yt_stream import CHANNELS, SAMPLE_RATE
from backend.vachana_tts import VachanaTTS
from db.mongo_helper import append_final_result, init_conversation

logger = logging.getLogger(__name__)


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


TARGET_LANG_CONFIG = _load_target_language_config()


class TranslationSession:
    def __init__(
        self,
        websocket: WebSocket,
        audio_source: Callable[..., bytes],
        source_label: str,
        speech_key: str,
        speech_endpoint: str,
        *,
        youtube_link: Optional[str] = None,
        stream_url: Optional[str] = None,
        recognition_language: str = "en-IN",
        frame_duration_ms: int = 20,
        frame_size_bytes: int = 320,
        segmentation_silence_ms: str = "500",
        start_recognition_on_first_chunk: bool = False,
    ):
        self.websocket = websocket
        self.youtube_link = youtube_link
        self.stream_url = stream_url
        self.audio_source = audio_source
        self.source_label = source_label
        self.recognition_language = recognition_language
        self.frame_duration_ms = frame_duration_ms
        self.frame_size_bytes = frame_size_bytes
        self.start_recognition_on_first_chunk = start_recognition_on_first_chunk
        self.session_id = str(uuid.uuid4())

        self.stop_event = threading.Event()
        self.loop = asyncio.get_running_loop()
        self.audio_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=200)
        self.send_lock = asyncio.Lock()
        self.recognition_started = False
        self.source_connected_monotonic: float | None = None
        self.tts = VachanaTTS(output_sender=self._safe_send)
        self.tts.start_forwarding_audio()
        self.timeline_audio_writer = SessionTimelineAudioWriter(
            self.session_id,
            sample_rate=self.tts.SAMPLE_RATE,
            channels=1,
            sample_width_bytes=2,
        )

        speech_config = speechsdk.SpeechConfig(subscription=speech_key, endpoint=speech_endpoint)
        speech_config.set_property(
            speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, segmentation_silence_ms
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

    async def _safe_send(self, payload: dict) -> None:
        if self.stop_event.is_set():
            return
        async with self.send_lock:
            try:
                await self.websocket.send_json(payload)
            except Exception:
                self._request_stop()

    def _request_stop(self) -> None:
        if self.stop_event.is_set():
            return
        self.stop_event.set()
        self._enqueue_audio(None)

    async def _monitor_client_disconnect(self) -> None:
        try:
            while not self.stop_event.is_set():
                message = await self.websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    self._request_stop()
                    break
        except WebSocketDisconnect:
            self._request_stop()
        except Exception:
            self._request_stop()

    async def _translate_for_subtitles(self, text: str, kind: str, speaker_id: str = "Unknown") -> None:
        if not text.strip() or self.stop_event.is_set():
            return
        try:
            translation_start_time = time.monotonic()
            if kind == "interim":
                logger.info(f"[INTERIM] Speaker={speaker_id} | {text}")
                return
            else:
                logger.info(f"[FINAL] Speaker={speaker_id} | {text}")

            lang_name = TARGET_LANG_CONFIG["name"]
            llm_code = TARGET_LANG_CONFIG["llm_code"]
            tts_lang_code = TARGET_LANG_CONFIG["tts_lang_code"]

            translated_result = await translate_text(
                text=text, source_lang="en", target_lang=llm_code,
            )
            llm_latency_seconds = time.monotonic() - translation_start_time
            logger.info("[LATENCY] Translation | latency=%s s", llm_latency_seconds)

            translated_text = extract_translated_text(translated_result, text)

            await self._safe_send(
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

            if kind == "final":
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
                    context_id=self.session_id,
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

                self.timeline_audio_writer.append_wav_base64(
                    language=lang_name,
                    audio_base64=audio_b64,
                    event_monotonic=tts_written_monotonic,
                )

                await append_final_result(
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
        except Exception as exc:
            await self._safe_send({"type": "error", "message": f"Subtitle translation failed: {exc}"})

    def _make_recognizing_cb(self):
        def _cb(evt):
            if self.stop_event.is_set() or not evt.result.text:
                return
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
            if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
                speaker_id = getattr(evt.result, "speaker_id", "Unknown") or "Unknown"
                asyncio.run_coroutine_threadsafe(
                    self._translate_for_subtitles(evt.result.text, "final", speaker_id=speaker_id),
                    self.loop,
                )

        return _cb

    def _make_canceled_cb(self):
        def _cb(_):
            self.stop_event.set()

        return _cb

    def _make_session_stopped_cb(self):
        def _cb(_):
            self.stop_event.set()

        return _cb

    def _audio_capture_thread(self) -> None:
        try:
            source_kwargs = {"frame_duration_ms": self.frame_duration_ms}
            if self.stream_url:
                source_kwargs["stream_url"] = self.stream_url
            if self.youtube_link:
                source_kwargs["youtube_url"] = self.youtube_link
            for audio_chunk in self.audio_source(**source_kwargs):
                if self.stop_event.is_set():
                    break
                self.loop.call_soon_threadsafe(self._enqueue_audio, audio_chunk)
        except Exception as exc:
            asyncio.run_coroutine_threadsafe(
                self._safe_send({"type": "error", "message": f"Audio capture failed: {exc}"}),
                self.loop,
            )
        finally:
            self.loop.call_soon_threadsafe(self._enqueue_audio, None)

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

    async def run(self) -> None:
        await init_conversation(
            session_id=self.session_id,
            source=self.source_label,
            metadata={
                "youtube_link": self.youtube_link,
                "recognition_language": self.recognition_language,
            },
        )
        capture_thread = threading.Thread(target=self._audio_capture_thread, daemon=True)
        disconnect_task = asyncio.create_task(self._monitor_client_disconnect())
        capture_thread.start()
        if self.start_recognition_on_first_chunk:
            await self._safe_send(
                {
                    "type": "status",
                    "message": "waiting_for_source_connection",
                    "source": self.source_label,
                    "session_id": self.session_id,
                    "frame_duration_ms": self.frame_duration_ms,
                    "frame_size_bytes": self.frame_size_bytes,
                }
            )
        else:
            self.conversation_transcriber.start_transcribing_async().get()
            self.recognition_started = True
            await self._safe_send(
                {
                    "type": "status",
                    "message": "streaming_started",
                    "source": self.source_label,
                    "session_id": self.session_id,
                    "frame_duration_ms": self.frame_duration_ms,
                    "frame_size_bytes": self.frame_size_bytes,
                }
            )

        try:
            while not self.stop_event.is_set():
                chunk = await self.audio_queue.get()
                if chunk is None:
                    if self.start_recognition_on_first_chunk and self.recognition_started:
                        await self._safe_send(
                            {
                                "type": "status",
                                "message": "source_disconnected",
                                "source": self.source_label,
                            }
                        )
                    break
                if len(chunk) != self.frame_size_bytes:
                    continue
                if self.source_connected_monotonic is None:
                    self.source_connected_monotonic = time.monotonic()
                    self.timeline_audio_writer.set_origin_if_unset(self.source_connected_monotonic)
                if not self.recognition_started and self.start_recognition_on_first_chunk:
                    self.conversation_transcriber.start_transcribing_async().get()
                    self.recognition_started = True
                    await self._safe_send(
                        {
                            "type": "status",
                            "message": "source_connected",
                            "source": self.source_label,
                            "session_id": self.session_id,
                        }
                    )
                self.push_stream.write(chunk)
        finally:
            self._request_stop()
            if not disconnect_task.done():
                disconnect_task.cancel()
                try:
                    await disconnect_task
                except asyncio.CancelledError:
                    pass
            try:
                self.push_stream.close()
            except Exception:
                pass
            if self.recognition_started:
                try:
                    self.conversation_transcriber.stop_transcribing_async().get()
                except Exception:
                    pass
            try:
                await self.tts.close()
            except Exception:
                pass
            self.timeline_audio_writer.close()
            await close_session()
