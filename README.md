# trueseal-e2e

System-level end-to-end tests for the TrueSeal ecosystem.

This repository owns tests that cross repository, process, language, and network boundaries. Unit and component tests remain in their owning repositories. Hush apps remain example consumers; core protocol tests do not depend on UI automation.

## Test lanes

The fast core lifecycle lane starts a real `trueseal-relay` process and drives isolated TypeScript SDK client processes through:

- Pairing token generation, join request, and explicit admission.
- Bidirectional encrypted delivery.
- Recipient process restart with deferred inbox delivery.
- Duplicate relay delivery with one stable application Message ID.
- The acknowledged-before-application-commit crash window.
- Relay restart with sender outbox replay.
- Member removal.
- Destroy Group propagation.

Each run generates a fresh relay identity, SQLite inbox, and client state under a temporary directory. Missing dependencies or an unavailable relay fail the run; tests never silently skip.

Two interoperability lanes pair a TypeScript client with a purpose-built Rust or Swift client over the real relay. They exercise only public caller APIs and verify explicit admission, encrypted delivery in both directions, stable Message IDs, identity recovery after process restart, and member removal. The control protocol between the test runner and each client is test-only JSON over standard input/output; protocol traffic remains unchanged.

Kotlin is Android-only, so running it as a desktop command-line client would bypass the public API that applications actually use. Its public boundary is instead covered by the Android packaging lane described below. Core protocol behavior remains in the deterministic headless lanes rather than requiring an emulator or UI automation for every change.

## Workspace layout

Local runs expect sibling checkouts:

```text
true-seal/
  trueseal-e2e/
  trueseal-relay/
  trueseal-sync/
  trueseal-sync-swift/
  trueseal-sync-ts/
```

Override paths with `TRUESEAL_RELAY_REPO` and `TRUESEAL_TS_REPO` when needed.

## Run

Requirements: Node.js 18+, Rust, Go, and npm. A small Go fixture copies opaque envelopes and observes inbox deletion in the relay's temporary SQLite database; it never inspects plaintext.

```bash
npm test
npm run test:rust
npm run test:swift # macOS only
```

The command installs the TypeScript SDK from its lockfile using the public npm registry, builds the SDK and relay, runs the system tests, and cleans up every child process and temporary file.

For an already-prepared workspace:

```bash
TRUESEAL_E2E_SKIP_PREPARE=1 npm test
```

## Ownership

- `clients/`: headless adapters over public SDK APIs.
- `lib/`: process and relay orchestration.
- `test/`: user-visible scenarios and assertions.
- `scripts/run.mjs`: one-command local/CI entry point.

## CI and release gates

The Developer Preview release gate is defined in [ADR-0001](docs/adr/0001-developer-preview-release-gate.md): a hard block against Candidate Artifacts listed in a Release Manifest. The table below describes the current lanes until that gate is implemented.

| Lane | Where | What it proves | Required before |
| --- | --- | --- | --- |
| Core lifecycle | `trueseal-e2e` / Linux | Relay and protocol lifecycle, restart, replay, duplicate delivery, removal, and destruction | Any core, relay, or SDK release |
| Rust ↔ TypeScript | `trueseal-e2e` / Linux | Direct core and Node wrapper agree on public behavior | Core and TypeScript SDK releases |
| Swift ↔ TypeScript | `trueseal-e2e` / macOS | Released Apple binary, Swift wrapper, Node wrapper, and relay interoperate | Swift SDK and Apple app releases |
| macOS example app | `hush-clip-macos` / macOS | Swift package resolution, app wiring, local persistence, and lifecycle tests | macOS app releases |
| iOS example app | `hush-clip-ios` / macOS | Swift package resolution and simulator-target app wiring | iOS app releases |
| Android example app | `hush-clip-android` / Linux | Released Kotlin AAR resolves and the real app compiles against its public API | Kotlin SDK and Android app releases |

The headless jobs are required checks for this repository. Platform jobs stay in each Hush repository so their native build files, signing settings, and lifecycle tests evolve with the example app. Before cutting a release, the owner must verify the applicable rows above are green against the exact SDK artifacts being released. A release is not considered verified solely because unit tests pass in one repository.

Artifacts consumed by these lanes are the relay executable, the Rust core source, the built TypeScript native package, the released Swift XCFramework selected by `trueseal-sync-swift/Package.swift`, and the released Kotlin `lib-release.aar` selected by the Android workflow. Package versions are not treated as protocol compatibility evidence; explicit mixed-version cases belong in the protocol-versioning work.
