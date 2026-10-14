import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildRelay,
  buildTypeScriptSdk,
  laneNotRunPolicy,
  parseMode,
  prepareWorkspace,
} from '../lib/workspace.mjs'

const adapter = process.argv[2]
if (!['rust', 'swift'].includes(adapter)) {
  throw new Error('usage: node scripts/run-interop.mjs <rust|swift> --mode <gate|dev>')
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = parseMode(process.argv.slice(3))
const layout = prepareWorkspace(mode)

const artifacts = mkdtempSync(join(tmpdir(), `trueseal-${adapter}-build-`))
const relayBin = join(artifacts, 'trueseal-relay')

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

/** Returns true when the command succeeded. */
function tryRun(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (result.error) throw result.error
  return result.status === 0
}

if (process.env.TRUESEAL_E2E_SKIP_PREPARE !== '1') {
  buildTypeScriptSdk(layout.tsRepo, run)
  buildRelay(layout.relayRepo, relayBin, run)
} else if (!process.env.TRUESEAL_RELAY_BIN) {
  buildRelay(layout.relayRepo, relayBin, run)
}

const effectiveRelayBin = resolve(process.env.TRUESEAL_RELAY_BIN ?? relayBin)
let adapterBin = process.env.TRUESEAL_E2E_ADAPTER_BIN
let adapterBuilt = Boolean(adapterBin)

if (!adapterBin && adapter === 'rust') {
  const target = join(artifacts, 'rust')
  adapterBuilt = tryRun('cargo', [
    'build', '--locked',
    '--manifest-path', join(layout.rustClientDir, 'Cargo.toml'),
    '--target-dir', target,
  ], layout.e2eRepo)
  adapterBin = join(target, 'debug', 'trueseal-e2e-rust-client')
}

if (!adapterBin && adapter === 'swift') {
  const scratch = join(artifacts, 'swift')
  adapterBuilt = tryRun('swift', [
    'build', '--package-path', layout.swiftClientDir,
    '--scratch-path', scratch,
    '--product', 'trueseal-e2e-swift-client',
  ], layout.e2eRepo)
  adapterBin = join(scratch, 'debug', 'trueseal-e2e-swift-client')
}

// Visible-skip discipline (e2e ADR-0001: a lane that can't run reports
// "not run", never skips silently). A lane listed in gates/not-run.json may
// report not-run; a lane that builds while listed FAILS — the stale entry
// is drift and removing it is part of the tracking issue.
const lane = `${adapter}-interop`
const notRun = laneNotRunPolicy()[lane]

if (!adapterBuilt) {
  if (notRun) {
    console.log('')
    console.log('════════════════════════════════════════════════════════════════')
    console.log(`NOT RUN — ${lane} (tracked, non-silent)`)
    console.log(`reason: ${notRun.reason}`)
    console.log(`tracking: ${notRun.issue}`)
    console.log('════════════════════════════════════════════════════════════════')
    process.exit(0)
  }
  console.error(`lane ${lane} failed to build and is not listed in gates/not-run.json`)
  process.exit(1)
}

if (notRun) {
  console.error(
    `lane ${lane} builds, but gates/not-run.json still lists it — remove the stale entry ` +
    `(${notRun.issue})`,
  )
  process.exit(1)
}

execFileSync(effectiveRelayBin, ['-h'], { stdio: 'ignore' })
run(process.execPath, ['--test', '--test-force-exit', join(repo, 'test', 'interop.test.mjs')], repo, {
  TRUESEAL_RELAY_BIN: effectiveRelayBin,
  TRUESEAL_TS_REPO: layout.tsRepo,
  TRUESEAL_E2E_ADAPTER_NAME: adapter,
  TRUESEAL_E2E_ADAPTER_BIN: resolve(adapterBin),
  TRUESEAL_E2E_LAYOUT: JSON.stringify({
    e2eRepo: layout.e2eRepo,
    tsRepo: layout.tsRepo,
    syncRepo: layout.syncRepo,
    kotlinRepo: layout.kotlinRepo,
    swiftClientDir: layout.swiftClientDir,
  }),
})
