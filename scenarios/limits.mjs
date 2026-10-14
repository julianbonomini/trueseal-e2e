import { ok, strictEqual } from 'node:assert/strict'

import { hex, pair, textOf } from './lifecycle.mjs'

/**
 * The relay-baseline matrix rows (relay ADR-0012, sync ADR-0025): the
 * Protocol Size Limit both sides of the boundary, an operator-lowered
 * limit producing a typed permanent sendFailed, inbox-full and
 * rate-limited refusals with retry AND recovery, the Receive Session cap
 * per device key, and the idle-timeout/heartbeat pair. All limits are
 * short operator settings (ADR-0001) — no test-only relay code.
 */

/** Collects count matching messages in arrival order (see delivery.mjs). */
async function collect(client, prefix, count, timeoutMs) {
  const received = []
  const deadline = Date.now() + timeoutMs
  while (received.length < count) {
    const notification = await client.waitForEvent(
      value => value.event === 'message' && textOf(value).startsWith(prefix),
      deadline - Date.now(),
      `${count} messages with prefix ${prefix}`,
    )
    received.push(textOf(notification))
  }
  return received
}

export async function runLimits(t, ctx) {
  await t.test('the Protocol Size Limit: 61,440 bytes accepted, 61,441 refused typed (ADR-0025)', async () => {
    const a = await ctx.openClient('size-a')
    const b = await ctx.openClient('size-b')
    await pair(a, b)

    const atLimit = Buffer.alloc(61_440, 0x61)
    const receipt = b.waitForEvent(
      value => value.event === 'message' && value.message.bodyHex.length === atLimit.length * 2,
      20_000,
      'the at-limit message',
    )
    const { messageId } = await a.request('send', { bodyHex: atLimit.toString('hex') })
    ok(messageId.startsWith('tsm1_'))
    await receipt

    let failure
    try {
      await a.request('send', { bodyHex: Buffer.alloc(61_441, 0x62).toString('hex') })
    } catch (error) {
      failure = error
    }
    strictEqual(failure?.code, 'payloadTooLarge')
  })

  await t.test('an operator-lowered relay limit surfaces sendFailed(tooLarge), permanent (ADR-0025)', async () => {
    await ctx.relay.reconfigure({ TRUESEAL_RELAY_MAX_ENVELOPE_BYTES: '2048' })
    try {
      const a = await ctx.openClient('limit-a')
      const b = await ctx.openClient('limit-b')
      await pair(a, b)

      const body = Buffer.alloc(4_096, 0x63).toString('hex')
      const { messageId } = await a.request('send', { bodyHex: body })
      const issue = await a.waitForEvent(
        value => value.event === 'issue' && value.kind === 'sendFailed' && value.messageId === messageId,
        20_000,
        'sendFailed for the over-operator-limit send',
      )
      strictEqual(issue.reason, 'tooLarge')
      // Permanent: the pump does not retry, and nothing is delivered.
      await b.expectNoEvent(value => value.event === 'message', 5_000, 'a delivery of the refused send')
    } finally {
      await ctx.relay.reconfigure({})
    }
  })

  await t.test('inbox full: typed temporary refusal, the pump retries and recovers (relay ADR-0012)', async () => {
    await ctx.relay.reconfigure({ TRUESEAL_RELAY_MAX_BLOBS_PER_INBOX: '2' })
    try {
      const a = await ctx.openClient('quota-a')
      let b = await ctx.openClient('quota-b')
      await pair(a, b)
      const bState = b.stateDir
      await b.stop()

      // Two blobs fit; the third and fourth are refused inboxFull
      // (temporary) and queue in the sender's outbox.
      for (const text of ['quota-1', 'quota-2', 'quota-3', 'quota-4']) {
        await a.request('send', { bodyHex: hex(text) })
      }
      // The recipient drains two, the acks free quota, the pump's
      // retries land the rest — recovery, in per-sender order.
      b = await ctx.openClient('quota-b-restarted', { stateDir: bState })
      const received = await collect(b, 'quota-', 4, 60_000)
      strictEqual(received.join(','), 'quota-1,quota-2,quota-3,quota-4')
    } finally {
      await ctx.relay.reconfigure({})
    }
  })

  await t.test('rate limited: typed temporary refusal with recovery in order (relay ADR-0012)', async () => {
    await ctx.relay.reconfigure({
      TRUESEAL_RELAY_PUSH_RATE_PER_SECOND: '1',
      TRUESEAL_RELAY_PUSH_RATE_BURST: '2',
    })
    try {
      const a = await ctx.openClient('rate-a')
      const b = await ctx.openClient('rate-b')
      await pair(a, b)
      for (const text of ['rate-1', 'rate-2', 'rate-3', 'rate-4']) {
        await a.request('send', { bodyHex: hex(text) })
      }
      const received = await collect(b, 'rate-', 4, 60_000)
      strictEqual(received.join(','), 'rate-1,rate-2,rate-3,rate-4')
    } finally {
      await ctx.relay.reconfigure({})
    }
  })

  await t.test('the Receive Session cap per device key refuses a second concurrent session (relay ADR-0012)', async () => {
    await ctx.relay.reconfigure({ TRUESEAL_RELAY_MAX_RECEIVE_SESSIONS_PER_DEVICE: '1' })
    try {
      const first = await ctx.openClient('cap-first')
      const stateDir = first.stateDir
      // A second process opening the SAME identity competes for the one
      // session slot: the relay refuses by close, so the second client
      // observes a disconnect (its reconnect loop keeps retrying).
      const second = await ctx.openClient('cap-second', { stateDir })
      // The cap-close can land before a scenario-registered waiter sees
      // it (buffered events drain at listenEvents during open), and the
      // reconnect backoff then spaces further attempts minutes apart —
      // so POLL the connection state: between redials the refused client
      // sits disconnected.
      const deadline = Date.now() + 25_000
      let refused = false
      while (Date.now() < deadline && !refused) {
        const { connection } = await second.request('connection')
        refused = connection.state !== 'connected'
        if (!refused) await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (!refused) throw new Error('the second session was never refused by the cap')
      await second.stop()
      // With the competitor gone, the first session is stable.
      await pollConnected(first, 15_000)
    } finally {
      await ctx.relay.reconfigure({})
    }
  })

  await t.test('idle timeout closes a heartbeat-less session; the client reconnects (relay ADR-0012)', async () => {
    await ctx.relay.reconfigure({ TRUESEAL_RELAY_RECEIVE_IDLE_DEADLINE: '3s' })
    try {
      const a = await ctx.openClient('idle-a')
      // The client's heartbeat runs every 25 s — far slower than the 3 s
      // idle deadline — so the relay cuts the session. The client severs
      // and redials (B14); observe the flap and the recovery.
      await a.waitForEvent(
        value => value.kind === 'connectionChanged' && value.connection.state !== 'connected',
        20_000,
        'the idle-timeout disconnect',
      )
      await a.waitForEvent(
        value => value.kind === 'connectionChanged' && value.connection.state === 'connected',
        20_000,
        'the reconnect after the idle cut',
      )
    } finally {
      await ctx.relay.reconfigure({})
    }
  })

  await t.test('the 25 s heartbeat keeps a session alive past one interval (relay ADR-0012)', async () => {
    // Default relay config: 75 s idle deadline. One full heartbeat
    // interval (25 s) of silence must NOT cost the connection — the
    // keep-alive half of the deadline/heartbeat pair. (The inverse half —
    // the cut — is the idle-timeout scenario above; the 75 s wall-clock
    // cut itself stays out of the gate's time budget.)
    const a = await ctx.openClient('heartbeat-a')
    await new Promise(resolve => setTimeout(resolve, 27_000))
    await pollConnected(a, 5_000)
  })
}

async function pollConnected(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { connection } = await client.request('connection')
    if (connection.state === 'connected') return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('client did not reach the connected state')
}
