import { useState } from 'react'
import { api, errorText } from './api'
import type { LoginResponse } from '../../backend/src/contract'

export function Login({ onLogin }: { onLogin: (u: LoginResponse) => void }) {
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const r = await api.login(userId.trim(), password)
    setBusy(false)
    if (r.ok) onLogin(r.data)
    else setErr(errorText(r))
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>Sealed-Bid Auction</h1>
        <p className="muted">Private bids on the Canton Network. Sign in to continue.</p>
        {err && <div className="error-banner" data-testid="error-banner" role="alert">{err}</div>}
        <label>User
          <input data-testid="login-user" value={userId} onChange={(e) => setUserId(e.target.value)}
            autoComplete="username" placeholder="alice" />
        </label>
        <label>Password
          <input data-testid="login-password" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <button className="primary" data-testid="login-submit" type="submit" disabled={busy || !userId || !password}>
          Sign in
        </button>
      </form>
    </div>
  )
}
