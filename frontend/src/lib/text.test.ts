import { describe, expect, it } from 'vitest'
import type { Finding } from '../api/types'
import { dateLabel, deriveTitle, evidenceLabel, highlightSegments, parseRag } from './text'

function finding(text: string, quote: string, occurrence = 0, verdict: Finding['verdict'] = 'contradicted'): Finding {
  let start = -1
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(quote, start + 1)
  return {
    id: `f_${start}`,
    quote,
    start_utf16: start,
    end_utf16: start + quote.length,
    verdict,
    highlight: verdict === 'contradicted' ? 'red' : 'yellow',
    reason_code: 'x',
    reason: 'because',
    correction: null,
    evidence: [],
  }
}

describe('highlightSegments', () => {
  it('slices at UTF-16 offsets, including astral characters', () => {
    const text = 'The warranty 😀 lasts 5 years. It covers damage.'
    const f = finding(text, '5 years')
    const { segments, dropped } = highlightSegments(text, [f])
    expect(dropped).toBe(0)
    expect(segments.map((s) => s.text).join('')).toBe(text)
    expect(segments[1]).toMatchObject({ text: '5 years', index: 0 })
  })

  it('addresses a repeated quote by its exact offsets', () => {
    const text = 'two years. Then two years again.'
    const second = finding(text, 'two years', 1)
    const { segments } = highlightSegments(text, [second])
    expect(segments[0].text).toBe('two years. Then ')
    expect(segments[1].finding?.start_utf16).toBe(16)
  })

  it('drops overlapping or mismatched spans instead of guessing', () => {
    const text = 'Launched in 2021 from Kourou.'
    const a = finding(text, 'Launched in 2021')
    const b = { ...finding(text, 'in 2021 from'), id: 'overlap' }
    const stale = { ...finding(text, 'Kourou'), quote: 'Canaveral' }
    const { findings, dropped } = highlightSegments(text, [b, a, stale])
    expect(findings.map((f) => f.quote)).toEqual(['Launched in 2021'])
    expect(dropped).toBe(2)
  })

  it('orders findings by position and numbers them', () => {
    const text = 'Alpha beta gamma.'
    const { findings } = highlightSegments(text, [finding(text, 'gamma', 0, 'unverifiable'), finding(text, 'Alpha')])
    expect(findings.map((f) => f.quote)).toEqual(['Alpha', 'gamma'])
  })
})

describe('parseRag', () => {
  it('numbers citations by first appearance and claims the preceding sentence', () => {
    const text = 'Webb launched in 2021.[c_a] It orbits L2.[c_b] Launch was from Kourou.[c_a]'
    const parsed = parseRag(text)
    expect(parsed.order).toEqual(['c_a', 'c_b'])
    const cites = parsed.pieces.filter((p) => p.kind === 'cite')
    expect(cites.map((c) => c.numbers)).toEqual([[1], [2], [1]])
    const claims = parsed.pieces.filter((p) => p.kind === 'text' && p.claim !== undefined)
    expect(claims.map((c) => c.kind === 'text' && c.text)).toEqual([
      'Webb launched in 2021.',
      'It orbits L2.',
      'Launch was from Kourou.',
    ])
  })

  it('starts a claim after the previous sentence even without a marker', () => {
    const parsed = parseRag('Intro sentence. The fact is here.[c_1]')
    expect(parsed.pieces[0]).toEqual({ kind: 'text', text: 'Intro sentence. ' })
    expect(parsed.pieces[1]).toMatchObject({ text: 'The fact is here.', claim: 0 })
  })

  it('merges adjacent and comma-separated markers', () => {
    const parsed = parseRag('A fact.[c_1] [c_2, c_3]')
    const cites = parsed.pieces.filter((p) => p.kind === 'cite')
    expect(cites).toHaveLength(1)
    expect(cites[0]).toMatchObject({ numbers: [1, 2, 3], chunkIds: ['c_1', 'c_2', 'c_3'] })
    expect(parsed.claims[0].chunkIds).toEqual(['c_1', 'c_2', 'c_3'])
  })

  it('hides a marker that is still streaming in', () => {
    const parsed = parseRag('It launched in 2021.[c_4', true)
    expect(parsed.pieces).toEqual([{ kind: 'text', text: 'It launched in 2021.' }])
  })
})

describe('labels', () => {
  it('formats evidence locators', () => {
    expect(evidenceLabel({ title: 'Webb_mission_facts.pdf', locator: { page: 2 } })).toBe('Webb mission facts, p.2')
    expect(evidenceLabel({ title: 'Deck.pptx', locator: { slide: 4, element: 2 } })).toBe('Deck, slide 4')
    expect(evidenceLabel({ title: 'Notes.md', locator: { heading: 'Orbit', line_start: 3, line_end: 9 } })).toBe(
      'Notes, Orbit, lines 3–9',
    )
    expect(
      evidenceLabel({ title: 'https://example.com', locator: { url: 'https://www.example.com/docs/a', title: '' } }),
    ).toBe('example.com/docs/a')
  })

  it('derives short session titles', () => {
    expect(deriveTitle('When did Webb launch?')).toBe('Webb launch')
    expect(
      deriveTitle('When and how did the James Webb Space Telescope launch, and where does it operate today?'),
    ).toBe('James Webb Space')
    expect(deriveTitle('is he pursuing bachelors')).toBe('Pursuing bachelors')
    expect(deriveTitle('who is siddique khan')).toBe('Siddique khan')
    expect(deriveTitle('what is it')).toBe('What is it')
  })

  it('labels dates relative to today', () => {
    const now = new Date(2026, 8, 30, 12)
    expect(dateLabel(now.getTime() / 1000, now)).toBe('Today')
    expect(dateLabel(new Date(2026, 8, 29, 23).getTime() / 1000, now)).toBe('Yesterday')
    expect(dateLabel(new Date(2026, 8, 10).getTime() / 1000, now)).toMatch(/Sep\w* 10/)
  })
})
