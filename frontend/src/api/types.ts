// Shapes returned by the Factos backend (see backend/factos/api.py and docs/backend-spec.md).

export type LaneState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AnalysisState = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped'
export type Lane = 'rag' | 'baseline'
export type Locator = Record<string, string | number | null | undefined>

export interface User {
  user_id: string
  email: string
}

export interface SessionSummary {
  id: string
  title: string
  active_index: string | null
  created: number
  updated?: number
  contradicted?: number
  unverifiable?: number
  active?: boolean
}

export interface SourceWarning {
  code?: string
  message?: string
  page?: number
  slide?: number
  url?: string
}

export interface Source {
  id: string
  title: string
  kind: 'file' | 'website'
  status: 'processing' | 'ready' | 'failed'
  warnings: SourceWarning[]
  error: string | null
}

export interface Evidence {
  chunk_id: string
  source_id: string
  title: string
  locator: Locator
  excerpt: string
}

export interface Finding {
  id: string
  quote: string
  start_utf16: number
  end_utf16: number
  verdict: 'contradicted' | 'unverifiable'
  highlight: 'red' | 'yellow'
  reason_code: string
  reason: string
  correction: string | null
  evidence: Evidence[]
}

export interface Coverage {
  claims_extracted: number
  claims_checked: number
  extraction_truncated: boolean
  unchecked_block_ids: string[]
}

export interface AnalysisResult {
  status: AnalysisState
  findings: Finding[]
  warnings: string[]
  tool_calls_used?: number
  termination_reason?: 'answered' | 'tool_limit' | 'timeout' | 'error'
  coverage?: Coverage
  message_id?: string
  answer_text_sha256?: string
  index_version_id?: string | null
  reason?: string
}

export interface SavedAnswer {
  id: string
  child_id: string
  turn_id: string
  lane: Lane
  text: string
  status: LaneState
  citations: Evidence[]
  text_hash: string | null
  warnings: string[]
}

export interface SavedTurn {
  id: string
  session_id: string
  sequence: number
  request_id: string
  index_version: string | null
  rag_state: LaneState
  baseline_state: LaneState
  analysis_state: AnalysisState
  created: number
  cancelled: number
  event_sequence: number
  user_message: { id: string; text: string; attachments: string[] }
  answers: SavedAnswer[]
  analysis: AnalysisResult | null
}

export interface SessionDetail {
  id: string
  title: string
  active_index_version: string | null
  children: { id: string; role: string }[]
  turns: SavedTurn[]
  sources: Source[]
  next_before_sequence: number | null
}

export interface TurnCreated {
  session_id: string
  turn_id: string
  index_version_id: string | null
  processing_source_ids: string[]
  events_url: string
}

export interface TurnEvent {
  event_id: number
  session_id: string
  turn_id: string
  channel: 'rag' | 'baseline' | 'analysis' | 'system'
  type: string
  payload: Record<string, unknown>
}
