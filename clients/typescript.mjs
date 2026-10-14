import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

// The TypeScript Scenario Driver — Protocol Version 1
// (docs/scenario-driver-protocol.md). Speaks JSON lines over stdin/stdout
// and drives ONLY the public @trueseal/sync API (e2e#5: no core or FFI
// imports). Started by the harness with TRUESEAL_TS_REPO pointing at the
// (pinned, in gate mode) SDK checkout.
const require = createRequire(import.meta.url)
const tsRepo = resolve(process.env.TRUESEAL_TS_REPO)
const { TrueSeal } = require(tsRepo)

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function reply(id, ok, payload) {
  emit(ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload })
}

function errorJson(error) {
  // TrueSealError carries the canonical code (D21); anything else is a
  // driver-local failure, never an SDK error.
  const code = typeof error?.code === 'string' ? error.code : 'driver'
  return { code, message: error?.message ?? String(error) }
}

function memberJson(member) {
  return { id: member.id, name: member.name }
}

function connectionJson(connection) {
  const value = { state: connection.state }
  if (connection.state === 'relayVersionUnsupported') {
    value.min = connection.min
    value.max = connection.max
  }
  return value
}

let ts = null

function requireSession() {
  if (!ts) throw new Error('no open session — send "open" first')
  return ts
}

async function execute(command, request) {
  switch (command) {
    case 'open': {
      if (ts) throw new Error('a session is already open')
      ts = await TrueSeal.open(request.relay, {
        storageDir: resolve(request.storagePath),
        namespace: request.namespace ?? 'default',
        maxPayloadBytes: request.maxPayloadBytes,
      })
      return { me: memberJson(ts.me) }
    }
    case 'close': {
      requireSession().close()
      ts = null
      return {}
    }
    case 'info': {
      const info = TrueSeal.info
      return {
        sdkVersion: info.sdkVersion,
        transportVersion: info.transportVersion,
        endToEndVersion: info.endToEndVersion,
        maxPayloadBytes: TrueSeal.maxPayloadBytes,
        maxGroupSize: TrueSeal.maxGroupSize,
      }
    }
    case 'send':
      return { messageId: requireSession().send(Buffer.from(request.bodyHex, 'hex')) }
    case 'startPairing':
      return { token: requireSession().startPairing() }
    case 'accept':
      requireSession().accept(request.requestId)
      return {}
    case 'cancelPairing':
      requireSession().cancelPairing()
      return {}
    case 'join':
      requireSession().join(request.token)
      return {}
    case 'cancelJoin':
      requireSession().cancelJoin()
      return {}
    case 'remove':
      requireSession().remove(request.memberId)
      return {}
    case 'leave':
      requireSession().leave()
      return {}
    case 'destroyGroup':
      requireSession().destroyGroup()
      return {}
    case 'status':
      return { status: requireSession().status }
    case 'me':
      return { me: memberJson(requireSession().me) }
    case 'members':
      return { members: requireSession().members.map(memberJson) }
    case 'connection':
      return { connection: connectionJson(requireSession().connection) }
    case 'receive':
      // Registration starts receiving (ADR-0026). The handler is awaited:
      // a throw is a handler attempt, so notification emission never throws.
      requireSession().onMessage(async message => {
        // Test-only fault injection (TS-driver-only capability): the app
        // misses its commit but the handler returns normally — the library
        // acks (ADR-0026 ack-after-handler) and the message is never
        // redelivered.
        if (message.body.toString('utf8') === process.env.TRUESEAL_E2E_DROP_BEFORE_COMMIT_TEXT) return
        emit({
          event: 'message',
          message: {
            id: message.id,
            from: memberJson(message.from),
            bodyHex: message.body.toString('hex'),
          },
        })
      })
      return {}
    case 'listenEvents':
      requireSession().onEvent(event => {
        switch (event.type) {
          case 'statusChanged':
            emit({ event: 'event', kind: 'statusChanged', status: event.status, reason: event.reason })
            break
          case 'membersChanged':
            emit({ event: 'event', kind: 'membersChanged', members: event.members.map(memberJson) })
            break
          case 'joinRequest':
            emit({ event: 'event', kind: 'joinRequest', requestId: event.request.id, name: event.request.name })
            break
          case 'connectionChanged':
            emit({ event: 'event', kind: 'connectionChanged', connection: connectionJson(event.connection) })
            break
          case 'admissionDropped':
            emit({ event: 'event', kind: 'admissionDropped', name: event.name, reason: event.reason })
            break
        }
      })
      return {}
    case 'listenIssues':
      requireSession().onDeliveryIssue(issue => {
        switch (issue.type) {
          case 'unreadable':
            emit({ event: 'issue', kind: 'unreadable', reason: issue.reason })
            break
          case 'unauthorized':
            emit({ event: 'issue', kind: 'unauthorized' })
            break
          case 'heldForUpgrade':
            emit({ event: 'issue', kind: 'heldForUpgrade', version: issue.version })
            break
          case 'handlerGaveUp':
            emit({ event: 'issue', kind: 'handlerGaveUp', messageId: issue.messageId, error: issue.error })
            break
          case 'sendFailed':
            emit({ event: 'issue', kind: 'sendFailed', messageId: issue.messageId, reason: issue.reason })
            break
        }
      })
      return {}
    default:
      throw new Error(`unknown command "${command}"`)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
  } catch (error) {
    reply(null, false, { code: 'malformed', message: `not a JSON object: ${error.message}` })
    continue
  }
  if (typeof request.command !== 'string') {
    reply(request.id ?? null, false, { code: 'malformed', message: 'missing "command"' })
    continue
  }
  try {
    reply(request.id ?? null, true, await execute(request.command, request))
  } catch (error) {
    reply(request.id ?? null, false, errorJson(error))
  }
}

ts?.close()
