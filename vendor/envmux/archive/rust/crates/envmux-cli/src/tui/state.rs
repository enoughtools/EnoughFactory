//! What the TUI knows, and how it finds out.
//!
//! Everything here is a snapshot pulled from the daemon on a tick. The TUI is
//! a client of the same IPC API as the CLI — it has no privileged access and
//! no second source of truth, which is the only way the two can never disagree
//! about what exists.

use envmux_api_types as dto;

use crate::client;

/// Which face the TUI is showing.
///
/// Dispatch is the product: this folder, what is happening to it, and a
/// prompt. The management dashboard is the machinery behind it, one `/manage`
/// away and one Esc back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    /// First run: choose what this repository's environment should be. Only
    /// ever reached from a folder with no configuration in it.
    Setup,
    Dispatch,
    Manage,
}

/// Which pane has the keyboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Namespaces,
    Workspaces,
    Events,
}

impl Focus {
    #[must_use]
    pub fn next(self) -> Self {
        match self {
            Self::Namespaces => Self::Workspaces,
            Self::Workspaces => Self::Events,
            Self::Events => Self::Namespaces,
        }
    }

    #[must_use]
    pub fn previous(self) -> Self {
        match self {
            Self::Namespaces => Self::Events,
            Self::Workspaces => Self::Namespaces,
            Self::Events => Self::Workspaces,
        }
    }
}

/// A transient line at the bottom: what just happened, and how it went.
#[derive(Debug, Clone)]
pub struct Flash {
    pub message: String,
    pub level: FlashLevel,
    /// The tick it was raised on, so it can fade.
    pub raised: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlashLevel {
    Good,
    Bad,
    /// An operation in flight. Does not expire — it is replaced by its result.
    Working,
}

/// The world as last seen.
#[derive(Default)]
pub struct Snapshot {
    pub daemon_ok: bool,
    pub namespaces: Vec<dto::NamespaceSummary>,
    pub workspaces: Vec<dto::WorkspaceSummary>,
    pub events: Vec<dto::EventRecord>,
    /// Highest event id seen, so each poll asks only for what is new.
    pub last_event_id: i64,
}

/// How many events to keep. Enough to scroll back through a provisioning run,
/// bounded so a long session cannot grow without limit.
const EVENT_CAP: usize = 500;

impl Snapshot {
    /// Refresh from the daemon.
    ///
    /// Failures are not errors here: the daemon going away mid-session is a
    /// state to render, not a reason to tear down the UI. The user may well be
    /// watching precisely because they expect it to come back.
    pub async fn refresh(&mut self, namespace: Option<&str>) {
        let Ok(resp) = client::get("/v1/namespaces").await else {
            self.daemon_ok = false;
            return;
        };
        if resp.status != 200 {
            self.daemon_ok = false;
            return;
        }
        self.daemon_ok = true;
        if let Ok(list) = resp.json::<Vec<dto::NamespaceSummary>>() {
            self.namespaces = list;
        }

        if let Some(ns) = namespace
            && let Ok(resp) = client::get(&format!("/v1/namespaces/{ns}/workspaces")).await
            && resp.status == 200
            && let Ok(list) = resp.json::<Vec<dto::WorkspaceSummary>>()
        {
            self.workspaces = list;
        }

        if let Ok(resp) = client::get(&format!("/v1/events?since={}", self.last_event_id)).await
            && resp.status == 200
            && let Ok(mut fresh) = resp.json::<Vec<dto::EventRecord>>()
        {
            if let Some(highest) = fresh.iter().map(|e| e.id).max() {
                self.last_event_id = highest;
            }
            // Newest first in the feed, and bounded.
            fresh.reverse();
            fresh.append(&mut self.events);
            self.events = fresh;
            self.events.truncate(EVENT_CAP);
        }
    }
}

/// Clamp a selection index to a list that may have shrunk under it.
///
/// Lists are re-fetched every tick and workspaces come and go, so an index
/// held across a refresh can point past the end. Silently clamping beats both
/// panicking and quietly selecting nothing.
#[must_use]
pub fn clamp(index: usize, len: usize) -> usize {
    if len == 0 { 0 } else { index.min(len - 1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_cycles_both_ways_without_getting_stuck() {
        let mut focus = Focus::Namespaces;
        for _ in 0..3 {
            focus = focus.next();
        }
        assert_eq!(focus, Focus::Namespaces);
        for _ in 0..3 {
            focus = focus.previous();
        }
        assert_eq!(focus, Focus::Namespaces);
        // And the two are actually inverses, not two different cycles.
        assert_eq!(Focus::Workspaces.next().previous(), Focus::Workspaces);
    }

    #[test]
    fn selection_survives_a_list_shrinking_under_it() {
        assert_eq!(clamp(7, 3), 2);
        assert_eq!(clamp(1, 3), 1);
        // The empty case is the one that would panic on a naive `len - 1`.
        assert_eq!(clamp(4, 0), 0);
    }
}
