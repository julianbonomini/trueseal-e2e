import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
    // The jvm-test module applies no `application` plugin (KOTLIN-2 kept
    // it a pure test module), so there is no installDist/run task — the
    // harness compiles the classes and resolves the runtime classpath
    // through a gradle INIT SCRIPT kept in THIS repo (the kotlin checkout
    // is never modified), then spawns plain `java -cp`.
    build(layout, run, artifacts) {
      // UniFFI bindings + the pinned Linux x64 core (committed pin +
      // checksum, D11/KOTLIN-3 — fetch-core-artifacts.sh refuses drift).
      run('bash', ['scripts/fetch-core-artifacts.sh'], layout.kotlinRepo)
      run('bash', ['scripts/fetch-core-artifacts.sh', '--linux'], layout.kotlinRepo)
      const gradlew = join(layout.kotlinRepo, 'gradlew')
      const initScript = join(layout.e2eRepo, 'scripts', 'kotlin-driver-classpath.init.gradle')
      const result = execFileSync(
        gradlew,
        ['-I', initScript, ':jvm-test:classes', ':jvm-test:e2eRuntimeClasspath', '--console=plain', '-q'],
        { cwd: layout.kotlinRepo, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } },
      )
      const line = result.split('\n').find(candidate => candidate.startsWith('CLASSPATH:'))
      if (!line) {
        throw new Error(`kotlin driver: e2eRuntimeClasspath printed no CLASSPATH line:\n${result}`)
      }
      // Source-set output dirs with no sources (the kotlin-only module's
      // java/main) never materialize — keep the entries that exist.
      const classpath = line.slice('CLASSPATH:'.length).trim().split(':')
        .filter(entry => existsSync(entry))
        .join(':')
      if (!classpath.includes('jvm-test')) {
        throw new Error(`kotlin driver: resolved classpath has no jvm-test output: ${classpath}`)
      }
      // The resolved classpath crosses to the suite process via env
      // (module state does not survive the node --test spawn).
      process.env.TRUESEAL_KOTLIN_DRIVER_CLASSPATH = classpath
      writeFileSync(join(artifacts, 'kotlin-driver-classpath.txt'), classpath)
    },
    spawn({ layout, extraEnv = {} }) {
      const classpath = process.env.TRUESEAL_KOTLIN_DRIVER_CLASSPATH
      if (!classpath) {
        throw new Error('kotlin driver: TRUESEAL_KOTLIN_DRIVER_CLASSPATH is not set (the runner sets it after the build)')
      }
      const javaHome = process.env.JAVA_HOME
      const java = javaHome ? join(javaHome, 'bin', 'java') : 'java'
      return new DriverProcess({
        command: java,
        args: [
          `-Djna.library.path=${join(layout.kotlinRepo, 'jvm-test', 'native')}`,
          '-cp', classpath,
          'dev.trueseal.sync.driver.Main',
        ],
        env: { TERM: 'dumb', ...extraEnv },
        cwd: layout.kotlinRepo,
        name: 'kotlin',
      })
    },
  },

  swift: {
    name: 'swift',
    capabilities: [],
    // KNOWN DEVIATION (found by E2E-1's first Swift run, 2026-10-14): the
    // Swift SDK's applyStateChange stores the membersChanged EVENT payload
    // verbatim — and the core's event carries the full manifest list, SELF
    // INCLUDED — while initialization reads core.members() (self excluded).
    // So the public `members` flips self-inclusion when an event arrives,
    // contradicting ADR-0028's "members lists every other member" (TS and
    // Kotlin always exclude self). SDK-side fix: filter self in
    // applyStateChange + a regression test — filed for the Swift repo;
    // removing this entry re-enables the strict assertion below (the suite
    // FAILS if the strict check passes while this entry exists — stale
    // entries are drift, same discipline as gates/not-run.json).
    deviations: ['members-includes-self'],
    build(layout, run, artifacts) {
      const scratch = join(artifacts, 'swift-driver')
      // Debug configuration: the Release SIL pipeline crashes
      // swift-frontend on this file (Xcode 26 toolchain, SIL linker
      // segfault) — the old interop runner built Debug for the same
      // reason. A scenario driver has no performance bar.
      run('swift', [
        'build', '--package-path', layout.swiftClientDir,
        '--scratch-path', scratch,
        '--product', 'trueseal-e2e-swift-client',
      ], layout.e2eRepo)
      process.env.TRUESEAL_SWIFT_DRIVER_BIN = join(scratch, 'debug', 'trueseal-e2e-swift-client')
      // The built path crosses to the suite process via
      // TRUESEAL_SWIFT_DRIVER_BIN (set by the runner) — module state does
      // not survive the node --test spawn.
      const binary = this.binaryPath()
      if (!existsSync(binary)) {
        throw new Error(`swift driver: swift build did not produce ${binary}`)
      }
    },
    binaryPath() {
      const fromEnv = process.env.TRUESEAL_SWIFT_DRIVER_BIN
      if (fromEnv) return fromEnv
      throw new Error('swift driver: TRUESEAL_SWIFT_DRIVER_BIN is not set (the runner sets it after the build)')
    },
    spawn({ extraEnv = {} }) {
      return new DriverProcess({ command: this.binaryPath(), env: extraEnv, name: 'swift' })
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
