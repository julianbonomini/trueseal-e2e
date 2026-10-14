import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class RelayProcess {
  constructor({ binary, stateDir, devMode = false, extraEnv = {} }) {
    this.binary = binary
    this.stateDir = stateDir
    this.devMode = devMode
    this.extraEnv = extraEnv
    this.keypair = join(stateDir, 'relay-key.hex')
    this.database = join(stateDir, 'inbox.db')
    this.output = ''
    mkdirSync(stateDir, { recursive: true })

    // RELAY-12 (trueseal-relay#32): keypair operations are subcommands —
    // `trueseal-relay genkey -keyout <path>`; the old `-genkey` flag form
    // fails loudly on current relays.
    const output = execFileSync(binary, ['genkey', '-keyout', this.keypair], { encoding: 'utf8' })
    const match = output.match(/relay public key \(share with clients\): ([0-9a-f]{64})/)
    if (!match) throw new Error(`could not parse relay public key from:\n${output}`)
    this.publicKey = match[1]
  }

  async start() {
    this.output = ''
    this.process = spawn(this.binary, ['-no-config'], {
      env: {
        ...process.env,
        TRUESEAL_RELAY_KEYPAIR_PATH: this.keypair,
        TRUESEAL_RELAY_STORE_TYPE: 'sqlite',
        TRUESEAL_RELAY_STORE_SQLITE_PATH: this.database,
        TRUESEAL_RELAY_LISTEN_RECEIVE: '127.0.0.1:7700',
        TRUESEAL_RELAY_LISTEN_PUSH: '127.0.0.1:7701',
        TRUESEAL_RELAY_LISTEN_HEALTH: '127.0.0.1:7702',
        TRUESEAL_RELAY_REAP_INTERVAL: '1s',
        // RELAY-9: dev mode is an explicit per-invocation choice (flag or
        // env only, never TOML). extraEnv carries short deadline/limit
        // knobs for the paths a check exercises (ADR-0012: short values
        // must be configurable for e2e).
        ...(this.devMode ? { TRUESEAL_RELAY_DEV: '1' } : {}),
        ...this.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.process.stdout.on('data', chunk => { this.output += chunk.toString() })
    this.process.stderr.on('data', chunk => { this.output += chunk.toString() })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) {
        throw new Error(`relay exited with code ${this.process.exitCode}\n${this.output}`)
      }
      try {
        const response = await fetch('http://127.0.0.1:7702/healthz')
        if (response.ok) return
      } catch {
        // Relay is still starting.
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    throw new Error(`relay did not become healthy\n${this.output}`)
  }

  async stop() {
    if (!this.process || this.process.exitCode !== null) return
    this.process.kill('SIGTERM')
    await Promise.race([
      new Promise(resolvePromise => this.process.once('exit', resolvePromise)),
      new Promise(resolvePromise => setTimeout(resolvePromise, 3_000)),
    ])
    if (this.process.exitCode === null) this.process.kill('SIGKILL')
  }
}
