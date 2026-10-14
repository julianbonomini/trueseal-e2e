import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildRelay, buildTypeScriptSdk, parseMode, prepareWorkspace } from '../lib/workspace.mjs'

// E2E-7 / gate G7: the relay log + store privacy check, as its own gate leg.
// Builds the pinned (gate) or sibling (dev) relay + TypeScript SDK, then runs
// test/privacy.test.mjs against the real binary over real TCP in both logging
// modes. Release Evidence JSON lands in TRUESEAL_E2E_EVIDENCE_DIR (CI
// uploads it; the default is gates/evidence/ in the working tree).

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = parseMode(process.argv.slice(2))
const layout = prepareWorkspace(mode)

const artifacts = mkdtempSync(join(tmpdir(), 'trueseal-e2e-build-'))
const relayBin = join(artifacts, 'trueseal-relay')
const duplicateInboxBin = join(artifacts, 'duplicate-inbox')

process.on('exit', () => {
  rmSync(artifacts, { recursive: true, force: true })
  layout.cleanup()
})

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

buildTypeScriptSdk(layout.tsRepo, run)
buildRelay(layout.relayRepo, relayBin, run)
// duplicate-inbox has its own module (scripts/go.mod) so its regression
// tests run without a relay checkout (E3b).
run('go', ['build', '-o', duplicateInboxBin, '.'], join(layout.e2eRepo, 'scripts'))

let pins = {}
if (mode === 'gate') {
  pins = JSON.parse(readFileSync(join(layout.e2eRepo, 'pins.json'), 'utf8')).pins
}

run(
  process.execPath,
  ['--test', '--test-force-exit', join(repo, 'test', 'privacy.test.mjs')],
  repo,
  {
    TRUESEAL_RELAY_BIN: resolve(relayBin),
    TRUESEAL_DUPLICATE_INBOX_BIN: resolve(duplicateInboxBin),
    TRUESEAL_TS_REPO: layout.tsRepo,
    TRUESEAL_E2E_MODE: mode,
    TRUESEAL_E2E_PINS: JSON.stringify(pins),
    TRUESEAL_E2E_EVIDENCE_DIR: process.env.TRUESEAL_E2E_EVIDENCE_DIR ?? join(repo, 'gates', 'evidence'),
  },
)
