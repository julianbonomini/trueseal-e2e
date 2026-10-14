# The Scenario Driver control protocol — Version 1

The test-only protocol every SDK Scenario Driver speaks, so one Scenario
Driver (`lib/driver-process.mjs`) runs the same scenario file against Swift,
Kotlin (JVM test build) and TypeScript (e2e ADR-0001 "SDK matrix"; issue #5).
It maps 1:1 onto the canonical `TrueSeal` API shape (sync ADR-0028) and adds
nothing an app developer could not do through the public API. **Drivers use
only the SDK's public API — no core or FFI imports.**

The canonical, machine-readable copy of the vocabularies is
[`scenarios/protocol.json`](../scenarios/protocol.json). Gate runs check its
error codes against the pinned core's `docs/shared-facts.json`; drift fails
the run (G12 discipline).

## Versioning

This document is **Protocol Version 1**. Version 1 is exactly the contract
the Kotlin reference driver shipped (KOTLIN-2's "v0 draft", promoted); there
is deliberately no per-line version marker because the reference driver
predates a handshake, and the Scenario Driver validates a driver at startup
by issuing `info` (a session-less command every driver must answer). If the
contract ever changes, the version becomes **2**, a `hello` handshake is
added, and all three drivers are updated in the same release — a driver that
cannot answer `info` or speaks unknown commands fails its lane loudly, never
skips.

## Transport

One JSON object per line over the driver subprocess's stdin/stdout. Requests
carry an integer `id`; responses echo it. Asynchronous traffic (messages,
events, delivery issues) is pushed as **id-less notifications** — a line
with an `event` key and no `id`/`ok`. Stderr is for driver diagnostics only
and carries no protocol meaning.

**Request:** `{"id": 1, "command": "<name>", ...args}`
**Response:** `{"id": 1, "ok": true, "result": {...}}` or
`{"id": 1, "ok": false, "error": {"code": "<code>", "message": "..."}}`

## Typed error mapping

`error.code` is one of the fourteen canonical `TrueSealError` codes from the
core's `docs/shared-facts.json` (G12 parity), or a driver-local code:

- `malformed` — the line was not a well-formed request (never an SDK error).
- `driver` — a driver-side failure (no open session, unknown command, an
  unexpected SDK error shape). A command a driver does not implement MUST
  fail with `driver`, never be ignored.

## Commands

| Command | Args | Result |
|---|---|---|
| `open` | `storagePath`, `relay`, `namespace?`, `maxPayloadBytes?` | `{me}` |
| `close` | — | `{}` |
| `info` | — (no session needed) | `{sdkVersion, transportVersion, endToEndVersion, maxPayloadBytes, maxGroupSize}` |
| `send` | `bodyHex` (lowercase hex) | `{messageId}` (`tsm1_…`) |
| `startPairing` | — | `{token}` |
| `accept` | `requestId` | `{}` |
| `cancelPairing` | — | `{}` |
| `join` | `token` | `{}` |
| `cancelJoin` | — | `{}` |
| `remove` | `memberId` | `{}` |
| `leave` / `destroyGroup` | — | `{}` |
| `status` | — | `{status}` — a canonical GroupStatus |
| `me` | — | `{me}` |
| `members` | — | `{members: [member]}` (excludes self) |
| `connection` | — | `{connection}` |
| `receive` | — | registers the one-shot message handler; messages arrive as notifications |
| `listenEvents` | — | events arrive as notifications |
| `listenIssues` | — | delivery issues arrive as notifications |

`relay` is the Relay Address string,
`trueseal://<relay public key hex>@host:7700?push=7701` (shared-facts
`relayAddress.format`; harness ports are always explicit).

Registration semantics are the SDK's own (ADR-0026/0028): receiving starts
when `receive` registers the handler; events raised before `listenEvents`
are buffered and delivered on registration; `receive` is one-shot per
`open`. A second `open` without `close` fails `driver`.

## Notifications

```json
{"event": "message", "message": {"id": "tsm1_…", "from": {"id": "…", "name": "…"}, "bodyHex": "…"}}
{"event": "event", "kind": "statusChanged", "status": "member", "reason": "joined"}
{"event": "event", "kind": "membersChanged", "members": [{"id": "…", "name": "…"}]}
{"event": "event", "kind": "joinRequest", "requestId": "…", "name": "…"}
{"event": "event", "kind": "connectionChanged", "connection": {"state": "connected"}}
{"event": "event", "kind": "connectionChanged", "connection": {"state": "relayVersionUnsupported", "min": 1, "max": 1}}
{"event": "event", "kind": "admissionDropped", "name": "…", "reason": "groupFull"}
{"event": "issue", "kind": "unreadable", "reason": "malformed|senderOutdated|expired|droppedWhileHeld"}
{"event": "issue", "kind": "unauthorized"}
{"event": "issue", "kind": "heldForUpgrade", "version": 2}
{"event": "issue", "kind": "handlerGaveUp", "messageId": "tsm1_…", "error": "…"}
{"event": "issue", "kind": "sendFailed", "messageId": "tsm1_…", "reason": "tooLarge|malformed|expired"}
```

Every vocabulary value (`status`, `reason`, `state`, `kind`, `code`) is the
canonical shared-facts spelling, character-for-character.

## The drivers

| SDK | Driver | Home |
|---|---|---|
| TypeScript | `clients/typescript.mjs` (Node, public `@trueseal/sync` API) | this repo |
| Kotlin (JVM test build) | `dev.trueseal.sync.driver.Main` | trueseal-sync-kotlin `jvm-test` (KOTLIN-2; consumed as-is) |
| Swift | `clients/swift` (public `TruesealSync` API) | this repo |

The Rust client is **not** an SDK driver — it becomes the Adversary Client
base in E2E-5 (#9), per ADR-0001 "SDK matrix".
