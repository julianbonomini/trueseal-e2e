import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

/**
 * The SDK-agnostic lifecycle scenario set (e2e#5: "the existing lifecycle
 * scenarios run through the driver for all three SDKs"). Ported from the
 * TS-only test/system.test.mjs to Protocol Version 1 — every step drives
 * the SDK through commands and notifications any driver speaks, so the
 * same file runs against TS, Kotlin (JVM) and Swift, selected by flag.
 *
 * The TS-only fault-injection scenario lives in scenarios/ts-only.mjs
 * (it needs the TS driver's drop-before-commit capability).
 */

export function hex(text) {
  return Buffer.from(text, 'utf8').toString('hex')
}

function textOf(notification) {
  return Buffer.from(notification.message.bodyHex, 'hex').toString('utf8')
}

/** Explicit admission over Protocol v1 notifications. */
async function pair(host, joiner) {
  const { token } = await host.request('startPairing')
  const request = host.waitForEvent('joinRequest', 15_000, 'joinRequest event')
  await joiner.request('join', { token })
  const incoming = await request

  const joinerJoined = joiner.waitForEvent(
    value => value.kind === 'statusChanged' && value.status === 'member' && value.reason === 'joined',
    15_000,
    'statusChanged(member, joined)',
  )
  // The membersChanged event carries the FULL manifest member list,
  // self included (the members command excludes self — both are the
  // core's canonical shapes, consistent across SDKs).
  const hostSees = host.waitForEvent(
    value => value.kind === 'membersChanged' && value.members.some(member => member.id === joiner.me.id),
    15_000,
    'membersChanged containing the joiner',
  )
  await host.request('accept', { requestId: incoming.requestId })
  await Promise.all([joinerJoined, hostSees])
}

/**
 * Runs the lifecycle suite as node:test subtests against the scenario
 * context `ctx` (see test/scenario-suite.test.mjs): ctx.openClient,
 * ctx.relay, ctx.duplicateInbox.
 */
export async function runLifecycle(t, ctx) {
  const a = await ctx.openClient('a')
  let b = await ctx.openClient('b')

  await t.test('explicit pairing and bidirectional delivery', async () => {
    await pair(a, b)

    const toB = b.waitForEvent(value => value.event === 'message' && textOf(value) === 'from-a', 15_000, 'message from-a')
    const { messageId: firstId } = await a.request('send', { bodyHex: hex('from-a') })
    ok(firstId.startsWith('tsm1_'))
    const first = await toB
    strictEqual(first.message.id, firstId)
    strictEqual(first.message.from.id, a.me.id)

    const toA = a.waitForEvent(value => value.event === 'message' && textOf(value) === 'from-b', 15_000, 'message from-b')
    await b.request('send', { bodyHex: hex('from-b') })
    const second = await toA
    notStrictEqual(second.message.id, first.message.id)

    deepStrictEqual((await a.request('members')).members.length, 1)
    deepStrictEqual((await b.request('members')).members.length, 1)
  })

  await t.test('offline recipient drains durable relay inbox after process restart', async () => {
    const bState = b.stateDir
    const bId = b.me.id
    await b.stop()

    await a.request('send', { bodyHex: hex('recipient-was-offline') })
    b = await ctx.openClient('b-restarted', { stateDir: bState })
    strictEqual(b.me.id, bId)
    await b.waitForEvent(
      value => value.event === 'message' && textOf(value) === 'recipient-was-offline',
      15_000,
      'queued message after restart',
    )
    // The ack goes out after the handler (ADR-0026) and the relay deletes
    // the row on ack (RELAY-1). Assert the round-trip — and leave no
    // un-acked row behind for later subtests (E3b's watermark discipline).
    execFileSync(ctx.duplicateInbox, ['wait-empty', ctx.relay.database], { stdio: 'inherit' })
  })

  await t.test('duplicate envelope is delivered once — the library dedups (ADR-0031)', async () => {
    const bState = b.stateDir
    await b.stop()

    const watermark = execFileSync(ctx.duplicateInbox, ['max-id', ctx.relay.database]).toString().trim()
    await a.request('send', { bodyHex: hex('duplicate-delivery') })
    execFileSync(ctx.duplicateInbox, ['wait-queued', ctx.relay.database, watermark], { stdio: 'inherit' })
    await ctx.relay.stop()
    try {
      execFileSync(ctx.duplicateInbox, ['duplicate', ctx.relay.database, watermark], { stdio: 'inherit' })
    } finally {
      await ctx.relay.start()
    }
    b = await ctx.openClient('b-after-duplicate', { stateDir: bState })
    const first = await b.waitForEvent(
      value => value.event === 'message' && textOf(value) === 'duplicate-delivery',
      15_000,
      'the duplicated message',
    )
    ok(first.message.id)
    await b.expectNoEvent(
      value => value.event === 'message' && textOf(value) === 'duplicate-delivery',
      5_000,
      'a second delivery of the duplicated message',
    )
  })

  await t.test('sender outbox replays after relay restart', async () => {
    await ctx.relay.stop()
    try {
      // send() is durable-queue semantics (ADR-0026, SYNC-5): it resolves
      // while the relay is down and the outbox pump retries on reconnect.
      await a.request('send', { bodyHex: hex('relay-was-offline') })
    } finally {
      await ctx.relay.start()
    }
    await b.waitForEvent(
      value => value.event === 'message' && textOf(value) === 'relay-was-offline',
      30_000,
      'the outbox-replayed message',
    )
  })

  await t.test('member removal reaches the removed device', async () => {
    const removed = b.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'removed',
      15_000,
      'statusChanged(notJoined, removed)',
    )
    await a.request('remove', { memberId: b.me.id })
    await removed
  })

  await t.test('Destroy Group reaches every current member', async () => {
    const c = await ctx.openClient('c')
    const d = await ctx.openClient('d')
    await pair(c, d)

    const destroyedC = c.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      15_000,
      'statusChanged(notJoined, destroyed) on the destroyer',
    )
    const destroyedD = d.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      15_000,
      'statusChanged(notJoined, destroyed) on the member',
    )
    await c.request('destroyGroup')
    await Promise.all([destroyedC, destroyedD])
  })
}
