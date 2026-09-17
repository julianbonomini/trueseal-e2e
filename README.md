# trueseal-e2e

System-level end-to-end tests for the TrueSeal ecosystem.

This repository owns tests that cross repository, process, language, and network boundaries. Unit and component tests remain in their owning repositories. Hush apps remain example consumers; core protocol tests do not depend on UI automation.

## Current lane

The first lane starts a real `trueseal-relay` process and drives isolated TypeScript SDK client processes through:

- Pairing token generation, join request, and explicit admission.
- Bidirectional encrypted delivery.
- Recipient process restart with deferred inbox delivery.
- Duplicate relay delivery with one stable application Message ID.
- The acknowledged-before-application-commit crash window.
- Relay restart with sender outbox replay.
- Member removal.
- Destroy Group propagation.

Each run generates a fresh relay identity, SQLite inbox, and client state under a temporary directory. Missing dependencies or an unavailable relay fail the run; tests never silently skip.

## Workspace layout

Local runs expect sibling checkouts:

```text
true-seal/
  trueseal-e2e/
  trueseal-relay/
  trueseal-sync/
  trueseal-sync-ts/
```

Override paths with `TRUESEAL_RELAY_REPO` and `TRUESEAL_TS_REPO` when needed.

## Run

Requirements: Node.js 18+, Rust, Go, and npm. A small Go fixture copies opaque envelopes and observes inbox deletion in the relay's temporary SQLite database; it never inspects plaintext.

```bash
npm test
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

Future lanes will add direct Rust, Swift, and Kotlin interoperability plus thin platform packaging/lifecycle checks.
