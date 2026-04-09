import json
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Type

from backend.utils.logger_utils import get_logger


def _load_tts_config() -> dict[str, Any]:
    config_path = Path(__file__).resolve().parents[1] / "config.json"
    try:
        with config_path.open() as f:
            root_config = json.load(f)
    except Exception:
        return {}
    return root_config.get("VachanaTTS", {}) or root_config.get("TTS", {})


_TTS_CONFIG = _load_tts_config()


logger = get_logger(__name__)


def _tts_provider_name() -> str:
    return str(os.environ.get("VACHANA_TTS_PROVIDER", _TTS_CONFIG.get("provider", "magpie"))).strip().lower()


def _resolve_provider_class() -> Type:
    provider = _tts_provider_name()
    if provider == "legacy":
        from backend.vachana_tts_legacy import VachanaTTSLegacy

        return VachanaTTSLegacy

    from backend.vachana_tts_magpie import VachanaTTSMagpie

    return VachanaTTSMagpie


_PROVIDER_CLASS = _resolve_provider_class()


class VachanaTTS:
    SAMPLE_RATE = _PROVIDER_CLASS.SAMPLE_RATE

    def __init__(
        self,
        output_socket: Optional[Any] = None,
        output_sender: Optional[Callable[[dict], Awaitable[None]]] = None,
        initial_text: str = "",
        context_id: str = "conv_1",
        speaker_id: Optional[str] = None,
        speaker_embedding: Optional[str] = None,
    ) -> None:
        self._impl = _PROVIDER_CLASS(
            output_socket=output_socket,
            output_sender=output_sender,
            initial_text=initial_text,
            context_id=context_id,
            speaker_id=speaker_id,
            speaker_embedding=speaker_embedding,
        )
        self.SAMPLE_RATE = self._impl.SAMPLE_RATE
        logger.info("[VACHANA_TTS] provider_selected=%s sample_rate=%s", _tts_provider_name(), self.SAMPLE_RATE)

    async def send_text(self, text: str, context_id: Optional[str] = None, flush: bool = True, lang: Optional[str] = None) -> None:
        await self._impl.send_text(text=text, context_id=context_id, flush=flush, lang=lang)

    async def synthesize_text(
        self,
        text: str,
        context_id: Optional[str] = None,
        flush: bool = True,
        lang: Optional[str] = None,
        audio_label: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        return await self._impl.synthesize_text(
            text=text,
            context_id=context_id,
            flush=flush,
            lang=lang,
            audio_label=audio_label,
        )

    def start_forwarding_audio(self) -> None:
        self._impl.start_forwarding_audio()

    async def close(self) -> None:
        await self._impl.close()
