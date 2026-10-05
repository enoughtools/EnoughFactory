//! Control-mode protocol parser: line-oriented, `%`-prefixed notifications,
//! command replies framed by `%begin`/`%end`/`%error`. Unit-tested from
//! recorded transcripts; owns no I/O.

/// A parsed notification or reply from the control-mode stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    /// A complete command reply (begin/end or begin/error pair).
    Reply(Reply),
    /// `%output %<pane-id> <data>` — pane output, octal escapes decoded.
    Output { pane: String, data: Vec<u8> },
    /// `%window-add @<id>`
    WindowAdd { window: String },
    /// `%window-close @<id>` / `%unlinked-window-close @<id>`
    WindowClose { window: String },
    /// `%window-renamed @<id> <name>`
    WindowRenamed { window: String, name: String },
    /// `%session-changed $<id> <name>`
    SessionChanged { session: String, name: String },
    /// `%exit [reason]` — the control client is detaching.
    Exit { reason: Option<String> },
    /// `%layout-change`, `%sessions-changed`, and anything else we accept but
    /// do not act on.
    Other { line: String },
}

/// One framed command reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    /// Reply number from the `%begin` line (matches commands in send order).
    pub number: u64,
    pub body: String,
    pub error: bool,
}

#[derive(Debug, Default)]
enum State {
    #[default]
    Idle,
    /// Accumulating lines between `%begin` and `%end`/`%error`.
    InReply { number: u64, lines: Vec<String> },
}

/// Incremental parser: feed whole lines (without trailing newline), receive
/// zero or more events per line.
#[derive(Debug, Default)]
pub struct Parser {
    state: State,
}

fn decode_octal_escapes(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            // tmux emits exactly three octal digits after a backslash.
            if i + 4 <= bytes.len()
                && bytes[i + 1].is_ascii_digit()
                && bytes[i + 2].is_ascii_digit()
                && bytes[i + 3].is_ascii_digit()
            {
                let val = (u32::from(bytes[i + 1] - b'0') << 6)
                    | (u32::from(bytes[i + 2] - b'0') << 3)
                    | u32::from(bytes[i + 3] - b'0');
                #[allow(clippy::cast_possible_truncation)] // three octal digits max 0o777 < 512
                out.push((val & 0xFF) as u8);
                i += 4;
                continue;
            }
            // `\\` literal backslash.
            if i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                out.push(b'\\');
                i += 2;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

impl Parser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one line (no trailing `\n`). Returns the event it completes, if
    /// any (lines inside a reply frame accumulate silently).
    pub fn feed_line(&mut self, line: &str) -> Option<ControlEvent> {
        // Over a TTY exec the stream carries \r\n endings.
        let line = line.strip_suffix('\r').unwrap_or(line);
        // In -CC mode tmux wraps its output in a DCS sequence; the opener
        // (`ESC P 1000 p`) is glued to the first %begin. Strip it.
        let line = if let Some(rest) = line.strip_prefix('\u{1b}') {
            let after_dcs = rest
                .strip_prefix('P')
                .map(|r| r.trim_start_matches(|c: char| c.is_ascii_digit()))
                .and_then(|r| r.strip_prefix('p'));
            match after_dcs {
                Some(r) => r,
                None => {
                    return Some(ControlEvent::Other {
                        line: line.to_owned(),
                    });
                }
            }
        } else {
            line
        };
        // Inside a reply frame, only %end/%error terminate; everything else
        // (including lines starting with %) is body.
        if let State::InReply { number, lines } = &mut self.state {
            if let Some(rest) = line.strip_prefix("%end ") {
                let _ = rest;
                let reply = Reply {
                    number: *number,
                    body: lines.join("\n"),
                    error: false,
                };
                self.state = State::Idle;
                return Some(ControlEvent::Reply(reply));
            }
            if line.strip_prefix("%error").is_some() {
                let reply = Reply {
                    number: *number,
                    body: lines.join("\n"),
                    error: true,
                };
                self.state = State::Idle;
                return Some(ControlEvent::Reply(reply));
            }
            lines.push(line.to_owned());
            return None;
        }

        if let Some(rest) = line.strip_prefix("%begin ") {
            let number = rest
                .split_whitespace()
                .nth(1)
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            self.state = State::InReply {
                number,
                lines: Vec::new(),
            };
            return None;
        }
        if let Some(rest) = line.strip_prefix("%output ") {
            let (pane, data) = rest.split_once(' ').unwrap_or((rest, ""));
            return Some(ControlEvent::Output {
                pane: pane.to_owned(),
                data: decode_octal_escapes(data),
            });
        }
        if let Some(rest) = line.strip_prefix("%window-add ") {
            return Some(ControlEvent::WindowAdd {
                window: rest.trim().to_owned(),
            });
        }
        if let Some(rest) = line
            .strip_prefix("%window-close ")
            .or_else(|| line.strip_prefix("%unlinked-window-close "))
        {
            return Some(ControlEvent::WindowClose {
                window: rest.trim().to_owned(),
            });
        }
        if let Some(rest) = line.strip_prefix("%window-renamed ") {
            let (window, name) = rest.split_once(' ').unwrap_or((rest, ""));
            return Some(ControlEvent::WindowRenamed {
                window: window.to_owned(),
                name: name.to_owned(),
            });
        }
        if let Some(rest) = line.strip_prefix("%session-changed ") {
            let (session, name) = rest.split_once(' ').unwrap_or((rest, ""));
            return Some(ControlEvent::SessionChanged {
                session: session.to_owned(),
                name: name.to_owned(),
            });
        }
        if line == "%exit" {
            return Some(ControlEvent::Exit { reason: None });
        }
        if let Some(rest) = line.strip_prefix("%exit ") {
            return Some(ControlEvent::Exit {
                reason: Some(rest.to_owned()),
            });
        }
        if line.starts_with('%') {
            return Some(ControlEvent::Other {
                line: line.to_owned(),
            });
        }
        // Stray non-notification line outside a frame; surface, don't drop.
        Some(ControlEvent::Other {
            line: line.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded from `tmux -CC` against tmux 3.4.
    const TRANSCRIPT: &[&str] = &[
        "%begin 1700000000 3 1",
        "%end 1700000000 3 1",
        "%session-changed $0 envmux",
        "%begin 1700000001 4 1",
        "0: dev* (1 panes)",
        "1: migrate (1 panes)",
        "%end 1700000001 4 1",
        "%window-add @2",
        "%output %1 hello\\015\\012world",
        "%window-renamed @2 seed",
        "%begin 1700000002 5 1",
        "unknown command: frobnicate",
        "%error 1700000002 5 1",
        "%window-close @2",
        "%exit",
    ];

    #[test]
    fn transcript_parses() {
        let mut p = Parser::new();
        let events: Vec<_> = TRANSCRIPT.iter().filter_map(|l| p.feed_line(l)).collect();
        assert_eq!(
            events,
            vec![
                ControlEvent::Reply(Reply {
                    number: 3,
                    body: String::new(),
                    error: false
                }),
                ControlEvent::SessionChanged {
                    session: "$0".into(),
                    name: "envmux".into()
                },
                ControlEvent::Reply(Reply {
                    number: 4,
                    body: "0: dev* (1 panes)\n1: migrate (1 panes)".into(),
                    error: false
                }),
                ControlEvent::WindowAdd {
                    window: "@2".into()
                },
                ControlEvent::Output {
                    pane: "%1".into(),
                    data: b"hello\r\nworld".to_vec()
                },
                ControlEvent::WindowRenamed {
                    window: "@2".into(),
                    name: "seed".into()
                },
                ControlEvent::Reply(Reply {
                    number: 5,
                    body: "unknown command: frobnicate".into(),
                    error: true
                }),
                ControlEvent::WindowClose {
                    window: "@2".into()
                },
                ControlEvent::Exit { reason: None },
            ]
        );
    }

    #[test]
    fn octal_escapes_decode() {
        assert_eq!(decode_octal_escapes("a\\033[1mb"), b"a\x1b[1mb");
        assert_eq!(decode_octal_escapes("\\\\literal"), b"\\literal");
        assert_eq!(decode_octal_escapes("plain"), b"plain");
    }

    #[test]
    fn percent_lines_inside_reply_are_body() {
        let mut p = Parser::new();
        assert!(p.feed_line("%begin 1 7 1").is_none());
        assert!(p.feed_line("%output looks like a notification").is_none());
        let ev = p.feed_line("%end 1 7 1").unwrap();
        assert_eq!(
            ev,
            ControlEvent::Reply(Reply {
                number: 7,
                body: "%output looks like a notification".into(),
                error: false
            })
        );
    }
}
