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
MAX_RETRIES = 1000  # Effectively infinite for long livestreams
SILENCE_TIMEOUT_SECONDS = 10 
STREAMLINK_TIMEOUT = 20  # Seconds to wait for stream resolution
RECONNECT_DELAY = 3

def capture_live_audio_srt(
    frame_duration_ms=20, status_callback=None, srt_port=9000, reconnect_on_disconnect=True
):
    # ... (docstring and inner functions remain same) ...
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
            
            # # === STEP 1: Fetch Stream URL via Streamlink ===
            # logger.info(f"[AUDIO] Resolving stream URL via Streamlink...")
            # fetch_start = time.time()
            
            # try:
            #     # Use streamlink to get streams
            #     streams = streamlink.streams(youtube_url)
            #     if not streams:
            #         raise Exception("No streams found for this URL")

            #     # Priority: bestaudio > audio_only > worst (low bandwidth video)
            #     if 'audio_only' in streams:
            #         stream_url = streams['audio_only'].url
            #         logger.info(f"[AUDIO] ✓ Found 'audio_only' stream")
            #     elif 'bestaudio' in streams:
            #          stream_url = streams['bestaudio'].url
            #          logger.info(f"[AUDIO] ✓ Found 'bestaudio' stream")
            #     else:
            #         # Fallback to worst video stream to save bandwidth
            #         worst_stream = streams.get('worst')
            #         if worst_stream:
            #             stream_url = worst_stream.url
            #             logger.info(f"[AUDIO] ✓ Fallback to 'worst' quality video stream")
            #         else:
            #             # Last resort: just get 'best'
            #             stream_url = streams['best'].url
            #             logger.info(f"[AUDIO] ✓ Fallback to 'best' quality stream")
                
            #     fetch_duration = time.time() - fetch_start
            #     logger.info(f"[AUDIO] ✓ Stream URL resolved in {fetch_duration:.1f}s")
                
            # except Exception as e:
            #     logger.error(f"[AUDIO] ✗ Streamlink resolution failed: {e}")
            #     time.sleep(RECONNECT_DELAY)
            #     continue

            
            ffmpeg_cmd = [
                'ffmpeg',
                '-nostdin',
                '-fflags', 'nobuffer',
                '-flags', 'low_delay',
                '-i', f'srt://0.0.0.0:{srt_port}?mode=listener',

                '-vn',
                '-acodec', 'pcm_s16le',
                '-f', 's16le',
                '-ar', str(SAMPLE_RATE),
                '-ac', str(CHANNELS),
                '-loglevel', 'info',
                'pipe:1'
            ]
            
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
                        logger.warning(
                            f"[AUDIO] ⚠ No data for {wait_time}s. Stopping listener."
                        )
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
                logger.info(f"[AUDIO] ✓ Process cleaned up.")
        if not reconnect_on_disconnect:
            logger.info("[AUDIO] Reconnect disabled, stopping capture loop.")
            break

        logger.info(f"[AUDIO] Reconnecting in {RECONNECT_DELAY}s...")
        time.sleep(RECONNECT_DELAY)
    
    # Should rarely reach here for livestreams
    total_duration = int(time.time() - session_start)
    logger.error(f"[AUDIO] Max retries ({MAX_RETRIES}) exceeded after {total_duration}s")
    logger.error(f"[AUDIO] Total chunks captured: {total_chunks_yielded}")
    
# if __name__ == "__main__":
#     youtube_url = "https://www.youtube.com/watch?v=9-Ny1mn66EE"
#     for audio_chunk in capture_live_audio(youtube_url, frame_duration_ms=20):
#         logger.info(f"[AUDIO] Audio chunk length: {len(audio_chunk)} bytes")