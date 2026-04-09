import os
import sys
import time
import json
import wave
import asyncio
import aiohttp

# -------- CONFIG --------
TTS_URL = "https://infer.e2enetworks.net/project/p-8848/endpoint/is-8563/voice/tts"
OUTPUT_WAV = "output.wav"

SAMPLE_RATE = 22050
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit PCM

READ_CHUNK = 16 * 1024  # bytes
HEX_PREVIEW_BYTES = 0   # set >0 if you want hex dump

AUTH_TOKEN = os.environ.get("AUTH_TOKEN")
# or keep hardcoded locally


def human_bytes(n: float) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.2f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.2f} TB"


async def tts_stream_to_wav(text: str, speaker_id: str):
    if not AUTH_TOKEN:
        raise RuntimeError("AUTH_TOKEN not set")

    payload = {
        "text": text,
        "speaker_id": speaker_id,
        "sample_rate": SAMPLE_RATE,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {AUTH_TOKEN}",
        "Accept": "*/*",
        "Connection": "keep-alive",
    }

    timeout = aiohttp.ClientTimeout(
        total=None,
        connect=10,
        sock_connect=10,
        sock_read=300,
    )

    connector = aiohttp.TCPConnector(
        limit=64,
        ttl_dns_cache=300,
        enable_cleanup_closed=True,
        force_close=False,
    )

    # ---- timing markers ----
    t0 = time.perf_counter()
    t_connected = None
    t_request_sent = None
    t_first_byte = None

    total_bytes = 0
    chunk_idx = 0

    trace_config = aiohttp.TraceConfig()

    async def on_conn_end(session, trace_config_ctx, params):
        nonlocal t_connected
        t_connected = time.perf_counter()

    async def on_req_end(session, trace_config_ctx, params):
        nonlocal t_request_sent
        t_request_sent = time.perf_counter()

    trace_config.on_connection_create_end.append(on_conn_end)
    trace_config.on_request_end.append(on_req_end)

    print("\n=== Request ===")
    print("POST:", TTS_URL)
    print("Payload:", json.dumps(payload, ensure_ascii=False))

    async with aiohttp.ClientSession(
        timeout=timeout,
        connector=connector,
        trace_configs=[trace_config],
    ) as session:

        async with session.post(TTS_URL, json=payload, headers=headers) as resp:
            if resp.status != 200:
                err = await resp.text()
                raise RuntimeError(f"HTTP {resp.status}: {err}")

            with wave.open(OUTPUT_WAV, "wb") as wf:
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(SAMPLE_WIDTH)
                wf.setframerate(SAMPLE_RATE)

                print("\n=== Streaming ===")
                while True:
                    chunk = await resp.content.read(READ_CHUNK)
                    if not chunk:
                        break

                    if t_first_byte is None:
                        t_first_byte = time.perf_counter()
                        print(
                            f"TTFB: {(t_first_byte - t0)*1000:.1f} ms"
                        )

                    chunk_idx += 1
                    wf.writeframes(chunk)
                    total_bytes += len(chunk)

                    elapsed = time.perf_counter() - t0
                    rate = total_bytes / elapsed if elapsed > 0 else 0

                    preview = ""
                    if HEX_PREVIEW_BYTES:
                        preview = chunk[:HEX_PREVIEW_BYTES].hex()

                    print(
                        f"[{chunk_idx:05d}] "
                        f"+{len(chunk):6d}  "
                        f"total={human_bytes(total_bytes):>9}  "
                        f"t={elapsed:6.2f}s  "
                        f"avg={human_bytes(rate)}/s"
                        + (f" hex={preview}" if preview else "")
                    )

    # ---- final stats ----
    t_end = time.perf_counter()
    wall = t_end - t0

    audio_seconds = total_bytes / (SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH)
    rtf = wall / audio_seconds if audio_seconds > 0 else float("inf")

    print("\n=== Summary ===")
    print(f"Connect time     : {(t_connected - t0)*1000:.1f} ms" if t_connected else "Connect time     : n/a")
    print(f"Request sent     : {(t_request_sent - t0)*1000:.1f} ms" if t_request_sent else "Request sent     : n/a")
    print(f"TTFB             : {(t_first_byte - t0)*1000:.1f} ms" if t_first_byte else "TTFB             : n/a")
    print(f"Wall time        : {wall:.2f} s")
    print(f"Audio duration   : {audio_seconds:.2f} s")
    print(f"RTF              : {rtf:.3f}")
    print(f"WAV written      : {OUTPUT_WAV}")


def main():
    if len(sys.argv) < 3:
        print("Usage: python tts_aiohttp_ttfb.py '<text>' <speaker_id>")
        sys.exit(1)

    asyncio.run(tts_stream_to_wav(sys.argv[1], sys.argv[2]))


if __name__ == "__main__":
    main()
