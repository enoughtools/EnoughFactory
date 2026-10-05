//! Overlays: forms, confirmations, and help.
//!
//! Anything that creates or destroys goes through one of these. Not for
//! ceremony — for the pause. A single keystroke that reaps a workspace is a
//! keystroke away from being pressed by accident, and the shadow snapshot is
//! the only thing standing between that and lost work.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph, Wrap};

use super::chrome;
use super::theme;

/// One editable line in a form.
#[derive(Debug, Clone)]
pub struct Field {
    pub label: &'static str,
    pub value: String,
    pub hint: &'static str,
}

impl Field {
    fn new(label: &'static str, hint: &'static str) -> Self {
        Self {
            label,
            value: String::new(),
            hint,
        }
    }
}

/// What is currently covering the screen.
pub enum Modal {
    /// Create a workspace. Both fields optional — the daemon generates a name
    /// and uses the namespace default branch when they are blank.
    NewWorkspace {
        fields: Vec<Field>,
        cursor: usize,
    },
    /// Create an ad-hoc tmux window inside a workspace and attach to it.
    NewSession {
        workspace: String,
        fields: Vec<Field>,
        cursor: usize,
    },
    /// Shadow snapshots for one workspace, newest first, with the option to
    /// start a fresh workspace from any of them.
    History {
        workspace: String,
        captures: Vec<envmux_api_types::CaptureSummary>,
        cursor: usize,
    },
    /// Browse the filesystem for a repository to register as a namespace.
    PickDirectory {
        current: std::path::PathBuf,
        entries: Vec<Entry>,
        cursor: usize,
    },
    /// A destructive action awaiting a deliberate `y`.
    Confirm {
        prompt: String,
        detail: String,
        action: ConfirmAction,
    },
    Help,
}

#[derive(Debug, Clone)]
pub enum ConfirmAction {
    Reap { id: String, name: String },
    Install,
}

/// One row in the directory picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// Register the directory currently being browsed. Always first, so
    /// choosing a directory never needs a second key to mean "this one".
    UseThis,
    /// Go up. Absent at a filesystem root.
    Parent,
    /// A subdirectory, flagged when it looks like something envmux can take.
    Directory {
        name: String,
        repo: bool,
        declared: bool,
    },
}

/// Read a directory into picker rows.
///
/// Unreadable entries are skipped rather than reported: a home directory with
/// one permission-denied subfolder should still be browsable, and the error
/// that matters is the one from registering, not from listing.
#[must_use]
pub fn read_entries(dir: &std::path::Path) -> Vec<Entry> {
    let mut entries = vec![Entry::UseThis];
    if dir.parent().is_some() {
        entries.push(Entry::Parent);
    }

    let mut directories: Vec<Entry> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Dotfiles are noise here; `.git` is the one thing being looked
            // for and it is reported as a flag rather than browsed into.
            if name.starts_with('.') {
                return None;
            }
            let path = entry.path();
            Some(Entry::Directory {
                repo: path.join(".git").exists(),
                declared: path.join(envmux_config::CONFIG_FILE).exists(),
                name,
            })
        })
        .collect();
    directories.sort_by(|a, b| match (a, b) {
        (Entry::Directory { name: a, .. }, Entry::Directory { name: b, .. }) => {
            a.to_lowercase().cmp(&b.to_lowercase())
        }
        _ => std::cmp::Ordering::Equal,
    });
    entries.append(&mut directories);
    entries
}

impl Modal {
    #[must_use]
    pub fn new_workspace() -> Self {
        Self::NewWorkspace {
            fields: vec![
                Field::new("name", "blank generates one"),
                Field::new("branch", "blank uses the namespace default"),
            ],
            cursor: 0,
        }
    }

    #[must_use]
    pub fn new_session(workspace: String) -> Self {
        Self::NewSession {
            workspace,
            fields: vec![
                Field::new("session", "a tmux window name"),
                Field::new("command", "blank opens a login shell"),
            ],
            cursor: 0,
        }
    }

    /// Feed a character to the focused field.
    pub fn type_char(&mut self, ch: char) {
        if let Some((fields, cursor)) = self.fields_mut() {
            fields[*cursor].value.push(ch);
        }
    }

    pub fn backspace(&mut self) {
        if let Some((fields, cursor)) = self.fields_mut() {
            fields[*cursor].value.pop();
        }
    }

    pub fn next_field(&mut self) {
        if let Some((fields, cursor)) = self.fields_mut() {
            *cursor = (*cursor + 1) % fields.len();
        }
    }

    pub fn previous_field(&mut self) {
        if let Some((fields, cursor)) = self.fields_mut() {
            *cursor = (*cursor + fields.len() - 1) % fields.len();
        }
    }

    fn fields_mut(&mut self) -> Option<(&mut Vec<Field>, &mut usize)> {
        match self {
            Self::NewWorkspace { fields, cursor } | Self::NewSession { fields, cursor, .. } => {
                Some((fields, cursor))
            }
            _ => None,
        }
    }

    /// Browse from `start`, or the current directory when it is unreadable.
    #[must_use]
    pub fn pick_directory(start: std::path::PathBuf) -> Self {
        Self::PickDirectory {
            entries: read_entries(&start),
            current: start,
            cursor: 0,
        }
    }

    /// Descend into the highlighted subdirectory, or go up.
    ///
    /// Returns the directory to register when the highlighted row is "use
    /// this", which is the only way out of the picker other than cancelling.
    pub fn descend(&mut self) -> Option<std::path::PathBuf> {
        let Self::PickDirectory {
            current,
            entries,
            cursor,
        } = self
        else {
            return None;
        };
        match entries.get(*cursor) {
            Some(Entry::UseThis) => return Some(current.clone()),
            Some(Entry::Parent) => {
                if let Some(parent) = current.parent() {
                    *current = parent.to_path_buf();
                }
            }
            Some(Entry::Directory { name, .. }) => *current = current.join(name),
            None => return None,
        }
        *entries = read_entries(current);
        // Back to the top: the row that was under the cursor has nothing to do
        // with the row at the same index in a different directory.
        *cursor = 0;
        None
    }

    /// Go up one level regardless of what is highlighted.
    pub fn ascend(&mut self) {
        let Self::PickDirectory {
            current,
            entries,
            cursor,
        } = self
        else {
            return;
        };
        if let Some(parent) = current.parent() {
            *current = parent.to_path_buf();
            *entries = read_entries(current);
            *cursor = 0;
        }
    }

    /// Move the selection in a list-shaped overlay.
    pub fn move_cursor(&mut self, delta: isize) {
        let (len, cursor) = match self {
            Self::History {
                captures, cursor, ..
            } => (captures.len(), cursor),
            Self::PickDirectory {
                entries, cursor, ..
            } => (entries.len(), cursor),
            _ => return,
        };
        if len == 0 {
            return;
        }
        let next = if delta.is_negative() {
            cursor.saturating_sub(delta.unsigned_abs())
        } else {
            cursor.saturating_add(usize::try_from(delta).unwrap_or(0))
        };
        *cursor = next.min(len - 1);
    }

    /// The capture under the cursor, if this is a history overlay.
    #[must_use]
    pub fn selected_capture(&self) -> Option<&envmux_api_types::CaptureSummary> {
        match self {
            Self::History {
                captures, cursor, ..
            } => captures.get(*cursor),
            _ => None,
        }
    }

    /// A field's value, trimmed, or `None` when blank.
    #[must_use]
    pub fn field(&self, index: usize) -> Option<String> {
        let (Self::NewWorkspace { fields, .. } | Self::NewSession { fields, .. }) = self else {
            return None;
        };
        fields
            .get(index)
            .map(|f| f.value.trim().to_owned())
            .filter(|v| !v.is_empty())
    }
}

/// Centre a box of the given size inside `area`, clamped so it always fits.
#[must_use]
pub fn centred(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    }
}

pub fn render(
    frame: &mut Frame,
    area: Rect,
    modal: &Modal,
    tick: u64,
    onboarding: Option<Onboarding>,
) {
    match modal {
        Modal::NewWorkspace { fields, cursor } => {
            form(
                frame,
                area,
                "spin up a workspace",
                fields,
                *cursor,
                tick,
                &[
                    "A fresh clone, its own container, its own tmux session.",
                    "Both fields are optional.",
                ],
            );
        }
        Modal::NewSession {
            workspace,
            fields,
            cursor,
        } => {
            form(
                frame,
                area,
                &format!("ad-hoc session in {workspace}"),
                fields,
                *cursor,
                tick,
                &[
                    "A new tmux window alongside the declared tasks —",
                    "yours, not the config's. Attaches when it exists.",
                ],
            );
        }
        Modal::History {
            workspace,
            captures,
            cursor,
        } => history(frame, area, workspace, captures, *cursor),
        Modal::PickDirectory {
            current,
            entries,
            cursor,
        } => pick_directory(frame, area, current, entries, *cursor),
        Modal::Confirm {
            prompt,
            detail,
            action: _,
        } => confirm(frame, area, prompt, detail),
        Modal::Help => help(frame, area, onboarding),
    }
}

/// Browse for a project directory.
///
/// A path field would be fewer lines, but "type the absolute path of your
/// repository" is a poor first instruction, and it cannot show which
/// directories are actually repositories. Browsing can.
fn pick_directory(
    frame: &mut Frame,
    area: Rect,
    current: &std::path::Path,
    entries: &[Entry],
    cursor: usize,
) {
    // Sized to the listing, capped: a directory with two children should not
    // open a box with eighteen blank rows in it.
    let wanted = u16::try_from(entries.len())
        .unwrap_or(u16::MAX)
        .saturating_add(7);
    let rect = centred(area, 74, wanted.clamp(10, 24));
    frame.render_widget(Clear, rect);
    frame.render_widget(chrome::block("open a project", true), rect);
    let inner = rect.inner(ratatui::layout::Margin::new(2, 1));
    if inner.height < 4 {
        return;
    }

    let mut lines = vec![
        Line::from(Span::styled(
            // The tail is the informative end of a long path.
            super::shorten(&current.display().to_string(), usize::from(inner.width)),
            Style::default()
                .fg(theme::CYAN)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    // Three rows held back: the path, the blank under it, and the key hint.
    let rows = usize::from(inner.height).saturating_sub(4);
    let first = cursor.saturating_sub(rows.saturating_sub(1));
    for (index, entry) in entries.iter().enumerate().skip(first).take(rows) {
        let selected = index == cursor;
        let mark = Span::styled(
            if selected { "▶ " } else { "  " },
            Style::default().fg(theme::NEON),
        );
        lines.push(match entry {
            Entry::UseThis => Line::from(vec![
                mark,
                Span::styled(
                    "use this directory",
                    Style::default()
                        .fg(theme::ACID)
                        .add_modifier(Modifier::BOLD),
                ),
            ]),
            Entry::Parent => Line::from(vec![
                mark,
                Span::styled("..", Style::default().fg(theme::TEXT)),
            ]),
            Entry::Directory {
                name,
                repo,
                declared,
            } => Line::from(vec![
                mark,
                Span::styled(
                    format!("{name}/"),
                    Style::default().fg(if *repo { theme::TEXT } else { theme::DIM }),
                ),
                // Flagged rather than filtered: a repository that has not been
                // declared yet is still one you might want, and hiding the
                // rest would make an empty-looking directory a mystery.
                Span::styled(
                    if *declared {
                        "  .envmux.toml"
                    } else if *repo {
                        "  git"
                    } else {
                        ""
                    },
                    Style::default().fg(if *declared { theme::ACID } else { theme::DIM }),
                ),
            ]),
        });
    }

    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("enter", theme::key()),
        Span::styled(" open   ", theme::faint()),
        Span::styled("←", theme::key()),
        Span::styled(" up   ", theme::faint()),
        Span::styled("esc", theme::key()),
        Span::styled(" cancel", theme::faint()),
    ]));

    frame.render_widget(Paragraph::new(lines).style(theme::base()), inner);
}

/// The shadow history for one workspace.
///
/// This is the safety net made visible. Every capture is a real commit in the
/// shadow origin, including the final one the reaper takes, so a workspace
/// that is long gone is still somewhere you can start from.
fn history(
    frame: &mut Frame,
    area: Rect,
    workspace: &str,
    captures: &[envmux_api_types::CaptureSummary],
    cursor: usize,
) {
    // Sized to its contents up to a cap, rather than a fixed box that is
    // mostly empty for the common case of two or three snapshots.
    let wanted = u16::try_from(captures.len())
        .unwrap_or(u16::MAX)
        .saturating_add(6);
    let rect = centred(area, 76, wanted.clamp(9, 24));
    frame.render_widget(Clear, rect);
    frame.render_widget(
        chrome::block(&format!("shadow history — {workspace}"), true),
        rect,
    );
    let inner = rect.inner(ratatui::layout::Margin::new(2, 1));

    if captures.is_empty() {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled("No snapshots yet.".to_owned(), theme::faint())),
                Line::from(""),
                Line::from(Span::styled(
                    "Captures run on a timer and once more when the reaper takes \
                     the workspace. Press c to take one now."
                        .to_owned(),
                    theme::faint(),
                )),
            ])
            .wrap(Wrap { trim: true })
            .style(theme::base()),
            inner,
        );
        return;
    }

    // Room for the list plus the key hint at the bottom.
    let rows = usize::from(inner.height).saturating_sub(2);
    // Scroll so the cursor stays on screen without a scrollbar to maintain.
    let first = cursor.saturating_sub(rows.saturating_sub(1));

    let mut lines: Vec<Line> = captures
        .iter()
        .enumerate()
        .skip(first)
        .take(rows)
        .map(|(index, capture)| {
            let selected = index == cursor;
            let oid: String = capture.commit_oid.chars().take(10).collect();
            Line::from(vec![
                Span::styled(
                    if selected { "▶ " } else { "  " },
                    Style::default().fg(theme::NEON),
                ),
                Span::styled(
                    format!("{:<10} ", crate::output::age(&capture.captured_at.clone())),
                    Style::default().fg(if selected { theme::CYAN } else { theme::TEXT }),
                ),
                Span::styled(format!("{oid} "), theme::faint()),
                Span::styled(
                    capture.branch.clone().unwrap_or_else(|| "—".to_owned()),
                    Style::default().fg(theme::TEXT),
                ),
                // A torn snapshot caught the tree mid-write. Still restorable,
                // but you want to know before you trust it.
                Span::styled(
                    if capture.torn { "  torn" } else { "" },
                    Style::default()
                        .fg(theme::AMBER)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    capture
                        .flagged_state
                        .as_ref()
                        .map_or_else(String::new, |f| format!("  {f}")),
                    Style::default().fg(theme::AMBER),
                ),
            ])
        })
        .collect();

    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("enter", theme::key()),
        Span::styled(" new workspace from this snapshot   ", theme::faint()),
        Span::styled("esc", theme::key()),
        Span::styled(" close", theme::faint()),
    ]));

    frame.render_widget(Paragraph::new(lines).style(theme::base()), inner);
}

#[allow(clippy::too_many_arguments)]
fn form(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    fields: &[Field],
    cursor: usize,
    tick: u64,
    blurb: &[&str],
) {
    let height = 6 + u16::try_from(fields.len() * 2 + blurb.len()).unwrap_or(6);
    let rect = centred(area, 64, height);
    frame.render_widget(Clear, rect);
    frame.render_widget(chrome::block(title, true), rect);

    let inner = rect.inner(ratatui::layout::Margin::new(2, 1));
    let mut lines: Vec<Line> = blurb
        .iter()
        .map(|text| Line::from(Span::styled((*text).to_owned(), theme::faint())))
        .collect();
    lines.push(Line::from(""));

    for (index, field) in fields.iter().enumerate() {
        let active = index == cursor;
        lines.push(Line::from(vec![
            Span::styled(
                format!("{:>9} ", field.label),
                Style::default().fg(if active { theme::CYAN } else { theme::DIM }),
            ),
            Span::styled(
                if active { "▶ " } else { "  " },
                Style::default().fg(theme::NEON),
            ),
            Span::styled(
                field.value.clone(),
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
            // A block cursor that blinks on its own, rather than relying on
            // the terminal's — the real one is parked elsewhere.
            Span::styled(
                if active && tick % 8 < 4 { "█" } else { " " },
                Style::default().fg(theme::ACID),
            ),
            Span::styled(
                if field.value.is_empty() && !active {
                    format!("  {}", field.hint)
                } else {
                    String::new()
                },
                theme::faint(),
            ),
        ]));
        lines.push(Line::from(""));
    }

    lines.push(Line::from(vec![
        Span::styled("enter", theme::key()),
        Span::styled(" go   ", theme::faint()),
        Span::styled("tab", theme::key()),
        Span::styled(" field   ", theme::faint()),
        Span::styled("esc", theme::key()),
        Span::styled(" abort", theme::faint()),
    ]));

    frame.render_widget(Paragraph::new(lines).style(theme::base()), inner);
}

fn confirm(frame: &mut Frame, area: Rect, prompt: &str, detail: &str) {
    let rect = centred(area, 62, 9);
    frame.render_widget(Clear, rect);
    frame.render_widget(chrome::block("confirm", true), rect);
    let inner = rect.inner(ratatui::layout::Margin::new(2, 1));

    let lines = vec![
        Line::from(Span::styled(
            prompt.to_owned(),
            Style::default()
                .fg(theme::BLOOD)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(Span::styled(detail.to_owned(), theme::faint())),
        Line::from(""),
        Line::from(vec![
            Span::styled("y", theme::key()),
            Span::styled(" do it   ", theme::faint()),
            Span::styled("n", theme::key()),
            Span::styled("/", theme::faint()),
            Span::styled("esc", theme::key()),
            Span::styled(" back out", theme::faint()),
        ]),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: true })
            .style(theme::base()),
        inner,
    );
}

/// Every binding, in one place. A TUI whose keys are undiscoverable is a TUI
/// with three usable keys.
const BINDINGS: &[(&str, &str)] = &[
    ("↑ ↓ / j k", "move within a pane"),
    ("tab / shift-tab", "cycle panes"),
    ("1 2 3", "jump to namespaces / workspaces / telemetry"),
    ("", ""),
    ("o", "open a project directory"),
    ("n", "new workspace"),
    ("s", "new ad-hoc session in this workspace"),
    ("a", "attach read-write (extends the lease)"),
    ("v", "attach read-only (does not extend it)"),
    ("g", "go to VS Code, attached into the container"),
    ("", ""),
    ("h", "shadow history, and revive from a snapshot"),
    ("c", "capture a shadow snapshot now"),
    ("p", "pin / unpin the lease"),
    ("e", "extend the lease by an hour"),
    ("f", "fetch the namespace mirror"),
    ("x", "reap this workspace"),
    ("", ""),
    ("u", "start a daemon, if there is none"),
    (
        "I",
        "install envmux: copy it somewhere permanent, add it to PATH",
    ),
    ("r", "refresh now"),
    ("?", "this"),
    ("q", "quit"),
];

/// How far along someone is, when they have nothing running yet.
///
/// A key list assumes you already know what the keys are *for*. Someone whose
/// first act is pressing `?` on an empty screen needs the next step, not an
/// index — so the help screen leads with it and the bindings follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
pub enum Onboarding {
    /// Nothing is listening. Everything else is downstream of this.
    NoDaemon,
    /// A daemon, but no project registered with it.
    NoNamespace,
    /// A project, but nothing built from it yet.
    NoWorkspace,
}

impl Onboarding {
    /// The keys this stage tells someone to press.
    ///
    /// Exposed so a test can check them against the real key list: a step
    /// naming a key that does nothing is worse than no guidance at all.
    #[must_use]
    #[cfg(test)]
    pub fn keys(self) -> Vec<&'static str> {
        self.script().1.iter().map(|(key, _)| *key).collect()
    }

    /// The heading, and the numbered steps under it.
    #[must_use]
    fn script(self) -> (&'static str, &'static [(&'static str, &'static str)]) {
        match self {
            Self::NoDaemon => (
                "Nothing is running yet.",
                &[
                    ("u", "start a daemon — it lives in this same binary"),
                    ("o", "then open a project directory"),
                    ("n", "then create your first workspace"),
                ],
            ),
            Self::NoNamespace => (
                "A daemon is up. It does not know about any projects yet.",
                &[
                    ("o", "open a project directory — a git repository is ideal"),
                    ("n", "then create a workspace in it"),
                ],
            ),
            Self::NoWorkspace => (
                "This project is registered. Nothing has been built from it yet.",
                &[
                    ("n", "create a workspace: its own container and checkout"),
                    ("a", "attach to it once it is ready"),
                    ("s", "or open an ad-hoc shell session inside it"),
                ],
            ),
        }
    }
}

fn help(frame: &mut Frame, area: Rect, onboarding: Option<Onboarding>) {
    let extra = onboarding.map_or(0, |o| o.script().1.len() + 3);
    let height = u16::try_from(BINDINGS.len() + extra).unwrap_or(20) + 4;
    // Sized from the longest line rather than a guess, so adding one can never
    // silently truncate it.
    let widest = BINDINGS
        .iter()
        .map(|(_, description)| description.chars().count())
        .chain(
            onboarding
                .iter()
                .flat_map(|o| o.script().1.iter().map(|(_, step)| step.chars().count())),
        )
        .chain(onboarding.iter().map(|o| o.script().0.chars().count() - 16))
        .max()
        .unwrap_or(40);
    let width = u16::try_from(widest + 22).unwrap_or(64);
    let rect = centred(area, width, height);
    frame.render_widget(Clear, rect);
    frame.render_widget(
        chrome::block(
            if onboarding.is_some() {
                "start here"
            } else {
                "keys"
            },
            true,
        ),
        rect,
    );
    let inner = rect.inner(ratatui::layout::Margin::new(2, 1));

    let binding = |keys: &str, description: &str| {
        Line::from(vec![
            Span::styled(format!("{keys:>16}  "), theme::key()),
            Span::styled(description.to_owned(), Style::default().fg(theme::TEXT)),
        ])
    };

    let mut lines = Vec::new();
    if let Some(onboarding) = onboarding {
        let (heading, steps) = onboarding.script();
        lines.push(Line::from(Span::styled(
            heading.to_owned(),
            Style::default()
                .fg(theme::CYAN)
                .add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(""));
        for (key, step) in steps {
            lines.push(binding(key, step));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "─".repeat(usize::from(inner.width)),
            theme::faint(),
        )));
    }

    lines.extend(BINDINGS.iter().map(|(keys, description)| {
        if keys.is_empty() {
            Line::from("")
        } else {
            binding(keys, description)
        }
    }));
    frame.render_widget(Paragraph::new(lines).style(theme::base()), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_centred_box_always_fits_inside_its_area() {
        let area = Rect::new(0, 0, 20, 6);
        // Asking for more than there is must clamp, not overflow the buffer —
        // ratatui panics on out-of-bounds rects.
        let rect = centred(area, 100, 100);
        assert!(rect.right() <= area.right() && rect.bottom() <= area.bottom());
        assert_eq!((rect.width, rect.height), (20, 6));

        let small = centred(area, 10, 2);
        assert_eq!((small.x, small.y), (5, 2));
    }

    #[test]
    fn typing_lands_in_the_focused_field_only() {
        let mut modal = Modal::new_workspace();
        for ch in "otter".chars() {
            modal.type_char(ch);
        }
        modal.next_field();
        for ch in "main".chars() {
            modal.type_char(ch);
        }
        assert_eq!(modal.field(0).as_deref(), Some("otter"));
        assert_eq!(modal.field(1).as_deref(), Some("main"));
    }

    #[test]
    fn blank_fields_read_as_absent_rather_than_empty_strings() {
        // The daemon treats absent as "generate one" and empty as a name, so
        // whitespace must not become a workspace called "  ".
        let mut modal = Modal::new_workspace();
        for ch in "   ".chars() {
            modal.type_char(ch);
        }
        assert_eq!(modal.field(0), None);

        modal.backspace();
        modal.backspace();
        modal.backspace();
        modal.backspace();
        assert_eq!(modal.field(0), None);
    }

    #[test]
    fn field_navigation_wraps_in_both_directions() {
        let mut modal = Modal::new_workspace();
        modal.previous_field();
        modal.type_char('z');
        // Wrapping backwards from the first field lands on the last.
        assert_eq!(modal.field(1).as_deref(), Some("z"));
    }

    #[test]
    fn modals_without_fields_ignore_typing_instead_of_panicking() {
        let mut modal = Modal::Help;
        modal.type_char('x');
        modal.backspace();
        modal.next_field();
        assert!(modal.field(0).is_none());
    }
}
