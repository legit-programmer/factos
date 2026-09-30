import { Library, LogOut, PanelLeft, Plus, Trash2, X } from 'lucide-react'
import type { SessionSummary, Source } from '../api/types'
import { cleanTitle, dateLabel } from '../lib/text'
import { Logo, Swatch } from './Marks'

interface Props {
  collapsed: boolean
  onToggle: () => void
  sessions: SessionSummary[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  sources: Source[]
  onOpenKnowledgeBase: () => void
  email: string
  onLogout: () => void
  onCloseMobile: () => void
}

export function knowledgeBaseName(sources: Source[]) {
  const live = sources.filter((s) => s.status !== 'failed')
  if (!sources.length) return 'No documents yet'
  if (live.length === 1) return cleanTitle(live[0].title)
  return `${live.length || sources.length} sources`
}

export function Sidebar(props: Props) {
  const { collapsed, sessions, currentId, sources } = props
  const sorted = [...sessions].sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created))
  const processing = sources.filter((s) => s.status === 'processing').length

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-top">
        <div className="brand">
          <Logo />
          <span className="brand-name">Hallucination Lab</span>
        </div>
        <button
          type="button"
          className="icon-button sidebar-toggle"
          onClick={props.onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <PanelLeft size={18} strokeWidth={1.6} />
        </button>
        <button type="button" className="icon-button sidebar-close" onClick={props.onCloseMobile} aria-label="Close">
          <X size={18} />
        </button>
      </div>

      <button type="button" className="new-session" onClick={props.onNew} title="New session">
        <Plus size={18} strokeWidth={2} />
        <span>New session</span>
      </button>

      <div className="sessions">
        {sorted.length > 0 && <div className="sessions-label">Sessions</div>}
        <ul>
          {sorted.map((session) => (
            <li key={session.id}>
              <div className={`session-item ${session.id === currentId ? 'is-current' : ''}`}>
                <button
                  type="button"
                  className="session-main"
                  onClick={() => props.onSelect(session.id)}
                  aria-current={session.id === currentId ? 'page' : undefined}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    <span className="session-date">
                      {session.active ? 'Writing…' : dateLabel(session.updated ?? session.created)}
                    </span>
                    <span className="session-counts" aria-label="Contradicted and unverifiable claims">
                      <Swatch kind="red" />
                      {session.contradicted ?? 0}
                      <Swatch kind="yellow" />
                      {session.unverifiable ?? 0}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button session-delete"
                  aria-label={`Delete ${session.title}`}
                  title="Delete session"
                  onClick={() => {
                    if (window.confirm(`Delete “${session.title}”? Its answers and documents are removed.`))
                      props.onDelete(session.id)
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-bottom">
        <button type="button" className="kb-card" onClick={props.onOpenKnowledgeBase}>
          <span className="kb-label">
            Knowledge base
            {processing > 0 && <span className="kb-processing">{processing} processing</span>}
          </span>
          <span className="kb-name">{knowledgeBaseName(sources)}</span>
        </button>
        <button
          type="button"
          className="icon-button kb-icon"
          onClick={props.onOpenKnowledgeBase}
          aria-label="Knowledge base"
          title="Knowledge base"
        >
          <Library size={18} strokeWidth={1.6} />
        </button>
        <div className="account">
          <span className="account-email" title={props.email}>
            {props.email}
          </span>
          <button type="button" className="icon-button" onClick={props.onLogout} aria-label="Log out" title="Log out">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}
