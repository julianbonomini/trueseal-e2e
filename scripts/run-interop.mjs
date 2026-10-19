import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

// The G2 Interop Smoke runner (E2E-4, #8): one command per SDK PAIR —
//   node scripts/run-interop.mjs <ts-ts|ts-swift|ts-kotlin|swift-swift|swift-kotlin|kotlin-kotlin> --mode <gate|dev>
//
// Topology (e2e ADR-0001: "A lane the host can't run, such as Swift off
// macOS, reports 'not run', and the gate counts that as a failure"):
// Swift drivers are macOS-only; the Kotlin JVM driver's pinned native
// artifact is Linux-x64-only. The harness is single-host, so pairs are
// assigned to the one runner OS that hosts both sides:
//   ubuntu-latest: ts-ts, ts-kotlin, kotlin-kotlin   (Kotlin's pinned .so)
//   macos-latest:  swift-swift, swift-ts, swift-kotlin (Kotlin builds the
//                  pinned core's cdylib from source — see
//                  lib/sdk-drivers.mjs; the pinned INPUT is the same
//                  pins.json SHA either way, G8)
// A pair scheduled on the wrong host is a wiring bug: this runner fails
// loudly (exit 1) rather than skipping.
//
// The pre-E2E-4 Rust↔TS lane is RETIRED (per the issue: the Rust client is
// not an SDK — its code is E2E-5's Adversary Client base, tracked in #9).

const PAIRS = ['ts-ts', 'ts-swift', 'ts-kotlin', 'swift-swift', 'swift-kotlin', 'kotlin-kotlin']

const pair = process.argv[2]
if (!PAIRS.includes(pair)) {
  throw new Error(`usage: node scripts/run-interop.mjs <${PAIRS.join('|')}> --mode <gate|dev>`)
}
const [sdkA, sdkB] = pair.split('-')
const sdks = [...new Set([sdkA, sdkB])]

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = parseMode(process.argv.slice(3))

// Host capability: fail loudly on a mis-scheduled leg (never a silent
// skip — the gate counts an unrunnable pair as a failure by design).
if (sdks.includes('swift') && process.platform !== 'darwin') {
  console.error(`NOT RUN — pair ${pair} needs macOS (the Swift driver is macOS-only); this leg is mis-scheduled`)
  process.exit(1)
}
if (sdks.includes('kotlin') && !['darwin', 'linux'].includes(process.platform)) {
  console.error(`NOT RUN — pair ${pair}: the Kotlin JVM driver runs on Linux (pinned artifact) or macOS (source-built pinned core), not ${process.platform}`)
  process.exit(1)
}

const layout = prepareWorkspace(mode)
const artifacts = mkdtempSync(join(tmpdir(), `trueseal-interop-${pair}-build-`))
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

// The protocol's vocabularies must match the pinned core's Shared Facts —
// drift fails the lane before anything builds (G12 discipline).
assertProtocolMatchesSharedFacts(layout)

if (sdks.includes('ts')) buildTypeScriptSdk(layout.tsRepo, run)
buildRelay(layout.relayRepo, relayBin, run)
for (const sdk of sdks) sdkDriver(sdk).build(layout, run, artifacts)

execFileSync(resolve(relayBin), ['-h'], { stdio: 'ignore' })

const evidenceDir = process.env.TRUESEAL_E2E_EVIDENCE_DIR ?? join(repo, 'gates', 'evidence')
const pins = mode === 'gate'
  ? JSON.parse(readFileSync(join(repo, 'pins.json'), 'utf8')).pins
  : undefined

execFileSync(
  process.execPath,
  ['--test', '--test-force-exit', join(repo, 'test', 'interop-pair.test.mjs')],
  {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...process.env,
      TRUESEAL_E2E_PAIR: pair,
      TRUESEAL_RELAY_BIN: resolve(relayBin),
      TRUESEAL_TS_REPO: layout.tsRepo,
      TRUESEAL_E2E_MODE: mode,
      TRUESEAL_E2E_EVIDENCE: join(evidenceDir, `g2-interop-${pair}.json`),
      ...(pins ? { TRUESEAL_E2E_PINS: JSON.stringify(pins) } : {}),
      TRUESEAL_E2E_LAYOUT: JSON.stringify({
        e2eRepo: layout.e2eRepo,
        tsRepo: layout.tsRepo,
        syncRepo: layout.syncRepo,
        relayRepo: layout.relayRepo,
        kotlinRepo: layout.kotlinRepo,
        swiftClientDir: layout.swiftClientDir,
      }),
      // Driver build() exports cross this process boundary via env (module
      // state does not survive the node --test spawn).
      ...(process.env.TRUESEAL_SWIFT_DRIVER_BIN
        ? { TRUESEAL_SWIFT_DRIVER_BIN: process.env.TRUESEAL_SWIFT_DRIVER_BIN }
        : {}),
      ...(process.env.TRUESEAL_KOTLIN_DRIVER_CLASSPATH
        ? { TRUESEAL_KOTLIN_DRIVER_CLASSPATH: process.env.TRUESEAL_KOTLIN_DRIVER_CLASSPATH }
        : {}),
      ...(process.env.TRUESEAL_KOTLIN_NATIVE_DIR
        ? { TRUESEAL_KOTLIN_NATIVE_DIR: process.env.TRUESEAL_KOTLIN_NATIVE_DIR }
        : {}),
    },
  },
)
