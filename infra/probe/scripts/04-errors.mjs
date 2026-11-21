// Capture real error bodies into packages/ledger-client/test/fixtures/*.json
import { call, submit, create, exercise, createdCid, acs, TPL, loadState, saveFixture, rand } from './lib.mjs';

const S = loadState();
const show = (n, r) => console.log(`--- ${n}: HTTP ${r.status}\n${r.text.slice(0, 900)}`);

// 1. not-found: syntactically valid cid that does not exist
const fake = S.svCid.slice(0, 10) + 'ab'.repeat(28) + S.svCid.slice(66); // keep 00 + 32-byte hash length + 1220.. suffix
let r = await submit('sv', S.svUser, [S.svParty], [exercise(fake, 'P_Consume')]);
show('not-found', r); saveFixture('not-found', r);

// 2. authorization: provider-node party exercises sv-owned contract using disclosure
const blobRes = await acs('sv', S.svUser, {
  filtersByParty: { [S.svParty]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: TPL, includeCreatedEventBlob: true } } } }] } },
  verbose: false,
});
const ce = blobRes.json.find((e) => e.contractEntry.JsActiveContract.createdEvent.contractId === S.svCid).contractEntry.JsActiveContract.createdEvent;
const disclosed = [{ templateId: ce.templateId, contractId: ce.contractId, createdEventBlob: ce.createdEventBlob, synchronizerId: blobRes.json[0].contractEntry.JsActiveContract.synchronizerId }];
r = await submit('provider', S.provUser, [S.provParty], [exercise(S.svCid, 'P_Consume')], { disclosedContracts: disclosed });
show('authorization (disclosed, provider node)', r); saveFixture('authorization', r);
// variant: observer on user node (no disclosure)
const r2 = await submit('user', S.userUser, [S.userParty], [exercise(S.svCid, 'P_Consume')]);
show('authorization variant (observer, user node)', r2); saveFixture('authorization-observer', r2);
// variant: HTTP-level 403 (token without rights for party)
const r3 = await submit('provider', S.provUser, [S.userParty], [create(S.userParty)]);
show('authorization variant (no CanActAs)', r3); saveFixture('authorization-noright', r3);

// 3. assertion
const own = createdCid(await submit('provider', S.provUser, [S.provParty], [create(S.provParty, [])]));
r = await submit('provider', S.provUser, [S.provParty], [exercise(own, 'P_Fail')]);
show('assertion', r); saveFixture('assertion', r);
r = await submit('provider', S.provUser, [S.provParty], [exercise(own, 'P_FailStatus')]);
show('assertion-status', r); saveFixture('assertion-status', r);

// 4. contention: N tries, two concurrent P_Consume on same cid
let got = null;
for (let i = 0; i < 6 && !got; i++) {
  const c = createdCid(await submit('provider', S.provUser, [S.provParty], [create(S.provParty, [])]));
  const rs = await Promise.all([0, 1].map(() => submit('provider', S.provUser, [S.provParty], [exercise(c, 'P_Consume')])));
  console.log(`try ${i}: statuses`, rs.map((x) => x.status));
  const loser = rs.find((x) => x.status !== 200);
  if (loser) { got = loser; got.cid = c; }
}
if (got) { show('contention (true race)', got); saveFixture('contention', got); }
else console.log('NO RACE obtained');
// already archived (sequential)
const c = createdCid(await submit('provider', S.provUser, [S.provParty], [create(S.provParty, [])]));
await submit('provider', S.provUser, [S.provParty], [exercise(c, 'P_Consume')]);
r = await submit('provider', S.provUser, [S.provParty], [exercise(c, 'P_Consume')]);
show('already-archived (sequential)', r); saveFixture('already-archived', r);
