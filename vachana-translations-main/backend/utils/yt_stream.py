"""
Audio Capture Module - Optimized for Live Streams
Handles YouTube live audio capture with aggressive retry logic and detailed logging.
"""
import streamlink
import subprocess
import logging
import select
import time

SAMPLE_RATE = 8000
CHANNELS = 1
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d | %(levelname)s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# === CONFIGURATION ===
MAX_RETRIES = 100  # Effectively infinite for long livestreams
SILENCE_TIMEOUT_SECONDS = 10 
STREAMLINK_TIMEOUT = 20  # Seconds to wait for stream resolution
RECONNECT_DELAY = 1

def resolve_audio_stream_url(youtube_url):
    """Resolve an audio-capable stream URL for a YouTube link."""
    streams = streamlink.streams(youtube_url)
    if not streams:
        raise ValueError("No streams found for this URL")

    # Priority: audio_only > bestaudio > worst > best
    if "audio_only" in streams:
        return streams["audio_only"].url, "audio_only"
    if "bestaudio" in streams:
        return streams["bestaudio"].url, "bestaudio"

    worst_stream = streams.get("worst")
    if worst_stream:
        return worst_stream.url, "worst"

    best_stream = streams.get("best")
    if best_stream:
        return best_stream.url, "best"

    raise ValueError("No usable stream variants found for this URL")

def capture_live_audio(youtube_url=None, frame_duration_ms=20, status_callback=None, stream_url=None):
    def notify(status, message):
        """Helper to send status updates if callback is provided."""
        if status_callback:
            try:
                status_callback(status, message)
            except Exception as e:
                logger.debug(f"Status callback failed: {e}")

    retry_count = 0
    total_chunks_yielded = 0
    session_start = time.time()
    
    while retry_count < MAX_RETRIES:
        process = None
        try:
            retry_count += 1
            notify("reconnecting", f"Connection attempt {retry_count}...")
            
            logger.info(f"")
            logger.info(f"{'='*50}")
            logger.info(f"[AUDIO] Connection Attempt {retry_count}/{MAX_RETRIES}")
            logger.info(f"[AUDIO] Session duration: {int(time.time() - session_start)}s, Total chunks: {total_chunks_yielded}")
            logger.info(f"{'='*50}")
            
            # === STEP 1: Resolve stream URL ===
            if stream_url:
                resolved_url = stream_url
                logger.info("[AUDIO] Using direct stream URL (Streamlink skipped)")
            elif youtube_url:
                logger.info("[AUDIO] Resolving stream URL via Streamlink...")
                fetch_start = time.time()
                try:
                    resolved_url, stream_variant = resolve_audio_stream_url(youtube_url)
                    if stream_variant == "audio_only":
                        logger.info("[AUDIO] ✓ Found 'audio_only' stream")
                    elif stream_variant == "bestaudio":
                        logger.info("[AUDIO] ✓ Found 'bestaudio' stream")
                    elif stream_variant == "worst":
                        logger.info("[AUDIO] ✓ Fallback to 'worst' quality video stream")
                    else:
                        logger.info("[AUDIO] ✓ Fallback to 'best' quality stream")
                    fetch_duration = time.time() - fetch_start
                    logger.info(f"[AUDIO] ✓ Stream URL resolved in {fetch_duration:.1f}s")
                except Exception as e:
                    logger.error(f"[AUDIO] ✗ Streamlink resolution failed: {e}")
                    time.sleep(RECONNECT_DELAY)
                    continue
            else:
                logger.error("[AUDIO] No youtube_url or stream_url provided")
                return
            
            # === STEP 2: Start FFmpeg ===
            ffmpeg_cmd = [
                'ffmpeg',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '2',
                '-reconnect_on_network_error', '1',
                '-reconnect_on_http_error', '4xx,5xx',
                '-i', resolved_url,
                '-f', 's16le',
                '-ar', str(SAMPLE_RATE),
                '-ac', str(CHANNELS),
                '-loglevel', 'warning',
                'pipe:1'
            ]
            
            # ffmpeg_cmd = [
            #     'ffmpeg',
            #     '-fflags', 'nobuffer',
            #     '-flags', 'low_delay',

            #     '-f', 's16le',
            #     '-ar', str(SAMPLE_RATE),
            #     '-ac', str(CHANNELS),
            #     '-i', 'srt://0.0.0.0:9000?mode=listener',

            #     '-f', 's16le',
            #     '-loglevel', 'info',
            #     'pipe:1'
            # ]
            
            logger.info(f"[AUDIO] Starting FFmpeg subprocess...")
            process = subprocess.Popen(
                ffmpeg_cmd, 
                stdout=subprocess.PIPE, 
                stderr=subprocess.PIPE, 
                bufsize=10**6
            )
            
            frame_size_bytes = int(SAMPLE_RATE * (frame_duration_ms / 1000.0) * CHANNELS * 2)
            frame_interval_seconds = frame_duration_ms / 1000.0
            consecutive_empty_reads = 0
            chunk_count_this_session = 0
            last_chunk_time = time.time()
            next_emit_time = time.monotonic()
            
            logger.info(f"[AUDIO] ✓ FFmpeg started. Waiting for audio data...")
            notify("streaming", "Audio stream connected")
            
            # === STEP 3: Read Audio Loop (Buffered) ===
            buffer = bytearray()
            
            while True:
                # Heartbeat: Check if FFmpeg is still alive
                poll = process.poll()
                if poll is not None:
                    stderr_content = process.stderr.read().decode()[-500:]  # Last 500 chars
                    logger.error(f"[AUDIO] ✗ FFmpeg died with code {poll}")
                    if stderr_content:
                        logger.error(f"[AUDIO] FFmpeg stderr: {stderr_content}")
                    break
                
                # Check for available data
                ready, _, _ = select.select([process.stdout], [], [], 2.0)
                
                if not ready:
                    consecutive_empty_reads += 1
                    wait_time = consecutive_empty_reads * 2
                    
                    if wait_time % 4 == 0:  # Log every 4 seconds
                        logger.info(f"[AUDIO] Buffering... ({wait_time}s since last data)")
                    
                    if wait_time >= SILENCE_TIMEOUT_SECONDS:
                        logger.warning(f"[AUDIO] ⚠ No data for {wait_time}s. Reconnecting to livestream...")
                        break
                    continue
                
                # Success! Reset empty read counter
                consecutive_empty_reads = 0

                # Read small chunk to avoid blocking
                raw_data = process.stdout.read(4096) 
                # logger.info(f"[AUDIO] Raw data length: {len(raw_data)}")
                if not raw_data:
                    logger.info(f"[AUDIO] EOF received. Reconnecting...")
                    break
                
                buffer.extend(raw_data)
                
                # Emit fixed-size PCM frames at wall-clock cadence.
                while len(buffer) >= frame_size_bytes:
                    frame_bytes = bytes(buffer[:frame_size_bytes])
                    buffer = buffer[frame_size_bytes:]  # Keep remainder
                    
                    chunk_count_this_session += 1
                    total_chunks_yielded += 1
                    last_chunk_time = time.time()
                    
                    # Log every 10 chunks for monitoring
                    if chunk_count_this_session % 10 == 0:
                        session_duration = int(time.time() - session_start)
                        # logger.info(f"[AUDIO] Session {retry_count}: {chunk_count_this_session} chunks | Total: {total_chunks_yielded} | Runtime: {session_duration}s")

                    sleep_for = next_emit_time - time.monotonic()
                    if sleep_for > 0:
                        time.sleep(sleep_for)
                    else:
                        # If we fell behind, reset cadence anchor to avoid runaway lag.
                        next_emit_time = time.monotonic()

                    yield frame_bytes
                    next_emit_time += frame_interval_seconds
                
        except Exception as e:
            logger.error(f"[AUDIO] ✗ Exception in audio loop: {type(e).__name__}: {e}")
            time.sleep(RECONNECT_DELAY)
            
        finally:
            if process:
                logger.info(f"[AUDIO] Cleaning up FFmpeg process...")
                try:
                    process.kill()
                    process.wait(timeout=2)
                except:
                    pass
                logger.info(f"[AUDIO] ✓ Process cleaned up. Reconnecting in {RECONNECT_DELAY}s...")
            
            time.sleep(RECONNECT_DELAY)
    
    # Should rarely reach here for livestreams
    total_duration = int(time.time() - session_start)
    logger.error(f"[AUDIO] Max retries ({MAX_RETRIES}) exceeded after {total_duration}s")
    logger.error(f"[AUDIO] Total chunks captured: {total_chunks_yielded}")
    
# if __name__ == "__main__":
#     youtube_url = "https://www.youtube.com/watch?v=9-Ny1mn66EE"
#     for audio_chunk in capture_live_audio(youtube_url, frame_duration_ms=20):
#         logger.info(f"[AUDIO] Audio chunk length: {len(audio_chunk)} bytes")