import { useState, type FormEvent } from 'react'
import { ApiError, api } from '../api/client'
import type { User } from '../api/types'
import { GroundedDot, Logo, UngroundedDot } from './Marks'
import { ThemeButton } from './ThemeButton'

const MIN_PASSWORD = 15
const MAX_PASSWORD = 128

function message(error: unknown, mode: 'login' | 'register') {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.'
  if (error.status === 401) return 'Invalid email or password.'
  if (error.status === 409) return 'Registration could not be completed. Try logging in instead.'
  if (error.status === 422)
    return mode === 'register'
      ? `Enter a valid email and a password of ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`
      : 'Enter a valid email and password.'
  return error.message
}

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (mode === 'register' && password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters — a short passphrase works well.`)
      return
    }
    setBusy(true)
    try {
      if (mode === 'register') await api.register(email, password)
      await api.login(email, password)
      onAuthenticated(await api.me())
    } catch (err) {
      setError(message(err, mode))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <div className="auth-theme">
        <ThemeButton />
      </div>
      <div className="auth-card">
        <div className="brand auth-brand">
          <Logo size={30} />
          <span className="brand-name">Hallucination Lab</span>
        </div>
        <p className="auth-lede">
          Ask once, get two answers: one <GroundedDot size={9} /> grounded in your documents, one{' '}
          <UngroundedDot size={12} /> from memory — then see which claims your sources contradict.
        </p>
        <form onSubmit={submit} className="auth-form" noValidate>
          <label>
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              minLength={mode === 'register' ? MIN_PASSWORD : undefined}
              maxLength={MAX_PASSWORD}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {mode === 'register' && (
              <small className="hint">
                {MIN_PASSWORD}–{MAX_PASSWORD} characters. {password.length > 0 && `${password.length} so far.`}
              </small>
            )}
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button-primary" disabled={busy || !email || !password}>
            {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
        <p className="auth-switch">
          {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setError(null)
            }}
          >
            {mode === 'login' ? 'Create an account' : 'Log in'}
          </button>
        </p>
      </div>
    </main>
  )
}
