# trueseal-e2e

System-level end-to-end tests for the TrueSeal ecosystem.

This repository owns tests that cross repository, process, language, and network boundaries. Unit and component tests remain in their owning repositories. Hush apps remain example consumers; core protocol tests do not depend on UI automation.

## The two modes

The one command runs in exactly one of two modes, and the mode is always explicit (e2e ADR-0001):

- **Gate mode** (`--mode gate`) builds the exact commit SHAs listed in [`pins.json`](pins.json), cloned fresh from GitHub into an isolated temporary tree. It refuses sibling-checkout overrides, refuses any pin that is not a full 40-hex SHA, and refuses client `path` dependencies that escape the pinned tree (G8 / E2E-9). Nothing floats. The Release Conductor (E2E-8) will regenerate `pins.json` from each Release Manifest; until then it is updated by hand as sibling mains move.
- **Dev Mode** (`--mode dev`) builds whatever the sibling checkouts contain — in CI, main HEADs. It runs on e2e changes and nightly, is labeled non-gating, and never blocks a release.

In CI the `gate / *` jobs check out only this repository; sibling sources enter through the pins alone. The `dev / *` jobs check out siblings at main and are `continue-on-error` by design.

## Test lanes

**The Scenario Suite (E2E-1, G1).** One shared Scenario Driver runs the same scenario files against each public SDK, selected by lane, through the test-only JSON control protocol ([`docs/scenario-driver-protocol.md`](docs/scenario-driver-protocol.md), Protocol Version 1). Each lane starts a real `trueseal-relay` process and drives isolated SDK driver processes through:

- Pairing token generation, join request, and explicit admission.
- Bidirectional encrypted delivery.
- Recipient process restart with deferred inbox delivery.
- Duplicate relay delivery, deduplicated by the library's Replay Window (ADR-0031).
- Relay restart with sender outbox replay.
- Member removal.
- Destroy Group propagation.

The drivers: TypeScript (`clients/typescript.mjs`, this repo), Kotlin (`dev.trueseal.sync.driver.Main` from the pinned `trueseal-sync-kotlin` `jvm-test` module — the headless lane runs on Linux per e2e ADR-0001), and Swift (`clients/swift`, this repo). Drivers use only their SDK's public API; error codes are the canonical Shared Facts codes, and gate runs check `scenarios/protocol.json` against the pinned core's `docs/shared-facts.json` (G12 discipline). A driver that is missing or cannot start fails its lane — never a silent skip. Scenario-granular skips (the TS-only fault-injection scenario) and SDK conformance deviations are reported loudly and tracked (see `lib/sdk-drivers.mjs`).

Run one lane: `node scripts/run-scenarios.mjs <ts|kotlin|swift> --mode <gate|dev>`.

**The Interop Smoke** pairs the TypeScript driver with a foreign driver binary over the real relay — both sides speak Protocol v1, so the lane needs no per-adapter code. The full pairwise matrix arrives with E2E-4.

Each run generates a fresh relay identity, SQLite inbox, and client state under a temporary directory. Missing dependencies or an unavailable relay fail the run; tests never silently skip.

The Swift interop lane runs for real (E2E-1 rebuilt the Swift client as a Protocol v1 Scenario Driver). The Rust lane reports NOT RUN: per e2e ADR-0001 "SDK matrix" the Rust client is not part of the SDK matrix — it becomes the Adversary Client base, rebuilt in E2E-5 ([#9](https://github.com/julianbonomini/trueseal-e2e/issues/9)). The skip is explicit and tracked — see [`gates/not-run.json`](gates/not-run.json). A lane that builds while it is listed there fails as drift; a lane that fails without being listed fails the run.

Kotlin is Android-only, so running it as a desktop command-line client would bypass the public API that applications actually use. Its headless coverage arrives with E2E-1 through the test-only JVM build (KOTLIN-2); packaging is covered by the Android emulator smoke (E2E-6).

## Workspace layout

Dev Mode local runs expect sibling checkouts:

```text
true-seal/
  trueseal-e2e/
  trueseal-relay/
  trueseal-sync/
  trueseal-sync-swift/
  trueseal-sync-ts/
```

Override paths with `TRUESEAL_RELAY_REPO` and `TRUESEAL_TS_REPO` in Dev Mode only — gate mode refuses them.

## Run

Requirements: Node.js 18+, Rust, Go, and npm. A small Go fixture copies opaque envelopes and observes inbox deletion in the relay's temporary SQLite database; it never inspects plaintext.

```bash
npm test               # dev mode, system lane
npm run test:gate      # gate mode, system lane (pinned refs)
npm run test:rust      # dev mode, Rust ↔ TypeScript
npm run test:swift     # dev mode, Swift ↔ TypeScript (macOS only)
```

The command installs and builds the TypeScript SDK and builds the relay, runs the tests, and cleans up every child process and temporary file.

**TypeScript SDK install — interim until the npm org exists (OPS-1).** The SDK's per-platform `@trueseal/sync-*` packages are not yet published, and `npm ci` cannot describe unpublished optional dependencies. The harness installs with `npm install --no-audit --no-fund --omit=optional` (a deterministic dependency set with no registry lookups for the unpublished packages) and the SDK's loader falls back to the native binding built locally by `npm run build`. Once the platform packages publish, trueseal-sync-ts#12 switches the harness back to `npm ci`.

For an already-prepared workspace (Dev Mode):

```bash
TRUESEAL_E2E_SKIP_PREPARE=1 npm test
```

## Ownership

- `clients/`: headless adapters over public SDK APIs.
- `lib/`: process, relay and workspace/mode orchestration.
- `gates/`: gate policy data (the not-run list).
- `scenarios/`: the SDK-agnostic scenario files the Scenario Driver runs (`protocol.json` is the machine-readable protocol vocabulary, checked against the pinned core's Shared Facts).
- `test/`: the suite and interop entry points.
- `clients/`: the TypeScript and Swift Scenario Drivers (the Kotlin driver lives in trueseal-sync-kotlin's `jvm-test` module; Rust becomes the Adversary Client in E2E-5).
- `scripts/run.mjs`: one-command local/CI entry point (`--mode` required).
- `pins.json`: the exact refs gate mode builds.

## CI and release gates

The Developer Preview release gate is defined in [ADR-0001](docs/adr/0001-developer-preview-release-gate.md): a hard block against Candidate Artifacts listed in a Release Manifest, sequenced by the Release Conductor ([ADR-0002](docs/adr/0002-release-conductor-orchestration.md)). The mode split in this repository is the gate's entry point: the Conductor supplies pins (from the Release Manifest), runs gate mode, and a lane that reports "not run" without a tracked entry counts as a failure.

| Lane | Mode | Where | What it proves |
| --- | --- | --- | --- |
| Core lifecycle | gate + dev | Linux | Relay and protocol lifecycle, restart, replay, duplicate delivery, removal, and destruction over the real relay and the canonical TypeScript SDK |
| Rust ↔ TypeScript | gate + dev | Linux | **NOT RUN** until E2E-1 rebuilds the client (tracked in gates/not-run.json) |
| Swift ↔ TypeScript | gate + dev | macOS | **NOT RUN** until E2E-1 rebuilds the client (tracked in gates/not-run.json) |

Package versions are not treated as protocol compatibility evidence; explicit mixed-version cases belong in the protocol-versioning scenarios (E2E-2).
