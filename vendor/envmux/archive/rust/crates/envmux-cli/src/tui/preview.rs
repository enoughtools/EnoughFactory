//! A rendering harness.
//!
//! A TUI is the one part of this codebase whose output nobody can see in CI,
//! which makes it the part most likely to quietly break — a panel that
//! overflows on an 80-column terminal, a banner that eats the workspace list,
//! a modal wider than the screen. Rendering into an in-memory backend puts the
//! whole frame under assertion, and `cargo test -- --nocapture` prints it if
//! you want to look at it.

use envmux_api_types as dto;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

use super::modal::{Entry, Modal, Onboarding};
use super::state::{Focus, View};
use super::{App, Launch, render};

/// A project directory that is already configured.
///
/// The setup screen opens for a folder with no `.envmux.toml` in it, and a
/// test's working directory usually has none — which would put every render
/// test in front of the picker instead of the view it means to look at.
pub fn configured_root() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("envmux-preview-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch project dir");
    let config = dir.join(envmux_config::CONFIG_FILE);
    if !config.exists() {
        std::fs::write(&config, envmux_config::generate_starter(Some("envmux")))
            .expect("writing a config");
    }
    dir
}

/// A launch into a configured project, which is what every view but setup
/// assumes it is looking at.
pub fn configured_launch() -> Launch {
    Launch {
        root: configured_root(),
        ..Launch::default()
    }
}

/// A populated dashboard, so the frame under test is not an empty shell.
pub fn demo_app() -> App {
    let mut app = App::new(Launch {
        manage: true,
        ..configured_launch()
    });
    app.snapshot.daemon_ok = true;
    app.snapshot.namespaces = vec![namespace("envmux", 3), namespace("strigops", 1)];
    app.snapshot.workspaces = vec![
        workspace("wobbly-otter", "ready", true),
        workspace("feature-x-a1b2", "provisioning", false),
        workspace("brisk-heron", "degraded", true),
    ];
    app.snapshot.events = vec![
        event(3, "info", "broker", "rw attach; lease extended"),
        event(2, "warn", "reaper", "brisk-heron is past its lease"),
        event(
            1,
            "error",
            "docker",
            "pull denied for ghcr.io/example:0.1.0",
        ),
    ];
    app
}

/// The same world seen from the dispatch view — launched from inside the
/// `envmux` namespace rather than bare.
pub fn demo_session_app() -> App {
    let mut app = App::new(Launch {
        namespace: Some("envmux".to_owned()),
        ..configured_launch()
    });
    app.snapshot = demo_app().snapshot;
    // A session that is up has windows; the pane is most of the view.
    app.windows = super::windows::merge(
        &[
            dto::TaskStatus {
                name: "api".to_owned(),
                state: dto::TaskState::Ready,
                exit_code: None,
                restarts: 0,
            },
            dto::TaskStatus {
                name: "web".to_owned(),
                state: dto::TaskState::Failed,
                exit_code: Some(1),
                restarts: 2,
            },
        ],
        &super::windows::parse_windows("0\tterminal\t1\t0\n1\tapi\t0\t0\n2\tweb\t0\t0\n"),
    );
    app
}

/// The first-run screen, over a directory with nothing in it.
pub fn demo_setup_app() -> App {
    let dir = std::env::temp_dir().join(format!("envmux-demo-setup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    App::new(Launch {
        root: dir,
        ..Launch::default()
    })
}

fn namespace(name: &str, workspaces: u32) -> dto::NamespaceSummary {
    dto::NamespaceSummary {
        name: name.to_owned(),
        repo_remote: Some("git@example.com:acme/thing.git".to_owned()),
        created_at: "2026-08-01T00:00:00Z".parse().expect("timestamp"),
        mirror_last_fetch: None,
        mirror_fetch_mode: "periodic".to_owned(),
        workspaces,
        services: Vec::new(),
    }
}

fn workspace(name: &str, state: &str, with_tasks: bool) -> dto::WorkspaceSummary {
    let tasks = if with_tasks {
        vec![
            dto::TaskStatus {
                name: "api".to_owned(),
                state: dto::TaskState::Ready,
                exit_code: None,
                restarts: 0,
            },
            dto::TaskStatus {
                name: "worker".to_owned(),
                state: dto::TaskState::Failed,
                exit_code: Some(1),
                restarts: 3,
            },
        ]
    } else {
        Vec::new()
    };
    dto::WorkspaceSummary {
        id: format!("019fe44d-{name}"),
        namespace: "envmux".to_owned(),
        name: name.to_owned(),
        state: state.parse().unwrap_or(envmux_core::WorkspaceState::Ready),
        branch_requested: "main".to_owned(),
        config_hash: "085a8cdd".to_owned(),
        config_current: true,
        created_at: "2026-08-08T00:00:00Z".parse().expect("timestamp"),
        death_date: Some("2026-08-15T00:00:00Z".parse().expect("timestamp")),
        container_id: Some("d44f2fc177a9".to_owned()),
        observation: Some(dto::Observation {
            observed_at: "2026-08-09T02:00:00Z".parse().expect("timestamp"),
            branch: Some("main".to_owned()),
            head: Some("da8458f51ba6".to_owned()),
            dirty_files: Some(2),
            dirty: true,
            truncated: false,
            ahead: Some(1),
            behind: None,
            tasks,
            last_attach_at: None,
            last_capture_at: None,
            flagged_state: None,
        }),
        routes: std::collections::BTreeMap::from([(
            "web".to_owned(),
            "https://envmux_wobbly-otter_5173.strigops.xyz".to_owned(),
        )]),
    }
}

/// A shadow-history overlay with something in it.
pub fn history_modal() -> Modal {
    Modal::History {
        workspace: "wobbly-otter".to_owned(),
        captures: vec![
            capture("019fe1", "2026-08-09T01:00:00Z", false, None),
            capture("019fe2", "2026-08-08T20:00:00Z", true, None),
            capture(
                "019fe3",
                "2026-08-08T09:00:00Z",
                false,
                Some("rebase in progress"),
            ),
        ],
        cursor: 0,
    }
}

fn capture(id: &str, at: &str, torn: bool, flagged: Option<&str>) -> dto::CaptureSummary {
    dto::CaptureSummary {
        id: id.to_owned(),
        workspace_id: "019fe44d-wobbly-otter".to_owned(),
        workspace_name: "wobbly-otter".to_owned(),
        branch: Some("main".to_owned()),
        captured_at: at.parse().expect("timestamp"),
        shadow_ref: format!("refs/envmux/shadow/{id}"),
        commit_oid: format!("{id}8458f51ba6326f9709e1cfe5dbcf76786f4864"),
        torn,
        flagged_state: flagged.map(ToOwned::to_owned),
    }
}

fn event(id: i64, level: &str, component: &str, message: &str) -> dto::EventRecord {
    dto::EventRecord {
        id,
        at: "2026-08-09T02:00:00Z".parse().expect("timestamp"),
        level: level.to_owned(),
        namespace: Some("envmux".to_owned()),
        workspace: None,
        component: component.to_owned(),
        message: message.to_owned(),
    }
}

/// Render one frame and return it as text, one line per row.
pub fn frame_text(app: &App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test terminal");
    terminal
        .draw(|frame| render(frame, app))
        .expect("draw the frame");
    let buffer = terminal.backend().buffer().clone();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_full_frame_shows_every_pane() {
        let app = demo_app();
        let text = frame_text(&app, 120, 40);
        println!("\n{text}\n");

        for expected in [
            "namespaces",
            "workspaces",
            "detail",
            "telemetry",
            "wobbly-otter",
            "brisk-heron",
            "linked",
        ] {
            assert!(text.contains(expected), "frame is missing {expected:?}");
        }
    }

    /// Nothing on screen is shouted at the reader.
    ///
    /// Pane titles, state words and the link indicator are all lowercase, and
    /// the rule matters most for the strings that are *data* — a namespace or
    /// a branch rendered in caps looks like a different string than the one in
    /// the config, which is a bug report waiting to happen.
    #[test]
    fn nothing_is_capitalised_for_effect() {
        for app in [demo_app(), demo_session_app()] {
            let text = frame_text(&app, 120, 40);
            let shouted: Vec<&str> = text
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|word| {
                    word.len() > 1
                        && word
                            .chars()
                            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
                        && word.chars().any(|c| c.is_ascii_uppercase())
                })
                .collect();
            assert!(
                shouted.is_empty(),
                "these are being shouted at the reader: {shouted:?}\n{text}"
            );
        }
    }

    /// The landing page answers, top to bottom, the questions in the order
    /// they get asked: where am I, what can I open, what is it doing, what do
    /// I type.
    #[test]
    fn the_dispatch_frame_orients_before_it_offers_anything() {
        let app = demo_session_app();
        let text = frame_text(&app, 80, 24);
        println!("\n{text}\n");

        for expected in [
            "linked",       // daemon reachability
            "dispatch",     // the context card
            "envmux",       // the namespace, in the case it was written in
            "branch",       // which branch this folder is on
            "wobbly-otter", // the workspace the session is of
            "windows",
            "ports",
            "activity", // the event feed
            "❯",        // the prompt marker
        ] {
            assert!(
                text.contains(expected),
                "dispatch frame is missing {expected:?}:\n{text}"
            );
        }
        // The input line is the bottom row: that is where the eye rests.
        assert!(
            text.lines().last().is_some_and(|line| line.contains('❯')),
            "the prompt is not on the last row:\n{text}"
        );
        // And it is not the dashboard wearing a different hat.
        assert!(
            !text.contains("namespaces"),
            "the dispatch view is showing dashboard panes:\n{text}"
        );
    }

    /// The two things the rebuild is *for*: the windows you can jump between,
    /// and the ports you can open.
    #[test]
    fn windows_are_numbered_as_tmux_numbers_them_and_ports_show_their_url() {
        let app = demo_session_app();
        let text = frame_text(&app, 100, 30);
        println!("\n{text}\n");

        let windows_row = text
            .lines()
            .find(|line| line.contains("terminal"))
            .expect("the terminal window is not listed");
        assert!(
            windows_row.contains('0'),
            "the window is not showing the index you would press: {windows_row}"
        );
        // A failed task keeps its restart count where you can see it.
        assert!(
            text.contains("failed"),
            "a failed task is not called one:\n{text}"
        );
        assert!(text.contains("×2"), "the restart count is missing:\n{text}");
        // Ports are whole URLs, not "3 routes".
        assert!(
            text.contains("https://"),
            "the ports pane is not showing a url:\n{text}"
        );
    }

    /// A boot in flight is on screen; a boot that finished has given its rows
    /// back to the feed.
    #[test]
    fn the_checklist_reports_the_boot_and_then_gets_out_of_the_way() {
        let mut app = demo_session_app();
        app.boot = super::super::boot::Boot::start_for_test([
            super::super::boot::StepState::Done(".envmux.toml".to_owned()),
            super::super::boot::StepState::Working("linking".to_owned()),
            super::super::boot::StepState::Waiting,
            super::super::boot::StepState::Waiting,
        ]);
        let booting = frame_text(&app, 100, 30);
        println!("\n{booting}\n");
        for expected in ["starting", "config", "daemon", "namespace", "workspace"] {
            assert!(
                booting.contains(expected),
                "the checklist is missing {expected:?}:\n{booting}"
            );
        }
        assert!(
            booting.contains(".envmux.toml"),
            "a finished step must say what it decided, not just that it ran:\n{booting}"
        );

        // Settled: the rows go back to the feed rather than showing four ticks
        // nobody is reading.
        let settled = frame_text(&demo_session_app(), 100, 30);
        assert!(
            !settled.contains("starting"),
            "the checklist outstayed its welcome:\n{settled}"
        );
    }

    /// The first-run screen: the list, what was detected, and the file it
    /// would write — all before anything is written.
    #[test]
    fn the_setup_screen_shows_the_file_before_it_writes_it() {
        let bare = std::env::temp_dir().join(format!("envmux-setup-frame-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).expect("scratch dir");
        std::fs::write(
            bare.join("package.json"),
            r#"{"dependencies":{"vite":"5"},"scripts":{"dev":"vite"}}"#,
        )
        .unwrap();
        std::fs::write(bare.join("pnpm-lock.yaml"), "").unwrap();

        let app = App::new(Launch {
            root: bare.clone(),
            ..Launch::default()
        });
        let text = frame_text(&app, 110, 34);
        println!("\n{text}\n");

        for expected in [
            "set up this repository",
            "starting points",
            envmux_config::CONFIG_FILE,
            "detected", // both the label and the mark on the recommended row
            "vite",     // what this repository looks like
            "pnpm",     // and which package manager it committed to
            "[meta]",   // the preview is the file itself
            "write it and start",
        ] {
            assert!(
                text.contains(expected),
                "the setup screen is missing {expected:?}:\n{text}"
            );
        }
        // Nothing has been written by rendering it.
        assert!(!bare.join(envmux_config::CONFIG_FILE).exists());
        let _ = std::fs::remove_dir_all(&bare);
    }

    /// A boot that failed keeps its checklist, because it is the only place
    /// the reason is written down.
    #[test]
    fn a_failed_boot_stays_on_screen_and_says_why() {
        let mut app = demo_session_app();
        app.boot = super::super::boot::Boot::start_for_test([
            super::super::boot::StepState::Done(".envmux.toml".to_owned()),
            super::super::boot::StepState::Failed("docker is not running".to_owned()),
            super::super::boot::StepState::Waiting,
            super::super::boot::StepState::Waiting,
        ]);
        let text = frame_text(&app, 100, 30);
        assert!(
            text.contains("docker is not running"),
            "a failed boot did not say why:\n{text}"
        );
    }

    #[test]
    fn typed_text_renders_in_the_input_line() {
        let mut app = demo_session_app();
        app.input = "/new fixup".to_owned();
        let text = frame_text(&app, 80, 24);
        assert!(
            text.lines()
                .last()
                .is_some_and(|line| line.contains("/new fixup")),
            "the input line does not show what was typed:\n{text}"
        );
    }

    #[test]
    fn the_dashboard_is_unchanged_by_the_dispatch_view_existing() {
        // `envmux manage` still lands on the dashboard, panes intact and no
        // prompt marker anywhere.
        let app = demo_app();
        assert_eq!(app.view, View::Manage);
        let text = frame_text(&app, 120, 40);
        assert!(text.contains("namespaces"), "lost the dashboard");
        assert!(!text.contains('❯'), "the prompt leaked into the dashboard");
    }

    #[test]
    fn it_survives_a_terminal_nobody_should_be_using() {
        // ratatui panics on a rect outside the buffer, so every layout
        // decision has to hold at sizes the author never sat in front of —
        // in both views.
        for (width, height) in [(80, 24), (40, 12), (20, 8), (10, 5), (1, 1)] {
            for app in [demo_app(), demo_session_app(), demo_setup_app()] {
                let text = frame_text(&app, width, height);
                assert!(
                    text.lines()
                        .all(|line| line.chars().count() <= width as usize),
                    "{width}x{height} ({:?}) produced an over-wide line",
                    app.view
                );
            }
        }
    }

    #[test]
    fn the_wordmark_only_appears_where_it_costs_nothing() {
        // With something selected the detail pane is doing a job, and the
        // wordmark is not in it — nor across the top, where it used to charge
        // six rows for the privilege.
        let busy = frame_text(&demo_app(), 120, 40);
        assert!(
            !busy.contains("E N V M U X") && !busy.contains("███"),
            "the wordmark is taking rows from the panes:\n{busy}"
        );

        let mut empty = demo_app();
        empty.snapshot.workspaces.clear();
        let text = frame_text(&empty, 120, 40);
        println!("\n{text}\n");
        assert!(
            text.contains("E N V M U X"),
            "no wordmark anywhere:\n{text}"
        );
        assert!(
            text.contains("nothing selected"),
            "no reason for the blank pane"
        );

        // Bottom of the pane, under the message — not on top of it.
        let row = |needle: &str| {
            text.lines()
                .position(|line| line.contains(needle))
                .unwrap_or_else(|| panic!("{needle:?} is not on screen:\n{text}"))
        };
        assert!(row("E N V M U X") > row("nothing selected"));
    }

    #[test]
    fn a_short_terminal_keeps_the_panes() {
        // Nothing decorative is left to sacrifice, so the data must survive on
        // its own.
        let short = frame_text(&demo_app(), 120, 20);
        assert!(short.contains("wobbly-otter"), "lost the workspace list");
        assert!(short.contains("telemetry"), "lost the event feed");
    }

    #[test]
    fn every_modal_fits_inside_a_small_terminal() {
        let modals = [
            Modal::new_workspace(),
            Modal::new_session("wobbly-otter".to_owned()),
            history_modal(),
            Modal::History {
                workspace: "empty".to_owned(),
                captures: Vec::new(),
                cursor: 0,
            },
            Modal::Help,
            Modal::Confirm {
                prompt: "reap wobbly-otter?".to_owned(),
                detail: "A final shadow snapshot is taken first.".to_owned(),
                action: super::super::modal::ConfirmAction::Reap {
                    id: "id".to_owned(),
                    name: "wobbly-otter".to_owned(),
                },
            },
        ];
        for modal in modals {
            let mut app = demo_app();
            app.modal = Some(modal);
            // 40x14 is smaller than any of these want to be; they must clamp.
            let text = frame_text(&app, 40, 14);
            assert!(text.lines().all(|line| line.chars().count() <= 40));
        }
    }

    #[test]
    fn the_focused_pane_is_the_one_that_looks_focused() {
        // Focus is drawn with a double rule; without it the keyboard goes
        // somewhere the eye cannot follow.
        let mut app = demo_app();
        app.focus = Focus::Namespaces;
        let namespaces = frame_text(&app, 120, 40);
        app.focus = Focus::Events;
        let events = frame_text(&app, 120, 40);
        assert_ne!(namespaces, events, "moving focus changed nothing on screen");
        assert!(namespaces.contains('╔') && events.contains('╔'));
    }

    /// Not an assertion so much as a way to look at the overlays:
    /// `cargo test -p envmux-cli overlays -- --nocapture`.
    #[test]
    fn overlays_render() {
        let mut app = demo_app();
        let mut session = Modal::new_session("wobbly-otter".to_owned());
        for ch in "scratch".chars() {
            session.type_char(ch);
        }
        for (label, modal) in [
            ("new workspace", Modal::new_workspace()),
            ("ad-hoc session", session),
            ("shadow history", history_modal()),
            ("help", Modal::Help),
            (
                "confirm",
                Modal::Confirm {
                    prompt: "reap wobbly-otter?".to_owned(),
                    detail: "A final shadow snapshot is taken first, so committed \
                             and uncommitted work survives in the shadow origin. \
                             The container and its volumes do not."
                        .to_owned(),
                    action: super::super::modal::ConfirmAction::Reap {
                        id: "id".to_owned(),
                        name: "wobbly-otter".to_owned(),
                    },
                },
            ),
        ] {
            app.modal = Some(modal);
            println!("\n=== {label} ===\n{}", frame_text(&app, 100, 30));
            assert!(app.modal.is_some());
        }
    }

    #[test]
    fn the_history_overlay_flags_what_you_would_want_to_know_before_reviving() {
        let mut app = demo_app();
        app.modal = Some(history_modal());
        let text = frame_text(&app, 100, 30);
        // A torn snapshot caught the tree mid-write, and a flagged one caught
        // it mid-rebase. Both are restorable; both are things to see first.
        assert!(
            text.contains("torn"),
            "torn snapshot not flagged:
{text}"
        );
        assert!(text.contains("rebase in progress"), "repo state not shown");
        assert!(text.contains("wobbly-otter"), "does not say whose history");
    }

    #[test]
    fn an_empty_history_explains_itself_rather_than_showing_a_blank_box() {
        let mut app = demo_app();
        app.modal = Some(Modal::History {
            workspace: "fresh".to_owned(),
            captures: Vec::new(),
            cursor: 0,
        });
        let text = frame_text(&app, 100, 30);
        assert!(text.contains("No snapshots yet"));
        assert!(text.contains("press c") || text.contains("Press c"));
    }

    #[test]
    fn the_help_overlay_shows_every_binding_in_full() {
        // A truncated key list is worse than none: it is the one screen whose
        // whole job is telling you what exists.
        let mut app = demo_app();
        app.modal = Some(Modal::Help);
        let text = frame_text(&app, 120, 40);
        for expected in [
            "new ad-hoc session in this workspace",
            "shadow history, and revive from a snapshot",
            "attach read-write (extends the lease)",
            "start a daemon, if there is none",
        ] {
            assert!(
                text.contains(expected),
                "help truncated {expected:?}:\n{text}"
            );
        }
    }

    #[test]
    fn the_help_screen_leads_with_the_next_step_when_nothing_is_running() {
        // Someone whose first act is pressing ? on an empty screen needs the
        // next step, not an index of keys they have no use for yet.
        let mut app = demo_app();
        app.modal = Some(Modal::Help);

        app.snapshot.daemon_ok = false;
        let no_daemon = frame_text(&app, 120, 44);
        println!("\n{no_daemon}\n");
        assert!(no_daemon.contains("Nothing is running yet"), "{no_daemon}");
        assert!(no_daemon.contains("start here"), "not framed as onboarding");

        app.snapshot.daemon_ok = true;
        app.snapshot.namespaces.clear();
        assert!(frame_text(&app, 120, 44).contains("does not know about any projects"));

        app.snapshot.namespaces = demo_app().snapshot.namespaces;
        app.snapshot.workspaces.clear();
        assert!(frame_text(&app, 120, 44).contains("Nothing has been built from it yet"));

        // ...and once there is a workspace, no lecture.
        app.snapshot.workspaces = demo_app().snapshot.workspaces;
        let settled = frame_text(&app, 120, 44);
        assert!(!settled.contains("Nothing is running yet"));
        assert!(settled.contains("keys"), "lost the key list");
    }

    #[test]
    fn every_key_the_onboarding_names_is_a_key_that_exists() {
        // A step telling someone to press a key that does nothing is worse
        // than no guidance at all, so check the scripts against the real list.
        let mut app = demo_app();
        app.modal = Some(Modal::Help);
        let listed = frame_text(&app, 120, 44);
        for stage in [
            Onboarding::NoDaemon,
            Onboarding::NoNamespace,
            Onboarding::NoWorkspace,
        ] {
            for key in stage.keys() {
                assert!(
                    listed.contains(&format!("{key}  ")),
                    "{stage:?} tells you to press {key:?}, which is not in the key list"
                );
            }
        }
    }

    #[test]
    fn the_directory_picker_flags_what_is_worth_opening() {
        let root = std::env::temp_dir().join(format!("envmux-pick-{}", std::process::id()));
        std::fs::create_dir_all(root.join("plain-dir")).expect("dir");
        std::fs::create_dir_all(root.join("a-repo").join(".git")).expect("repo");
        std::fs::create_dir_all(root.join("declared").join(".git")).expect("declared");
        std::fs::write(root.join("declared").join(".envmux.toml"), b"[meta]").expect("config");
        std::fs::create_dir_all(root.join(".hidden")).expect("hidden");

        let mut app = demo_app();
        app.modal = Some(Modal::pick_directory(root.clone()));
        let text = frame_text(&app, 100, 30);
        println!("\n{text}\n");

        assert!(text.contains("use this directory"), "no way to choose one");
        assert!(text.contains("a-repo/"), "missing a repository");
        assert!(text.contains(".envmux.toml"), "declared repo not flagged");
        // Dotfiles are noise; .git is reported as a flag, not browsed into.
        assert!(!text.contains(".hidden"), "listing dotfiles");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn choosing_use_this_returns_the_directory_and_exploring_does_not() {
        let root = std::env::temp_dir().join(format!("envmux-pick2-{}", std::process::id()));
        std::fs::create_dir_all(root.join("child")).expect("dir");

        // Row 0 is always "use this directory".
        let mut modal = Modal::pick_directory(root.clone());
        assert_eq!(modal.descend().as_deref(), Some(root.as_path()));

        // Descending into a child moves the browser rather than choosing it —
        // otherwise a keypress meant to explore registers the wrong project.
        let mut modal = Modal::pick_directory(root.clone());
        modal.move_cursor(99);
        assert_eq!(modal.descend(), None);
        modal.ascend();

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_picker_offers_no_parent_at_a_filesystem_root() {
        // A parent row above the root would be a row that does nothing.
        let root = std::path::Path::new(if cfg!(windows) { "C:\\" } else { "/" });
        let entries = super::super::modal::read_entries(root);
        assert_eq!(entries.first(), Some(&Entry::UseThis));
        assert!(
            !entries.contains(&Entry::Parent),
            "offered a parent above the root"
        );
    }

    #[test]
    fn the_history_cursor_cannot_leave_the_list() {
        let mut modal = history_modal();
        modal.move_cursor(-5);
        assert_eq!(
            modal.selected_capture().map(|c| c.id.as_str()),
            Some("019fe1")
        );
        modal.move_cursor(99);
        assert_eq!(
            modal.selected_capture().map(|c| c.id.as_str()),
            Some("019fe3")
        );

        // An empty history has nothing to select, and must not panic saying so.
        let mut empty = Modal::History {
            workspace: "x".to_owned(),
            captures: Vec::new(),
            cursor: 0,
        };
        empty.move_cursor(1);
        assert!(empty.selected_capture().is_none());
    }

    #[test]
    fn the_new_session_form_names_the_workspace_it_will_open_in() {
        // Creating an ad-hoc session in the wrong workspace is not something
        // you notice until you have typed into it.
        let mut app = demo_app();
        app.modal = Some(Modal::new_session("brisk-heron".to_owned()));
        let text = frame_text(&app, 100, 30);
        assert!(
            text.contains("brisk-heron"),
            "form does not say where:\n{text}"
        );
    }
}
