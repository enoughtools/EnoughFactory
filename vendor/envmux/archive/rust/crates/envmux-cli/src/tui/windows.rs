//! The workspace's tmux windows, as something you can see and navigate.
//!
//! A workspace *is* a tmux session: every declared task is a named window in
//! it, and so is the terminal you attach to and any ad-hoc window you opened.
//! That is a good model and it was invisible — you attached into one window
//! and found the rest with tmux's own key chords, which is fine if you already
//! know tmux and a dead end if you do not.
//!
//! So the windows are listed, numbered with **tmux's own indices**, and one
//! keystroke away. `alt-2` here and `prefix 2` inside the session select the
//! same window, deliberately: two numbering schemes for one list is worse than
//! none.
//!
//! Two sources are merged. The task engine knows what a task's state *is*
//! (ready, failed, how many restarts); tmux knows what windows actually exist
//! and in what order. Neither alone is the list: a task that has not opened
//! its window yet is real and missing from tmux, and an ad-hoc window is real
//! and unknown to the task engine.

use envmux_api_types as dto;

/// Where a window came from, which is what decides how it reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The interactive window an attach lands in.
    Terminal,
    /// Declared in `.envmux.toml`, run by the task engine.
    Task,
    /// Opened by hand, in this workspace, for whatever is happening now.
    Adhoc,
}

/// One row of the windows pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    /// tmux's own window index — the number to press.
    pub index: Option<u32>,
    pub name: String,
    pub origin: Origin,
    /// Lowercase state word, shared with the theme's colour table.
    pub state: String,
    pub restarts: u32,
    /// Whether tmux currently has this window selected.
    pub active: bool,
}

/// A window as tmux reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveWindow {
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub dead: bool,
}

/// The argv that lists a session's windows.
///
/// A vector of arguments rather than a shell line: the format string is full
/// of braces and hashes, and putting it through a shell is how it comes back
/// expanded into something else.
pub fn list_windows_cmd() -> Vec<String> {
    vec![
        "tmux".to_owned(),
        "list-windows".to_owned(),
        "-t".to_owned(),
        format!("{}:", envmux_tmux::SESSION),
        "-F".to_owned(),
        "#{window_index}\t#{window_name}\t#{window_active}\t#{pane_dead}".to_owned(),
    ]
}

/// Parse what that command printed.
///
/// Unparseable lines are dropped rather than failing the lot: a tmux that
/// grows a field or a warning on stdout should cost one row, not the pane.
pub fn parse_windows(stdout: &str) -> Vec<LiveWindow> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim_end().split('\t');
            let index: u32 = parts.next()?.trim().parse().ok()?;
            let name = parts.next()?.to_owned();
            let active = parts.next() == Some("1");
            let dead = parts.next() == Some("1");
            Some(LiveWindow {
                index,
                name,
                active,
                dead,
            })
        })
        .collect()
}

/// Merge what the task engine knows with what tmux has.
///
/// tmux's order wins where both agree, because that is the order the indices
/// belong to and the order you will see once you are inside. Declared tasks
/// with no window yet are appended: they are coming, and hiding them would
/// make a workspace mid-provision look emptier than it is.
pub fn merge(tasks: &[dto::TaskStatus], live: &[LiveWindow]) -> Vec<Window> {
    let mut out: Vec<Window> = Vec::new();

    for window in live {
        let task = tasks.iter().find(|t| t.name == window.name);
        let origin = if window.name == envmux_tmux::TERMINAL_WINDOW {
            Origin::Terminal
        } else if task.is_some() {
            Origin::Task
        } else {
            Origin::Adhoc
        };
        // A dead pane is what it is regardless of what the engine last
        // recorded — the window is still listed, because a task you need to
        // look at is exactly the one that died.
        let state = if window.dead {
            "exited".to_owned()
        } else {
            match task {
                Some(task) => task_state(task.state),
                None if origin == Origin::Terminal => "shell".to_owned(),
                None => "open".to_owned(),
            }
        };
        out.push(Window {
            index: Some(window.index),
            name: window.name.clone(),
            origin,
            state,
            restarts: task.map_or(0, |t| t.restarts),
            active: window.active,
        });
    }

    for task in tasks {
        if out.iter().any(|w| w.name == task.name) {
            continue;
        }
        out.push(Window {
            index: None,
            name: task.name.clone(),
            origin: Origin::Task,
            state: task_state(task.state),
            restarts: task.restarts,
            active: false,
        });
    }

    out
}

/// The task engine's states, lowercased into the vocabulary the theme's
/// colour table already speaks.
fn task_state(state: dto::TaskState) -> String {
    match state {
        dto::TaskState::Waiting => "waiting",
        dto::TaskState::Running => "running",
        dto::TaskState::Ready => "ready",
        dto::TaskState::Exited => "exited",
        dto::TaskState::Failed => "failed",
    }
    .to_owned()
}

/// Fetch the live window list for a workspace.
///
/// One `docker exec` per call, so callers run it on a spawned task and never
/// on the render path.
pub async fn probe(workspace_id: &str) -> Vec<LiveWindow> {
    let body = serde_json::json!({ "cmd": list_windows_cmd() });
    let Ok(resp) = crate::client::post(&format!("/v1/workspaces/{workspace_id}/run"), body).await
    else {
        return Vec::new();
    };
    if resp.status != 200 {
        return Vec::new();
    }
    let out: serde_json::Value = resp.json().unwrap_or_default();
    // A non-zero exit is a workspace whose session is not up yet, which is a
    // normal moment during provisioning rather than something to report.
    if out["exit_code"].as_i64().unwrap_or(0) != 0 {
        return Vec::new();
    }
    parse_windows(out["stdout"].as_str().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(name: &str, state: dto::TaskState, restarts: u32) -> dto::TaskStatus {
        dto::TaskStatus {
            name: name.to_owned(),
            state,
            exit_code: None,
            restarts,
        }
    }

    #[test]
    fn tmux_output_parses_into_indexed_windows() {
        let stdout = "0\tterminal\t1\t0\n1\tdev\t0\t0\n2\ttest\t0\t1\n";
        assert_eq!(
            parse_windows(stdout),
            vec![
                LiveWindow {
                    index: 0,
                    name: "terminal".to_owned(),
                    active: true,
                    dead: false
                },
                LiveWindow {
                    index: 1,
                    name: "dev".to_owned(),
                    active: false,
                    dead: false
                },
                LiveWindow {
                    index: 2,
                    name: "test".to_owned(),
                    active: false,
                    dead: true
                },
            ]
        );
    }

    #[test]
    fn a_line_that_makes_no_sense_costs_one_row_not_the_pane() {
        let stdout = "0\tterminal\t1\t0\nsome tmux warning\n\n2\tdev\t0\t0\n";
        let windows = parse_windows(stdout);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[1].name, "dev");
    }

    #[test]
    fn window_names_with_spaces_survive_the_round_trip() {
        // Ad-hoc windows are named by hand, and the format is tab-separated
        // precisely so a space in a name is not a field boundary.
        let windows = parse_windows("3\tmy scratch window\t0\t0\n");
        assert_eq!(windows[0].name, "my scratch window");
    }

    #[test]
    fn the_merge_keeps_tmux_order_and_tmux_indices() {
        // The numbers on screen have to be the numbers inside the session, or
        // there are two numbering schemes for one list.
        let tasks = [task("dev", dto::TaskState::Ready, 0)];
        let live = parse_windows("0\tterminal\t1\t0\n4\tdev\t0\t0\n");
        let merged = merge(&tasks, &live);
        assert_eq!(merged[0].index, Some(0));
        assert_eq!(merged[1].index, Some(4));
        assert_eq!(merged[1].name, "dev");
    }

    #[test]
    fn each_window_is_labelled_with_where_it_came_from() {
        let tasks = [task("dev", dto::TaskState::Ready, 0)];
        let live = parse_windows("0\tterminal\t1\t0\n1\tdev\t0\t0\n2\tscratch\t0\t0\n");
        let merged = merge(&tasks, &live);
        assert_eq!(merged[0].origin, Origin::Terminal);
        assert_eq!(merged[1].origin, Origin::Task);
        // A window tmux has and the task engine does not is one you opened.
        assert_eq!(merged[2].origin, Origin::Adhoc);
        assert_eq!(merged[2].state, "open");
    }

    #[test]
    fn a_declared_task_with_no_window_yet_is_still_listed() {
        // It is coming. Hiding it makes a workspace mid-provision look emptier
        // than it is, and the row is where its state is reported.
        let tasks = [
            task("dev", dto::TaskState::Ready, 0),
            task("worker", dto::TaskState::Waiting, 0),
        ];
        let live = parse_windows("1\tdev\t1\t0\n");
        let merged = merge(&tasks, &live);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[1].name, "worker");
        assert_eq!(merged[1].index, None, "it has no tmux index to press yet");
        assert_eq!(merged[1].state, "waiting");
    }

    #[test]
    fn a_dead_pane_reads_as_exited_whatever_the_engine_last_said() {
        // The engine's last word can lag the pane by a poll, and the window
        // you need to look at is exactly the one that just died.
        let tasks = [task("dev", dto::TaskState::Ready, 2)];
        let live = parse_windows("1\tdev\t0\t1\n");
        let merged = merge(&tasks, &live);
        assert_eq!(merged[0].state, "exited");
        // The restart count still comes from the engine.
        assert_eq!(merged[0].restarts, 2);
    }

    #[test]
    fn with_no_session_yet_the_declared_tasks_are_the_whole_list() {
        let tasks = [
            task("install", dto::TaskState::Running, 0),
            task("dev", dto::TaskState::Waiting, 0),
        ];
        let merged = merge(&tasks, &[]);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().all(|w| w.index.is_none()));
        assert_eq!(merged[0].state, "running");
    }

    #[test]
    fn the_listing_command_passes_its_format_as_one_argument() {
        // Through a shell, `#{window_index}` is a comment and a brace
        // expansion. As one argv element it is a tmux format string.
        let cmd = list_windows_cmd();
        assert_eq!(cmd[0], "tmux");
        assert!(cmd.contains(&"envmux:".to_owned()));
        let format = cmd.last().unwrap();
        assert!(format.contains("#{window_index}"), "{format}");
        assert_eq!(format.matches('\t').count(), 3, "four fields, three tabs");
    }
}
