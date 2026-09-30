import { AlertCircle, Check } from 'lucide-react'
import { answersDone, type TurnView } from '../lib/turns'

type Tone = 'writing' | 'done' | 'waiting' | 'checking' | 'warn' | 'error'
export interface PillStatus {
  label: string
  tone: Tone
}

export function groundedStatus(turn: TurnView): PillStatus {
  switch (turn.rag.status) {
    case 'pending':
      return { label: 'Searching…', tone: 'waiting' }
    case 'running':
      return { label: 'Writing…', tone: 'writing' }
    case 'completed':
      return { label: 'Done', tone: 'done' }
    case 'failed':
      return { label: 'Failed', tone: 'error' }
    case 'cancelled':
      return { label: 'Stopped', tone: 'warn' }
  }
}

export function ungroundedStatus(turn: TurnView): PillStatus {
  const lane = turn.baseline.status
  if (lane === 'pending') return { label: 'Starting…', tone: 'waiting' }
  if (lane === 'running') return { label: 'Writing…', tone: 'writing' }
  if (lane === 'failed') return { label: 'Failed', tone: 'error' }
  if (lane === 'cancelled') return { label: 'Stopped', tone: 'warn' }
  switch (turn.analysisState) {
    case 'pending':
      return answersDone(turn)
        ? { label: 'Queued for check', tone: 'waiting' }
        : { label: 'Waiting to check', tone: 'waiting' }
    case 'running':
      return { label: 'Checking…', tone: 'checking' }
    case 'completed':
      return { label: 'Checked', tone: 'done' }
    case 'partial':
      return { label: 'Partly checked', tone: 'warn' }
    case 'failed':
      return { label: 'Check failed', tone: 'error' }
    case 'skipped':
      return { label: 'Not checked', tone: 'warn' }
  }
}

export function StatusPill({ lane, status }: { lane: 'rag' | 'baseline'; status: PillStatus }) {
  const { tone, label } = status
  return (
    <span className={`pill pill-${lane} pill-${tone}`} role="status">
      {tone === 'done' && <Check size={13} strokeWidth={2.2} />}
      {(tone === 'writing' || tone === 'checking' || tone === 'waiting') && <span className="pill-dot" />}
      {(tone === 'error' || tone === 'warn') && <AlertCircle size={13} strokeWidth={2} />}
      {label}
    </span>
  )
}
