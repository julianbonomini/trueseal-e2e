import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const tsRepo = resolve(process.env.TRUESEAL_TS_REPO)
const { TrueSeal } = require(tsRepo)

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

// The harness drives the relay on the default ports (lib/relay-process.mjs),
// so the Relay Address is explicit about both.
const relayAddress = `trueseal://${argument('--relay-pub')}@${argument('--relay-host')}:7700?push=7701`

const ts = await TrueSeal.open(relayAddress, {
  storageDir: resolve(argument('--state-dir')),
  namespace: 'e2e',
})

// The canonical API emits membersChanged snapshots (ADR-0028); the harness
// protocol speaks memberJoined/memberLeft, so the client diffs snapshots.
let knownMembers = new Map(ts.members.map(member => [member.id, member]))

ts.onMessage(message => {
  const text = message.body.toString('utf8')
  // Test-only fault injection: the app misses its commit but the handler
  // returns normally — the library acks (ADR-0026 ack-after-handler), and
  // the message is never redelivered.
  if (text === process.env.TRUESEAL_E2E_DROP_BEFORE_COMMIT_TEXT) return
  emit({
    event: 'message',
    text,
    data: message.body.toString('base64'),
    senderId: message.from.id,
    messageId: message.id,
  })
})

ts.onEvent(event => {
  switch (event.type) {
    case 'joinRequest':
      emit({ event: 'memberRequest', requestToken: event.request.id, name: event.request.name })
      break
    case 'membersChanged': {
      const next = new Map(event.members.map(member => [member.id, member]))
      for (const [id, member] of next) {
        if (!knownMembers.has(id)) emit({ event: 'memberJoined', member: { id: member.id, name: member.name } })
      }
      for (const [id, member] of knownMembers) {
        if (!next.has(id)) emit({ event: 'memberLeft', member: { id: member.id, name: member.name } })
      }
      knownMembers = next
      break
    }
    case 'statusChanged':
      if (event.status === 'notJoined' && event.reason === 'removed') emit({ event: 'removedFromGroup' })
      if (event.status === 'notJoined' && event.reason === 'destroyed') emit({ event: 'groupDestroyed' })
      break
    case 'connectionChanged':
      emit({ event: 'connectionChanged', connected: event.connection.state === 'connected' })
      break
    default:
      break
  }
})

ts.onDeliveryIssue(issue => {
  emit({ event: 'deliveryIssue', issue })
})

emit({
  event: 'ready',
  localNodeId: ts.me.id,
  localDeviceName: ts.me.name,
  members: ts.members,
})

async function execute(message) {
  switch (message.command) {
    case 'pairingToken':
      return ts.startPairing()
    case 'joinGroup':
      ts.join(message.token)
      return null
    case 'acceptPairingRequest':
      ts.accept(message.requestToken)
      return null
    case 'cancelPairing':
      ts.cancelPairing()
      return null
    case 'send':
      ts.send(Buffer.from(message.data, 'base64'))
      return null
    case 'members':
      return ts.members
    case 'removeMember':
      ts.remove(message.memberId)
      return null
    case 'destroyGroup':
      ts.destroyGroup()
      return null
    default:
      throw new Error(`unknown command: ${message.command}`)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let message
  try {
    message = JSON.parse(line)
    const result = await execute(message)
    emit({ id: message.id, ok: true, result })
  } catch (error) {
    emit({ id: message?.id, ok: false, error: error?.message ?? String(error) })
  }
}

ts.close()
