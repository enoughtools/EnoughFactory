//! The landing page: what this folder is, what is happening to it, and a
//! prompt.
//!
//! The old session view opened onto a workspace list and an event feed, which
//! is the right *content* and the wrong first impression: it assumed a session
//! that already existed, and everything that made one existed before the UI
//! did, behind four printed lines and several silent minutes.
//!
//! This view is up first and narrates instead. Top to bottom it answers the
//! questions in the order they get asked — where am I, is it working, what can
//! I open, what is it doing, what do I type — and each region gives up its
//! rows once it has nothing left to say. The boot checklist is gone the moment
//! the session is up; the ports pane appears only when something is routed.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, Paragraph, Wrap};

use super::boot::StepState;
use super::windows::Origin;
use super::{App, chrome, theme};

/// Rows the boot checklist needs: a border, one row per step, a border.
const CHECKLIST_ROWS: u16 = 6;

/// The whole view.
pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    // A checklist for a boot that has settled cleanly is four ticks nobody is
    // reading; the rows are worth more to the feed. A failed one stays, since
    // it is the only place the reason is written down.
    let booting = !app.boot.settled() || app.boot.failure().is_some();
    let checklist = if booting { CHECKLIST_ROWS } else { 0 };
    // The middle band holds windows and ports side by side. It is skipped
    // entirely until there is something to put in it, rather than drawing two
    // empty boxes over a session that has not started.
    let band = if app.windows.is_empty() && app.routes().is_empty() {
        0
    } else {
        u16::try_from(app.windows.len().max(app.routes().len()))
            .unwrap_or(6)
            .saturating_add(2)
            .clamp(3, 9)
    };

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),         // status strip
            Constraint::Length(4),         // context card
            Constraint::Length(checklist), // boot
            Constraint::Length(band),      // windows | ports
            Constraint::Min(0),            // activity
            Constraint::Length(1),         // flash / hints
            Constraint::Length(1),         // input
        ])
        .split(area);

    status_strip(frame, rows[0], app);
    context_card(frame, rows[1], app);
    if checklist > 0 {
        checklist_pane(frame, rows[2], app);
    }
    if band > 0 {
        // Ports get the larger share: a window row is a short name and a
        // state word, and a route is a whole URL that is useless truncated.
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(38), Constraint::Percentage(62)])
            .split(rows[3]);
        windows_pane(frame, columns[0], app);
        ports_pane(frame, columns[1], app);
    }
    activity_pane(frame, rows[4], app);
    super::footer(frame, rows[5], app);
    input_line(frame, rows[6], app);
}

/// One line: the link, and where this session's state lives.
fn status_strip(frame: &mut Frame, area: Rect, app: &App) {
    let (dir, kind) = envmux_core::state_dir_with_kind();
    let line = Line::from(vec![
        Span::styled(" ", theme::base()),
        super::link_indicator(app),
        Span::styled("  ◢ ", Style::default().fg(theme::NEON)),
        Span::styled(kind.as_str().to_owned(), Style::default().fg(theme::CYAN)),
        Span::styled(" ", theme::faint()),
        Span::styled(
            super::shorten(&dir.display().to_string(), 52),
            theme::faint(),
        ),
    ]);
    frame.render_widget(Paragraph::new(line).style(theme::base()), area);
}

/// Where you are, in the two lines it takes to say it.
///
/// The folder on one line because it is the thing you recognise; the facts
/// derived from it — namespace, branch, workspace — on the next, in that
/// order, because that is the order they are decided in.
fn context_card(frame: &mut Frame, area: Rect, app: &App) {
    let block = chrome::block("dispatch", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 {
        return;
    }

    let namespace = app.namespace_name().unwrap_or("—").to_owned();
    let branch = app.context.branch.clone().unwrap_or_else(|| "—".to_owned());
    let workspace = app
        .primary_workspace()
        .map(|ws| ws.name.clone())
        .or_else(|| app.boot.outcome().workspace.clone())
        .unwrap_or_else(|| "—".to_owned());

    let facts = Line::from(vec![
        fact_key("namespace"),
        // Never uppercased. It is an identifier the user chose or the
        // repository implied, and shouting it back at them makes it look like
        // a different string than the one in their config.
        fact_value(&namespace, theme::CYAN),
        fact_key("branch"),
        fact_value(&branch, theme::CYAN),
        fact_key("workspace"),
        fact_value(&workspace, theme::TEXT),
    ]);

    let lines = vec![
        Line::from(Span::styled(
            super::shorten(
                &app.context.root.display().to_string(),
                inner.width as usize,
            ),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        )),
        facts,
    ];
    frame.render_widget(Paragraph::new(lines).style(theme::base()), inner);
}

fn fact_key(key: &str) -> Span<'static> {
    Span::styled(format!("{key} "), theme::faint())
}

fn fact_value(value: &str, colour: ratatui::style::Color) -> Span<'static> {
    Span::styled(format!("{value}   "), Style::default().fg(colour))
}

/// The boot, as four rows that fill in.
fn checklist_pane(frame: &mut Frame, area: Rect, app: &App) {
    let lines: Vec<Line> = app
        .boot
        .states()
        .map(|(step, state)| {
            let (mark, colour, note) = match state {
                StepState::Waiting => ("·", theme::GHOST, String::new()),
                StepState::Working(note) => (
                    // A spinner, so a four-minute image pull does not look
                    // like a hang.
                    ["◜", "◝", "◞", "◟"][usize::try_from(app.tick / 2 % 4).unwrap_or(0)],
                    theme::AMBER,
                    note.clone(),
                ),
                StepState::Done(what) => ("✔", theme::ACID, what.clone()),
                StepState::Failed(why) => ("✖", theme::BLOOD, why.clone()),
            };
            Line::from(vec![
                Span::styled(format!(" {mark} "), Style::default().fg(colour)),
                Span::styled(format!("{:<11}", step.label()), theme::faint()),
                Span::styled(note, Style::default().fg(colour)),
            ])
        })
        .collect();

    frame.render_widget(
        Paragraph::new(lines)
            .block(chrome::block("starting", false))
            .style(theme::base()),
        area,
    );
}

/// The windows, numbered as tmux numbers them.
fn windows_pane(frame: &mut Frame, area: Rect, app: &App) {
    let block = chrome::block("windows", app.window_focus);
    if app.windows.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled("no session yet", theme::faint())))
                .block(block)
                .style(theme::base()),
            area,
        );
        return;
    }

    let items: Vec<ListItem> = app
        .windows
        .iter()
        .enumerate()
        .map(|(row, window)| {
            let selected = app.window_focus && row == app.window_cursor;
            let key = window
                .index
                .map_or_else(|| "  ".to_owned(), |index| format!("{index:<2}"));
            let origin = match window.origin {
                Origin::Terminal => "❯",
                Origin::Task => "▪",
                Origin::Adhoc => "+",
            };
            ListItem::new(Line::from(vec![
                Span::styled(
                    if selected { "▶ " } else { "  " },
                    Style::default().fg(theme::NEON),
                ),
                Span::styled(key, Style::default().fg(theme::ACID)),
                Span::styled(format!("{origin} "), Style::default().fg(theme::NEON)),
                Span::styled(
                    format!("{:<12}", super::truncate(&window.name, 12)),
                    Style::default().fg(if window.active {
                        theme::TEXT
                    } else {
                        theme::DIM
                    }),
                ),
                Span::styled(
                    window.state.clone(),
                    Style::default().fg(theme::state_colour(&window.state)),
                ),
                Span::styled(
                    if window.restarts > 0 {
                        format!(" ×{}", window.restarts)
                    } else {
                        String::new()
                    },
                    Style::default().fg(theme::AMBER),
                ),
            ]))
        })
        .collect();
    frame.render_widget(List::new(items).block(block), area);
}

/// What this workspace serves, and where.
///
/// URLs are printed whole and unstyled-as-links: every terminal worth using
/// linkifies a bare https:// itself, and an OSC 8 escape smuggled through a
/// cell-based renderer breaks the width arithmetic for the whole row. `/open`
/// is there for the terminals that do not.
fn ports_pane(frame: &mut Frame, area: Rect, app: &App) {
    let routes = app.routes();
    let block = chrome::block("ports", false);
    if routes.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                if app.primary_workspace().is_some() {
                    "no routes declared — add [routes] to .envmux.toml"
                } else {
                    "—"
                },
                theme::faint(),
            )))
            .block(block)
            .style(theme::base()),
            area,
        );
        return;
    }

    let items: Vec<ListItem> = routes
        .iter()
        .map(|(name, url)| {
            ListItem::new(Line::from(vec![
                Span::styled(" ", theme::base()),
                Span::styled(
                    format!("{:<8}", super::truncate(name, 8)),
                    Style::default()
                        .fg(theme::ACID)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled((*url).to_owned(), Style::default().fg(theme::CYAN)),
            ]))
        })
        .collect();
    frame.render_widget(List::new(items).block(block), area);
}

fn activity_pane(frame: &mut Frame, area: Rect, app: &App) {
    // Scrolled back gets said in the title: there is no cursor in this view to
    // show it any other way.
    let title = if app.session_scroll > 0 {
        "activity ↑"
    } else {
        "activity"
    };
    let items: Vec<ListItem> = app
        .snapshot
        .events
        .iter()
        .skip(app.session_scroll)
        .map(|event| ListItem::new(super::event_line(event)))
        .collect();
    if items.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled("quiet", theme::faint())))
                .block(chrome::block(title, false))
                .wrap(Wrap { trim: false })
                .style(theme::base()),
            area,
        );
        return;
    }
    frame.render_widget(List::new(items).block(chrome::block(title, false)), area);
}

/// The command line. Always focused: type, enter, done.
fn input_line(frame: &mut Frame, area: Rect, app: &App) {
    let line = Line::from(vec![
        Span::styled(
            " ❯ ",
            Style::default()
                .fg(theme::NEON)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(app.input.clone(), Style::default().fg(theme::TEXT)),
        // Its own blinking block: the terminal's real cursor is parked
        // elsewhere by the alternate screen.
        Span::styled(
            if app.tick % 8 < 4 { "█" } else { " " },
            Style::default().fg(theme::ACID),
        ),
    ]);
    frame.render_widget(Paragraph::new(line).style(theme::base()), area);
}
