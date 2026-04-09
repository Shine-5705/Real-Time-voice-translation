#!/bin/bash

DEVICE=":1"
SRT_HOST="${SRT_HOST:-localhost}"
SRT_PORT="${SRT_PORT:-8111}"
SRT_URL="srt://${SRT_HOST}:${SRT_PORT}?mode=caller&latency=120000"
RETRY_DELAY=2
MAX_RETRIES=100

attempt=0
while [ $attempt -lt $MAX_RETRIES ]; do
    attempt=$((attempt + 1))
    echo "[SENDER] Attempt $attempt/$MAX_RETRIES — connecting to $SRT_URL"

    ffmpeg -f avfoundation -i "$DEVICE" \
        -ac 1 -ar 48000 \
        -c:a libopus -b:a 48k \
        -f mpegts \
        "$SRT_URL"

    exit_code=$?
    echo "[SENDER] FFmpeg exited with code $exit_code. Retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
done

echo "[SENDER] Max retries ($MAX_RETRIES) reached. Exiting."
