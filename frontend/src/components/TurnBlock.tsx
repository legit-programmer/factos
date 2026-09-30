import { ChevronDown, ChevronUp, ImageIcon, Loader2, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Finding, Source } from '../api/types'
import { evidenceLabel, highlightSegments, parseRag } from '../lib/text'
import { analysisMatchesAnswer, answersDone, findingCounts, type TurnView } from '../lib/turns'
import { Excerpt } from './Excerpt'
import { FindingCard } from './FindingCard'
import { Swatch } from './Marks'

interface Props {
  turn: TurnView
  isLatest: boolean
  expanded: boolean
  onToggle: () => void
  sources: Source[]
  onRetryAnalysis: () => void
}

export function TurnBlock({ turn, isLatest, expanded, onToggle, sources, onRetryAnalysis }: Props) {
  const [active, setActive] = useState(0)
  const [hovered, setHovered] = useState<number | null>(null)
  const matches = analysisMatchesAnswer(turn)
  const highlight = useMemo(
    () => highlightSegments(turn.baseline.text, matches ? (turn.analysis?.findings ?? []) : []),
    [turn.baseline.text, turn.analysis, matches],
  )
  const focus = highlight.findings[hovered ?? active] ?? null
  const linkedChunks = new Set(focus?.evidence.map((e) => e.chunk_id) ?? [])

  if (!expanded) {
    return (
      <section className="turn is-collapsed">
        <button type="button" className="question-row" onClick={onToggle} aria-expanded="false">
          <span className="question-text small">{turn.question || 'Image question'}</span>
          <TurnSummary turn={turn} />
          <ChevronDown size={18} strokeWidth={1.6} className="chevron" />
        </button>
      </section>
    )
  }

  const processing = turn.processingSourceIds
    .map((id) => sources.find((s) => s.id === id))
    .filter((s): s is Source => Boolean(s && s.status === 'processing'))

  return (
    <section className={`turn ${isLatest ? 'is-latest' : ''}`}>
      {isLatest ? (
        <div className="question-row is-static">
          <Question turn={turn} />
        </div>
      ) : (
        <button type="button" className="question-row" onClick={onToggle} aria-expanded="true">
          <Question turn={turn} />
          <ChevronUp size={18} strokeWidth={1.6} className="chevron" />
        </button>
      )}
      {processing.length > 0 && (
        <p className="turn-notice">
          <Loader2 size={13} className="spin" /> {processing.length} source{processing.length > 1 ? 's were' : ' was'}{' '}
          still processing, so this turn uses the last ready knowledge base. Ask again once it finishes to include{' '}
          {processing.length > 1 ? 'them' : 'it'}.
        </p>
      )}
      <div className="turn-grid">
        <div className="cell cell-rag">
          <GroundedAnswer turn={turn} linkedChunks={linkedChunks} />
        </div>
        <div className="cell cell-baseline">
          <UngroundedAnswer
            turn={turn}
            highlight={highlight}
            active={active}
            onSelect={setActive}
            onHover={setHovered}
            hashMismatch={!matches}
            onRetry={onRetryAnalysis}
          />
        </div>
      </div>
    </section>
  )
}

function Question({ turn }: { turn: TurnView }) {
  const images = turn.localImages?.length ?? turn.attachmentIds.length
  return (
    <span className="question-block">
      {turn.localImages && turn.localImages.length > 0 && (
        <span className="question-images">
          {turn.localImages.map((src) => (
            <img key={src} src={src} alt="" />
          ))}
        </span>
      )}
      <span className="question-text">
        {turn.question || 'Image question'}
        {!turn.localImages?.length && images > 0 && (
          <span className="question-attachments">
            <ImageIcon size={13} /> {images} image{images > 1 ? 's' : ''}
          </span>
        )}
      </span>
    </span>
  )
}

function TurnSummary({ turn }: { turn: TurnView }) {
  const { contradicted, unverifiable } = findingCounts(turn)
  const state = turn.analysisState
  if (state === 'pending' || state === 'running')
    return <span className="turn-summary muted">{state === 'running' ? 'Checking…' : 'Waiting to check'}</span>
  if (state === 'failed') return <span className="turn-summary muted">Check failed</span>
  if (state === 'skipped') return <span className="turn-summary muted">Not checked</span>
  return (
    <span className="turn-summary">
      <span>
        <Swatch kind="red" /> {contradicted} contradicted
      </span>
      <span>
        <Swatch kind="yellow" /> {unverifiable} unverifiable
      </span>
    </span>
  )
}

// ---------- Grounded lane ----------

const RAG_WARNINGS: Record<string, string> = {
  invalid_citation_ids: 'Some citation markers don’t match the evidence supplied for this answer.',
  missing_citation_markers: 'This answer didn’t cite the evidence it was given.',
}

function GroundedAnswer({ turn, linkedChunks }: { turn: TurnView; linkedChunks: Set<string> }) {
  const lane = turn.rag
  const streaming = lane.status === 'running' || lane.status === 'pending'
  const parsed = useMemo(() => parseRag(lane.text, streaming), [lane.text, streaming])
  const byChunk = new Map(lane.citations.map((c) => [c.chunk_id, c]))
  const [open, setOpen] = useState<string | null>(null)

  if (lane.status === 'pending' && !lane.text) {
    return <p className="lane-placeholder">Searching your documents…</p>
  }

  return (
    <>
      <div className="answer">
        {parsed.pieces.map((piece, i) => {
          if (piece.kind === 'cite') {
            const label = piece.chunkIds.map((id) => (byChunk.get(id) ? evidenceLabel(byChunk.get(id)!) : id)).join('; ')
            const invalid = !streaming && piece.chunkIds.some((id) => !byChunk.has(id))
            return (
              <sup key={i} className={`cite ${invalid ? 'is-invalid' : ''}`} title={invalid ? 'Not in supplied evidence' : label}>
                {piece.numbers.join(',')}
              </sup>
            )
          }
          if (piece.claim === undefined) return <span key={i}>{piece.text}</span>
          const linked = parsed.claims[piece.claim].chunkIds.some((id) => linkedChunks.has(id))
          return (
            <span key={i} className={`claim ${linked ? 'is-linked' : ''}`}>
              {piece.text}
            </span>
          )
        })}
        {streaming && <span className="caret caret-rag" aria-hidden="true" />}
      </div>
      <LaneOutcome status={lane.status} />
      {lane.warnings
        .filter((w) => RAG_WARNINGS[w] || w.startsWith('Answer failed'))
        .map((w) => (
          <p key={w} className="lane-warning">
            {RAG_WARNINGS[w] ?? w}
          </p>
        ))}
      {!streaming && parsed.order.length > 0 && (
        <ol className="citations">
          {parsed.order.map((id, index) => {
            const citation = byChunk.get(id)
            return (
              <li key={id}>
                <span className="citation-number">{index + 1}</span>
                <div>
                  <button
                    type="button"
                    className={`citation-label ${linkedChunks.has(id) ? 'is-linked' : ''}`}
                    onClick={() => setOpen(open === id ? null : id)}
                    aria-expanded={open === id}
                    disabled={!citation}
                  >
                    {citation ? evidenceLabel(citation) : `Unknown source (${id})`}
                  </button>
                  {open === id && citation && <Excerpt evidence={citation} />}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </>
  )
}

function LaneOutcome({ status }: { status: TurnView['rag']['status'] }) {
  if (status === 'failed') return <p className="lane-error">This answer failed before it finished.</p>
  if (status === 'cancelled') return <p className="lane-note">Stopped.</p>
  return null
}

// ---------- Ungrounded lane ----------

const TERMINATION: Record<string, string> = {
  tool_limit: 'search limit reached',
  timeout: 'timed out',
  error: 'stopped by an error',
}

function UngroundedAnswer({
  turn,
  highlight,
  active,
  onSelect,
  onHover,
  hashMismatch,
  onRetry,
}: {
  turn: TurnView
  highlight: ReturnType<typeof highlightSegments>
  active: number
  onSelect: (index: number) => void
  onHover: (index: number | null) => void
  hashMismatch: boolean
  onRetry: () => void
}) {
  const lane = turn.baseline
  const streaming = lane.status === 'running' || lane.status === 'pending'
  const analysis = turn.analysis
  const checked = turn.analysisState === 'completed' || turn.analysisState === 'partial'
  const findings = highlight.findings
  const current = Math.min(active, Math.max(findings.length - 1, 0))
  const counts = {
    contradicted: findings.filter((f) => f.verdict === 'contradicted').length,
    unverifiable: findings.filter((f) => f.verdict === 'unverifiable').length,
  }
  const jumpTo = (verdict: Finding['verdict']) => {
    const index = findings.findIndex((f) => f.verdict === verdict)
    if (index >= 0) onSelect(index)
  }

  if (lane.status === 'pending' && !lane.text) {
    return <p className="lane-placeholder">Answering from memory…</p>
  }

  return (
    <>
      {checked && (
        <div className="finding-chips">
          <button type="button" className="chip-count" onClick={() => jumpTo('contradicted')}>
            <Swatch kind="red" /> {counts.contradicted} contradicted
          </button>
          <button type="button" className="chip-count" onClick={() => jumpTo('unverifiable')}>
            <Swatch kind="yellow" /> {counts.unverifiable} unverifiable
          </button>
        </div>
      )}
      <div className="answer">
        {highlight.segments.map((segment, i) =>
          segment.finding ? (
            <span key={i}>
              <mark
                role="button"
                tabIndex={0}
                className={`finding finding-${segment.finding.highlight} ${segment.index === current ? 'is-active' : ''}`}
                aria-label={`${segment.finding.verdict}: ${segment.finding.reason}`}
                title={segment.finding.reason}
                onClick={() => onSelect(segment.index!)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(segment.index!)
                  }
                }}
                onMouseEnter={() => onHover(segment.index!)}
                onMouseLeave={() => onHover(null)}
              >
                {segment.text}
              </mark>
              <sup className="finding-number">{segment.index! + 1}</sup>
            </span>
          ) : (
            <span key={i}>{segment.text}</span>
          ),
        )}
        {streaming && <span className="caret caret-baseline" aria-hidden="true" />}
      </div>
      <LaneOutcome status={lane.status} />
      <AnalysisStatus turn={turn} dropped={highlight.dropped} hashMismatch={hashMismatch} onRetry={onRetry} />
      {checked && analysis && findings.length > 0 && (
        <FindingCard findings={findings} index={current} onIndex={onSelect} />
      )}
    </>
  )
}

function AnalysisStatus({
  turn,
  dropped,
  hashMismatch,
  onRetry,
}: {
  turn: TurnView
  dropped: number
  hashMismatch: boolean
  onRetry: () => void
}) {
  const { analysis, analysisState: state } = turn
  if (!answersDone(turn)) return null
  if (state === 'pending')
    return (
      <p className="analysis-status">
        <Loader2 size={13} className="spin" /> Waiting for an earlier fact check to finish…
      </p>
    )
  if (state === 'running')
    return (
      <p className="analysis-status">
        <Loader2 size={13} className="spin" /> Checking claims against your sources…
      </p>
    )
  if (state === 'skipped')
    return (
      <p className="analysis-status">
        Not fact-checked{turn.baseline.status === 'completed' ? '.' : ': this answer didn’t finish.'}
      </p>
    )

  const warnings = analysis?.warnings ?? []
  const coverage = analysis?.coverage
  if (state === 'failed') {
    return (
      <div className="analysis-status is-failed">
        <p>The fact check failed, so nothing here has been verified.</p>
        {warnings.length > 0 && <Notes warnings={warnings} />}
        <button type="button" className="link-button" onClick={onRetry}>
          <RotateCcw size={13} /> Retry fact check
        </button>
      </div>
    )
  }

  const findings = analysis?.findings.length ?? 0
  return (
    <div className={`analysis-status ${state === 'partial' ? 'is-partial' : ''}`}>
      {findings === 0 && !hashMismatch && (
        <p>Nothing in this answer was contradicted by, or unverifiable against, your sources.</p>
      )}
      {hashMismatch && <p>The answer changed after it was checked, so highlights are hidden.</p>}
      {coverage && (
        <p className="coverage">
          {state === 'partial' ? 'Partial check: ' : ''}
          {coverage.claims_checked} of {coverage.claims_extracted} claims checked
          {analysis?.tool_calls_used != null && ` · ${analysis.tool_calls_used}/10 searches`}
          {analysis?.termination_reason && TERMINATION[analysis.termination_reason]
            ? ` · ${TERMINATION[analysis.termination_reason]}`
            : ''}
          {coverage.extraction_truncated ? ' · long answer, not every claim extracted' : ''}
        </p>
      )}
      {dropped > 0 && <p className="coverage">{dropped} finding(s) couldn’t be placed in the text and are hidden.</p>}
      {warnings.length > 0 && <Notes warnings={warnings} />}
      {state === 'partial' && (
        <button type="button" className="link-button" onClick={onRetry}>
          <RotateCcw size={13} /> Re-run fact check
        </button>
      )}
    </div>
  )
}

function Notes({ warnings }: { warnings: string[] }) {
  return (
    <details className="notes">
      <summary>
        {warnings.length} note{warnings.length > 1 ? 's' : ''} from the checker
      </summary>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  )
}
