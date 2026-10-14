import { createServer } from 'node:net'

import { hex, pair, textOf } from './lifecycle.mjs'

/**
 * The version-compatibility matrix rows (sync ADR-0022). Scenario-testable
 * through the driver protocol: the Transport Version refusal. A stub
 * server speaks the plaintext prefix exchange ("TSP"||u16) and replies
 * `unsupported <min>..<max>` — the client must surface the typed
 * relayVersionUnsupported connection state, keep outbox entries queued
 * (nothing is lost), and recover when a compatible relay returns.
 *
 * NOT scenario-testable through Protocol v1 (and deliberately so): the
 * End-to-End Version rows (newer held / older dropped / malformed) and
 * the malformed/replayed/unauthorized frame rows. Those need crafted
 * envelopes — a capability the driver protocol must NOT grow, because it
 * maps 1:1 onto the public API. They are the Adversary Client's rows
 * (E2E-5, trueseal-e2e#9, on the Rust base per ADR-0001); the README's
 * matrix maps them there. The outbox upgrade transition is G6's
 * (scenarios/upgrades.mjs + the core's re-seal unit tests).
 */

/** A stub that refuses the version exchange with `unsupported 5..7`. */
function startRefusingStub() {
  const connections = []
  const handle = socket => {
    connections.push(socket)
    let received = Buffer.alloc(0)
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      if (received.length >= 5) {
        socket.end('unsupported 5..7\n')
      }
    })
    socket.on('error', () => {})
  }
  const receive = createServer(handle)
  const push = createServer(handle)
  return new Promise((resolvePromise, rejectPromise) => {
    receive.listen(7700, '127.0.0.1', () => {
      push.listen(7701, '127.0.0.1', () => {
        resolvePromise({
          async stop() {
            for (const socket of connections) socket.destroy()
            await Promise.all([
              new Promise(done => receive.close(done)),
              new Promise(done => push.close(done)),
            ])
          },
        })
      })
    })
    receive.on('error', rejectPromise)
    push.on('error', rejectPromise)
  })
}

export async function runVersions(t, ctx) {
  await t.test('an unsupported Transport Version surfaces typed, queues nothing away, and recovers (ADR-0022)', async () => {
    const a = await ctx.openClient('ver-a')
    const b = await ctx.openClient('ver-b')
    await pair(a, b)
    const aState = a.stateDir
    await a.stop()

    // Swap the real relay for a stub that refuses the version exchange.
    await ctx.relay.stop()
    const stub = await startRefusingStub()
    try {
      const a2 = await ctx.openClient('ver-a-refused', { stateDir: aState })
      const refusal = await a2.waitForEvent(
        value => value.kind === 'connectionChanged'
          && value.connection.state === 'relayVersionUnsupported',
        20_000,
        'connectionChanged(relayVersionUnsupported)',
      )
      if (refusal.connection.min !== 5 || refusal.connection.max !== 7) {
        throw new Error(
          `expected relayVersionUnsupported{min:5,max:7}, got ${JSON.stringify(refusal.connection)}`,
        )
      }

      // send() is durable-queue semantics: it resolves, and the entry
      // stays queued — no sendFailed, no loss (SYNC-1's criterion).
      const { messageId } = await a2.request('send', { bodyHex: hex('queued-through-refusal') })
      await a2.expectNoEvent(
        value => value.event === 'issue' && value.kind === 'sendFailed' && value.messageId === messageId,
        5_000,
        'a sendFailed while the relay is version-refused',
      )
      await a2.stop()
    } finally {
      await stub.stop()
      await ctx.relay.start()
    }

    // The compatible relay returns: the queued message is delivered.
    const a3 = await ctx.openClient('ver-a-recovered', { stateDir: aState })
    await a3.waitForEvent(
      value => value.kind === 'connectionChanged' && value.connection.state === 'connected',
      20_000,
      'reconnected to the compatible relay',
    )
    await b.waitForEvent(
      value => value.event === 'message' && textOf(value) === 'queued-through-refusal',
      30_000,
      'the message queued through the refusal, delivered after recovery',
    )
  })
}
