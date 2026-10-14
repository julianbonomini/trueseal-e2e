// E2E-7 / gate G7 (relay ADR-0012 "Release gate", trueseal-roadmap#26):
// boot the real pinned relay binary over real TCP, drive the receive, push,
// connection-limit, deadline and shutdown paths in BOTH logging modes, then
// assert no client address appears in the captured log output or the raw
// inbox.db bytes, and no client metadata appears in normal-mode logs.
//
// The relay's unit-level privacy tests run over net.Pipe, where IP
// assertions are vacuous — this check is the real-TCP evidence behind the
// public wording "The relay never logs, stores or uses your IP address".
// The RemoteAddr source guard (trueseal-relay remoteaddr_guard_test.go)
// stays the relay repo's own CI tripwire; this check verifies behavior.

import { deepStrictEqual, ok } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Socket } from 'node:net'
import { test } from 'node:test'

import { ClientProcess } from '../lib/client-process.mjs'
import { RelayProcess } from '../lib/relay-process.mjs'
import {
  assertNoFindings,
  collectAddressFindings,
  collectMetadataFindings,
  collectStoreFindings,
} from '../lib/privacy-assertions.mjs'

const relayBinary = resolve(process.env.TRUESEAL_RELAY_BIN)
const duplicateInboxBinary = resolve(process.env.TRUESEAL_DUPLICATE_INBOX_BIN)
const mode = process.env.TRUESEAL_E2E_MODE ?? 'unknown'
const evidenceDir = process.env.TRUESEAL_E2E_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'trueseal-g7-evidence-'))
const pins = JSON.parse(process.env.TRUESEAL_E2E_PINS ?? '{}')

// The relay's own listeners (its startup lifecycle line names its own bind
// addresses — ADR-0012 allows config/lifecycle logs). Anything else that
// looks like an address is a client leak: over loopback a leak shows up as
// 127.0.0.1:<ephemeral port>, which this allowlist rejects.
const BIND_ADDRS = ['127.0.0.1:7700', '127.0.0.1:7701', '127.0.0.1:7702']
const DEV_BANNER = '*** DEV MODE ENABLED'

const captured = { normal: null, dev: null }

async function pair(host, joiner) {
  const token = await host.request('pairingToken')
  const request = host.waitForEvent('memberRequest')
  await joiner.request('joinGroup', { token })
  const incoming = await request
  const hostJoined = host.waitForEvent('memberJoined')
  const joinerSide = joiner.waitForEvent('memberJoined')
  await host.request('acceptPairingRequest', { requestToken: incoming.requestToken })
  await Promise.all([hostJoined, joinerSide])
}

function encoded(text) {
  return Buffer.from(text).toString('base64')
}

/** A raw connection that completes the version exchange then goes silent:
 * the handshake deadline (set short for this run) must close it. */
function deadlinePath() {
  return new Promise((resolvePromise, reject) => {
    const socket = new Socket()
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('deadline path: the relay did not close a silent post-prefix connection within 3s'))
    }, 3_000)
    socket.connect(7700, '127.0.0.1', () => {
      // Transport Version prefix: "TSP" || u16 BE 1 (sync ADR-0022 / RELAY-5).
      socket.write(Buffer.from([0x54, 0x53, 0x50, 0x00, 0x01]))
    })
    socket.once('data', byte => {
      deepStrictEqual(byte[0], 0x01, 'expected the 0x01 version-accept byte')
      // Now stay silent. No further handlers: 'close' resolves.
    })
    socket.once('close', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    socket.once('error', () => {}) // a reset on close is fine; 'close' follows
  })
}

async function runMode(devMode) {
  const label = devMode ? 'dev' : 'normal'
  const root = mkdtempSync(join(tmpdir(), `trueseal-g7-${label}-`))
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const markers = [`g7-marker-${label}-online-${runId}`, `g7-marker-${label}-resident-${runId}`]
  const relay = new RelayProcess({
    binary: relayBinary,
    stateDir: join(root, 'relay'),
    devMode,
    extraEnv: {
      // Short so the deadline path fires inside the test (ADR-0012: short
      // values must be configurable for e2e) and a per-device cap of 1 so
      // the connection-limit path is a deterministic refusal.
      TRUESEAL_RELAY_HANDSHAKE_DEADLINE: '500ms',
      TRUESEAL_RELAY_MAX_RECEIVE_SESSIONS_PER_DEVICE: '1',
    },
  })
  const clients = []
  const report = {
    gate: 'G7',
    issue: 'trueseal-e2e#11',
    mode: label,
    harnessMode: mode,
    pins,
    startedAt: new Date().toISOString(),
    pathsExercised: [],
    assertions: [],
  }
  const record = (name, fn) => {
    fn()
    report.assertions.push({ name, result: 'pass' })
  }

  try {
    await relay.start()

    const health = await (await fetch('http://127.0.0.1:7702/healthz')).json()
    record(`healthz reports dev_mode=${devMode}`, () => deepStrictEqual(health.dev_mode, devMode))
    report.transportVersion = health.transport_version

    // receive + push paths: pair two devices, deliver and ack one message.
    const a = new ClientProcess({ stateDir: join(root, 'a'), relayPublicKey: relay.publicKey })
    clients.push(a)
    await a.start()
    const b = new ClientProcess({ stateDir: join(root, 'b'), relayPublicKey: relay.publicKey })
    clients.push(b)
    await b.start()
    await pair(a, b)
    const delivered = b.waitForEvent('message', event => event.text === markers[0])
    await a.request('send', { data: encoded(markers[0]) })
    await delivered
    report.pathsExercised.push('receive', 'push', 'deliver-ack')

    // A blob RESIDENT in the store at copy time: B offline, one message
    // queued in its inbox (recipient key + sealed envelope on disk).
    await b.stop()
    await a.request('send', { data: encoded(markers[1]) })
    execFileSync(duplicateInboxBinary, ['wait-queued', relay.database], { stdio: 'inherit' })
    report.assertions.push({ name: 'a blob is resident in inbox.db at copy time', result: 'pass' })

    // connection-limit path: two concurrent Receive Sessions for ONE device
    // key against a per-device cap of 1 — one must be refused (counted
    // silently in normal mode, totalled in dev mode). A is stopped first so
    // its store copy is a clean second identity instance.
    await a.stop()
    const aCopy = join(root, 'a-copy')
    cpSync(join(root, 'a'), aCopy, { recursive: true })
    const a1 = new ClientProcess({ stateDir: join(root, 'a'), relayPublicKey: relay.publicKey })
    const a2 = new ClientProcess({ stateDir: aCopy, relayPublicKey: relay.publicKey })
    clients.push(a1, a2)
    await a1.start()
    await a2.start()
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
    report.pathsExercised.push('connection-limit')

    // deadline path: version exchange then silence; the short handshake
    // deadline closes the connection.
    await deadlinePath()
    report.pathsExercised.push('deadline')

    await a1.stop()
    await a2.stop()

    // shutdown path: SIGTERM — graceful-shutdown lifecycle lines.
    await relay.stop()
    report.pathsExercised.push('shutdown')

    const logs = relay.output
    const dbBytes = readFileSync(relay.database)
    report.logBytes = Buffer.byteLength(logs)
    report.logLines = logs.split('\n').filter(line => line.length > 0).length
    report.dbBytes = dbBytes.length
    captured[label] = { logs, dbBytes, markers, ids: [a.ready.localNodeId, b.ready.localNodeId] }

    // Mode sanity: the dev banner is present in dev mode and absent in
    // normal mode (proves the two runs really ran in different modes).
    record(`dev-mode banner is ${devMode ? 'present' : 'absent'}`, () =>
      deepStrictEqual(logs.includes(DEV_BANNER), devMode))

    // The exercise proof for the connection-limit path: dev mode totals the
    // per-device-cap refusal; normal mode stays silent about it.
    record(`per-device-cap refusal ${devMode ? 'is totalled in dev logs' : 'is silent in normal logs'}`, () =>
      deepStrictEqual(/per-device cap reached/.test(logs), devMode))

    // G7 core: no client address in ANY mode. Own bind addresses allowed.
    record('no client address in logs', () =>
      assertNoFindings('logs', collectAddressFindings(logs, { allowedBindAddrs: BIND_ADDRS })))

    // G7 core: no client address or plaintext client metadata in the store.
    record('no client address or plaintext metadata in inbox.db', () =>
      assertNoFindings('inbox.db', collectStoreFindings(dbBytes, { markers, ids: [a.ready.localNodeId, b.ready.localNodeId] })))

    if (!devMode) {
      // Normal mode additionally: no client metadata at all.
      record('no client metadata in normal-mode logs', () =>
        assertNoFindings('normal-mode logs', collectMetadataFindings(logs, { knownIds: [a.ready.localNodeId, b.ready.localNodeId] })))
    }

    // Payload bytes are never logged in ANY mode (ADR-0012).
    record('payload markers never appear in logs', () => {
      for (const marker of markers) ok(!logs.includes(marker), `log contains payload marker ${marker}`)
    })
  } finally {
    await Promise.allSettled(clients.map(value => value.stop()))
    await relay.stop()
    rmSync(root, { recursive: true, force: true })
  }

  report.finishedAt = new Date().toISOString()
  mkdirSync(evidenceDir, { recursive: true })
  const file = join(evidenceDir, `g7-privacy-${label}.json`)
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`G7 evidence (${label}): ${file}`)
}

test('G7: relay log and store privacy in normal and dev mode', { timeout: 180_000 }, async t => {
  await t.test('normal mode', () => runMode(false))
  await t.test('dev mode', () => runMode(true))
})

test('G7 negative controls: the assertions fail on planted data', async t => {
  await t.test('planted client address in log text is caught', () => {
    const findings = collectAddressFindings('session 127.0.0.1:51023 closed', { allowedBindAddrs: BIND_ADDRS })
    ok(findings.length > 0, 'expected an IPv4:ephemeral-port finding')
    try {
      assertNoFindings('planted', findings)
      throw new Error('assertNoFindings did not throw')
    } catch (error) {
      ok(/G7 privacy check failed/.test(error.message))
    }
  })

  await t.test('planted client metadata in normal-mode log text is caught', () => {
    const findings = collectMetadataFindings('recv: XX handshake complete key=ab12cd34', { knownIds: [] })
    ok(findings.length > 0, 'expected a key= metadata finding')
  })

  await t.test('planted address appended to the REAL captured output is caught', t => {
    if (!captured.normal) return t.skip('normal-mode run did not produce captured output')
    const findings = collectAddressFindings(`${captured.normal.logs}\ndeleted from 10.0.0.7:443\n`, {
      allowedBindAddrs: BIND_ADDRS,
    })
    ok(findings.length > 0, 'expected the planted 10.0.0.7:443 to be flagged')
  })

  await t.test('planted marker appended to the REAL store bytes is caught', t => {
    if (!captured.normal) return t.skip('normal-mode run did not produce store bytes')
    const planted = Buffer.concat([captured.normal.dbBytes, Buffer.from(captured.normal.markers[0], 'latin1')])
    const findings = collectStoreFindings(planted, { markers: captured.normal.markers })
    ok(findings.length > 0, 'expected the planted plaintext marker to be flagged')
  })

  await t.test('planted ASCII IPv4 in store bytes is caught', () => {
    const findings = collectStoreFindings(Buffer.from('...10.1.2.3...', 'latin1'), { markers: [] })
    ok(findings.length > 0, 'expected an ASCII IPv4 finding in store bytes')
  })
})
