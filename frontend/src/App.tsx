import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, setUnauthorizedHandler } from './api/client'
import type { SessionSummary, Source, User } from './api/types'
import { AuthScreen } from './components/AuthScreen'
import { KnowledgeBase } from './components/KnowledgeBase'
import { SessionView } from './components/SessionView'
import { Sidebar } from './components/Sidebar'
import { ToastProvider, useToast } from './components/Toast'

function sessionFromPath() {
  const match = window.location.pathname.match(/^\/s\/([A-Za-z0-9_]+)$/)
  return match ? match[1] : null
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null))
    api.me().then(setUser, () => setUser(null))
  }, [])

  if (user === undefined) return <div className="boot" aria-busy="true" />
  return (
    <ToastProvider>
      {user ? <Shell user={user} onLogout={() => setUser(null)} /> : <AuthScreen onAuthenticated={setUser} />}
    </ToastProvider>
  )
}

function readCollapsed() {
  try {
    return localStorage.getItem('factos.sidebar') === 'collapsed'
  } catch {
    return false
  }
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const toast = useToast()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentId, setCurrentId] = useState<string | null>(sessionFromPath)
  // Changes only on explicit navigation, so adopting a freshly created session keeps the view mounted.
  const [viewKey, setViewKey] = useState(0)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileNav, setMobileNav] = useState(false)
  const [kbOpen, setKbOpen] = useState(false)
  const [sources, setSources] = useState<Source[]>([])
  const creating = useRef<Promise<string> | null>(null)

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions } = await api.sessions()
      setSessions(sessions)
      return sessions
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) toast(error.message)
      return null
    }
  }, [toast])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  const navigate = useCallback((id: string | null) => {
    const path = id ? `/s/${id}` : '/'
    if (window.location.pathname !== path) window.history.pushState(null, '', path)
    setCurrentId(id)
    setViewKey((key) => key + 1)
    setMobileNav(false)
  }, [])

  useEffect(() => {
    const onPop = () => {
      setCurrentId(sessionFromPath())
      setViewKey((key) => key + 1)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const ensureSession = useCallback(
    async (title: string) => {
      if (currentId) return currentId
      creating.current ??= api.createSession(title.slice(0, 200)).then(({ id }) => {
        const now = Date.now() / 1000
        // Show the new session in the sidebar right away; the refresh fills in server fields.
        setSessions((all) => [
          { id, title: title.slice(0, 200), active_index: null, created: now, updated: now },
          ...all,
        ])
        window.history.replaceState(null, '', `/s/${id}`)
        setCurrentId(id)
        refreshSessions()
        return id
      })
      try {
        return await creating.current
      } finally {
        creating.current = null
      }
    },
    [currentId, refreshSessions],
  )

  // Knowledge-base sources for the open session; polled while anything is still processing.
  const refreshSources = useCallback(async () => {
    if (!currentId) return setSources([])
    try {
      setSources((await api.sources(currentId)).sources)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast('That session no longer exists.')
        navigate(null)
      }
    }
  }, [currentId, navigate, toast])

  useEffect(() => {
    setSources([])
    refreshSources()
  }, [refreshSources])

  const processing = sources.some((s) => s.status === 'processing')
  useEffect(() => {
    if (!processing) return
    const timer = window.setInterval(refreshSources, 2500)
    return () => window.clearInterval(timer)
  }, [processing, refreshSources])

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      try {
        localStorage.setItem('factos.sidebar', value ? 'expanded' : 'collapsed')
      } catch {
        // Storage may be unavailable; the toggle still works for this page.
      }
      return !value
    })
  }

  const deleteSession = async (id: string) => {
    try {
      await api.deleteSession(id)
      if (id === currentId) navigate(null)
      refreshSessions()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not delete the session')
    }
  }

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      onLogout()
    }
  }

  const current = sessions.find((s) => s.id === currentId) ?? null

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''} ${mobileNav ? 'nav-open' : ''}`}>
      <Sidebar
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        sessions={sessions}
        currentId={currentId}
        onSelect={navigate}
        onNew={() => navigate(null)}
        onDelete={deleteSession}
        sources={sources}
        onOpenKnowledgeBase={() => setKbOpen(true)}
        email={user.email}
        onLogout={logout}
        onCloseMobile={() => setMobileNav(false)}
      />
      <div className="scrim" onClick={() => setMobileNav(false)} />
      <SessionView
        key={viewKey}
        sessionId={currentId}
        title={current?.title ?? (currentId ? '' : 'New session')}
        sources={sources}
        ensureSession={ensureSession}
        onActivity={refreshSessions}
        onOpenKnowledgeBase={() => setKbOpen(true)}
        onOpenNav={() => setMobileNav(true)}
        onMissing={() => {
          toast('That session no longer exists.')
          navigate(null)
        }}
      />
      {kbOpen && (
        <KnowledgeBase
          sessionId={currentId}
          sources={sources}
          ensureSession={() => ensureSession('New session')}
          onChanged={refreshSources}
          onClose={() => setKbOpen(false)}
        />
      )}
    </div>
  )
}
