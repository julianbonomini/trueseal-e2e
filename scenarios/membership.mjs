import { deepStrictEqual, ok } from 'node:assert/strict'

import { hex, pair, textOf } from './lifecycle.mjs'

/**
 * The membership matrix rows (AGENTS.md: "membership addition and removal,
 * including silence after removal; concurrent membership updates"; sync
 * ADR-0027).
 */

/** Polls members until the id set equals `expected` (sorted). Self is
 *  filtered out first: the Swift/Kotlin 'members-includes-self' known
 *  deviation (lib/sdk-drivers.mjs) makes self-inclusion nondeterministic
 *  — the deterministic contract asserted here is the PEER SET. */
async function membersConvergeTo(client, expectedIds, timeoutMs = 20_000) {
  const expected = [...expectedIds].sort()
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = (await client.request('members')).members
      .map(member => member.id)
      .filter(id => id !== client.me.id)
      .sort()
    if (last.length === expected.length && last.every((id, index) => id === expected[index])) return last
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(
    `members did not converge: expected ${JSON.stringify(expected)}, last ${JSON.stringify(last)}`,
  )
}

export async function runMembership(t, ctx) {
  await t.test('a third device joins an existing group and every member sees everyone', async () => {
    const a = await ctx.openClient('mem3-a')
    const b = await ctx.openClient('mem3-b')
    const c = await ctx.openClient('mem3-c')
    await pair(a, b)
    await pair(a, c)

    for (const [client, others] of [
      [a, [b.me.id, c.me.id]],
      [b, [a.me.id, c.me.id]],
      [c, [a.me.id, b.me.id]],
    ]) {
      await membersConvergeTo(client, others)
    }

    // Fan-out reaches the newest member.
    const toC = c.waitForEvent(
      value => value.event === 'message' && textOf(value) === 'third-device',
      15_000,
      'message to the third device',
    )
    await a.request('send', { bodyHex: hex('third-device') })
    await toC
  })

  await t.test('silence after removal: the removed device receives nothing and cannot send (ADR-0027)', async () => {
    const a = await ctx.openClient('silence-a')
    const b = await ctx.openClient('silence-b')
    await pair(a, b)

    const removed = b.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'removed',
      15_000,
      'statusChanged(notJoined, removed)',
    )
    await a.request('remove', { memberId: b.me.id })
    await removed

    // The removed device's identity is wiped and rotated — it is not a
    // member, so its send is refused typed.
    let failure
    try {
      await b.request('send', { bodyHex: hex('from-removed') })
    } catch (error) {
      failure = error
    }
    ok(failure, 'a removed device must not be able to send')
    strictEqualCode(failure, 'notMember')

    // The group's fan-out no longer addresses the removed device.
    await a.request('send', { bodyHex: hex('after-removal') })
    await b.expectNoEvent(
      value => value.event === 'message',
      5_000,
      'any message on the removed device',
    )
  })

  await t.test('concurrent admissions by two members converge on one membership (ADR-0027)', async () => {
    const a = await ctx.openClient('conc-a')
    const b = await ctx.openClient('conc-b')
    const c = await ctx.openClient('conc-c')
    const d = await ctx.openClient('conc-d')
    await pair(a, b)

    // Both members open windows and admit different joiners with no
    // convergence wait in between — the (version, hash) total order and
    // the issuer's automatic re-application must settle everyone on the
    // same four-device membership.
    const tokenA = (await a.request('startPairing')).token
    const tokenB = (await b.request('startPairing')).token
    const requestA = a.waitForEvent('joinRequest', 15_000, 'joinRequest on a')
    const requestB = b.waitForEvent('joinRequest', 15_000, 'joinRequest on b')
    await c.request('join', { token: tokenA })
    await d.request('join', { token: tokenB })
    const [incomingA, incomingB] = await Promise.all([requestA, requestB])

    const joinedC = c.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'member' && value.reason === 'joined',
      20_000,
      'c joined',
    )
    const joinedD = d.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'member' && value.reason === 'joined',
      20_000,
      'd joined',
    )
    await a.request('accept', { requestId: incomingA.requestId })
    await b.request('accept', { requestId: incomingB.requestId })
    await Promise.all([joinedC, joinedD])

    const all = [a.me.id, b.me.id, c.me.id, d.me.id]
    for (const client of [a, b, c, d]) {
      const settled = await membersConvergeTo(client, all.filter(id => id !== client.me.id), 30_000)
      deepStrictEqual(settled.length, 3)
    }

    // And the converged group is functional for every member.
    const receipt = d.waitForEvent(
      value => value.event === 'message' && textOf(value) === 'post-convergence',
      15_000,
      'a post-convergence message',
    )
    await b.request('send', { bodyHex: hex('post-convergence') })
    await receipt
  })
}

function strictEqualCode(error, code) {
  if (error.code !== code) {
    throw new Error(`expected error code ${code}, got ${error.code}: ${error.message}`)
  }
}
