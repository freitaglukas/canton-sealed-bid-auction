import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTopology, type Topology } from '@sa/ledger-client'
import { isVetted, packageStatus, uploadDar } from './admin'
import { parseArgs } from './args'

/** The status literal LocalNet (Canton 3.6.4) actually returns for an uploaded package. */
export const EXPECTED_STATUS = 'PACKAGE_STATUS_REGISTERED'

export interface DeployRow {
  participant: string
  packageId: string
  status: string
  vetted: boolean
  error?: string
}

export function mainPackageId(darPath: string): string {
  const dpm = process.env.DPM ?? join(homedir(), '.dpm', 'bin', 'dpm')
  const out = execFileSync(dpm, ['damlc', 'inspect-dar', '--json', darPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const id = JSON.parse(out).main_package_id
  if (typeof id !== 'string' || !id) throw new Error(`no main_package_id in inspect-dar output for ${darPath}`)
  return id
}

/** Upload (with vetting) to every participant in the topology, then verify on each one. */
export async function deploy(darPath: string, topology: Topology): Promise<DeployRow[]> {
  if (!Object.keys(topology.participants).length) throw new Error('topology has no participants')
  const packageId = mainPackageId(darPath)
  const bytes = readFileSync(darPath)
  const rows: DeployRow[] = []
  for (const [participant, base] of Object.entries(topology.participants)) {
    const row: DeployRow = { participant, packageId, status: 'UNKNOWN', vetted: false }
    try {
      await uploadDar(base, bytes)
      row.status = (await packageStatus(base, packageId)) ?? 'NOT_FOUND'
      row.vetted = await isVetted(base, packageId)
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e)
    }
    rows.push(row)
  }
  return rows
}

export const deployOk = (r: DeployRow) => !r.error && r.status === EXPECTED_STATUS && r.vetted

async function main() {
  const args = parseArgs(process.argv.slice(2), ['dar', 'topology'])
  if (!args.dar) throw new Error('usage: deploy --dar <abs path> [--topology <abs path>]')
  const rows = await deploy(args.dar, loadTopology(args.topology))
  for (const r of rows)
    console.log(
      `${r.participant.padEnd(14)} package=${r.packageId} status=${r.status} vetted=${r.vetted ? 'yes' : 'no'}${r.error ? ` ERROR=${r.error}` : ''}`,
    )
  const bad = rows.filter((r) => !deployOk(r))
  if (bad.length) {
    console.error(`deploy FAILED on: ${bad.map((r) => r.participant).join(', ')}`)
    process.exit(1)
  }
  console.log(`deploy OK on ${rows.length} participant(s)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
