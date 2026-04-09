from __future__ import annotations

import base64
import io
import logging
import os
import wave
from pathlib import Path

logger = logging.getLogger(__name__)


class SessionTimelineAudioWriter:
    """Writes language-specific WAV files aligned to event timeline."""

    def __init__(
        self,
        session_id: str,
        *,
        sample_rate: int = 22050,
        channels: int = 1,
        sample_width_bytes: int = 2,
    ) -> None:
        self.session_id = session_id
        self.sample_rate = sample_rate
        self.channels = channels
        self.sample_width_bytes = sample_width_bytes
        self.origin_monotonic: float | None = None
        self.write_head_seconds: dict[str, float] = {"hindi": 0.0, "tamil": 0.0}
        self._wave_handles: dict[str, wave.Wave_write] = {}
        self._files: dict[str, object] = {}
        self._output_dir = self._resolve_output_dir()
        self._open_language_file("hindi")
        self._open_language_file("tamil")

    @staticmethod
    def _resolve_output_dir() -> Path:
        app_files_dir = Path("/app/files")
        if app_files_dir.exists():
            app_files_dir.mkdir(parents=True, exist_ok=True)
            return app_files_dir
        fallback_dir = Path(os.getcwd()) / "audios"
        fallback_dir.mkdir(parents=True, exist_ok=True)
        return fallback_dir

    def _open_language_file(self, language: str) -> None:
        filename = f"{self.session_id}_{language}.wav"
        file_path = self._output_dir / filename
        file_obj = file_path.open("wb")
        wav = wave.open(file_obj, "wb")
        wav.setnchannels(self.channels)
        wav.setsampwidth(self.sample_width_bytes)
        wav.setframerate(self.sample_rate)
        self._files[language] = file_obj
        self._wave_handles[language] = wav

    def set_origin_if_unset(self, origin_monotonic: float) -> None:
        if self.origin_monotonic is None:
            self.origin_monotonic = origin_monotonic

    def append_wav_base64(self, *, language: str, audio_base64: str, event_monotonic: float) -> None:
        if language not in self._wave_handles:
            return
        if not audio_base64:
            return

        try:
            audio_bytes = base64.b64decode(audio_base64)
            with wave.open(io.BytesIO(audio_bytes), "rb") as source_wav:
                if source_wav.getnchannels() != self.channels:
                    logger.warning(
                        "Skipping audio write due to channel mismatch | session_id=%s language=%s channels=%s expected=%s",
                        self.session_id,
                        language,
                        source_wav.getnchannels(),
                        self.channels,
                    )
                    return
                if source_wav.getsampwidth() != self.sample_width_bytes:
                    logger.warning(
                        "Skipping audio write due to sample width mismatch | session_id=%s language=%s width=%s expected=%s",
                        self.session_id,
                        language,
                        source_wav.getsampwidth(),
                        self.sample_width_bytes,
                    )
                    return
                if source_wav.getframerate() != self.sample_rate:
                    logger.warning(
                        "Skipping audio write due to sample rate mismatch | session_id=%s language=%s sample_rate=%s expected=%s",
                        self.session_id,
                        language,
                        source_wav.getframerate(),
                        self.sample_rate,
                    )
                    return
                pcm_frames = source_wav.readframes(source_wav.getnframes())
        except Exception:
            logger.exception(
                "Failed decoding WAV audio for timeline write | session_id=%s language=%s",
                self.session_id,
                language,
            )
            return

        self.set_origin_if_unset(event_monotonic)
        if self.origin_monotonic is None:
            return

        target_start_seconds = max(0.0, event_monotonic - self.origin_monotonic)
        current_head_seconds = self.write_head_seconds.get(language, 0.0)
        silence_seconds = max(0.0, target_start_seconds - current_head_seconds)
        if silence_seconds > 0:
            silence_frames = int(round(silence_seconds * self.sample_rate))
            silence_bytes = b"\x00" * (silence_frames * self.channels * self.sample_width_bytes)
            self._wave_handles[language].writeframes(silence_bytes)
            current_head_seconds += silence_seconds

        self._wave_handles[language].writeframes(pcm_frames)
        audio_duration_seconds = len(pcm_frames) / (
            self.sample_rate * self.channels * self.sample_width_bytes
        )
        self.write_head_seconds[language] = current_head_seconds + audio_duration_seconds

    def close(self) -> None:
        for language in ("hindi", "tamil"):
            wav = self._wave_handles.get(language)
            file_obj = self._files.get(language)
            try:
                if wav is not None:
                    wav.close()
            except Exception:
                logger.exception(
                    "Failed closing WAV writer | session_id=%s language=%s",
                    self.session_id,
                    language,
                )
            try:
                if file_obj is not None:
                    file_obj.close()
            except Exception:
                logger.exception(
                    "Failed closing WAV file handle | session_id=%s language=%s",
                    self.session_id,
                    language,
                )
