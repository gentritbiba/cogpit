//! Frames the core sends. The server relays them to the terminal panel
//! unchanged, so their shape is the panel's protocol (`usePtySocket.ts`).

use axum::extract::ws::Utf8Bytes;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Outbound<'a> {
    Error { id: &'a Value, message: &'a str },
    Spawned { id: &'a str, name: &'a str },
    Output { id: &'a str, data: &'a str },
    Exit { id: &'a str, code: Option<i64> },
    Sessions { sessions: &'a [SessionInfo] },
}

impl Outbound<'_> {
    pub fn frame(&self) -> Utf8Bytes {
        serde_json::to_string(self)
            .expect("frames contain only strings, numbers and JSON values")
            .into()
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Exited,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub status: Status,
    pub exit_code: Option<i64>,
    pub created_at: u64,
    pub cwd: String,
    /// Whatever the spawning client sent, echoed back; absent when it sent none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_match_the_panel_protocol() {
        let id = Value::String(String::new());
        assert_eq!(
            Outbound::Error {
                id: &id,
                message: "Invalid JSON"
            }
            .frame()
            .as_str(),
            r#"{"type":"error","id":"","message":"Invalid JSON"}"#
        );
        assert_eq!(
            Outbound::Exit {
                id: "a",
                code: None
            }
            .frame()
            .as_str(),
            r#"{"type":"exit","id":"a","code":null}"#
        );
        let sessions = [SessionInfo {
            id: "a".into(),
            name: "Terminal 1".into(),
            status: Status::Running,
            exit_code: None,
            created_at: 5,
            cwd: "/".into(),
            metadata: None,
        }];
        assert_eq!(
            Outbound::Sessions {
                sessions: &sessions
            }
            .frame()
            .as_str(),
            r#"{"type":"sessions","sessions":[{"id":"a","name":"Terminal 1","status":"running","exitCode":null,"createdAt":5,"cwd":"/"}]}"#
        );
    }
}
