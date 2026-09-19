use std::env;
use std::io::{self, BufRead, Write};
use std::sync::Arc;

use base64::prelude::*;
use serde_json::{json, Value};
use trueseal_sync::ffi::{
    ConnectionChangedCallback, GroupDestroyedCallback, MemberJoinedCallback, MemberLeftCallback,
    MemberRequestCallback, MessageCallback, RemovedFromGroupCallback, TruesealFfiSession,
};

fn emit(value: Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &value).expect("serialize event");
    writeln!(out).expect("write event");
}

struct Messages;
impl MessageCallback for Messages {
    fn on_message(&self, blob: Vec<u8>, sender_noise_pub: Vec<u8>, message_id: String) {
        emit(json!({
            "event": "message",
            "text": String::from_utf8_lossy(&blob),
            "data": BASE64_STANDARD.encode(&blob),
            "senderId": BASE64_URL_SAFE_NO_PAD.encode(sender_noise_pub),
            "messageId": message_id,
        }));
    }
}

struct Removed;
impl RemovedFromGroupCallback for Removed {
    fn on_removed_from_group(&self) {
        emit(json!({ "event": "removedFromGroup" }));
    }
}

struct Destroyed;
impl GroupDestroyedCallback for Destroyed {
    fn on_group_destroyed(&self) {
        emit(json!({ "event": "groupDestroyed" }));
    }
}

struct Connection;
impl ConnectionChangedCallback for Connection {
    fn on_connection_changed(&self, connected: bool) {
        emit(json!({ "event": "connectionChanged", "connected": connected }));
    }
}

struct Requests;
impl MemberRequestCallback for Requests {
    fn on_member_request(&self, token: String, name: String) {
        emit(json!({ "event": "memberRequest", "requestToken": token, "name": name }));
    }
}

struct Joined;
impl MemberJoinedCallback for Joined {
    fn on_member_joined(&self, member_id: String, member_name: String) {
        emit(json!({
            "event": "memberJoined",
            "member": { "id": member_id, "name": member_name },
        }));
    }
}

struct Left;
impl MemberLeftCallback for Left {
    fn on_member_left(&self, member_id: String, member_name: String) {
        emit(json!({
            "event": "memberLeft",
            "member": { "id": member_id, "name": member_name },
        }));
    }
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

fn execute(session: &Arc<TruesealFfiSession>, message: &Value) -> Result<Value, String> {
    let command = message["command"].as_str().ok_or("missing command")?;
    match command {
        "pairingToken" => Ok(json!(session.pairing_token())),
        "joinGroup" => {
            session
                .join_group(message["token"].as_str().ok_or("missing token")?.to_owned())
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "acceptPairingRequest" => Ok(json!(session.accept_member(
            message["requestToken"]
                .as_str()
                .ok_or("missing requestToken")?
                .to_owned()
        ))),
        "cancelPairing" => {
            session.cancel_pairing();
            Ok(Value::Null)
        }
        "send" => {
            let data = BASE64_STANDARD
                .decode(message["data"].as_str().ok_or("missing data")?)
                .map_err(|error| error.to_string())?;
            session.send(data).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "members" => Ok(json!(session
            .members()
            .into_iter()
            .map(|member| { json!({ "id": member.id, "name": member.name }) })
            .collect::<Vec<_>>())),
        "removeMember" => {
            session
                .remove_member(
                    message["memberId"]
                        .as_str()
                        .ok_or("missing memberId")?
                        .to_owned(),
                )
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "destroyGroup" => {
            session.destroy_group();
            Ok(Value::Null)
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let session = TruesealFfiSession::create(
        argument("--state-dir"),
        "e2e".into(),
        argument("--relay-host"),
        decode_hex(&argument("--relay-pub"))?,
        Box::new(Messages),
        Box::new(Removed),
        Box::new(Destroyed),
        Some(Box::new(Connection)),
    )?;
    session.set_on_member_request(Box::new(Requests));
    session.set_on_member_joined(Box::new(Joined));
    session.set_on_member_left(Box::new(Left));

    emit(json!({
        "event": "ready",
        "localNodeId": session.local_node_id(),
        "localDeviceName": session.local_device_name(),
        "members": session.members().into_iter().map(|member| {
            json!({ "id": member.id, "name": member.name })
        }).collect::<Vec<_>>(),
    }));

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
        match execute(&session, &message) {
            Ok(result) => emit(json!({ "id": id, "ok": true, "result": result })),
            Err(error) => emit(json!({ "id": id, "ok": false, "error": error })),
        }
    }
    Ok(())
}
