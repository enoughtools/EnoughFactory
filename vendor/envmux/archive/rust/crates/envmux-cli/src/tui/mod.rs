//! The interactive terminal UI — the primary way in.
//!
//! `envmux` with no subcommand, on a TTY, lands here. That ordering is
//! deliberate: asking someone to install a service before they can see what
//! the thing does is asking a lot, and a TUI over the same IPC API costs them
//! nothing to try.
//!
//! It is a client of that API and nothing more. No privileged access, no
//! second source of truth, no state of its own beyond what is on screen — so
//! it can never disagree with the CLI about what exists.

mod boot;
mod chrome;
mod dispatch;
mod modal;
#[cfg(test)]
mod preview;
mod setup;
mod state;
mod theme;
mod windows;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context as _;

use envmux_api_types as dto;
use futures_util::StreamExt as _;
use ratatui::Frame;
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, List, ListItem, ListState, Paragraph, Row, Table, TableState, Wrap};

use crate::client;
use boot::Boot;
use modal::{ConfirmAction, Modal};
use state::{Flash, FlashLevel, Focus, Snapshot, View};
use windows::Window;

/// How often to repaint. Fast enough for the animation to read as motion,
/// slow enough to be invisible on a battery.
const FRAME: Duration = Duration::from_millis(120);

/// How often to ask the daemon what changed. Observation is a snapshot rather
/// than a feed, so polling faster buys nothing but load.
const POLL_EVERY_TICKS: u64 = 8;

/// How often to ask tmux what windows exist. Slower than the main poll
/// because each one is a `docker exec` into the workspace, and the answer
/// changes when a task starts or someone opens a window — not continuously.
const WINDOW_EVERY_TICKS: u64 = 24;

/// How often to re-read the branch the host checkout is on. It is a `git`
/// subprocess, and the answer changes when you check out, not on a timer.
const BRANCH_EVERY_TICKS: u64 = 40;

/// How long a flash message lingers before fading.
const FLASH_TICKS: u64 = 40;

/// Where this session is, in the terms the landing page states it in.
///
/// Cheap and host-side: the folder and the branch it is checked out on. The
/// branch is re-read on a slow tick rather than once, because switching
/// branches in another terminal is a normal thing to do and a stale answer
/// here is the sort of wrong that goes unnoticed.
struct Context {
    root: PathBuf,
    branch: Option<String>,
}

struct App {
    launch: Launch,
    view: View,
    tick: u64,
    snapshot: Snapshot,
    context: Context,
    /// The session being brought up, and the checklist that reports it.
    boot: Boot,
    /// The workspace's tmux windows, merged from the task engine and tmux.
    windows: Vec<Window>,
    /// The last answer tmux gave, kept between probes so a dead pane stays
    /// dead until something says otherwise.
    window_live: Vec<windows::LiveWindow>,
    window_cursor: usize,
    /// Whether the windows pane is taking the arrow keys. False means the
    /// input line has them for history recall, which is the resting state.
    window_focus: bool,
    /// One window probe in flight at a time; it is a `docker exec` and must
    /// never happen on the render path.
    window_probe: Option<tokio::task::JoinHandle<Vec<windows::LiveWindow>>>,
    /// The first-run picker, while it is up. Present only for a folder with
    /// no configuration in it.
    setup: Option<setup::Setup>,
    focus: Focus,
    namespace_index: usize,
    workspace_index: usize,
    event_index: usize,
    modal: Option<Modal>,
    flash: Option<Flash>,
    quit: bool,
    /// The session view's command line. Always focused while that view is up —
    /// there is nothing else there to focus.
    input: String,
    /// Submitted lines, oldest first, for Up/Down recall.
    history: Vec<String>,
    /// Where recall is pointing, when it is. Typing anything resets it.
    history_cursor: Option<usize>,
    /// How many events the session feed is scrolled back by.
    session_scroll: usize,
    /// Set when an action needs the terminal to itself. The loop suspends the
    /// UI, runs it, and restores — a real tmux attach cannot share the screen
    /// with a rendering loop.
    suspend: Option<Suspend>,
    /// Editor launches being watched for a late non-zero exit. Success was
    /// already flashed at spawn; these exist only so a fast failure ("code:
    /// command exited 1") still surfaces instead of vanishing into /dev/null.
    editor_watch: Vec<crate::editor::launch::Launched>,
}

/// Work that takes over the terminal.
enum Suspend {
    Attach {
        id: String,
        name: String,
        task: Option<String>,
        read_only: bool,
    },
}

impl App {
    fn new(launch: Launch) -> Self {
        // A folder with no configuration cannot boot a session — there is
        // nothing to build one from — so the first screen is the one that
        // decides what it should be. Everything else lands on dispatch.
        let setup = (launch.namespace.is_none() && setup::Setup::needed(&launch.root))
            .then(|| setup::Setup::new(launch.root.clone()));
        let view = if setup.is_some() {
            View::Setup
        } else if launch.manage {
            View::Manage
        } else {
            View::Dispatch
        };
        // Constructing the app must not start anything: `new` runs in tests
        // with no daemon, no Docker and sometimes no runtime, and a
        // constructor that forks a daemon is one nobody can call safely. The
        // event loop starts the boot, once, on the way in.
        let boot = Boot::idle();
        let context = Context {
            branch: crate::host_branch(&launch.root),
            root: launch.root.clone(),
        };
        Self {
            launch,
            view,
            tick: 0,
            snapshot: Snapshot::default(),
            context,
            boot,
            windows: Vec::new(),
            window_live: Vec::new(),
            window_cursor: 0,
            window_focus: false,
            window_probe: None,
            setup,
            focus: Focus::Workspaces,
            namespace_index: 0,
            workspace_index: 0,
            event_index: 0,
            modal: None,
            flash: None,
            quit: false,
            input: String::new(),
            history: Vec::new(),
            history_cursor: None,
            session_scroll: 0,
            suspend: None,
            editor_watch: Vec::new(),
        }
    }

    /// Begin bringing the session up. Called once, by the event loop, and
    /// again by the setup screen once it has written a configuration.
    fn start_boot(&mut self) {
        // Nothing to boot from until the repository has been set up, and
        // forking a daemon behind a screen that has not been answered yet
        // would be doing the thing the screen exists to ask about.
        if self.setup.is_some() {
            return;
        }
        self.boot = match &self.launch.namespace {
            // Already registered — `envmux manage` over a folder that is up.
            Some(namespace) => Boot::already_done(namespace.clone()),
            None => Boot::start(self.launch.root.clone(), self.context.branch.clone()),
        };
    }

    fn namespace(&self) -> Option<&dto::NamespaceSummary> {
        self.snapshot.namespaces.get(self.namespace_index)
    }

    /// The namespace this session is about: what boot registered, what the
    /// launch pinned, or whatever the cursor is on in the dashboard.
    fn namespace_name(&self) -> Option<&str> {
        self.boot
            .outcome()
            .namespace
            .as_deref()
            .or(self.launch.namespace.as_deref())
            .or_else(|| self.namespace().map(|ns| ns.name.as_str()))
    }

    fn workspace(&self) -> Option<&dto::WorkspaceSummary> {
        self.snapshot.workspaces.get(self.workspace_index)
    }

    /// The workspace the landing page is about.
    ///
    /// The one boot created, when it is still there — a session is *of* a
    /// workspace, and quietly switching to a different one because it sorts
    /// first would be a surprise. Otherwise the first that can take an attach.
    fn primary_workspace(&self) -> Option<&dto::WorkspaceSummary> {
        let named = self
            .boot
            .outcome()
            .workspace
            .as_deref()
            .and_then(|name| self.snapshot.workspaces.iter().find(|ws| ws.name == name));
        named
            .or_else(|| self.snapshot.workspaces.iter().find(|ws| attachable(ws)))
            .or_else(|| self.snapshot.workspaces.first())
    }

    /// The routed URLs of the primary workspace, as name/url pairs.
    fn routes(&self) -> Vec<(&str, &str)> {
        self.primary_workspace().map_or_else(Vec::new, |ws| {
            ws.routes
                .iter()
                .map(|(name, url)| (name.as_str(), url.as_str()))
                .collect()
        })
    }

    /// The window the cursor is on.
    fn selected_window(&self) -> Option<&Window> {
        self.windows.get(self.window_cursor)
    }

    /// Move the window cursor, wrapping — the list is short and a cursor that
    /// stops dead at the end costs a keystroke to notice.
    fn move_window_cursor(&mut self, delta: isize) {
        if self.windows.is_empty() {
            return;
        }
        // Any movement means the pane has the keyboard; that is what the key
        // was for, so saying so twice would be a step nobody would guess.
        self.window_focus = true;
        // Wrapping arithmetic on indices, done in signed space so a backwards
        // step from the top lands on the bottom rather than underflowing.
        let len = isize::try_from(self.windows.len()).unwrap_or(isize::MAX);
        let cursor = isize::try_from(self.window_cursor).unwrap_or(0);
        self.window_cursor = usize::try_from((cursor + delta).rem_euclid(len)).unwrap_or(0);
    }

    fn say(&mut self, message: impl Into<String>, level: FlashLevel) {
        self.flash = Some(Flash {
            message: message.into(),
            level,
            raised: self.tick,
        });
    }

    /// Keep every selection inside its list after a refresh.
    fn clamp_selections(&mut self) {
        self.namespace_index = state::clamp(self.namespace_index, self.snapshot.namespaces.len());
        self.workspace_index = state::clamp(self.workspace_index, self.snapshot.workspaces.len());
        self.event_index = state::clamp(self.event_index, self.snapshot.events.len());
        self.session_scroll = self
            .session_scroll
            .min(self.snapshot.events.len().saturating_sub(1));
        self.window_cursor = state::clamp(self.window_cursor, self.windows.len());
    }

    /// Recall the previous submitted line into the input.
    fn history_previous(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let next = match self.history_cursor {
            None => self.history.len() - 1,
            // Pinned at the oldest rather than wrapping: wrapping makes "how
            // far back am I" unanswerable.
            Some(index) => index.saturating_sub(1),
        };
        self.history_cursor = Some(next);
        self.input = self.history[next].clone();
    }

    /// Walk forward again; past the newest line the input goes back to blank.
    fn history_next(&mut self) {
        match self.history_cursor {
            Some(index) if index + 1 < self.history.len() => {
                self.history_cursor = Some(index + 1);
                self.input = self.history[index + 1].clone();
            }
            Some(_) => {
                self.history_cursor = None;
                self.input.clear();
            }
            None => {}
        }
    }

    fn move_selection(&mut self, delta: isize) {
        let (index, len) = match self.focus {
            Focus::Namespaces => (&mut self.namespace_index, self.snapshot.namespaces.len()),
            Focus::Workspaces => (&mut self.workspace_index, self.snapshot.workspaces.len()),
            Focus::Events => (&mut self.event_index, self.snapshot.events.len()),
        };
        if len == 0 {
            return;
        }
        let next = if delta.is_negative() {
            index.saturating_sub(delta.unsigned_abs())
        } else {
            index.saturating_add(usize::try_from(delta).unwrap_or(0))
        };
        *index = next.min(len - 1);

        // Changing namespace changes which workspaces are listed, so the
        // workspace cursor has to go back to the top rather than pointing at
        // whatever happens to sit at the same index in a different list.
        if self.focus == Focus::Namespaces {
            self.workspace_index = 0;
        }
    }
}

/// Whether a workspace can take an attach right now.
///
/// Ready or degraded: the container is up either way, and a failed task is
/// exactly the thing you attach to go and look at. Provisioning is not an
/// error, just not yet.
fn attachable(ws: &dto::WorkspaceSummary) -> bool {
    matches!(ws.state.to_string().as_str(), "ready" | "degraded")
}

/// How the TUI was launched, and what it should show first.
///
/// `envmux` in a project lands on the dispatch view and boots the session
/// behind it; `envmux manage` (or `/manage`) opens the management dashboard
/// over the same folder.
pub struct Launch {
    /// The project folder this session is for. Everything else — the
    /// namespace, the branch, the workspace — is derived from it.
    pub root: PathBuf,
    /// A namespace that is already registered. Absent means boot finds out,
    /// which is the normal case.
    pub namespace: Option<String>,
    /// Open the management dashboard instead of the dispatch view.
    pub manage: bool,
}

impl Default for Launch {
    fn default() -> Self {
        Self {
            root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            namespace: None,
            manage: false,
        }
    }
}

/// Whether `root` has no configuration and would land on the setup screen.
pub fn setup_needed(root: &std::path::Path) -> bool {
    setup::Setup::needed(root)
}

/// Write the preset the setup screen would have recommended, without asking.
///
/// The `--yes` path: same detection, same file, no screen. It exists so that
/// scripting `envmux` stays possible, and it deliberately picks the *same*
/// answer the interactive path pre-selects rather than a separate "default"
/// that could quietly drift away from it.
///
/// # Errors
/// If the configuration cannot be written, or one appeared while deciding.
pub fn write_recommended_config(root: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    setup::Setup::new(root.to_path_buf()).write()
}

/// Run the TUI until the user quits.
///
/// # Errors
/// If the terminal cannot be put into raw mode or restored.
pub async fn run(launch: Launch) -> anyhow::Result<()> {
    // Refuse before touching the terminal when stdout is not one.
    //
    // Crossterm on Windows will happily open the attached console even with
    // stdout redirected, so `try_init` succeeding proves nothing: the UI would
    // render and its escape sequences would go down the pipe. A caller who
    // redirected output wants text, and there is no version of a full-screen
    // UI that is text.
    {
        use std::io::IsTerminal as _;
        anyhow::ensure!(
            std::io::stdout().is_terminal(),
            "the TUI needs a terminal on stdout. Use a subcommand \
             (`envmux ls`, `envmux status --json`) when output is redirected"
        );
    }

    // The panicking `init` would turn a CI job into a backtrace, when the
    // honest answer is one sentence.
    let mut terminal = ratatui::try_init().context("taking over the terminal")?;
    let result = event_loop(&mut terminal, launch).await;
    // Restore even when the loop failed, or the shell is left in raw mode with
    // no echo — which reads as "my shell broke", not "envmux crashed".
    let restored = ratatui::try_restore();
    result.and(restored.context("restoring the terminal"))
}

async fn event_loop(terminal: &mut ratatui::DefaultTerminal, launch: Launch) -> anyhow::Result<()> {
    let mut app = App::new(launch);
    let mut events = ratatui::crossterm::event::EventStream::new();
    let mut ticker = tokio::time::interval(FRAME);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Paint before anything else happens. This is the whole point of the
    // rearrangement: the landing page is on screen with the folder's name on
    // it before the first IPC call, let alone before an image pull.
    terminal.draw(|frame| render(frame, &app))?;
    app.start_boot();
    terminal.draw(|frame| render(frame, &app))?;

    while !app.quit {
        tokio::select! {
            _ = ticker.tick() => {
                app.tick += 1;
                app.boot.drain();
                if app.tick.is_multiple_of(POLL_EVERY_TICKS) {
                    refresh(&mut app).await;
                }
                collect_windows(&mut app);
                if app.tick.is_multiple_of(WINDOW_EVERY_TICKS) {
                    probe_windows(&mut app);
                }
                // Branches change in other terminals, and a context header
                // that quietly reports last hour's branch is the sort of
                // wrong nobody catches.
                if app.tick.is_multiple_of(BRANCH_EVERY_TICKS) {
                    app.context.branch = crate::host_branch(&app.context.root);
                }
                // Editor launches report failure late, from a reap thread; the
                // tick is where those warnings become flashes. Warnings are
                // taken before the done-list is pruned, so none can be lost.
                let warnings: Vec<String> =
                    app.editor_watch.iter().filter_map(|l| l.try_warning()).collect();
                if !warnings.is_empty() {
                    app.say(warnings.join(" · "), FlashLevel::Bad);
                }
                app.editor_watch.retain(|l| !l.is_done());
                if let Some(flash) = &app.flash
                    && flash.level != FlashLevel::Working
                    && app.tick.saturating_sub(flash.raised) > FLASH_TICKS
                {
                    app.flash = None;
                }
            }
            Some(Ok(event)) = events.next() => {
                match event {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        handle_key(&mut app, key).await;
                    }
                    Event::Resize(..) => {}
                    _ => {}
                }
            }
        }

        // An attach owns the terminal, so leave ours entirely and come back.
        if let Some(suspend) = app.suspend.take() {
            ratatui::try_restore().context("releasing the terminal for attach")?;
            let outcome = run_suspended(suspend).await;
            *terminal = ratatui::try_init().context("reclaiming the terminal after attach")?;
            terminal.clear()?;
            match outcome {
                Ok(message) => app.say(message, FlashLevel::Good),
                Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
            }
            refresh(&mut app).await;
            // Coming back from an attach is the moment the window list is
            // most likely to be wrong: opening or closing windows inside tmux
            // is exactly what you were just doing.
            probe_windows(&mut app);
        }

        terminal.draw(|frame| render(frame, &app))?;
    }
    Ok(())
}

async fn run_suspended(suspend: Suspend) -> anyhow::Result<String> {
    match suspend {
        Suspend::Attach {
            id,
            name,
            task,
            read_only,
        } => {
            crate::attach::attach(&id, task.as_deref(), read_only).await?;
            Ok(format!("detached from {name}"))
        }
    }
}

/// Ask the workspace what windows it has, on a spawned task.
///
/// One at a time: the probe is a `docker exec`, and a queue of them behind a
/// slow container would be a backlog of answers about a past that no longer
/// matters.
fn probe_windows(app: &mut App) {
    if app.window_probe.is_some() {
        return;
    }
    let Some(ws) = app.primary_workspace() else {
        return;
    };
    if !attachable(ws) {
        // No session to list yet. The declared tasks still show, from the
        // observation the ordinary poll already carries.
        return;
    }
    let id = ws.id.clone();
    app.window_probe = Some(tokio::spawn(async move { windows::probe(&id).await }));
}

/// Re-merge the window list, taking a finished probe's answer if there is one.
///
/// Runs every tick rather than only when a probe lands, because the two halves
/// go stale at different rates: what windows *exist* changes rarely, and what
/// their tasks are *doing* changes constantly and arrives on the ordinary
/// poll. The last probe's answer is kept as-is between probes — rebuilding it
/// from the rendered rows would quietly lose which panes had died.
fn collect_windows(app: &mut App) {
    if app
        .window_probe
        .as_ref()
        .is_some_and(tokio::task::JoinHandle::is_finished)
    {
        let handle = app.window_probe.take().expect("just checked");
        // A probe that panicked told us nothing; the previous answer stands
        // until one of them succeeds.
        if let Some(Ok(live)) = futures_util::FutureExt::now_or_never(handle) {
            app.window_live = live;
        }
    }

    let tasks = app
        .primary_workspace()
        .and_then(|ws| ws.observation.as_ref())
        .map(|o| o.tasks.clone())
        .unwrap_or_default();
    app.windows = windows::merge(&tasks, &app.window_live);
    app.window_cursor = state::clamp(app.window_cursor, app.windows.len());
}

async fn refresh(app: &mut App) {
    let namespace = app.namespace_name().map(ToOwned::to_owned);
    app.snapshot.refresh(namespace.as_deref()).await;
    // The session stays pointed at its own namespace across refreshes: the
    // dispatch view is about this folder, whatever else the daemon knows.
    if let Some(target) = namespace.as_deref()
        && let Some(found) = app
            .snapshot
            .namespaces
            .iter()
            .position(|ns| ns.name == target)
    {
        app.namespace_index = found;
    }
    app.clamp_selections();
    if !app.snapshot.daemon_ok {
        // Only worth saying once the boot has had its go. Before that the
        // checklist is already reporting it, in more detail and in the right
        // place, and a contradicting flash underneath reads as two problems.
        // And never over the setup screen, which has not yet decided what a
        // daemon here would even run.
        if app.boot.settled() && app.view != View::Setup {
            app.say(
                match app.view {
                    View::Manage => "no daemon on this state directory — press u to start one",
                    View::Setup | View::Dispatch => {
                        "no daemon on this state directory — /up starts one"
                    }
                },
                FlashLevel::Bad,
            );
        }
    } else if matches!(&app.flash, Some(f) if f.level == FlashLevel::Working) {
        app.flash = None;
    }
}

// ---------------------------------------------------------------------------
// Input

async fn handle_key(app: &mut App, key: KeyEvent) {
    if app.modal.is_some() {
        handle_modal_key(app, key).await;
        return;
    }

    // Ctrl-C quits from either view. In the session view it is the only key
    // that does — everything else there is typing.
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        app.quit = true;
        return;
    }

    match app.view {
        View::Setup => handle_setup_key(app, key),
        View::Dispatch => handle_dispatch_key(app, key).await,
        View::Manage => handle_manage_key(app, key).await,
    }
}

/// Setup view: a list, a preview of the file, and two ways out.
///
/// No input line and no slash commands. There is exactly one decision on this
/// screen and everything that is not making it is a way to look at it for
/// longer.
fn handle_setup_key(app: &mut App, key: KeyEvent) {
    let Some(setup) = &mut app.setup else {
        return;
    };
    match key.code {
        KeyCode::Down | KeyCode::Char('j') => setup.move_cursor(1),
        KeyCode::Up | KeyCode::Char('k') => setup.move_cursor(-1),
        KeyCode::PageDown => setup.scroll_preview(10),
        KeyCode::PageUp => setup.scroll_preview(-10),
        KeyCode::Enter => accept_setup(app),
        // Esc and q both leave without writing. Quitting is the *safe* answer
        // here — this screen's other option puts a file in someone's
        // repository — so it gets the two spellings rather than one.
        KeyCode::Esc | KeyCode::Char('q') => app.quit = true,
        _ => {}
    }
}

/// Write the chosen configuration, then start the session it describes.
///
/// The two are one intention — *set this repository up and get to work* — and
/// stopping at a written file would leave someone looking at a screen that has
/// nothing left to say.
fn accept_setup(app: &mut App) {
    let Some(setup) = &app.setup else {
        return;
    };
    match setup.write() {
        Ok(path) => {
            let name = path.file_name().map_or_else(
                || path.display().to_string(),
                |n| n.to_string_lossy().into(),
            );
            app.setup = None;
            app.view = View::Dispatch;
            app.say(format!("wrote {name}"), FlashLevel::Good);
            app.start_boot();
        }
        // Left on the screen deliberately: the file was not written, so the
        // decision has not been made, and dropping through to a session that
        // cannot start would report the same problem twice in a worse place.
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

/// Dispatch view: every key belongs to the input line except the few that
/// cannot — quit, recall, scrolling the feed, and moving between windows.
///
/// The window list is the one thing here with a cursor, and it deliberately
/// does not take plain arrow keys by default: those recall history, which is
/// what a prompt's arrows do everywhere else. Tab moves between windows, and
/// `alt-<n>` goes straight to one by its tmux index.
async fn handle_dispatch_key(app: &mut App, key: KeyEvent) {
    // alt-<digit> selects a window by the number tmux gave it — the same
    // number that works inside the session, which is the point.
    if key.modifiers.contains(KeyModifiers::ALT)
        && let KeyCode::Char(ch) = key.code
        && let Some(digit) = ch.to_digit(10)
    {
        attach_window_by_index(app, digit);
        return;
    }

    match key.code {
        KeyCode::Enter => submit_input(app).await,
        KeyCode::Backspace => {
            app.input.pop();
            app.history_cursor = None;
        }
        // Esc clears the line, or drops the window cursor when the line is
        // already empty. Abandoning a half-typed command is routine, and
        // quitting has /quit and ctrl-c.
        KeyCode::Esc => {
            if app.input.is_empty() {
                app.window_focus = false;
            }
            app.input.clear();
            app.history_cursor = None;
        }
        KeyCode::Tab => app.move_window_cursor(1),
        KeyCode::BackTab => app.move_window_cursor(-1),
        // Arrows recall history, unless the windows pane has been given the
        // keyboard by a Tab — then they move within it, which is what a
        // focused list is expected to do.
        KeyCode::Up if app.window_focus => app.move_window_cursor(-1),
        KeyCode::Down if app.window_focus => app.move_window_cursor(1),
        KeyCode::Up => app.history_previous(),
        KeyCode::Down => app.history_next(),
        // The feed scrolls; the input stays put.
        KeyCode::PageUp => {
            app.session_scroll =
                (app.session_scroll + 5).min(app.snapshot.events.len().saturating_sub(1));
        }
        KeyCode::PageDown => app.session_scroll = app.session_scroll.saturating_sub(5),
        KeyCode::Char(ch)
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            app.input.push(ch);
            app.history_cursor = None;
        }
        _ => {}
    }
}

async fn handle_manage_key(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Char('q') => app.quit = true,
        // Esc is "back", and there is now always somewhere to go back to:
        // every launch has a dispatch view, including the one that opened
        // straight into the dashboard. Quitting has `q` and ctrl-c.
        KeyCode::Esc => app.view = View::Dispatch,
        KeyCode::Char('?') => app.modal = Some(Modal::Help),

        KeyCode::Tab => app.focus = app.focus.next(),
        KeyCode::BackTab => app.focus = app.focus.previous(),
        KeyCode::Char('1') => app.focus = Focus::Namespaces,
        KeyCode::Char('2') => app.focus = Focus::Workspaces,
        KeyCode::Char('3') => app.focus = Focus::Events,

        KeyCode::Down | KeyCode::Char('j') => app.move_selection(1),
        KeyCode::Up | KeyCode::Char('k') => app.move_selection(-1),
        KeyCode::PageDown => app.move_selection(10),
        KeyCode::PageUp => app.move_selection(-10),

        KeyCode::Char('r') => {
            app.say("resyncing…", FlashLevel::Working);
            refresh(app).await;
        }
        KeyCode::Char('u') => start_daemon(app).await,
        KeyCode::Char('n') => app.modal = Some(Modal::new_workspace()),
        KeyCode::Char('o') => open_project(app),
        KeyCode::Char('I') => confirm_install(app),
        KeyCode::Char('s') => match app.workspace() {
            Some(ws) => app.modal = Some(Modal::new_session(ws.name.clone())),
            None => app.say("no workspace selected", FlashLevel::Bad),
        },
        KeyCode::Char('a') => attach(app, false),
        KeyCode::Char('v') => attach(app, true),
        // g for "go to editor": e (extend) and c (capture) were taken.
        KeyCode::Char('g') => open_editor_selected(app).await,
        KeyCode::Char('x') => match app.workspace() {
            Some(ws) => {
                app.modal = Some(Modal::Confirm {
                    prompt: format!("reap {}?", ws.name),
                    detail: "A final shadow snapshot is taken first, so committed \
                             and uncommitted work survives in the shadow origin. \
                             The container and its volumes do not."
                        .to_owned(),
                    action: ConfirmAction::Reap {
                        id: ws.id.clone(),
                        name: ws.name.clone(),
                    },
                });
            }
            None => app.say("no workspace selected", FlashLevel::Bad),
        },
        KeyCode::Char('h') => open_history(app).await,
        KeyCode::Char('c') => capture(app).await,
        KeyCode::Char('p') => toggle_pin(app).await,
        KeyCode::Char('e') => extend_lease(app).await,
        KeyCode::Char('f') => fetch_mirror(app).await,
        _ => {}
    }
}

/// What a submitted input line asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    /// Also what an empty line means: dropping into a window is the default
    /// action, not a command you have to know.
    Attach {
        task: Option<String>,
    },
    New {
        name: Option<String>,
    },
    /// Open a routed port in the local browser.
    Open {
        route: Option<String>,
    },
    /// Open a workspace in local VS Code, attached to its container.
    Code {
        workspace: Option<String>,
    },
    /// Open an ad-hoc window — a shell, a REPL, a `tail -f`.
    Window {
        name: Option<String>,
    },
    /// Start a daemon for this state directory.
    Up,
    Manage,
    Help,
    Quit,
    /// A slash followed by something that is not a command.
    Unknown(String),
    /// Text with no leading slash. Nothing here takes prose.
    Prose,
}

fn parse_command(line: &str) -> Command {
    let line = line.trim();
    if line.is_empty() {
        return Command::Attach { task: None };
    }
    let Some(rest) = line.strip_prefix('/') else {
        return Command::Prose;
    };
    let (name, argument) = match rest.split_once(char::is_whitespace) {
        Some((name, argument)) => (
            name,
            Some(argument.trim())
                .filter(|a| !a.is_empty())
                .map(ToOwned::to_owned),
        ),
        None => (rest, None),
    };
    match name {
        "attach" | "a" => Command::Attach { task: argument },
        "new" => Command::New { name: argument },
        "open" | "o" => Command::Open { route: argument },
        "code" => Command::Code {
            workspace: argument,
        },
        // `/w` is the tmux-shaped spelling, for muscle memory that already
        // exists.
        "window" | "w" => Command::Window { name: argument },
        "up" => Command::Up,
        "manage" => Command::Manage,
        "help" | "?" => Command::Help,
        "quit" | "q" => Command::Quit,
        other => Command::Unknown(other.to_owned()),
    }
}

/// Everything the input line understands, on one line — this doubles as the
/// `/help` output, so it can never drift from what a flash row can hold.
const HELP_LINE: &str = "enter opens the selected window · tab moves · alt-<n> jumps · \
                         /open [route] · /window [name] · /new · /code · /manage · /quit";

/// Take the input line and act on it.
async fn submit_input(app: &mut App) {
    let line = std::mem::take(&mut app.input);
    app.history_cursor = None;
    let trimmed = line.trim();
    // Deduplicating only against the last entry: pressing Up after submitting
    // the same command twice should not cost two presses.
    if !trimmed.is_empty() && app.history.last().map(String::as_str) != Some(trimmed) {
        app.history.push(trimmed.to_owned());
    }
    match parse_command(trimmed) {
        Command::Attach { task } => attach_first_live(app, task),
        Command::New { name } => create_workspace(app, name, None).await,
        Command::Open { route } => open_route(app, route.as_deref()),
        Command::Code { workspace } => open_editor_named(app, workspace).await,
        Command::Window { name } => open_adhoc_window(app, name).await,
        Command::Up => start_daemon(app).await,
        Command::Manage => app.view = View::Manage,
        Command::Help => app.say(HELP_LINE, FlashLevel::Good),
        Command::Quit => app.quit = true,
        Command::Unknown(name) => app.say(
            format!("/{name} is not a command — /help lists them"),
            FlashLevel::Bad,
        ),
        Command::Prose => {
            app.say("commands start with / — /help lists them", FlashLevel::Bad);
        }
    }
}

/// Open a routed port in the local browser.
///
/// With no name, the only route when there is one — asking someone to name
/// the single thing on screen is a keystroke tax. With several, the name is
/// required, because guessing which of three services you meant is worse than
/// asking.
fn open_route(app: &mut App, route: Option<&str>) {
    let routes = app.routes();
    if routes.is_empty() {
        app.say(
            "nothing routed — declare ports in [routes] and re-create the workspace",
            FlashLevel::Bad,
        );
        return;
    }
    let chosen = match route {
        Some(name) => routes.iter().find(|(candidate, _)| *candidate == name),
        None if routes.len() == 1 => routes.first(),
        None => None,
    };
    let Some((name, url)) = chosen else {
        let known: Vec<&str> = routes.iter().map(|(name, _)| *name).collect();
        app.say(
            match route {
                Some(name) => format!("no route called {name} — there is {}", known.join(", ")),
                None => format!("which one? {}", known.join(", ")),
            },
            FlashLevel::Bad,
        );
        return;
    };
    let (name, url) = ((*name).to_owned(), (*url).to_owned());
    match open_in_browser(&url) {
        Ok(()) => app.say(format!("opening {name} — {url}"), FlashLevel::Good),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

/// Hand a URL to the platform's opener.
///
/// Spawned and disowned: the opener is often a launcher that exits instantly
/// and sometimes a browser that does not, and waiting on either would hang
/// the UI on a keystroke that is supposed to be instant.
fn open_in_browser(url: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    let mut command = {
        // Through `cmd /c start`, whose first quoted argument is the window
        // title — the empty "" is not decoration, and without it a quoted URL
        // becomes the title and nothing opens.
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "start", "", url]);
        // No console window for the launcher.
        #[expect(
            clippy::unreadable_literal,
            reason = "the Win32 constant's own spelling"
        )]
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
        .spawn()
        .with_context(|| format!("opening {url}"))
        .map(drop)
}

/// `/window [name]`: an ad-hoc tmux window in the primary workspace.
async fn open_adhoc_window(app: &mut App, name: Option<String>) {
    let Some(ws) = app.primary_workspace().map(|ws| ws.name.clone()) else {
        app.say("no workspace yet", FlashLevel::Bad);
        return;
    };
    match name {
        // Named on the command line: open it and go.
        Some(name) => create_session(app, &ws, &name, None).await,
        // Unnamed: the form, because an ad-hoc window without a name is
        // reachable only by an index that shifts as windows come and go.
        None => app.modal = Some(Modal::new_session(ws)),
    }
}

/// `alt-<n>`: attach straight into the window tmux calls `n`.
fn attach_window_by_index(app: &mut App, index: u32) {
    let Some(window) = app.windows.iter().find(|w| w.index == Some(index)).cloned() else {
        app.say(format!("no window {index}"), FlashLevel::Bad);
        return;
    };
    // Move the cursor there too: the next bare Enter should mean the window
    // you just jumped to, not the one you left.
    if let Some(row) = app.windows.iter().position(|w| w.name == window.name) {
        app.window_cursor = row;
        app.window_focus = true;
    }
    attach_named_window(app, &window.name);
}

/// Queue an attach into a named window of the primary workspace.
fn attach_named_window(app: &mut App, task: &str) {
    let Some(ws) = app.primary_workspace() else {
        app.say("no workspace yet", FlashLevel::Bad);
        return;
    };
    app.suspend = Some(Suspend::Attach {
        id: ws.id.clone(),
        name: ws.name.clone(),
        task: Some(task.to_owned()),
        read_only: false,
    });
}

/// Attach read-write, into a named window or the one under the cursor.
///
/// A bare Enter means "open what is selected", because the windows pane is on
/// screen with a cursor in it and the alternative — always landing in the
/// first window regardless of what is highlighted — would make the cursor a
/// decoration.
fn attach_first_live(app: &mut App, task: Option<String>) {
    // Nothing named, and a window is selected: that is the one.
    if task.is_none()
        && let Some(window) = app.selected_window().map(|w| w.name.clone())
        && app.primary_workspace().is_some_and(attachable)
    {
        attach_named_window(app, &window);
        return;
    }

    let live = app.snapshot.workspaces.iter().find(|ws| attachable(ws));
    let Some(ws) = live else {
        if app
            .snapshot
            .workspaces
            .iter()
            .any(|ws| ws.state.to_string() == "provisioning")
        {
            app.say("still provisioning — try again shortly", FlashLevel::Bad);
        } else {
            app.say(
                "nothing to attach to — /new spins up a workspace",
                FlashLevel::Bad,
            );
        }
        return;
    };
    // A named task lands in that window; otherwise the first observed task,
    // like the dashboard's `a`; with neither the session itself is the shell.
    let task = task.or_else(|| {
        ws.observation
            .as_ref()
            .and_then(|o| o.tasks.first())
            .map(|t| t.name.clone())
    });
    app.suspend = Some(Suspend::Attach {
        id: ws.id.clone(),
        name: ws.name.clone(),
        task,
        read_only: false,
    });
}

async fn handle_modal_key(app: &mut App, key: KeyEvent) {
    let is_confirm = matches!(app.modal, Some(Modal::Confirm { .. }));
    let is_help = matches!(app.modal, Some(Modal::Help));
    let is_history = matches!(app.modal, Some(Modal::History { .. }));
    let is_picker = matches!(app.modal, Some(Modal::PickDirectory { .. }));
    // Both navigate rather than type, so neither takes characters as input.
    let is_list = is_history || is_picker;

    match key.code {
        KeyCode::Esc => app.modal = None,
        KeyCode::Char('q') if is_help || is_list => app.modal = None,

        KeyCode::Down | KeyCode::Char('j') if is_list => {
            if let Some(m) = &mut app.modal {
                m.move_cursor(1);
            }
        }
        KeyCode::Up | KeyCode::Char('k') if is_list => {
            if let Some(m) = &mut app.modal {
                m.move_cursor(-1);
            }
        }
        KeyCode::Left | KeyCode::Backspace | KeyCode::Char('h') if is_picker => {
            if let Some(m) = &mut app.modal {
                m.ascend();
            }
        }
        KeyCode::Enter | KeyCode::Right | KeyCode::Char('l') if is_picker => {
            // `descend` yields a directory only for the "use this" row; every
            // other row just moves the browser.
            let chosen = app.modal.as_mut().and_then(Modal::descend);
            if let Some(dir) = chosen {
                register_project(app, dir).await;
            }
        }
        KeyCode::Enter if is_history => revive_from_capture(app).await,
        _ if is_list => {}

        KeyCode::Char('n') if is_confirm => app.modal = None,
        KeyCode::Char('y') if is_confirm => {
            let action = match app.modal.take() {
                Some(Modal::Confirm { action, .. }) => Some(action),
                other => {
                    app.modal = other;
                    None
                }
            };
            match action {
                Some(ConfirmAction::Reap { id, name }) => reap(app, &id, &name).await,
                Some(ConfirmAction::Install) => install_now(app),
                None => {}
            }
        }
        _ if is_confirm || is_help => {}

        KeyCode::Enter => submit_modal(app).await,
        KeyCode::Tab | KeyCode::Down => {
            if let Some(m) = &mut app.modal {
                m.next_field();
            }
        }
        KeyCode::BackTab | KeyCode::Up => {
            if let Some(m) = &mut app.modal {
                m.previous_field();
            }
        }
        KeyCode::Backspace => {
            if let Some(m) = &mut app.modal {
                m.backspace();
            }
        }
        KeyCode::Char(ch) => {
            if let Some(m) = &mut app.modal {
                m.type_char(ch);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Actions

async fn submit_modal(app: &mut App) {
    let Some(modal) = app.modal.take() else {
        return;
    };
    match modal {
        Modal::NewWorkspace { .. } => {
            let name = modal_field(&modal, 0);
            let branch = modal_field(&modal, 1);
            create_workspace(app, name, branch).await;
        }
        Modal::NewSession { ref workspace, .. } => {
            let Some(session) = modal_field(&modal, 0) else {
                app.say("a session needs a name", FlashLevel::Bad);
                app.modal = Some(modal);
                return;
            };
            let command = modal_field(&modal, 1);
            let workspace = workspace.clone();
            create_session(app, &workspace, &session, command.as_deref()).await;
        }
        other => app.modal = Some(other),
    }
}

fn modal_field(modal: &Modal, index: usize) -> Option<String> {
    modal.field(index)
}

async fn start_daemon(app: &mut App) {
    app.say("starting a daemon…", FlashLevel::Working);
    match crate::spawn_daemon().await {
        Ok(()) => {
            app.say("daemon up", FlashLevel::Good);
            refresh(app).await;
        }
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

async fn create_workspace(app: &mut App, name: Option<String>, branch: Option<String>) {
    let Some(ns) = app.namespace().map(|n| n.name.clone()) else {
        app.say(
            "no namespace — run `envmux up` in a repository",
            FlashLevel::Bad,
        );
        return;
    };
    app.say("provisioning…", FlashLevel::Working);
    let body = serde_json::json!({
        "repo": null, "branch": branch, "name": name, "overrides": null,
    });
    match client::post(&format!("/v1/namespaces/{ns}/workspaces"), body).await {
        Ok(resp) if resp.status == 200 || resp.status == 202 => {
            let created: Option<dto::CreateWorkspaceResponse> = resp.json().ok();
            let message = created.map_or_else(
                || "workspace provisioning".to_owned(),
                |c| {
                    if c.reused {
                        // Worth saying: asking for a name that already exists
                        // hands back the existing one rather than a new one.
                        format!("{} already existed — reusing it", c.workspace.name)
                    } else {
                        format!("{} provisioning", c.workspace.name)
                    }
                },
            );
            app.say(message, FlashLevel::Good);
            refresh(app).await;
        }
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

/// The tmux invocation that opens an ad-hoc window.
///
/// `-d` creates it without pulling the session's focus across; the attach that
/// follows selects it by name. The window must be *named*, because that name
/// is how `attach --task` finds it again after a detach — an unnamed window
/// would be reachable only by an index that shifts as other windows come and
/// go.
fn new_window_cmd(session: &str, command: Option<&str>) -> Vec<String> {
    let mut cmd = vec![
        "tmux".to_owned(),
        "new-window".to_owned(),
        "-d".to_owned(),
        "-t".to_owned(),
        format!("{}:", envmux_tmux::SESSION),
        "-n".to_owned(),
        session.to_owned(),
    ];
    match command {
        // Through a login shell, so the field takes a pipeline rather than
        // only a bare executable, and so the image's profile is applied.
        Some(command) => {
            cmd.extend(["bash".to_owned(), "-lc".to_owned(), command.to_owned()]);
        }
        None => cmd.extend(["bash".to_owned(), "-l".to_owned()]),
    }
    cmd
}

/// Create an ad-hoc tmux window in a workspace, then attach to it.
///
/// Declared tasks come from the config and are the same in every workspace
/// built from it. This is the other kind: a window you made, for whatever you
/// are doing right now. It is a `new-window` in the same session, so it shows
/// up in the status line beside the tasks and survives detaching.
async fn create_session(app: &mut App, workspace: &str, session: &str, command: Option<&str>) {
    let Some(ws) = app
        .snapshot
        .workspaces
        .iter()
        .find(|w| w.name == workspace)
        .cloned()
    else {
        app.say(format!("{workspace} is gone"), FlashLevel::Bad);
        return;
    };

    app.say(format!("opening {session}…"), FlashLevel::Working);
    let body = serde_json::json!({ "cmd": new_window_cmd(session, command) });
    match client::post(&format!("/v1/workspaces/{}/run", ws.id), body).await {
        Ok(resp) if resp.status == 200 => {
            let out: serde_json::Value = resp.json().unwrap_or_default();
            let code = out["exit_code"].as_i64().unwrap_or(0);
            if code != 0 {
                let stderr = out["stderr"].as_str().unwrap_or_default().trim().to_owned();
                app.say(
                    if stderr.is_empty() {
                        format!("tmux refused the window (exit {code})")
                    } else {
                        stderr
                    },
                    FlashLevel::Bad,
                );
                return;
            }
            app.suspend = Some(Suspend::Attach {
                id: ws.id.clone(),
                name: ws.name.clone(),
                task: Some(session.to_owned()),
                read_only: false,
            });
        }
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

fn attach(app: &mut App, read_only: bool) {
    let Some(ws) = app.workspace() else {
        app.say("no workspace selected", FlashLevel::Bad);
        return;
    };
    // Prefer the selected task's window; with none reported, the session
    // itself is still there and is exactly where a shell is wanted.
    let task = ws
        .observation
        .as_ref()
        .and_then(|o| o.tasks.first())
        .map(|t| t.name.clone());
    app.suspend = Some(Suspend::Attach {
        id: ws.id.clone(),
        name: ws.name.clone(),
        task,
        read_only,
    });
}

/// The manage view's `g`: VS Code on the selected workspace.
async fn open_editor_selected(app: &mut App) {
    let Some(ws) = app.workspace().cloned() else {
        app.say("no workspace selected", FlashLevel::Bad);
        return;
    };
    open_editor(app, ws).await;
}

/// The session view's `/code [workspace]`: named, or the first live one —
/// the same default an attach uses.
async fn open_editor_named(app: &mut App, workspace: Option<String>) {
    let found = match &workspace {
        Some(name) => app
            .snapshot
            .workspaces
            .iter()
            .find(|w| &w.name == name || &w.id == name)
            .cloned(),
        None => app
            .snapshot
            .workspaces
            .iter()
            .find(|ws| matches!(ws.state.to_string().as_str(), "ready" | "degraded"))
            .cloned(),
    };
    match found {
        Some(ws) => open_editor(app, ws).await,
        None => app.say(
            match workspace {
                Some(name) => format!("{name} is not a workspace here"),
                None => "nothing live to open — /new spins up a workspace".to_owned(),
            },
            FlashLevel::Bad,
        ),
    }
}

/// Launch VS Code attached into a workspace's container.
///
/// Non-blocking by design: the editor is handed off, the flash reports the
/// hand-off, and a late non-zero exit surfaces through the tick loop's watch
/// list. The terminal is never suspended — unlike an attach, the editor
/// lives in its own window.
async fn open_editor(app: &mut App, ws: dto::WorkspaceSummary) {
    app.say(
        format!("launching VS Code on {}…", ws.name),
        FlashLevel::Working,
    );
    let (editor_cfg, workdir) = editor_settings();
    match crate::editor::open(crate::editor::OpenSpec {
        namespace: &ws.namespace,
        workspace: &ws.name,
        editor: &editor_cfg,
        configured_workdir: workdir.as_deref(),
    })
    .await
    {
        Ok(opened) => {
            let message = match &opened.hint {
                Some(hint) => {
                    format!("VS Code launched — the attach happens in its window ({hint})")
                }
                None => "VS Code launched — the attach happens in its window".to_owned(),
            };
            app.editor_watch.push(opened.launched);
            app.say(message, FlashLevel::Good);
        }
        Err(e) => app.say(e.to_string(), FlashLevel::Bad),
    }
}

/// The `[editor]` section and workdir for the folder envmux was launched in.
///
/// The TUI may show workspaces of other namespaces, but the only config it
/// can honestly consult is this folder's; with none resolvable the defaults
/// apply and the folder chain falls back to the container's own WorkingDir.
fn editor_settings() -> (envmux_config::Editor, Option<String>) {
    std::env::current_dir()
        .ok()
        .and_then(|cwd| crate::repo_root(&cwd).ok())
        .and_then(|root| envmux_config::resolve_dir(&root).ok())
        .map_or((envmux_config::Editor::default(), None), |resolved| {
            (
                resolved.config.editor.clone(),
                Some(resolved.config.workspace.workdir.clone()),
            )
        })
}

async fn reap(app: &mut App, id: &str, name: &str) {
    app.say(format!("reaping {name}…"), FlashLevel::Working);
    match client::delete(&format!("/v1/workspaces/{id}")).await {
        Ok(resp) if resp.status == 202 || resp.status == 200 => {
            app.say(format!("{name} reaped"), FlashLevel::Good);
            refresh(app).await;
        }
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

/// Which step of the first-run path someone is on, if any.
///
/// `None` once there is a workspace: from there the key list is the useful
/// thing and a lecture is not.
fn onboarding(app: &App) -> Option<modal::Onboarding> {
    if !app.snapshot.daemon_ok {
        Some(modal::Onboarding::NoDaemon)
    } else if app.snapshot.namespaces.is_empty() {
        Some(modal::Onboarding::NoNamespace)
    } else if app.snapshot.workspaces.is_empty() {
        Some(modal::Onboarding::NoWorkspace)
    } else {
        None
    }
}

/// Browse for a project directory to register as a namespace.
///
/// Starts wherever envmux was launched from, which is usually the project in
/// question — and when it is not, it is at least somewhere familiar to browse
/// from.
fn open_project(app: &mut App) {
    let start = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    app.modal = Some(Modal::pick_directory(start));
}

/// Register a directory, then go straight into creating a workspace in it.
///
/// The two are one intention — "work on this project" — and stopping at a
/// registered namespace leaves someone looking at a list with nothing in it.
async fn register_project(app: &mut App, dir: std::path::PathBuf) {
    app.modal = None;
    app.say(
        format!("registering {}…", dir.display()),
        FlashLevel::Working,
    );
    let body = serde_json::json!({ "repo_dir": dir.display().to_string() });
    match client::post("/v1/namespaces", body).await {
        Ok(resp) if resp.status == 200 => {
            let registered: Option<dto::NamespaceSummary> = resp.json().ok();
            refresh(app).await;
            if let Some(ns) = registered {
                // Select what was just opened, so the workspace about to be
                // created lands in it rather than in whatever was selected
                // before.
                if let Some(index) = app
                    .snapshot
                    .namespaces
                    .iter()
                    .position(|candidate| candidate.name == ns.name)
                {
                    app.namespace_index = index;
                    app.workspace_index = 0;
                    refresh(app).await;
                }
                app.say(format!("{} ready", ns.name), FlashLevel::Good);
            }
            app.modal = Some(Modal::new_workspace());
        }
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

/// Ask before installing: it writes outside the directory envmux was unpacked
/// into and changes `PATH`, and neither is something to do on a mis-key.
fn confirm_install(app: &mut App) {
    let plan = match crate::install::plan(None) {
        Ok(plan) => plan,
        Err(e) => {
            app.say(format!("{e:#}"), FlashLevel::Bad);
            return;
        }
    };
    if plan.already_installed {
        app.say(
            format!("already installed at {}", plan.destination.display()),
            FlashLevel::Good,
        );
        return;
    }

    let mut detail = format!("Copies this executable to {}.", plan.dir.display());
    if plan.on_path {
        detail.push_str(" That directory is already on PATH.");
    } else {
        detail.push_str(" It will also be added to your user PATH.");
    }
    if plan.portable_source {
        detail.push_str(
            " This copy is portable, so its workspaces stay where they are — \
             the installed copy starts empty.",
        );
    }

    app.modal = Some(Modal::Confirm {
        prompt: "install envmux?".to_owned(),
        detail,
        action: ConfirmAction::Install,
    });
}

fn install_now(app: &mut App) {
    let plan = match crate::install::plan(None) {
        Ok(plan) => plan,
        Err(e) => {
            app.say(format!("{e:#}"), FlashLevel::Bad);
            return;
        }
    };
    match crate::install::run(&plan, true) {
        Ok(report) => app.say(
            if report.path_updated {
                format!(
                    "installed to {} and added to PATH — open a new terminal",
                    plan.dir.display()
                )
            } else {
                format!("installed to {}", plan.dir.display())
            },
            FlashLevel::Good,
        ),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

async fn open_history(app: &mut App) {
    let Some(ws) = app.workspace().cloned() else {
        app.say("no workspace selected", FlashLevel::Bad);
        return;
    };
    app.say("reading the shadow origin…", FlashLevel::Working);
    match client::get(&format!("/v1/workspaces/{}/captures", ws.id)).await {
        Ok(resp) if resp.status == 200 => match resp.json::<Vec<dto::CaptureSummary>>() {
            Ok(mut captures) => {
                // Newest first: the one you want is almost always the last one
                // taken.
                captures.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
                app.flash = None;
                app.modal = Some(Modal::History {
                    workspace: ws.name.clone(),
                    captures,
                    cursor: 0,
                });
            }
            Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
        },
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

/// Start a fresh workspace from a shadow snapshot.
///
/// Not a restore: the existing workspace is untouched and a new one is built
/// from the snapshot's commit. Workspaces are never upgraded in place, and
/// reviving over the top of a live one would be exactly that.
async fn revive_from_capture(app: &mut App) {
    let Some(capture) = app
        .modal
        .as_ref()
        .and_then(Modal::selected_capture)
        .cloned()
    else {
        return;
    };
    let Some(ns) = app.namespace().map(|n| n.name.clone()) else {
        app.say("no namespace selected", FlashLevel::Bad);
        return;
    };
    app.modal = None;
    app.say(
        format!(
            "reviving from {}…",
            &capture.commit_oid[..8.min(capture.commit_oid.len())]
        ),
        FlashLevel::Working,
    );
    let body = serde_json::json!({ "capture_id": capture.id, "name": null });
    match client::post(
        &format!("/v1/namespaces/{ns}/workspaces:from-capture"),
        body,
    )
    .await
    {
        Ok(resp) if resp.status == 200 || resp.status == 202 => {
            let created: Option<dto::CreateWorkspaceResponse> = resp.json().ok();
            let name = created.map_or_else(|| "workspace".to_owned(), |c| c.workspace.name);
            app.say(
                format!("{name} built from {}", capture.workspace_name),
                FlashLevel::Good,
            );
            refresh(app).await;
        }
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

async fn capture(app: &mut App) {
    let Some(ws) = app.workspace().cloned() else {
        app.say("no workspace selected", FlashLevel::Bad);
        return;
    };
    app.say("capturing…", FlashLevel::Working);
    match client::post(
        &format!("/v1/workspaces/{}/captures", ws.id),
        serde_json::json!({}),
    )
    .await
    {
        Ok(resp) if resp.status == 200 => app.say("snapshot captured", FlashLevel::Good),
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

async fn toggle_pin(app: &mut App) {
    let Some(ws) = app.workspace().cloned() else {
        app.say("no workspace selected", FlashLevel::Bad);
        return;
    };
    // Pinned workspaces have no death date; that is what pinning means.
    let pinned = ws.death_date.is_none();
    let path = if pinned {
        format!("/v1/workspaces/{}/unpin", ws.id)
    } else {
        format!("/v1/workspaces/{}/pin", ws.id)
    };
    match client::post(&path, serde_json::json!({})).await {
        Ok(resp) if resp.status == 200 => {
            app.say(
                if pinned {
                    format!("{} unpinned — the reaper can have it", ws.name)
                } else {
                    format!("{} pinned — it will outlive its lease", ws.name)
                },
                FlashLevel::Good,
            );
            refresh(app).await;
        }
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

async fn extend_lease(app: &mut App) {
    let Some(ws) = app.workspace().cloned() else {
        app.say("no workspace selected", FlashLevel::Bad);
        return;
    };
    let body = serde_json::json!({ "extend": "1h", "until": null, "pin": false, "unpin": false });
    match client::post(&format!("/v1/workspaces/{}/lease", ws.id), body).await {
        Ok(resp) if resp.status == 200 => {
            app.say(format!("{} gets another hour", ws.name), FlashLevel::Good);
            refresh(app).await;
        }
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

async fn fetch_mirror(app: &mut App) {
    let Some(ns) = app.namespace().map(|n| n.name.clone()) else {
        app.say("no namespace selected", FlashLevel::Bad);
        return;
    };
    app.say("fetching…", FlashLevel::Working);
    match client::post(
        &format!("/v1/namespaces/{ns}/mirror/fetch"),
        serde_json::json!({}),
    )
    .await
    {
        Ok(resp) if resp.status == 200 => app.say("mirror fetched", FlashLevel::Good),
        Ok(resp) => app.say(resp.error_message(), FlashLevel::Bad),
        Err(e) => app.say(format!("{e:#}"), FlashLevel::Bad),
    }
}

// ---------------------------------------------------------------------------
// Render

fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    frame.render_widget(
        ratatui::widgets::Block::default().style(theme::base()),
        area,
    );

    match app.view {
        View::Setup => setup::render(frame, area, app),
        View::Dispatch => dispatch::render(frame, area, app),
        View::Manage => render_manage(frame, area, app),
    }

    if let Some(m) = &app.modal {
        modal::render(frame, area, m, app.tick, onboarding(app));
    }
}

fn render_manage(frame: &mut Frame, area: Rect, app: &App) {
    // No banner: the panes are the point, and the wordmark has somewhere less
    // expensive to live — the detail pane, when it has nothing else to show.
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(6),
            Constraint::Length(1),
        ])
        .split(area);

    status_strip(frame, rows[0], app);
    body(frame, rows[1], app);
    footer(frame, rows[2], app);
}

/// The daemon link as a span: solid when reachable, blinking when not — a
/// dead daemon explains every other empty region on screen, and a static red
/// word is easy to read past.
fn link_indicator(app: &App) -> Span<'static> {
    if app.snapshot.daemon_ok {
        Span::styled(
            "◆ linked",
            Style::default()
                .fg(theme::ACID)
                .add_modifier(Modifier::BOLD),
        )
    } else {
        Span::styled(
            "◇ no carrier",
            Style::default()
                .fg(if app.tick % 10 < 5 {
                    theme::BLOOD
                } else {
                    theme::GHOST
                })
                .add_modifier(Modifier::BOLD),
        )
    }
}

fn status_strip(frame: &mut Frame, area: Rect, app: &App) {
    let (dir, kind) = envmux_core::state_dir_with_kind();
    let link = link_indicator(app);

    let live = app
        .snapshot
        .workspaces
        .iter()
        .filter(|w| !matches!(w.state.to_string().as_str(), "reaped" | "lost"))
        .count();

    let line = Line::from(vec![
        Span::styled(" ", theme::base()),
        link,
        Span::styled("  ◢ ", Style::default().fg(theme::NEON)),
        Span::styled(kind.as_str().to_owned(), Style::default().fg(theme::CYAN)),
        Span::styled(" ", theme::faint()),
        Span::styled(shorten(&dir.display().to_string(), 44), theme::faint()),
        Span::styled("  ◢ ", Style::default().fg(theme::NEON)),
        Span::styled(format!("{live} live"), Style::default().fg(theme::CYAN)),
    ]);
    frame.render_widget(Paragraph::new(line).style(theme::base()), area);
}

fn body(frame: &mut Frame, area: Rect, app: &App) {
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
        .split(area);

    // Namespaces are usually few, so they take a fixed slice and the detail
    // gets the rest rather than leaving a tall empty column.
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(namespace_pane_height(app, columns[0].height)),
            Constraint::Min(3),
        ])
        .split(columns[0]);
    namespaces_pane(frame, left[0], app);
    detail_pane(frame, left[1], app);

    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
        .split(columns[1]);
    workspaces_pane(frame, right[0], app);
    events_pane(frame, right[1], app);
}

fn namespaces_pane(frame: &mut Frame, area: Rect, app: &App) {
    let focused = app.focus == Focus::Namespaces;
    let items: Vec<ListItem> = app
        .snapshot
        .namespaces
        .iter()
        .map(|ns| {
            ListItem::new(Line::from(vec![
                Span::styled("▪ ", Style::default().fg(theme::NEON)),
                Span::styled(ns.name.clone(), Style::default().fg(theme::TEXT)),
                Span::styled(format!("  {}", ns.workspaces), theme::faint()),
            ]))
        })
        .collect();

    let mut list_state = ListState::default();
    list_state.select(Some(app.namespace_index));
    frame.render_stateful_widget(
        List::new(items)
            .block(chrome::block("namespaces", focused))
            .highlight_style(theme::selected()),
        area,
        &mut list_state,
    );
}

fn workspaces_pane(frame: &mut Frame, area: Rect, app: &App) {
    let focused = app.focus == Focus::Workspaces;
    let header = Row::new(
        ["name", "state", "branch", "dirty", "tasks", "expires"]
            .into_iter()
            .map(|h| Cell::from(h).style(Style::default().fg(theme::DIM))),
    );

    let rows: Vec<Row> = app
        .snapshot
        .workspaces
        .iter()
        .map(|ws| {
            let state = ws.state.to_string();
            let observation = ws.observation.as_ref();
            let dirty = observation.map_or_else(
                || "—".to_owned(),
                |o| {
                    if o.dirty {
                        o.dirty_files
                            .map_or_else(|| "dirty".to_owned(), |n| format!("{n}"))
                    } else {
                        "clean".to_owned()
                    }
                },
            );
            let tasks = observation.map_or_else(
                || "—".to_owned(),
                |o| {
                    let ready = o
                        .tasks
                        .iter()
                        .filter(|t| matches!(t.state, dto::TaskState::Ready))
                        .count();
                    format!("{ready}/{}", o.tasks.len())
                },
            );
            Row::new(vec![
                Cell::from(ws.name.clone()).style(
                    Style::default()
                        .fg(theme::TEXT)
                        .add_modifier(Modifier::BOLD),
                ),
                Cell::from(state.clone()).style(Style::default().fg(theme::state_colour(&state))),
                Cell::from(
                    observation
                        .and_then(|o| o.branch.clone())
                        .unwrap_or_else(|| ws.branch_requested.clone()),
                )
                .style(Style::default().fg(theme::CYAN)),
                Cell::from(dirty).style(theme::faint()),
                Cell::from(tasks).style(theme::faint()),
                // Relative, not absolute: "6d" answers the question the
                // column exists for; an RFC 3339 string does not.
                Cell::from(
                    ws.death_date
                        .as_ref()
                        .map_or_else(|| "pinned".to_owned(), |d| crate::output::until(&d.clone())),
                )
                .style(Style::default().fg(if ws.death_date.is_none() {
                    theme::CYAN
                } else {
                    theme::DIM
                })),
            ])
        })
        .collect();

    let mut table_state = TableState::default();
    table_state.select(Some(app.workspace_index));
    frame.render_stateful_widget(
        Table::new(
            rows,
            [
                Constraint::Percentage(24),
                // Wide enough for "provisioning" — a truncated state is the
                // one column you cannot afford to have to guess at.
                Constraint::Percentage(16),
                Constraint::Percentage(18),
                Constraint::Percentage(9),
                Constraint::Percentage(9),
                Constraint::Percentage(24),
            ],
        )
        .header(header)
        .block(chrome::block("workspaces", focused))
        .row_highlight_style(theme::selected())
        .highlight_symbol("▶ "),
        area,
        &mut table_state,
    );
}

fn detail_pane(frame: &mut Frame, area: Rect, app: &App) {
    // Follows the focus: with the namespace pane active, the interesting
    // detail is the namespace's, not whichever workspace happens to be under
    // the cursor in a list you are not looking at.
    if app.focus == Focus::Namespaces {
        namespace_detail(frame, area, app);
        return;
    }
    let block = chrome::block("detail", false);
    let Some(ws) = app.workspace() else {
        empty_pane(frame, area, block, "nothing selected");
        return;
    };

    let mut lines = vec![
        kv("id", &ws.id),
        kv("namespace", &ws.namespace),
        kv(
            "config",
            if ws.config_current {
                "current"
            } else {
                "drifted from the active file"
            },
        ),
    ];

    if let Some(o) = &ws.observation {
        lines.push(kv(
            "head",
            &o.head.clone().unwrap_or_else(|| "—".to_owned()),
        ));
        if let Some(flag) = &o.flagged_state {
            lines.push(Line::from(vec![
                Span::styled(format!("{:>10}  ", "flagged"), theme::faint()),
                Span::styled(
                    flag.clone(),
                    Style::default()
                        .fg(theme::AMBER)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
        }
        if !o.tasks.is_empty() {
            lines.push(Line::from(""));
            for task in &o.tasks {
                let state = format!("{:?}", task.state).to_lowercase();
                lines.push(Line::from(vec![
                    Span::styled(format!("{:>10}  ", task.name), theme::faint()),
                    Span::styled(
                        state.clone(),
                        Style::default().fg(theme::state_colour(&state)),
                    ),
                    Span::styled(
                        if task.restarts > 0 {
                            format!("  ×{}", task.restarts)
                        } else {
                            String::new()
                        },
                        Style::default().fg(theme::AMBER),
                    ),
                ]));
            }
        }
    }

    if !ws.routes.is_empty() {
        lines.push(Line::from(""));
        for (name, url) in &ws.routes {
            lines.push(Line::from(vec![
                Span::styled(format!("{name:>10}  "), theme::faint()),
                Span::styled(url.clone(), Style::default().fg(theme::CYAN)),
            ]));
        }
    }

    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            // Not trimmed: the key column is right-aligned with leading
            // spaces, and trimming would collapse it into a ragged list.
            .wrap(Wrap { trim: false })
            .style(theme::base()),
        area,
    );
}

/// The detail pane with nothing to detail: why it is empty, and the wordmark
/// in the room left under it.
///
/// This is the only place the logo appears. It costs nothing here — the pane
/// is blank either way — and it goes as soon as there is something to read.
fn empty_pane(
    frame: &mut Frame,
    area: Rect,
    block: ratatui::widgets::Block<'static>,
    message: &str,
) {
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    // Two rows held back for the message and a blank line under it, so the
    // mark can never push the explanation off the top of the pane.
    let spare = Rect {
        height: inner.height.saturating_sub(2),
        ..inner
    };
    let logo_height = chrome::logo_height(spare);
    let text_area = if logo_height > 0 {
        let split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(2), Constraint::Length(logo_height)])
            .split(inner);
        chrome::logo(frame, split[1]);
        split[0]
    } else {
        inner
    };

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(message.to_owned(), theme::faint())))
            .wrap(Wrap { trim: false })
            .style(theme::base()),
        text_area,
    );
}

/// How tall the namespace pane should be: enough for the list, capped so it
/// never crowds out the detail beneath it.
fn namespace_pane_height(app: &App, available: u16) -> u16 {
    let wanted = u16::try_from(app.snapshot.namespaces.len()).unwrap_or(u16::MAX);
    // Two rows of border, and never more than half the column.
    wanted
        .saturating_add(2)
        .clamp(3, available.saturating_sub(3).max(3))
        .min(available.div_ceil(2).max(3))
}

fn namespace_detail(frame: &mut Frame, area: Rect, app: &App) {
    let block = chrome::block("namespace", false);
    let Some(ns) = app.namespace() else {
        empty_pane(
            frame,
            area,
            block,
            "no namespaces — run `envmux up` in a repository",
        );
        return;
    };

    let mut lines = vec![
        kv(
            "remote",
            ns.repo_remote.as_deref().unwrap_or("— (no origin)"),
        ),
        kv("mirror", &ns.mirror_fetch_mode),
        kv(
            "fetched",
            &ns.mirror_last_fetch
                .as_ref()
                .map_or_else(|| "never".to_owned(), |t| crate::output::age(&t.clone())),
        ),
    ];

    if ns.services.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "no shared services declared",
            theme::faint(),
        )));
    } else {
        lines.push(Line::from(""));
        for service in &ns.services {
            lines.push(Line::from(vec![
                Span::styled(format!("{:>10}  ", service.name), theme::faint()),
                Span::styled(service.kind.clone(), Style::default().fg(theme::CYAN)),
            ]));
        }
    }

    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false })
            .style(theme::base()),
        area,
    );
}

/// One event, rendered the same way wherever it appears — the dashboard's
/// telemetry pane and the session feed are the same data.
fn event_line(event: &dto::EventRecord) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{:<5} ", event.level),
            Style::default().fg(theme::level_colour(&event.level)),
        ),
        Span::styled(format!("{:<10} ", event.component), theme::faint()),
        Span::styled(event.message.clone(), Style::default().fg(theme::TEXT)),
    ])
}

fn events_pane(frame: &mut Frame, area: Rect, app: &App) {
    let focused = app.focus == Focus::Events;
    let items: Vec<ListItem> = app
        .snapshot
        .events
        .iter()
        .map(|event| ListItem::new(event_line(event)))
        .collect();

    let mut list_state = ListState::default();
    list_state.select(Some(app.event_index));
    frame.render_stateful_widget(
        List::new(items)
            .block(chrome::block("telemetry", focused))
            .highlight_style(theme::selected()),
        area,
        &mut list_state,
    );
}

fn footer(frame: &mut Frame, area: Rect, app: &App) {
    if let Some(flash) = &app.flash {
        let (colour, mark) = match flash.level {
            FlashLevel::Good => (theme::ACID, "✔"),
            FlashLevel::Bad => (theme::BLOOD, "✖"),
            // A spinner, so a slow provision does not look like a hang.
            FlashLevel::Working => (
                theme::AMBER,
                ["◜", "◝", "◞", "◟"][usize::try_from(app.tick / 2 % 4).unwrap_or(0)],
            ),
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(format!(" {mark} "), Style::default().fg(colour)),
                Span::styled(
                    flash.message.clone(),
                    Style::default().fg(colour).add_modifier(Modifier::BOLD),
                ),
            ]))
            .style(theme::base()),
            area,
        );
        return;
    }

    // With nothing to report, the footer is key hints and nothing else —
    // each view hinting only the keys it actually answers to.
    let hints = match app.view {
        View::Setup => Line::from(vec![
            Span::styled(" ↑↓", theme::key()),
            Span::styled(" choose  ", theme::faint()),
            Span::styled("enter", theme::key()),
            Span::styled(" write it and start  ", theme::faint()),
            Span::styled("pgup/pgdn", theme::key()),
            Span::styled(" read it  ", theme::faint()),
            Span::styled("esc", theme::key()),
            Span::styled(" write nothing and quit ", theme::faint()),
        ]),
        View::Manage => Line::from(vec![
            Span::styled(" o", theme::key()),
            Span::styled(" open  ", theme::faint()),
            Span::styled("n", theme::key()),
            Span::styled(" new  ", theme::faint()),
            Span::styled("s", theme::key()),
            Span::styled(" session  ", theme::faint()),
            Span::styled("a", theme::key()),
            Span::styled(" attach  ", theme::faint()),
            Span::styled("g", theme::key()),
            Span::styled(" code  ", theme::faint()),
            Span::styled("h", theme::key()),
            Span::styled(" history  ", theme::faint()),
            Span::styled("x", theme::key()),
            Span::styled(" reap  ", theme::faint()),
            Span::styled("?", theme::key()),
            Span::styled(" keys ", theme::faint()),
        ]),
        View::Dispatch => Line::from(vec![
            Span::styled(" enter", theme::key()),
            Span::styled(" open  ", theme::faint()),
            Span::styled("tab", theme::key()),
            Span::styled(" window  ", theme::faint()),
            Span::styled("alt-n", theme::key()),
            Span::styled(" jump  ", theme::faint()),
            Span::styled("/open", theme::key()),
            Span::styled(" port  ", theme::faint()),
            Span::styled("/manage", theme::key()),
            Span::styled(" dashboard  ", theme::faint()),
            Span::styled("/help", theme::key()),
            Span::styled(" commands ", theme::faint()),
        ]),
    };
    frame.render_widget(Paragraph::new(hints).style(theme::base()), area);
}

fn kv(key: &str, value: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{key:>10}  "), theme::faint()),
        Span::styled(value.to_owned(), Style::default().fg(theme::TEXT)),
    ])
}

/// Trim from the right, keeping the head — the informative end of a name is
/// the start of it, which is the opposite of a path.
fn truncate(value: &str, max: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max {
        return value.to_owned();
    }
    let head: String = chars[..max.saturating_sub(1)].iter().collect();
    format!("{head}…")
}

/// Trim from the left, keeping the tail — the informative end of a path or a
/// timestamp is the right-hand side.
fn shorten(value: &str, max: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max {
        return value.to_owned();
    }
    let tail: String = chars[chars.len() - max.saturating_sub(1)..]
        .iter()
        .collect();
    format!("…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortening_keeps_the_tail_and_respects_the_budget() {
        assert_eq!(shorten("short", 10), "short");
        let long = "/very/long/path/to/the/state/directory";
        let cut = shorten(long, 12);
        assert_eq!(cut.chars().count(), 12);
        assert!(cut.starts_with('…'));
        assert!(long.ends_with(cut.trim_start_matches('…')));
    }

    #[test]
    fn shortening_handles_multibyte_without_splitting_a_character() {
        // Slicing by byte here would panic on a boundary.
        let value = "ø".repeat(40);
        assert_eq!(shorten(&value, 10).chars().count(), 10);
    }

    #[test]
    fn an_adhoc_session_opens_a_named_window_in_the_envmux_session() {
        let cmd = new_window_cmd("scratch", None);
        assert_eq!(
            cmd,
            vec![
                "tmux",
                "new-window",
                "-d",
                "-t",
                "envmux:",
                "-n",
                "scratch",
                "bash",
                "-l",
            ]
        );

        // A command goes through a login shell so a pipeline works.
        let piped = new_window_cmd("logs", Some("tail -f /var/log/app | grep ERROR"));
        assert_eq!(
            piped[7..],
            ["bash", "-lc", "tail -f /var/log/app | grep ERROR"]
        );

        // The command is a separate argv element, never spliced into a string:
        // that is what keeps a name or command with spaces or quotes from
        // being re-parsed on the way through.
        let awkward = new_window_cmd("my session", Some("echo \"hi there\"; rm -rf /nope"));
        assert!(awkward.contains(&"my session".to_owned()));
        assert!(awkward.contains(&"echo \"hi there\"; rm -rf /nope".to_owned()));
    }

    #[tokio::test]
    async fn keys_that_need_no_daemon_do_what_they_say() {
        let mut app = manage_app();
        app.snapshot.daemon_ok = true;

        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);

        handle_key(&mut app, press(KeyCode::Char('?'))).await;
        assert!(matches!(app.modal, Some(Modal::Help)));
        // Esc closes the overlay rather than quitting out from under it.
        handle_key(&mut app, press(KeyCode::Esc)).await;
        assert!(app.modal.is_none());
        assert!(!app.quit);

        handle_key(&mut app, press(KeyCode::Char('n'))).await;
        assert!(matches!(app.modal, Some(Modal::NewWorkspace { .. })));
        // Typing into a form must not be read as a global binding — 'q' here
        // is a character, not quit.
        handle_key(&mut app, press(KeyCode::Char('q'))).await;
        assert!(!app.quit);
        assert_eq!(
            app.modal.as_ref().and_then(|m| m.field(0)).as_deref(),
            Some("q")
        );
        handle_key(&mut app, press(KeyCode::Esc)).await;

        handle_key(&mut app, press(KeyCode::Tab)).await;
        assert_eq!(app.focus, Focus::Events);
        handle_key(&mut app, press(KeyCode::Char('1'))).await;
        assert_eq!(app.focus, Focus::Namespaces);

        handle_key(&mut app, press(KeyCode::Char('q'))).await;
        assert!(app.quit);
    }

    #[tokio::test]
    async fn a_reap_needs_confirming_and_the_confirmation_can_be_refused() {
        let mut app = manage_app();
        app.snapshot.workspaces = vec![super::preview::demo_app().snapshot.workspaces[0].clone()];

        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);
        handle_key(&mut app, press(KeyCode::Char('x'))).await;
        let Some(Modal::Confirm { prompt, .. }) = &app.modal else {
            panic!("reap did not ask first");
        };
        assert!(prompt.contains("wobbly-otter"));

        // 'n' backs out without touching anything.
        handle_key(&mut app, press(KeyCode::Char('n'))).await;
        assert!(app.modal.is_none());
        assert_eq!(app.snapshot.workspaces.len(), 1);
    }

    #[tokio::test]
    async fn install_asks_before_it_writes_anything() {
        // It copies files outside the directory envmux was unpacked into and
        // changes PATH. Neither should happen on a mis-key, and `I` is one
        // shift away from `i`.
        let mut app = manage_app();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('I'), KeyModifiers::NONE),
        )
        .await;
        let Some(Modal::Confirm { prompt, detail, .. }) = &app.modal else {
            panic!(
                "install did not ask first: {:?}",
                app.flash.map(|f| f.message)
            );
        };
        assert!(prompt.contains("install"));
        // And says where, since the default is somewhere nobody chose.
        assert!(
            detail.contains(&crate::install::default_dir().display().to_string()),
            "the prompt does not say where it will install: {detail}"
        );

        // Backing out leaves nothing behind.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE),
        )
        .await;
        assert!(app.modal.is_none());
    }

    #[tokio::test]
    async fn opening_a_project_starts_the_browser_rather_than_guessing() {
        let mut app = manage_app();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('o'), KeyModifiers::NONE),
        )
        .await;
        assert!(matches!(app.modal, Some(Modal::PickDirectory { .. })));
        // Typing must not leak into it: the picker navigates, and a stray
        // character should not silently do nothing visible either.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('z'), KeyModifiers::NONE),
        )
        .await;
        assert!(matches!(app.modal, Some(Modal::PickDirectory { .. })));
    }

    #[tokio::test]
    async fn opening_the_editor_with_nothing_selected_says_so() {
        // Rather than inspecting a container that cannot exist. The Docker
        // and spawn paths never run when P1 fails, so this is also the test
        // that `g` on an empty dashboard touches nothing.
        let mut app = manage_app();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('g'), KeyModifiers::NONE),
        )
        .await;
        assert!(matches!(
            &app.flash,
            Some(f) if f.level == FlashLevel::Bad && f.message.contains("no workspace")
        ));
        assert!(app.editor_watch.is_empty());

        // The session-view spelling with a name that is not there says which
        // name it looked for.
        let mut session = App::new(session_launch());
        open_editor_named(&mut session, Some("ghost".to_owned())).await;
        assert!(matches!(
            &session.flash,
            Some(f) if f.level == FlashLevel::Bad && f.message.contains("ghost")
        ));

        // And with nothing live at all, it points at /new.
        open_editor_named(&mut session, None).await;
        assert!(matches!(
            &session.flash,
            Some(f) if f.level == FlashLevel::Bad && f.message.contains("/new")
        ));
    }

    #[tokio::test]
    async fn asking_for_a_session_with_nothing_selected_says_so() {
        // Rather than opening a form that cannot be submitted.
        let mut app = manage_app();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE),
        )
        .await;
        assert!(app.modal.is_none());
        assert!(matches!(
            &app.flash,
            Some(f) if f.level == FlashLevel::Bad && f.message.contains("no workspace")
        ));
    }

    /// The ad-hoc session path against a real daemon: create the window, then
    /// ask tmux whether it is there.
    ///
    /// Every other test here stops at the request boundary, which would not
    /// notice the one thing most likely to be wrong — a tmux invocation that
    /// is accepted by the run endpoint and does nothing useful.
    ///
    /// ```console
    /// $ ENVMUX_STATE_DIR=... cargo test -p envmux-cli -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "needs a running daemon with a ready workspace: set ENVMUX_STATE_DIR"]
    async fn an_adhoc_session_really_appears_in_tmux() {
        let mut app = App::new(super::preview::configured_launch());
        refresh(&mut app).await;
        assert!(app.snapshot.daemon_ok, "no daemon on this state directory");

        // Any namespace with a live workspace will do.
        let mut chosen = None;
        for index in 0..app.snapshot.namespaces.len() {
            app.namespace_index = index;
            refresh(&mut app).await;
            if let Some(ws) = app
                .snapshot
                .workspaces
                .iter()
                .find(|w| w.state.to_string() == "ready")
            {
                chosen = Some(ws.clone());
                break;
            }
        }
        let workspace = chosen.expect("a ready workspace to open a session in");
        eprintln!("using {}/{}", workspace.namespace, workspace.name);

        let session = "tui-adhoc-probe";
        create_session(&mut app, &workspace.name, session, None).await;
        assert!(
            app.suspend.is_some(),
            "no attach queued; flash said: {:?}",
            app.flash.as_ref().map(|f| &f.message)
        );
        // Drop the queued attach: this test has no terminal to give it.
        app.suspend = None;

        let resp = client::post(
            &format!("/v1/workspaces/{}/run", workspace.id),
            serde_json::json!({ "cmd": ["tmux", "list-windows", "-t", envmux_tmux::SESSION] }),
        )
        .await
        .expect("listing tmux windows");
        let out: serde_json::Value = resp.json().expect("run output");
        let stdout = out["stdout"].as_str().unwrap_or_default();
        eprintln!("{stdout}");
        assert!(
            stdout.contains(session),
            "the window was not created; tmux reported:\n{stdout}"
        );

        // Leave the workspace as it was found.
        let _ = client::post(
            &format!("/v1/workspaces/{}/run", workspace.id),
            serde_json::json!({
                "cmd": ["tmux", "kill-window", "-t", format!("{}:{session}", envmux_tmux::SESSION)]
            }),
        )
        .await;
    }

    /// The history overlay against a real daemon: capture, then open it and
    /// see the capture that was just taken.
    ///
    /// Exercises the two calls the overlay makes — `POST /captures` and
    /// `GET /captures` — and the deserialisation between them, which is the
    /// part a DTO change would silently break.
    #[tokio::test]
    #[ignore = "needs a running daemon with a ready workspace: set ENVMUX_STATE_DIR"]
    async fn shadow_history_shows_a_capture_that_was_just_taken() {
        let mut app = App::new(super::preview::configured_launch());
        refresh(&mut app).await;
        assert!(app.snapshot.daemon_ok, "no daemon on this state directory");

        for index in 0..app.snapshot.namespaces.len() {
            app.namespace_index = index;
            refresh(&mut app).await;
            if let Some(position) = app
                .snapshot
                .workspaces
                .iter()
                .position(|w| w.state.to_string() == "ready")
            {
                app.workspace_index = position;
                break;
            }
        }
        let name = app
            .workspace()
            .map(|w| w.name.clone())
            .expect("a ready workspace");
        eprintln!("capturing {name}");

        capture(&mut app).await;
        assert!(
            matches!(&app.flash, Some(f) if f.level == FlashLevel::Good),
            "capture failed: {:?}",
            app.flash.as_ref().map(|f| &f.message)
        );

        open_history(&mut app).await;
        let Some(Modal::History { captures, .. }) = &app.modal else {
            panic!(
                "history did not open: {:?}",
                app.flash.as_ref().map(|f| &f.message)
            );
        };
        assert!(!captures.is_empty(), "no snapshots after capturing one");
        for capture in captures.iter().take(3) {
            eprintln!(
                "  {} {} torn={}",
                capture.captured_at, capture.commit_oid, capture.torn
            );
        }
        // Newest first is what the overlay promises.
        assert!(
            captures
                .windows(2)
                .all(|w| w[0].captured_at >= w[1].captured_at),
            "snapshots are not newest-first"
        );
    }

    /// Opening a project directory against a real daemon: register it, and
    /// land on the new namespace with the workspace form already open.
    ///
    /// The half that unit tests cannot reach is whether the daemon accepts
    /// `repo_dir` for a directory the CLI was not launched from — which is the
    /// whole point of a picker.
    ///
    /// ```console
    /// $ ENVMUX_STATE_DIR=… ENVMUX_TEST_REPO=/path/to/repo \
    ///     cargo test -p envmux-cli -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "needs a running daemon and ENVMUX_TEST_REPO pointing at a repository"]
    async fn opening_a_directory_registers_it_and_offers_a_workspace() {
        let repo =
            std::path::PathBuf::from(std::env::var("ENVMUX_TEST_REPO").expect("ENVMUX_TEST_REPO"));
        let mut app = App::new(super::preview::configured_launch());
        refresh(&mut app).await;
        assert!(app.snapshot.daemon_ok, "no daemon on this state directory");

        // The picker hands `register_project` a directory; do the same.
        register_project(&mut app, repo.clone()).await;

        assert!(
            matches!(&app.flash, Some(f) if f.level != FlashLevel::Bad),
            "registering failed: {:?}",
            app.flash.as_ref().map(|f| &f.message)
        );
        // Landing on the namespace that was just opened is the point: creating
        // a workspace next must not put it somewhere else.
        let selected = app
            .namespace()
            .map(|ns| ns.name.clone())
            .expect("a namespace");
        eprintln!("selected namespace {selected}");
        let expected = repo
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase().replace(['.', ' '], "-"))
            .expect("a directory name");
        assert!(
            selected == expected || app.snapshot.namespaces.iter().any(|n| n.name == selected),
            "landed on {selected}, expected the one just opened"
        );
        assert!(
            matches!(app.modal, Some(Modal::NewWorkspace { .. })),
            "did not offer to create a workspace"
        );
    }

    fn session_launch() -> Launch {
        Launch {
            namespace: Some("envmux".to_owned()),
            ..super::preview::configured_launch()
        }
    }

    /// The dashboard, where the single-letter bindings live. Dispatch sends
    /// every letter to the input line, so a test of `n` or `x` has to say
    /// which view it means.
    fn manage_app() -> App {
        App::new(Launch {
            manage: true,
            ..super::preview::configured_launch()
        })
    }

    #[test]
    fn the_first_view_matches_how_envmux_was_launched() {
        // Dispatch is where `envmux` lands in a configured project, with or
        // without a namespace to start from: the landing page is the thing
        // that reports there not being one yet.
        assert_eq!(
            App::new(super::preview::configured_launch()).view,
            View::Dispatch
        );
        assert_eq!(App::new(session_launch()).view, View::Dispatch);
        assert_eq!(
            App::new(Launch {
                manage: true,
                ..session_launch()
            })
            .view,
            View::Manage
        );
    }

    #[test]
    fn a_folder_with_no_configuration_lands_on_setup_first() {
        // There is nothing to build a session from, so the first screen is
        // the one that decides what it should be — even when the launch asked
        // for the dashboard, which would be a dashboard of nothing.
        let bare = std::env::temp_dir().join(format!("envmux-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).expect("scratch dir");

        let app = App::new(Launch {
            root: bare.clone(),
            ..Launch::default()
        });
        assert_eq!(app.view, View::Setup);
        assert!(app.setup.is_some());

        let dashboard = App::new(Launch {
            root: bare.clone(),
            manage: true,
            ..Launch::default()
        });
        assert_eq!(dashboard.view, View::Setup);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn the_window_list_keeps_the_last_probe_between_probes() {
        // The two halves go stale at different rates: what windows exist
        // changes rarely, what their tasks are doing changes constantly. A
        // re-merge that rebuilt the tmux half from the rendered rows would
        // quietly lose which panes had died.
        let mut app = App::new(super::preview::configured_launch());
        app.window_live = windows::parse_windows("0\tterminal\t1\t0\n1\tdev\t0\t1\n");
        collect_windows(&mut app);
        assert_eq!(app.windows.len(), 2);
        assert_eq!(app.windows[1].state, "exited");

        // Another tick with no probe in flight must not resurrect it.
        collect_windows(&mut app);
        assert_eq!(app.windows[1].state, "exited");
        assert_eq!(app.windows[1].index, Some(1));
    }

    #[test]
    fn moving_between_windows_wraps_in_both_directions() {
        let mut app = App::new(super::preview::configured_launch());
        app.window_live = windows::parse_windows("0\ta\t1\t0\n1\tb\t0\t0\n2\tc\t0\t0\n");
        collect_windows(&mut app);

        // A short list read past the end should come back to the top rather
        // than stopping dead, which costs a keystroke to even notice.
        app.move_window_cursor(1);
        app.move_window_cursor(1);
        assert_eq!(app.window_cursor, 2);
        app.move_window_cursor(1);
        assert_eq!(app.window_cursor, 0);
        app.move_window_cursor(-1);
        assert_eq!(app.window_cursor, 2);
        // And moving is itself what gives the pane the keyboard.
        assert!(app.window_focus);
    }

    #[tokio::test]
    async fn alt_digit_jumps_to_the_window_tmux_calls_that_number() {
        // The numbers on screen are tmux's, so `alt-2` here and `prefix 2`
        // inside have to mean the same window.
        let mut app = App::new(session_launch());
        app.snapshot.workspaces = super::preview::demo_app().snapshot.workspaces;
        app.window_live = windows::parse_windows("0\tterminal\t1\t0\n4\tdev\t0\t0\n");
        collect_windows(&mut app);

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('4'), KeyModifiers::ALT),
        )
        .await;
        let Some(Suspend::Attach { task, .. }) = &app.suspend else {
            panic!("alt-4 queued no attach: {:?}", app.flash.map(|f| f.message));
        };
        assert_eq!(task.as_deref(), Some("dev"));
        // The cursor follows, so the next bare enter means where you just
        // went rather than where you left.
        assert_eq!(app.selected_window().map(|w| w.name.as_str()), Some("dev"));
        app.suspend = None;

        // A number nothing answers to says so rather than doing something
        // else quietly.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('7'), KeyModifiers::ALT),
        )
        .await;
        assert!(app.suspend.is_none());
        assert!(matches!(&app.flash, Some(f) if f.message.contains("no window 7")));
    }

    #[tokio::test]
    async fn opening_a_port_needs_a_name_only_when_there_is_a_choice() {
        let mut app = App::new(session_launch());
        // Nothing routed at all is its own answer, and it says what to do.
        open_route(&mut app, None);
        assert!(matches!(
            &app.flash,
            Some(f) if f.level == FlashLevel::Bad && f.message.contains("[routes]")
        ));

        let mut workspace = super::preview::demo_app().snapshot.workspaces[0].clone();
        workspace.routes.insert(
            "api".to_owned(),
            "https://envmux_wobbly-otter_api.strigops.xyz".to_owned(),
        );
        app.snapshot.workspaces = vec![workspace];

        // Two routes and no name: asking beats guessing which you meant, and
        // the question lists the options.
        open_route(&mut app, None);
        let message = app
            .flash
            .as_ref()
            .map(|f| f.message.clone())
            .unwrap_or_default();
        assert!(message.contains("which one?"), "{message}");
        assert!(
            message.contains("api") && message.contains("web"),
            "{message}"
        );

        // A name that is not there says which name it looked for.
        open_route(&mut app, Some("ghost"));
        assert!(matches!(&app.flash, Some(f) if f.message.contains("ghost")));
    }

    #[test]
    fn constructing_an_app_starts_nothing() {
        // `new` runs in tests with no daemon, no Docker and no runtime. A
        // constructor that forks a daemon is one nobody can call safely, so
        // the boot is the event loop's to start.
        let app = App::new(super::preview::configured_launch());
        assert!(app.boot.settled(), "an unstarted boot must not spin");
        assert!(app.boot.failure().is_none());
        assert!(app.windows.is_empty());
    }

    #[test]
    fn the_command_line_grammar_is_small_and_exact() {
        assert_eq!(parse_command(""), Command::Attach { task: None });
        assert_eq!(parse_command("   "), Command::Attach { task: None });
        assert_eq!(parse_command("/attach"), Command::Attach { task: None });
        assert_eq!(
            parse_command("/attach api"),
            Command::Attach {
                task: Some("api".to_owned())
            }
        );
        assert_eq!(
            parse_command("/new fixup"),
            Command::New {
                name: Some("fixup".to_owned())
            }
        );
        assert_eq!(parse_command("/code"), Command::Code { workspace: None });
        assert_eq!(
            parse_command("/code otter"),
            Command::Code {
                workspace: Some("otter".to_owned())
            }
        );
        assert_eq!(parse_command("/manage"), Command::Manage);
        assert_eq!(parse_command("/help"), Command::Help);
        assert_eq!(parse_command("/quit"), Command::Quit);
        assert_eq!(parse_command("/nope"), Command::Unknown("nope".to_owned()));
        // Prose is not a command; it gets a hint, never a guess.
        assert_eq!(parse_command("hello there"), Command::Prose);
    }

    #[tokio::test]
    async fn session_keys_are_typing_not_bindings() {
        let mut app = App::new(session_launch());
        app.snapshot.daemon_ok = true;
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);

        // 'q' is a letter here, not quit.
        handle_key(&mut app, press(KeyCode::Char('q'))).await;
        assert!(!app.quit);
        assert_eq!(app.input, "q");

        // Esc clears the line and nothing else.
        handle_key(&mut app, press(KeyCode::Esc)).await;
        assert!(app.input.is_empty());
        assert!(!app.quit);

        // Ctrl-C is the one key that is not typing.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
        )
        .await;
        assert!(app.quit);
    }

    #[tokio::test]
    async fn slash_quit_quits_and_an_unknown_command_points_at_help() {
        let mut app = App::new(session_launch());
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);

        for ch in "/frobnicate".chars() {
            handle_key(&mut app, press(KeyCode::Char(ch))).await;
        }
        handle_key(&mut app, press(KeyCode::Enter)).await;
        assert!(!app.quit);
        assert!(app.input.is_empty(), "the line was not consumed");
        assert!(matches!(
            &app.flash,
            Some(f) if f.level == FlashLevel::Bad && f.message.contains("/help")
        ));

        for ch in "/quit".chars() {
            handle_key(&mut app, press(KeyCode::Char(ch))).await;
        }
        handle_key(&mut app, press(KeyCode::Enter)).await;
        assert!(app.quit);
    }

    #[tokio::test]
    async fn manage_is_a_command_away_and_esc_comes_back() {
        let mut app = App::new(session_launch());
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);
        for ch in "/manage".chars() {
            handle_key(&mut app, press(KeyCode::Char(ch))).await;
        }
        handle_key(&mut app, press(KeyCode::Enter)).await;
        assert_eq!(app.view, View::Manage);

        // Esc returns to the dispatch view it was opened over, and does not
        // quit out from under someone who meant "back".
        handle_key(&mut app, press(KeyCode::Esc)).await;
        assert_eq!(app.view, View::Dispatch);
        assert!(!app.quit);

        // The same for a launch that opened straight into the dashboard:
        // there is always a dispatch view behind it now.
        let mut bare = App::new(Launch {
            manage: true,
            ..super::preview::configured_launch()
        });
        handle_key(&mut bare, press(KeyCode::Esc)).await;
        assert_eq!(bare.view, View::Dispatch);
        assert!(!bare.quit);
    }

    #[tokio::test]
    async fn enter_on_an_empty_line_drops_into_the_workspace() {
        let mut app = App::new(session_launch());
        app.snapshot.daemon_ok = true;
        app.snapshot.workspaces = super::preview::demo_app().snapshot.workspaces;
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);

        handle_key(&mut app, press(KeyCode::Enter)).await;
        let Some(Suspend::Attach {
            name, read_only, ..
        }) = &app.suspend
        else {
            panic!(
                "no attach queued: {:?}",
                app.flash.as_ref().map(|f| &f.message)
            );
        };
        // First attachable workspace, read-write — the default default.
        assert_eq!(name.as_str(), "wobbly-otter");
        assert!(!*read_only);
    }

    #[tokio::test]
    async fn attach_takes_a_task_and_an_empty_environment_says_so() {
        let mut app = App::new(session_launch());
        app.snapshot.workspaces = super::preview::demo_app().snapshot.workspaces;
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);
        for ch in "/attach worker".chars() {
            handle_key(&mut app, press(KeyCode::Char(ch))).await;
        }
        handle_key(&mut app, press(KeyCode::Enter)).await;
        let Some(Suspend::Attach { task, .. }) = &app.suspend else {
            panic!("no attach queued");
        };
        assert_eq!(task.as_deref(), Some("worker"));

        // With nothing running, Enter explains rather than failing silently.
        let mut empty = App::new(session_launch());
        handle_key(&mut empty, press(KeyCode::Enter)).await;
        assert!(empty.suspend.is_none());
        assert!(matches!(&empty.flash, Some(f) if f.level == FlashLevel::Bad));
    }

    #[test]
    fn input_history_recalls_and_walks_forward_to_blank() {
        let mut app = App::new(session_launch());
        app.history = vec!["/new a".to_owned(), "/attach".to_owned()];

        app.history_previous();
        assert_eq!(app.input, "/attach");
        app.history_previous();
        assert_eq!(app.input, "/new a");
        // Pinned at the oldest rather than wrapping.
        app.history_previous();
        assert_eq!(app.input, "/new a");

        app.history_next();
        assert_eq!(app.input, "/attach");
        // Past the newest is a blank line again, ready to type into.
        app.history_next();
        assert_eq!(app.input, "");
    }

    #[test]
    fn moving_a_selection_stays_inside_the_list() {
        let mut app = App::new(super::preview::configured_launch());
        app.focus = Focus::Namespaces;
        // Empty lists must not move, and must not panic doing it.
        app.move_selection(1);
        assert_eq!(app.namespace_index, 0);
        app.move_selection(-5);
        assert_eq!(app.namespace_index, 0);
    }

    #[test]
    fn changing_namespace_resets_the_workspace_cursor() {
        // Index 3 of one namespace's workspaces has nothing to do with index 3
        // of another's; keeping it would silently select an unrelated row.
        let mut app = App::new(super::preview::configured_launch());
        app.workspace_index = 3;
        app.focus = Focus::Namespaces;
        app.snapshot.namespaces = vec![namespace("a"), namespace("b")];
        app.move_selection(1);
        assert_eq!(app.namespace_index, 1);
        assert_eq!(app.workspace_index, 0);
    }

    fn namespace(name: &str) -> dto::NamespaceSummary {
        dto::NamespaceSummary {
            name: name.to_owned(),
            repo_remote: None,
            created_at: "2026-01-01T00:00:00Z".parse().expect("timestamp"),
            mirror_last_fetch: None,
            mirror_fetch_mode: "periodic".to_owned(),
            workspaces: 0,
            services: Vec::new(),
        }
    }
}
