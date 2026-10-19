import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Socket } from 'node:net'

export class RelayProcess {
  constructor({ binary, stateDir, devMode = false, extraEnv = {}, hostile = false }) {
    this.binary = binary
    this.stateDir = stateDir
    this.devMode = devMode
    this.extraEnv = extraEnv
    this.hostile = hostile
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
    this.process = spawn(
      this.binary,
      // RELAY-14: the hostile build's injection hooks live behind a
      // loopback-only JSON control listener (never in a release binary).
      ['-no-config', ...(this.hostile ? ['-hostile-control', '127.0.0.1:7703'] : [])],
      {
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
      },
    )
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

  /**
   * Restarts the relay with different operator config (ADR-0001: slow
   * scenarios use short TTL/deadline/limit settings through NORMAL
   * operator configuration). The keypair and store persist in stateDir,
   * so the Relay Address is unchanged and clients reconnect.
   */
  async reconfigure(extraEnv = {}) {
    await this.stop()
    this.extraEnv = extraEnv
    await this.start()
  }

  /**
   * One Hostile Relay control command (RELAY-14): newline-delimited JSON
   * to the loopback listener — `{"cmd":"set","device":"*","drop":true}`
   * and friends. Fails loudly on a relay error or a missing listener.
   */
  async hostileCommand(command) {
    if (!this.hostile) throw new Error('hostileCommand on a non-hostile relay')
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = new Socket()
      let buffer = ''
      const timeout = setTimeout(() => {
        socket.destroy()
        rejectPromise(new Error('hostile control listener timed out'))
      }, 5_000)
      socket.connect(7703, '127.0.0.1', () => {
        socket.write(JSON.stringify(command) + '\n')
      })
      socket.on('data', chunk => {
        buffer += chunk.toString()
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        clearTimeout(timeout)
        socket.destroy()
        let response
        try {
          response = JSON.parse(buffer.slice(0, newline))
        } catch (error) {
          rejectPromise(new Error(`hostile control returned non-JSON: ${buffer}`))
          return
        }
        if (response.ok) resolvePromise(response)
        else rejectPromise(new Error(`hostile rule refused: ${response.error}`))
      })
      socket.on('error', error => {
        clearTimeout(timeout)
        rejectPromise(new Error(`hostile control listener unreachable: ${error.message}`))
      })
    })
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
