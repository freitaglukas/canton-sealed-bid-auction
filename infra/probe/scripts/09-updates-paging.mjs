// Page /v2/updates with limit=100 using beginExclusive = last offset.
import { call, loadState, ledgerEnd } from './lib.mjs';
const S = loadState();
const end = await ledgerEnd('provider');
const fmt = { includeTransactions: { eventFormat: { filtersForAnyParty: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] }, verbose: false }, transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA' } };
let begin = 0, total = 0;
for (;;) {
  const r = await call('provider', S.auditor, 'POST', '/v2/updates?limit=100', { beginExclusive: begin, endInclusive: end, updateFormat: fmt });
  if (r.status !== 200) { console.log('error', r.status, r.text.slice(0, 200)); break; }
  const n = r.json.length; total += n;
  const off = r.json.at(-1)?.update?.Transaction?.value?.offset;
  console.log('page', { n, lastOffset: off });
  if (n < 100) break;
  begin = off;
}
console.log('total', total);
