import { notStrictEqual, ok, strictEqual } from 'node:assert/strict'

import { pair } from './lifecycle.mjs'

/**
 * The Destroy Group matrix rows (ADR-0001's ADR-0029 list): destroy from
 * each SDK (the lane IS the SDK), every device ending notJoined(destroyed)
 * with a fresh identity, nothing addressed to old keys afterwards, an
 * offline recipient wiping after it reconnects, re-pairing where a stolen
 * device isn't admitted without acceptance, and a device offline past the
 * TTL missing the Destroy (the documented availability limitation — sync
 * ADR-0029/0034, relay TTL per sync ADR-0034 §30-day cap).
 */

export async function runDestroy(t, ctx) {
  await t.test('an offline member wipes after it reconnects (ADR-0029)', async () => {
    const a = await ctx.openClient('destroy-offline-a')
    let b = await ctx.openClient('destroy-offline-b')
    await pair(a, b)

    const bState = b.stateDir
    const bId = b.me.id
    await b.stop()

    const destroyedA = a.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      20_000,
      'statusChanged(notJoined, destroyed) on the destroyer',
    )
    await a.request('destroyGroup')
    await destroyedA

    // The Revoke waited in the durable inbox; the reconnected member
    // processes it, wipes and rotates (ADR-0029's forwarded-durability).
    b = await ctx.openClient('destroy-offline-b-restarted', { stateDir: bState })
    strictEqual(b.me.id, bId, 'identity before processing the Revoke')
    await b.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      20_000,
      'statusChanged(notJoined, destroyed) on the reconnected member',
    )
  })

  await t.test('destroy rotates the identity; old member ids are dead (ADR-0029)', async () => {
    const a = await ctx.openClient('rotate-a')
    const b = await ctx.openClient('rotate-b')
    await pair(a, b)
    const aOldId = a.me.id
    const aState = a.stateDir

    const destroyed = a.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      20_000,
      'statusChanged(notJoined, destroyed)',
    )
    await a.request('destroyGroup')
    await destroyed

    // Reopening the same state dir yields a FRESH identity — nothing is
    // addressed to the old keys afterwards because they no longer exist.
    // (The original processes are stopped first: two live sessions on one
    // identity compete for the relay's per-device session slot. Drain
    // first: b's Revoke ack trails its destroyed event — stopping in
    // that window strands the inbox row.)
    await ctx.drain()
    await a.stop()
    await b.stop()
    const a2 = await ctx.openClient('rotate-a-reopened', { stateDir: aState })
    notStrictEqual(a2.me.id, aOldId)
    strictEqual((await a2.request('status')).status, 'notJoined')
    let failure
    try {
      await a2.request('remove', { memberId: aOldId })
    } catch (error) {
      failure = error
    }
    ok(failure, 'removing a dead member id must fail')
    strictEqual(failure.code, 'notMember')
  })

  await t.test('re-pairing after destroy: a stolen device is not admitted without acceptance (ADR-0029)', async () => {
    const a = await ctx.openClient('stolen-a')
    const b = await ctx.openClient('stolen-b')
    await pair(a, b)
    const aState = a.stateDir
    const bState = b.stateDir

    const destroyedA = a.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      20_000,
      'destroyed on a',
    )
    const destroyedB = b.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      20_000,
      'destroyed on b',
    )
    await a.request('destroyGroup')
    await Promise.all([destroyedA, destroyedB])

    // Both devices start over. The (stolen) b device joins a's fresh
    // token — but without the explicit accept it never becomes a member.
    await ctx.drain()
    await a.stop()
    await b.stop()
    const a2 = await ctx.openClient('stolen-a-reopened', { stateDir: aState })
    const b2 = await ctx.openClient('stolen-b-reopened', { stateDir: bState })
    const { token } = await a2.request('startPairing')
    const request = a2.waitForEvent('joinRequest', 15_000, 'the stolen device join request')
    await b2.request('join', { token })
    await request
    await new Promise(resolve => setTimeout(resolve, 2_000))
    strictEqual((await b2.request('status')).status, 'pendingJoin')
    await b2.request('cancelJoin')
  })

  await t.test('a device offline past the TTL misses the Destroy (documented limitation, ADR-0029/0034)', async () => {
    // Short relay TTL through normal operator config (ADR-0001). The
    // Revoke expires from the inbox before the offline device returns —
    // the device never learns the group was destroyed. This is the
    // availability limitation the threat model documents: the relay is
    // trusted for availability, and a message that outlives the TTL is
    // gone (the sender's outbox copy was deleted on relay acceptance).
    await ctx.relay.reconfigure({
      TRUESEAL_RELAY_TTL: '3s',
      TRUESEAL_RELAY_REAP_INTERVAL: '1s',
    })
    try {
      const a = await ctx.openClient('ttl-destroy-a')
      let b = await ctx.openClient('ttl-destroy-b')
      await pair(a, b)
      const bState = b.stateDir
      await b.stop()

      const destroyedA = a.waitForEvent(
        value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
        20_000,
        'destroyed on the initiator',
      )
      await a.request('destroyGroup')
      await destroyedA

      // Let the Revoke expire in the inbox before b returns.
      await new Promise(resolve => setTimeout(resolve, 5_000))
      b = await ctx.openClient('ttl-destroy-b-restarted', { stateDir: bState })
      await b.expectNoEvent(
        value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
        5_000,
        'a destroy notification after the Revoke expired',
      )
      console.log('')
      console.log(
        `note — ${ctx.sdk}: the offline-past-TTL device missed the Destroy (status ` +
          `${(await b.request('status')).status}) — the documented availability limitation`,
      )
      console.log('')
    } finally {
      await ctx.relay.reconfigure({})
    }
  })
}
