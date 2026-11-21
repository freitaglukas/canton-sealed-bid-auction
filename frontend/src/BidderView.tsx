import { useState } from 'react'
import { api, errorText } from './api'
import { usePoll } from './usePoll'
import type { InvitationView, OutcomeView, OwnBidView } from '../../backend/src/contract'

export function BidderView({ setError }: { setError: (e: string | null) => void }) {
  const [invs, setInvs] = useState<InvitationView[]>([])
  const [bids, setBids] = useState<OwnBidView[]>([])
  const [outs, setOuts] = useState<OutcomeView[]>([])
  const [amounts, setAmounts] = useState<Record<string, string>>({})

  const refresh = usePoll(async () => {
    const [i, b, o] = await Promise.all([api.invitations(), api.bids(), api.outcomes()])
    if (i.ok) setInvs(i.data); else setError(errorText(i))
    if (b.ok) setBids(b.data)
    if (o.ok) setOuts(o.data)
  })

  const place = async (invitationId: string) => {
    setError(null)
    const r = await api.bid(invitationId, (amounts[invitationId] ?? '').trim())
    if (!r.ok) setError(errorText(r))
    refresh()
  }

  const cards = new Map<string, string>()
  for (const x of [...invs, ...bids, ...outs]) cards.set(x.auctionId, x.item)

  if (cards.size === 0) return <p className="empty">No auctions visible to you</p>

  return (
    <div className="grid">
      {[...cards.entries()].map(([auctionId, item]) => {
        const inv = invs.find((x) => x.auctionId === auctionId)
        const bid = bids.find((x) => x.auctionId === auctionId)
        const out = outs.find((x) => x.auctionId === auctionId)
        const closed = !!out || bid?.status === 'closed'
        return (
          <article key={auctionId} className="card">
            <div className="card-head">
              <h3>{item}</h3>
              <span className={`badge ${closed ? 'closed' : 'open'}`}>{closed ? 'closed' : 'open'}</span>
            </div>
            {bid && <p data-testid={`my-bid-${auctionId}`}>Your bid: <strong>{bid.amount}</strong></p>}
            {inv && !closed && (
              <div data-testid={`invitation-${auctionId}`} className="bid-form">
                <input data-testid={`bid-input-${auctionId}`} inputMode="decimal" placeholder="Amount"
                  value={amounts[inv.invitationId] ?? ''}
                  onChange={(e) => setAmounts((a) => ({ ...a, [inv.invitationId]: e.target.value }))} />
                <button className="primary" data-testid={`bid-submit-${auctionId}`}
                  disabled={!(amounts[inv.invitationId] ?? '').trim()} onClick={() => place(inv.invitationId)}>
                  Place bid
                </button>
              </div>
            )}
            {out && (
              <p data-testid={`outcome-${auctionId}`} className={`outcome ${out.result}`}>
                {out.result === 'won' ? `You won — you owe ${out.amountOwed}`
                  : out.result === 'lost' ? 'You lost' : 'You did not bid'}
              </p>
            )}
          </article>
        )
      })}
    </div>
  )
}
