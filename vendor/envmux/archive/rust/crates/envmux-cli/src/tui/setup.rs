//! First run: choosing what this repository's environment should be.
//!
//! The old version of this was a line of text on a cooked terminal —
//! "set this directory up for envmux? [Y/n]" — and one answer, which wrote a
//! seed that ran nothing. It asked the only question it could ask, because it
//! had no idea what the repository was.
//!
//! Now it does. [`envmux_config::detect`] reads the repository's own files,
//! [`envmux_config::preset`] turns that into a small, complete configuration,
//! and this screen shows you the list, what was detected, and the **exact file
//! it will write** before it writes anything. Choosing is one keystroke and
//! backing out is another, because the thing on the other side of this screen
//! is a commit in someone's repository.
//!
//! Nothing here is remembered. The preset is a starting point, not a mode: the
//! file is ordinary TOML the moment it lands, and there is nothing that
//! regenerates it or minds it being edited.

use std::path::{Path, PathBuf};

use anyhow::Context as _;
use envmux_config::preset::{Plan, PresetId};
use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, Paragraph, Wrap};

use super::{App, chrome, theme};

/// The picker's state.
pub struct Setup {
    pub root: PathBuf,
    detected: envmux_config::Detected,
    cursor: usize,
    /// The file the current choice would write, rendered up front so the pane
    /// is showing the thing itself rather than a description of it.
    preview: String,
    scroll: usize,
}

impl Setup {
    /// Look at `root` and open on whatever it looks like.
    pub fn new(root: PathBuf) -> Self {
        let detected = envmux_config::detect(&root);
        let recommended = envmux_config::recommended(&detected);
        // Pre-selected, not re-ordered. The list stays where it was last time
        // so that picking `rust` from the middle keeps working, and the
        // recommendation earns its place with a mark rather than by shuffling
        // everything else.
        let cursor = envmux_config::catalogue()
            .iter()
            .position(|preset| preset.id == recommended)
            .unwrap_or(0);
        let mut setup = Self {
            root,
            detected,
            cursor,
            preview: String::new(),
            scroll: 0,
        };
        setup.repreview();
        setup
    }

    /// Whether `root` needs this at all.
    pub fn needed(root: &Path) -> bool {
        !root.join(envmux_config::CONFIG_FILE).exists()
            && !root.join(envmux_config::LOCAL_CONFIG_FILE).exists()
    }

    pub fn preset(&self) -> PresetId {
        envmux_config::catalogue()
            .get(self.cursor)
            .map_or(PresetId::Minimal, |preset| preset.id)
    }

    pub fn plan(&self) -> Plan {
        // No namespace: absent means "implied from the repository name", which
        // is right far more often than a name derived from a directory that
        // may have been cloned somewhere odd.
        Plan::new(self.preset(), &self.detected, None)
    }

    fn repreview(&mut self) {
        self.preview = self.plan().render();
        self.scroll = 0;
    }

    pub fn move_cursor(&mut self, delta: isize) {
        let len = isize::try_from(envmux_config::catalogue().len()).unwrap_or(1);
        if len == 0 {
            return;
        }
        let cursor = isize::try_from(self.cursor).unwrap_or(0);
        self.cursor = usize::try_from((cursor + delta).rem_euclid(len)).unwrap_or(0);
        self.repreview();
    }

    pub fn scroll_preview(&mut self, delta: isize) {
        let lines = self.preview.lines().count().saturating_sub(1);
        let scroll = isize::try_from(self.scroll).unwrap_or(0);
        self.scroll = usize::try_from(scroll + delta).unwrap_or(0).min(lines);
    }

    /// Write the file, and everything that has to exist beside it.
    ///
    /// Refuses to overwrite: this screen only opens when there is no config,
    /// but the gap between opening it and pressing enter is long enough for
    /// another terminal to have written one, and clobbering somebody's
    /// configuration is not a thing to do on a race.
    pub fn write(&self) -> anyhow::Result<PathBuf> {
        let path = self.root.join(envmux_config::CONFIG_FILE);
        anyhow::ensure!(
            !path.exists(),
            "{} already exists — nothing was written",
            path.display()
        );
        std::fs::write(&path, self.plan().render())
            .with_context(|| format!("writing {}", path.display()))?;
        crate::onboard::ensure_project_dir(&self.root)?;
        Ok(path)
    }

    /// One line summarising what detection found, for the header.
    fn findings(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(stack) = self.detected.primary() {
            parts.push(stack.label().to_owned());
        }
        if let Some(manager) = self.detected.package_manager {
            parts.push(manager.label().to_owned());
        }
        if let Some(dockerfile) = &self.detected.dockerfile {
            parts.push(dockerfile.clone());
        }
        for hint in &self.detected.ports {
            parts.push(format!("{} ({})", hint.port, hint.source));
        }
        if parts.is_empty() {
            "nothing recognisable — minimal is the honest answer".to_owned()
        } else {
            parts.join(" · ")
        }
    }
}

/// The whole screen.
pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let Some(setup) = &app.setup else {
        return;
    };

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            // Four rows inside: the folder, what was detected, and an
            // explanation with room to wrap on a narrow terminal.
            Constraint::Length(6), // what and where
            Constraint::Min(0),    // list | preview
            Constraint::Length(1), // keys
        ])
        .split(area);

    header(frame, rows[0], setup);

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(26), Constraint::Min(0)])
        .split(rows[1]);
    catalogue_pane(frame, columns[0], setup, app);
    preview_pane(frame, columns[1], setup);

    // The shared footer, so a refusal to write ("that file already exists")
    // lands in the same row as every other outcome in the program.
    super::footer(frame, rows[2], app);
}

fn header(frame: &mut Frame, area: Rect, setup: &Setup) {
    let block = chrome::block("set up this repository", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 {
        return;
    }
    // What was found comes second, directly under the folder it was found in,
    // because it is the line that decides whether the recommendation below is
    // worth taking. The explanation is last: it says the same thing every
    // time, and is the row that can afford to wrap.
    let lines = vec![
        Line::from(Span::styled(
            super::shorten(&setup.root.display().to_string(), inner.width as usize),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(vec![
            Span::styled("detected  ", theme::faint()),
            Span::styled(setup.findings(), Style::default().fg(theme::CYAN)),
        ]),
        Line::from(Span::styled(
            format!(
                "no {} here yet. pick a starting point — it lands in your repository as ordinary toml.",
                envmux_config::CONFIG_FILE
            ),
            theme::faint(),
        )),
        // What the highlighted choice actually does. It lives here rather
        // than in the list because the list column is narrow enough to
        // truncate a sentence, and a summary cut off mid-word explains less
        // than no summary at all.
        Line::from(vec![
            Span::styled("▶ ", Style::default().fg(theme::NEON)),
            Span::styled(
                envmux_config::catalogue()
                    .get(setup.cursor)
                    .map_or(String::new(), |preset| preset.summary.to_owned()),
                Style::default().fg(theme::TEXT),
            ),
        ]),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(theme::base()),
        inner,
    );
}

fn catalogue_pane(frame: &mut Frame, area: Rect, setup: &Setup, app: &App) {
    let recommended = envmux_config::recommended(&setup.detected);
    let items: Vec<ListItem> = envmux_config::catalogue()
        .iter()
        .enumerate()
        .map(|(row, preset)| {
            let selected = row == setup.cursor;
            let mut spans = vec![
                Span::styled(
                    if selected { "▶ " } else { "  " },
                    Style::default().fg(theme::NEON),
                ),
                Span::styled(
                    format!("{:<10}", preset.label),
                    Style::default()
                        .fg(if selected { theme::CYAN } else { theme::TEXT })
                        .add_modifier(if selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                ),
            ];
            if preset.id == recommended {
                // Earns its place with a mark rather than by being moved to
                // the top and shuffling everything else under it.
                spans.push(Span::styled(
                    "detected",
                    Style::default()
                        .fg(theme::ACID)
                        .add_modifier(Modifier::BOLD),
                ));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();

    let _ = app;
    frame.render_widget(
        List::new(items).block(chrome::block("starting points", true)),
        area,
    );
}

/// The file itself, before it exists.
fn preview_pane(frame: &mut Frame, area: Rect, setup: &Setup) {
    let title = if setup.scroll > 0 {
        format!("{} ↑", envmux_config::CONFIG_FILE)
    } else {
        envmux_config::CONFIG_FILE.to_owned()
    };
    let lines: Vec<Line> = setup
        .preview
        .lines()
        .skip(setup.scroll)
        .map(|line| {
            // Comments are the explanation and the keys are the file; colour
            // says which is which without anyone having to read both.
            let style = if line.trim_start().starts_with('#') {
                theme::faint()
            } else if line.starts_with('[') {
                Style::default()
                    .fg(theme::NEON)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            Line::from(Span::styled(line.to_owned(), style))
        })
        .collect();
    frame.render_widget(
        Paragraph::new(lines)
            .block(chrome::block(&title, false))
            .style(theme::base()),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("envmux-setup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_configured_repository_needs_no_setup() {
        let root = scratch("configured");
        assert!(Setup::needed(&root), "an empty directory needs setting up");
        std::fs::write(root.join(envmux_config::CONFIG_FILE), "schema = 2\n").unwrap();
        assert!(!Setup::needed(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_local_override_also_counts_as_configured() {
        // `.envmux.local.toml` *is* the configuration while it exists, so a
        // repository carrying only one is set up — offering to write a
        // committed file over the top would be offering to change which file
        // is in force.
        let root = scratch("local");
        std::fs::write(root.join(envmux_config::LOCAL_CONFIG_FILE), "schema = 2\n").unwrap();
        assert!(!Setup::needed(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn it_opens_on_what_the_repository_looks_like() {
        let root = scratch("opens");
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}"#,
        )
        .unwrap();
        let setup = Setup::new(root.clone());
        assert_eq!(setup.preset(), PresetId::Next);
        assert!(setup.findings().contains("next.js"));
        // The port it found is named with where it came from, so it can be
        // checked rather than taken on trust.
        assert!(setup.findings().contains("3000"), "{}", setup.findings());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unrecognisable_repository_opens_on_minimal() {
        let root = scratch("unknown");
        let setup = Setup::new(root.clone());
        assert_eq!(setup.preset(), PresetId::Minimal);
        assert!(setup.findings().contains("minimal is the honest answer"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_preview_is_the_file_and_it_follows_the_cursor() {
        let root = scratch("preview");
        let mut setup = Setup::new(root.clone());
        let first = setup.preview.clone();
        assert!(first.contains("[meta]"), "the preview is not a config file");
        setup.move_cursor(1);
        assert_ne!(
            setup.preview, first,
            "the preview did not follow the cursor"
        );
        // And it is exactly what write() would put on disk — the whole promise
        // of showing it.
        assert_eq!(setup.preview, setup.plan().render());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_cursor_wraps_and_every_stop_previews_a_valid_config() {
        let root = scratch("wrap");
        let mut setup = Setup::new(root.clone());
        let start = setup.cursor;
        for _ in 0..envmux_config::catalogue().len() {
            setup.move_cursor(1);
            let text = &setup.preview;
            envmux_config::parse(envmux_config::CONFIG_FILE, text)
                .unwrap_or_else(|e| panic!("the preview is not a usable config: {e}\n{text}"));
        }
        assert_eq!(setup.cursor, start, "the cursor did not wrap back round");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn writing_produces_the_previewed_file_and_the_project_dir() {
        let root = scratch("write");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let setup = Setup::new(root.clone());
        let path = setup.write().expect("writing the config");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            setup.preview,
            "what was written is not what was shown"
        );
        // And the things that have to exist beside it.
        assert!(root.join(".envmux").join(".gitignore").exists());
        let ignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == ".envmux/"), "{ignore}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn it_refuses_to_clobber_a_config_that_appeared_underneath_it() {
        // This screen only opens when there is none, but the gap between
        // opening it and pressing enter is long enough for another terminal to
        // have written one.
        let root = scratch("race");
        let setup = Setup::new(root.clone());
        std::fs::write(root.join(envmux_config::CONFIG_FILE), "# theirs\n").unwrap();
        let error = setup.write().expect_err("it overwrote someone's config");
        assert!(error.to_string().contains("already exists"), "{error}");
        assert_eq!(
            std::fs::read_to_string(root.join(envmux_config::CONFIG_FILE)).unwrap(),
            "# theirs\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
