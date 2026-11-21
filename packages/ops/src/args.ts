/** Minimal `--key value` / `--key=value` parser for the allowed keys. */
export function parseArgs(argv: string[], allowed: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m || !allowed.includes(m[1])) throw new Error(`unknown argument: ${a}`)
    out[m[1]] = m[2] ?? argv[++i]
    if (out[m[1]] === undefined) throw new Error(`missing value for --${m[1]}`)
  }
  return out
}
