import json
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.session_results_router import router as session_results_router
from backend.services.srt_broadcast_manager import SRTBroadcastManager
from backend.services.translation_session import TranslationSession
from backend.utils.logger_utils import get_logger
from backend.utils.yt_stream import capture_live_audio, resolve_audio_stream_url

FRAME_DURATION_MS = 20
FRAME_SIZE_BYTES = 320
SEGMENTATION_SILENCE_MS = "1500"

logger = get_logger(__name__)


class YouTubeAudioStreamRequest(BaseModel):
    yt_link: str

with open("config.json", "r", encoding="utf-8") as config_file:
    config = json.load(config_file)

speech_key = config.get("SubscriptionKey")
speech_endpoint = config.get("Endpoint")
RECOGNITION_LANGUAGE = config.get("SourceLanguage", "en-IN")

app = FastAPI(title="YT Live Translation Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(session_results_router)

app.state.youtube_link = config.get("YouTubeUrl", "")
app.state.stream_url = ""
app.state.srt_manager = SRTBroadcastManager(
    speech_key=speech_key,
    speech_endpoint=speech_endpoint,
    recognition_language=RECOGNITION_LANGUAGE,
    frame_duration_ms=FRAME_DURATION_MS,
    frame_size_bytes=FRAME_SIZE_BYTES,
    segmentation_silence_ms=SEGMENTATION_SILENCE_MS,
    default_port=8111,
)

BASE_DIR = Path(__file__).resolve().parent
UI_DIST_DIR = BASE_DIR / "ui" / "dist"
if UI_DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(UI_DIST_DIR / "assets")), name="ui-assets")


@app.get("/translate")
async def set_translation_source(
    yt_link: str = Query("", description="YouTube URL"),
    stream_url: str = Query("", description="Direct HLS / stream URL (bypasses Streamlink)"),
):
    if not yt_link and not stream_url:
        raise HTTPException(status_code=400, detail="Provide either yt_link or stream_url")
    app.state.youtube_link = yt_link
    app.state.stream_url = stream_url
    return {
        "status": "ok",
        "yt_link": yt_link,
        "stream_url": stream_url,
        "websocket_url": "/ws/translate",
    }


@app.get("/youtube/audio_stream")
async def get_youtube_audio_stream_url(yt_link: str = Query(..., description="YouTube URL")):
    try:
        stream_url, stream_variant = resolve_audio_stream_url(yt_link)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to resolve stream URL: {exc}") from exc

    return {
        "status": "ok",
        "yt_link": yt_link,
        "stream_variant": stream_variant,
        "audio_stream_url": stream_url,
    }


@app.post("/youtube/audio_stream")
async def post_youtube_audio_stream_url(payload: YouTubeAudioStreamRequest):
    try:
        stream_url, stream_variant = resolve_audio_stream_url(payload.yt_link)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to resolve stream URL: {exc}") from exc

    return {
        "status": "ok",
        "yt_link": payload.yt_link,
        "stream_variant": stream_variant,
        "audio_stream_url": stream_url,
    }


@app.websocket("/ws/translate")
async def translation_socket(websocket: WebSocket):
    await websocket.accept()
    yt_link = getattr(app.state, "youtube_link", "")
    stream_url = getattr(app.state, "stream_url", "")
    if not yt_link and not stream_url:
        await websocket.send_json({"type": "error", "message": "No youtube link or stream URL set. Call /translate first."})
        await websocket.close()
        return

    session = TranslationSession(
        websocket=websocket,
        youtube_link=yt_link or None,
        stream_url=stream_url or None,
        audio_source=capture_live_audio,
        source_label="youtube",
        speech_key=speech_key,
        speech_endpoint=speech_endpoint,
        recognition_language=RECOGNITION_LANGUAGE,
        frame_duration_ms=FRAME_DURATION_MS,
        frame_size_bytes=FRAME_SIZE_BYTES,
        segmentation_silence_ms=SEGMENTATION_SILENCE_MS,
    )
    try:
        await session.run()
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            # Socket may already be closed by client or server.
            pass


@app.post("/srt_stream/start")
async def start_srt_stream(
    port: int = Query(8111, ge=1, le=65535, description="Port to listen for SRT input")
):
    if app.state.srt_manager.running:
        logger.info("[SRT] Start ignored, server already running on port %s", app.state.srt_manager.port)
        return {
            "status": "running",
            "port": app.state.srt_manager.port,
            "websocket_url": "/ws/srt_stream",
        }

    logger.info(f"[SRT] Starting SRT stream on port {port}")
    result = await app.state.srt_manager.start(port=port)
    if result.get("status") == "already_running":
        result["status"] = "running"
    return {**result, "websocket_url": "/ws/srt_stream"}


@app.post("/srt_stream/stop")
async def stop_srt_stream():
    logger.info(f"[SRT] Stopping SRT stream")
    result = await app.state.srt_manager.stop()
    return result


@app.websocket("/ws/srt_stream")
async def srt_stream_socket(websocket: WebSocket):
    logger.info(f"[SRT] SRT stream socket accepted")
    await websocket.accept()
    manager = app.state.srt_manager
    await manager.add_client(websocket)
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        await manager.remove_client(websocket)
        try:
            await websocket.close()
        except RuntimeError:
            # Socket may already be closed by client or server.
            pass


@app.get("/health")
async def health():
    return {"status": "ok"}


if UI_DIST_DIR.exists():
    @app.get("/", include_in_schema=False)
    async def serve_ui_root():
        return FileResponse(UI_DIST_DIR / "index.html")


    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_ui(full_path: str):
        requested_path = UI_DIST_DIR / full_path
        if requested_path.is_file():
            return FileResponse(requested_path)
        return FileResponse(UI_DIST_DIR / "index.html")
