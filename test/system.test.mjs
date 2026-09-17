import { deepStrictEqual, notStrictEqual, ok } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { ClientProcess } from '../lib/client-process.mjs'
import { RelayProcess } from '../lib/relay-process.mjs'

const relayBinary = resolve(process.env.TRUESEAL_RELAY_BIN)
const duplicateInboxBinary = resolve(process.env.TRUESEAL_DUPLICATE_INBOX_BIN)
const root = mkdtempSync(join(tmpdir(), 'trueseal-e2e-'))

async function pair(host, joiner) {
  const token = await host.request('pairingToken')
  const request = host.waitForEvent('memberRequest')
  await joiner.request('joinGroup', { token })
  const incoming = await request

  const hostJoined = host.waitForEvent('memberJoined')
  const joinerJoined = joiner.waitForEvent('memberJoined')
  await host.request('acceptPairingRequest', { requestToken: incoming.requestToken })
  await Promise.all([hostJoined, joinerJoined])
}

function encoded(text) {
  return Buffer.from(text).toString('base64')
}

test('real relay and public SDK complete critical sync lifecycle', { timeout: 90_000 }, async t => {
  const relay = new RelayProcess({ binary: relayBinary, stateDir: join(root, 'relay') })
  const clients = []

  async function client(name, stateDir = join(root, name)) {
    const value = new ClientProcess({ stateDir, relayPublicKey: relay.publicKey })
    clients.push(value)
    return value.start()
  }

  try {
    await relay.start()
    const a = await client('a')
    let b = await client('b')

    await t.test('explicit pairing and bidirectional delivery', async () => {
      await pair(a, b)

      const toB = b.waitForEvent('message', event => event.text === 'from-a')
      await a.request('send', { data: encoded('from-a') })
      const first = await toB
      ok(first.messageId.startsWith('tsm1_'))

      const toA = a.waitForEvent('message', event => event.text === 'from-b')
      await b.request('send', { data: encoded('from-b') })
      const second = await toA
      notStrictEqual(second.messageId, first.messageId)

      deepStrictEqual((await a.request('members')).length, 1)
      deepStrictEqual((await b.request('members')).length, 1)
    })

    await t.test('offline recipient drains durable relay inbox after process restart', async () => {
      const bState = b.stateDir
      const bNodeId = b.ready.localNodeId
      await b.stop()

      await a.request('send', { data: encoded('recipient-was-offline') })
      b = await client('b-restarted', bState)
      deepStrictEqual(b.ready.localNodeId, bNodeId)
      await b.waitForEvent('message', event => event.text === 'recipient-was-offline')
    })

    await t.test('duplicate envelope keeps one stable application message ID', async () => {
      const bState = b.stateDir
      await b.stop()

      await a.request('send', { data: encoded('duplicate-delivery') })
      await relay.stop()
      execFileSync(duplicateInboxBinary, [relay.database], { stdio: 'inherit' })

      await relay.start()
      b = await client('b-after-duplicate', bState)
      const first = await b.waitForEvent('message', event => event.text === 'duplicate-delivery')
      const duplicate = await b.waitForEvent('message', event => event.text === 'duplicate-delivery')
      deepStrictEqual(duplicate.messageId, first.messageId)
    })

    await t.test('sender outbox replays after relay restart', async () => {
      await relay.stop()
      try {
        await a.request('send', { data: encoded('relay-was-offline') })
      } catch (error) {
        ok(/push|connect|relay/i.test(error.message), error.message)
      }

      await relay.start()
      await b.waitForEvent('message', event => event.text === 'relay-was-offline', 30_000)
    })

    await t.test('member removal reaches removed device', async () => {
      const removed = b.waitForEvent('removedFromGroup')
      await a.request('removeMember', { memberId: b.ready.localNodeId })
      await removed
    })

    await t.test('Destroy Group reaches every current member', async () => {
      const c = await client('c')
      const d = await client('d')
      await pair(c, d)

      const destroyedC = c.waitForEvent('groupDestroyed')
      const destroyedD = d.waitForEvent('groupDestroyed')
      await c.request('destroyGroup')
      await Promise.all([destroyedC, destroyedD])
    })
  } finally {
    await Promise.allSettled(clients.map(value => value.stop()))
    await relay.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
