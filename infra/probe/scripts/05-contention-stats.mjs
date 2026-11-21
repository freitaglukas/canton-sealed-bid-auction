// Repeat the concurrent-consume race to see which loser codes occur.
import { submit, create, exercise, createdCid, loadState } from './lib.mjs';
const S = loadState();
const tally = {};
for (let i = 0; i < 12; i++) {
  const c = createdCid(await submit('provider', S.provUser, [S.provParty], [create(S.provParty, [])]));
  const rs = await Promise.all([0, 1].map(() => submit('provider', S.provUser, [S.provParty], [exercise(c, 'P_Consume')])));
  for (const x of rs) { const k = `${x.status} ${x.json?.code ?? 'ok'}`; tally[k] = (tally[k] ?? 0) + 1; }
}
console.log(tally);
