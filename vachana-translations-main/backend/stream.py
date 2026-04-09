# Copyright (c) Microsoft. All rights reserved.
# Licensed under the MIT license. See LICENSE.md file in the project root for full license information.

# <code>
import azure.cognitiveservices.speech as speechsdk
import asyncio
import json
import threading
from concurrent.futures import TimeoutError as FuturesTimeoutError
from datetime import datetime
from utils.yt_stream import capture_live_audio, SAMPLE_RATE, CHANNELS
from llm import close_session, translate_text

RECOGNITION_LANGUAGE = "en-IN"
FRAME_DURATION_MS = 20
FRAME_SIZE_BYTES = 320
OUTPUT_WAV_PATH = "captured_stream.wav"
SEGMENTATION_SILENCE_MS = "700"

# Load the configuration from the config.json file
with open('config.json', 'r') as config_file:
    config = json.load(config_file)

speech_key = config.get("SubscriptionKey")
speech_endpoint = config.get("Endpoint")
youtube_url = config.get("YouTubeUrl", "https://www.youtube.com/watch?v=dkDVA6NdIA4")
# output_wav_path = config.get("OutputWavPath", OUTPUT_WAV_PATH)

speech_config = speechsdk.SpeechConfig(subscription=speech_key, endpoint=speech_endpoint)
speech_config.set_property(speechsdk.PropertyId.Speech_LogFilename, "speech.log")
speech_config.set_property(
    speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
    SEGMENTATION_SILENCE_MS,
)
speech_config.set_property(
    property_id=speechsdk.PropertyId.SpeechServiceConnection_LanguageIdMode,
    value="Continuous",
)

done = False
_async_loop = asyncio.new_event_loop()


def _run_async_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_forever()


_async_thread = threading.Thread(target=_run_async_loop, args=(_async_loop,), daemon=True)
_async_thread.start()


def get_timestamp():
    now = datetime.now()
    return now.strftime("%H:%M:%S.%f")[:-3]


def _schedule(coro):
    future = asyncio.run_coroutine_threadsafe(coro, _async_loop)

    def _done(fut):
        try:
            fut.result()
        except Exception as exc:
            print(f"[{get_timestamp()}] Async task error: {exc}")

    future.add_done_callback(_done)


async def _translate_and_print(text, label, kind):
    translated = await translate_text(text)
    print(f"[{get_timestamp()}] TRANSLATED-{kind} ({label}): {translated['translated_text']}")


def make_recognizing_cb(label):
    def _cb(evt):
        if not evt.result.text:
            return
        # print(f"[{get_timestamp()}] INTERIM ({label}): {evt.result.text}")
        _schedule(_translate_and_print(evt.result.text, label, "INTERIM"))
    return _cb


def make_recognized_cb(label):
    def _cb(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
            # print(f"[{get_timestamp()}] FINAL ({label}): {evt.result.text}")
            _schedule(_translate_and_print(evt.result.text, label, "FINAL"))
        elif evt.result.reason == speechsdk.ResultReason.NoMatch:
            print(f"[{get_timestamp()}] No speech could be recognized ({label})")
    return _cb


def make_canceled_cb(label):
    def _cb(evt):
        global done
        print(f"[{get_timestamp()}] CANCELED ({label}): {evt.cancellation_details.reason}")
        if evt.cancellation_details.reason == speechsdk.CancellationReason.Error:
            print(f"[{get_timestamp()}] Error details ({label}): {evt.cancellation_details.error_details}")
        done = True
    return _cb


def make_session_stopped_cb(label):
    def _cb(evt):
        global done
        print(f"[{get_timestamp()}] Session stopped ({label})")
        done = True
    return _cb


audio_stream_format = speechsdk.audio.AudioStreamFormat(
    samples_per_second=SAMPLE_RATE,
    bits_per_sample=16,
    channels=CHANNELS,
)
push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_stream_format)
audio_config = speechsdk.audio.AudioConfig(stream=push_stream)

speech_recognizer = speechsdk.SpeechRecognizer(
    speech_config=speech_config,
    language=RECOGNITION_LANGUAGE,
    audio_config=audio_config,
)
speech_recognizer.recognizing.connect(make_recognizing_cb(RECOGNITION_LANGUAGE))
speech_recognizer.recognized.connect(make_recognized_cb(RECOGNITION_LANGUAGE))
speech_recognizer.canceled.connect(make_canceled_cb(RECOGNITION_LANGUAGE))
speech_recognizer.session_stopped.connect(make_session_stopped_cb(RECOGNITION_LANGUAGE))

speech_recognizer.start_continuous_recognition_async().get()
print(f"[{get_timestamp()}] Streaming YouTube audio to Microsoft ASR at {SAMPLE_RATE} Hz.")
print(f"[{get_timestamp()}] Expecting {FRAME_SIZE_BYTES} bytes every {FRAME_DURATION_MS} ms.")
# print(f"[{get_timestamp()}] Saving raw stream audio to WAV: {output_wav_path}")
print("Press Ctrl+C to stop...\n")

frame_count = 0
# wav_writer = wave.open(output_wav_path, "wb")
# wav_writer.setnchannels(CHANNELS)
# wav_writer.setsampwidth(2)  # 16-bit PCM
# wav_writer.setframerate(SAMPLE_RATE)
try:
    for audio_chunk in capture_live_audio(youtube_url, frame_duration_ms=FRAME_DURATION_MS):
        if done:
            break
        if len(audio_chunk) != FRAME_SIZE_BYTES:
            print(
                f"[{get_timestamp()}] Skipping frame with unexpected size: "
                f"{len(audio_chunk)} bytes"
            )
            continue
        # wav_writer.writeframes(audio_chunk)
        push_stream.write(audio_chunk)
        frame_count += 1
except KeyboardInterrupt:
    print(f"\n[{get_timestamp()}] Stopping recognition...")
finally:
    done = True
    try:
        # wav_writer.close()
        pass
    except Exception:
        pass
    try:
        push_stream.close()
    except Exception:
        pass
    speech_recognizer.stop_continuous_recognition_async().get()
    try:
        asyncio.run_coroutine_threadsafe(close_session(), _async_loop).result(timeout=3)
    except FuturesTimeoutError:
        print(f"[{get_timestamp()}] Timed out closing translation session.")
    except Exception as exc:
        print(f"[{get_timestamp()}] Error closing translation session: {exc}")
    _async_loop.call_soon_threadsafe(_async_loop.stop)
    _async_thread.join(timeout=1)

print(f"[{get_timestamp()}] Recognition stopped. Frames sent: {frame_count}")
# print(f"[{get_timestamp()}] WAV written to: {output_wav_path}")
# </code>
