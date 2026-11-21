// Acceptance run of the 7 demo requirements, driven through the real UI in Chrome against LIVE LocalNet.
// Rejections that the UI deliberately offers no button for are fired from the acting user's own browser session
// (REST) or with that user's own ledger credentials, and the result is shown on screen in a labelled banner.
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ledgerForUser, loadParties, T, LedgerError } from '../../packages/ledger-client/src/index'

const ROOT = join(process.cwd(), '..') // run from e2e/
const creds: Record<string, string> = JSON.parse(readFileSync(join(ROOT, 'config/credentials.json'), 'utf8'))
const parties = loadParties()
const P = (u: string) => parties[u]

const stamp = Date.now().toString().slice(-5)
const ITEM_A = `Painting #${stamp}`
const ITEM_B = `Vase #${stamp}`
const BIDS = { alice: '1111', bob: '3333', carol: '2222' } as const
const bidders = ['alice', 'bob', 'carol'] as const

let page: Page
let A = '' // auctionId of the main auction
let B = '' // auctionId of the "bid after close" auction
const inv: Record<string, Record<string, string>> = { A: {}, B: {} } // invitationIds per bidder

async function banner(ok: boolean, title: string, detail = '') {
  await page.evaluate(
    ([ok, title, detail]) => {
      document.getElementById('acceptance-banner')?.remove()
      const d = document.createElement('div')
      d.id = 'acceptance-banner'
      d.style.cssText = `position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:99999;max-width:900px;
        padding:14px 20px;border-radius:10px;font:600 15px system-ui;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.3);
        background:${ok ? '#15803d' : '#b91c1c'}`
      d.innerHTML = `<div>${ok ? '✓' : '✗ REJECTED —'} ${title}</div>${detail ? `<div style="font-weight:400;font-size:13px;margin-top:4px;opacity:.95">${detail}</div>` : ''}`
      document.body.appendChild(d)
    },
    [ok, title, detail] as const,
  )
  await page.waitForTimeout(Number(process.env.BANNER_MS ?? 1800))
}

async function login(user: string) {
  await page.goto('/')
  const logout = page.getByRole('button', { name: 'Log out' })
  if (await logout.isVisible().catch(() => false)) await logout.click()
  await page.getByTestId('login-user').fill(user)
  await page.getByTestId('login-password').fill(creds[user])
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()
  await expect(page.locator('header, [role=banner]').first()).toContainText(user)
}

/** REST call from the logged-in user's own browser session. */
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ([method, path, body]) => {
      const r = await fetch(path, {
        method,
        credentials: 'include',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let j: unknown = null
      try { j = await r.json() } catch { /* empty */ }
      return { status: r.status, body: j }
    },
    [method, path, body] as const,
  )
}

/** Run a ledger command expecting rejection; returns the ledger error code. */
async function ledgerRejects(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError)
    return (e as LedgerError).code
  }
  throw new Error('expected the ledger to reject this command, but it succeeded')
}

async function mainText() {
  return page.locator('main').innerText()
}

test.describe.serial('Sealed-bid auction — acceptance on LIVE LocalNet (Chrome)', () => {
  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage()
  })
  test.afterAll(async () => {
    await page.context().close()
  })

  test('1. Five users: auctioneer, three bidders and one outsider can sign in', async () => {
    for (const u of ['auctioneer', 'alice', 'bob', 'carol', 'dave']) {
      await login(u)
      const me = await api('GET', '/api/me')
      expect(me.status).toBe(200)
      await banner(true, `${u} signed in`, `role: ${me.body.role} · party ${P(u).slice(0, 18)}… on its own LocalNet participant`)
    }
  })

  test('2a. Auctioneer creates the auction and invites three bidders by name', async () => {
    await login('auctioneer')
    for (const item of [ITEM_A, ITEM_B]) {
      await page.getByTestId('item-input').fill(item)
      for (const b of bidders) await page.getByTestId(`bidder-checkbox-${b}`).check()
      await page.getByTestId('create-auction').click()
      await expect(page.getByText(item)).toBeVisible()
    }
    const auctions = (await api('GET', '/api/auctions')).body as any[]
    A = auctions.find((a) => a.item === ITEM_A).auctionId
    B = auctions.find((a) => a.item === ITEM_B).auctionId
    await expect(page.getByTestId(`status-${A}`)).toHaveText(/open/i)
    await banner(true, `Two auctions open at once on the ledger: "${ITEM_A}" and "${ITEM_B}"`, 'each invites alice, bob, carol')
    for (const b of bidders) {
      await login(b)
      await expect(page.getByTestId(`invitation-${A}`)).toBeVisible()
      const invs = (await api('GET', '/api/invitations')).body as any[]
      inv.A[b] = invs.find((i) => i.auctionId === A).invitationId
      inv.B[b] = invs.find((i) => i.auctionId === B).invitationId
      await banner(true, `${b} received the invitation`, 'and sees only their own invitation')
    }
  })

  test('6b. Outsider cannot bid — dave was not invited (fails while alice’s invitation is still active)', async () => {
    await login('dave')
    const r = await api('POST', `/api/invitations/${inv.A.alice}/bid`, { amount: '9999' })
    expect(r.status).toBe(409)
    await banner(false, 'dave bids using alice’s live invitation', `HTTP ${r.status} ${r.body.code} · ledger: ${r.body.ledgerCode}`)
    const forged = await ledgerRejects(() =>
      ledgerForUser('dave').create(T.Bid, {
        auctioneer: P('auctioneer'), bidder: P('dave'), invitationCid: inv.A.alice, auctionId: A,
        item: ITEM_A, amount: '9999.0', submittedAt: new Date().toISOString(),
      }, [P('dave')]),
    )
    expect(forged).toBe('DAML_AUTHORIZATION_ERROR')
    await banner(false, 'dave forges a Bid directly on the ledger', `ledger: ${forged}`)
  })

  test('2b. Each bidder submits one sealed bid through the UI', async () => {
    for (const b of bidders) {
      await login(b)
      await page.getByTestId(`bid-input-${A}`).fill(BIDS[b])
      await page.getByTestId(`bid-submit-${A}`).click()
      await expect(page.getByTestId(`my-bid-${A}`)).toContainText(BIDS[b])
      await banner(true, `${b} placed a sealed bid of ${BIDS[b]}`)
    }
    await login('auctioneer')
    await expect(page.getByTestId(`bids-received-${A}`)).toHaveText('3')
    await banner(true, 'Auctioneer sees 3 / 3 bids received')
  })

  test('3a. Bids stay private BEFORE close: each bidder sees only their own bid', async () => {
    for (const b of bidders) {
      await login(b)
      await expect(page.getByTestId(`my-bid-${A}`)).toContainText(BIDS[b])
      const text = await mainText()
      for (const other of bidders.filter((o) => o !== b)) expect(text).not.toContain(BIDS[other])
      const own = ((await api('GET', '/api/bids')).body as any[]).filter((x) => x.auctionId === A)
      expect(own.map((x) => x.amount)).toEqual([BIDS[b]])
      const ledgerBids = await ledgerForUser(b).activeContracts<any>(P(b), [T.Bid])
      expect(ledgerBids.every((c) => c.payload.bidder === P(b))).toBe(true)
      await banner(true, `${b} sees only their own bid (${BIDS[b]})`, `ledger query with ${b}'s own credentials: ${ledgerBids.length} Bid contract(s), all their own`)
    }
  })

  test('4a. Outsider sees nothing (checking as dave)', async () => {
    await login('dave')
    await expect(page.getByText('No auctions visible to you')).toBeVisible()
    const text = await mainText()
    expect(text).not.toContain(ITEM_A)
    for (const path of ['/api/invitations', '/api/bids', '/api/outcomes']) {
      const r = (await api('GET', path)).body as any[]
      expect(r.filter((x) => x.auctionId === A || x.auctionId === B)).toEqual([])
    }
    const acs = await ledgerForUser('dave').activeContracts<any>(P('dave'), 'ALL')
    expect(acs.filter((c) => c.payload.auctionId === A || c.payload.auctionId === B)).toEqual([])
    await banner(true, 'dave sees no auction, invitation or bid', `ledger query as dave: 0 auction contracts (dave shares a node with alice)`)
  })

  test('5b. A bidder cannot change someone else’s bid (bob vs alice)', async () => {
    await login('bob')
    const auctioneer = ledgerForUser('auctioneer')
    const aliceBid = (await auctioneer.activeContracts<any>(P('auctioneer'), [T.Bid], { includeBlob: true }))
      .find((c) => c.payload.auctionId === A && c.payload.bidder === P('alice'))!
    const bob = ledgerForUser('bob')
    const plain = await ledgerRejects(() => bob.exercise(T.Bid, aliceBid.contractId, 'Archive', {}, [P('bob')]))
    await banner(false, 'bob tries to delete alice’s bid', `ledger: ${plain} — bob cannot even see it`)
    const disclosed = await ledgerRejects(() =>
      bob.exercise(T.Bid, aliceBid.contractId, 'Bid_Conclude', { won: true }, [P('bob')], {
        disclosed: [{ templateId: aliceBid.templateId, contractId: aliceBid.contractId, createdEventBlob: aliceBid.createdEventBlob! }],
      }),
    )
    expect(disclosed).toBe('DAML_AUTHORIZATION_ERROR')
    await banner(false, 'bob tries to rewrite alice’s bid even when handed the contract', `ledger: ${disclosed}`)
    await login('alice')
    await expect(page.getByTestId(`my-bid-${A}`)).toContainText(BIDS.alice)
    await banner(true, 'alice’s bid is unchanged', BIDS.alice)
  })

  test('6a. Only the auctioneer can close (bob tries)', async () => {
    await login('bob')
    await expect(page.getByTestId(`close-${A}`)).toHaveCount(0)
    const r = await api('POST', `/api/auctions/${A}/close`)
    expect(r.status).toBe(403)
    await banner(false, 'bob calls “close auction”', `HTTP ${r.status} ${r.body.code}`)
    const auction = (await ledgerForUser('auctioneer').activeContracts<any>(P('auctioneer'), [T.Auction]))
      .find((c) => c.payload.auctionId === A)!
    const code = await ledgerRejects(() =>
      ledgerForUser('bob').exercise(T.Auction, auction.contractId, 'Auction_Close', { bids: [], openInvitations: [] }, [P('bob')]),
    )
    await banner(false, 'bob exercises Auction_Close on the ledger', `ledger: ${code}`)
  })

  test('2c. Auctioneer closes and awards to the highest bid', async () => {
    await login('auctioneer')
    await page.getByTestId(`close-${A}`).click()
    await expect(page.getByTestId(`status-${A}`)).toHaveText(/closed/i)
    await expect(page.getByTestId(`result-${A}`)).toContainText('bob')
    await expect(page.getByTestId(`result-${A}`)).toContainText(BIDS.bob)
    await banner(true, `Awarded to bob at ${BIDS.bob}`)
    await page.getByTestId(`close-${B}`).click()
    await expect(page.getByTestId(`status-${B}`)).toHaveText(/closed/i)
    await banner(true, `"${ITEM_B}" closed with no bids`)
  })

  test('3b. Bids stay private AFTER close; winner learns what they owe, losers only that they lost', async () => {
    for (const b of bidders) {
      await login(b)
      const outcome = page.getByTestId(`outcome-${A}`)
      if (b === 'bob') await expect(outcome).toHaveText(`You won — you owe ${BIDS.bob}`)
      else await expect(outcome).toHaveText('You lost')
      await expect(page.getByTestId(`my-bid-${A}`)).toContainText(BIDS[b])
      const text = await mainText()
      for (const other of bidders.filter((o) => o !== b)) expect(text).not.toContain(BIDS[other])
      await banner(true, `${b}: "${await outcome.innerText()}" — still sees only their own bid (${BIDS[b]})`)
    }
  })

  test('4b. Outsider still sees nothing after close', async () => {
    await login('dave')
    await expect(page.getByText('No auctions visible to you')).toBeVisible()
    const acs = await ledgerForUser('dave').activeContracts<any>(P('dave'), 'ALL')
    expect(acs.filter((c) => c.payload.auctionId === A || c.payload.auctionId === B)).toEqual([])
    await banner(true, 'dave still sees nothing — no result, no winner, no price')
  })

  test('5a. A bidder cannot bid after the auction closes (carol on the closed Vase auction)', async () => {
    await login('carol')
    await expect(page.getByTestId(`outcome-${B}`)).toHaveText('You did not bid')
    await expect(page.getByTestId(`bid-input-${B}`)).toHaveCount(0)
    const r = await api('POST', `/api/invitations/${inv.B.carol}/bid`, { amount: '5000' })
    expect(r.status).toBe(409)
    await banner(false, 'carol bids on the closed auction', `HTTP ${r.status} ${r.body.code} · ledger: ${r.body.ledgerCode}`)
  })
})
