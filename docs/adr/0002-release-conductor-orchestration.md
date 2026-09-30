# Coordinated releases through a Release Conductor

Status: accepted (decided 2026-09-30 in [trueseal-roadmap#22](https://github.com/julianbonomini/trueseal-roadmap/issues/22)). It builds on ADR-0001 (release gate) and trueseal-sync ADR-0030 (distribution and lockstep versions).

A TrueSeal release across repos is cut by one command: the **Release Conductor**, a `workflow_dispatch` workflow in this repo.

**Flow.**
1. The maintainer (or the agent acting for them) starts the conductor with the target versions. Only the maintainer's account can start it, and one run at a time is allowed.
2. The conductor asks each repo that has a candidate to build it from a commit, not a tag. Files are staged in a draft GitHub Release of the owning repo; the relay image is pushed by digest only; Maven bundles are signed at build time and uploaded at promotion. The release commit records versions and checksums (for example Swift's `binaryTarget` checksum).
3. It assembles the **Release Manifest**. A manifest may mix candidates with already-published pins (for example noise 0.2.0 published, relay 0.2.1 candidate, TrueSeal 0.6.0 candidates), so the gate tests exactly the combination users will install. Only candidates are promoted.
4. Pre-promotion checks: every package manifest carries the target version; every cross-repo input is pinned (Rust git deps pin a full commit SHA with `rev =`, commented with the tag, so noise and sync candidates can be tested together before any tag exists); every package has a changelog entry; license metadata is Apache-2.0.
5. The Release Gate runs against the manifest (ADR-0001).
6. On green, promotion is automatic, with no approval step: the dispatch is the intent to release. Order: noise tag → relay image → core tag → the three SDKs → a docs PR. Tags are pushed only here.
7. The **Release Evidence** bundle (Release Manifest, per-lane gate results including test vectors, pre-promotion check output) is attached to every GitHub Release in the set.
8. The conductor opens a trueseal-docs PR that updates the generated Compatibility Table (built from all past Release Manifests) and pinned versions such as the self-hosting relay image tag. It auto-merges when the docs checks pass.

**Failures.**
- A red gate burns nothing: no tag exists, the drafts are deleted, and the same version can be retried.
- A failed promotion is retried forward with the same bytes. Promotion is idempotent per channel, and a re-run publishes only missing channels. The release is complete only when every channel is live; docs update only then.
- If a channel can't accept those exact bytes, the version is burned on every channel and the next patch is cut everywhere. No channel ever ships a version the others skip.

**Credentials.** Registry secrets stay in their owning repos (the Maven signing key only on trueseal-sync-kotlin, npm through OIDC). The conductor holds only a narrowly scoped GitHub App credential that can dispatch workflows and read artifacts in the TrueSeal repos.

**Release notes.** One TrueSeal Release changelog in trueseal-sync with a section per SDK, linked from each GitHub Release in the lockstep group. noise and the relay keep their own changelogs.

**Manual steps.** Done once, before 0.6.0, from a checklist: those in ADR-0030 (npm org, Central Portal, DNS TXT, GPG key), the first publish of each package, and creating the conductor's GitHub App. Every later release is fully automated.

**Relay deploys.** A release never touches infrastructure. The relay's tag-triggered VPS deploy and its `:latest` push are removed from the release; a separate, manually started deploy workflow takes an exact published version.

**Visibility.** This repo becomes public before the first gated release, after a secrets check: public gate runs make Release Evidence verifiable, and macOS runner minutes are free for public repos.

## Considered alternatives

- **Drive releases from trueseal-sync core.** Rejected. The gate and manifest reader live here, and core would still need cross-repo dispatch.
- **No conductor; each repo releases alone and calls the gate.** Rejected. The Release Manifest would be assembled by hand, the manual checklist ADR-0001 rejected.
- **Separate release runs per train (noise, relay, lockstep).** Rejected. They would not test the combination users install.
- **Burn the version on any promotion failure.** Rejected. A transient registry outage shouldn't cost a version.
- **An environment approval between gate and promotion.** Rejected. The gate has no override, so a second click adds friction without safety.
- **Keep evidence only as workflow artifacts.** Rejected. They expire.
- **Per-repo changelogs for the lockstep group.** Rejected. It weakens "same version, same core".
- **Keep the automatic VPS deploy.** Rejected. Deploying infrastructure needs explicit approval, and a hosted public relay is out of scope.
- **Keep this repo private.** Rejected. It bills macOS minutes on every gated and nightly run, and hides the evidence.

## Consequences

- None of this exists today: e2e builds each repo's main from source, Swift and Kotlin force-move tags, Kotlin pulls `releases/latest`, trueseal-sync-ts has no CI, and there are no sync test vectors or Compatibility Table generator. Each repo's release workflow is rebuilt as "build candidate on dispatch" plus "promote on dispatch".
- Moving Kotlin to Maven Central breaks hush-clip-android's CI, which downloads the AAR from GitHub Releases. The Hush apps are out of scope.
