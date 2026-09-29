# Developer Preview release gate

Status: accepted (decided 2026-09-29 in [trueseal-roadmap#15](https://github.com/julianbonomini/trueseal-roadmap/issues/15)). It builds on trueseal-sync ADR-0022 (protocol versions), ADR-0026 (delivery contract), ADR-0028 (SDK API shape), ADR-0029 (Destroy Group), ADR-0030 (distribution and lockstep versions) and trueseal-relay ADR-0012 (self-hosted baseline).

A Developer Preview release can't be published until the cross-repo E2E suite passes against the exact artifacts that will be published.

**Scenario matrix.** Every scenario below blocks every gated release. None of them run only nightly or advisory.
- AGENTS.md end-to-end list: pairing and explicit admission, including reject, cancel, bad token and restart mid-pairing; send and receive; offline sender outbox replay, including a sender process restart; offline recipient inbox; duplicates and idempotency; relay and client restart; membership addition and removal, including silence after removal; concurrent membership updates; Destroy Group; TTL expiry boundaries; version compatibility; and adversarial frames.
- Protocol versions (ADR-0022): an unsupported Transport Version (`RelayVersionUnsupported`); newer, older and malformed End-to-End Versions; and the outbox upgrade transition (`UndeliverableAfterUpgrade`). The sync JSON test vectors are also a gate, checked in Rust, in relay Go tests, and in each SDK through its bindings.
- Relay baseline (relay ADR-0012): the idle-timeout close after 75 s, with the 25 s heartbeat keeping a session alive; `inbox full` and `rate limited` refusals with retry and recovery; the Receive Session cap per Device key; graceful shutdown with no message loss; and a normal-mode log check asserting that no client metadata appears.
- Destroy Group (ADR-0029): Destroy from each SDK, with every device ending `notJoined(destroyed)` with a fresh identity; nothing addressed to old keys afterwards; an offline recipient that wipes after it reconnects; re-pairing where a stolen device isn't admitted without acceptance; and a device offline past the TTL that misses the Destroy.

Slow scenarios stay in the gate. They use short relay settings (seconds-long TTL, short deadlines) through the normal operator configuration, not test-only code paths in the shipped relay.

**SDK matrix.**
- **Scenario Suite per SDK.** One shared Scenario Driver runs the whole matrix against each public SDK (Swift, Kotlin, TS) on its own, over the test-only JSON control protocol. This is possible because the SDKs share one API shape (ADR-0028).
- **Interop Smoke for every SDK pair,** including same-SDK pairs: pair, send both ways, remove.
- The direct Rust client isn't part of the SDK matrix, because Rust isn't a public SDK for the preview. Its code becomes the base of the Adversary Client.

**Kotlin.**
- Headless lanes run a test-only JVM build of the same Kotlin SDK sources on Linux, with the Android storage helper left out. That build is never published, and JVM stays an unsupported target for the preview.
- An Android emulator smoke test of the candidate AAR, in this repo, proves the Android packaging: install, pair, send once.
- The Hush apps are not part of the gate.

**Adversarial harness.**
- **Adversary Client.** A Rust client built on pinned core crates. It sends malformed, replayed, unauthorized, oversized and wrong-version frames, both as a non-member and as a hostile member.
- **Hostile Relay.** The real relay with injection hooks: drop, duplicate, reorder, replay, inject a Manifest or Sync, and corrupt. The hooks sit behind a Go build tag, so a release binary can't contain them.
- Every SDK must reject hostile input with the typed error or delivery issue from ADR-0026, and must never ack or apply it.

**Candidate artifacts, not HEAD.**
- Each gated release workflow builds the bytes it will publish (npm tarballs, the XCFramework, the AAR, the relay image and native libraries) as staged **Candidate Artifacts**.
- E2E runs against a **Release Manifest** listing each candidate's version and checksum. After a green run, those same bytes are promoted to the registries, followed by a quick check that installing from the registry works.
- **Dev Mode** builds the latest code on each repo's main branch. It runs on e2e changes and nightly, and never gates a release.
- One command runs every lane in either mode. A lane the host can't run, such as Swift off macOS, reports "not run", and the gate counts that as a failure. Nothing skips silently.

**Enforcement.**
- The gate is a hard block for the lockstep TrueSeal Release (trueseal-sync and the three SDKs), for trueseal-relay and for trueseal-noise. Each publish job depends on a green gate run against its Release Manifest, and there's no manual override.
- A bad release is fixed with a new patch version (ADR-0030).
- Docs releases aren't gated.
- Other repos' PRs don't run E2E.
- How the repos' release workflows are sequenced together is decided separately, in trueseal-roadmap's coordinated release orchestration ticket.

## Considered alternatives

- **A fast gate tier plus nightly-only slow scenarios.** Rejected. The slow cases (TTL, idle timeout, concurrent membership) are where confirmed defects lived, and short operator settings make them fast enough.
- **Every SDK pair running every scenario.** Rejected. It grows quadratically, and API parity makes per-SDK suites plus pairwise smoke tests enough.
- **Android emulator for every Kotlin scenario.** Rejected. It's slow and non-deterministic in CI. The emulator is kept only for the packaging smoke test.
- **Publishing a supported JVM Kotlin target.** Rejected for the preview. It's a product expansion that the gate doesn't need.
- **Only a hostile client, or only per-repo fuzzing.** Rejected. Relay-injected manifests were a confirmed defect, so the gate needs a hostile relay.
- **Testing source at the release tags, or publishing first and testing after.** Rejected. Tags are immutable, so publishing first burns versions on red runs, and testing source doesn't test what users install.
- **A required check the maintainer can override, or a manual checklist.** Rejected. The previous README table was a manual policy that nothing enforced.

## Consequences

- The harness gains a Scenario Driver, a JVM Kotlin client, an Adversary Client, a Hostile Relay build and an AAR emulator smoke test, and it reads Release Manifests.
- The Rust interop lane becomes the Adversary Client's base.
- Each gated repo's release workflow splits into build candidates, then the gate, then promotion.
- The relay must accept short TTL and deadline settings through its configuration.
- The docs drop the claim that Kotlin supports plain JVM.
