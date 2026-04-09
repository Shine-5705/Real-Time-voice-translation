import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function resolveApiBaseUrl() {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL
  }

  const hostname = window.location.hostname
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (isLocalHost) {
    return `${window.location.protocol}//${hostname}:8112`
  }
  return `${window.location.protocol}//${window.location.host}`
}

const API_BASE_URL = resolveApiBaseUrl()
const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL ?? API_BASE_URL

function extractVideoId(link) {
  try {
    const url = new URL(link)
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1)
    }
    if (url.hostname.includes('youtube.com')) {
      return url.searchParams.get('v')
    }
  } catch {
    return null
  }
  return null
}

function buildApiUrl(path) {
  if (!API_BASE_URL) {
    return path
  }
  return `${API_BASE_URL}${path}`
}

function toWebSocketUrl(rawUrl) {
  const wsBase = WS_BASE_URL || `${window.location.protocol}//${window.location.host}`

  if (!rawUrl) {
    return `${wsBase.replace(/^http/, 'ws')}/ws/translate`
  }
  if (rawUrl.startsWith('ws://') || rawUrl.startsWith('wss://')) {
    return rawUrl
  }
  return `${wsBase.replace(/^http/, 'ws')}${rawUrl}`
}

function decodeBase64Chunk(base64Data) {
  const binary = atob(base64Data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function App() {
  const [ytLink, setYtLink] = useState('')
  const [streamUrl, setStreamUrl] = useState('')
  const [selectedLanguage, setSelectedLanguage] = useState('')
  const [subtitles, setSubtitles] = useState({})
  const [knownLanguages, setKnownLanguages] = useState([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamStatus, setStreamStatus] = useState('Disconnected')
  const [error, setError] = useState('')
  const [latestSourceText, setLatestSourceText] = useState('')
  const [latestSpeakerId, setLatestSpeakerId] = useState('')
  const [subtitleKind, setSubtitleKind] = useState('interim')
  const [subtitleHistory, setSubtitleHistory] = useState([])
  const audioRef = useRef(null)
  const ttsAudioRef = useRef(null)
  const webSocketRef = useRef(null)
  const sourceBufferRef = useRef(null)
  const chunkQueueRef = useRef([])
  const objectUrlRef = useRef('')
  const ttsQueueRef = useRef([])
  const pendingFinalSubtitlesRef = useRef([])
  const ttsCurrentUrlRef = useRef('')

  const videoId = useMemo(() => extractVideoId(ytLink), [ytLink])
  const iframeSrc = useMemo(
    () => (videoId ? `https://www.youtube.com/embed/${videoId}` : ''),
    [videoId],
  )

  const appendQueuedChunks = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current
    if (!sourceBuffer || sourceBuffer.updating || chunkQueueRef.current.length === 0) {
      return
    }
    const nextChunk = chunkQueueRef.current.shift()
    sourceBuffer.appendBuffer(nextChunk)
  }, [])

  const queueAudioChunk = useCallback(
    (chunk) => {
      chunkQueueRef.current.push(chunk)
      appendQueuedChunks()
    },
    [appendQueuedChunks],
  )

  const initializeMediaSource = useCallback(
    (mimeType = 'audio/webm; codecs=opus') => {
      if (!audioRef.current) {
        return
      }

      sourceBufferRef.current = null
      chunkQueueRef.current = []

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }

      const mediaSource = new MediaSource()
      objectUrlRef.current = URL.createObjectURL(mediaSource)
      audioRef.current.src = objectUrlRef.current

      mediaSource.addEventListener('sourceopen', () => {
        try {
          if (!MediaSource.isTypeSupported(mimeType)) {
            setError(`Unsupported stream MIME type: ${mimeType}`)
            return
          }
          const sourceBuffer = mediaSource.addSourceBuffer(mimeType)
          sourceBuffer.mode = 'sequence'
          sourceBufferRef.current = sourceBuffer
          sourceBuffer.addEventListener('updateend', appendQueuedChunks)
          appendQueuedChunks()
        } catch (setupError) {
          setError(`Audio stream initialization failed: ${setupError.message}`)
        }
      })
    },
    [appendQueuedChunks],
  )

  const stopStreaming = useCallback(() => {
    if (webSocketRef.current) {
      webSocketRef.current.close()
      webSocketRef.current = null
    }
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause()
      ttsAudioRef.current.removeAttribute('src')
      ttsAudioRef.current.load()
    }
    if (ttsCurrentUrlRef.current) {
      URL.revokeObjectURL(ttsCurrentUrlRef.current)
      ttsCurrentUrlRef.current = ''
    }
    ttsQueueRef.current.forEach((item) => URL.revokeObjectURL(item.url))
    ttsQueueRef.current = []
    pendingFinalSubtitlesRef.current = []
    setIsStreaming(false)
    setStreamStatus('Disconnected')
  }, [])

  const applySubtitlePayload = useCallback((payload) => {
    if (payload.subtitles) {
      const incoming = payload.subtitles
      const langs = Object.keys(incoming)
      if (langs.length > 0) {
        setKnownLanguages((prev) => {
          const merged = new Set(prev)
          langs.forEach((l) => merged.add(l))
          return merged.size !== prev.length ? [...merged] : prev
        })
        setSelectedLanguage((prev) => prev || langs[0])
      }
      setSubtitles((current) => ({ ...current, ...incoming }))
    }
    if (payload.text) {
      setLatestSourceText(payload.text)
    }
    if (payload.kind) {
      setSubtitleKind(payload.kind)
    }
    if (payload.speaker_id) {
      setLatestSpeakerId(payload.speaker_id)
    }
    if (payload.kind === 'final' && payload.text) {
      setSubtitleHistory((prev) => [
        {
          id: Date.now(),
          sourceText: payload.text,
          subtitles: payload.subtitles ?? {},
          speakerId: payload.speaker_id ?? '',
          timestamp: new Date(),
        },
        ...prev,
      ])
    }
  }, [])

  const playNextTtsChunk = useCallback(() => {
    if (!ttsAudioRef.current) {
      return
    }
    if (!ttsAudioRef.current.paused) {
      return
    }
    const nextItem = ttsQueueRef.current.shift()
    if (!nextItem) {
      return
    }

    if (ttsCurrentUrlRef.current) {
      URL.revokeObjectURL(ttsCurrentUrlRef.current)
    }
    ttsCurrentUrlRef.current = nextItem.url
    ttsAudioRef.current.src = nextItem.url
    if (nextItem.subtitlePayload) {
      applySubtitlePayload(nextItem.subtitlePayload)
    }
    ttsAudioRef.current.play().catch(() => {
      setError('Autoplay blocked for generated speech. Press play in audio controls.')
    })
  }, [applySubtitlePayload])

  const queueTtsAudioChunk = useCallback(
    (base64Audio, audioMime = 'audio/mpeg') => {
      const chunkBuffer = decodeBase64Chunk(base64Audio)
      const blob = new Blob([chunkBuffer], { type: audioMime })
      const objectUrl = URL.createObjectURL(blob)
      const subtitlePayload = pendingFinalSubtitlesRef.current.shift() ?? null
      ttsQueueRef.current.push({ url: objectUrl, subtitlePayload })
      playNextTtsChunk()
    },
    [playNextTtsChunk],
  )

  const startStreaming = useCallback(
    (streamPath) => {
      setError('')
      stopStreaming()
      initializeMediaSource()

      const ws = new WebSocket(toWebSocketUrl(streamPath))
      ws.binaryType = 'arraybuffer'
      webSocketRef.current = ws

      ws.onopen = () => {
        setIsStreaming(true)
        setStreamStatus('Connected')
      }

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          queueAudioChunk(event.data)
          return
        }

        if (event.data instanceof Blob) {
          queueAudioChunk(await event.data.arrayBuffer())
          return
        }

        if (typeof event.data === 'string') {
          try {
            const payload = JSON.parse(event.data)
            if (payload.type === 'error' && payload.message) {
              setError(payload.message)
            }
            if (payload.audioChunkBase64) {
              queueAudioChunk(decodeBase64Chunk(payload.audioChunkBase64))
            }
            if (payload.type === 'subtitle') {
              if (payload.kind === 'final') {
                pendingFinalSubtitlesRef.current.push(payload)
              } else {
                applySubtitlePayload(payload)
              }
            }
            if (payload.type === 'tts_audio' && payload.audio) {
              queueTtsAudioChunk(payload.audio, payload.audio_mime ?? 'audio/mpeg')
            }
            if (payload.tamil || payload.hindi || payload.malayalam) {
              const langUpdate = {}
              if (payload.tamil) langUpdate.tamil = payload.tamil
              if (payload.hindi) langUpdate.hindi = payload.hindi
              if (payload.malayalam) langUpdate.malayalam = payload.malayalam
              applySubtitlePayload({ subtitles: langUpdate })
            }
          } catch {
            // Non-JSON text frames are ignored.
          }
        }
      }

      ws.onerror = () => {
        setError('WebSocket audio stream error. Please try again.')
      }

      ws.onclose = () => {
        setIsStreaming(false)
        setStreamStatus('Disconnected')
      }
    },
    [applySubtitlePayload, initializeMediaSource, queueAudioChunk, queueTtsAudioChunk, stopStreaming],
  )

  useEffect(() => {
    return () => {
      stopStreaming()
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    }
  }, [stopStreaming])

  const handleTranslate = async (event) => {
    event.preventDefault()
    if (!ytLink.trim() && !streamUrl.trim()) {
      setError('Please enter a YouTube link or a direct stream URL.')
      return
    }

    setError('')
    setIsSubmitting(true)
    try {
      const params = new URLSearchParams()
      if (ytLink.trim()) params.set('yt_link', ytLink.trim())
      if (streamUrl.trim()) params.set('stream_url', streamUrl.trim())

      const response = await fetch(buildApiUrl(`/translate?${params.toString()}`))
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`)
      }

      const payload = await response.json().catch(() => ({}))
      if (payload.subtitles) {
        applySubtitlePayload(payload)
      }
      startStreaming(payload.websocket_url)
    } catch (requestError) {
      setError(`Unable to start translation: ${requestError.message}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  const subtitlesEndRef = useRef(null)

  useEffect(() => {
    if (subtitlesEndRef.current) {
      subtitlesEndRef.current.scrollTop = 0
    }
  }, [subtitleHistory])

  return (
    <main className="app-shell">
      <section className="card-panel">
        <header className="panel-header">
          <h1>YouTube Live Translator</h1>
          <p>Stream translated subtitles and generated audio in real-time.</p>
        </header>

        <form className="link-form" onSubmit={handleTranslate}>
          <input
            type="url"
            placeholder="Paste YouTube URL..."
            value={ytLink}
            onChange={(event) => setYtLink(event.target.value)}
          />
          <input
            type="url"
            placeholder="Or paste direct HLS / stream URL..."
            value={streamUrl}
            onChange={(event) => setStreamUrl(event.target.value)}
          />
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Starting...' : 'Start Translation'}
          </button>
        </form>

        <div className="main-layout">
          <div className="main-left">
            <div className="video-wrapper">
              {iframeSrc ? (
                <iframe
                  src={iframeSrc}
                  title="YouTube stream preview"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <div className="video-placeholder">
                  <p>YouTube video embed will appear here</p>
                  <span>Submit a link to load preview and begin translation.</span>
                </div>
              )}
              <div className="subtitle-overlay">
                {selectedLanguage
                  ? subtitles[selectedLanguage] || `Waiting for ${capitalize(selectedLanguage)} subtitles...`
                  : 'Subtitles will appear here once streaming starts.'}
              </div>
            </div>

            <p className="source-text">
              <strong>{subtitleKind.toUpperCase()}</strong>
              {latestSpeakerId ? <span className="speaker-badge">{latestSpeakerId}</span> : null}
              {' '}source text: {latestSourceText || 'Waiting for speech...'}
            </p>

            <div className="controls-row">
              <div className="lang-switch">
                {knownLanguages.map((langKey) => (
                  <button
                    key={langKey}
                    type="button"
                    className={selectedLanguage === langKey ? 'active' : ''}
                    onClick={() => setSelectedLanguage(langKey)}
                  >
                    {capitalize(langKey)}
                  </button>
                ))}
              </div>
              <div className={`status-pill ${isStreaming ? 'online' : ''}`}>{streamStatus}</div>
            </div>

            <section className="audio-panel">
              <h2>Translated Audio Stream</h2>
              <p>Incoming audio chunks (20ms over WebSocket) are buffered for playback.</p>
              <audio ref={audioRef} controls autoPlay />
              <p>Generated speech audio (TTS) plays here as chunks arrive.</p>
              <audio ref={ttsAudioRef} controls autoPlay onEnded={playNextTtsChunk} />
              <button type="button" className="secondary" onClick={stopStreaming} disabled={!isStreaming}>
                Stop Stream
              </button>
            </section>
          </div>

          <aside className="subtitles-panel" ref={subtitlesEndRef}>
            <h2>Subtitles</h2>

            {latestSourceText && subtitleKind === 'interim' && (
              <div className="subtitle-entry subtitle-interim">
                <div className="subtitle-entry-header">
                  <span className="subtitle-kind-badge interim">LIVE</span>
                  {latestSpeakerId && <span className="speaker-badge">{latestSpeakerId}</span>}
                  <span className="subtitle-timestamp">{new Date().toLocaleTimeString()}</span>
                </div>
                <p className="subtitle-source">{latestSourceText}</p>
              </div>
            )}

            {subtitleHistory.length === 0 && !latestSourceText && (
              <p className="subtitles-empty">Subtitles will stack here as they arrive.</p>
            )}
            {subtitleHistory.map((entry, idx) => (
              <div key={entry.id} className={`subtitle-entry${idx === 0 ? ' subtitle-active' : ''}`}>
                <div className="subtitle-entry-header">
                  {idx === 0 && <span className="subtitle-kind-badge final">FINAL</span>}
                  {entry.speakerId && <span className="speaker-badge">{entry.speakerId}</span>}
                  <span className="subtitle-timestamp">{entry.timestamp.toLocaleTimeString()}</span>
                </div>
                <p className="subtitle-source">{entry.sourceText}</p>
                {selectedLanguage && entry.subtitles[selectedLanguage] && (
                  <p className="subtitle-translated">{entry.subtitles[selectedLanguage]}</p>
                )}
              </div>
            ))}
          </aside>
        </div>

        {error && <p className="error-text">{error}</p>}
      </section>
    </main>
  )
}

export default App
