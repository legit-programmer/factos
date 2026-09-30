import { ApiError, send, url } from './client'
import type { TurnEvent } from './types'

/** Incremental parser for the `text/event-stream` framing used by the turn stream. */
export class SseParser {
  private buffer = ''

  constructor(private readonly onEvent: (event: TurnEvent) => void) {}

  push(chunk: string) {
    this.buffer += chunk.replace(/\r\n?/g, '\n')
    let boundary: number
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) this.onEvent(JSON.parse(data) as TurnEvent)
    }
  }
}

/**
 * Reads one connection of the combined turn stream, replaying events after `lastEventId`.
 * Resolves when the server closes the stream (the turn is terminal); rejects with ApiError on
 * HTTP errors such as 410 (replay expired) and with other errors on network failure.
 *
 * This uses fetch rather than EventSource: EventSource reconnects forever after the server
 * finishes a settled turn and cannot read 410 responses.
 */
export async function readTurnEvents(
  eventsPath: string,
  lastEventId: number,
  signal: AbortSignal,
  onEvent: (event: TurnEvent) => void,
) {
  const response = await send(url(eventsPath), {
    credentials: 'include',
    headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(lastEventId) },
    signal,
  })
  if (!response.ok || !response.body) {
    let detail: { code?: string; message?: string } = {}
    try {
      detail = await response.json()
    } catch {
      // Non-JSON error body.
    }
    throw new ApiError(response.status, detail.code ?? 'stream_error', detail.message ?? 'Stream failed')
  }
  const parser = new SseParser(onEvent)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    parser.push(value)
  }
}
