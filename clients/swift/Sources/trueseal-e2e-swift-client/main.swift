import Foundation
import TruesealSync

// The Swift Scenario Driver — Protocol Version 1
// (docs/scenario-driver-protocol.md in trueseal-e2e). Speaks JSON lines
// over stdin/stdout and drives ONLY the public TruesealSync API (e2e#5:
// no core or FFI imports — the bindings are @_implementationOnly in the
// SDK, so nothing else is even reachable).

private let outputLock = NSLock()

private func emit(_ value: [String: Any]) {
    outputLock.lock()
    defer { outputLock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func reply(_ id: Int?, _ ok: Bool, _ payload: [String: Any]) {
    var line: [String: Any] = ["ok": ok, ok ? "result" : "error": payload]
    if let id { line["id"] = id }
    emit(line)
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

private func encodeHex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

// The canonical vocabularies (shared-facts.json) — the SDK's enums map
// character-for-character; the G12 parity check verifies the same names
// from source.
private func statusCode(_ status: GroupStatus) -> String {
    switch status {
    case .notJoined: "notJoined"
    case .pendingJoin: "pendingJoin"
    case .member: "member"
    case .leaving: "leaving"
    case .destroying: "destroying"
    }
}

private func reasonCode(_ reason: StatusReason) -> String {
    switch reason {
    case .created: "created"
    case .joined: "joined"
    case .left: "left"
    case .removed: "removed"
    case .destroyed: "destroyed"
    case .storeReset: "storeReset"
    }
}

private func connectionJson(_ connection: ConnectionState) -> [String: Any] {
    switch connection {
    case .connecting: ["state": "connecting"]
    case .connected: ["state": "connected"]
    case .disconnected: ["state": "disconnected"]
    case .relayVersionUnsupported(let min, let max):
        ["state": "relayVersionUnsupported", "min": Int(min), "max": Int(max)]
    }
}

private func memberJson(_ member: Member) -> [String: Any] {
    ["id": member.id, "name": member.name]
}

private func errorJson(_ error: Error) -> [String: Any] {
    guard let error = error as? TrueSealError else {
        return ["code": "driver", "message": String(describing: error)]
    }
    let code: String = switch error {
    case .invalidRelayAddress: "invalidRelayAddress"
    case .invalidNamespace: "invalidNamespace"
    case .storage: "storage"
    case .closed: "closed"
    case .notMember: "notMember"
    case .alreadyInGroup: "alreadyInGroup"
    case .invalidPairingToken: "invalidPairingToken"
    case .pairingClosed: "pairingClosed"
    case .groupFull: "groupFull"
    case .memberNotFound: "memberNotFound"
    case .payloadTooLarge: "payloadTooLarge"
    case .messageHandlerAlreadySet: "messageHandlerAlreadySet"
    case .storeTooNew: "storeTooNew"
    case .manifestVersionExhausted: "manifestVersionExhausted"
    }
    return ["code": code, "message": String(describing: error)]
}

private struct DriverFailure: Error {
    let message: String
}

// The driver is an ACTOR, not MainActor: its protocol loop parks in the
// blocking readLine() on the actor's executor (a background thread), which
// leaves the main thread free — so the SDK's @MainActor @Observable state
// updates (Task-hopped from the internal event listeners, D1) are never
// starved. Every touch of the SDK's MainActor-isolated surface is an
// explicit await hop.
private actor Driver {
    private var session: TrueSeal?

    private func requireSession() throws -> TrueSeal {
        guard let session else { throw DriverFailure(message: "no open session — send \"open\" first") }
        return session
    }

    func execute(_ command: String, _ request: [String: Any]) async throws -> [String: Any] {
    switch command {
    case "open":
        guard session == nil else { throw DriverFailure(message: "a session is already open") }
        guard let relay = request["relay"] as? String,
              let storagePath = request["storagePath"] as? String
        else { throw DriverFailure(message: "open needs relay and storagePath") }
        let namespace = request["namespace"] as? String ?? "default"
        let maxPayload = (request["maxPayloadBytes"] as? Int).map { UInt32($0) }
        let ts = try await TrueSeal.open(
            relay: relay,
            storage: URL(fileURLWithPath: storagePath),
            namespace: namespace,
            maxPayloadBytes: maxPayload
        )
        session = ts
        return ["me": memberJson(await ts.me)]
    case "close":
        try requireSession().close()
        session = nil
        return [:]
    case "info":
        let info = TrueSeal.info
        return [
            "sdkVersion": info.sdkVersion,
            "transportVersion": Int(info.transportVersion),
            "endToEndVersion": Int(info.endToEndVersion),
            "maxPayloadBytes": Int(TrueSeal.maxPayloadBytes),
            "maxGroupSize": Int(TrueSeal.maxGroupSize),
        ]
    case "send":
        guard let bodyHex = request["bodyHex"] as? String, let body = decodeHex(bodyHex) else {
            throw DriverFailure(message: "send needs bodyHex (lowercase hex)")
        }
        return ["messageId": try requireSession().send(body)]
    case "startPairing":
        return ["token": try await requireSession().startPairing()]
    case "accept":
        guard let requestId = request["requestId"] as? String else {
            throw DriverFailure(message: "accept needs requestId")
        }
        try await requireSession().accept(requestId: requestId)
        return [:]
    case "cancelPairing":
        try await requireSession().cancelPairing()
        return [:]
    case "join":
        guard let token = request["token"] as? String else {
            throw DriverFailure(message: "join needs token")
        }
        try await requireSession().join(token: token)
        return [:]
    case "cancelJoin":
        try await requireSession().cancelJoin()
        return [:]
    case "remove":
        guard let memberId = request["memberId"] as? String else {
            throw DriverFailure(message: "remove needs memberId")
        }
        try await requireSession().remove(memberId: memberId)
        return [:]
    case "leave":
        try await requireSession().leave()
        return [:]
    case "destroyGroup":
        try await requireSession().destroyGroup()
        return [:]
    case "status":
        return ["status": statusCode(try await requireSession().status)]
    case "me":
        return ["me": memberJson(try await requireSession().me)]
    case "members":
        return ["members": try await requireSession().members.map(memberJson)]
    case "connection":
        return ["connection": connectionJson(try await requireSession().connection)]
    case "receive":
        // Registration starts receiving (ADR-0026). The handler is awaited:
        // a throw is a handler attempt, so emission never throws.
        _ = try requireSession().onMessage { message in
            emit([
                "event": "message",
                "message": [
                    "id": message.id,
                    "from": memberJson(message.from),
                    "bodyHex": encodeHex(message.body),
                ],
            ])
        }
        return [:]
    case "listenEvents":
        _ = try requireSession().onEvent { event in
            switch event {
            case .statusChanged(let status, let reason):
                emit(["event": "event", "kind": "statusChanged", "status": statusCode(status), "reason": reasonCode(reason)])
            case .membersChanged(let members):
                emit(["event": "event", "kind": "membersChanged", "members": members.map(memberJson)])
            case .joinRequest(let joinRequest):
                emit(["event": "event", "kind": "joinRequest", "requestId": joinRequest.id, "name": joinRequest.name])
            case .connectionChanged(let connection):
                emit(["event": "event", "kind": "connectionChanged", "connection": connectionJson(connection)])
            case .admissionDropped(let name, let reason):
                let reasonCode = switch reason {
                case .groupFull: "groupFull"
                }
                emit(["event": "event", "kind": "admissionDropped", "name": name, "reason": reasonCode])
            }
        }
        return [:]
    case "listenIssues":
        _ = try requireSession().onDeliveryIssue { issue in
            switch issue {
            case .unreadable(let reason):
                let code = switch reason {
                case .malformed: "malformed"
                case .senderOutdated: "senderOutdated"
                case .expired: "expired"
                case .droppedWhileHeld: "droppedWhileHeld"
                }
                emit(["event": "issue", "kind": "unreadable", "reason": code])
            case .unauthorized:
                emit(["event": "issue", "kind": "unauthorized"])
            case .heldForUpgrade(let version):
                emit(["event": "issue", "kind": "heldForUpgrade", "version": Int(version)])
            case .handlerGaveUp(let messageId, let error):
                emit(["event": "issue", "kind": "handlerGaveUp", "messageId": messageId, "error": error])
            case .sendFailed(let messageId, let reason):
                let code = switch reason {
                case .tooLarge: "tooLarge"
                case .malformed: "malformed"
                case .expired: "expired"
                }
                emit(["event": "issue", "kind": "sendFailed", "messageId": messageId, "reason": code])
            }
        }
        return [:]
    default:
        throw DriverFailure(message: "unknown command \"\(command)\"")
    }
    }

    func run() async {
        // The protocol loop: one JSON object per line over stdio.
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard let data = line.data(using: .utf8),
                  let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                reply(nil, false, ["code": "malformed", "message": "not a JSON object"])
                continue
            }
            let id = request["id"] as? Int
            guard let command = request["command"] as? String else {
                reply(id, false, ["code": "malformed", "message": "missing \"command\""])
                continue
            }
            do {
                reply(id, true, try await execute(command, request))
            } catch let failure as DriverFailure {
                reply(id, false, ["code": "driver", "message": failure.message])
            } catch {
                reply(id, false, errorJson(error))
            }
        }
        await session?.close()
    }
}

await Driver().run()
