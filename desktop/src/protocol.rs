//! The line-delimited JSON spoken with the server sidecar. The TypeScript side
//! and the contract's documentation live in `shared/desktopProtocol.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationNav {
    pub session_id: Option<String>,
    pub dir_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notify {
    pub title: String,
    pub body: String,
    pub nav: NotificationNav,
    pub history_id: Option<String>,
    pub path: Option<String>,
}

/// What the server writes to its stdout.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    Ready { port: u16 },
    Error { error: String },
    Notify(Notify),
}

/// What the shell writes to the server's stdin.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ShellMessage {
    DesktopPresence {
        has_window: bool,
        locked: bool,
        idle_seconds: f64,
    },
    NotificationClicked {
        history_id: String,
    },
    Shutdown,
}

/// A stdout line, or None for anything that is not a message (a stray log line).
pub fn parse_server_line(line: &str) -> Option<ServerMessage> {
    serde_json::from_str(line).ok()
}

pub fn encode_shell_message(message: &ShellMessage) -> String {
    let mut line = serde_json::to_string(message).expect("shell messages always serialize");
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_server_messages() {
        assert_eq!(
            parse_server_line(r#"{"type":"ready","port":51234}"#),
            Some(ServerMessage::Ready { port: 51234 })
        );
        assert_eq!(
            parse_server_line(r#"{"type":"error","error":"boom"}"#),
            Some(ServerMessage::Error {
                error: "boom".into()
            })
        );
        assert_eq!(
            parse_server_line(
                r#"{"type":"notify","title":"t","body":"b","nav":{"sessionId":"s","dirName":"d"},"historyId":"h","path":"/d/s"}"#
            ),
            Some(ServerMessage::Notify(Notify {
                title: "t".into(),
                body: "b".into(),
                nav: NotificationNav {
                    session_id: Some("s".into()),
                    dir_name: Some("d".into())
                },
                history_id: Some("h".into()),
                path: Some("/d/s".into()),
            }))
        );
    }

    #[test]
    fn accepts_a_notification_without_history_or_session() {
        let message = parse_server_line(
            r#"{"type":"notify","title":"t","body":"b","nav":{"sessionId":null,"dirName":null},"path":null}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::Notify(Notify {
                history_id: None,
                path: None,
                ..
            }))
        ));
    }

    #[test]
    fn ignores_lines_that_are_not_messages() {
        assert_eq!(parse_server_line("[server] listening"), None);
        assert_eq!(parse_server_line(r#"{"type":"something-new"}"#), None);
        assert_eq!(parse_server_line(r#"{"type":"ready","port":"x"}"#), None);
    }

    #[test]
    fn encodes_shell_messages_as_the_server_parses_them() {
        assert_eq!(
            encode_shell_message(&ShellMessage::DesktopPresence {
                has_window: true,
                locked: false,
                idle_seconds: 3.5
            }),
            "{\"type\":\"desktop-presence\",\"hasWindow\":true,\"locked\":false,\"idleSeconds\":3.5}\n"
        );
        assert_eq!(
            encode_shell_message(&ShellMessage::NotificationClicked {
                history_id: "h1".into()
            }),
            "{\"type\":\"notification-clicked\",\"historyId\":\"h1\"}\n"
        );
        assert_eq!(
            encode_shell_message(&ShellMessage::Shutdown),
            "{\"type\":\"shutdown\"}\n"
        );
    }
}
