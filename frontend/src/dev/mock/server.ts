// An in-browser stand-in for the Factos backend, used by the developer tools.
//
// It serves the same routes, status codes and bodies as backend/factos/api.py, keeps state in
// localStorage, and simulates work on a clock: both answer lanes stream as persisted, sequence-numbered
// events; fact checks run one at a time per session in turn order; sources index in the background.
// The event stream honours Last-Event-ID, replays from the log and returns 410 once replay has expired,
// so reloads, dropped connections and restarts exercise the same client paths as the real server.

import { API_BASE, type Transport } from '../../api/client'
import type {
  AnalysisResult,
  AnalysisState,
  Evidence,
  Finding,
  LaneState,
  Locator,
  SourceWarning,
} from '../../api/types'
import { DEMO_EMAIL, DEMO_PASSWORD, SCRIPTS, SEED, type CorpusSource, type ScriptFinding } from './scripts'

// ---------- State ----------

export type Speed = 'slow' | 'normal' | 'fast' | 'instant'
export type Outcome = 'normal' | 'rag_fail' | 'baseline_fail' | 'check_fail' | 'check_partial' | 'slow_check'

export interface MockSettings {
  speed: Speed
  outcome: Outcome
  firecrawl: boolean
}

interface MChunk {
  id: string
  sourceId: string
  text: string
  locator: Locator
  key?: string
}

interface MSource {
  id: string
  title: string
  kind: 'file' | 'website'
  status: 'processing' | 'ready' | 'failed'
  warnings: SourceWarning[]
  error: string | null
  deleted: boolean
  inputHash: string
  readyAt: number | null
  attempts: number
  failFirst: boolean
  pending: { text: string; locator: Locator; key?: string }[]
}

interface MAnswer {
  id: string
  child_id: string
  turn_id: string
  lane: 'rag' | 'baseline'
  text: string
  status: LaneState
  citations: Evidence[]
  text_hash: string | null
  warnings: string[]
}

interface MEvent {
  event_id: number
  channel: 'rag' | 'baseline' | 'analysis' | 'system'
  type: string
  payload: Record<string, unknown>
  created: number
}

interface Plan {
  outcome: Outcome
  started: boolean
  rag: string[]
  ragPos: number
  ragDelay: number
  ragCitations: Evidence[]
  ragFailAt: number | null
  baseline: string[]
  basePos: number
  baseFailAt: number | null
  script: number
  checkTicks: number
  checkElapsed: number
}

interface MTurn {
  id: string
  session_id: string
  sequence: number
  request_id: string
  payload_hash: string
  index_version: string | null
  user_message: { id: string; text: string; attachments: string[] }
  rag_state: LaneState
  baseline_state: LaneState
  analysis_state: AnalysisState
  created: number
  cancelled: number
  event_sequence: number
  answers: { rag: MAnswer; baseline: MAnswer }
  analysis: AnalysisResult | null
  verifier: { input: string; output: string; valid: number } | null
  events: MEvent[]
  settled: boolean
  plan: Plan
}

interface MSession {
  id: string
  owner: string
  title: string
  created: number
  activeIndex: string | null
  children: { id: string; role: 'rag' | 'baseline' | 'verifier' }[]
  sources: MSource[]
  chunks: MChunk[]
  snapshots: { id: string; chunkIds: string[] }[]
  attachments: { id: string; mime: string; width: number; height: number }[]
  turns: MTurn[]
}

interface MState {
  version: 1
  users: { id: string; email: string; password: string }[]
  currentUser: string | null
  sessions: MSession[]
  settings: MockSettings
}

const STORAGE = 'factos.mock.state.v1'
const DAY = 86_400_000
const LANE_TERMINAL = new Set<LaneState>(['completed', 'failed', 'cancelled'])
const ANALYSIS_TERMINAL = new Set<AnalysisState>(['completed', 'partial', 'failed', 'skipped'])
const TICK_MS: Record<Speed, number> = { slow: 110, normal: 40, fast: 12, instant: 30 }

let state: MState
let dirty = false
/** Bumped by every simulation step, so instant mode knows when work has stopped advancing. */
let progress = 0
let timer: number | undefined
const connections = new Set<{ drop: () => void }>()

function uid(prefix: string) {
  return `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** Stable text fingerprint; the client only compares these, so FNV-1a stands in for SHA-256. */
function digest(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return 'fnv1a_' + (h >>> 0).toString(16).padStart(8, '0') + text.length.toString(16)
}

function save() {
  dirty = false
  try {
    localStorage.setItem(STORAGE, JSON.stringify(state))
  } catch {
    // Quota or privacy mode: the mock keeps working in memory for this page.
  }
}

function load(): MState | null {
  try {
    const raw = localStorage.getItem(STORAGE)
    const parsed = raw ? (JSON.parse(raw) as MState) : null
    return parsed?.version === 1 ? parsed : null
  } catch {
    return null
  }
}

// ---------- Retrieval and content ----------

function sessionById(id: string) {
  return state.sessions.find((s) => s.id === id && s.owner === state.currentUser)
}

function sourceOf(session: MSession, chunk: MChunk) {
  return session.sources.find((s) => s.id === chunk.sourceId)
}

function evidenceOf(session: MSession, chunk: MChunk, excerpt = chunk.text): Evidence {
  return {
    chunk_id: chunk.id,
    source_id: chunk.sourceId,
    title: sourceOf(session, chunk)?.title ?? 'Source',
    locator: chunk.locator,
    excerpt,
  }
}

function snapshotChunks(session: MSession, version: string | null) {
  const snapshot = session.snapshots.find((s) => s.id === version)
  if (!snapshot) return []
  const ids = new Set(snapshot.chunkIds)
  return session.chunks.filter((c) => ids.has(c.id))
}

function publish(session: MSession) {
  const ready = new Set(session.sources.filter((s) => s.status === 'ready' && !s.deleted).map((s) => s.id))
  const snapshot = { id: uid('index'), chunkIds: session.chunks.filter((c) => ready.has(c.sourceId)).map((c) => c.id) }
  session.snapshots.push(snapshot)
  session.activeIndex = snapshot.id
}

function firstSentence(text: string) {
  const match = text.match(/^[\s\S]*?[.!?](?=\s|$)/)
  return (match ? match[0] : text.slice(0, 220)).trim()
}

/** Keyword overlap stands in for vector search; like FAISS it always returns the top k. */
function retrieve(question: string, chunks: MChunk[], k: number) {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []
  return chunks
    .map((chunk, index) => {
      const text = chunk.text.toLowerCase()
      return { chunk, index, score: words.filter((w) => text.includes(w)).length }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k)
    .map((r) => r.chunk)
}

const NO_EVIDENCE = 'I do not have sufficient indexed evidence to answer this question.'
const GENERIC_CLAIMS = {
  origin: 'It was first described in 1998 by an international working group',
  revisions: 'it has been revised at least four times since',
}

function genericBaseline(question: string) {
  const topic = question.trim().replace(/[?.!\s]+$/, '').slice(0, 90) || 'this'
  return (
    `Here is what I remember about “${topic}”. ${GENERIC_CLAIMS.origin}, and ${GENERIC_CLAIMS.revisions}. ` +
    'Most practitioners consider the current version reliable, although details vary between regions.'
  )
}

function pieces(text: string) {
  return text.match(/\[c_[^\]]+\]|\S+\s*|\s+/g) ?? []
}

function speed() {
  return state.settings.speed
}

function buildPlan(session: MSession, turn: MTurn, outcome: Outcome): Plan {
  const question = turn.user_message.text || 'Describe the documents relevant to the attached images'
  const chunks = snapshotChunks(session, turn.index_version)
  const script = SCRIPTS.findIndex((s) => s.match.test(question))
  let rag = ''
  let citations: Evidence[] = []
  const scripted = SCRIPTS[script]
  const keys = scripted ? [...scripted.rag.matchAll(/\[\[(\w+)\]\]/g)].map((m) => m[1]) : []
  const byKey = new Map(chunks.filter((c) => c.key).map((c) => [c.key!, c]))
  if (scripted && keys.every((key) => byKey.has(key))) {
    rag = scripted.rag.replace(/\[\[(\w+)\]\]/g, (_, key: string) => `[${byKey.get(key)!.id}]`)
    citations = [...new Set(keys)].map((key) => evidenceOf(session, byKey.get(key)!))
  } else if (chunks.length) {
    const evidence = retrieve(question, chunks, 3)
    rag = evidence.map((c) => `${firstSentence(c.text)}[${c.id}]`).join(' ')
    citations = evidence.map((c) => evidenceOf(session, c))
  } else {
    rag = NO_EVIDENCE
  }
  const baseline = scripted?.baseline ?? genericBaseline(question)
  const ragPieces = rag === NO_EVIDENCE ? [rag] : pieces(rag)
  const basePieces = pieces(baseline)
  return {
    outcome,
    started: false,
    rag: ragPieces,
    ragPos: 0,
    ragDelay: rag === NO_EVIDENCE ? 2 : 12,
    ragCitations: citations,
    ragFailAt: outcome === 'rag_fail' ? Math.max(1, Math.floor(ragPieces.length * 0.4)) : null,
    baseline: basePieces,
    basePos: 0,
    baseFailAt: outcome === 'baseline_fail' ? Math.max(1, Math.floor(basePieces.length * 0.5)) : null,
    script,
    checkTicks: outcome === 'slow_check' ? 320 : 45,
    checkElapsed: 0,
  }
}

function resolveFindings(session: MSession, turn: MTurn) {
  const text = turn.answers.baseline.text
  const chunks = snapshotChunks(session, turn.index_version)
  const byKey = new Map(chunks.filter((c) => c.key).map((c) => [c.key!, c]))
  let raw: ScriptFinding[]
  if (turn.plan.script >= 0) {
    raw = SCRIPTS[turn.plan.script].findings
  } else {
    const top = retrieve(turn.user_message.text, chunks, 1)[0]
    raw = [
      top
        ? {
            quote: GENERIC_CLAIMS.origin,
            verdict: 'contradicted',
            reason_code: 'direct_contradiction',
            reason: 'Your sources describe this differently.',
            correction: firstSentence(top.text),
            evidence: [{ key: '__top', excerpt: firstSentence(top.text) }],
          }
        : {
            quote: GENERIC_CLAIMS.origin,
            verdict: 'unverifiable',
            reason_code: 'no_evidence_found',
            reason: 'The knowledge base has nothing on where this came from.',
          },
      {
        quote: GENERIC_CLAIMS.revisions,
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'No indexed source counts the revisions.',
      },
    ]
    if (top) byKey.set('__top', top)
  }
  const findings: Finding[] = []
  for (const f of raw) {
    const start = text.indexOf(f.quote)
    if (start < 0) continue
    const evidence = (f.evidence ?? []).flatMap((e) => {
      const chunk = byKey.get(e.key)
      return chunk ? [evidenceOf(session, chunk, e.excerpt)] : []
    })
    // Without the cited evidence in this turn's index, a contradiction can only be "unverifiable".
    const grounded = f.verdict === 'contradicted' && evidence.length > 0 && Boolean(f.correction)
    const verdict = f.verdict === 'contradicted' && !grounded ? 'unverifiable' : f.verdict
    findings.push({
      id: uid('finding'),
      quote: f.quote,
      start_utf16: start,
      end_utf16: start + f.quote.length,
      verdict,
      highlight: verdict === 'contradicted' ? 'red' : 'yellow',
      reason_code: verdict === f.verdict ? f.reason_code : 'no_evidence_found',
      reason: verdict === f.verdict ? f.reason : 'No indexed source covers this claim.',
      correction: verdict === f.verdict ? (f.correction ?? null) : null,
      evidence: verdict === f.verdict ? evidence : [],
    })
  }
  return findings.sort((a, b) => a.start_utf16 - b.start_utf16)
}

function analyze(session: MSession, turn: MTurn): AnalysisResult {
  const outcome = turn.plan.outcome
  if (outcome === 'check_fail') {
    return {
      status: 'failed',
      termination_reason: 'error',
      tool_calls_used: 3,
      findings: [],
      warnings: ['Verification failed: ValidationError'],
    }
  }
  const text = turn.answers.baseline.text
  const claims = Math.min(20, text.split(/(?<=[.!?])\s+/).filter(Boolean).length + 1)
  let findings = resolveFindings(session, turn)
  const partial = outcome === 'check_partial'
  if (partial) findings = findings.slice(0, Math.max(0, findings.length - 1))
  const lookups = new Set(findings.flatMap((f) => f.evidence.map((e) => e.chunk_id))).size
  return {
    session_id: session.id,
    turn_id: turn.id,
    child_session_id: turn.answers.baseline.child_id,
    message_id: turn.answers.baseline.id,
    answer_text_sha256: digest(text),
    index_version_id: turn.index_version,
    status: partial ? 'partial' : 'completed',
    tool_calls_used: partial ? 10 : Math.min(10, 1 + lookups + Math.ceil(findings.length / 2)),
    termination_reason: partial ? 'tool_limit' : 'answered',
    coverage: {
      claims_extracted: claims,
      claims_checked: partial ? Math.max(0, claims - 2) : claims,
      extraction_truncated: false,
      unchecked_block_ids: partial ? ['b_0'] : [],
    },
    findings,
    warnings: partial ? ['Evidence response budget reached; coverage may be incomplete'] : [],
  } as AnalysisResult
}

// ---------- Simulation ----------

function emit(turn: MTurn, channel: MEvent['channel'], type: string, payload: Record<string, unknown>) {
  turn.event_sequence += 1
  turn.events.push({ event_id: turn.event_sequence, channel, type, payload, created: Date.now() })
  dirty = true
  progress++
}

function finishLane(turn: MTurn, lane: 'rag' | 'baseline', status: LaneState, warnings: string[] = []) {
  const answer = turn.answers[lane]
  answer.status = status
  answer.text_hash = digest(answer.text)
  if (lane === 'rag') {
    const markers = new Set([...answer.text.matchAll(/\[(c_[A-Za-z0-9_]+)\]/g)].map((m) => m[1]))
    answer.citations = turn.plan.ragCitations.filter((c) => markers.has(c.chunk_id))
    if (status === 'completed' && turn.plan.ragCitations.length && !markers.size) warnings.push('missing_citation_markers')
  }
  answer.warnings = warnings
  turn[`${lane}_state`] = status
  emit(turn, lane, 'answer.' + status, {
    message_id: answer.id,
    text: answer.text,
    answer_text_sha256: answer.text_hash,
    citations: answer.citations,
    finish_status: status,
    warnings,
  })
}

function streamLane(turn: MTurn, lane: 'rag' | 'baseline') {
  const plan = turn.plan
  const list = lane === 'rag' ? plan.rag : plan.baseline
  const pos = lane === 'rag' ? plan.ragPos : plan.basePos
  const failAt = lane === 'rag' ? plan.ragFailAt : plan.baseFailAt
  if (failAt !== null && pos >= failAt) return finishLane(turn, lane, 'failed', ['Answer failed: ServerError'])
  if (pos >= list.length) return finishLane(turn, lane, 'completed')
  const answer = turn.answers[lane]
  answer.text += list[pos]
  if (lane === 'rag') plan.ragPos++
  else plan.basePos++
  emit(turn, lane, 'answer.delta', { message_id: answer.id, text: list[pos] })
}

function stepTurn(turn: MTurn) {
  const plan = turn.plan
  if (turn.cancelled) return
  if (!plan.started) {
    plan.started = true
    for (const lane of ['rag', 'baseline'] as const) {
      turn[`${lane}_state`] = 'running'
      turn.answers[lane].status = 'running'
      emit(turn, lane, 'answer.started', { message_id: turn.answers[lane].id })
    }
    return
  }
  if (turn.baseline_state === 'running') streamLane(turn, 'baseline')
  if (turn.rag_state === 'running') {
    if (plan.ragDelay > 0) {
      plan.ragDelay--
      dirty = true
      progress++
    } else streamLane(turn, 'rag')
  }
}

function answersDone(turn: MTurn) {
  return LANE_TERMINAL.has(turn.rag_state) && LANE_TERMINAL.has(turn.baseline_state)
}

function settle(turn: MTurn) {
  if (turn.settled || !answersDone(turn) || !ANALYSIS_TERMINAL.has(turn.analysis_state)) return
  turn.settled = true
  emit(turn, 'system', 'turn.settled', {
    rag: turn.rag_state,
    baseline: turn.baseline_state,
    analysis: turn.analysis_state,
  })
}

/** One verification at a time per session, strictly in turn order. */
function stepVerifier(session: MSession) {
  const running = session.turns.find((t) => t.analysis_state === 'running')
  if (running) {
    running.plan.checkElapsed++
    dirty = true
    progress++
    if (running.plan.checkElapsed < running.plan.checkTicks) return
    const result = analyze(session, running)
    running.analysis = result
    running.analysis_state = result.status
    running.verifier = {
      input: JSON.stringify({
        question: running.user_message.text,
        baseline_answer: running.answers.baseline.text,
        message_id: running.answers.baseline.id,
        index_version_id: running.index_version,
      }),
      output: JSON.stringify(result),
      valid: result.status === 'failed' ? 0 : 1,
    }
    emit(running, 'analysis', result.status === 'failed' ? 'analysis.failed' : 'analysis.completed', {
      ...result,
    })
    settle(running)
    return
  }
  const next = [...session.turns].sort((a, b) => a.sequence - b.sequence).find((t) => t.analysis_state === 'pending')
  if (!next || !answersDone(next)) return
  if (next.cancelled || next.baseline_state !== 'completed') {
    next.analysis_state = 'skipped'
    emit(next, 'analysis', 'analysis.skipped', { reason: 'baseline_incomplete_or_cancelled' })
    settle(next)
    return
  }
  next.analysis_state = 'running'
  next.plan.checkElapsed = 0
  emit(next, 'analysis', 'analysis.started', {})
}

function stepSources(session: MSession) {
  for (const source of session.sources) {
    if (source.status !== 'processing' || source.deleted || source.readyAt === null || Date.now() < source.readyAt) continue
    source.readyAt = null
    source.attempts++
    progress++
    if (source.failFirst && source.attempts === 1) {
      source.status = 'failed'
      source.error = 'No extractable text found (simulated failure; retry succeeds).'
    } else {
      source.status = 'ready'
      for (const item of source.pending) session.chunks.push({ id: uid('c'), sourceId: source.id, ...item })
      source.pending = []
      publish(session)
    }
    dirty = true
  }
}

function tick() {
  const rounds = speed() === 'instant' ? 5000 : 1
  for (let round = 0; round < rounds; round++) {
    const before = progress
    for (const session of state.sessions) {
      stepSources(session)
      for (const turn of session.turns) if (!answersDone(turn)) stepTurn(turn)
      stepVerifier(session)
    }
    if (progress === before) break
  }
  if (dirty) save()
}

function restartClock() {
  window.clearInterval(timer)
  timer = window.setInterval(tick, TICK_MS[speed()])
}

// ---------- Seeding ----------

function addCorpus(session: MSession, corpus: CorpusSource[]) {
  for (const source of corpus) {
    const id = uid('source')
    session.sources.push({
      id,
      title: source.title,
      kind: 'file',
      status: 'ready',
      warnings: [],
      error: null,
      deleted: false,
      inputHash: digest(source.title),
      readyAt: null,
      attempts: 1,
      failFirst: false,
      pending: [],
    })
    for (const chunk of source.chunks) session.chunks.push({ id: uid('c'), sourceId: id, ...chunk })
  }
  publish(session)
}

function newSession(owner: string, title: string, created = Date.now()): MSession {
  return {
    id: uid('session'),
    owner,
    title,
    created,
    activeIndex: null,
    children: (['rag', 'baseline', 'verifier'] as const).map((role) => ({ id: uid('child'), role })),
    sources: [],
    chunks: [],
    snapshots: [],
    attachments: [],
    turns: [],
  }
}

function seed(): MState {
  const user = { id: uid('user'), email: DEMO_EMAIL, password: DEMO_PASSWORD }
  state = {
    version: 1,
    users: [user],
    currentUser: null,
    sessions: [],
    settings: { speed: 'normal', outcome: 'normal', firecrawl: true },
  }
  for (const entry of SEED) {
    const created = Date.now() - entry.daysAgo * DAY - 25 * 60_000
    const session = newSession(user.id, entry.title, created)
    state.sessions.push(session)
    addCorpus(session, entry.corpus)
    entry.questions.forEach((text, i) => {
      const turn = createTurn(session, { request_id: uid('seed'), text, attachment_ids: [] }, 'normal')
      for (let n = 0; n < 5000 && !turn.settled; n++) {
        if (!answersDone(turn)) stepTurn(turn)
        stepVerifier(session)
      }
      const at = created + (i + 1) * 90_000
      turn.created = at / 1000
      turn.events.forEach((e) => (e.created = at))
    })
    session.created = created
  }
  return state
}

// ---------- Turns ----------

function newAnswer(session: MSession, turnId: string, lane: 'rag' | 'baseline'): MAnswer {
  return {
    id: uid('message'),
    child_id: session.children.find((c) => c.role === lane)!.id,
    turn_id: turnId,
    lane,
    text: '',
    status: 'pending',
    citations: [],
    text_hash: null,
    warnings: [],
  }
}

interface TurnBody {
  request_id: string
  text: string
  attachment_ids: string[]
}

function createTurn(session: MSession, body: TurnBody, outcome: Outcome) {
  const id = uid('turn')
  const turn: MTurn = {
    id,
    session_id: session.id,
    sequence: session.turns.reduce((n, t) => Math.max(n, t.sequence), 0) + 1,
    request_id: body.request_id,
    payload_hash: digest(JSON.stringify(body)),
    index_version: session.activeIndex,
    user_message: { id: uid('user_message'), text: body.text, attachments: body.attachment_ids },
    rag_state: 'pending',
    baseline_state: 'pending',
    analysis_state: 'pending',
    created: Date.now() / 1000,
    cancelled: 0,
    event_sequence: 0,
    answers: { rag: newAnswer(session, id, 'rag'), baseline: newAnswer(session, id, 'baseline') },
    analysis: null,
    verifier: null,
    events: [],
    settled: false,
    plan: undefined as unknown as Plan,
  }
  turn.plan = buildPlan(session, turn, outcome)
  session.turns.push(turn)
  emit(turn, 'analysis', 'analysis.queued', {})
  return turn
}

function cancelTurn(turn: MTurn) {
  turn.cancelled = 1
  for (const lane of ['rag', 'baseline'] as const) {
    if (!LANE_TERMINAL.has(turn[`${lane}_state`])) {
      const answer = turn.answers[lane]
      answer.status = 'cancelled'
      answer.text_hash = digest(answer.text)
      turn[`${lane}_state`] = 'cancelled'
      emit(turn, lane, 'answer.cancelled', { message_id: answer.id, text: answer.text, finish_status: 'cancelled' })
    }
  }
  if (turn.analysis_state === 'running') {
    turn.analysis_state = 'failed'
    turn.analysis = { status: 'failed', termination_reason: 'error', findings: [], warnings: ['cancelled'] }
    emit(turn, 'analysis', 'analysis.failed', { reason: 'cancelled' })
  } else if (turn.analysis_state === 'pending') {
    turn.analysis_state = 'skipped'
    emit(turn, 'analysis', 'analysis.skipped', { reason: 'cancelled' })
  }
  settle(turn)
}

function savedTurn(turn: MTurn) {
  return {
    id: turn.id,
    session_id: turn.session_id,
    sequence: turn.sequence,
    request_id: turn.request_id,
    payload_hash: turn.payload_hash,
    index_version: turn.index_version,
    user_message_id: turn.user_message.id,
    rag_state: turn.rag_state,
    baseline_state: turn.baseline_state,
    analysis_state: turn.analysis_state,
    created: turn.created,
    cancelled: turn.cancelled,
    event_sequence: turn.event_sequence,
    user_message: { ...turn.user_message, session_id: turn.session_id },
    answers: [turn.answers.rag, turn.answers.baseline].map((a) => ({ ...a, session_id: turn.session_id })),
    analysis: turn.analysis,
  }
}

// ---------- HTTP ----------

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function publicSources(session: MSession) {
  return session.sources
    .filter((s) => !s.deleted)
    .map(({ id, title, kind, status, warnings, error }) => ({ id, title, kind, status, warnings, error }))
}

function requireUser() {
  const user = state.users.find((u) => u.id === state.currentUser)
  if (!user) throw new HttpError(401, 'unauthenticated', 'Login required')
  return user
}

function requireSession(id: string) {
  requireUser()
  const session = sessionById(id)
  if (!session) throw new HttpError(404, 'not_found', 'Session not found')
  return session
}

function requireTurn(session: MSession, id: string) {
  const turn = session.turns.find((t) => t.id === id)
  if (!turn) throw new HttpError(404, 'not_found', 'Turn not found')
  return turn
}

function invalid(): never {
  throw new HttpError(422, 'invalid_input', 'Invalid request fields')
}

function fields<T extends Record<string, unknown>>(body: unknown, allowed: string[]): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid()
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalid()
  return body as T
}

function title(body: unknown) {
  const { title = 'New comparison' } = fields<{ title?: unknown }>(body ?? {}, ['title'])
  if (typeof title !== 'string' || title.length < 1 || title.length > 200) invalid()
  return title
}

const SUPPORTED = ['.pdf', '.docx', '.pptx', '.md']

async function fileChunks(file: File, extension: string) {
  const name = file.name.replace(/\.[^.]+$/, '')
  const warnings: SourceWarning[] = []
  const chunks: MSource['pending'] = []
  if (extension === '.md') {
    const lines = (await file.text()).split('\n')
    let heading = ''
    let start = -1
    const flush = (end: number) => {
      if (start < 0) return
      const text = lines.slice(start, end).join('\n').trim()
      if (text) chunks.push({ text, locator: { heading, line_start: start + 1, line_end: end } })
      start = -1
    }
    lines.forEach((line, i) => {
      if (/^#{1,6}\s/.test(line)) {
        flush(i)
        heading = line.replace(/^#+\s*/, '').trim()
      } else if (!line.trim()) flush(i)
      else if (start < 0) start = i
    })
    flush(lines.length)
  } else {
    const note = 'Mock mode does not parse binary documents; this stands in for the extracted text.'
    if (extension === '.pdf') {
      for (const page of [1, 2]) chunks.push({ text: `${name}, page ${page}. ${note}`, locator: { page } })
      warnings.push({ page: 3, code: 'no_extractable_text', message: 'Page not indexed' })
    } else if (extension === '.docx') {
      for (const paragraph of [1, 2])
        chunks.push({ text: `${name}, paragraph ${paragraph}. ${note}`, locator: { heading: name, paragraph } })
      warnings.push({
        code: 'office_extraction_scope',
        message: 'Body text/tables indexed; images, headers and embedded objects not interpreted',
      })
    } else {
      for (const slide of [1, 2])
        chunks.push({ text: `${name}, slide ${slide}. ${note}`, locator: { slide, element: 1 } })
      warnings.push({
        code: 'office_extraction_scope',
        message: 'Text/tables indexed; images, charts, notes and grouped objects not interpreted',
      })
    }
  }
  return { chunks, warnings }
}

function indexingDelay() {
  return speed() === 'instant' ? 0 : speed() === 'fast' ? 600 : speed() === 'slow' ? 4500 : 2000
}

function addSource(session: MSession, source: Omit<MSource, 'id' | 'status' | 'deleted' | 'error' | 'readyAt' | 'attempts'>) {
  if (session.sources.filter((s) => !s.deleted).length >= 100)
    throw new HttpError(429, 'source_limit', 'Session source limit (100) reached')
  const duplicate = session.sources.find(
    (s) => !s.deleted && s.inputHash === source.inputHash && s.status !== 'failed',
  )
  if (duplicate) return { source_id: duplicate.id, status: duplicate.status, deduplicated: true }
  const created: MSource = {
    ...source,
    id: uid('source'),
    status: 'processing',
    deleted: false,
    error: null,
    readyAt: Date.now() + indexingDelay(),
    attempts: 0,
  }
  session.sources.push(created)
  return { source_id: created.id, status: 'processing' }
}

function eventStream(session: MSession, turn: MTurn, last: number, signal?: AbortSignal | null) {
  const encoder = new TextEncoder()
  let interval: number | undefined
  let connection: { drop: () => void } | undefined
  const stop = () => {
    window.clearInterval(interval)
    if (connection) connections.delete(connection)
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = last
      let heartbeat = Date.now()
      const fail = (error: unknown) => {
        stop()
        try {
          controller.error(error)
        } catch {
          // Already closed.
        }
      }
      connection = { drop: () => fail(new TypeError('Mock connection dropped')) }
      connections.add(connection)
      signal?.addEventListener('abort', () => fail(new DOMException('Aborted', 'AbortError')), { once: true })
      const poll = () => {
        const current = state.currentUser === session.owner && sessionById(session.id)?.turns.find((t) => t.id === turn.id)
        if (!current) {
          stop()
          return controller.close()
        }
        const batch = current.events.filter((e) => e.event_id > cursor).slice(0, 50)
        for (const event of batch) {
          cursor = event.event_id
          const value = {
            event_id: event.event_id,
            session_id: session.id,
            turn_id: turn.id,
            channel: event.channel,
            type: event.type,
            payload: event.payload,
          }
          controller.enqueue(encoder.encode(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(value)}\n\n`))
        }
        if (batch.length) return
        if (answersDone(current) && ANALYSIS_TERMINAL.has(current.analysis_state)) {
          stop()
          return controller.close()
        }
        if (Date.now() - heartbeat >= 15_000) {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
          heartbeat = Date.now()
        }
      }
      interval = window.setInterval(poll, 80)
      poll()
    },
    cancel: stop,
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}

type Handler = (match: string[], request: { body: unknown; init?: RequestInit }) => Promise<Response> | Response

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/health$/, () => json(200, { status: 'ok' })],

  [
    'POST',
    /^\/auth\/register$/,
    (_, { body }) => {
      const { email, password } = fields<{ email: unknown; password: unknown }>(body, ['email', 'password'])
      if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) invalid()
      if (typeof password !== 'string' || password.length < 15 || password.length > 128) invalid()
      const normalized = email.trim().toLowerCase()
      if (state.users.some((u) => u.email === normalized))
        throw new HttpError(409, 'registration_failed', 'Registration could not be completed')
      const user = { id: uid('user'), email: normalized, password }
      state.users.push(user)
      return json(201, { user_id: user.id })
    },
  ],
  [
    'POST',
    /^\/auth\/login$/,
    (_, { body }) => {
      const { email, password } = fields<{ email: unknown; password: unknown }>(body, ['email', 'password'])
      if (typeof email !== 'string' || typeof password !== 'string') invalid()
      const user = state.users.find((u) => u.email === email.trim().toLowerCase() && u.password === password)
      if (!user) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password')
      state.currentUser = user.id
      return json(200, { user_id: user.id })
    },
  ],
  [
    'POST',
    /^\/auth\/logout$/,
    () => {
      requireUser()
      state.currentUser = null
      return json(200, { status: 'logged_out' })
    },
  ],
  [
    'GET',
    /^\/auth\/me$/,
    () => {
      const user = requireUser()
      return json(200, { user_id: user.id, email: user.email })
    },
  ],

  [
    'POST',
    /^\/sessions$/,
    (_, { body }) => {
      const user = requireUser()
      const session = newSession(user.id, title(body))
      state.sessions.push(session)
      return json(201, { id: session.id, children: session.children, active_index_version: null })
    },
  ],
  [
    'GET',
    /^\/sessions$/,
    () => {
      const user = requireUser()
      const sessions = state.sessions
        .filter((s) => s.owner === user.id)
        .sort((a, b) => b.created - a.created)
        .map((s) => {
          const findings = s.turns.flatMap((t) => t.analysis?.findings ?? [])
          return {
            id: s.id,
            title: s.title,
            active_index: s.activeIndex,
            created: s.created / 1000,
            updated: Math.max(s.created / 1000, ...s.turns.map((t) => t.created)),
            active: s.turns.some((t) => !answersDone(t)),
            contradicted: findings.filter((f) => f.verdict === 'contradicted').length,
            unverifiable: findings.filter((f) => f.verdict === 'unverifiable').length,
          }
        })
      return json(200, { sessions })
    },
  ],
  [
    'GET',
    /^\/sessions\/([^/]+)$/,
    ([id]) => {
      const session = requireSession(id)
      const turns = [...session.turns].sort((a, b) => a.sequence - b.sequence).slice(-50)
      return json(200, {
        id: session.id,
        title: session.title,
        active_index_version: session.activeIndex,
        children: session.children,
        turns: turns.map(savedTurn),
        verifier_history: turns.filter((t) => t.verifier).map((t) => ({ turn_id: t.id, ...t.verifier })),
        sources: publicSources(session),
        next_before_sequence: null,
      })
    },
  ],
  [
    'PATCH',
    /^\/sessions\/([^/]+)$/,
    ([id], { body }) => {
      const session = requireSession(id)
      session.title = title(body)
      return json(200, { id, title: session.title })
    },
  ],
  [
    'DELETE',
    /^\/sessions\/([^/]+)$/,
    ([id]) => {
      requireSession(id)
      state.sessions = state.sessions.filter((s) => s.id !== id)
      return json(200, { status: 'deleted' })
    },
  ],

  ['GET', /^\/sessions\/([^/]+)\/sources$/, ([id]) => json(200, { sources: publicSources(requireSession(id)) })],
  [
    'POST',
    /^\/sessions\/([^/]+)\/sources\/files$/,
    async ([id], { body }) => {
      const session = requireSession(id)
      const file = body instanceof FormData ? body.get('file') : null
      if (!(file instanceof File)) invalid()
      const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      if (!SUPPORTED.includes(extension))
        throw new HttpError(415, 'unsupported_type', 'Only PDF, DOCX, PPTX and Markdown are supported')
      if (file.size > 25 * 1024 * 1024) throw new HttpError(413, 'upload_too_large', 'Upload exceeds size limit')
      const head = await file.slice(0, 5).text()
      if (
        !file.size ||
        (extension === '.pdf' && !head.startsWith('%PDF-')) ||
        ((extension === '.docx' || extension === '.pptx') && !head.startsWith('PK'))
      )
        throw new HttpError(422, 'invalid_file', 'File content does not match supported format')
      const { chunks, warnings } = await fileChunks(file, extension)
      if (!chunks.length) throw new HttpError(422, 'invalid_file', 'No extractable text')
      return json(
        202,
        addSource(session, {
          title: file.name.slice(0, 200),
          kind: 'file',
          warnings,
          inputHash: digest(`${file.name}:${file.size}:${file.lastModified}`),
          failFirst: /fail/i.test(file.name),
          pending: chunks,
        }),
      )
    },
  ],
  [
    'POST',
    /^\/sessions\/([^/]+)\/sources\/websites$/,
    ([id], { body }) => {
      const session = requireSession(id)
      const { url, include_paths = [] } = fields<{ url: unknown; include_paths?: unknown }>(body, ['url', 'include_paths'])
      if (typeof url !== 'string' || url.length > 2048 || !Array.isArray(include_paths) || include_paths.length > 20)
        invalid()
      if (!state.settings.firecrawl)
        throw new HttpError(503, 'firecrawl_unavailable', 'Configure Firecrawl with public fetch restrictions', true)
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new HttpError(422, 'unsafe_url', 'Public HTTP(S) URL required')
      }
      if (
        !/^https?:$/.test(parsed.protocol) ||
        /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(parsed.hostname)
      )
        throw new HttpError(422, 'unsafe_url', 'Public HTTP(S) URL required')
      const base = parsed.origin + parsed.pathname.replace(/\/$/, '')
      const pages = ['', '/about', '/docs'].map((path, i) => ({
        text: `${parsed.hostname}${path || '/'}: page ${i + 1} of a simulated crawl. Mock mode does not fetch websites.`,
        locator: { url: base + path, title: `${parsed.hostname} ${path || 'home'}`, fetched_at: Date.now() / 1000 },
      }))
      return json(
        202,
        addSource(session, {
          title: url,
          kind: 'website',
          warnings: [{ code: 'skipped_url', url: base + '/brochure.pdf' }],
          inputHash: digest(JSON.stringify({ url, include_paths })),
          failFirst: false,
          pending: pages,
        }),
      )
    },
  ],
  [
    'POST',
    /^\/sessions\/([^/]+)\/sources\/([^/]+)\/retry$/,
    ([id, sourceId]) => {
      const session = requireSession(id)
      const source = session.sources.find((s) => s.id === sourceId && !s.deleted)
      if (!source) throw new HttpError(404, 'not_found', 'Source not found')
      if (source.status !== 'failed') throw new HttpError(409, 'source_not_failed', 'Only failed sources can be retried')
      source.status = 'processing'
      source.error = null
      source.readyAt = Date.now() + indexingDelay()
      return json(202, { source_id: sourceId, status: 'processing' })
    },
  ],
  [
    'DELETE',
    /^\/sessions\/([^/]+)\/sources\/([^/]+)$/,
    ([id, sourceId]) => {
      const session = requireSession(id)
      const source = session.sources.find((s) => s.id === sourceId && !s.deleted)
      if (!source) throw new HttpError(404, 'not_found', 'Source not found')
      source.deleted = true
      publish(session)
      return json(200, { status: 'deleted' })
    },
  ],

  [
    'POST',
    /^\/sessions\/([^/]+)\/attachments$/,
    async ([id], { body }) => {
      const session = requireSession(id)
      const file = body instanceof FormData ? body.get('file') : null
      if (!(file instanceof File)) invalid()
      if (file.size > 10 * 1024 * 1024) throw new HttpError(413, 'upload_too_large', 'Upload exceeds size limit')
      let size = { width: 0, height: 0 }
      try {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('type')
        const bitmap = await createImageBitmap(file)
        size = { width: bitmap.width, height: bitmap.height }
        bitmap.close()
      } catch {
        throw new HttpError(422, 'invalid_image', 'Valid single-frame JPEG/PNG/WebP within pixel limit required')
      }
      const attachment = { id: uid('attachment'), mime: file.type, ...size }
      session.attachments.push(attachment)
      return json(201, { attachment_id: attachment.id, mime: attachment.mime, ...size })
    },
  ],

  [
    'POST',
    /^\/sessions\/([^/]+)\/turns$/,
    ([id], { body }) => {
      const session = requireSession(id)
      const input = fields<{ request_id?: unknown; text?: unknown; attachment_ids?: unknown }>(body, [
        'request_id',
        'text',
        'attachment_ids',
      ])
      const submitted: TurnBody = {
        request_id: input.request_id as string,
        text: (input.text ?? '') as string,
        attachment_ids: (input.attachment_ids ?? []) as string[],
      }
      if (
        typeof submitted.request_id !== 'string' ||
        !submitted.request_id ||
        submitted.request_id.length > 100 ||
        typeof submitted.text !== 'string' ||
        submitted.text.length > 16000 ||
        !Array.isArray(submitted.attachment_ids) ||
        submitted.attachment_ids.length > 4 ||
        new Set(submitted.attachment_ids).size !== submitted.attachment_ids.length ||
        (!submitted.text.trim() && !submitted.attachment_ids.length)
      )
        invalid()
      let turn = session.turns.find((t) => t.request_id === submitted.request_id)
      if (turn) {
        if (turn.payload_hash !== digest(JSON.stringify(submitted)))
          throw new HttpError(409, 'turn_conflict', 'request_id was used for different content')
      } else {
        if (session.turns.some((t) => !answersDone(t)))
          throw new HttpError(409, 'turn_conflict', 'an answering turn is already active')
        if (submitted.attachment_ids.some((a) => !session.attachments.some((x) => x.id === a)))
          throw new HttpError(404, 'not_found', 'Attachment not found in session')
        turn = createTurn(session, submitted, state.settings.outcome)
      }
      return json(202, {
        session_id: session.id,
        turn_id: turn.id,
        index_version_id: turn.index_version,
        processing_source_ids: session.sources.filter((s) => s.status === 'processing' && !s.deleted).map((s) => s.id),
        events_url: `/sessions/${session.id}/turns/${turn.id}/events`,
      })
    },
  ],
  ['GET', /^\/sessions\/([^/]+)\/turns\/([^/]+)$/, ([id, turnId]) => json(200, savedTurn(requireTurn(requireSession(id), turnId)))],
  [
    'POST',
    /^\/sessions\/([^/]+)\/turns\/([^/]+)\/cancel$/,
    ([id, turnId]) => {
      cancelTurn(requireTurn(requireSession(id), turnId))
      return json(200, { status: 'cancelled' })
    },
  ],
  [
    'POST',
    /^\/sessions\/([^/]+)\/turns\/([^/]+)\/analysis\/retry$/,
    ([id, turnId]) => {
      const session = requireSession(id)
      const turn = requireTurn(session, turnId)
      if (turn.baseline_state !== 'completed' || turn.cancelled || !ANALYSIS_TERMINAL.has(turn.analysis_state))
        throw new HttpError(409, 'analysis_conflict', 'Completed baseline and terminal analysis required')
      if (session.turns.some((t) => t.analysis_state === 'pending' || t.analysis_state === 'running'))
        throw new HttpError(409, 'analysis_conflict', 'Wait for queued verification before retrying')
      // The retry uses the outcome selected now, so a failed check can be retried into a clean one.
      turn.plan.outcome = state.settings.outcome === 'rag_fail' || state.settings.outcome === 'baseline_fail' ? 'normal' : state.settings.outcome
      turn.plan.checkTicks = turn.plan.outcome === 'slow_check' ? 320 : 45
      turn.analysis_state = 'pending'
      turn.settled = false
      emit(turn, 'analysis', 'analysis.queued', { retry: true })
      return json(202, { status: 'pending', turn_id: turnId })
    },
  ],
  [
    'GET',
    /^\/sessions\/([^/]+)\/turns\/([^/]+)\/events$/,
    ([id, turnId], { init }) => {
      const session = requireSession(id)
      const turn = requireTurn(session, turnId)
      const header = new Headers(init?.headers).get('last-event-id') ?? '0'
      const last = Number(header)
      if (!Number.isInteger(last) || last < 0)
        throw new HttpError(422, 'invalid_event_id', 'Nonnegative Last-Event-ID required')
      const cutoff = Date.now() - DAY
      for (const s of state.sessions) for (const t of s.turns) t.events = t.events.filter((e) => e.created >= cutoff)
      const first = turn.events[0]?.event_id
      if ((turn.created * 1000 < cutoff && last === 0) || (first && last < first - 1))
        throw new HttpError(410, 'replay_expired', 'Fetch saved turn state; event replay expired')
      if (last > turn.event_sequence) throw new HttpError(422, 'invalid_event_id', 'Last-Event-ID is beyond this turn')
      return eventStream(session, turn, last, init?.signal)
    },
  ],
]

function latency() {
  if (speed() === 'instant') return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 90))
}

export const mockFetch: Transport = async (input, init) => {
  await latency()
  const method = (init?.method ?? 'GET').toUpperCase()
  const url = new URL(input, window.location.origin)
  const base = new URL(API_BASE, window.location.origin).pathname.replace(/\/$/, '')
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname
  let body: unknown = init?.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return json(422, { code: 'invalid_input', message: 'Invalid request fields', retryable: false })
    }
  }
  try {
    for (const [verb, pattern, handler] of routes) {
      const match = path.match(pattern)
      if (match && verb === method) {
        const response = await handler(match.slice(1), { body, init })
        save()
        return response
      }
    }
    return json(404, { code: 'not_found', message: 'Not Found', retryable: false })
  } catch (error) {
    if (error instanceof HttpError) {
      save()
      return json(error.status, { code: error.code, message: error.message, retryable: error.retryable })
    }
    throw error
  }
}

// ---------- Developer controls ----------

export function startMock() {
  if (timer !== undefined) return
  state = load() ?? seed()
  save()
  restartClock()
}

export const controls = {
  settings: (): MockSettings => ({ ...state.settings }),
  update(next: Partial<MockSettings>) {
    state.settings = { ...state.settings, ...next }
    save()
    if (next.speed) restartClock()
  },
  status() {
    const sessions = state.sessions.filter((s) => s.owner === state.currentUser)
    return {
      loggedIn: Boolean(state.currentUser),
      streams: connections.size,
      activeTurns: sessions.reduce((n, s) => n + s.turns.filter((t) => !t.settled && !(answersDone(t) && ANALYSIS_TERMINAL.has(t.analysis_state))).length, 0),
      processing: sessions.reduce((n, s) => n + s.sources.filter((x) => x.status === 'processing' && !x.deleted).length, 0),
    }
  },
  /** Errors every open stream so the client reconnects with Last-Event-ID. */
  dropStreams() {
    const open = [...connections]
    open.forEach((c) => c.drop())
    return open.length
  },
  /** Deletes the replayable event log; reconnecting streams receive 410 and fall back to saved state. */
  expireReplay() {
    for (const session of state.sessions) for (const turn of session.turns) turn.events = []
    save()
    return this.dropStreams()
  },
  /** Mirrors backend startup recovery: interrupted work fails without events, streams disconnect. */
  simulateRestart() {
    for (const session of state.sessions) {
      for (const source of session.sources)
        if (source.status === 'processing') Object.assign(source, { status: 'failed', error: 'interrupted', readyAt: null })
      for (const turn of session.turns) {
        for (const lane of ['rag', 'baseline'] as const) {
          if (!LANE_TERMINAL.has(turn[`${lane}_state`])) {
            turn[`${lane}_state`] = 'failed'
            turn.answers[lane].status = 'failed'
            turn.answers[lane].warnings = ['interrupted']
          }
        }
        if (turn.analysis_state === 'pending' || turn.analysis_state === 'running') turn.analysis_state = 'failed'
      }
    }
    save()
    return this.dropStreams()
  },
  loginDemo() {
    const demo = state.users.find((u) => u.email === DEMO_EMAIL)
    if (demo) state.currentUser = demo.id
    save()
  },
  reset() {
    window.clearInterval(timer)
    timer = undefined
    connections.forEach((c) => c.drop())
    try {
      localStorage.removeItem(STORAGE)
    } catch {
      // Nothing stored.
    }
  },
}

export const demoCredentials = { email: DEMO_EMAIL, password: DEMO_PASSWORD }
