import { useState } from 'react'
import { api } from './api'
import { usePoll, usePollReporter, reportAction } from './usePoll'
import { INVITEE_COUNT } from './constants'
import type { AuctionSummary } from '../../backend/src/contract'

export function AuctioneerView(ctx: { setError: (e: string | null) => void; onUnauth: () => void }) {
  const { setError } = ctx
  const report = usePollReporter(ctx)
  const [directory, setDirectory] = useState<string[]>([])
  const [auctions, setAuctions] = useState<AuctionSummary[]>([])
  const [item, setItem] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = usePoll(async () => {
    const [d, a] = await Promise.all([api.directory(), api.auctions()])
    if (d.ok) setDirectory(d.data.bidders)
    if (a.ok) setAuctions(a.data)
    report([d, a])
  })

  const toggle = (b: string) =>
    setPicked((p) => (p.includes(b) ? p.filter((x) => x !== b) : [...p, b]))

  const create = async () => {
    setBusy(true); setError(null)
    const r = await api.createAuction({ item: item.trim(), bidders: picked as [string, string, string] })
    setBusy(false)
    if (r.ok) { setItem(''); setPicked([]); refresh() } else reportAction(r, ctx)
  }

  const close = async (id: string) => {
    setError(null)
    const r = await api.close(id)
    reportAction(r, ctx)
    refresh()
  }

  const canCreate = item.trim().length > 0 && picked.length === INVITEE_COUNT && !busy

  return (
    <>
      <section className="card">
        <h2>New auction</h2>
        <label>Item
          <input data-testid="item-input" value={item} onChange={(e) => setItem(e.target.value)}
            placeholder="e.g. Vintage guitar" />
        </label>
        <fieldset>
          <legend>Invite exactly {INVITEE_COUNT} bidders <span className="muted">({picked.length}/{INVITEE_COUNT} selected)</span></legend>
          <div className="chips">
            {directory.map((b) => (
              <label key={b} className={'chip' + (picked.includes(b) ? ' on' : '')}>
                <input type="checkbox" data-testid={`bidder-checkbox-${b}`} checked={picked.includes(b)}
                  onChange={() => toggle(b)} />
                {b}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="primary" data-testid="create-auction" disabled={!canCreate} onClick={create}>
          Create auction
        </button>
      </section>

      <h2 className="section-title">Auctions</h2>
      {auctions.length === 0 && <p className="muted">No auctions yet.</p>}
      <div className="grid">
        {auctions.map((a) => (
          <article key={a.auctionId} className="card" data-testid={`auction-row-${a.auctionId}`}>
            <div className="card-head">
              <h3>{a.item}</h3>
              <span className={`badge ${a.status}`} data-testid={`status-${a.auctionId}`}>{a.status}</span>
            </div>
            <p className="muted">Invited: {a.invitees.join(', ')}</p>
            <p>Bids received: <strong data-testid={`bids-received-${a.auctionId}`}>{a.bidsReceived}</strong> / {a.invitees.length}</p>
            {a.status === 'closed' ? (
              <p className="result" data-testid={`result-${a.auctionId}`}>
                {a.winner ? <>Winner: <strong>{a.winner}</strong> at <strong>{a.price}</strong></> : 'No bids received'}
              </p>
            ) : (
              <button className="danger" data-testid={`close-${a.auctionId}`} onClick={() => close(a.auctionId)}>
                Close auction
              </button>
            )}
          </article>
        ))}
      </div>
    </>
  )
}
