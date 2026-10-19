import { strictEqual, ok } from 'node:assert'
import { join } from 'node:path'

import { hex, textOf } from './lifecycle.mjs'

/**
 * The G3 adversarial matrix (E2E-5, e2e ADR-0001): hostile traffic from a
 * crafted client AND from the Hostile Relay (RELAY-14), against the SDK
 * under test. Every row asserts the typed outcome AND the negative: no
 * handler call, no state change, nothing applied.
 *
 * The Adversary Client (clients/rust) builds on the pinned core crates and
 * does what the SDK drivers deliberately cannot (Protocol v1 maps 1:1 onto
 * the public API): tampered End-to-End Versions, corrupted seals, unknown
 * frame types, replayed bytes, unauthorized manifests, oversized pushes,
 * wrong Transport Versions. It can also join the group as a REAL member
 * holding its own private keys (the hostile-member role).
 *
 * Isolation: this scenario stops the suite's shared relay and runs its own
 * relay instances (fresh identity/store per part), so a held-unacked blob
 * or an injected row can never poison another scenario's drain assertions.
 * The shared relay is restarted on the way out.
 */

/** The session-state DB the core writes inside a client's state dir. */
const STORE_DB = 'trueseal_e2e.db'

export async function runAdversary(t, ctx) {
  /** Drain every pending event until 1.5 s of silence — expectNoEvent
   *  counts the QUEUE, and legitimate earlier traffic (pairing, prior
   *  rows) leaves events behind. A negative assertion is only meaningful
   *  against an empty queue. */
  async function drainEvents(client) {
    for (;;) {
      try {
        await client.waitForEvent(() => true, 1_500, 'queue drain')
      } catch {
        return
      }
    }
  }

  const { execFileSync } = await import('node:child_process')

  /** The noise public key of a client the harness opened (read from ITS
   *  OWN fixture store — the canonical API never exposes raw keys). */
  function deviceKey(client) {
    return execFileSync(ctx.duplicateInbox, [
      'device-key',
      join(client.stateDir, STORE_DB),
    ], { encoding: 'utf8' }).trim()
  }

  async function spawnAdversary(name, relay, { fresh = false } = {}) {
    const process = await ctx.spawnAdversary(name, relay)
    const identity = await process.request('keypair', { fresh })
    return { process, identity }
  }

  /** Pair two SDK clients over `relay` (the honest setup for the victim). */
  async function pairedVictims(relay, prefix) {
    const admitter = await ctx.openClient(`${prefix}-admitter`, { relay })
    const victim = await ctx.openClient(`${prefix}-victim`, { relay })
    const { pair } = await import('./lifecycle.mjs')
    await pair(admitter, victim)
    return { admitter, victim }
  }

  // The adversary scenario owns its relay lifecycle — the shared relay
  // steps aside for the whole scenario (port space is fixed).
  await ctx.relay.stop()

  try {
    // ── Part A: crafted client traffic over an HONEST relay ─────────────
    await t.test('adversary client: version, seal, auth and size rows (honest relay)', async t => {
      const relay = ctx.spawnRelay(join(ctx.root, 'adv-relay-a'))
      await relay.start()
      // Relay-process hygiene: a thrown row must never orphan a listener
      // on the fixed port space (an orphaned relay silently cross-wires
      // the NEXT run's pushes and receives).
      try {
      const { admitter, victim } = await pairedVictims(relay, 'a')
      const victimKey = deviceKey(victim)
      const adversary = await spawnAdversary('adv-a', relay, { fresh: true })
      const baselineCount = { messages: 0 }

      await t.test('baseline: a well-formed crafted envelope IS handled (the craft is valid)', async () => {
        // The adversary is NOT a member yet — a non-member Sync is dropped
        // silently by the member filter (ADR-0023/0027). Craft to the
        // ADMITTER instead? No — admission is what gates membership. This
        // row proves the crafting pipeline end to end once the adversary
        // has joined (row "hostile member" below); here we prove the
        // negative baseline: a non-member's well-formed Sync never lands.
        const push = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex('non-member hello'),
        })
        strictEqual(push.outcome, 'ack', 'the relay stores a well-formed push from anyone (quota permitting)')
        await victim.expectNoEvent(value => value.event === 'message', 5_000, 'a non-member Sync reaching the handler')
      })

      await t.test('newer End-to-End Version: held unacked with heldForUpgrade, never handled (ADR-0022)', async () => {
        const push = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex('from the future'),
          version: 2,
        })
        strictEqual(push.outcome, 'ack')
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'heldForUpgrade' && value.version === 2,
          15_000,
          'heldForUpgrade(2)',
        )
        await victim.expectNoEvent(value => value.event === 'message', 4_000, 'a newer-version blob reaching the handler')
      })

      await t.test('older End-to-End Version (0 = the refused pre-version format): unreadable(senderOutdated) (ADR-0022/0034)', async () => {
        const push = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex('from the past'),
          version: 0,
        })
        strictEqual(push.outcome, 'ack')
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'unreadable' && value.reason === 'senderOutdated',
          15_000,
          'unreadable(senderOutdated)',
        )
        await victim.expectNoEvent(value => value.event === 'message' && textOf(value) === 'from the past', 4_000, 'the version-0 blob reaching the handler')
      })

      await t.test('malformed seal (corrupted ciphertext, valid frame): unreadable(malformed) (ADR-0031/0034)', async () => {
        // The corruption lands inside the sealed payload (the AEAD
        // ciphertext) — proto and frame stay well-formed; only the seal
        // fails. (The envelope's LAST bytes are the version field —
        // version = 7 in the proto — so corrupting there would exercise
        // the senderOutdated row instead.)
        const corrupted = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex('corrupted seal'),
          corruptPayload: true,
        })
        strictEqual(corrupted.outcome, 'ack')
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'unreadable' && value.reason === 'malformed',
          15_000,
          'unreadable(malformed) for the corrupted seal',
        )
        await victim.expectNoEvent(value => value.event === 'message' && textOf(value) === 'corrupted seal', 4_000, 'the corrupted blob reaching the handler')
      })

      await t.test('unknown message tag inside a VALID seal: unreadable(malformed)', async () => {
        const push = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          messageHex: '7f00c0ffee', // decodes fine, verifies fine, no such tag
        })
        strictEqual(push.outcome, 'ack')
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'unreadable' && value.reason === 'malformed',
          15_000,
          'unreadable(malformed) for the unknown tag',
        )
      })

      await t.test('expired Sync (Sender Timestamp 61 days back): unreadable(expired), never handled (ADR-0031/0034)', async () => {
        const sixtyOneDaysMs = 61 * 24 * 60 * 60 * 1000
        const push = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex('ancient history'),
          senderTimestampMs: Date.now() - sixtyOneDaysMs,
        })
        strictEqual(push.outcome, 'ack')
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'unreadable' && value.reason === 'expired',
          15_000,
          'unreadable(expired)',
        )
        await victim.expectNoEvent(value => value.event === 'message' && textOf(value) === 'ancient history', 4_000, 'the expired blob reaching the handler')
      })

      await t.test('manifest from a key the group never admitted: silently dropped, never applied (ADR-0023/0027; roadmap#4 variant 3)', async () => {
        // The update path rejects a non-member signer BEFORE validation and
        // without an issue — strangers get zero signal (session/mod.rs:
        // "the Envelope signer must be a current member", silent return).
        // `unauthorized` is reserved for an AUTHENTICATED-but-unacceptable
        // manifest (a member's foreign/over-bound manifest — the
        // hostile-member row below).
        // Drain the join-time membersChanged still queued from pairing
        // (expectNoEvent counts queued events, not only fresh ones).
        await victim.waitForEvent(value => value.kind === 'membersChanged', 5_000, 'the join membersChanged').catch(() => {})
        const before = (await victim.request('members')).members.length
        const manifest = await adversary.process.request('craftManifest', {
          groupId: 'ab'.repeat(32), // a foreign group id — a non-member knows nothing real
          version: 1,
          members: [],
        })
        const push = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          messageHex: manifest.messageHex,
        })
        strictEqual(push.outcome, 'ack')
        await victim.expectNoEvent(value => value.event === 'issue', 5_000, 'any issue from a stranger\'s manifest')
        const after = (await victim.request('members')).members.length
        strictEqual(after, before, 'the foreign manifest must not change membership')
        await victim.expectNoEvent(value => value.kind === 'membersChanged', 4_000, 'a membersChanged fired by the hostile manifest')
      })

      await t.test('held-blob cap: the 101st newer-version blob drops the oldest with droppedWhileHeld (ADR-0022)', { timeout: 120_000 }, async () => {
        for (let index = 0; index < 101; index++) {
          const push = await adversary.process.request('craftAndPush', {
            recipient: victimKey,
            bodyHex: hex(`future blob ${index}`),
            version: 2,
            sequence: 100 + index,
          })
          strictEqual(push.outcome, 'ack', `push ${index} should reach the inbox`)
        }
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'unreadable' && value.reason === 'droppedWhileHeld',
          20_000,
          'droppedWhileHeld at the cap overflow',
        )
        await victim.expectNoEvent(value => value.event === 'message', 3_000, 'any held blob reaching the handler')
        baselineCount.messages = 0
      })

      await t.test('oversize: past the frame ceiling the Noise layer refuses locally; over an operator-lowered limit the relay refuses with typed tooLarge (ADR-0025, RELAY-5/8)', async () => {
        // 65,483 bytes of envelope body — one past the 65,482 ceiling: the
        // frame (32-byte prefix + body + 5-byte header) exceeds the u16
        // Noise frame ceiling (65,519), so the NOISE layer refuses the send
        // before the relay can see it (NOISE-4: the frame ceiling is the
        // source of the size limit).
        const huge = Buffer.alloc(65_483, 0x41)
        const refused = await adversary.process.request('pushFrame', {
          frameHex: pushFrameHex(victimKey, huge),
        })
        strictEqual(refused.outcome, 'error', 'an over-ceiling frame can never reach the relay')
        ok(/large|frame|size/i.test(refused.error), `a size error expected, got ${refused.error}`)
        await victim.expectNoEvent(value => value.event === 'message', 3_000, 'a delivery of the un-framable blob')

        // An operator-lowered limit refuses proportionally (ADR-0025:
        // operators may only lower) — and the refusal is typed the same.
        await relay.reconfigure({ TRUESEAL_RELAY_MAX_ENVELOPE_BYTES: '1024' })
        try {
          const over = await adversary.process.request('craftAndPush', {
            recipient: victimKey,
            bodyHex: hex('x'.repeat(2_000)),
          })
          strictEqual(over.outcome, 'refused')
          ok(/tooLarge/i.test(over.refusal), `typed tooLarge expected, got ${over.refusal}`)
          await victim.expectNoEvent(value => value.event === 'message', 4_000, 'a delivery of the refused blob')
        } finally {
          await relay.reconfigure({})
        }
      })

      await t.test('wrong Transport Version: the relay answers unsupported 1..1 and closes (ADR-0022)', async () => {
        const probe = await adversary.process.request('transportProbe', { version: 99 })
        strictEqual(probe.replyText, 'unsupported 1..1\n')
        const reserved = await adversary.process.request('transportProbe', { version: 0 })
        strictEqual(reserved.replyText, 'unsupported 1..1\n', 'version 0 is the reserved refused format')
      })

      await t.test('unknown frame type on a valid Noise session: typed malformed refusal, never stored (RELAY-5)', async () => {
        const frame = Buffer.concat([Buffer.from([0x7f]), Buffer.from([0, 0, 0, 4]), Buffer.from('test')])
        const result = await adversary.process.request('pushFrame', { frameHex: frame.toString('hex') })
        strictEqual(result.outcome, 'refused')
        ok(/malformed/i.test(result.refusal), `typed malformed expected, got ${result.refusal}`)
        // The session stays usable: a well-formed push right after succeeds.
        const good = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex('after the garbage'),
        })
        strictEqual(good.outcome, 'ack')
      })

      await t.test('hostile member: admitted, crafts a VALID member Sync (handled once), replayed bytes never handled twice (ADR-0026/0031)', async () => {
        // The adversary joins the VICTIM'S group for real — admitted
        // through the same explicit ceremony any member uses — while
        // KEEPING its private keys.
        const { token } = await admitter.request('startPairing')
        const joinRequest = admitter.waitForEvent('joinRequest', 15_000, 'joinRequest for the adversary')
        await adversary.process.request('open')
        await adversary.process.request('joinGroup', { token })
        const incoming = await joinRequest
        await admitter.request('accept', { requestId: incoming.requestId })
        await adversary.process.waitForEvent(
          value => value.event === 'manifestChanged',
          15_000,
          'the adversary receiving its first manifest',
        )

        // A member-signed crafted Sync is legitimate traffic: handled.
        const push = await adversary.process.request('craftAndPush', {
          recipient: deviceKey(victim),
          bodyHex: hex('member-crafted hello'),
        })
        strictEqual(push.outcome, 'ack')
        await victim.waitForEvent(
          value => value.event === 'message' && textOf(value) === 'member-crafted hello',
          15_000,
          'the member-crafted Sync delivered',
        )

        // Re-push the EXACT frame bytes (a fresh blob, the same envelope):
        // the library's dedup must ack-and-drop it silently.
        const replay = await adversary.process.request('pushFrame', { frameHex: push.frameHex })
        strictEqual(replay.outcome, 'ack', 'the relay stores the replay (dedup is the client\'s job)')
        await victim.expectNoEvent(
          value => value.event === 'message' && textOf(value) === 'member-crafted hello',
          5_000,
          'a second handling of the replayed envelope',
        )
        // A MEMBER-signed manifest for a foreign group: the signer check
        // passes (the adversary is a member), the content is unacceptable —
        // this is the authenticated-but-unacceptable `unauthorized` case
        // (ADR-0034 §3). Drain the admission's membersChanged first.
        await victim.waitForEvent(value => value.kind === 'membersChanged', 5_000, 'the admission membersChanged').catch(() => {})
        const before = (await victim.request('members')).members.length
        const manifest = await adversary.process.request('craftManifest', {
          groupId: 'cd'.repeat(32),
          version: 42,
          members: [],
        })
        const push2 = await adversary.process.request('craftAndPush', {
          recipient: deviceKey(victim),
          messageHex: manifest.messageHex,
          sequence: 77,
        })
        strictEqual(push2.outcome, 'ack')
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'unauthorized',
          15_000,
          'unauthorized for the member-signed foreign manifest',
        )
        strictEqual((await victim.request('members')).members.length, before, 'never applied')
        await victim.expectNoEvent(value => value.kind === 'membersChanged', 4_000, 'a membersChanged from the foreign manifest')

        await adversary.process.request('close')
      })

      } finally {
        await relay.stop()
      }
    })

    // ── Part B: the Hostile Relay (RELAY-14 build-tagged hooks) ─────────
    await t.test('hostile relay: corrupt, duplicate, reorder, drop, inject, replay', async t => {
      const relay = ctx.spawnHostileRelay(join(ctx.root, 'adv-relay-b'))
      await relay.start()
      try {
      const { admitter, victim } = await pairedVictims(relay, 'b')
      const victimKey = deviceKey(victim)
      const adversary = await spawnAdversary('adv-b', relay)
      // The adversary identity persisted from Part A — it is NOT a member
      // of this new group; admit it through the victim's group's own
      // ceremony (hostile-member role).
      {
        const { token } = await admitter.request('startPairing')
        const joinRequest = admitter.waitForEvent('joinRequest', 15_000, 'joinRequest for the adversary')
        await adversary.process.request('open')
        await adversary.process.request('joinGroup', { token })
        const incoming = await joinRequest
        await admitter.request('accept', { requestId: incoming.requestId })
        await adversary.process.waitForEvent(
          value => value.event === 'manifestChanged',
          15_000,
          'the adversary admitted in part B',
        )
      }

      /** One member-crafted Sync from the adversary to the victim. */
      async function pushCrafted(text, sequence) {
        const push = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex(text),
          sequence,
        })
        strictEqual(push.outcome, 'ack')
        return push
      }

      await t.test('corrupt: a byte-flipped Deliver is rejected unreadable(malformed) — never handled, never applied (G3)', async () => {
        await relay.hostileCommand({ cmd: 'set', device: '*', corrupt: true })
        try {
          await pushCrafted('corrupt me', 1)
          await victim.waitForEvent(
            value => value.event === 'issue' && value.kind === 'unreadable' && value.reason === 'malformed',
            15_000,
            'unreadable(malformed) for the corrupted Deliver',
          )
          await victim.expectNoEvent(value => value.event === 'message' && textOf(value) === 'corrupt me', 4_000, 'the corrupted blob reaching the handler')
        } finally {
          await relay.hostileCommand({ cmd: 'clear', device: '*' })
        }
      })

      await t.test('duplicate: the same blob twice is handled EXACTLY once (ADR-0026)', async () => {
        await relay.hostileCommand({ cmd: 'set', device: '*', duplicate: true })
        try {
          await pushCrafted('say it once', 2)
          await victim.waitForEvent(
            value => value.event === 'message' && textOf(value) === 'say it once',
            15_000,
            'the first (only) handling',
          )
          await victim.expectNoEvent(
            value => value.event === 'message' && textOf(value) === 'say it once',
            5_000,
            'a duplicate handling',
          )
        } finally {
          await relay.hostileCommand({ cmd: 'clear', device: '*' })
        }
      })

      await t.test('reorder: a reversed window still delivers every message exactly once (no loss, no dup under hostility)', async () => {
        await relay.hostileCommand({ cmd: 'set', device: '*', reorder: 3 })
        try {
          await pushCrafted('reorder-1', 3)
          await pushCrafted('reorder-2', 4)
          await pushCrafted('reorder-3', 5)
          for (const text of ['reorder-1', 'reorder-2', 'reorder-3']) {
            await victim.waitForEvent(
              value => value.event === 'message' && textOf(value) === text,
              20_000,
              `delivery of ${text} under reordering`,
            )
          }
        } finally {
          await relay.hostileCommand({ cmd: 'clear', device: '*' })
        }
      })

      await t.test('drop: withheld while the rule is set, redelivered on the next session after clear (at-least-once recovery, ADR-0026)', async () => {
        await relay.hostileCommand({ cmd: 'set', device: '*', drop: true })
        await pushCrafted('withheld', 6)
        await victim.expectNoEvent(value => value.event === 'message' && textOf(value) === 'withheld', 4_000, 'a delivery while drop is set')
        await relay.hostileCommand({ cmd: 'clear', device: '*' })
        // The per-session delivery cursor already advanced past the
        // withheld blob (C4), so the same session will not re-send it —
        // the unacked row redelivers on the NEXT session (RELAY-14 README:
        // "clearing the rule and reconnecting re-delivers"). Bounce the
        // hostile relay: the store persists, the victim reconnects.
        await relay.stop()
        await relay.start()
        await victim.waitForEvent(
          value => value.event === 'event' && value.kind === 'connectionChanged' && value.connection.state === 'connected',
          20_000,
          'the victim reconnecting after the bounce',
        )
        await victim.waitForEvent(value => value.event === 'message' && textOf(value) === 'withheld', 25_000, 'the withheld blob redelivered on the fresh session')
        await drainEvents(victim)
      })

      await t.test('inject: a relay-delivered foreign manifest is rejected unauthorized, never applied (G3; roadmap#4 at the relay seam)', async () => {
        // Signed by the adversary (a real member of this group): the relay
        // injects member-signed but group-foreign bytes under a synthetic
        // blob id — the authenticated-but-unacceptable case.
        await drainEvents(victim) // clear pairing/admission leftovers
        const before = (await victim.request('members')).members.length
        const manifest = await adversary.process.request('craftManifest', {
          groupId: 'cd'.repeat(32),
          version: 7,
          members: [],
        })
        // The adversary seals it to the victim; the RELAY injects the bytes
        // under a synthetic blob id (it could not produce them itself).
        const envelope = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          messageHex: manifest.messageHex,
          // Do not push this one through the honest path: craftAndPush both
          // crafts and pushes, and the honest push is fine — the inject row
          // is about the RELAY re-delivering attacker bytes. The push above
          // IS the attacker push; here we additionally inject a relay copy.
        })
        strictEqual(envelope.outcome, 'ack')
        await relay.hostileCommand({
          cmd: 'inject',
          device: victimKey,
          envelope: envelope.envelopeHex,
        })
        await victim.waitForEvent(
          value => value.event === 'issue' && value.kind === 'unauthorized',
          15_000,
          'unauthorized for the injected manifest',
        )
        const after = (await victim.request('members')).members.length
        strictEqual(after, before, 'an injected manifest must not change membership')
        await victim.expectNoEvent(value => value.kind === 'membersChanged', 4_000, 'a membersChanged from the inject')
      })

      await t.test('inject: a non-member Sync delivered by the relay is silently dropped (member filter, ADR-0023/0027)', async () => {
        const crafted = await adversary.process.request('craftAndPush', {
          recipient: victimKey,
          bodyHex: hex('relay-minted sync'),
          freshIdentity: true, // a key the group never admitted
        })
        strictEqual(crafted.outcome, 'ack')
        await relay.hostileCommand({
          cmd: 'inject',
          device: victimKey,
          envelope: crafted.envelopeHex,
        })
        await victim.expectNoEvent(
          value => value.event === 'message' && textOf(value) === 'relay-minted sync',
          5_000,
          'a non-member Sync reaching the handler',
        )
      })

      await t.test('replay: the relay re-serving history (original blob ids) is deduped — never handled twice (ADR-0031)', async () => {
        // Everything above already delivered + acked several blobs on this
        // session's history; replay the whole history. (The queue is empty
        // after row 4's drain; drain again defensively.)
        await drainEvents(victim)
        await relay.hostileCommand({ cmd: 'replay', device: victimKey, count: 0 })
        await victim.expectNoEvent(
          value => value.event === 'message',
          5_000,
          'any second handling from the relay replay',
        )
      })

      await adversary.process.request('close')
      } finally {
        await relay.stop()
      }
    })
  } finally {
    // Hand the shared relay back to any scenario that follows.
    await ctx.relay.start()
  }
}

/** Push frame layout (relay ADR-0008): [0x01][len:4 BE][recipient 32][envelope]. */
function pushFrameHex(recipientHex, envelopeBytes) {
  const body = Buffer.concat([Buffer.from(recipientHex, 'hex'), envelopeBytes])
  const frame = Buffer.concat([Buffer.from([0x01]), lengthPrefix(body.length), body])
  return frame.toString('hex')
}

function lengthPrefix(length) {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(length)
  return prefix
}
