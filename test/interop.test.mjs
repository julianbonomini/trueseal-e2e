import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { ClientProcess } from '../lib/client-process.mjs'
import { RelayProcess } from '../lib/relay-process.mjs'

const relayBinary = resolve(process.env.TRUESEAL_RELAY_BIN)
const adapterBinary = resolve(process.env.TRUESEAL_E2E_ADAPTER_BIN)
const adapterName = process.env.TRUESEAL_E2E_ADAPTER_NAME
const root = mkdtempSync(join(tmpdir(), `trueseal-${adapterName}-interop-`))

function encoded(text) {
  return Buffer.from(text).toString('base64')
}

async function pair(host, joiner) {
  const token = await host.request('pairingToken')
  const request = host.waitForEvent('memberRequest')
  await joiner.request('joinGroup', { token })
  const incoming = await request
  const hostJoined = host.waitForEvent('memberJoined')
  const joinerJoined = joiner.waitForEvent('memberJoined')
  strictEqual(await host.request('acceptPairingRequest', { requestToken: incoming.requestToken }), true)
  await Promise.all([
    hostJoined.catch(error => { throw new Error(`host did not observe memberJoined: ${error.message}`) }),
    joinerJoined.catch(error => { throw new Error(`joiner did not observe memberJoined: ${error.message}`) }),
  ])
}

test(`TypeScript and ${adapterName} interoperate through a real relay`, { timeout: 90_000 }, async () => {
  const relay = new RelayProcess({ binary: relayBinary, stateDir: join(root, 'relay') })
  const clients = []
  const create = async (name, options = {}) => {
    const client = new ClientProcess({
      stateDir: options.stateDir ?? join(root, name),
      relayPublicKey: relay.publicKey,
      command: options.command,
      args: options.args,
    })
    clients.push(client)
    return client.start()
  }

  try {
    await relay.start()
    const typescript = await create('typescript')
    let foreign = await create(adapterName, { command: adapterBinary, args: [] })

    await pair(typescript, foreign)
    deepStrictEqual((await typescript.request('members')).length, 1)
    deepStrictEqual((await foreign.request('members')).length, 1)

    const toForeign = foreign.waitForEvent('message', event => event.text === 'from-typescript')
    await typescript.request('send', { data: encoded('from-typescript') })
    const first = await toForeign
    ok(first.messageId.startsWith('tsm1_'))

    const toTypescript = typescript.waitForEvent('message', event => event.text === `from-${adapterName}`)
    await foreign.request('send', { data: encoded(`from-${adapterName}`) })
    const second = await toTypescript
    ok(second.messageId.startsWith('tsm1_'))
    notStrictEqual(second.messageId, first.messageId)

    const stateDir = foreign.stateDir
    const nodeId = foreign.ready.localNodeId
    await foreign.stop()
    foreign = await create(`${adapterName}-restarted`, { command: adapterBinary, args: [], stateDir })
    strictEqual(foreign.ready.localNodeId, nodeId)

    const removed = foreign.waitForEvent('removedFromGroup')
    await typescript.request('removeMember', { memberId: nodeId })
    await removed
  } finally {
    await Promise.allSettled(clients.map(client => client.stop()))
    await relay.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
