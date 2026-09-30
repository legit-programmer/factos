// Tiny and dependency-free so it can load before the app; the mock itself is imported lazily.

export const DEV_TOOLS = import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === 'true'
const KEY = 'factos.dev.mock'

function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** `?mock=1` / `?mock=0` switch the mock backend from a link; the choice is remembered. */
export function mockEnabled() {
  if (!DEV_TOOLS) return false
  const param = new URLSearchParams(window.location.search).get('mock')
  if (param === '1' || param === '0') setMockEnabled(param === '1', false)
  return read(KEY) === 'on'
}

export function setMockEnabled(on: boolean, reload = true) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // Without storage the mock cannot be remembered across the reload.
  }
  if (reload) window.location.reload()
}
