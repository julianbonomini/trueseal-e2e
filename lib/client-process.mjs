import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export class ClientProcess {
  constructor({ stateDir, relayPublicKey, clientEnv = {}, command = process.execPath, args }) {
    this.stateDir = stateDir
    this.relayPublicKey = relayPublicKey
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.waiters = []
    this.stderr = ''
    this.clientEnv = clientEnv
    this.command = command
    this.args = args ?? [join(repo, 'clients', 'typescript.mjs')]
  }

  async start() {
    mkdirSync(this.stateDir, { recursive: true })
    this.process = spawn(this.command, [
      ...this.args,
      '--relay-host', '127.0.0.1',
      '--relay-pub', this.relayPublicKey,
      '--state-dir', this.stateDir,
    ], {
      cwd: repo,
      env: { ...process.env, ...this.clientEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stderr.on('data', chunk => { this.stderr += chunk.toString() })
    this.process.once('exit', code => {
      const error = new Error(`client exited with code ${code}\n${this.stderr}`)
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.waiters = []
    })

    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity })
    lines.on('line', line => this.#handleLine(line))
    this.ready = await this.waitForEvent('ready')
    return this
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.stderr += `non-JSON stdout: ${line}\n`
      return
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
      return
    }

    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i]
      if (waiter.event === message.event && waiter.predicate(message)) {
        this.waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
    }
    this.events.push(message)
  }

  request(command, payload = {}, timeoutMs = 15_000) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out waiting for ${command}\n${this.stderr}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolvePromise(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.process.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`)
    })
  }

  waitForEvent(event, predicate = () => true, timeoutMs = 15_000) {
    const buffered = this.events.findIndex(value => value.event === event && predicate(value))
    if (buffered >= 0) return Promise.resolve(this.events.splice(buffered, 1)[0])

    return new Promise((resolvePromise, reject) => {
      const waiter = { event, predicate, resolve: resolvePromise, reject }
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(value => value !== waiter)
        reject(new Error(`timed out waiting for event ${event}\n${this.stderr}`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async expectNoEvent(event, predicate = () => true, timeoutMs = 1_000) {
    try {
      const value = await this.waitForEvent(event, predicate, timeoutMs)
      throw new Error(`unexpected event ${event}: ${JSON.stringify(value)}`)
    } catch (error) {
      if (error.message.startsWith(`timed out waiting for event ${event}`)) return
      throw error
    }
  }

  async stop() {
    if (!this.process || this.process.exitCode !== null) return
    this.process.kill('SIGTERM')
    await Promise.race([
      new Promise(resolvePromise => this.process.once('exit', resolvePromise)),
      new Promise(resolvePromise => setTimeout(resolvePromise, 2_000)),
    ])
    if (this.process.exitCode === null) this.process.kill('SIGKILL')
  }
}
