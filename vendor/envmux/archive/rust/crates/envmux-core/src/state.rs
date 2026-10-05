//! The workspace lifecycle state machine.
//!
//! Transitions are enforced by an explicit table, not by convention. `Reaping`
//! is entered exactly once and exits only to `Reaped`; a daemon crash mid-reap
//! resumes at the persisted [`ReapStep`].

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceState {
    /// Slices being created, clone in progress, task graph starting.
    Provisioning,
    /// Task graph satisfied.
    Ready,
    /// A supervised task is failing its restart policy.
    Degraded,
    /// Final capture → deprovision → destroy, in progress.
    Reaping,
    /// Terminal; row retained for shadow-history linkage.
    Reaped,
    /// Recorded but container vanished outside envmux.
    Lost,
}

impl WorkspaceState {
    pub const ALL: [WorkspaceState; 6] = [
        Self::Provisioning,
        Self::Ready,
        Self::Degraded,
        Self::Reaping,
        Self::Reaped,
        Self::Lost,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Provisioning => "provisioning",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
            Self::Reaping => "reaping",
            Self::Reaped => "reaped",
            Self::Lost => "lost",
        }
    }

    /// Whether the reaper's sweep may select a workspace in this state.
    #[must_use]
    pub fn reapable(self) -> bool {
        matches!(self, Self::Provisioning | Self::Ready | Self::Degraded)
    }

    /// Whether the observer collects from a workspace in this state.
    #[must_use]
    pub fn observable(self) -> bool {
        matches!(self, Self::Ready | Self::Degraded)
    }
}

impl fmt::Display for WorkspaceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for WorkspaceState {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown workspace state {s:?}"))
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("invalid workspace state transition {from} -> {to}")]
pub struct InvalidTransition {
    pub from: WorkspaceState,
    pub to: WorkspaceState,
}

/// The exhaustive transition table.
pub fn try_transition(from: WorkspaceState, to: WorkspaceState) -> Result<(), InvalidTransition> {
    use WorkspaceState as S;
    // Separate arms deliberately mirror the documented lifecycle categories.
    #[allow(clippy::match_same_arms)]
    let ok = match (from, to) {
        // Startup path.
        (S::Provisioning, S::Ready) => true,
        // Restart-policy breach and recovery.
        (S::Ready, S::Degraded) | (S::Degraded, S::Ready) => true,
        // Anything live can start reaping, or be discovered lost.
        (S::Provisioning | S::Ready | S::Degraded, S::Reaping | S::Lost) => true,
        // Reaping exits only to Reaped.
        (S::Reaping, S::Reaped) => true,
        // A lost workspace's record is finalized by the reaper.
        (S::Lost, S::Reaping) => true,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(InvalidTransition { from, to })
    }
}

/// Persisted sub-step of the reap sequence; a crash resumes at this step.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ReapStep {
    Capture,
    Deprovision,
    Destroy,
}

impl ReapStep {
    pub const ALL: [ReapStep; 3] = [Self::Capture, Self::Deprovision, Self::Destroy];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Deprovision => "deprovision",
            Self::Destroy => "destroy",
        }
    }

    #[must_use]
    pub fn next(self) -> Option<Self> {
        match self {
            Self::Capture => Some(Self::Deprovision),
            Self::Deprovision => Some(Self::Destroy),
            Self::Destroy => None,
        }
    }
}

impl fmt::Display for ReapStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ReapStep {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown reap step {s:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use WorkspaceState as S;

    /// Exhaustive check of the full 6x6 table against the intended semantics.
    #[test]
    fn transition_table_exhaustive() {
        let allowed: &[(S, S)] = &[
            (S::Provisioning, S::Ready),
            (S::Provisioning, S::Reaping),
            (S::Provisioning, S::Lost),
            (S::Ready, S::Degraded),
            (S::Ready, S::Reaping),
            (S::Ready, S::Lost),
            (S::Degraded, S::Ready),
            (S::Degraded, S::Reaping),
            (S::Degraded, S::Lost),
            (S::Reaping, S::Reaped),
            (S::Lost, S::Reaping),
        ];
        for from in S::ALL {
            for to in S::ALL {
                let expect = allowed.contains(&(from, to));
                assert_eq!(
                    try_transition(from, to).is_ok(),
                    expect,
                    "transition {from} -> {to}"
                );
            }
        }
    }

    #[test]
    fn reaped_is_terminal() {
        for to in S::ALL {
            assert!(try_transition(S::Reaped, to).is_err());
        }
    }

    #[test]
    fn reap_steps_are_ordered() {
        assert_eq!(ReapStep::Capture.next(), Some(ReapStep::Deprovision));
        assert_eq!(ReapStep::Deprovision.next(), Some(ReapStep::Destroy));
        assert_eq!(ReapStep::Destroy.next(), None);
    }

    #[test]
    fn state_round_trips_via_str() {
        for s in S::ALL {
            assert_eq!(s.as_str().parse::<S>().unwrap(), s);
        }
    }
}
