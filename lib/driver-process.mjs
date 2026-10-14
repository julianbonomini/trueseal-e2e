import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * The Scenario Driver's handle on one SDK driver subprocess (Protocol
 * Version 1 — docs/scenario-driver-protocol.md). One JSON object per line
 * over stdio: requests carry an integer id, responses echo it, and id-less
 * notifications (messages/events/issues) queue for waitForEvent.
 */
export class DriverError extends Error {
  constructor(code, message, command) {
    super(`${command} failed [${code}]: ${message}`)
    this.code = code
    this.command = command
  }
}

export class DriverProcess {
  constructor({ command, args = [], env = {}, name = 'driver', cwd }) {
    this.command = command
    this.args = args
    this.env = env
    this.name = name
    this.cwd = cwd
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.waiters = []
    this.stderr = ''
  }

  /** Spawns the driver and verifies the protocol handshake: `info` must
   *  answer with the Shared Facts shape (a driver that cannot fails the
   *  lane here, loudly — never a silent skip). */
  async start() {
    this.process = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.cwd ? { cwd: this.cwd } : {}),
    })
    this.process.stderr.on('data', chunk => {
      this.stderr += chunk.toString()
    })
    this.process.on('exit', (code, signal) => {
      const error = new Error(
        `driver ${this.name} exited unexpectedly (code ${code}, signal ${signal})\n${this.stderr}`,
      )
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      for (const waiter of this.waiters) waiter.reject(error)
      this.waiters = []
    })
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity })
    lines.on('line', line => this.onLine(line))

    const info = await this.request('info')
    for (const field of ['sdkVersion', 'transportVersion', 'endToEndVersion', 'maxPayloadBytes', 'maxGroupSize']) {
      if (info[field] === undefined || info[field] === null) {
        throw new Error(
          `driver ${this.name} failed the protocol handshake: info result is missing "${field}" ` +
            `(docs/scenario-driver-protocol.md)`,
        )
      }
    }
    this.info = info
    return this
  }

  onLine(line) {
    if (!line.trim()) return
    let value
    try {
      value = JSON.parse(line)
    } catch {
      this.stderr += `non-JSON line on stdout: ${line}\n`
      return
    }
    if (value.event !== undefined) {
      this.notifications.push(value)
      this.waiters = this.waiters.filter(waiter => {
        if (!waiter.predicate(value)) return true
        clearTimeout(waiter.timer)
        waiter.resolve(value)
        return false
      })
      return
    }
    const entry = this.pending.get(value.id)
    if (!entry) {
      this.stderr += `response with unknown id ${value.id}: ${line}\n`
      return
    }
    this.pending.delete(value.id)
    if (value.ok) entry.resolve(value.result ?? {})
    else entry.reject(new DriverError(value.error?.code ?? 'driver', value.error?.message ?? 'unknown error', entry.command))
  }

  request(command, args = {}) {
    if (!this.process || this.process.exitCode !== null) {
      return Promise.reject(new Error(`driver ${this.name} is not running`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, command })
      this.process.stdin.write(`${JSON.stringify({ id, command, ...args })}\n`)
    })
  }

  /** Waits for a notification matching `predicate` (a kind string matches
   *  `event.kind` for event/issue notifications, or the event name). */
  waitForEvent(predicate, timeoutMs = 15_000, description = 'notification') {
    const match = typeof predicate === 'string'
      ? value => value.event === predicate || value.kind === predicate
      : predicate
    // Already-queued notifications count — events can land before the wait.
    const queued = this.notifications.find(match)
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.timer !== timer)
        reject(
          new Error(
            `${this.name}: timed out after ${timeoutMs}ms waiting for ${description}\n` +
              `seen: ${JSON.stringify(this.notifications.slice(-10))}\n${this.stderr}`,
          ),
        )
      }, timeoutMs)
      this.waiters.push({ predicate: match, resolve, reject, timer })
    })
  }

  /** Asserts no matching notification arrives within `ms`. Drains the queue
   *  first so an already-queued match fails immediately. */
  async expectNoEvent(predicate, ms = 5_000, description = 'notification') {
    const match = typeof predicate === 'string'
      ? value => value.event === predicate || value.kind === predicate
      : predicate
    const queued = this.notifications.find(match)
    if (queued) {
      throw new Error(`${this.name}: expected no ${description}, but one was queued: ${JSON.stringify(queued)}`)
    }
    try {
      const value = await this.waitForEvent(match, ms, description)
      throw new Error(`${this.name}: expected no ${description}, got ${JSON.stringify(value)}`)
    } catch (error) {
      if (error.message.startsWith(`${this.name}: timed out`)) return
      throw error
    }
  }

  /** Forgets queued notifications (scenario steps that deliberately leave
   *  traffic unread call this before the next assertion). */
  drain() {
    this.notifications = []
  }

  async stop() {
    if (!this.process || this.process.exitCode !== null) return
    try {
      this.process.stdin.end()
    } catch {
      // Already closed.
    }
    this.process.kill('SIGTERM')
    await Promise.race([
      new Promise(resolvePromise => this.process.once('exit', resolvePromise)),
      new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
    ])
    if (this.process.exitCode === null) this.process.kill('SIGKILL')
  }
}
