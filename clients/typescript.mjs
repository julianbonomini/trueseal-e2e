import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const tsRepo = resolve(process.env.TRUESEAL_TS_REPO)
const { TruesealSyncClient } = require(tsRepo)

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const client = await TruesealSyncClient.create({
  relayHost: argument('--relay-host'),
  relayPublicKey: Buffer.from(argument('--relay-pub'), 'hex'),
  storageDir: resolve(argument('--state-dir')),
  namespace: 'e2e',
})

client.on('message', (blob, senderId, messageId) => {
  const text = Buffer.from(blob).toString('utf8')
  // Test-only fault injection: model a crash/failure before app state commits.
  if (text === process.env.TRUESEAL_E2E_DROP_BEFORE_COMMIT_TEXT) return
  emit({
    event: 'message',
    text,
    data: Buffer.from(blob).toString('base64'),
    senderId,
    messageId,
  })
})
client.on('memberRequest', (requestToken, name) => emit({ event: 'memberRequest', requestToken, name }))
client.on('memberJoined', member => emit({ event: 'memberJoined', member }))
client.on('memberLeft', member => emit({ event: 'memberLeft', member }))
client.on('removedFromGroup', () => emit({ event: 'removedFromGroup' }))
client.on('groupDestroyed', () => emit({ event: 'groupDestroyed' }))
client.on('connectionChanged', connected => emit({ event: 'connectionChanged', connected }))

emit({
  event: 'ready',
  localNodeId: client.localNodeId,
  localDeviceName: client.localDeviceName,
  members: client.members,
})

async function execute(message) {
  switch (message.command) {
    case 'pairingToken':
      return client.pairingToken()
    case 'joinGroup':
      client.joinGroup(message.token)
      return null
    case 'acceptPairingRequest':
      return client.acceptPairingRequest(message.requestToken)
    case 'cancelPairing':
      client.cancelPairing()
      return null
    case 'send':
      await client.send(Buffer.from(message.data, 'base64'))
      return null
    case 'members':
      return client.members
    case 'removeMember':
      client.removeMember(message.memberId)
      return null
    case 'destroyGroup':
      client.destroyGroup()
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

client.dispose()
