// Shared helpers for live probes. Node >= 20. HS256 secret "unsafe".
import { createHmac, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Run order: 03 creates ../.state.json, which 04-09 need. Env overrides: PROVIDER_URL USER_URL SV_URL LEDGER_SECRET DPM.
export const NODES = { provider: process.env.PROVIDER_URL ?? 'http://localhost:3975', user: process.env.USER_URL ?? 'http://localhost:2975', sv: process.env.SV_URL ?? 'http://localhost:4975' };
const fallbackDpm = `${process.env.HOME}/.dpm/bin/dpm`;
export const DPM = process.env.DPM ?? (() => {
  try { return execSync('command -v dpm', { shell: '/bin/sh' }).toString().trim() || fallbackDpm; } catch { return fallbackDpm; }
})();
export const TPL = '#sa-probe:Probe:P';
const b64 = (x) => Buffer.from(x).toString('base64url');
export const jwt = (sub) => {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({ sub, aud: 'https://canton.network.global' }));
  return `${h}.${p}.${createHmac('sha256', process.env.LEDGER_SECRET ?? 'unsafe').update(`${h}.${p}`).digest('base64url')}`;
};
export const rand = () => randomBytes(3).toString('hex');

/** Returns { status, body (raw text), json (parsed or null) } */
export async function call(node, sub, method, path, body, headers = {}) {
  const res = await fetch(NODES[node] + path, {
    method,
    headers: { Authorization: `Bearer ${jwt(sub)}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}
export const ADMIN = 'ledger-api-user';

export async function allocParty(node, hint) {
  const r = await call(node, ADMIN, 'POST', '/v2/parties', { partyIdHint: hint, identityProviderId: '' });
  if (r.status !== 200) throw new Error(`allocParty ${node} ${r.status} ${r.text}`);
  return r.json.partyDetails.party;
}
export async function createUser(node, id, primaryParty, rights) {
  const r = await call(node, ADMIN, 'POST', '/v2/users', {
    user: { id, primaryParty, isDeactivated: false, identityProviderId: '' },
    rights,
  });
  if (r.status !== 200) throw new Error(`createUser ${node} ${r.status} ${r.text}`);
  return r.json;
}
export const actAs = (party) => ({ kind: { CanActAs: { value: { party } } } });
export const readAs = (party) => ({ kind: { CanReadAs: { value: { party } } } });
export const readAny = () => ({ kind: { CanReadAsAnyParty: { value: {} } } });

export async function ledgerEnd(node) {
  return (await call(node, ADMIN, 'GET', '/v2/state/ledger-end')).json.offset;
}
export const effectsFormat = (party) => ({
  eventFormat: { filtersByParty: { [party]: { cumulative: [] } }, verbose: true },
  transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
});
/** submit commands as user (sub=userId) acting as parties */
export function submit(node, userId, actAsParties, commands, extra = {}) {
  return call(node, userId, 'POST', '/v2/commands/submit-and-wait-for-transaction', {
    commands: {
      commands,
      commandId: `probe-${rand()}-${Date.now()}`,
      userId,
      actAs: actAsParties,
      readAs: [],
      ...extra,
    },
    transactionFormat: effectsFormat(actAsParties[0]),
  });
}
export const create = (owner, obs = [], tpl = TPL) => ({ CreateCommand: { templateId: tpl, createArguments: { owner, obs } } });
export const exercise = (cid, choice, tpl = TPL, arg = {}) => ({
  ExerciseCommand: { templateId: tpl, contractId: cid, choice, choiceArgument: arg },
});
export const createdCid = (r) => {
  const ev = r.json.transaction.events.find((e) => e.CreatedEvent);
  return ev.CreatedEvent.contractId;
};
export async function acs(node, sub, eventFormat) {
  const off = await ledgerEnd(node);
  return call(node, sub, 'POST', '/v2/state/active-contracts', { activeAtOffset: off, eventFormat });
}
export const wildcardTpl = { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: TPL, includeCreatedEventBlob: false } } } }] };

const STATE = new URL('../.state.json', import.meta.url).pathname;
export const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
export const loadState = () => JSON.parse(readFileSync(STATE, 'utf8'));
export const FIX = new URL('../../../packages/ledger-client/test/fixtures/', import.meta.url).pathname;
export const saveFixture = (name, r) => {
  const body = r.json ?? { _raw: r.text };
  writeFileSync(FIX + name + '.json', JSON.stringify({ ...body, _httpStatus: r.status }, null, 2) + '\n');
};
