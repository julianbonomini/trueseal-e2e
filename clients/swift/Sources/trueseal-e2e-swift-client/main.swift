import Foundation
import TruesealSync

private let outputQueue = DispatchQueue(label: "trueseal.e2e.output")

private func emit(_ value: [String: Any]) {
    outputQueue.sync {
        let data = try! JSONSerialization.data(withJSONObject: value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

private func argument(_ name: String) -> String {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        fatalError("missing \(name)")
    }
    return arguments[index + 1]
}

private func decodeHex(_ value: String) -> Data? {
    guard value.count.isMultiple(of: 2) else { return nil }
    var data = Data(capacity: value.count / 2)
    var index = value.startIndex
    while index < value.endIndex {
        let next = value.index(index, offsetBy: 2)
        guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
        data.append(byte)
        index = next
    }
    return data
}

private actor PairingRequests {
    private var values: [String: PairingRequest] = [:]
    func store(_ request: PairingRequest) { values[request.token] = request }
    func take(_ token: String) -> PairingRequest? { values.removeValue(forKey: token) }
}

@main
struct ClientMain {
    static func main() async throws {
        guard let relayKey = decodeHex(argument("--relay-pub")) else {
            fatalError("invalid relay public key")
        }
        let client = try TruesealSyncClient(
            relayURL: URL(string: "tcp://\(argument("--relay-host"))")!,
            relayPublicKey: relayKey,
            storageDirectory: URL(fileURLWithPath: argument("--state-dir"), isDirectory: true),
            namespace: "e2e"
        )
        let requests = PairingRequests()

        let listeners = [
            Task.detached {
                for await blob in client.blobs {
                    emit([
                        "event": "message",
                        "text": blob.text ?? "",
                        "data": blob.data.base64EncodedString(),
                        "senderId": blob.senderPublicKey.base64EncodedString(),
                        "messageId": blob.messageId,
                    ])
                }
            },
            Task.detached {
                for await request in client.pairingRequests {
                    await requests.store(request)
                    emit(["event": "memberRequest", "requestToken": request.token, "name": request.deviceName])
                }
            },
            Task.detached {
                for await event in client.memberEvents {
                    switch event {
                    case .joined(let member):
                        emit(["event": "memberJoined", "member": ["id": member.id, "name": member.name]])
                    case .left(let member):
                        emit(["event": "memberLeft", "member": ["id": member.id, "name": member.name]])
                    case .removedSelf:
                        emit(["event": "removedFromGroup"])
                    case .groupDestroyed:
                        emit(["event": "groupDestroyed"])
                    }
                }
            },
            Task.detached {
                for await state in client.connectionState {
                    switch state {
                    case .connected: emit(["event": "connectionChanged", "connected": true])
                    case .disconnected: emit(["event": "connectionChanged", "connected": false])
                    }
                }
            },
        ]

        emit([
            "event": "ready",
            "localNodeId": client.localNodeId,
            "localDeviceName": client.localDeviceName,
            "members": client.members.map { ["id": $0.id, "name": $0.name] },
        ])

        while let line = readLine() {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            var id: Any = NSNull()
            do {
                guard let data = line.data(using: .utf8),
                      let message = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let command = message["command"] as? String else {
                    throw ClientError.invalidCommand
                }
                id = message["id"] ?? NSNull()
                let result: Any
                switch command {
                case "pairingToken":
                    result = client.generatePairingToken()
                case "joinGroup":
                    try client.joinGroup(token: message["token"] as! String)
                    result = NSNull()
                case "acceptPairingRequest":
                    let token = message["requestToken"] as! String
                    guard let request = await requests.take(token) else { throw ClientError.unknownPairingRequest }
                    client.acceptPairingRequest(request)
                    result = true
                case "cancelPairing":
                    client.cancelPairing()
                    result = NSNull()
                case "send":
                    guard let value = message["data"] as? String, let data = Data(base64Encoded: value) else {
                        throw ClientError.invalidData
                    }
                    try await client.publish(data)
                    result = NSNull()
                case "members":
                    result = client.members.map { ["id": $0.id, "name": $0.name] }
                case "removeMember":
                    let memberId = message["memberId"] as! String
                    guard let member = client.members.first(where: { $0.id == memberId }) else {
                        throw ClientError.memberNotFound
                    }
                    try client.removeMember(member)
                    result = NSNull()
                case "destroyGroup":
                    client.destroyGroup()
                    result = NSNull()
                default:
                    throw ClientError.invalidCommand
                }
                emit(["id": id, "ok": true, "result": result])
            } catch {
                emit(["id": id, "ok": false, "error": String(describing: error)])
            }
        }
        listeners.forEach { $0.cancel() }
    }
}

private enum ClientError: Error {
    case invalidCommand
    case invalidData
    case unknownPairingRequest
    case memberNotFound
}
