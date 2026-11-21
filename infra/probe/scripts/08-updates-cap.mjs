// Push provider past 200 updates (probe-owned txs), then see how /v2/updates behaves over the cap.
import { call, submit, create, loadState, ledgerEnd } from './lib.mjs';
const S = loadState();
const N = Number(process.argv[2] ?? 230);
for (let i = 0; i < N; i += 10) {
  await Promise.all(Array.from({ length: Math.min(10, N - i) }, () => submit('provider', S.provUser, [S.provParty], [create(S.provParty, [])])));
}
const end = await ledgerEnd('provider');
console.log('provider ledger end', end);
const fmt = { includeTransactions: { eventFormat: { filtersForAnyParty: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] }, verbose: false }, transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA' } };
for (const q of ['', '?limit=5', '?limit=250', '?limit=100000']) {
  const r = await call('provider', S.auditor, 'POST', '/v2/updates' + q, { beginExclusive: 0, endInclusive: end, updateFormat: fmt });
  const n = Array.isArray(r.json) ? r.json.length : 'n/a';
  const last = Array.isArray(r.json) ? JSON.stringify(r.json.at(-1)).match(/"offset":(\d+)/)?.[1] : '';
  console.log(`updates${q}: HTTP ${r.status} count=${n} lastOffset=${last}`, Array.isArray(r.json) ? '' : r.text.slice(0, 500));
}
// paging: resume from last offset
const r1 = await call('provider', S.auditor, 'POST', '/v2/updates', { beginExclusive: 0, endInclusive: end, updateFormat: fmt });
if (Array.isArray(r1.json)) {
  const lastOff = Number(JSON.stringify(r1.json.at(-1)).match(/"offset":(\d+)/)?.[1]);
  const r2 = await call('provider', S.auditor, 'POST', '/v2/updates', { beginExclusive: lastOff, endInclusive: end, updateFormat: fmt });
  console.log('page 2 from', lastOff, '->', r2.status, Array.isArray(r2.json) ? r2.json.length : r2.text.slice(0, 300));
}
// ACS paging/cap for reference
const a = await call('provider', S.auditor, 'POST', '/v2/state/active-contracts', { activeAtOffset: end, eventFormat: { filtersForAnyParty: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] }, verbose: false } });
console.log('ACS any-party:', a.status, Array.isArray(a.json) ? a.json.length : a.text.slice(0, 400));
