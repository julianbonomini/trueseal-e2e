import { deepStrictEqual } from 'node:assert/strict'

import { hex, pair, textOf } from './lifecycle.mjs'

/**
 * The delivery-contract matrix rows (sync ADR-0026): ordering in outbox
 * replay INCLUDING a sender process restart, and per-sender ordering when
 * senders interleave. Crash mid-handler lives in scenarios/ts-only.mjs
 * (the fault hook is a TS-driver capability; see the suite's NOT RUN).
 */

/** Collects `count` message notifications matching `prefix`, in arrival order. */
async function collect(client, prefix, count, timeoutMs) {
  const received = []
  const deadline = Date.now() + timeoutMs
  while (received.length < count && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const notification = await client.waitForEvent(
      value => value.event === 'message' && textOf(value).startsWith(prefix),
      remaining,
      `${count} messages with prefix ${prefix}`,
    )
    received.push(textOf(notification))
  }
  return received
}

export async function runDelivery(t, ctx) {
  await t.test('outbox replay preserves per-sender order across a sender process restart (ADR-0026)', async () => {
    let a = await ctx.openClient('order-a')
    const b = await ctx.openClient('order-b')
    await pair(a, b)

    // Queue while the relay is down, then kill the SENDER: the outbox
    // rows are durable, so the restarted pump replays them.
    await ctx.relay.stop()
    try {
      for (const text of ['replay-1', 'replay-2', 'replay-3']) {
        await a.request('send', { bodyHex: hex(text) })
      }
      const aState = a.stateDir
      const aId = a.me.id
      await a.stop()
      a = await ctx.openClient('order-a-restarted', { stateDir: aState })
      if (a.me.id !== aId) throw new Error('sender identity changed across restart')
    } finally {
      await ctx.relay.start()
    }

    const received = await collect(b, 'replay-', 3, 30_000)
    deepStrictEqual(received, ['replay-1', 'replay-2', 'replay-3'])
  })

  await t.test('per-sender order holds when two senders interleave (ADR-0026)', async () => {
    const a = await ctx.openClient('multi-a')
    const c = await ctx.openClient('multi-c')
    const b = await ctx.openClient('multi-b')
    await pair(a, b)
    await pair(a, c)

    const collecting = Promise.all([
      collect(b, 'a-msg-', 3, 30_000),
      collect(b, 'c-msg-', 3, 30_000),
    ])
    // Interleave the senders; per-sender order is the contract, global
    // interleave is arbitrary.
    for (let index = 1; index <= 3; index += 1) {
      await a.request('send', { bodyHex: hex(`a-msg-${index}`) })
      await c.request('send', { bodyHex: hex(`c-msg-${index}`) })
    }
    const [fromA, fromC] = await collecting
    deepStrictEqual(fromA, ['a-msg-1', 'a-msg-2', 'a-msg-3'])
    deepStrictEqual(fromC, ['c-msg-1', 'c-msg-2', 'c-msg-3'])
  })
}
