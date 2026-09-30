import { Menu } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { ApiError, api } from '../api/client'
import { readTurnEvents } from '../api/sse'
import type { SavedTurn, Source, TurnEvent } from '../api/types'
import { deriveTitle } from '../lib/text'
import {
  ANALYSIS_TERMINAL,
  LANE_TERMINAL,
  analysisMatchesAnswer,
  answersDone,
  applyEvent,
  emptyLane,
  fromSaved,
  turnSettled,
  type TurnView,
} from '../lib/turns'
import { Composer } from './Composer'
import { EmptyState } from './EmptyState'
import { GroundedDot, UngroundedDot } from './Marks'
import { StatusPill, groundedStatus, ungroundedStatus } from './StatusPill'
import { useToast } from './Toast'
import { TurnBlock } from './TurnBlock'

type Action =
  | { type: 'load'; turns: TurnView[] }
  | { type: 'add'; turn: TurnView }
  | { type: 'replace'; id: string; turn: TurnView }
  | { type: 'remove'; id: string }
  | { type: 'event'; event: TurnEvent }
  | { type: 'saved'; saved: SavedTurn }

function reducer(turns: TurnView[], action: Action): TurnView[] {
  switch (action.type) {
    case 'load': {
      // Turns already followed locally (e.g. sent while this session was being created) win.
      const local = new Map(turns.map((t) => [t.id, t]))
      const loaded = action.turns.map((t) => local.get(t.id) ?? t)
      const ids = new Set(loaded.map((t) => t.id))
      return [...loaded, ...turns.filter((t) => !ids.has(t.id))]
    }
    case 'add':
      return [...turns, action.turn]
    case 'replace':
      return turns.map((t) => (t.id === action.id ? action.turn : t))
    case 'remove':
      return turns.filter((t) => t.id !== action.id)
    case 'event':
      return turns.map((t) => (t.id === action.event.turn_id ? applyEvent(t, action.event) : t))
    case 'saved': {
      // Saved state is canonical once the turn is terminal; keep local-only fields.
      const saved = fromSaved(action.saved)
      return turns.map((t) =>
        t.id === saved.id
          ? {
              ...saved,
              cursor: Math.max(t.cursor, action.saved.event_sequence),
              localImages: t.localImages,
              processingSourceIds: t.processingSourceIds,
            }
          : t,
      )
    }
  }
}

function savedSettled(saved: SavedTurn) {
  return (
    LANE_TERMINAL.has(saved.rag_state) &&
    LANE_TERMINAL.has(saved.baseline_state) &&
    ANALYSIS_TERMINAL.has(saved.analysis_state)
  )
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (window.clearTimeout(timer), resolve()), { once: true })
  })

/** Follows one turn's combined stream until it settles, reconnecting with Last-Event-ID. */
async function followTurn(
  sessionId: string,
  turn: TurnView,
  signal: AbortSignal,
  dispatch: (action: Action) => void,
) {
  let cursor = turn.cursor
  let delay = 1000
  const onEvent = (event: TurnEvent) => {
    if (signal.aborted) return
    cursor = Math.max(cursor, event.event_id)
    dispatch({ type: 'event', event })
  }
  const reconcile = async () => {
    const saved = await api.turn(sessionId, turn.id)
    if (signal.aborted) return true
    if (savedSettled(saved)) {
      dispatch({ type: 'saved', saved })
      return true
    }
    return false
  }
  while (!signal.aborted) {
    try {
      await readTurnEvents(`/sessions/${sessionId}/turns/${turn.id}/events`, cursor, signal, onEvent)
      if (await reconcile()) return
      delay = 1000
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 404) return
        if (error.status === 410 || error.status === 422) {
          // Replay expired: fall back to polling the saved turn.
          while (!signal.aborted) {
            try {
              if (await reconcile()) return
            } catch {
              // Keep polling; transient failures are expected while the backend restarts.
            }
            await sleep(2500, signal)
          }
          return
        }
      }
      await sleep(delay, signal)
      delay = Math.min(delay * 2, 10_000)
    }
  }
}

function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

interface Props {
  sessionId: string | null
  title: string
  sources: Source[]
  ensureSession: (title: string) => Promise<string>
  onActivity: () => void
  onOpenKnowledgeBase: () => void
  onOpenNav: () => void
  onMissing: () => void
}

export function SessionView(props: Props) {
  const { sessionId, sources, onActivity } = props
  const toast = useToast()
  const [turns, dispatch] = useReducer(reducer, [])
  const [loading, setLoading] = useState(Boolean(sessionId))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [mobileLane, setMobileLane] = useState<'rag' | 'baseline'>('rag')
  const [editingTitle, setEditingTitle] = useState(false)
  const adopted = useRef<string | null>(null)
  const streams = useRef(new Map<string, AbortController>())
  const settledSeen = useRef(new Set<string>())
  const refetched = useRef(new Set<string>())
  const scroller = useRef<HTMLDivElement>(null)
  const latest = turns[turns.length - 1]

  // Load saved turns, except for a session this view just created (its turn is already local).
  useEffect(() => {
    if (!sessionId || adopted.current === sessionId) return
    let cancelled = false
    setLoading(true)
    api.session(sessionId).then(
      (detail) => {
        if (cancelled) return
        const loaded = detail.turns.map(fromSaved)
        loaded.filter(turnSettled).forEach((t) => settledSeen.current.add(t.id))
        dispatch({ type: 'load', turns: loaded })
        setLoading(false)
      },
      (error) => {
        if (cancelled) return
        setLoading(false)
        if (error instanceof ApiError && error.status === 404) props.onMissing()
        else toast(error instanceof Error ? error.message : 'Could not load the session')
      },
    )
    return () => {
      cancelled = true
    }
    // Only a session change reloads; callbacks from props are read at call time.
  }, [sessionId])

  // One stream per unsettled turn.
  useEffect(() => {
    if (!sessionId) return
    for (const turn of turns) {
      if (turn.optimistic || turnSettled(turn) || streams.current.has(turn.id)) continue
      const controller = new AbortController()
      streams.current.set(turn.id, controller)
      followTurn(sessionId, turn, controller.signal, dispatch).finally(() => {
        if (streams.current.get(turn.id) === controller) streams.current.delete(turn.id)
      })
    }
  }, [sessionId, turns])

  useEffect(() => {
    const active = streams.current
    return () => {
      active.forEach((controller) => controller.abort())
      active.clear()
    }
  }, [])

  // Refresh sidebar counts as turns settle; refetch canonical text when spans don't match it.
  useEffect(() => {
    let changed = false
    for (const turn of turns) {
      if (turnSettled(turn) && !settledSeen.current.has(turn.id)) {
        settledSeen.current.add(turn.id)
        changed = true
      }
      if (sessionId && answersDone(turn) && !analysisMatchesAnswer(turn) && !refetched.current.has(turn.id)) {
        refetched.current.add(turn.id)
        api.turn(sessionId, turn.id).then((saved) => dispatch({ type: 'saved', saved }), () => {})
      }
    }
    if (changed) onActivity()
  }, [turns, sessionId, onActivity])

  // A new turn scrolls to its question (with the previous question row above it); while it streams
  // the view follows the text until the reader scrolls up.
  const stick = useRef(true)
  const shownTurn = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    const node = el?.querySelector<HTMLElement>('.turn.is-latest')
    if (!el || !node || !latest) return
    if (shownTurn.current !== latest.id) {
      const replacingOptimistic = shownTurn.current?.startsWith('pending_') && !latest.optimistic
      shownTurn.current = latest.id
      if (replacingOptimistic) return
      stick.current = true
      el.scrollTop = Math.max(0, node.offsetTop - (node.previousElementSibling ? 52 : 0))
      return
    }
    if (!stick.current || answersDone(latest)) return
    const grid = node.querySelector('.turn-grid')
    if (!grid) return
    const overflow = grid.getBoundingClientRect().bottom - (el.getBoundingClientRect().bottom - 140)
    if (overflow > 0) el.scrollTop += overflow
  }, [latest, loading])

  const submit = useCallback(
    async (text: string, files: File[]) => {
      const rid = requestId()
      const tempId = 'pending_' + rid
      const previews = files.map((file) => URL.createObjectURL(file))
      const temp: TurnView = {
        id: tempId,
        sequence: (latest?.sequence ?? 0) + 1,
        question: text,
        attachmentIds: [],
        localImages: previews,
        created: Date.now() / 1000,
        rag: emptyLane(),
        baseline: emptyLane(),
        analysisState: 'pending',
        analysis: null,
        analysisNote: null,
        processingSourceIds: [],
        cursor: 0,
        optimistic: true,
      }
      dispatch({ type: 'add', turn: temp })
      try {
        const title = deriveTitle(text || 'Image question')
        const id = sessionId ?? (adopted.current = await props.ensureSession(title))
        if (sessionId && !turns.length && props.title === 'New session') {
          api.renameSession(id, title).then(onActivity, () => {})
        }
        const attachmentIds: string[] = []
        for (const file of files) attachmentIds.push((await api.uploadAttachment(id, file)).attachment_id)
        let created
        for (let attempt = 0; ; attempt++) {
          try {
            // The request id makes retries safe: the backend returns the same turn.
            created = await api.createTurn(id, rid, text, attachmentIds)
            break
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 0 || attempt >= 2) throw error
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
          }
        }
        dispatch({
          type: 'replace',
          id: tempId,
          turn: {
            ...temp,
            id: created.turn_id,
            optimistic: false,
            attachmentIds,
            processingSourceIds: created.processing_source_ids,
          },
        })
        onActivity()
        return true
      } catch (error) {
        dispatch({ type: 'remove', id: tempId })
        previews.forEach((p) => URL.revokeObjectURL(p))
        if (error instanceof ApiError && error.code === 'provider_unavailable')
          toast('The answering model is not configured on the server (Gemini API key and model ID).')
        else toast(error instanceof Error ? error.message : 'Could not send the question')
        return false
      }
    },
    [latest?.sequence, onActivity, props, sessionId, toast, turns.length],
  )

  const stop = async () => {
    if (!sessionId || !latest || latest.optimistic) return
    try {
      await api.cancelTurn(sessionId, latest.id)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not stop the turn')
    }
  }

  const retryAnalysis = async (turnId: string) => {
    if (!sessionId) return
    try {
      await api.retryAnalysis(sessionId, turnId)
      refetched.current.delete(turnId)
      const saved = await api.turn(sessionId, turnId)
      dispatch({ type: 'replace', id: turnId, turn: { ...fromSaved(saved), cursor: 0 } })
      streams.current.get(turnId)?.abort()
      streams.current.delete(turnId)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not retry the fact check')
    }
  }

  const rename = async (title: string) => {
    setEditingTitle(false)
    const trimmed = title.trim()
    if (!sessionId || !trimmed || trimmed === props.title) return
    try {
      await api.renameSession(sessionId, trimmed)
      onActivity()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not rename the session')
    }
  }

  const busy = Boolean(latest && !answersDone(latest))
  const empty = !turns.length && !loading
  const readySources = sources.filter((s) => s.status === 'ready')
  const displayTitle = props.title || (loading ? '' : 'Untitled session')

  return (
    <main className={`session lane-${mobileLane}`}>
      <header className="session-header">
        <button type="button" className="icon-button nav-button" onClick={props.onOpenNav} aria-label="Open sessions">
          <Menu size={20} />
        </button>
        {editingTitle ? (
          <input
            className="title-input"
            defaultValue={props.title}
            autoFocus
            maxLength={200}
            aria-label="Session title"
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename(e.currentTarget.value)
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <h1
            className={`session-title-heading ${sessionId ? '' : 'is-draft'}`}
            onDoubleClick={() => sessionId && setEditingTitle(true)}
            title={sessionId ? 'Double-click to rename' : undefined}
          >
            {displayTitle}
          </h1>
        )}
        <div className="lane-switch" role="tablist" aria-label="Answer shown">
          <button type="button" role="tab" aria-selected={mobileLane === 'rag'} onClick={() => setMobileLane('rag')}>
            Grounded
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileLane === 'baseline'}
            onClick={() => setMobileLane('baseline')}
          >
            Ungrounded
          </button>
        </div>
      </header>

      <div className="columns-head">
        <div className="column-head column-rag">
          <h2>
            <GroundedDot /> Grounded
          </h2>
          {latest && <StatusPill lane="rag" status={groundedStatus(latest)} />}
        </div>
        <div className="column-head column-baseline">
          <h2>
            <UngroundedDot /> Ungrounded
          </h2>
          {latest && <StatusPill lane="baseline" status={ungroundedStatus(latest)} />}
        </div>
      </div>

      <div className="session-body" ref={scroller}
        onWheel={(e) => e.deltaY < 0 && (stick.current = false)}
        onTouchMove={() => (stick.current = false)}
      >
        {empty ? (
          <EmptyState hasSources={readySources.length > 0} onOpenKnowledgeBase={props.onOpenKnowledgeBase} />
        ) : (
          <div className="turns">
            {turns.map((turn, index) => {
              const isLatest = index === turns.length - 1
              return (
                <TurnBlock
                  key={turn.id}
                  turn={turn}
                  isLatest={isLatest}
                  expanded={isLatest || expanded.has(turn.id)}
                  onToggle={() =>
                    setExpanded((set) => {
                      const next = new Set(set)
                      if (next.has(turn.id)) next.delete(turn.id)
                      else next.add(turn.id)
                      return next
                    })
                  }
                  sources={sources}
                  onRetryAnalysis={() => retryAnalysis(turn.id)}
                />
              )
            })}
          </div>
        )}
      </div>

      {busy && latest && latest.analysisState === 'pending' && (
        <div className="factcheck-note">
          <ClockIcon /> Fact check runs when both answers finish
        </div>
      )}

      <Composer
        busy={busy}
        canStop={Boolean(latest && !latest.optimistic)}
        placeholder={busy ? 'Waiting for both answers...' : turns.length ? 'Ask a follow-up' : 'Ask a question'}
        suggestions={empty ? suggestionsFor(readySources) : []}
        onSubmit={submit}
        onStop={stop}
      />
    </main>
  )
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.6V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function suggestionsFor(sources: Source[]) {
  if (!sources.length) return []
  if (sources.length === 1) {
    const name = sources[0].title.replace(/\.(pdf|docx|pptx|md)$/i, '').replace(/_/g, ' ')
    return [`Summarize ${name}`, 'What are the key dates?', 'What numbers does it mention?']
  }
  return ['Summarize my documents', 'What are the key dates?', 'Where do my sources disagree?']
}
