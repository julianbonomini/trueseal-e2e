import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRelay, buildTypeScriptSdk, parseMode, prepareWorkspace } from '../lib/workspace.mjs'

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

if (process.env.TRUESEAL_E2E_SKIP_PREPARE !== '1') {
  buildTypeScriptSdk(layout.tsRepo, run)
  buildRelay(layout.relayRepo, relayBin, run)
  // duplicate-inbox.go resolves modernc.org/sqlite through the relay's go.mod,
  // so it builds with the relay checkout as its working directory.
  run('go', ['build', '-o', duplicateInboxBin, join(layout.e2eRepo, 'scripts', 'duplicate-inbox.go')], layout.relayRepo)
} else if (!process.env.TRUESEAL_RELAY_BIN) {
  buildRelay(layout.relayRepo, relayBin, run)
}

if (process.env.TRUESEAL_E2E_SKIP_PREPARE === '1' && !process.env.TRUESEAL_DUPLICATE_INBOX_BIN) {
  run('go', ['build', '-o', duplicateInboxBin, join(layout.e2eRepo, 'scripts', 'duplicate-inbox.go')], layout.relayRepo)
}

const effectiveRelayBin = resolve(process.env.TRUESEAL_RELAY_BIN ?? relayBin)
const effectiveDuplicateInboxBin = resolve(
  process.env.TRUESEAL_DUPLICATE_INBOX_BIN ?? duplicateInboxBin,
)
execFileSync(effectiveRelayBin, ['-h'], { stdio: 'ignore' })

run(
  process.execPath,
  ['--test', '--test-force-exit', join(repo, 'test', 'system.test.mjs')],
  repo,
  {
    TRUESEAL_RELAY_BIN: effectiveRelayBin,
    TRUESEAL_DUPLICATE_INBOX_BIN: effectiveDuplicateInboxBin,
    TRUESEAL_TS_REPO: layout.tsRepo,
  },
)
