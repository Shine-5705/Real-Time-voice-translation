const fs = require('fs');
const path = require('path');

function createArtifactService({ env, nowISO, logInfo, logError }) {
  let sessionArtifacts = null;
  let pipelineStats = { count: 0, sttSum: 0, translateSum: 0, ttsSum: 0, totalSum: 0, latencySum: 0 };

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
      sourceLanguage,
      targetLanguage,
    };

    fs.writeFileSync(sessionArtifacts.sourceLogPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.spokenTextPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.translatedLogPath, '', 'utf8');
    fs.writeFileSync(sessionArtifacts.eventsPath, '', 'utf8');

    const header =
      `=== Pipeline Timing Log ===\n`
      + `Session started : ${nowISO()}\n`
      + `Source language  : ${sourceLanguage}\n`
      + `Target language  : ${targetLanguage}\n`
      + `STT provider     : ${env('STT_PROVIDER', 'vachana')}\n`
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
    if (!sessionArtifacts || pipelineStats.count === 0) return;
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
  }

  return {
    getSessionArtifacts: () => sessionArtifacts,
    initSessionArtifacts,
    appendLine,
    writeEvent,
    writePipelineRow,
    writePipelineSummary,
  };
}

module.exports = {
  createArtifactService,
};
