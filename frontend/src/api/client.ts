import type {
  SavedTurn,
  SessionDetail,
  SessionSummary,
  Source,
  TurnCreated,
  User,
} from './types'

// Same-origin `/api` through the Vite proxy by default; VITE_API_BASE targets the backend directly.
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

/** The network layer; developer tools swap in an in-browser mock of the backend. */
export type Transport = (input: string, init?: RequestInit) => Promise<Response>
let transport: Transport = (input, init) => fetch(input, init)
export function setTransport(next: Transport) {
  transport = next
}
export function send(input: string, init?: RequestInit) {
  return transport(input, init)
}

let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

export function url(path: string) {
  return API_BASE + path
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: {} }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  let response: Response
  try {
    response = await send(url(path), init)
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check that the backend is running.', true)
  }
  if (response.ok) return (await response.json()) as T
  let detail: { code?: string; message?: string; retryable?: boolean } = {}
  try {
    detail = await response.json()
  } catch {
    // Proxies and crashed backends may not return the common error body.
  }
  const error = new ApiError(
    response.status,
    detail.code ?? 'http_' + response.status,
    detail.message ?? `Request failed (${response.status})`,
    detail.retryable ?? response.status >= 500,
  )
  if (response.status === 401 && !path.startsWith('/auth/login')) onUnauthorized()
  throw error
}

function upload(file: File) {
  const form = new FormData()
  form.append('file', file)
  return form
}

export const api = {
  me: () => request<User>('GET', '/auth/me'),
  register: (email: string, password: string) =>
    request<{ user_id: string }>('POST', '/auth/register', { email, password }),
  login: (email: string, password: string) =>
    request<{ user_id: string }>('POST', '/auth/login', { email, password }),
  logout: () => request<{ status: string }>('POST', '/auth/logout'),

  sessions: () => request<{ sessions: SessionSummary[] }>('GET', '/sessions'),
  createSession: (title: string) =>
    request<{ id: string; children: { id: string; role: string }[] }>('POST', '/sessions', { title }),
  session: (id: string) => request<SessionDetail>('GET', `/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    request<{ id: string; title: string }>('PATCH', `/sessions/${id}`, { title }),
  deleteSession: (id: string) => request<{ status: string }>('DELETE', `/sessions/${id}`),

  sources: (id: string) => request<{ sources: Source[] }>('GET', `/sessions/${id}/sources`),
  uploadSource: (id: string, file: File) =>
    request<{ source_id: string; status: string; deduplicated?: boolean }>(
      'POST',
      `/sessions/${id}/sources/files`,
      upload(file),
    ),
  addWebsite: (id: string, siteUrl: string, includePaths: string[]) =>
    request<{ source_id: string; status: string; deduplicated?: boolean }>(
      'POST',
      `/sessions/${id}/sources/websites`,
      { url: siteUrl, include_paths: includePaths },
    ),
  retrySource: (id: string, sourceId: string) =>
    request<{ status: string }>('POST', `/sessions/${id}/sources/${sourceId}/retry`),
  deleteSource: (id: string, sourceId: string) =>
    request<{ status: string }>('DELETE', `/sessions/${id}/sources/${sourceId}`),

  uploadAttachment: (id: string, file: File) =>
    request<{ attachment_id: string; mime: string; width: number; height: number }>(
      'POST',
      `/sessions/${id}/attachments`,
      upload(file),
    ),
  createTurn: (id: string, requestId: string, text: string, attachmentIds: string[]) =>
    request<TurnCreated>('POST', `/sessions/${id}/turns`, {
      request_id: requestId,
      text,
      attachment_ids: attachmentIds,
    }),
  turn: (id: string, turnId: string) => request<SavedTurn>('GET', `/sessions/${id}/turns/${turnId}`),
  cancelTurn: (id: string, turnId: string) =>
    request<{ status: string }>('POST', `/sessions/${id}/turns/${turnId}/cancel`),
  retryAnalysis: (id: string, turnId: string) =>
    request<{ status: string }>('POST', `/sessions/${id}/turns/${turnId}/analysis/retry`),
}
