import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(repo, '..')
const relayRepo = resolve(process.env.TRUESEAL_RELAY_REPO ?? join(workspace, 'trueseal-relay'))
const tsRepo = resolve(process.env.TRUESEAL_TS_REPO ?? join(workspace, 'trueseal-sync-ts'))
const artifacts = mkdtempSync(join(tmpdir(), 'trueseal-e2e-build-'))
const relayBin = join(artifacts, 'trueseal-relay')

process.on('exit', () => rmSync(artifacts, { recursive: true, force: true }))

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.env.TRUESEAL_E2E_SKIP_PREPARE !== '1') {
  run('npm', ['ci', '--registry=https://registry.npmjs.org'], tsRepo)
  run('npm', ['run', 'build'], tsRepo)
  run('go', ['build', '-o', relayBin, './cmd/trueseal-relay'], relayRepo)
} else if (!process.env.TRUESEAL_RELAY_BIN) {
  run('go', ['build', '-o', relayBin, './cmd/trueseal-relay'], relayRepo)
}

const effectiveRelayBin = resolve(process.env.TRUESEAL_RELAY_BIN ?? relayBin)
execFileSync(effectiveRelayBin, ['-h'], { stdio: 'ignore' })

run(
  process.execPath,
  ['--test', '--test-force-exit', join(repo, 'test', 'system.test.mjs')],
  repo,
  {
    TRUESEAL_RELAY_BIN: effectiveRelayBin,
    TRUESEAL_TS_REPO: tsRepo,
  },
)
