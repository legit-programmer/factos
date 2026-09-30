import { FlaskConical, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { mockEnabled, setMockEnabled } from './flags'
import type { MockSettings, Outcome, Speed } from './mock/server'

type MockModule = typeof import('./mock/server')

const SPEEDS: Speed[] = ['slow', 'normal', 'fast', 'instant']
const OUTCOMES: [Outcome, string][] = [
  ['normal', 'Everything succeeds'],
  ['rag_fail', 'Grounded answer fails'],
  ['baseline_fail', 'Ungrounded answer fails (check skipped)'],
  ['check_fail', 'Fact check fails'],
  ['check_partial', 'Fact check is partial'],
  ['slow_check', 'Slow fact check (queues later turns)'],
]

/** Floating developer button: switches the app between the real backend and the in-browser mock. */
export default function DevTools() {
  const enabled = mockEnabled()
  const [open, setOpen] = useState(false)
  const [mock, setMock] = useState<MockModule | null>(null)
  const [settings, setSettings] = useState<MockSettings | null>(null)
  const [status, setStatus] = useState<ReturnType<MockModule['controls']['status']> | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    document.body.classList.add('has-devtools')
    return () => document.body.classList.remove('has-devtools')
  }, [])

  useEffect(() => {
    if (!enabled) return
    import('./mock/server').then((module) => {
      setMock(module)
      setSettings(module.controls.settings())
      setStatus(module.controls.status())
    })
  }, [enabled])

  useEffect(() => {
    if (!open || !mock) return
    const timer = window.setInterval(() => setStatus(mock.controls.status()), 600)
    return () => window.clearInterval(timer)
  }, [open, mock])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const update = (next: Partial<MockSettings>) => {
    if (!mock) return
    mock.controls.update(next)
    setSettings(mock.controls.settings())
  }

  const act = (label: string, run: () => number) => {
    const count = run()
    setNote(`${label}: ${count} open stream${count === 1 ? '' : 's'} affected.`)
    setStatus(mock?.controls.status() ?? null)
  }

  return (
    <div className="devtools">
      {open && (
        <section className="devtools-panel" role="dialog" aria-label="Developer tools">
          <header>
            <h2>Developer tools</h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </header>

          <label className="dev-switch">
            <span>
              <strong>Mock backend</strong>
              <small>
                Serve every API call, stream and replay from an in-browser simulation. Switching reloads the page;
                real and mock data stay separate.
              </small>
            </span>
            <input type="checkbox" role="switch" checked={enabled} onChange={(e) => setMockEnabled(e.target.checked)} />
          </label>

          {enabled && mock && settings && (
            <>
              {status && (
                <p className="dev-status">
                  {status.streams} open stream{status.streams === 1 ? '' : 's'} · {status.activeTurns} active turn
                  {status.activeTurns === 1 ? '' : 's'} · {status.processing} indexing
                </p>
              )}

              <div className="dev-field">
                <span>Speed</span>
                <div className="dev-segmented" role="radiogroup" aria-label="Simulation speed">
                  {SPEEDS.map((speed) => (
                    <button
                      key={speed}
                      type="button"
                      role="radio"
                      aria-checked={settings.speed === speed}
                      onClick={() => update({ speed })}
                    >
                      {speed[0].toUpperCase() + speed.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <label className="dev-field">
                <span>Next question</span>
                <select value={settings.outcome} onChange={(e) => update({ outcome: e.target.value as Outcome })}>
                  {OUTCOMES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="dev-check">
                <input
                  type="checkbox"
                  checked={settings.firecrawl}
                  onChange={(e) => update({ firecrawl: e.target.checked })}
                />
                Firecrawl configured (website sources)
              </label>

              <div className="dev-actions">
                <button
                  type="button"
                  title="Errors open streams; the client reconnects and resumes from Last-Event-ID"
                  onClick={() => act('Dropped', mock.controls.dropStreams)}
                >
                  Drop streams
                </button>
                <button
                  type="button"
                  title="Deletes the event log; reconnects get 410 and fall back to saved turns"
                  onClick={() => act('Replay expired', () => mock.controls.expireReplay())}
                >
                  Expire replay
                </button>
                <button
                  type="button"
                  title="Like a backend restart: in-flight answers, checks and indexing fail as interrupted"
                  onClick={() => act('Restarted', () => mock.controls.simulateRestart())}
                >
                  Simulate restart
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm('Reset all mock users, sessions and documents to the demo data?')) return
                    mock.controls.reset()
                    window.location.assign('/')
                  }}
                >
                  Reset data
                </button>
              </div>
              {note && <p className="dev-note">{note}</p>}

              <div className="dev-demo">
                <span>
                  Demo account <code>{mock.demoCredentials.email}</code> / <code>{mock.demoCredentials.password}</code>
                </span>
                {status && !status.loggedIn && (
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => {
                      mock.controls.loginDemo()
                      window.location.reload()
                    }}
                  >
                    Sign in as demo
                  </button>
                )}
              </div>
              <p className="dev-tip">
                Ask about Webb’s launch, L2, the mirror, the EU AI Act, pricing or mitochondria for scripted
                answers; anything else gets a generic pair. Files with “fail” in the name fail once, then retry.
              </p>
            </>
          )}
        </section>
      )}
      <button
        type="button"
        className={`devtools-button ${enabled ? 'is-mock' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="Developer tools"
      >
        <FlaskConical size={15} strokeWidth={2} />
        {enabled ? 'Mock' : 'Dev'}
        {enabled && <span className="devtools-dot" aria-hidden="true" />}
      </button>
    </div>
  )
}
