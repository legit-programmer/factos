import type {
  AnalysisResult,
  AnalysisState,
  Evidence,
  LaneState,
  SavedAnswer,
  SavedTurn,
  TurnEvent,
} from '../api/types'

export interface LaneView {
  messageId: string | null
  text: string
  status: LaneState
  citations: Evidence[]
  warnings: string[]
  hash: string | null
}

export interface TurnView {
  id: string
  sequence: number
  question: string
  attachmentIds: string[]
  localImages?: string[]
  created: number
  rag: LaneView
  baseline: LaneView
  analysisState: AnalysisState
  analysis: AnalysisResult | null
  analysisNote: string | null
  processingSourceIds: string[]
  /** Highest event_id applied; events at or below it are replay duplicates. */
  cursor: number
  optimistic?: boolean
}

export const LANE_TERMINAL = new Set<LaneState>(['completed', 'failed', 'cancelled'])
export const ANALYSIS_TERMINAL = new Set<AnalysisState>(['completed', 'partial', 'failed', 'skipped'])

export function answersDone(turn: TurnView) {
  return LANE_TERMINAL.has(turn.rag.status) && LANE_TERMINAL.has(turn.baseline.status)
}

export function turnSettled(turn: TurnView) {
  return answersDone(turn) && ANALYSIS_TERMINAL.has(turn.analysisState)
}

export function emptyLane(status: LaneState = 'pending'): LaneView {
  return { messageId: null, text: '', status, citations: [], warnings: [], hash: null }
}

function laneFromSaved(answer: SavedAnswer | undefined, state: LaneState): LaneView {
  if (!answer) return emptyLane(state)
  return {
    messageId: answer.id,
    text: answer.text,
    status: state,
    citations: answer.citations,
    warnings: answer.warnings,
    hash: answer.text_hash,
  }
}

export function fromSaved(saved: SavedTurn): TurnView {
  const answer = (lane: string) => saved.answers.find((a) => a.lane === lane)
  return {
    id: saved.id,
    sequence: saved.sequence,
    question: saved.user_message.text,
    attachmentIds: saved.user_message.attachments,
    created: saved.created,
    rag: laneFromSaved(answer('rag'), saved.rag_state),
    baseline: laneFromSaved(answer('baseline'), saved.baseline_state),
    analysisState: saved.analysis_state,
    analysis: saved.analysis,
    analysisNote: null,
    processingSourceIds: [],
    // Unsettled turns replay their stream from the start, rebuilding text from deltas.
    cursor: 0,
  }
}

function analysisFailure(payload: Record<string, unknown>): AnalysisResult {
  if (Array.isArray(payload.findings)) return payload as unknown as AnalysisResult
  const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown error'
  return { status: 'failed', findings: [], warnings: ['Verification failed: ' + reason] }
}

const TERMINAL_TYPES: Record<string, LaneState> = {
  'answer.completed': 'completed',
  'answer.failed': 'failed',
  'answer.cancelled': 'cancelled',
}

/** Applies one stream event. Pure; duplicate or replayed events return the same turn. */
export function applyEvent(turn: TurnView, event: TurnEvent): TurnView {
  if (event.event_id <= turn.cursor) return turn
  const next: TurnView = { ...turn, cursor: event.event_id }
  const payload = event.payload
  if (event.channel === 'rag' || event.channel === 'baseline') {
    const lane = { ...next[event.channel] }
    if (event.type === 'answer.started') {
      Object.assign(lane, emptyLane('running'), { messageId: payload.message_id as string })
    } else if (event.type === 'answer.delta') {
      lane.text += payload.text as string
      lane.status = 'running'
    } else if (event.type in TERMINAL_TYPES) {
      lane.status = (payload.finish_status as LaneState) ?? TERMINAL_TYPES[event.type]
      lane.text = (payload.text as string) ?? lane.text
      lane.citations = (payload.citations as Evidence[]) ?? []
      lane.warnings = (payload.warnings as string[]) ?? []
      lane.hash = (payload.answer_text_sha256 as string) ?? null
    }
    next[event.channel] = lane
  } else if (event.channel === 'analysis') {
    if (event.type === 'analysis.queued') {
      next.analysisState = 'pending'
      next.analysisNote = null
      if (payload.retry) next.analysis = null
    } else if (event.type === 'analysis.started') {
      next.analysisState = 'running'
    } else if (event.type === 'analysis.completed') {
      next.analysis = payload as unknown as AnalysisResult
      next.analysisState = next.analysis.status
    } else if (event.type === 'analysis.failed') {
      next.analysis = analysisFailure(payload)
      next.analysisState = 'failed'
    } else if (event.type === 'analysis.skipped') {
      next.analysisState = 'skipped'
      next.analysisNote = (payload.reason as string) ?? null
    }
  } else if (event.type === 'turn.settled') {
    next.rag = { ...next.rag, status: payload.rag as LaneState }
    next.baseline = { ...next.baseline, status: payload.baseline as LaneState }
    next.analysisState = payload.analysis as AnalysisState
  }
  return next
}

export function findingCounts(turn: TurnView) {
  const findings = turn.analysis?.findings ?? []
  return {
    contradicted: findings.filter((f) => f.verdict === 'contradicted').length,
    unverifiable: findings.filter((f) => f.verdict === 'unverifiable').length,
  }
}

/**
 * Spans are only valid for the exact canonical message they were computed on. A hash mismatch
 * means the caller must refetch the saved message instead of drawing stale annotations.
 */
export function analysisMatchesAnswer(turn: TurnView) {
  const analysis = turn.analysis
  if (!analysis?.findings.length) return true
  if (analysis.message_id && turn.baseline.messageId && analysis.message_id !== turn.baseline.messageId)
    return false
  if (analysis.answer_text_sha256 && turn.baseline.hash) return analysis.answer_text_sha256 === turn.baseline.hash
  return true
}
