//! Bringing a session up, with the lights on.
//!
//! `envmux` used to do all of this before the UI existed: onboard, fork a
//! daemon, register the namespace — which on a first run pulls or builds an
//! image — and create a workspace, printing four lines and then going quiet
//! for minutes. The terminal you were left looking at could not tell you which
//! step you were in, how far through it was, or that anything was happening at
//! all.
//!
//! So it happens here instead, on a spawned task, reporting each transition
//! down a channel while the render loop keeps drawing. The landing page is on
//! screen before any of it starts. The coarse shape of the work is the
//! checklist; the detail is the daemon's own event feed, which is already on
//! screen underneath it.
//!
//! Nothing in here is privileged: it is the same IPC calls the CLI makes, in
//! the same order, and a session booted by hand with `envmux up && envmux
//! create` arrives in exactly the same place.

use std::path::PathBuf;

use tokio::sync::mpsc;

use crate::client;

/// The steps, in the order they must happen.
///
/// Fixed and total: every session runs all four, and one that is already done
/// completes instantly rather than being skipped. A checklist whose rows come
/// and go is one you cannot learn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Read the configuration for this folder.
    Config,
    /// Adopt or fork the daemon for this state directory.
    Daemon,
    /// Register the folder as a namespace — the slow one on a first run,
    /// because it pulls or builds the image.
    Namespace,
    /// Create (or reuse) a workspace on the branch you are actually on.
    Workspace,
}

impl Step {
    pub const ALL: [Self; 4] = [Self::Config, Self::Daemon, Self::Namespace, Self::Workspace];

    /// Lowercase, like every other label on screen.
    pub fn label(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Daemon => "daemon",
            Self::Namespace => "namespace",
            Self::Workspace => "workspace",
        }
    }
}

/// Where a step has got to, and what it has to say about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepState {
    /// Not started. Its turn has not come.
    Waiting,
    /// In flight, with a note about what it is doing.
    Working(String),
    /// Finished, with what it established — the namespace name, the image,
    /// the workspace. The note is the point: a tick with nothing beside it
    /// says the step ran, not what it decided.
    Done(String),
    Failed(String),
}

/// One transition, as the boot task reports it.
#[derive(Debug, Clone)]
pub struct Progress {
    pub step: Step,
    pub state: StepState,
}

/// What a completed boot established, for the view that follows it.
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub namespace: Option<String>,
    pub workspace: Option<String>,
}

/// A boot in flight, and everything the checklist needs to render it.
pub struct Boot {
    rx: mpsc::UnboundedReceiver<Progress>,
    /// Parallel to [`Step::ALL`].
    states: [StepState; 4],
    outcome: Outcome,
    /// True once every step has either finished or failed.
    settled: bool,
}

impl Boot {
    /// Start bringing a session up for `root`.
    ///
    /// Returns immediately; the work runs on a spawned task. `branch` is the
    /// branch the host checkout is on, because `envmux` in a directory means
    /// "this directory, as it is here" — defaulting to the mirror's HEAD would
    /// quietly hand back the default branch whenever the two differ.
    pub fn start(root: PathBuf, branch: Option<String>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            run(&tx, root, branch).await;
        });
        Self {
            rx,
            states: [
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
            ],
            outcome: Outcome::default(),
            settled: false,
        }
    }

    /// A boot with nothing to do and nothing to say.
    ///
    /// What an [`App`](crate::tui) is constructed with, so that building one
    /// starts no work: `new` runs in tests with no daemon and no Docker, and a
    /// constructor that forks a daemon is one nobody can call safely.
    pub fn idle() -> Self {
        let (_tx, rx) = mpsc::unbounded_channel();
        Self {
            rx,
            states: [
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
            ],
            outcome: Outcome::default(),
            // Settled, so an app that never booted does not sit under a
            // checklist of four things that are never going to happen.
            settled: true,
        }
    }

    /// A boot frozen mid-flight, for rendering tests.
    ///
    /// The real one is a spawned task talking to a daemon, which is exactly
    /// what a test that only wants to look at the checklist cannot have.
    #[cfg(test)]
    pub fn start_for_test(states: [StepState; 4]) -> Self {
        let (_tx, rx) = mpsc::unbounded_channel();
        let settled = states.iter().any(|s| matches!(s, StepState::Failed(_)))
            || states
                .iter()
                .all(|s| matches!(s, StepState::Done(_) | StepState::Failed(_)));
        Self {
            rx,
            states,
            outcome: Outcome::default(),
            settled,
        }
    }

    /// A boot that never ran, for a session that was handed its namespace
    /// already — `envmux manage` on a folder that is up, say.
    pub fn already_done(namespace: String) -> Self {
        let (_tx, rx) = mpsc::unbounded_channel();
        let done = |what: &str| StepState::Done(what.to_owned());
        Self {
            rx,
            states: [
                done("resolved"),
                done("running"),
                done(&namespace),
                done("existing"),
            ],
            outcome: Outcome {
                namespace: Some(namespace),
                workspace: None,
            },
            settled: true,
        }
    }

    /// Drain whatever the boot task has said since the last call.
    ///
    /// Non-blocking: the render loop calls this on a tick and must never wait
    /// on it, since not waiting is the entire reason the work is over there.
    /// Returns true when something changed and the frame is worth redrawing.
    pub fn drain(&mut self) -> bool {
        let mut changed = false;
        while let Ok(progress) = self.rx.try_recv() {
            changed = true;
            let index = Step::ALL
                .iter()
                .position(|s| *s == progress.step)
                .unwrap_or(0);
            // The note a step finished with is worth keeping: it carries the
            // namespace and workspace names the rest of the UI is about.
            if let StepState::Done(what) = &progress.state {
                match progress.step {
                    Step::Namespace => self.outcome.namespace = Some(what.clone()),
                    Step::Workspace => self.outcome.workspace = Some(what.clone()),
                    Step::Config | Step::Daemon => {}
                }
            }
            self.states[index] = progress.state;
        }
        if changed {
            self.settled = self
                .states
                .iter()
                .all(|s| matches!(s, StepState::Done(_) | StepState::Failed(_)))
                || self
                    .states
                    .iter()
                    .any(|s| matches!(s, StepState::Failed(_)));
        }
        changed
    }

    pub fn states(&self) -> impl Iterator<Item = (Step, &StepState)> {
        Step::ALL.into_iter().zip(self.states.iter())
    }

    /// True once there is nothing left to wait for, successfully or not.
    pub fn settled(&self) -> bool {
        self.settled
    }

    /// The first failure, if the boot stopped on one.
    pub fn failure(&self) -> Option<(Step, &str)> {
        Step::ALL
            .into_iter()
            .zip(self.states.iter())
            .find_map(|(step, state)| match state {
                StepState::Failed(why) => Some((step, why.as_str())),
                _ => None,
            })
    }

    pub fn outcome(&self) -> &Outcome {
        &self.outcome
    }
}

/// The boot itself. Every step reports before and after, and a failure stops
/// the sequence — there is no useful workspace to create in a namespace that
/// could not be registered, and pressing on would replace one clear error with
/// a second, more confusing one.
async fn run(tx: &mpsc::UnboundedSender<Progress>, root: PathBuf, branch: Option<String>) {
    let say = |step: Step, state: StepState| {
        // A closed channel means the UI is gone; there is nobody to tell and
        // nothing to do about it.
        let _ = tx.send(Progress { step, state });
    };

    // ---- config -----------------------------------------------------------
    say(Step::Config, StepState::Working("reading".to_owned()));
    // `.envmux/` and its ignore entries, for repositories configured before
    // the folder existed as well as for the one the setup screen just wrote.
    // Cheap, idempotent, and the alternative is state landing in a commit.
    if let Err(e) = crate::onboard::ensure_project_dir(&root) {
        say(Step::Config, StepState::Failed(format!("{e:#}")));
        return;
    }
    match envmux_config::resolve_dir(&root) {
        Ok(resolved) => say(
            Step::Config,
            StepState::Done(resolved.active.file_name().to_owned()),
        ),
        Err(e) => {
            say(Step::Config, StepState::Failed(format!("{e}")));
            return;
        }
    }

    // ---- daemon -----------------------------------------------------------
    say(Step::Daemon, StepState::Working("linking".to_owned()));
    let adopted = client::get("/v1/health").await.is_ok();
    if let Err(e) = crate::spawn_daemon().await {
        say(Step::Daemon, StepState::Failed(format!("{e:#}")));
        return;
    }
    say(
        Step::Daemon,
        StepState::Done(if adopted { "adopted" } else { "started" }.to_owned()),
    );

    // ---- namespace --------------------------------------------------------
    // The long one on a first run: registration pulls or builds the image
    // before it returns. The note says so, because a step that sits still for
    // four minutes without explaining itself reads as a hang.
    say(
        Step::Namespace,
        StepState::Working("registering — a first run pulls or builds the image".to_owned()),
    );
    let namespace = match client::post(
        "/v1/namespaces",
        serde_json::json!({ "repo_dir": root.display().to_string() }),
    )
    .await
    {
        Ok(resp) if resp.status == 200 => match resp.json::<envmux_api_types::NamespaceSummary>() {
            Ok(ns) => ns.name,
            Err(e) => {
                say(Step::Namespace, StepState::Failed(format!("{e:#}")));
                return;
            }
        },
        Ok(resp) => {
            say(Step::Namespace, StepState::Failed(resp.error_message()));
            return;
        }
        Err(e) => {
            say(Step::Namespace, StepState::Failed(format!("{e:#}")));
            return;
        }
    };
    say(Step::Namespace, StepState::Done(namespace.clone()));

    // ---- workspace --------------------------------------------------------
    say(
        Step::Workspace,
        StepState::Working(match &branch {
            Some(branch) => format!("provisioning on {branch}"),
            None => "provisioning".to_owned(),
        }),
    );
    let body = serde_json::json!({
        "repo": null, "branch": branch, "name": null, "overrides": null,
    });
    match client::post(&format!("/v1/namespaces/{namespace}/workspaces"), body).await {
        Ok(resp) if resp.status == 200 || resp.status == 202 => {
            match resp.json::<envmux_api_types::CreateWorkspaceResponse>() {
                // Reuse is the common case on every run after the first, and
                // it is worth saying out loud: "created" against a workspace
                // that is three days old would be a lie.
                Ok(created) => say(Step::Workspace, StepState::Done(created.workspace.name)),
                Err(e) => say(Step::Workspace, StepState::Failed(format!("{e:#}"))),
            }
        }
        Ok(resp) => say(Step::Workspace, StepState::Failed(resp.error_message())),
        Err(e) => say(Step::Workspace, StepState::Failed(format!("{e:#}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boot_with(states: [StepState; 4]) -> Boot {
        let (_tx, rx) = mpsc::unbounded_channel();
        Boot {
            rx,
            states,
            outcome: Outcome::default(),
            settled: false,
        }
    }

    #[test]
    fn the_checklist_is_always_all_four_steps() {
        // A checklist whose rows appear and disappear cannot be learned, so
        // every step is always on screen whatever state it is in.
        let boot = boot_with([
            StepState::Done("ok".to_owned()),
            StepState::Working("linking".to_owned()),
            StepState::Waiting,
            StepState::Waiting,
        ]);
        assert_eq!(boot.states().count(), 4);
        let labels: Vec<&str> = boot.states().map(|(step, _)| step.label()).collect();
        assert_eq!(labels, ["config", "daemon", "namespace", "workspace"]);
    }

    #[test]
    fn a_failure_is_findable_and_names_its_step() {
        let boot = boot_with([
            StepState::Done("ok".to_owned()),
            StepState::Failed("no docker".to_owned()),
            StepState::Waiting,
            StepState::Waiting,
        ]);
        assert_eq!(
            boot.failure(),
            Some((Step::Daemon, "no docker")),
            "a failed boot must say which step failed, not just that one did"
        );
    }

    #[test]
    fn a_boot_in_flight_reports_no_failure() {
        let boot = boot_with([
            StepState::Done("ok".to_owned()),
            StepState::Working("linking".to_owned()),
            StepState::Waiting,
            StepState::Waiting,
        ]);
        assert!(boot.failure().is_none());
    }

    #[tokio::test]
    async fn draining_records_what_each_step_established() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut boot = Boot {
            rx,
            states: [
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
            ],
            outcome: Outcome::default(),
            settled: false,
        };
        // Nothing to drain yet, and the call must not block.
        assert!(!boot.drain());

        for progress in [
            Progress {
                step: Step::Config,
                state: StepState::Done(".envmux.toml".to_owned()),
            },
            Progress {
                step: Step::Namespace,
                state: StepState::Done("acme".to_owned()),
            },
            Progress {
                step: Step::Workspace,
                state: StepState::Done("wobbly-otter".to_owned()),
            },
        ] {
            tx.send(progress).unwrap();
        }
        assert!(boot.drain());
        assert_eq!(boot.outcome().namespace.as_deref(), Some("acme"));
        assert_eq!(boot.outcome().workspace.as_deref(), Some("wobbly-otter"));
        // The daemon step never reported, so this is not settled yet.
        assert!(!boot.settled());

        tx.send(Progress {
            step: Step::Daemon,
            state: StepState::Done("adopted".to_owned()),
        })
        .unwrap();
        boot.drain();
        assert!(boot.settled());
    }

    #[tokio::test]
    async fn a_failure_settles_the_boot_even_with_steps_still_waiting() {
        // The sequence stops on a failure, so the steps after it stay Waiting
        // forever — a boot that waits for them would spin the spinner until
        // the user gave up.
        let (tx, rx) = mpsc::unbounded_channel();
        let mut boot = Boot {
            rx,
            states: [
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
                StepState::Waiting,
            ],
            outcome: Outcome::default(),
            settled: false,
        };
        tx.send(Progress {
            step: Step::Daemon,
            state: StepState::Failed("docker is not running".to_owned()),
        })
        .unwrap();
        boot.drain();
        assert!(boot.settled());
        assert_eq!(boot.failure().map(|(s, _)| s), Some(Step::Daemon));
    }

    #[test]
    fn a_session_handed_its_namespace_starts_settled() {
        let boot = Boot::already_done("acme".to_owned());
        assert!(boot.settled());
        assert!(boot.failure().is_none());
        assert_eq!(boot.outcome().namespace.as_deref(), Some("acme"));
    }
}
