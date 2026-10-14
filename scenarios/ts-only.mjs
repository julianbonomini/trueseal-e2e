import { execFileSync } from 'node:child_process'

import { hex } from './lifecycle.mjs'

/**
 * Scenarios that need a harness-only fault-injection capability only the
 * TS driver has today (TRUESEAL_E2E_DROP_BEFORE_COMMIT_TEXT). The suite
 * reports them NOT RUN for drivers without the capability — a loud,
 * scenario-granular skip with the reason named, never a silent one.
 */
export const TS_ONLY_SCENARIOS = {
  requiredCapability: 'dropBeforeCommit',
  reason:
    'needs the TS driver-only fault hook TRUESEAL_E2E_DROP_BEFORE_COMMIT_TEXT (the app misses its commit; no Kotlin/Swift driver exposes an equivalent)',

  async run(t, ctx) {
    await t.test('acknowledged frame is not replayed after the app misses its commit', async () => {
      const a = await ctx.openClient('fault-a')
      let b = await ctx.openClient('fault-b')
      // Pair inline (the lifecycle pair() helper is not imported here to
      // keep this file self-contained for the capability gate).
      const { token } = await a.request('startPairing')
      const request = a.waitForEvent('joinRequest', 15_000, 'joinRequest event')
      await b.request('join', { token })
      const incoming = await request
      const joined = b.waitForEvent(
        value => value.kind === 'statusChanged' && value.status === 'member',
        15_000,
        'statusChanged(member)',
      )
      await a.request('accept', { requestId: incoming.requestId })
      await joined

      const bState = b.stateDir
      await b.stop()
      await a.request('send', { bodyHex: hex('crash-before-app-commit') })
      b = await ctx.openClient('fault-b-drops', {
        stateDir: bState,
        extraEnv: { TRUESEAL_E2E_DROP_BEFORE_COMMIT_TEXT: 'crash-before-app-commit' },
      })
      // The handler returns normally without the app committing: the
      // library acks (ADR-0026) and the relay deletes the row. Prove the
      // full cycle deterministically: the row LANDS (wait-queued) and then
      // DISAPPEARS (wait-empty) — the only way out of an inbox is a
      // DeliverAck (RELAY-1). A bare wait-empty can pass before the push
      // lands at all, racing the row's arrival past the client stop (the
      // dev/scenario-ts flake in run 38527940503).
      // The helper's default 10 s deadline is tight at the END of the
      // full matrix (dozens of driver processes have churned through);
      // the ack-and-delete path is honest, just loaded.
      const helperEnv = { ...process.env, DUPLICATE_INBOX_TIMEOUT_S: '30' }
      execFileSync(ctx.duplicateInbox, ['wait-queued', ctx.relay.database], { stdio: 'inherit', env: helperEnv })
      execFileSync(ctx.duplicateInbox, ['wait-empty', ctx.relay.database], { stdio: 'inherit', env: helperEnv })

      await b.stop()
      b = await ctx.openClient('fault-b-after', { stateDir: bState })
      await b.expectNoEvent(
        value => value.event === 'message'
          && Buffer.from(value.message.bodyHex, 'hex').toString('utf8') === 'crash-before-app-commit',
        8_000,
        'a redelivery of the acked-but-uncommitted message',
      )
    })
  },
}
