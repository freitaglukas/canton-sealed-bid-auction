import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { Login } from './Login'
import { AuctioneerView } from './AuctioneerView'
import { BidderView } from './BidderView'
import type { LoginResponse } from '../../backend/src/contract'
import './styles.css'

function App() {
  const [user, setUser] = useState<LoginResponse | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.me().then((r) => { if (r.ok) setUser(r.data); setReady(true) })
  }, [])

  if (!ready) return null
  if (!user) return <Login onLogin={setUser} />

  const logout = async () => { await api.logout(); setError(null); setUser(null) }

  const onUnauth = () => { setError(null); setUser(null) }

  return (
    <>
      <header className="topbar">
        <strong className="brand">Sealed-Bid Auction</strong>
        <span className="who" data-testid="whoami">{user.userId} <span className="role">{user.role}</span></span>
        <button onClick={logout} data-testid="logout">Log out</button>
      </header>
      <main>
        {error && (
          <div className="error-banner" data-testid="error-banner" role="alert">
            <span>{error}</span>
            <button className="x" aria-label="Dismiss" onClick={() => setError(null)}>×</button>
          </div>
        )}
        {user.role === 'auctioneer'
          ? <AuctioneerView setError={setError} onUnauth={onUnauth} />
          : <BidderView setError={setError} onUnauth={onUnauth} />}
      </main>
    </>
  )
}

async function boot() {
  if (import.meta.env.VITE_MOCK) (await import('./mock-server')).installMock()
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
}
void boot()
