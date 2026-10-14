import { notStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { pair } from './lifecycle.mjs'

/**
 * The upgrade-fixture matrix rows (G6; sync ADR-0032, relay ADR-0013).
 *
 * Two fixture families per the core's design (sync fixtures.rs):
 * - PURE-STORAGE states are emitted by `trueseal-cli emit-fixture` and
 *   COMMITTED under testdata/fixtures/ (regenerate with the pinned core's
 *   CLI; at the first preview release the fixture version IS the current
 *   Store Version 1 — the migration floor).
 * - PROTOCOL STATE-MACHINE states (Pending Join, Leaving, Destroying)
 *   are produced by DRIVING A REAL SESSION into the state and crashing
 *   it — their persisted records are session-owned encodings — then
 *   resumed by reopening. (Pending Join's resume row lives in
 *   scenarios/pairing.mjs "restart mid-pairing: the joiner resumes…".)
 *
 * Killed-migration recovery: NO migration chains exist at Store Version 1
 * (the first preview release) — there is nothing to migrate, hence
 * nothing to kill. The machinery is unit-tested in both stores (sync
 * B11's killed-migration retry tests; relay C6's whole-chain rollback
 * tests). The README's matrix maps the G6 row there; the first release
 * with a migration chain must add the scenario-level row.
 */

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Copies a committed fixture store into a fresh state dir. */
function stageFixture(ctx, name, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const source = join(ctx.e2eRepo, 'testdata', 'fixtures', name, 'trueseal_e2e.db')
  copyFileSync(source, join(targetDir, 'trueseal_e2e.db'))
}

async function pollStatus(client, wanted, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = (await client.request('status')).status
    if (last === wanted) return last
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`status did not reach ${wanted} (${label}); last: ${last}`)
}

export async function runUpgrades(t, ctx) {
  await t.test('G6: the member-with-outbox fixture opens and its queue drains to the relay (ADR-0032)', async () => {
    // Own relay: the fixture's queued entry is addressed to a SYNTHETIC
    // manifest member — a random recipient key that exists nowhere — so
    // the pushed row would sit in the shared inbox forever and poison
    // later tests' wait-empty assertions.
    await ctx.relay.stop()
    const ownRelay = ctx.spawnRelay(join(ctx.root, 'fixture-outbox-relay'))
    try {
      await ownRelay.start()
      const stateDir = join(ctx.root, 'fixture-outbox')
      stageFixture(ctx, 'member-with-outbox', stateDir)
      const client = await ctx.openClient('fixture-outbox', { stateDir, relay: ownRelay })
      strictEqual((await client.request('status')).status, 'member')
      // The resumed pump pushes the queued entry: the row landing in
      // the relay store is the drain evidence.
      execFileSync(ctx.duplicateInbox, ['wait-queued', ownRelay.database], { stdio: 'inherit' })
      await client.stop()
    } finally {
      await ownRelay.stop()
      await ctx.relay.start()
    }
  })

  await t.test('G6: the dedup-in-use fixture opens clean (ADR-0032)', async () => {
    const stateDir = join(ctx.root, 'fixture-dedup')
    stageFixture(ctx, 'dedup-in-use', stateDir)
    const client = await ctx.openClient('fixture-dedup', { stateDir })
    strictEqual((await client.request('status')).status, 'member')
    // The dedup table's persistence across this open IS the row — the
    // deeper "a recorded duplicate is never rehandled" semantics are
    // unit-tested at both backends in the core (B11's dedup suite).
    await client.stop()
  })

  await t.test('G6: a Leaving state persisted at crash resumes and completes (ADR-0027/0032)', async () => {
    const a = await ctx.openClient('leave-a')
    let b = await ctx.openClient('leave-b')
    await pair(a, b)

    const bState = b.stateDir
    await b.request('leave')
    // Crash immediately: the Leaving record is durable (B9's two-phase
    // leave), so the reopened session resumes the drain and finishes.
    await b.stop()
    b = await ctx.openClient('leave-b-reopened', { stateDir: bState })
    await pollStatus(b, 'notJoined', 30_000, 'the resumed leave completes')

    // The group converges without the leaver.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const { members } = await a.request('members')
      if (!members.some(member => member.id === b.me.id)) return
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    throw new Error('the group still lists the leaver')
  })

  await t.test('G6: a Destroying state persisted at crash resumes and completes (ADR-0029/0032)', async () => {
    let a = await ctx.openClient('destroying-a')
    const b = await ctx.openClient('destroying-b')
    await pair(a, b)

    const aState = a.stateDir
    await a.request('destroyGroup')
    // Crash the initiator mid-Destroying: the persisted record + queued
    // Revokes resume on reopen and the destroy completes (B12).
    await a.stop()
    const destroyedB = b.waitForEvent(
      value => value.kind === 'statusChanged' && value.status === 'notJoined' && value.reason === 'destroyed',
      30_000,
      'the member still receives the Revoke from the crashed initiator',
    )
    a = await ctx.openClient('destroying-a-reopened', { stateDir: aState })
    await Promise.all([pollStatus(a, 'notJoined', 30_000, 'the resumed destroy completes'), destroyedB])
  })

  await t.test('G6: a newer store is refused typed and left byte-unchanged (ADR-0032 storeTooNew)', async () => {
    const stateDir = join(ctx.root, 'fixture-too-new')
    stageFixture(ctx, 'member-with-outbox', stateDir)
    const database = join(stateDir, 'trueseal_e2e.db')
    // Doctor the Store Version past the migration floor. The version
    // lives in the store's meta table (sync store.rs META_STORE_VERSION),
    // not in the SQLite user_version pragma.
    execFileSync('python3', [
      '-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE meta SET value=99 WHERE key=\'store_version\'"); c.commit(); c.close()',
      database,
    ])
    const before = sha256(database)
    const client = await ctx.spawnOnly('too-new', { stateDir })
    let failure
    try {
      await client.request('open', {
        storagePath: stateDir,
        relay: ctx.relayAddress,
        namespace: 'e2e',
      })
    } catch (error) {
      failure = error
    }
    ok(failure, 'opening a newer store must fail')
    strictEqual(failure.code, 'storeTooNew')
    strictEqual(sha256(database), before, 'a refused store must be byte-unchanged')
    await client.stop()
  })

  await t.test('G6: the relay opens its committed v1 store fixture and serves traffic (relay ADR-0013)', async () => {
    // The relay's committed upgrade fixture (relayRepo testdata) opened
    // by the CURRENT binary, then used for a real pair+send.
    await ctx.relay.stop()
    const fixtureDir = join(ctx.root, 'relay-fixture')
    mkdirSync(fixtureDir, { recursive: true })
    copyFileSync(
      join(ctx.relayRepo, 'internal', 'store', 'sqlite', 'testdata', 'store-v1.db'),
      join(fixtureDir, 'inbox.db'),
    )
    const fixtureRelay = ctx.spawnRelay(fixtureDir)
    try {
      await fixtureRelay.start()
      const a = await ctx.openClient('relay-fixture-a', { relay: fixtureRelay })
      const b = await ctx.openClient('relay-fixture-b', { relay: fixtureRelay })
      await pair(a, b)
      const receipt = b.waitForEvent(
        value => value.event === 'message',
        15_000,
        'a message through the fixture-backed relay',
      )
      await a.request('send', { bodyHex: Buffer.from('fixture-relay', 'utf8').toString('hex') })
      const { message } = await receipt
      ok(message.id.startsWith('tsm1_'))
      const aId = a.me.id
      notStrictEqual(message.from.id, '')
      strictEqual(message.from.id, aId)
      await a.stop()
      await b.stop()
    } finally {
      await fixtureRelay.stop()
      await ctx.relay.start()
    }
  })
}
