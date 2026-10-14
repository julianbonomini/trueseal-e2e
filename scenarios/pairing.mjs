import { strictEqual } from 'node:assert/strict'

import { pair } from './lifecycle.mjs'

/**
 * The pairing matrix rows (AGENTS.md: "pairing and explicit admission,
 * including reject, cancel, bad token and restart mid-pairing"; sync
 * ADR-0023). Driver-protocol only — every lane runs every row.
 */

/** Polls a command until predicate(value) holds; returns the value. */
async function pollUntil(command, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await command()
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)}`)
}

export async function runPairing(t, ctx) {
  await t.test('a malformed pairing token is refused typed (ADR-0023)', async () => {
    const c = await ctx.openClient('pair-bad-token')
    let failure
    try {
      await c.request('join', { token: 'ts1_not-a-real-token' })
    } catch (error) {
      failure = error
    }
    strictEqual(failure?.code, 'invalidPairingToken')
    strictEqual((await c.request('status')).status, 'notJoined')
  })

  await t.test('cancelJoin returns a pending join to notJoined', async () => {
    const host = await ctx.openClient('pair-cancel-host')
    const joiner = await ctx.openClient('pair-cancel-joiner')
    const { token } = await host.request('startPairing')
    await joiner.request('join', { token })
    strictEqual((await joiner.request('status')).status, 'pendingJoin')
    await joiner.request('cancelJoin')
    strictEqual((await joiner.request('status')).status, 'notJoined')
    await host.request('cancelPairing')
  })

  await t.test('reject: a window closed without accept never admits (ADR-0023: no decline message)', async () => {
    const host = await ctx.openClient('pair-reject-host')
    const joiner = await ctx.openClient('pair-reject-joiner')
    const { token } = await host.request('startPairing')
    const request = host.waitForEvent('joinRequest', 15_000, 'joinRequest event')
    await joiner.request('join', { token })
    await request
    // The host declines by cancelling the window — no decline message
    // exists on the wire. The joiner stays pendingJoin (its Pending Join
    // gates the first manifest, which never comes).
    await host.request('cancelPairing')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    strictEqual((await joiner.request('status')).status, 'pendingJoin')
    await joiner.request('cancelJoin')
  })

  await t.test('restart mid-pairing: the joiner resumes from its persisted Pending Join (G6 state)', async () => {
    const host = await ctx.openClient('pair-restart-host')
    let joiner = await ctx.openClient('pair-restart-joiner')
    const { token } = await host.request('startPairing')
    const request = host.waitForEvent('joinRequest', 15_000, 'joinRequest event')
    await joiner.request('join', { token })
    const incoming = await request

    // Crash the joiner before admission: the Pending Join record is
    // durable (ADR-0023), so the reopened session is still pendingJoin
    // and the SAME admission completes it.
    const joinerState = joiner.stateDir
    const joinerId = joiner.me.id
    await joiner.stop()
    joiner = await ctx.openClient('pair-restart-joiner-reopened', { stateDir: joinerState })
    strictEqual(joiner.me.id, joinerId)
    strictEqual((await joiner.request('status')).status, 'pendingJoin')

    const joined = joiner.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'member' && value.reason === 'joined',
      15_000,
      'statusChanged(member, joined) after the restart',
    )
    await host.request('accept', { requestId: incoming.requestId })
    await joined
  })

  await t.test('restart mid-pairing: a host restart spends the in-memory window (ADR-0023)', async () => {
    let host = await ctx.openClient('pair-host-restart')
    const joiner = await ctx.openClient('pair-host-restart-joiner')
    const { token } = await host.request('startPairing')
    const request = host.waitForEvent('joinRequest', 15_000, 'joinRequest event')
    await joiner.request('join', { token })
    await request

    // The Pairing Secret lives in memory only — a host restart spends
    // the window, so the pending request can no longer be accepted.
    // The joiner stays pendingJoin until it cancels; a FRESH window
    // admits it (the documented recovery).
    const hostState = host.stateDir
    await host.stop()
    host = await ctx.openClient('pair-host-restart-reopened', { stateDir: hostState })
    await new Promise(resolve => setTimeout(resolve, 1_000))
    strictEqual((await joiner.request('status')).status, 'pendingJoin')

    const fresh = await host.request('startPairing')
    const freshRequest = host.waitForEvent('joinRequest', 15_000, 'joinRequest on the fresh window')
    await joiner.request('cancelJoin')
    await joiner.request('join', { token: fresh.token })
    const incoming = await freshRequest
    const joined = joiner.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'member' && value.reason === 'joined',
      15_000,
      'statusChanged(member, joined) on the fresh window',
    )
    await host.request('accept', { requestId: incoming.requestId })
    await joined
  })

  await t.test('explicit admission completes the happy path (template check)', async () => {
    const a = await ctx.openClient('pair-happy-a')
    const b = await ctx.openClient('pair-happy-b')
    await pair(a, b)
    await pollUntil(
      () => a.request('members'),
      value => value.members.some(member => member.id === b.me.id),
      10_000,
      'the host listing the joiner',
    )
  })
}
