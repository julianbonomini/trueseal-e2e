import { execFileSync } from 'node:child_process'

import { hex, pair, textOf } from './lifecycle.mjs'

/**
 * The TTL expiry boundary rows (AGENTS.md + e2e ADR-0001; sync ADR-0026's
 * 30-day Sync expiry and ADR-0034's relay TTL cap). THE RELEASE-BLOCKING
 * GAP this task owns: these are the first TTL boundary tests anywhere —
 * the threat model's delivery claim shipped without its numeric-lifetime
 * block, and this file's landing is the evidence to restore it.
 *
 * What is scenario-testable: the RELAY-side TTL. A blob accepted by the
 * relay (the sender's outbox copy is deleted on acceptance, ADR-0026)
 * lives in the recipient's inbox until the TTL; the reaper removes it and
 * NOBODY resends — delivery within the TTL, silent loss past it. Both
 * sides of the boundary run here with a seconds-long operator TTL
 * (ADR-0001: short relay settings through normal config only).
 *
 * What is NOT real-time scenario-testable: the client-side 30-day Sync
 * expiry and the 60-day Replay Window. Those boundaries are unit-tested
 * at both sides in the core (sync B10's sealed-envelope suite:
 * 59d-accepted / 61d-rejected, expired → acked + unreadable(expired);
 * relay C10's 30-day TTL-cap refusal at startup). The README's matrix
 * maps the claim to those tests plus this file.
 */

export async function runTtl(t, ctx) {
  await t.test('TTL boundary: delivered just under, silently gone just past (sync ADR-0026/0034)', async () => {
    // TTL headroom is chosen for LOADED CI runners: phase 1 must leave a
    // stopped recipient enough time to reopen and drain (driver spawn +
    // handshake can take seconds under load), and phase 2's reap wait is
    // generous because the reaper's 1s tick slips under CPU starvation.
    // A leftover row here poisons later tests' wait-empty assertions, so
    // phase 2 does not exit before the row is provably gone.
    await ctx.relay.reconfigure({
      TRUESEAL_RELAY_TTL: '12s',
      TRUESEAL_RELAY_REAP_INTERVAL: '1s',
    })
    const helperEnv = { ...process.env, DUPLICATE_INBOX_TIMEOUT_S: '60' }
    try {
      const a = await ctx.openClient('ttl-a')
      let b = await ctx.openClient('ttl-b')
      await pair(a, b)
      const bState = b.stateDir

      // ── Under the boundary: the recipient returns before expiry.
      await b.stop()
      await a.request('send', { bodyHex: hex('within-ttl') })
      await new Promise(resolve => setTimeout(resolve, 2_000))
      b = await ctx.openClient('ttl-b-within', { stateDir: bState })
      await b.waitForEvent(
        value => value.event === 'message' && textOf(value) === 'within-ttl',
        20_000,
        'the message delivered within the TTL',
      )
      execFileSync(ctx.duplicateInbox, ['wait-empty', ctx.relay.database], { stdio: 'inherit', env: helperEnv })

      // ── Over the boundary: the blob is reaped before the recipient
      // returns, and nobody resends (the sender's copy was deleted on
      // relay acceptance — this is the documented availability limit).
      await b.stop()
      await a.request('send', { bodyHex: hex('past-ttl') })
      execFileSync(ctx.duplicateInbox, ['wait-queued', ctx.relay.database], { stdio: 'inherit', env: helperEnv })
      // The reaper (1s interval) removes it once the 12s TTL passes.
      execFileSync(ctx.duplicateInbox, ['wait-empty', ctx.relay.database], { stdio: 'inherit', env: helperEnv })
      b = await ctx.openClient('ttl-b-past', { stateDir: bState })
      await b.expectNoEvent(
        value => value.event === 'message' && textOf(value) === 'past-ttl',
        8_000,
        'a message whose inbox copy expired past the TTL',
      )
      console.log('')
      console.log(
        `note — ${ctx.sdk}: the past-TTL message was reaped before the recipient returned; ` +
          'no resend exists by design (sender copy deleted on acceptance)',
      )
      console.log('')
    } finally {
      await ctx.relay.reconfigure({})
    }
  })
}
