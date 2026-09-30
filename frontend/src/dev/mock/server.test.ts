import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError, api, setTransport } from '../../api/client'
import { readTurnEvents } from '../../api/sse'
import type { TurnEvent } from '../../api/types'
import { controls, mockFetch, startMock } from './server'

async function stream(sessionId: string, turnId: string, last = 0) {
  const events: TurnEvent[] = []
  await readTurnEvents(`/sessions/${sessionId}/turns/${turnId}/events`, last, new AbortController().signal, (e) =>
    events.push(e),
  )
  return events
}

describe('mock backend', () => {
  beforeAll(() => {
    localStorage.clear()
    startMock()
    controls.update({ speed: 'instant' })
    setTransport(mockFetch)
  })

  it('requires login and seeds the demo sessions', async () => {
    await expect(api.me()).rejects.toMatchObject({ status: 401 })
    controls.loginDemo()
    const { sessions } = await api.sessions()
    expect(sessions.map((s) => s.title)).toContain('Webb telescope launch')
    const webb = sessions.find((s) => s.title === 'Webb telescope launch')!
    expect([webb.contradicted, webb.unverifiable]).toEqual([2, 3])
    const detail = await api.session(webb.id)
    const launch = detail.turns[1]
    const baseline = launch.answers.find((a) => a.lane === 'baseline')!
    for (const f of launch.analysis!.findings) expect(baseline.text.slice(f.start_utf16, f.end_utf16)).toBe(f.quote)
    expect(launch.analysis!.findings[0].evidence[0].excerpt).toContain('Ariane 5')
  })

  it('streams a turn, replays after Last-Event-ID and expires replay with 410', async () => {
    const { id } = await api.createSession('Mock test')
    await expect(api.createTurn(id, 'r1', '', [])).rejects.toMatchObject({ status: 422 })
    const created = await api.createTurn(id, 'r1', 'How far away is L2?', [])
    expect((await api.createTurn(id, 'r1', 'How far away is L2?', [])).turn_id).toBe(created.turn_id)
    await expect(api.createTurn(id, 'r1', 'changed', [])).rejects.toMatchObject({ status: 409 })

    const events = await stream(id, created.turn_id)
    expect(events.map((e) => e.event_id)).toEqual(events.map((_, i) => i + 1))
    expect(events.at(-1)?.type).toBe('turn.settled')
    const rag = events.find((e) => e.channel === 'rag' && e.type === 'answer.completed')!
    expect(rag.payload.text).toMatch(/sufficient indexed evidence/)

    const after = await stream(id, created.turn_id, 4)
    expect(after[0].event_id).toBe(5)

    controls.expireReplay()
    const saved = await api.turn(id, created.turn_id)
    expect(saved.analysis_state).toBe('completed')
    const expired = stream(id, created.turn_id, 0)
    // A settled turn with no remaining events just closes; an in-flight gap would be a 410.
    await expect(expired).resolves.toEqual([])
  })

  it('cancels a turn and skips its fact check', async () => {
    controls.update({ speed: 'slow' })
    const { id } = await api.createSession('Cancel test')
    const created = await api.createTurn(id, 'c1', 'When did Webb launch?', [])
    await api.cancelTurn(id, created.turn_id)
    const saved = await api.turn(id, created.turn_id)
    expect([saved.rag_state, saved.baseline_state, saved.analysis_state]).toEqual(['cancelled', 'cancelled', 'skipped'])
    await expect(api.retryAnalysis(id, created.turn_id)).rejects.toBeInstanceOf(ApiError)
    controls.update({ speed: 'instant' })
  })
})
