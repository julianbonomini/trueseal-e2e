# TrueSeal E2E

The cross-repo system tests that decide whether a TrueSeal release may be published.

## Language

**Release Gate**:
The E2E run whose green result a release's publish step requires. It is a hard block with no manual override.
_Avoid_: release check, sign-off

**Candidate Artifact**:
The exact bytes a release workflow will publish (package, framework, AAR, image), staged but not yet in any registry.
_Avoid_: build, pre-release

**Release Manifest**:
The list of Candidate Artifacts, each with version and checksum, that a Release Gate run tests.
_Avoid_: lockfile, pin list

**Dev Mode**:
An E2E run against the latest code on each repo's main branch. It gives feedback and never gates a release.
_Avoid_: HEAD mode, nightly gate

**Scenario Suite**:
The full scenario matrix, run against one SDK on its own through the shared Scenario Driver.

**Scenario Driver**:
The harness side that runs scenarios against any SDK client through the test-only control protocol.

**Interop Smoke**:
A short pair, send-both-ways and remove check run for every pair of SDKs.
_Avoid_: interop lane

**Adversary Client**:
A test-only client that sends hostile frames as a non-member or as a hostile member.

**Hostile Relay**:
A test-only relay build that drops, duplicates, reorders, replays, injects or corrupts traffic. It is never shipped.
_Avoid_: evil relay, mock relay
