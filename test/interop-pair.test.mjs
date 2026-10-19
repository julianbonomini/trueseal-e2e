import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { RelayProcess } from '../lib/relay-process.mjs'
import { relayAddress, sdkDriver } from '../lib/sdk-drivers.mjs'

// The G2 Interop Smoke (E2E-4 / e2e ADR-0001 "SDK matrix"): ONE unordered
// SDK pair per process (the runner picks it with TRUESEAL_E2E_PAIR), driven
// entirely through Protocol v1 — both sides are Scenario Drivers, so this
// file needs no per-SDK code. Per pair, each side acts as admitter once
// (the issue's "each side acting as admitter in at least one run"), and
// each run checks explicit admission, delivery in both directions and
// silence after removal.
//
// Same-SDK pairs spawn two driver instances of the same SDK with distinct
// storage dirs — the mechanical minimum that proves a pair is not an
// echo of one identity.

const layout = JSON.parse(process.env.TRUESEAL_E2E_LAYOUT)
const relayBinary = resolve(process.env.TRUESEAL_RELAY_BIN)
const pairId = process.env.TRUESEAL_E2E_PAIR
const [sdkA, sdkB] = pairId.split('-')
const evidencePath = process.env.TRUESEAL_E2E_EVIDENCE
const root = mkdtempSync(join(tmpdir(), `trueseal-interop-${pairId}-`))

const assertions = []
/** Records the outcome of a block as one evidence assertion; rethrows. */
async function record(name, fn) {
  try {
    await fn()
    assertions.push({ name, result: 'pass' })
  } catch (error) {
    assertions.push({ name, result: 'fail', error: String(error?.message ?? error) })
    throw error
  }
}

after(() => {
  if (evidencePath) {
    // gates/evidence/ is untracked (evidence uploads as CI artifacts), so a
    // fresh checkout has no such directory — create it.
    mkdirSync(dirname(evidencePath), { recursive: true })
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          gate: 'G2',
          issue: 'trueseal-e2e#8',
          pair: pairId,
          mode: process.env.TRUESEAL_E2E_MODE ?? 'unknown',
          pins: process.env.TRUESEAL_E2E_PINS ? JSON.parse(process.env.TRUESEAL_E2E_PINS) : undefined,
          run: process.env.GITHUB_RUN_ID
            ? `https://github.com/julianbonomini/trueseal-e2e/actions/runs/${process.env.GITHUB_RUN_ID}`
            : 'local',
          assertions,
        },
        null,
        2,
      ) + '\n',
    )
  }
  rmSync(root, { recursive: true, force: true })
})

function hex(text) {
  return Buffer.from(text, 'utf8').toString('hex')
}

function textOf(notification) {
  return Buffer.from(notification.message.bodyHex, 'hex').toString('utf8')
}

function strictEqualCode(error, code) {
  if (error?.code !== code) {
    throw new Error(`expected error code ${code}, got ${error?.code}: ${error?.message}`)
  }
}

async function pairDevices(host, joiner) {
  const { token } = await host.request('startPairing')
  ok(typeof token === 'string' && token.length > 0, 'startPairing returns a token')
  const request = host.waitForEvent('joinRequest', 20_000, 'joinRequest event')
  await joiner.request('join', { token })
  const incoming = await request
  ok(incoming.requestId, 'joinRequest carries a requestId (explicit admission)')
  const joined = joiner.waitForEvent(
    value => value.kind === 'statusChanged' && value.status === 'member' && value.reason === 'joined',
    20_000,
    'statusChanged(member, joined)',
  )
  const hostSees = host.waitForEvent(
    value => value.kind === 'membersChanged' && value.members.some(member => member.id === joiner.me.id),
    20_000,
    'membersChanged containing the joiner',
  )
  await host.request('accept', { requestId: incoming.requestId })
  await Promise.all([joined, hostSees])
}

async function spawnClient(sdk, name, relay) {
  const stateDir = join(root, name)
  mkdirSync(stateDir, { recursive: true })
  const client = sdkDriver(sdk).spawn({ layout })
  await client.start()
  const { me } = await client.request('open', {
    storagePath: stateDir,
    relay: relayAddress(relay),
    namespace: 'e2e',
  })
  await client.request('listenEvents')
  await client.request('receive')
  client.me = me
  return client
}

/** One full smoke: `admitterSdk` pairs `joinerSdk` in explicitly, both
 *  directions deliver, and removal silences the removed device (ADR-0027:
 *  the wiped device cannot send, and fan-out stops addressing it). */
async function smoke(admitterSdk, joinerSdk, relay, clients, runId) {
  const label = `${admitterSdk} admits ${joinerSdk}`
  // Distinct state dirs per run: for same-SDK pairs both runs carry the
  // same label, so the run id keeps the second run from reopening the
  // first run's stores (alreadyInGroup).
  const admitter = await spawnClient(admitterSdk, `${runId}-host`, relay)
  const joiner = await spawnClient(joinerSdk, `${runId}-joiner`, relay)
  clients.push(admitter, joiner)
  notStrictEqual(admitter.me.id, joiner.me.id, 'two distinct identities')

  await pairDevices(admitter, joiner)
  assertions.push({ name: `${label}: explicit admission (joinRequest → accept → member(joined) both sides)`, result: 'pass' })

  const toJoiner = joiner.waitForEvent(
    value => value.event === 'message' && textOf(value) === `${label}:a2b`,
    20_000,
    'message admitter→joiner',
  )
  const { messageId: firstId } = await admitter.request('send', { bodyHex: hex(`${label}:a2b`) })
  const first = await toJoiner
  await record(`${label}: delivery admitter→joiner (content + MessageId)`, async () => {
    strictEqual(textOf(first), `${label}:a2b`)
    strictEqual(first.message.id, firstId)
    ok(firstId.startsWith('tsm1_'), 'MessageId carries the tsm1_ prefix')
    strictEqual(first.message.from.id, admitter.me.id)
  })

  const toAdmitter = admitter.waitForEvent(
    value => value.event === 'message' && textOf(value) === `${label}:b2a`,
    20_000,
    'message joiner→admitter',
  )
  const { messageId: secondId } = await joiner.request('send', { bodyHex: hex(`${label}:b2a`) })
  const second = await toAdmitter
  await record(`${label}: delivery joiner→admitter (content + MessageId)`, async () => {
    strictEqual(textOf(second), `${label}:b2a`)
    strictEqual(second.message.id, secondId)
    notStrictEqual(second.message.id, first.message.id)
    strictEqual(second.message.from.id, joiner.me.id)
  })

  const removed = joiner.waitForEvent(
    value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'removed',
    20_000,
    'statusChanged(notJoined, removed)',
  )
  await admitter.request('remove', { memberId: joiner.me.id })
  await removed

  await record(`${label}: silence after removal (typed refusal + no fan-out)`, async () => {
    let failure
    try {
      await joiner.request('send', { bodyHex: hex(`${label}:from-removed`) })
    } catch (error) {
      failure = error
    }
    ok(failure, 'a removed device must not be able to send')
    strictEqualCode(failure, 'notMember')

    // The group's fan-out no longer addresses the removed device.
    await admitter.request('send', { bodyHex: hex(`${label}:after-removal`) })
    await joiner.expectNoEvent(value => value.event === 'message', 5_000, 'any message on the removed device')

    deepStrictEqual((await admitter.request('status')).status, 'member')
  })
}

test(`G2 interop smoke: ${sdkA} ↔ ${sdkB} over a real relay (Protocol v1)`, { timeout: 240_000 }, async t => {
  const relay = new RelayProcess({ binary: relayBinary, stateDir: join(root, 'relay') })
  const clients = []
  try {
    await relay.start()
    await t.test(`${sdkA} admits ${sdkB}`, async () => {
      await smoke(sdkA, sdkB, relay, clients, 'run-1')
    })
    await t.test(`${sdkB} admits ${sdkA}`, async () => {
      await smoke(sdkB, sdkA, relay, clients, 'run-2')
    })
  } finally {
    await Promise.allSettled(clients.map(client => client.stop()))
    await relay.stop()
  }
})
