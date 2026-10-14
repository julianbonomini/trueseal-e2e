import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { DriverProcess } from '../lib/driver-process.mjs'
import { RelayProcess } from '../lib/relay-process.mjs'
import { relayAddress } from '../lib/sdk-drivers.mjs'

// The Interop Smoke (E2E-4's pair, send-both-ways, remove shape), driven
// entirely through Protocol Version 1 — TypeScript's driver from this repo
// and the foreign adapter binary both speak the same control protocol, so
// this test needs no per-adapter code. The full pairwise matrix arrives
// with E2E-4 (#8); this lane proves the protocol is SDK-agnostic.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const layout = JSON.parse(process.env.TRUESEAL_E2E_LAYOUT)
const relayBinary = resolve(process.env.TRUESEAL_RELAY_BIN)
const adapterBinary = resolve(process.env.TRUESEAL_E2E_ADAPTER_BIN)
const adapterName = process.env.TRUESEAL_E2E_ADAPTER_NAME
const root = mkdtempSync(join(tmpdir(), `trueseal-${adapterName}-interop-`))

function hex(text) {
  return Buffer.from(text, 'utf8').toString('hex')
}

function textOf(notification) {
  return Buffer.from(notification.message.bodyHex, 'hex').toString('utf8')
}

async function pair(host, joiner) {
  const { token } = await host.request('startPairing')
  const request = host.waitForEvent('joinRequest', 15_000, 'joinRequest event')
  await joiner.request('join', { token })
  const incoming = await request
  const joined = joiner.waitForEvent(
    value => value.kind === 'statusChanged' && value.status === 'member' && value.reason === 'joined',
    15_000,
    'statusChanged(member, joined)',
  )
  const hostSees = host.waitForEvent(
    value => value.kind === 'membersChanged' && value.members.some(member => member.id === joiner.me.id),
    15_000,
    'membersChanged containing the joiner',
  )
  await host.request('accept', { requestId: incoming.requestId })
  await Promise.all([joined, hostSees])
}

test(`TypeScript and ${adapterName} interoperate through a real relay (Protocol v1)`, { timeout: 120_000 }, async () => {
  const relay = new RelayProcess({ binary: relayBinary, stateDir: join(root, 'relay') })
  const clients = []
  const create = async (name, { command, args = [], stateDir = join(root, name) } = {}) => {
    mkdirSync(stateDir, { recursive: true })
    const client = new DriverProcess({
      command: command ?? process.execPath,
      args: command ? args : [join(layout.e2eRepo, 'clients', 'typescript.mjs')],
      env: command ? {} : { TRUESEAL_TS_REPO: layout.tsRepo },
      name,
    })
    await client.start()
    const { me } = await client.request('open', {
      storagePath: stateDir,
      relay: relayAddress(relay),
      namespace: 'e2e',
    })
    await client.request('listenEvents')
    await client.request('receive')
    client.me = me
    client.stateDir = stateDir
    clients.push(client)
    return client
  }

  try {
    await relay.start()
    const typescript = await create('typescript')
    let foreign = await create(adapterName, { command: adapterBinary })

    await pair(typescript, foreign)

    const toForeign = foreign.waitForEvent(
      value => value.event === 'message' && textOf(value) === 'from-typescript',
      15_000,
      'message from-typescript',
    )
    const { messageId: firstId } = await typescript.request('send', { bodyHex: hex('from-typescript') })
    ok(firstId.startsWith('tsm1_'))
    const first = await toForeign
    strictEqual(first.message.id, firstId)

    const toTypescript = typescript.waitForEvent(
      value => value.event === 'message' && textOf(value) === `from-${adapterName}`,
      15_000,
      `message from-${adapterName}`,
    )
    await foreign.request('send', { bodyHex: hex(`from-${adapterName}`) })
    const second = await toTypescript
    ok(second.message.id.startsWith('tsm1_'))
    notStrictEqual(second.message.id, first.message.id)

    // The foreign driver's identity survives a process restart on the
    // same storage dir.
    const stateDir = foreign.stateDir
    const foreignId = foreign.me.id
    await foreign.stop()
    foreign = await create(`${adapterName}-restarted`, { command: adapterBinary, stateDir })
    strictEqual(foreign.me.id, foreignId)

    const removed = foreign.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'removed',
      15_000,
      'statusChanged(notJoined, removed)',
    )
    await typescript.request('remove', { memberId: foreignId })
    await removed
    deepStrictEqual((await typescript.request('status')).status, 'member')
  } finally {
    await Promise.allSettled(clients.map(client => client.stop()))
    await relay.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
