// Decimal JSON rendering (separate sa-probe-dec package) + /v2/updates cap behaviour.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { call, jwt, NODES, ADMIN, DPM, submit, createdCid, loadState, ledgerEnd, rand } from './lib.mjs';

const S = loadState();
const dir = new URL('../dec/', import.meta.url).pathname;
execSync(`"${DPM}" build`, { cwd: dir, stdio: 'ignore' });
const dar = readFileSync(dir + '.daml/dist/sa-probe-dec-0.1.0.dar');
const up = await fetch(NODES.provider + '/v2/dars?vetAllPackages=true', { method: 'POST', headers: { Authorization: `Bearer ${jwt(ADMIN)}`, 'Content-Type': 'application/octet-stream' }, body: dar });
console.log('upload dec', up.status, await up.text());

const T = '#sa-probe-dec:ProbeDec:D';
for (const amt of [150, '150', '150.5', '0.1', '123456789012345678.1234567891', '1e2', '1.00000000005']) {
  const r = await submit('provider', S.provUser, [S.provParty], [{ CreateCommand: { templateId: T, createArguments: { owner: S.provParty, amount: amt, n: '7', at: '2026-11-21T10:00:00Z', maybeAmt: amt } } }]);
  const ev = r.json?.transaction?.events?.find((e) => e.CreatedEvent)?.CreatedEvent;
  console.log('input', JSON.stringify(amt), '->', r.status, ev ? JSON.stringify(ev.createArgument) : r.text.slice(0, 250));
}

// /v2/updates cap: how many txs on provider?
const end = await ledgerEnd('provider');
console.log('provider ledger end', end);
const fmt = { includeTransactions: { eventFormat: { filtersForAnyParty: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] }, verbose: false }, transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA' } };
for (const q of ['', '?limit=5', '?limit=100000']) {
  const r = await call('provider', S.auditor, 'POST', '/v2/updates' + q, { beginExclusive: 0, endInclusive: end, updateFormat: fmt });
  console.log(`updates${q}: HTTP ${r.status} count=${Array.isArray(r.json) ? r.json.length : 'n/a'}`, Array.isArray(r.json) ? '' : r.text.slice(0, 500));
}
