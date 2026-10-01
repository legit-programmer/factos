import type { Evidence, Finding, Locator } from '../api/types'

// ---------- Grounded answers: `[c_…]` citation markers ----------

export type RagPiece =
  | { kind: 'text'; text: string; claim?: number }
  | { kind: 'cite'; claim: number; numbers: number[]; chunkIds: string[] }

export interface RagClaim {
  chunkIds: string[]
}

export interface ParsedRag {
  pieces: RagPiece[]
  claims: RagClaim[]
  /** Cited chunk ids in order of first appearance; the footnote number is index + 1. */
  order: string[]
}

const MARKER = /\[(c_[A-Za-z0-9_]+(?:\s*[,;]\s*c_[A-Za-z0-9_]+)*)\]/g
// A marker still arriving mid-stream, e.g. "…Guiana.[c_4".
const PARTIAL_MARKER = /\[(?:c(?:_[A-Za-z0-9_,;\s]*)?)?$/
// Sentence ends inside the text preceding a marker (the claim starts after the last one).
const SENTENCE_END = /[.!?]["'”’)\]]*\s+|\n+/g

function claimStart(region: string) {
  // Ignore the region's own closing punctuation ("Guiana." directly before its marker).
  const body = region.replace(/[\s.!?"'”’)\]]+$/, '')
  let start = 0
  for (const match of body.matchAll(SENTENCE_END)) start = match.index + match[0].length
  while (start < region.length && /\s/.test(region[start])) start++
  return start
}

/**
 * Splits a grounded answer into text and footnote pieces. Each marker "claims" the sentence
 * fragment directly before it, so evidence shown elsewhere can point back at the cited text.
 */
export function parseRag(text: string, streaming = false): ParsedRag {
  const source = streaming ? text.replace(PARTIAL_MARKER, '') : text
  const pieces: RagPiece[] = []
  const claims: RagClaim[] = []
  const order: string[] = []
  let cursor = 0
  for (const match of source.matchAll(MARKER)) {
    const chunkIds = match[1].split(/\s*[,;]\s*/)
    for (const id of chunkIds) if (!order.includes(id)) order.push(id)
    const numbers = chunkIds.map((id) => order.indexOf(id) + 1)
    const region = source.slice(cursor, match.index)
    const previous = pieces[pieces.length - 1]
    if (!region.trim() && previous?.kind === 'cite') {
      // Adjacent markers "[c_1] [c_2]" cite the same claim.
      previous.chunkIds.push(...chunkIds)
      previous.numbers.push(...numbers)
      claims[previous.claim].chunkIds.push(...chunkIds)
    } else {
      const start = claimStart(region)
      if (start > 0) pieces.push({ kind: 'text', text: region.slice(0, start) })
      const claim = claims.length
      claims.push({ chunkIds: [...chunkIds] })
      pieces.push({ kind: 'text', text: region.slice(start), claim })
      pieces.push({ kind: 'cite', claim, numbers, chunkIds: [...chunkIds] })
    }
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) pieces.push({ kind: 'text', text: source.slice(cursor) })
  return { pieces, claims, order }
}

// ---------- Ungrounded answers: exact UTF-16 finding spans ----------

export interface Segment {
  text: string
  finding?: Finding
  /** Position of the finding in the sorted list; its superscript is index + 1. */
  index?: number
}

/**
 * Cuts canonical text at the server-resolved half-open UTF-16 offsets. JavaScript string indices
 * are UTF-16 code units, so the offsets slice directly. Findings whose quote does not equal the
 * addressed substring, or that overlap an earlier finding, are dropped rather than guessed at.
 */
export function highlightSegments(text: string, findings: Finding[]) {
  const sorted = [...findings].sort((a, b) => a.start_utf16 - b.start_utf16 || a.end_utf16 - b.end_utf16)
  const valid: Finding[] = []
  let dropped = 0
  let end = 0
  for (const finding of sorted) {
    const { start_utf16: start, end_utf16: stop } = finding
    if (start < end || stop <= start || stop > text.length || text.slice(start, stop) !== finding.quote) {
      dropped++
      continue
    }
    valid.push(finding)
    end = stop
  }
  const segments: Segment[] = []
  let cursor = 0
  valid.forEach((finding, index) => {
    if (finding.start_utf16 > cursor) segments.push({ text: text.slice(cursor, finding.start_utf16) })
    segments.push({ text: finding.quote, finding, index })
    cursor = finding.end_utf16
  })
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return { segments, findings: valid, dropped }
}

// ---------- Source labels ----------

export function cleanTitle(title: string) {
  return title.replace(/\.(pdf|docx|pptx|md)$/i, '').replace(/[_]+/g, ' ').trim() || title
}

function clip(text: string, length = 40) {
  return text.length > length ? text.slice(0, length - 1).trimEnd() + '…' : text
}

export function formatLocator(locator: Locator) {
  const parts: string[] = []
  if (locator.page != null) parts.push(`p.${locator.page}`)
  if (locator.slide != null) parts.push(`slide ${locator.slide}`)
  if (locator.heading) parts.push(clip(String(locator.heading)))
  if (locator.table != null) parts.push(`table ${locator.table}`)
  if (locator.row != null) parts.push(`row ${locator.row}`)
  if (locator.paragraph != null && locator.table == null) parts.push(`¶${locator.paragraph}`)
  if (locator.line_start != null) {
    parts.push(
      locator.line_end != null && locator.line_end !== locator.line_start
        ? `lines ${locator.line_start}–${locator.line_end}`
        : `line ${locator.line_start}`,
    )
  }
  return parts.join(', ')
}

export function hostPath(value: string) {
  try {
    const parsed = new URL(value)
    return clip(parsed.hostname.replace(/^www\./, '') + (parsed.pathname === '/' ? '' : parsed.pathname), 48)
  } catch {
    return clip(value, 48)
  }
}

export function evidenceLabel(evidence: Pick<Evidence, 'title' | 'locator'>) {
  const { locator } = evidence
  if (locator.url) {
    const pageTitle = locator.title ? clip(String(locator.title)) : ''
    return pageTitle || hostPath(String(locator.url))
  }
  const where = formatLocator(locator)
  return where ? `${cleanTitle(evidence.title)}, ${where}` : cleanTitle(evidence.title)
}

// ---------- Sessions ----------

const FILLER = new Set(
  (
    'what when where who whom whose why how which and or did does do is are was were can could would should will ' +
    'the a an tell me please explain describe about of to in on at for with from by be been has have had ' +
    'i you he she it we they my your his her its our their this that these those any some all'
  ).split(' '),
)

/** A very short title from the first question: "Who is Siddique Khan?" → "Siddique Khan". */
export function deriveTitle(question: string) {
  const firstClause = question.trim().split(/[?.!,;:\n]/)[0] ?? ''
  const words = firstClause.split(/\s+/).filter(Boolean)
  const keywords = words.filter((word) => !FILLER.has(word.toLowerCase()))
  let title = ''
  for (const word of (keywords.length ? keywords : words).slice(0, 3)) {
    if (title && title.length + word.length + 1 > 28) break
    title = title ? `${title} ${word}` : word
  }
  title = (title || question.trim()).slice(0, 28).trim() || 'New session'
  return title[0].toUpperCase() + title.slice(1)
}

export function dateLabel(epochSeconds: number, now = new Date()) {
  const date = new Date(epochSeconds * 1000)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' })
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}
