import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildRelay,
  buildTypeScriptSdk,
  parseMode,
  prepareWorkspace,
} from '../lib/workspace.mjs'
import { assertProtocolMatchesSharedFacts, sdkDriver } from '../lib/sdk-drivers.mjs'

// The Scenario Suite runner (e2e#5): one command per SDK lane —
//   node scripts/run-scenarios.mjs <ts|kotlin|swift> --mode <gate|dev>
const sdk = process.argv[2]
const driver = sdkDriver(sdk)
const mode = parseMode(process.argv.slice(3))
const layout = prepareWorkspace(mode)

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = mkdtempSync(join(tmpdir(), `trueseal-e2e-${sdk}-build-`))
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

// The protocol's vocabularies must match the pinned core's Shared Facts —
// drift fails the lane before anything builds (G12 discipline).
assertProtocolMatchesSharedFacts(layout)

if (sdk === 'ts') buildTypeScriptSdk(layout.tsRepo, run)
buildRelay(layout.relayRepo, relayBin, run)
run('go', ['build', '-o', duplicateInboxBin, '.'], join(layout.e2eRepo, 'scripts'))
driver.build(layout, run, artifacts)

execFileSync(resolve(relayBin), ['-h'], { stdio: 'ignore' })

const layoutJson = JSON.stringify({
  e2eRepo: layout.e2eRepo,
  tsRepo: layout.tsRepo,
  syncRepo: layout.syncRepo,
  relayRepo: layout.relayRepo,
  kotlinRepo: layout.kotlinRepo,
  swiftClientDir: layout.swiftClientDir,
})

run(
  process.execPath,
  ['--test', '--test-force-exit', join(repo, 'test', 'scenario-suite.test.mjs')],
  repo,
  {
    TRUESEAL_E2E_SDK: sdk,
    TRUESEAL_RELAY_BIN: resolve(relayBin),
    TRUESEAL_DUPLICATE_INBOX_BIN: resolve(duplicateInboxBin),
    TRUESEAL_TS_REPO: layout.tsRepo,
    TRUESEAL_E2E_LAYOUT: layoutJson,
    ...(process.env.TRUESEAL_SWIFT_DRIVER_BIN
      ? { TRUESEAL_SWIFT_DRIVER_BIN: process.env.TRUESEAL_SWIFT_DRIVER_BIN }
      : {}),
  },
)
