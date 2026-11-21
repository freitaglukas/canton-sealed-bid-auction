// Allocate probe parties on sv / provider / user nodes, create users, probe auditor CanReadAsAnyParty.
import { NODES, call, rand, ADMIN, allocParty, createUser, actAs, readAs, readAny, submit, create, createdCid, acs, wildcardTpl, saveState, ledgerEnd } from './lib.mjs';

const r = rand();
const S = { r };
S.svParty = await allocParty('sv', `probe-${r}-sv`);
S.provParty = await allocParty('provider', `probe-${r}-prov`);
S.userParty = await allocParty('user', `probe-${r}-usr`);
console.log('parties', S);

// users with own-party rights
S.svUser = `probe-${r}-svu`; S.provUser = `probe-${r}-provu`; S.userUser = `probe-${r}-usru`;
await createUser('sv', S.svUser, S.svParty, [actAs(S.svParty), readAs(S.svParty)]);
await createUser('provider', S.provUser, S.provParty, [actAs(S.provParty), readAs(S.provParty)]);
await createUser('user', S.userUser, S.userParty, [actAs(S.userParty), readAs(S.userParty)]);

// Auditor users, CanReadAsAnyParty on each node
S.auditor = `probe-${r}-auditor`;
for (const n of ['sv', 'provider', 'user']) await createUser(n, S.auditor, '', [readAny()]);
// rights listing for evidence
console.log('auditor rights on sv:', (await call('sv', ADMIN, 'GET', `/v2/users/${S.auditor}/rights`)).text);

// Positive control: sv-hosted party creates P (obs = user-node party, cross-participant)
const c1 = await submit('sv', S.svUser, [S.svParty], [create(S.svParty, [S.userParty])]);
console.log('create on sv:', c1.status, c1.text.slice(0, 200));
S.svCid = createdCid(c1);
// provider-hosted party creates P with no observers
const c2 = await submit('provider', S.provUser, [S.provParty], [create(S.provParty, [])]);
console.log('create on provider:', c2.status);
S.provCid = createdCid(c2);
// user-node party creates P
const c3 = await submit('user', S.userUser, [S.userParty], [create(S.userParty, [])]);
S.userCid = createdCid(c3);

const anyFmt = { filtersForAnyParty: wildcardTpl, verbose: true };
for (const n of ['sv', 'provider', 'user']) {
  const a = await acs(n, S.auditor, anyFmt);
  const cids = Array.isArray(a.json) ? a.json.map((e) => e.contractEntry?.JsActiveContract?.createdEvent?.contractId) : a.text.slice(0, 300);
  console.log(`auditor filtersForAnyParty on ${n}: status=${a.status}`, JSON.stringify(cids));
}
// Control: auditor with filtersByParty for sv party, and without filtersForAnyParty
const a2 = await acs('sv', S.auditor, { filtersByParty: { [S.svParty]: wildcardTpl }, verbose: true });
console.log('auditor byParty sv:', a2.status, a2.text.slice(0, 300));
// Negative control: non-auditor sv user using filtersForAnyParty
const a3 = await acs('sv', S.svUser, anyFmt);
console.log('non-auditor svUser filtersForAnyParty:', a3.status, a3.text.slice(0, 400));
S.ids = { sv: S.svCid, provider: S.provCid, user: S.userCid };
saveState(S);
console.log('ledger ends', await ledgerEnd('sv'));
