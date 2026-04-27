const fs = require('fs');
const path = require('path');

function createArtifactService({ env, nowISO, logInfo, logError }) {
  let sessionArtifacts = null;
  let pipelineStats = { count: 0, sttSum: 0, translateSum: 0, ttsSum: 0, totalSum: 0, latencySum: 0 };
  const audioTrackState = {};

  function getWorkspaceRoot(appDir) {
    return path.join(appDir, '..');
  }

  function sessionDirNow(appDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(getWorkspaceRoot(appDir), 'workdir', 'live', stamp);
  }

  function appendLine(filePath, line) {
    try {
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    } catch (err) {
      logError(`Failed writing ${filePath}: ${err.message}`);
    }
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    });
  }

  function initSessionArtifacts(appDir, sourceLanguage, targetLanguage) {
    const dir = sessionDirNow(appDir);
    fs.mkdirSync(dir, { recursive: true });
    sessionArtifacts = {
      dir,
      sourceLogPath: path.join(dir, 'source_transcript.log'),
      spokenTextPath: path.join(dir, 'spoken_text.txt'),
      translatedLogPath: path.join(dir, 'translated_transcript.log'),
      eventsPath: path.join(dir, 'events.jsonl'),
      pipelineLogPath: path.join(dir, 'pipeline_timings.txt'),
      pairedTranscriptPath: path.join(dir, 'paired_transcript.log'),
      conversationTextPath: path.join(dir, 'full_conversation.log'),
      sourceLanguage,
      targetLanguage,
    };

    fs.writeFileSync(sessionArtifacts.sourceLogPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.spokenTextPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.translatedLogPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.eventsPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.pairedTranscriptPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.conversationTextPath, '', 'utf8');

    const audioTracks = {
      outgoingReal: { file: path.join(dir, 'audio_outgoing_real.pcm'), wav: path.join(dir, 'audio_outgoing_real.wav') },
      outgoingTranslated: { file: path.join(dir, 'audio_outgoing_translated.pcm'), wav: path.join(dir, 'audio_outgoing_translated.wav') },
      incomingReal: { file: path.join(dir, 'audio_incoming_real.pcm'), wav: path.join(dir, 'audio_incoming_real.wav') },
      incomingTranslated: { file: path.join(dir, 'audio_incoming_translated.pcm'), wav: path.join(dir, 'audio_incoming_translated.wav') },
      fullRealConversation: { file: path.join(dir, 'audio_full_real_conversation.pcm'), wav: path.join(dir, 'audio_full_real_conversation.wav') },
      fullTranslatedConversation: { file: path.join(dir, 'audio_full_translated_conversation.pcm'), wav: path.join(dir, 'audio_full_translated_conversation.wav') },
    };
    Object.keys(audioTrackState).forEach((k) => delete audioTrackState[k]);
    for (const [key, track] of Object.entries(audioTracks)) {
      fs.writeFileSync(track.file, Buffer.alloc(0));
      audioTrackState[key] = {
        ...track,
        sampleRate: 16000,
        bytes: 0,
      };
    }

    const header =
      `=== Pipeline Timing Log ===\n`
      + `Session started : ${nowISO()}\n`
      + `Source language  : ${sourceLanguage}\n`
      + `Target language  : ${targetLanguage}\n`
      + `STT provider     : ${env('STT_PROVIDER', 'google')}\n`
      + `Translate provider: ${env('TRANSLATION_PROVIDER', 'google')}\n`
      + `TTS provider     : ${env('TTS_PROVIDER', 'google')}\n\n`
      + '─'.repeat(80) + '\n';
    fs.writeFileSync(sessionArtifacts.pipelineLogPath, header, 'utf8');
    pipelineStats = { count: 0, sttSum: 0, translateSum: 0, ttsSum: 0, totalSum: 0, latencySum: 0 };
    logInfo(`Session log directory: ${dir}`);
    return sessionArtifacts;
  }

  function writeEvent(eventType, data) {
    if (!sessionArtifacts) return;
    appendLine(sessionArtifacts.eventsPath, JSON.stringify({ ts: nowISO(), event: eventType, ...data }));
  }

  function writePipelineRow({ segmentId, spokeAtMs, sttMs, translateMs, ttsMs, totalMs, sourceText, translatedText }) {
    if (!sessionArtifacts) return;
    const playedAtMs = Date.now();
    const latencyMs = playedAtMs - spokeAtMs;
    const row =
      `#${segmentId}\n`
      + `  Spoke at    : ${fmtTime(spokeAtMs)}  →  "${sourceText}"\n`
      + `  Played at   : ${fmtTime(playedAtMs)}  →  "${translatedText}"\n`
      + `  Latency     : ${latencyMs} ms  (STT ${sttMs}ms + Translate ${translateMs}ms + TTS ${ttsMs}ms)\n\n`;
    appendLine(sessionArtifacts.pipelineLogPath, row);
    pipelineStats.count += 1;
    pipelineStats.sttSum += Number(sttMs) || 0;
    pipelineStats.translateSum += Number(translateMs) || 0;
    pipelineStats.ttsSum += Number(ttsMs) || 0;
    pipelineStats.totalSum += Number(totalMs) || 0;
    pipelineStats.latencySum += latencyMs;
  }

  function writePipelineSummary() {
    if (!sessionArtifacts) return;
    if (pipelineStats.count > 0) {
      const n = pipelineStats.count;
      const avg = (v) => Math.round(v / n);
      const summary =
        `\n${'─'.repeat(80)}\n`
        + `Session ended       : ${nowISO()}\n`
        + `Total segments      : ${n}\n`
        + `Avg Spoke→Played    : ${avg(pipelineStats.latencySum)} ms\n`
        + `  Avg STT           : ${avg(pipelineStats.sttSum)} ms\n`
        + `  Avg Translate     : ${avg(pipelineStats.translateSum)} ms\n`
        + `  Avg TTS           : ${avg(pipelineStats.ttsSum)} ms\n`;
      appendLine(sessionArtifacts.pipelineLogPath, summary);
    } else {
      appendLine(sessionArtifacts.pipelineLogPath, `\nSession ended: ${nowISO()} (no segments processed)\n`);
    }
    finalizeAudioTracks();
    writeAudioManifest();
  }

  function buildWavFromPcm16(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const out = Buffer.alloc(44 + dataSize);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + dataSize, 4);
    out.write('WAVE', 8);
    out.write('fmt ', 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(channels, 22);
    out.writeUInt32LE(sampleRate, 24);
    out.writeUInt32LE(byteRate, 28);
    out.writeUInt16LE(blockAlign, 32);
    out.writeUInt16LE(bitsPerSample, 34);
    out.write('data', 36);
    out.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(out, 44);
    return out;
  }

  function appendAudioTrack(trackKey, pcmBytes, sampleRate = 16000) {
    if (!sessionArtifacts) return;
    const track = audioTrackState[trackKey];
    if (!track) return;
    if (!pcmBytes || !pcmBytes.length) return;
    try {
      const sr = Number(sampleRate || 16000);
      if (sr > 0) track.sampleRate = sr;
      fs.appendFileSync(track.file, pcmBytes);
      track.bytes += pcmBytes.length;
    } catch (err) {
      logError(`Audio track append failed (${trackKey}): ${err.message}`);
    }
  }

  function appendConversationPair({ segmentId, direction, sourceText, translatedText }) {
    if (!sessionArtifacts) return;
    const dir = direction === 'incoming' ? 'incoming' : 'outgoing';
    const label = dir === 'incoming' ? 'Other person' : 'You';
    const toLabel = dir === 'incoming' ? 'To you (AI)' : 'To other side (AI)';
    appendLine(
      sessionArtifacts.pairedTranscriptPath,
      `[${nowISO()}] seg=${segmentId} dir=${dir} | ${label}: ${sourceText} | ${toLabel}: ${translatedText}`
    );
    appendLine(
      sessionArtifacts.conversationTextPath,
      `[${nowISO()}] ${label}: ${sourceText}\n[${nowISO()}] ${toLabel}: ${translatedText}\n`
    );
  }

  function finalizeAudioTracks() {
    for (const track of Object.values(audioTrackState)) {
      try {
        if (!track.bytes) continue;
        const pcm = fs.readFileSync(track.file);
        if (!pcm.length) continue;
        const wav = buildWavFromPcm16(pcm, Number(track.sampleRate || 16000), 1, 16);
        fs.writeFileSync(track.wav, wav);
      } catch (err) {
        logError(`Audio track finalize failed (${track.file}): ${err.message}`);
      }
    }
  }

  function writeAudioManifest() {
    if (!sessionArtifacts) return;
    const manifestPath = path.join(sessionArtifacts.dir, 'audio_manifest.json');
    const payload = {};
    for (const [key, track] of Object.entries(audioTrackState)) {
      payload[key] = {
        pcm: path.basename(track.file),
        wav: path.basename(track.wav),
        sampleRate: Number(track.sampleRate || 16000),
        bytes: Number(track.bytes || 0),
      };
    }
    fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  return {
    getSessionArtifacts: () => sessionArtifacts,
    initSessionArtifacts,
    appendLine,
    writeEvent,
    writePipelineRow,
    writePipelineSummary,
    appendAudioTrack,
    appendConversationPair,
  };
}

module.exports = {
  createArtifactService,
};
