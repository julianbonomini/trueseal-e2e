import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The two run modes of the one command (e2e ADR-0001).
 *
 * - gate: builds the exact refs listed in pins.json, cloned fresh into an
 *   isolated temporary tree. Sibling checkouts, env overrides and any path
 *   dependency escaping the pinned tree FAIL the run (G8 / E2E-9).
 * - dev: builds whatever the sibling checkouts contain (main HEADs in CI).
 *   It gives feedback and never gates a release.
 */
export function parseMode(argv) {
  const index = argv.indexOf('--mode')
  const mode = index >= 0 ? argv[index + 1] : null
  if (mode !== 'gate' && mode !== 'dev') {
    throw new Error(
      'usage: pass --mode gate|dev explicitly — gate builds pins.json refs, dev builds sibling checkouts (non-gating)',
    )
  }
  return mode
}

const PINNED_REPOS = [
  'trueseal-relay',
  'trueseal-sync',
  'trueseal-sync-swift',
  'trueseal-sync-ts',
  'trueseal-sync-kotlin',
]
const FULL_SHA = /^[0-9a-f]{40}$/

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stderr}`)
  }
  return result.stdout.trim()
}

function loadPins() {
  const file = join(repo, 'pins.json')
  const { pins } = JSON.parse(readFileSync(file, 'utf8'))
  for (const name of PINNED_REPOS) {
    const sha = pins[name]
    if (typeof sha !== 'string' || !FULL_SHA.test(sha)) {
      throw new Error(
        `pins.json: "${name}" is not an exact 40-hex commit SHA (got ${JSON.stringify(sha)}) — gate mode refuses unpinned references (E2E-9)`,
      )
    }
  }
  return pins
}

/** The sibling-path env overrides dev mode honours and gate mode forbids. */
const SIBLING_ENV = [
  'TRUESEAL_RELAY_REPO',
  'TRUESEAL_TS_REPO',
  'TRUESEAL_SYNC_REPO',
  'TRUESEAL_SWIFT_REPO',
  'TRUESEAL_KOTLIN_REPO',
]

/**
 * Resolve the repo layout for a run. Returns:
 *   { mode, e2eRepo, relayRepo, tsRepo, rustClientDir, swiftClientDir, cleanup() }
 * In gate mode every path points inside a fresh temporary tree cloned at the
 * pinned SHAs; in dev mode paths point at the sibling checkouts (or the
 * TRUESEAL_*_REPO overrides).
 */
export function prepareWorkspace(mode) {
  if (mode === 'dev') {
    const workspace = resolve(repo, '..')
    console.log('E2E mode: DEV — building sibling checkouts (non-gating; the gate uses pins.json)')
    return {
      mode,
      e2eRepo: repo,
      relayRepo: resolve(process.env.TRUESEAL_RELAY_REPO ?? join(workspace, 'trueseal-relay')),
      tsRepo: resolve(process.env.TRUESEAL_TS_REPO ?? join(workspace, 'trueseal-sync-ts')),
      syncRepo: resolve(process.env.TRUESEAL_SYNC_REPO ?? join(workspace, 'trueseal-sync')),
      kotlinRepo: resolve(process.env.TRUESEAL_KOTLIN_REPO ?? join(workspace, 'trueseal-sync-kotlin')),
      rustClientDir: join(repo, 'clients', 'rust'),
      swiftClientDir: join(repo, 'clients', 'swift'),
      cleanup() {},
    }
  }

  for (const name of SIBLING_ENV) {
    if (process.env[name]) {
      throw new Error(`gate mode refuses the sibling-checkout override ${name} (E2E-9)`)
    }
  }

  const pins = loadPins()
  const tree = mkdtempSync(join(tmpdir(), 'trueseal-e2e-gate-'))
  const paths = {}
  for (const name of PINNED_REPOS) {
    const dir = join(tree, name)
    const sha = pins[name]
    git(['init', '-q', dir], tree)
    git(['remote', 'add', 'origin', `https://github.com/julianbonomini/${name}.git`], dir)
    git(['fetch', '-q', '--depth', '1', 'origin', sha], dir)
    git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir)
    const head = git(['rev-parse', 'HEAD'], dir)
    if (head !== sha) {
      throw new Error(`gate mode: ${name} checked out ${head}, expected pinned ${sha}`)
    }
    paths[name] = dir
  }
  // The harness itself joins the pinned tree as the sibling the client
  // manifests' relative paths expect (clients/*/..  ../../../<repo>).
  const e2eCopy = join(tree, 'trueseal-e2e')
  cpSync(repo, e2eCopy, {
    recursive: true,
    filter: source => !source.includes(`${sep()}.git`) && !source.includes('node_modules'),
  })

  assertPathDepsStayInside(tree, e2eCopy)
  console.log(`E2E mode: GATE — pinned tree at ${tree}`)
  for (const name of PINNED_REPOS) console.log(`  ${name} @ ${pins[name]}`)

  return {
    mode,
    e2eRepo: e2eCopy,
    relayRepo: paths['trueseal-relay'],
    tsRepo: paths['trueseal-sync-ts'],
    syncRepo: paths['trueseal-sync'],
    kotlinRepo: paths['trueseal-sync-kotlin'],
    rustClientDir: join(e2eCopy, 'clients', 'rust'),
    swiftClientDir: join(e2eCopy, 'clients', 'swift'),
    cleanup() {
      rmSync(tree, { recursive: true, force: true })
    },
  }
}

function sep() {
  return process.platform === 'win32' ? '\\' : '/'
}

/**
 * G8 guard: a path dependency in a client manifest must resolve INSIDE the
 * pinned tree — anything else means the build can see bytes the pins do not
 * cover. (The relative path deps between pinned checkouts are exact: every
 * side of them is at a pinned SHA. Artifact-level checksums arrive with the
 * Release Manifest in E2E-8.)
 */
function assertPathDepsStayInside(tree, e2eCopy) {
  const cargoToml = readFileSync(join(e2eCopy, 'clients', 'rust', 'Cargo.toml'), 'utf8')
  for (const match of cargoToml.matchAll(/path\s*=\s*"([^"]+)"/g)) {
    const target = resolve(join(e2eCopy, 'clients', 'rust'), match[1])
    if (!target.startsWith(tree + sep())) {
      throw new Error(`gate mode: clients/rust path dependency escapes the pinned tree: ${match[1]}`)
    }
    if (!existsSync(target)) {
      throw new Error(`gate mode: clients/rust path dependency does not exist in the pinned tree: ${match[1]}`)
    }
  }
  const packageSwift = readFileSync(join(e2eCopy, 'clients', 'swift', 'Package.swift'), 'utf8')
  for (const match of packageSwift.matchAll(/\.package\(path:\s*"([^"]+)"\)/g)) {
    const target = resolve(join(e2eCopy, 'clients', 'swift'), match[1])
    if (!target.startsWith(tree + sep())) {
      throw new Error(`gate mode: clients/swift path dependency escapes the pinned tree: ${match[1]}`)
    }
    if (!existsSync(target)) {
      throw new Error(`gate mode: clients/swift path dependency does not exist in the pinned tree: ${match[1]}`)
    }
  }
}

/**
 * Install + build the TypeScript SDK checkout at tsRepo.
 *
 * INTERIM (until the @trueseal/sync-* platform packages publish — npm org is
 * OPS-1, trueseal-sync-ts#14): `npm ci` cannot run because the lock cannot
 * contain the unpublished per-platform optional dependencies. We install
 * with --omit=optional (deterministic dependency set, no registry lookups
 * for the unpublished packages) and the loader falls back to the locally
 * built native binding from `npm run build`. trueseal-sync-ts#12 (D26)
 * switches the harness back to `npm ci` once the packages exist.
 */
export function buildTypeScriptSdk(tsRepo, run) {
  run('npm', ['install', '--no-audit', '--no-fund', '--omit=optional', '--registry=https://registry.npmjs.org'], tsRepo)
  run('npm', ['run', 'build'], tsRepo)
}

/** The relay binary builds from the (pinned or sibling) relay checkout. */
export function buildRelay(relayRepo, outBin, run) {
  run('go', ['build', '-o', outBin, './cmd/trueseal-relay'], relayRepo)
}

export function laneNotRunPolicy() {
  const file = join(repo, 'gates', 'not-run.json')
  return JSON.parse(readFileSync(file, 'utf8')).lanes
}
