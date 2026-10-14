import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { RelayProcess } from '../lib/relay-process.mjs'
import { sdkDriver, relayAddress } from '../lib/sdk-drivers.mjs'
import { runLifecycle } from '../scenarios/lifecycle.mjs'
import { TS_ONLY_SCENARIOS } from '../scenarios/ts-only.mjs'

// The Scenario Suite (G1): one shared Scenario Driver runs the same
// scenario files against the SDK named by TRUESEAL_E2E_SDK, through
// Protocol Version 1, against the real (pinned, in gate mode) relay.
const sdkName = process.env.TRUESEAL_E2E_SDK
const driver = sdkDriver(sdkName)
const relayBinary = resolve(process.env.TRUESEAL_RELAY_BIN)
const duplicateInbox = resolve(process.env.TRUESEAL_DUPLICATE_INBOX_BIN)
const layout = JSON.parse(process.env.TRUESEAL_E2E_LAYOUT)
const root = mkdtempSync(join(tmpdir(), `trueseal-e2e-suite-${sdkName}-`))

test(`scenario suite: ${sdkName} driver through the shared Scenario Driver`, { timeout: 180_000 }, async t => {
  const relay = new RelayProcess({ binary: relayBinary, stateDir: join(root, 'relay') })
  const clients = []

  const ctx = {
    relay,
    duplicateInbox,
    async openClient(name, { stateDir = join(root, name), extraEnv = {} } = {}) {
      // The core opens the DB file but does not create its parent
      // directory — the harness owns the state dirs.
      mkdirSync(stateDir, { recursive: true })
      const process = driver.spawn({ layout, stateDir, extraEnv })
      await process.start()
      const { me } = await process.request('open', {
        storagePath: stateDir,
        relay: relayAddress(relay),
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

  try {
    await relay.start()
    await runLifecycle(t, ctx)

    if (driver.capabilities.includes(TS_ONLY_SCENARIOS.requiredCapability)) {
      await TS_ONLY_SCENARIOS.run(t, ctx)
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
