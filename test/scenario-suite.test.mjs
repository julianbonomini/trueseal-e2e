import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { RelayProcess } from '../lib/relay-process.mjs'
import { sdkDriver, relayAddress } from '../lib/sdk-drivers.mjs'
import { runLifecycle } from '../scenarios/lifecycle.mjs'
import { runPairing } from '../scenarios/pairing.mjs'
import { runDelivery } from '../scenarios/delivery.mjs'
import { runMembership } from '../scenarios/membership.mjs'
import { runDestroy } from '../scenarios/destroy.mjs'
import { runTtl } from '../scenarios/ttl.mjs'
import { runLimits } from '../scenarios/limits.mjs'
import { runVersions } from '../scenarios/versions.mjs'
import { runUpgrades } from '../scenarios/upgrades.mjs'
import { runAdversary } from '../scenarios/adversary.mjs'
import { TS_ONLY_SCENARIOS } from '../scenarios/ts-only.mjs'

// The Scenario Suite (G1): one shared Scenario Driver runs the same
// scenario files against the SDK named by TRUESEAL_E2E_SDK, through
// Protocol Version 1, against the real (pinned, in gate mode) relay.
const sdkName = process.env.TRUESEAL_E2E_SDK
const driver = sdkDriver(sdkName)
const relayBinary = resolve(process.env.TRUESEAL_RELAY_BIN)
const hostileRelayBinary = resolve(process.env.TRUESEAL_HOSTILE_RELAY_BIN)
const adversaryBinary = resolve(process.env.TRUESEAL_ADVERSARY_BIN)
const duplicateInbox = resolve(process.env.TRUESEAL_DUPLICATE_INBOX_BIN)
const layout = JSON.parse(process.env.TRUESEAL_E2E_LAYOUT)
const root = mkdtempSync(join(tmpdir(), `trueseal-e2e-suite-${sdkName}-`))

test(`scenario suite: ${sdkName} driver through the shared Scenario Driver`, { timeout: 600_000 }, async t => {
  const relay = new RelayProcess({ binary: relayBinary, stateDir: join(root, 'relay') })
  const clients = []

  const ctx = {
    relay,
    duplicateInbox,
    knownDeviations: driver.deviations ?? [],
    sdk: sdkName,
    root,
    e2eRepo: layout.e2eRepo,
    relayRepo: layout.relayRepo,
    get relayAddress() {
      return relayAddress(relay)
    },
    /** Waits for the main relay's inbox to drain. Delivered rows are
     *  deleted on ack; an event's notification is emitted INSIDE the
     *  driver's handler, so the ack trails the event — any test that
     *  stops a client right after receiving must drain FIRST, or the
     *  stop strands the row (30-day TTL) and poisons later wait-empty
     *  assertions (gate/scenario-kotlin, run 38542388595). */
    drain() {
      execFileSync(duplicateInbox, ['wait-empty', relay.database], {
        env: { ...process.env, DUPLICATE_INBOX_TIMEOUT_S: '30' },
      })
    },
    /** A second relay process on the same ports (use only while the main
     *  relay is stopped) — e.g. the G6 committed store fixture. */
    spawnRelay(stateDir, extraEnv = {}) {
      return new RelayProcess({ binary: relayBinary, stateDir, extraEnv })
    },
    /** The Hostile Relay (RELAY-14): the same pinned relay built with the
     *  `hostile` tag, control listener on 127.0.0.1:7703. Same port rule:
     *  only while the main relay is stopped. */
    spawnHostileRelay(stateDir, extraEnv = {}) {
      return new RelayProcess({ binary: hostileRelayBinary, stateDir, extraEnv, hostile: true })
    },
    /** The Adversary Client (E2E-5): the hostile-traffic lane. Speaks the
     *  driver line protocol (plus adversary-only commands) so DriverProcess
     *  handles it unmodified. */
    async spawnAdversary(name, targetRelay) {
      const stateDir = join(root, name)
      mkdirSync(stateDir, { recursive: true })
      const { DriverProcess } = await import('../lib/driver-process.mjs')
      const process = new DriverProcess({
        command: adversaryBinary,
        args: ['--state-dir', stateDir, '--relay-host', '127.0.0.1', '--relay-pub', targetRelay.publicKey],
        name,
      })
      await process.start()
      process.stateDir = stateDir
      clients.push(process)
      return process
    },
    /** Spawns a driver WITHOUT opening a session (the storeTooNew row
     *  must drive `open` itself to catch the typed failure). */
    async spawnOnly(name, { stateDir = join(root, name), extraEnv = {} } = {}) {
      mkdirSync(stateDir, { recursive: true })
      const process = driver.spawn({ layout, stateDir, extraEnv })
      await process.start()
      process.stateDir = stateDir
      clients.push(process)
      return process
    },
    async openClient(name, { stateDir = join(root, name), extraEnv = {}, relay: targetRelay } = {}) {
      // The core opens the DB file but does not create its parent
      // directory — the harness owns the state dirs.
      mkdirSync(stateDir, { recursive: true })
      const process = driver.spawn({ layout, stateDir, extraEnv })
      await process.start()
      const { me } = await process.request('open', {
        storagePath: stateDir,
        relay: relayAddress(targetRelay ?? relay),
        namespace: 'e2e',
      })
      // Suite ergonomics: every client observes messages, events and
      // issues. Registration semantics (buffered events, receiving starts
      // at handler registration) are the SDK's own (ADR-0026/0028).
      await process.request('listenEvents')
      await process.request('listenIssues')
      await process.request('receive')
      process.me = me
      process.stateDir = stateDir
      clients.push(process)
      return process
    },
  }

  // Each scenario module's clients are stopped when the module finishes:
  // the full matrix spawns ~70 driver processes against one relay, and
  // leaving them all alive starves the later modules (the ts-only flake
  // in the first full run).
  //
  // DRAIN BEFORE STOP: a message's notification is emitted INSIDE the
  // driver's handler, so the suite proceeds while the core's DeliverAck
  // is still in flight — a client stopped in that window strands its row
  // in the inbox with a 30-day TTL, poisoning every later wait-empty
  // (the gate-leg TTL/ts-only failures, run 38540148152: straggler rows
  // with expires_at = now+30d). Delivered rows are deleted on ack, so
  // wait for the inbox to drain while the clients are still alive. A
  // row that legitimately cannot drain fails HERE, loudly, with the
  // helper's straggler diagnostics — not in an innocent downstream test.
  const runModule = async module => {
    const before = clients.length
    try {
      await module(t, ctx)
    } finally {
      const owned = clients.splice(before)
      try {
        execFileSync(duplicateInbox, ['wait-empty', relay.database], {
          env: { ...process.env, DUPLICATE_INBOX_TIMEOUT_S: '30' },
        })
      } finally {
        await Promise.allSettled(owned.map(client => client.stop()))
      }
    }
  }

  try {
    await relay.start()
    await runModule(runLifecycle)
    await runModule(runPairing)
    await runModule(runDelivery)
    await runModule(runMembership)
    await runModule(runDestroy)
    await runModule(runTtl)
    await runModule(runLimits)
    await runModule(runVersions)
    await runModule(runUpgrades)
    // G3 last: the adversary scenario stops the shared relay and runs its
    // own (hostile) relay instances, so its held/injected rows can never
    // poison another module's drain assertions.
    await runModule(runAdversary)

    if (driver.capabilities.includes(TS_ONLY_SCENARIOS.requiredCapability)) {
      await runModule(TS_ONLY_SCENARIOS.run)
    } else {
      console.log('')
      console.log(`NOT RUN — TS-only fault-injection scenario (driver "${sdkName}")`)
      console.log(`reason: ${TS_ONLY_SCENARIOS.reason}`)
      console.log('')
    }
  } finally {
    await Promise.allSettled(clients.map(client => client.stop()))
    await relay.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
