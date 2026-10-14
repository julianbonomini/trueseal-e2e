import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DriverProcess } from './driver-process.mjs'

/**
 * One entry per SDK in the G1 matrix (e2e ADR-0001): how the harness builds
 * its Scenario Driver and how a scenario spawns one driver process. Every
 * driver speaks Protocol Version 1 (docs/scenario-driver-protocol.md); the
 * Kotlin driver lives in trueseal-sync-kotlin's jvm-test module (KOTLIN-2)
 * and is consumed as-is — this repo never modifies SDK checkouts.
 *
 * `capabilities` names the harness-only fault hooks a driver supports;
 * scenarios that need a capability a driver lacks report NOT RUN loudly
 * (scenario-granular visible-skip, same discipline as gates/not-run.json).
 */
export const SDK_DRIVERS = {
  ts: {
    name: 'ts',
    capabilities: ['dropBeforeCommit'],
    build(layout, run, _artifacts) {
      // The TS SDK is installed+built by the runner (buildTypeScriptSdk) —
      // nothing driver-specific here. The driver resolves it via
      // TRUESEAL_TS_REPO, which in gate mode points inside the pinned tree.
      if (!existsSync(join(layout.tsRepo, 'index.js'))) {
        throw new Error(`ts driver: the SDK at ${layout.tsRepo} is not built (index.js missing)`)
      }
    },
    spawn({ layout, stateDir: _stateDir, extraEnv = {} }) {
      return new DriverProcess({
        command: process.execPath,
        args: [join(layout.e2eRepo, 'clients', 'typescript.mjs')],
        env: { TRUESEAL_TS_REPO: layout.tsRepo, ...extraEnv },
        name: 'ts',
      })
    },
  },

  kotlin: {
    name: 'kotlin',
    capabilities: [],
    build(layout, run, _artifacts) {
      // UniFFI bindings + the pinned Linux x64 core (committed pin +
      // checksum, D11/KOTLIN-3 — fetch-core-artifacts.sh refuses drift).
      run('bash', ['scripts/fetch-core-artifacts.sh'], layout.kotlinRepo)
      run('bash', ['scripts/fetch-core-artifacts.sh', '--linux'], layout.kotlinRepo)
      const gradlew = join(layout.kotlinRepo, 'gradlew')
      run(gradlew, [':jvm-test:installDist', '--console=plain', '-q'], layout.kotlinRepo, {
        TERM: 'dumb',
      })
      const binary = this.binaryPath(layout)
      if (!existsSync(binary)) {
        throw new Error(`kotlin driver: installDist did not produce ${binary}`)
      }
    },
    binaryPath(layout) {
      return join(layout.kotlinRepo, 'jvm-test', 'build', 'install', 'jvm-test', 'bin', 'jvm-test')
    },
    spawn({ layout, extraEnv = {} }) {
      // The installDist start script sets -Djna.library.path to the pinned
      // Linux core (jvm-test README).
      return new DriverProcess({
        command: this.binaryPath(layout),
        env: { TERM: 'dumb', ...extraEnv },
        cwd: layout.kotlinRepo,
        name: 'kotlin',
      })
    },
  },

  swift: {
    name: 'swift',
    capabilities: [],
    build(layout, run, artifacts) {
      const scratch = join(artifacts, 'swift-driver')
      run('swift', [
        'build', '--package-path', layout.swiftClientDir,
        '--scratch-path', scratch,
        '--product', 'trueseal-e2e-swift-client',
        '-c', 'release',
      ], layout.e2eRepo)
      this.binary = join(scratch, 'release', 'trueseal-e2e-swift-client')
      if (!existsSync(this.binary)) {
        throw new Error(`swift driver: swift build did not produce ${this.binary}`)
      }
    },
    spawn({ extraEnv = {} }) {
      return new DriverProcess({ command: this.binary, env: extraEnv, name: 'swift' })
    },
  },
}

export function sdkDriver(name) {
  const driver = SDK_DRIVERS[name]
  if (!driver) {
    throw new Error(`unknown SDK "${name}" — expected one of: ${Object.keys(SDK_DRIVERS).join(', ')}`)
  }
  return driver
}

/**
 * The G12 discipline at the harness level: scenarios/protocol.json's error
 * codes must equal the pinned core's shared-facts.json `errors` list.
 * Drift fails the run.
 */
export function assertProtocolMatchesSharedFacts(layout) {
  const protocol = JSON.parse(
    readFileSync(join(layout.e2eRepo, 'scenarios', 'protocol.json'), 'utf8'),
  )
  const facts = JSON.parse(
    readFileSync(join(layout.syncRepo, 'docs', 'shared-facts.json'), 'utf8'),
  )
  const expected = JSON.stringify(facts.errors)
  const actual = JSON.stringify(protocol.errorCodes)
  if (actual !== expected) {
    throw new Error(
      `scenarios/protocol.json errorCodes drifted from the pinned core's shared-facts.json:\n` +
        `  protocol:    ${actual}\n  shared-facts: ${expected}`,
    )
  }
  return protocol
}

/** The relay address every driver opens against (harness ports explicit). */
export function relayAddress(relay) {
  return `trueseal://${relay.publicKey}@127.0.0.1:7700?push=7701`
}

export { execFileSync }
