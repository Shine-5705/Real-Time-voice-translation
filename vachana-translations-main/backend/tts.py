import asyncio
import json
from typing import Any, Awaitable, Callable, Optional

import websockets
from websockets.exceptions import ConnectionClosed


class ELevenlabsTTS:
    URL = "wss://api.in.residency.elevenlabs.io/v1/text-to-speech/iWNf11sz1GrUE4ppxTOL/multi-stream-input"
    API_KEY = "sk_25cb389248ec63987af152de5462ef98716cb92d3c1a8a8e_residency_in"
    HEADERS = {
        # ElevenLabs websocket auth accepts xi-api-key (or Authorization bearer token).
        "xi-api-key": API_KEY,
    }

    def __init__(
        self,
        output_socket: Optional[Any] = None,
        output_sender: Optional[Callable[[dict], Awaitable[None]]] = None,
        initial_text: str = "",
        context_id: str = "conv_1",
    ) -> None:
        self.output_socket = output_socket
        self.output_sender = output_sender
        self.context_id = context_id
        self.ws = None
        self._connect_task = None
        self._reader_task = None

        # Connect as soon as the class is initialized.
        self._connect_task = asyncio.create_task(self._connect_and_bootstrap(initial_text))

    async def _connect_and_bootstrap(self, initial_text: str) -> None:
        await self.connect_ws()
        if not initial_text.strip():
            return
        payload = {
            "text": initial_text,
            "context_id": self.context_id,
            "flush": True,
        }
        print(
            f"[TTS] bootstrap send | context_id={self.context_id} | "
            f"text_len={len(initial_text)} | flush=True"
        )
        await self.ws.send(json.dumps(payload))

    async def connect_ws(self) -> None:
        if self.ws is not None:
            return
        print("[TTS] connecting websocket...")
        self.ws = await websockets.connect(self.URL, additional_headers=self.HEADERS)
        print("[TTS] websocket connected")

    async def send_text(self, text: str, context_id: Optional[str] = None, flush: bool = True, lang: Optional[str] = None) -> None:
        if self._connect_task and asyncio.current_task() is not self._connect_task:
            await self._connect_task
            self._connect_task = None

        if self.ws is None:
            await self.connect_ws()

        payload = {
            "text": text,
            "context_id": context_id or self.context_id,
            "flush": flush,
        }
        preview = text[:80].replace("\n", " ")
        print(
            f"[TTS] send_text | context_id={payload['context_id']} | "
            f"text_len={len(text)} | flush={flush} | text='{preview}'"
        )
        await self.ws.send(json.dumps(payload))

    async def receive_and_forward_audio(self) -> Optional[str]:
        if self._connect_task:
            await self._connect_task
            self._connect_task = None

        if self.ws is None:
            await self.connect_ws()

        raw_message = await self.ws.recv()
        response = json.loads(raw_message)
        audio_b64 = response.get("audio")
        if audio_b64:
            print(f"[TTS] received audio chunk | base64_len={len(audio_b64)}")
            await self._send_audio_to_socket(audio_b64)
        else:
            print(
                "[TTS] received non-audio message | "
                f"keys={list(response.keys())}"
            )
        return audio_b64

    def start_forwarding_audio(self) -> None:
        if self._reader_task is None or self._reader_task.done():
            self._reader_task = asyncio.create_task(self._forward_audio_loop())

    async def _forward_audio_loop(self) -> None:
        try:
            while True:
                await self.receive_and_forward_audio()
        except asyncio.CancelledError:
            raise
        except ConnectionClosed:
            return
        except Exception as exc:
            await self._send_error_to_socket(f"TTS receive failed: {exc}")
            return

    async def _send_audio_to_socket(self, audio_b64: str) -> None:
        payload = {"type": "tts_audio", "audio": audio_b64}
        if self.output_sender is not None:
            await self.output_sender(payload)
            return
        if self.output_socket is None:
            return
        await self.output_socket.send_json(payload)

    async def _send_error_to_socket(self, message: str) -> None:
        payload = {"type": "error", "message": message}
        if self.output_sender is not None:
            await self.output_sender(payload)
            return
        if self.output_socket is None:
            return
        await self.output_socket.send_json(payload)

    async def close(self) -> None:
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
        self._reader_task = None

        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None