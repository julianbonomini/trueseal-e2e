//! The Adversary Client (E2E-5, e2e ADR-0001 "Adversarial harness").
//!
//! A test-only hostile client built on the pinned trueseal-sync core crates.
//! Where the SDK Scenario Drivers map 1:1 onto the public SDK API (and must
//! never grow envelope crafting — Protocol v1), this binary is the lane that
//! crafts hostile-but-well-formed protocol traffic:
//!
//! - envelopes with tampered End-to-End Versions (newer / older / malformed);
//! - corrupted ciphertexts and unknown frame types;
//! - replayed envelope bytes (re-pushed verbatim);
//! - unauthorized Group Manifests (signed by a key the group never admitted);
//! - oversized pushes past the relay's size ceiling;
//! - wrong Transport Version prefixes.
//!
//! It can also join a group as a REAL member (a `TruesealSession` over its
//! own persisted `DeviceKeypair`) — the hostile-member role: admitted by the
//! group, still holding its private keys, so it can craft member-signed
//! envelopes with hostile parameters.
//!
//! Control protocol: newline-delimited JSON on stdin/stdout, the same
//! request/response + event shape as the SDK Scenario Drivers
//! (docs/scenario-driver-protocol.md), plus adversary-only commands the SDK
//! drivers deliberately do not have.

use std::env;
use std::io::{self, BufRead, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::prelude::*;
use serde_json::{json, Value};
use trueseal_sync::device::DeviceKeypair;
use trueseal_sync::envelope::{Envelope, SigningKeypair};
use trueseal_sync::keys::NoisePublicKey;
use trueseal_sync::manifest::{GroupManifest, ManifestMember};
use trueseal_sync::message::Message;
use trueseal_sync::relay::{push_send, RelayError};
use trueseal_sync::session::TruesealSession;
use trueseal_sync::version::{END_TO_END_VERSION, TRANSPORT_VERSION};

// ── Protocol plumbing ────────────────────────────────────────────────────────

fn emit(value: Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &value).expect("serialize event");
    writeln!(out).expect("write event");
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|error| error.to_string())
        })
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex_32(value: &str) -> Result<[u8; 32], String> {
    let bytes = decode_hex(value)?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| "expected 32 bytes".to_string())
}

fn argument(name: &str) -> String {
    let args: Vec<String> = env::args().collect();
    let index = args
        .iter()
        .position(|arg| arg == name)
        .unwrap_or_else(|| panic!("missing {name}"));
    args.get(index + 1)
        .cloned()
        .unwrap_or_else(|| panic!("missing {name}"))
}

// ── Identity ─────────────────────────────────────────────────────────────────

/// The adversary's persisted identity: `noise_priv || signing_priv` (hex) in
/// `<state-dir>/adversary.key`. Persisted so a restarted adversary keeps its
/// membership (a member's keys ARE its authority — ADR-0027).
struct Identity {
    keypair: DeviceKeypair,
    signing_priv: [u8; 32],
}

fn identity(state_dir: &str, fresh: bool) -> Result<Identity, String> {
    let path = std::path::Path::new(state_dir).join("adversary.key");
    if !fresh {
        if let Ok(hex) = std::fs::read_to_string(&path) {
            let raw = decode_hex(hex.trim())?;
            if raw.len() == 64 {
                let noise_priv: [u8; 32] = raw[..32].try_into().map_err(|_| "bad key file")?;
                let signing_priv: [u8; 32] = raw[32..].try_into().map_err(|_| "bad key file")?;
                let keypair = DeviceKeypair::from_bytes(noise_priv, signing_priv)
                    .map_err(|e| e.to_string())?;
                return Ok(Identity { keypair, signing_priv });
            }
        }
    }
    let keypair = DeviceKeypair::generate();
    let noise_priv = keypair.noise.private();
    let signing_priv = keypair.signing.to_bytes();
    let mut raw = Vec::with_capacity(64);
    raw.extend_from_slice(&noise_priv);
    raw.extend_from_slice(&signing_priv);
    std::fs::create_dir_all(state_dir).map_err(|e| e.to_string())?;
    std::fs::write(&path, encode_hex(&raw)).map_err(|e| e.to_string())?;
    Ok(Identity { keypair, signing_priv })
}

// ── Member role: a real session over the adversary's own keypair ─────────────
//
// The session type carries the concrete transport; a process-global slot is
// fine because a scenario drives one adversary at a time.

static SESSION: OnceLock<Arc<TruesealSession<TcpStream>>> = OnceLock::new();

fn session() -> Result<&'static Arc<TruesealSession<TcpStream>>, String> {
    SESSION.get().ok_or_else(|| "no session — open first".to_string())
}

fn open_session(
    state_dir: &str,
    relay_host: &str,
    relay_pub: [u8; 32],
) -> Result<Value, String> {
    let id = identity(state_dir, false)?;
    let noise_pub = id.keypair.public_key().0;
    let signing_pub = id.keypair.signing_public_key().0;
    let addr = format!("{relay_host}:7700");
    let on_message = |message: Message, sender: [u8; 32], sequence: u64| {
        let (kind, body) = match &message {
            Message::Sync { body } => ("sync", Some(body.clone())),
            Message::Pair { .. } => ("pair", None),
            Message::Revoke => ("revoke", None),
            Message::GroupManifest { .. } => ("groupManifest", None),
        };
        emit(json!({
            "event": "message",
            "kind": kind,
            "data": body.map(|b| BASE64_STANDARD.encode(b)),
            "senderId": encode_hex(&sender),
            "sequence": sequence,
        }));
    };
    let session = TruesealSession::connect_tcp(&addr, NoisePublicKey(relay_pub), id.keypair, on_message)
        .map_err(|e| e.to_string())?;
    let session = Arc::new(session);
    session.subscribe_delivery_issues(|issue| {
        use trueseal_sync::delivery_issue::{DeliveryIssue, UnreadableReason};
        let value = match issue {
            DeliveryIssue::Unreadable(reason) => json!({
                "type": "unreadable",
                "reason": match reason {
                    UnreadableReason::Malformed => "malformed",
                    UnreadableReason::SenderOutdated => "senderOutdated",
                    UnreadableReason::Expired => "expired",
                    UnreadableReason::DroppedWhileHeld => "droppedWhileHeld",
                },
            }),
            DeliveryIssue::HeldForUpgrade(v) => json!({ "type": "heldForUpgrade", "version": v }),
            DeliveryIssue::SendFailed { message_id, .. } => {
                json!({ "type": "sendFailed", "messageId": message_id })
            }
            DeliveryIssue::Unauthorized => json!({ "type": "unauthorized" }),
            other => json!({ "type": format!("{other:?}") }),
        };
        emit(json!({ "event": "deliveryIssue", "issue": value }));
    });
    SESSION
        .set(session)
        .map_err(|_| "session already open".to_string())?;
    Ok(json!({
        "noisePub": encode_hex(&noise_pub),
        "signingPub": encode_hex(&signing_pub),
    }))
}

// ── Wire crafting ────────────────────────────────────────────────────────────

/// Frame layout (relay ADR-0008): [msg type: 1][body length: 4 BE][body].
/// Hand-rolled here because the core's `frame` is crate-private — the
/// adversary must be able to emit frames the library never would.
fn frame(msg_type: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + body.len());
    out.push(msg_type);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// Push body layout (relay ADR-0008): [recipient_pub: 32][envelope proto].
fn push_frame_for(recipient: &[u8; 32], envelope_bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(32 + envelope_bytes.len());
    body.extend_from_slice(recipient);
    body.extend_from_slice(envelope_bytes);
    frame(0x01, &body) // MsgType::Push
}

fn relay_error_outcome(error: RelayError) -> Value {
    match error {
        RelayError::PushRejected(refusal) => {
            json!({ "outcome": "refused", "refusal": format!("{refusal:?}") })
        }
        RelayError::EnvelopeTooLarge => {
            json!({ "outcome": "refused", "refusal": "envelopeTooLarge(local backstop)" })
        }
        RelayError::RelayVersionUnsupported { min, max } => {
            json!({ "outcome": "versionUnsupported", "min": min, "max": max })
        }
        other => json!({ "outcome": "error", "error": other.to_string() }),
    }
}

fn raw_push(relay_host: &str, relay_pub: [u8; 32], frame_bytes: Vec<u8>) -> Value {
    let addr = format!("{relay_host}:7701");
    let stream = match TcpStream::connect(&addr) {
        Ok(stream) => stream,
        Err(error) => return json!({ "outcome": "error", "error": error.to_string() }),
    };
    // push_send requires a non-blocking transport (the version exchange
    // enforces its timeout through WouldBlock retries).
    if let Err(error) = stream.set_nonblocking(true) {
        return json!({ "outcome": "error", "error": error.to_string() });
    }
    match push_send(stream, relay_pub, frame_bytes) {
        Ok(()) => json!({ "outcome": "ack" }),
        Err(error) => relay_error_outcome(error),
    }
}

/// `craftAndPush`: build a sealed envelope to `recipient` (Sync body or a
/// verbatim encoded `Message`), optionally tamper the plaintext version
/// field, and push it over a fresh NK session. Returns the exact frame bytes
/// so the harness can replay them or hand them to the Hostile Relay's
/// `inject`.
fn craft_and_push(
    state_dir: &str,
    relay_host: &str,
    relay_pub: [u8; 32],
    message: &Value,
) -> Result<Value, String> {
    let recipient = decode_hex_32(message["recipient"].as_str().ok_or("missing recipient")?)?;
    let id = identity(state_dir, message["freshIdentity"].as_bool().unwrap_or(false))?;
    let signing = SigningKeypair::from_signing_key(ed25519_dalek::SigningKey::from_bytes(
        &id.signing_priv,
    ));

    let encoded_message = if let Some(hex) = message["messageHex"].as_str() {
        decode_hex(hex)?
    } else {
        let body = decode_hex(message["bodyHex"].as_str().ok_or("missing bodyHex")?)?;
        Message::Sync { body }.encode()
    };

    let sequence = message["sequence"].as_u64().unwrap_or(1);
    let timestamp = message["senderTimestampMs"]
        .as_u64()
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        });
    let envelope = Envelope::build_sealed(
        sequence,
        Vec::new(),
        NoisePublicKey(recipient),
        &signing,
        timestamp,
        &encoded_message,
    );
    let mut envelope_bytes = envelope.encode();
    if let Some(version) = message["version"].as_u64() {
        // The End-to-End Version is a plaintext proto field checked BEFORE
        // decryption (ADR-0022) — tampering it post-seal is exactly what a
        // wrong-version blob from the wild looks like.
        let mut tampered = Envelope::decode(&envelope_bytes).map_err(|e| e.to_string())?;
        tampered.version = version as u32;
        envelope_bytes = tampered.encode();
    }
    let frame_bytes = push_frame_for(&recipient, &envelope_bytes);
    let mut result = raw_push(relay_host, relay_pub, frame_bytes.clone());
    result["frameHex"] = json!(encode_hex(&frame_bytes));
    result["envelopeHex"] = json!(encode_hex(&envelope_bytes));
    Ok(result)
}

/// `pushFrame`: push verbatim frame bytes (malformed / unknown-type rows).
fn push_frame(relay_host: &str, relay_pub: [u8; 32], message: &Value) -> Result<Value, String> {
    let frame_bytes = decode_hex(message["frameHex"].as_str().ok_or("missing frameHex")?)?;
    Ok(raw_push(relay_host, relay_pub, frame_bytes))
}

/// `transportProbe`: speak only the Transport Version prefix
/// ("TSP" || u16 BE, ADR-0022) and report the relay's plaintext reply. No
/// Noise handshake — a wrong-version client never gets that far.
fn transport_probe(relay_host: &str, message: &Value) -> Result<Value, String> {
    let version = message["version"].as_u64().ok_or("missing version")? as u16;
    let addr = format!("{relay_host}:7700");
    let mut stream = TcpStream::connect(&addr).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut prefix = b"TSP".to_vec();
    prefix.extend_from_slice(&version.to_be_bytes());
    stream.write_all(&prefix).map_err(|e| e.to_string())?;
    let mut reply = Vec::new();
    let mut buf = [0u8; 256];
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break, // closed — a refusal ends the connection
            Ok(n) => reply.extend_from_slice(&buf[..n]),
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    break;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
        if reply.ends_with(b"\n") {
            break;
        }
    }
    Ok(json!({
        "replyHex": encode_hex(&reply),
        "replyText": String::from_utf8_lossy(&reply),
    }))
}

/// `craftManifest`: a GroupManifest signed by the adversary's own key —
/// unauthorized unless the group admitted that key (ADR-0027's
/// unknown-issuer / group-id checks are the client's defense). Returns the
/// encoded `Message` for `craftAndPush` or the Hostile Relay's `inject`.
fn craft_manifest(state_dir: &str, message: &Value) -> Result<Value, String> {
    let group_id = decode_hex_32(message["groupId"].as_str().ok_or("missing groupId")?)?;
    let version = message["version"].as_u64().ok_or("missing version")?;
    let id = identity(state_dir, false)?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&id.signing_priv);
    let members: Vec<ManifestMember> = message["members"]
        .as_array()
        .ok_or("missing members")?
        .iter()
        .map(|member| {
            Ok(ManifestMember {
                noise_pub: trueseal_sync::keys::NoisePublicKey(decode_hex_32(
                    member["noisePub"].as_str().ok_or("missing noisePub")?,
                )?),
                signing_pub: trueseal_sync::keys::SigningPublicKey(decode_hex_32(
                    member["signingPub"].as_str().ok_or("missing signingPub")?,
                )?),
                name: member["name"].as_str().unwrap_or("adversary").to_owned(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    // GroupManifest::new signs with the caller's key and sets parent=None.
    // A hostile manifest's CONTENT (a version jump past the bound, a foreign
    // group id, an unknown issuer) is what the client must reject — the
    // signature itself is valid.
    let manifest = GroupManifest::new(group_id, version, members, &signing);
    let encoded = Message::GroupManifest { manifest }.encode();
    Ok(json!({ "messageHex": encode_hex(&encoded) }))
}

// ── Command dispatch ─────────────────────────────────────────────────────────

fn execute(state_dir: &str, relay_host: &str, relay_pub: [u8; 32], message: &Value) -> Result<Value, String> {
    let command = message["command"].as_str().ok_or("missing command")?;
    match command {
        "info" => Ok(json!({
            // The Adversary Client is not an SDK; it reports the pinned
            // core's facts so the harness handshake passes.
            "sdkVersion": "adversary",
            "transportVersion": TRANSPORT_VERSION,
            "endToEndVersion": END_TO_END_VERSION,
            "maxPayloadBytes": trueseal_sync::limits::PROTOCOL_SIZE_LIMIT,
            "maxGroupSize": 32,
        })),
        "keypair" => {
            let fresh = message["fresh"].as_bool().unwrap_or(false);
            let id = identity(state_dir, fresh)?;
            Ok(json!({
                "noisePub": encode_hex(&id.keypair.public_key().0),
                "signingPub": encode_hex(&id.keypair.signing_public_key().0),
            }))
        }
        "open" => open_session(state_dir, relay_host, relay_pub),
        "joinGroup" => {
            let token = message["token"].as_str().ok_or("missing token")?;
            session()?
                .join_group(token)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "groupStatus" => Ok(json!(format!("{:?}", session()?.group_status()))),
        "pairingToken" => Ok(json!(session()?.pairing_token().map_err(|e| e.to_string())?)),
        "acceptMember" => Ok(json!(session()?
            .accept_member(message["token"].as_str().ok_or("missing token")?)
            .map_err(|e| e.to_string())?)),
        "members" => Ok(json!(session()?
            .members()
            .into_iter()
            .map(|member| json!({
                "noisePub": encode_hex(&member.noise_pub.0),
                "signingPub": encode_hex(&member.signing_pub.0),
                "name": member.name,
            }))
            .collect::<Vec<_>>())),
        "send" => {
            let data = BASE64_STANDARD
                .decode(message["data"].as_str().ok_or("missing data")?)
                .map_err(|e| e.to_string())?;
            Ok(json!(session()?.push_sync(data).map_err(|e| e.to_string())?))
        }
        "craftAndPush" => craft_and_push(state_dir, relay_host, relay_pub, message),
        "pushFrame" => push_frame(relay_host, relay_pub, message),
        "transportProbe" => transport_probe(relay_host, message),
        "craftManifest" => craft_manifest(state_dir, message),
        "close" => {
            if let Some(session) = SESSION.get() {
                session.close();
            }
            Ok(Value::Null)
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state_dir = argument("--state-dir");
    let relay_host = argument("--relay-host");
    let relay_pub = decode_hex_32(&argument("--relay-pub"))?;

    emit(json!({ "event": "ready" }));

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                emit(json!({ "ok": false, "error": error.to_string() }));
                continue;
            }
        };
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        match execute(&state_dir, &relay_host, relay_pub, &message) {
            Ok(result) => emit(json!({ "id": id, "ok": true, "result": result })),
            Err(error) => emit(json!({ "id": id, "ok": false, "error": error })),
        }
    }
    Ok(())
}
