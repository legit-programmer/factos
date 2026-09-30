import { describe, expect, it } from 'vitest'
import { SseParser } from '../api/sse'
import type { TurnEvent } from '../api/types'
import { analysisMatchesAnswer, applyEvent, emptyLane, turnSettled, type TurnView } from './turns'

function turn(): TurnView {
  return {
    id: 'turn_1',
    sequence: 1,
    question: 'q',
    attachmentIds: [],
    created: 0,
    rag: emptyLane(),
    baseline: emptyLane(),
    analysisState: 'pending',
    analysis: null,
    analysisNote: null,
    processingSourceIds: [],
    cursor: 0,
  }
}

let id = 0
function ev(channel: TurnEvent['channel'], type: string, payload: Record<string, unknown> = {}): TurnEvent {
  return { event_id: ++id, session_id: 's', turn_id: 'turn_1', channel, type, payload }
}

describe('applyEvent', () => {
  it('builds both lanes from a replayed stream and ignores duplicates', () => {
    id = 0
    const events = [
      ev('analysis', 'analysis.queued'),
      ev('rag', 'answer.started', { message_id: 'm_r' }),
      ev('baseline', 'answer.started', { message_id: 'm_b' }),
      ev('baseline', 'answer.delta', { message_id: 'm_b', text: 'Five ' }),
      ev('baseline', 'answer.delta', { message_id: 'm_b', text: 'years.' }),
      ev('rag', 'answer.delta', { message_id: 'm_r', text: 'Two' }),
      ev('baseline', 'answer.completed', {
        message_id: 'm_b',
        text: 'Five years.',
        answer_text_sha256: 'h',
        citations: [],
        finish_status: 'completed',
        warnings: [],
      }),
      ev('rag', 'answer.completed', { message_id: 'm_r', text: 'Two years.', citations: [], finish_status: 'completed' }),
      ev('analysis', 'analysis.started'),
      ev('analysis', 'analysis.completed', {
        status: 'partial',
        findings: [],
        warnings: ['tool budget'],
        message_id: 'm_b',
        answer_text_sha256: 'h',
      }),
      ev('system', 'turn.settled', { rag: 'completed', baseline: 'completed', analysis: 'partial' }),
    ]
    let state = turn()
    for (const e of events) state = applyEvent(state, e)
    // Replaying the whole stream again must be a no-op.
    const again = events.reduce(applyEvent, state)
    expect(again).toBe(state)
    expect(state.baseline).toMatchObject({ text: 'Five years.', status: 'completed', hash: 'h' })
    expect(state.rag.text).toBe('Two years.')
    expect(state.analysisState).toBe('partial')
    expect(turnSettled(state)).toBe(true)
    expect(analysisMatchesAnswer(state)).toBe(true)
  })

  it('represents a bare analysis failure as a failed result', () => {
    id = 100
    const state = applyEvent(turn(), ev('analysis', 'analysis.failed', { reason: 'cancelled' }))
    expect(state.analysisState).toBe('failed')
    expect(state.analysis).toMatchObject({ status: 'failed', findings: [] })
  })

  it('detects spans computed for a different message text', () => {
    const state: TurnView = {
      ...turn(),
      baseline: { ...emptyLane('completed'), messageId: 'm', hash: 'new' },
      analysis: {
        status: 'completed',
        warnings: [],
        answer_text_sha256: 'old',
        message_id: 'm',
        findings: [
          {
            id: 'f',
            quote: 'x',
            start_utf16: 0,
            end_utf16: 1,
            verdict: 'unverifiable',
            highlight: 'yellow',
            reason_code: '',
            reason: '',
            correction: null,
            evidence: [],
          },
        ],
      },
    }
    expect(analysisMatchesAnswer(state)).toBe(false)
  })
})

describe('SseParser', () => {
  it('parses events split across chunks and skips heartbeats', () => {
    const seen: TurnEvent[] = []
    const parser = new SseParser((e) => seen.push(e))
    const payload = JSON.stringify({ event_id: 7, channel: 'rag', type: 'answer.delta', payload: { text: 'hi' } })
    parser.push(': heartbeat\n\nid: 7\nevent: answer.delta\nda')
    parser.push(`ta: ${payload}\r\n\r\n`)
    expect(seen).toHaveLength(1)
    expect(seen[0].event_id).toBe(7)
  })
})
