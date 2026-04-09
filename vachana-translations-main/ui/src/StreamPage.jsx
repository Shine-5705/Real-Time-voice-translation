import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './StreamPage.css'

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
const PAGE_SIZE = 20

function buildApiUrl(path) {
  if (!API_BASE_URL) {
    return path
  }
  return `${API_BASE_URL}${path}`
}

function inferAudioMime(base64Audio) {
  if (!base64Audio) {
    return 'audio/mpeg'
  }
  if (base64Audio.startsWith('UklG')) {
    return 'audio/wav'
  }
  if (base64Audio.startsWith('SUQz') || base64Audio.startsWith('/+MY')) {
    return 'audio/mpeg'
  }
  if (base64Audio.startsWith('T2dn')) {
    return 'audio/ogg'
  }
  return 'audio/mpeg'
}

function formatDate(isoValue) {
  if (!isoValue) {
    return 'N/A'
  }
  const date = new Date(isoValue)
  if (Number.isNaN(date.getTime())) {
    return isoValue
  }
  return date.toLocaleString()
}

function StreamPage() {
  const [sessions, setSessions] = useState([])
  const [sessionsPagination, setSessionsPagination] = useState({ page: 1, total_pages: 1 })
  const [sessionsLoading, setSessionsLoading] = useState(false)

  const [selectedSessionId, setSelectedSessionId] = useState('')

  const [results, setResults] = useState([])
  const [resultsPagination, setResultsPagination] = useState({ page: 1, total_pages: 1 })
  const [resultsLoading, setResultsLoading] = useState(false)
  const [selectedResultId, setSelectedResultId] = useState('')
  const [resultAudioCache, setResultAudioCache] = useState({})
  const [audioLoadingResultId, setAudioLoadingResultId] = useState('')

  const [error, setError] = useState('')
  const pollAttemptsRef = useRef(0)

  const selectedResult = useMemo(
    () => results.find((result) => result.id === selectedResultId) ?? null,
    [results, selectedResultId],
  )

  const selectedAudioSources = useMemo(() => {
    const audioByLanguage = resultAudioCache[selectedResultId]
    if (!audioByLanguage) {
      return {}
    }
    const sources = {}
    for (const [lang, b64] of Object.entries(audioByLanguage)) {
      sources[lang] = b64 ? `data:${inferAudioMime(b64)};base64,${b64}` : ''
    }
    return sources
  }, [resultAudioCache, selectedResultId])

  const loadSessions = async (page) => {
    setSessionsLoading(true)
    setError('')
    try {
      const response = await fetch(buildApiUrl(`/api/sessions?page=${page}&page_size=${PAGE_SIZE}`))
      if (!response.ok) {
        throw new Error(`Unable to fetch sessions (${response.status})`)
      }
      const payload = await response.json()
      const items = payload.items ?? []
      const pagination = payload.pagination ?? { page, total_pages: 1 }
      setSessions(items)
      setSessionsPagination({
        page: pagination.page ?? page,
        total_pages: pagination.total_pages ?? 1,
      })

      if (items.length === 0) {
        setSelectedSessionId('')
        setResults([])
        setSelectedResultId('')
        return
      }

      setSelectedSessionId((current) => {
        const stillExists = items.some((session) => session.session_id === current)
        return stillExists ? current : items[0].session_id
      })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSessionsLoading(false)
    }
  }

  const loadSessionResults = useCallback(async (sessionId, page, { silent = false } = {}) => {
    if (!sessionId) {
      setResults([])
      setSelectedResultId('')
      return
    }

    if (!silent) {
      setResultsLoading(true)
      setError('')
    }
    try {
      const response = await fetch(
        buildApiUrl(
          `/api/sessions/${encodeURIComponent(sessionId)}/results?page=${page}&page_size=${PAGE_SIZE}&include_audio=false`,
        ),
      )
      if (!response.ok) {
        throw new Error(`Unable to fetch session results (${response.status})`)
      }
      const payload = await response.json()
      const items = payload.items ?? []
      const pagination = payload.pagination ?? { page, total_pages: 1 }
      setResults(items)
      setResultsPagination({
        page: pagination.page ?? page,
        total_pages: pagination.total_pages ?? 1,
      })
      setSelectedResultId((current) => {
        const stillExists = items.some((item) => item.id === current)
        return stillExists ? current : ''
      })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      if (!silent) {
        setResultsLoading(false)
      }
    }
  }, [])

  const loadResultAudio = async (sessionId, resultId) => {
    if (!sessionId || !resultId) {
      return
    }
    if (Object.prototype.hasOwnProperty.call(resultAudioCache, resultId)) {
      return
    }

    setAudioLoadingResultId(resultId)
    setError('')
    try {
      const response = await fetch(
        buildApiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/results/${encodeURIComponent(resultId)}/audio`),
      )
      if (!response.ok) {
        throw new Error(`Unable to fetch audio (${response.status})`)
      }
      const payload = await response.json()
      const audioByLanguage = payload.audio_base64s ?? {}
      setResultAudioCache((current) => ({
        ...current,
        [resultId]: audioByLanguage,
      }))
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setAudioLoadingResultId((current) => (current === resultId ? '' : current))
    }
  }

  const handleResultClick = (resultId) => {
    setSelectedResultId(resultId)
    void loadResultAudio(selectedSessionId, resultId)
  }

  useEffect(() => {
    loadSessions(1)
  }, [])

  useEffect(() => {
    setResultAudioCache({})
    setAudioLoadingResultId('')
    setSelectedResultId('')
    pollAttemptsRef.current = 0
    loadSessionResults(selectedSessionId, 1)
  }, [selectedSessionId, loadSessionResults])

  useEffect(() => {
    if (!selectedSessionId) {
      return undefined
    }

    const pollId = window.setInterval(() => {
      if (pollAttemptsRef.current >= 100) {
        window.clearInterval(pollId)
        return
      }
      pollAttemptsRef.current += 1
      loadSessionResults(selectedSessionId, resultsPagination.page, { silent: true })
    }, 8000)

    return () => {
      window.clearInterval(pollId)
    }
  }, [selectedSessionId, resultsPagination.page, loadSessionResults])

  return (
    <main className="stream-shell">
      <aside className="stream-sidebar">
        <div className="stream-sidebar-header">
          <h2>Sessions</h2>
          <button type="button" onClick={() => loadSessions(sessionsPagination.page)} disabled={sessionsLoading}>
            Refresh
          </button>
        </div>

        <div className="stream-scroll-list">
          {sessionsLoading && <p className="muted-text">Loading sessions...</p>}
          {!sessionsLoading && sessions.length === 0 && <p className="muted-text">No sessions found.</p>}
          {sessions.map((session) => (
            <button
              key={session.session_id}
              type="button"
              className={`stream-list-item ${selectedSessionId === session.session_id ? 'active' : ''}`}
              onClick={() => setSelectedSessionId(session.session_id)}
            >
              <strong>{session.session_id}</strong>
              <span>Last: {formatDate(session.last_created_at)}</span>
              <span>Items: {session.result_count ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="stream-pagination">
          <button
            type="button"
            onClick={() => loadSessions(sessionsPagination.page - 1)}
            disabled={sessionsPagination.page <= 1 || sessionsLoading}
          >
            Prev
          </button>
          <span>
            {sessionsPagination.page} / {sessionsPagination.total_pages}
          </span>
          <button
            type="button"
            onClick={() => loadSessions(sessionsPagination.page + 1)}
            disabled={sessionsPagination.page >= sessionsPagination.total_pages || sessionsLoading}
          >
            Next
          </button>
        </div>
      </aside>

      <aside className="stream-sidebar">
        <div className="stream-sidebar-header">
          <h2>Transcripts</h2>
          <button
            type="button"
            onClick={() => loadSessionResults(selectedSessionId, resultsPagination.page)}
            disabled={resultsLoading || !selectedSessionId}
          >
            Refresh
          </button>
        </div>

        <div className="stream-scroll-list">
          {resultsLoading && <p className="muted-text">Loading results...</p>}
          {!resultsLoading && results.length === 0 && <p className="muted-text">No results in this session.</p>}
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              className={`stream-list-item ${selectedResultId === result.id ? 'active' : ''}`}
              onClick={() => handleResultClick(result.id)}
            >
              <strong>{formatDate(result.created_at)}</strong>
              <span>{result.source_text || 'No source text'}</span>
            </button>
          ))}
        </div>

        <div className="stream-pagination">
          <button
            type="button"
            onClick={() => loadSessionResults(selectedSessionId, resultsPagination.page - 1)}
            disabled={resultsPagination.page <= 1 || resultsLoading || !selectedSessionId}
          >
            Prev
          </button>
          <span>
            {resultsPagination.page} / {resultsPagination.total_pages}
          </span>
          <button
            type="button"
            onClick={() => loadSessionResults(selectedSessionId, resultsPagination.page + 1)}
            disabled={
              resultsPagination.page >= resultsPagination.total_pages || resultsLoading || !selectedSessionId
            }
          >
            Next
          </button>
        </div>
      </aside>

      <section className="stream-content">
        <span>
          <h2>Audio Player</h2>
        </span>

        {!selectedResult && <p className="muted-text">Select an item from the transcripts list.</p>}

        {selectedResult && (
          <div className="stream-result-card">
            <div className="stream-text-block">
              <h3>English {selectedResult.speaker_id ? <span className="speaker-tag">({selectedResult.speaker_id})</span> : null}</h3>
              <p>{selectedResult.source_text || 'N/A'}</p>
            </div>

            {Object.entries(selectedResult.translated_texts ?? {}).map(([lang, text]) => (
              <div className="stream-text-block" key={lang}>
                <h3>{lang.charAt(0).toUpperCase() + lang.slice(1)}</h3>
                <p>{text || 'N/A'}</p>
              </div>
            ))}

            {Object.entries(selectedAudioSources).map(([lang, src]) => (
              <div className="stream-text-block" key={`audio-${lang}`}>
                <h3>Audio - {lang.charAt(0).toUpperCase() + lang.slice(1)}</h3>
                {audioLoadingResultId === selectedResultId ? (
                  <p className="muted-text">Loading audio...</p>
                ) : src ? (
                  <audio controls src={src} />
                ) : (
                  <p className="muted-text">No {lang.charAt(0).toUpperCase() + lang.slice(1)} audio for this item.</p>
                )}
              </div>
            ))}

            {Object.keys(selectedAudioSources).length === 0 && audioLoadingResultId !== selectedResultId && (
              <p className="muted-text">No audio available for this item.</p>
            )}
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
      </section>
    </main>
  )
}

export default StreamPage
