//! `envmux prune` — the janitor for whatever ephemeral daemons left behind.
//!
//! Talks to Docker directly; no daemon is required, because the point is to
//! clean up after daemons that are gone. Scope is strictly the envmux label
//! schema: every listing is filtered on `dev.envmux.schema`, and the planner
//! re-checks the labels on each object, so an unlabelled resource can never
//! appear in a plan.

use std::collections::HashSet;

use anyhow::Context as _;
use bollard::models::{ContainerSummary, MountPointTypeEnum, Network, Volume};
use envmux_core::labels as l;
use envmux_docker::DockerHandle;

/// Seconds a running container gets to stop cleanly under `--all`.
const STOP_TIMEOUT_SECS: i64 = 10;

/// What one container contributes to the decision: whether it survives, and
/// which volumes and networks it holds alive if it does.
#[derive(Debug)]
struct ContainerFacts {
    name: String,
    running: bool,
    labelled: bool,
    volumes: Vec<String>,
    networks: Vec<String>,
}

#[derive(Debug)]
struct VolumeFacts {
    name: String,
    labelled: bool,
    size_bytes: Option<i64>,
}

#[derive(Debug)]
struct NetworkFacts {
    name: String,
    labelled: bool,
}

/// The decided sweep. Removal order matters: containers release volumes and
/// networks, so they go first.
#[derive(Debug, Default, PartialEq, Eq)]
struct Plan {
    /// Running containers taken only under `--all`: stopped, then removed.
    stop_containers: Vec<String>,
    /// Containers already not running (exited/created/dead).
    remove_containers: Vec<String>,
    volumes: Vec<String>,
    networks: Vec<String>,
    /// Sum of the removed volumes' sizes where the listing knew them.
    reclaimed_bytes: i64,
}

impl Plan {
    fn is_empty(&self) -> bool {
        self.stop_containers.is_empty()
            && self.remove_containers.is_empty()
            && self.volumes.is_empty()
            && self.networks.is_empty()
    }
}

/// Decide the sweep from listings. Pure: structs in, plan out.
///
/// Anything not verifiably stopped counts as running — the safe direction for
/// a deletion tool — and running containers survive unless `all` takes them.
/// A volume survives with any surviving container that mounts it; a network
/// survives with any surviving container attached to it.
fn plan(
    containers: &[ContainerFacts],
    volumes: &[VolumeFacts],
    networks: &[NetworkFacts],
    all: bool,
) -> Plan {
    let mut out = Plan::default();
    let mut held_volumes: HashSet<&str> = HashSet::new();
    let mut held_networks: HashSet<&str> = HashSet::new();

    for c in containers.iter().filter(|c| c.labelled) {
        if c.running && !all {
            held_volumes.extend(c.volumes.iter().map(String::as_str));
            held_networks.extend(c.networks.iter().map(String::as_str));
        } else if c.running {
            out.stop_containers.push(c.name.clone());
        } else {
            out.remove_containers.push(c.name.clone());
        }
    }

    for v in volumes.iter().filter(|v| v.labelled) {
        if !held_volumes.contains(v.name.as_str()) {
            out.volumes.push(v.name.clone());
            out.reclaimed_bytes += v.size_bytes.unwrap_or(0);
        }
    }

    // Label-checked like everything else, plus the `envmux-` name the daemon
    // stamps on every network it creates — belt and braces on the one object
    // kind that carries no namespace in its name.
    for n in networks.iter().filter(|n| n.labelled) {
        if n.name.starts_with("envmux-") && !held_networks.contains(n.name.as_str()) {
            out.networks.push(n.name.clone());
        }
    }

    out
}

fn is_envmux(labels: Option<&std::collections::HashMap<String, String>>) -> bool {
    labels.is_some_and(|m| {
        m.get(l::LABEL_SCHEMA).map(String::as_str) == Some(l::LABEL_SCHEMA_VERSION)
    })
}

fn container_facts(c: &ContainerSummary) -> ContainerFacts {
    let name = c
        .names
        .as_ref()
        .and_then(|n| n.first())
        .map(|n| n.trim_start_matches('/').to_owned())
        .or_else(|| c.id.clone())
        .unwrap_or_default();
    // Only these states are verifiably stopped; paused, restarting, or
    // anything Docker invents later counts as running and is left alone.
    let running = !matches!(c.state.as_deref(), Some("exited" | "created" | "dead"));
    let volumes = c
        .mounts
        .iter()
        .flatten()
        .filter(|m| m.typ == Some(MountPointTypeEnum::VOLUME))
        .filter_map(|m| m.name.clone())
        .collect();
    let networks = c
        .network_settings
        .as_ref()
        .and_then(|s| s.networks.as_ref())
        .map(|n| n.keys().cloned().collect())
        .unwrap_or_default();
    ContainerFacts {
        name,
        running,
        labelled: is_envmux(c.labels.as_ref()),
        volumes,
        networks,
    }
}

fn volume_facts(v: &Volume) -> VolumeFacts {
    VolumeFacts {
        name: v.name.clone(),
        labelled: is_envmux(Some(&v.labels)),
        // Docker reports -1 for "not available"; treat it as unknown.
        size_bytes: v.usage_data.as_ref().map(|u| u.size).filter(|s| *s >= 0),
    }
}

fn network_facts(n: &Network) -> NetworkFacts {
    NetworkFacts {
        name: n.name.clone().unwrap_or_default(),
        labelled: is_envmux(n.labels.as_ref()),
    }
}

/// List every envmux-labelled container (including stopped), volume, and
/// network across all namespaces.
async fn collect(
    docker: &DockerHandle,
) -> anyhow::Result<(Vec<ContainerFacts>, Vec<VolumeFacts>, Vec<NetworkFacts>)> {
    let containers = docker.list_containers(None).await?;
    let volumes = docker.list_volumes(None).await?;
    let networks = docker.list_networks(None).await?;
    Ok((
        containers.iter().map(container_facts).collect(),
        volumes.iter().map(volume_facts).collect(),
        networks.iter().map(network_facts).collect(),
    ))
}

/// Carry out a plan. Containers first (they hold the rest), then volumes,
/// then networks; each removal is idempotent, so a race with another cleaner
/// is harmless.
async fn execute(docker: &DockerHandle, plan: &Plan) -> anyhow::Result<()> {
    for name in &plan.stop_containers {
        docker.stop_container(name, STOP_TIMEOUT_SECS).await?;
        docker.remove_container(name).await?;
        println!("removed container {name} (was running)");
    }
    for name in &plan.remove_containers {
        docker.remove_container(name).await?;
        println!("removed container {name}");
    }
    for name in &plan.volumes {
        docker.remove_volume(name).await?;
        println!("removed volume {name}");
    }
    for name in &plan.networks {
        docker.remove_network(name).await?;
        println!("removed network {name}");
    }
    Ok(())
}

fn print_group(heading: &str, names: &[String]) {
    if names.is_empty() {
        return;
    }
    println!("{heading} ({}):", names.len());
    for name in names {
        println!("  {name}");
    }
}

fn print_plan(plan: &Plan) {
    print_group(
        "RUNNING containers — live sessions, stopped then removed",
        &plan.stop_containers,
    );
    print_group("stopped containers", &plan.remove_containers);
    print_group("volumes", &plan.volumes);
    print_group("networks", &plan.networks);
    if plan.reclaimed_bytes > 0 {
        println!(
            "reclaims about {} MiB",
            plan.reclaimed_bytes / (1024 * 1024)
        );
    }
}

/// Ask on a TTY; refuse without one. A script that wants to prune must say
/// `--force` — silence is not consent for a deletion tool.
fn confirm(plan: &Plan) -> anyhow::Result<bool> {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() {
        anyhow::bail!("no terminal to confirm on; pass --force to prune from a script");
    }
    println!("this will remove:");
    print_plan(plan);
    if !plan.stop_containers.is_empty() {
        println!(
            "\nWARNING: {} RUNNING container(s) will be stopped — someone may be working in them",
            plan.stop_containers.len()
        );
    }
    print!("proceed? [y/N] ");
    use std::io::Write as _;
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
}

/// `envmux prune`: sweep envmux-labelled leftovers straight from Docker.
pub async fn run(all: bool, dry_run: bool, force: bool) -> anyhow::Result<()> {
    let docker = DockerHandle::connect().context("connecting to docker")?;
    docker.ping().await.context("docker is not reachable")?;

    let (containers, volumes, networks) = collect(&docker).await?;
    let plan = plan(&containers, &volumes, &networks, all);

    if plan.is_empty() {
        println!("nothing to prune");
        return Ok(());
    }

    if dry_run {
        println!("would remove:");
        print_plan(&plan);
        return Ok(());
    }

    if !force && !confirm(&plan)? {
        println!("not pruning");
        return Ok(());
    }

    execute(&docker, &plan).await?;
    if plan.reclaimed_bytes > 0 {
        println!(
            "reclaimed about {} MiB",
            plan.reclaimed_bytes / (1024 * 1024)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(name: &str, running: bool, labelled: bool) -> ContainerFacts {
        ContainerFacts {
            name: name.to_owned(),
            running,
            labelled,
            volumes: Vec::new(),
            networks: Vec::new(),
        }
    }

    fn volume(name: &str, labelled: bool) -> VolumeFacts {
        VolumeFacts {
            name: name.to_owned(),
            labelled,
            size_bytes: None,
        }
    }

    fn network(name: &str, labelled: bool) -> NetworkFacts {
        NetworkFacts {
            name: name.to_owned(),
            labelled,
        }
    }

    #[test]
    fn keeps_running_containers_by_default() {
        let containers = [
            container("live", true, true),
            container("dead", false, true),
        ];
        let plan = plan(&containers, &[], &[], false);
        assert_eq!(plan.remove_containers, ["dead"]);
        assert!(plan.stop_containers.is_empty());
    }

    #[test]
    fn all_takes_running_containers_through_the_stop_list() {
        let containers = [
            container("live", true, true),
            container("dead", false, true),
        ];
        let plan = plan(&containers, &[], &[], true);
        assert_eq!(plan.stop_containers, ["live"]);
        assert_eq!(plan.remove_containers, ["dead"]);
    }

    #[test]
    fn volume_attached_to_a_survivor_is_kept() {
        let mut live = container("live", true, true);
        live.volumes = vec!["held".to_owned()];
        let volumes = [volume("held", true), volume("loose", true)];
        let plan = plan(&[live], &volumes, &[], false);
        assert_eq!(plan.volumes, ["loose"]);
    }

    #[test]
    fn all_releases_the_survivors_volumes_too() {
        let mut live = container("live", true, true);
        live.volumes = vec!["held".to_owned()];
        let volumes = [volume("held", true)];
        let plan = plan(&[live], &volumes, &[], true);
        assert_eq!(plan.volumes, ["held"]);
    }

    #[test]
    fn network_with_a_remaining_container_is_kept() {
        let mut live = container("live", true, true);
        live.networks = vec!["envmux-proj".to_owned()];
        let networks = [network("envmux-proj", true), network("envmux-idle", true)];
        let plan = plan(&[live], &[], &networks, false);
        assert_eq!(plan.networks, ["envmux-idle"]);
    }

    #[test]
    fn unlabelled_resources_never_appear() {
        let containers = [container("theirs", false, false)];
        let volumes = [volume("their-data", false)];
        // Labelled but not envmux-named, and named but unlabelled: neither goes.
        let networks = [network("bridge", false), network("something-else", true)];
        let plan = plan(&containers, &volumes, &networks, true);
        assert!(plan.is_empty());
    }

    #[test]
    fn reclaimed_bytes_sum_only_what_the_listing_knew() {
        let volumes = [
            VolumeFacts {
                name: "a".to_owned(),
                labelled: true,
                size_bytes: Some(5 * 1024 * 1024),
            },
            volume("b", true),
        ];
        let plan = plan(&[], &volumes, &[], false);
        assert_eq!(plan.reclaimed_bytes, 5 * 1024 * 1024);
    }

    /// Real round trip against Docker: a stopped labelled container and its
    /// labelled volume are created, pruned, and verifiably gone.
    ///
    /// ```console
    /// $ cargo test -p envmux-cli prune -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "needs a Docker daemon; removes ALL stopped envmux containers on it"]
    async fn a_real_prune_removes_a_stopped_container_and_its_volume() {
        use envmux_core::{Labels, Role, VolumeClass};
        use envmux_docker::{ContainerSpec, VolumeMountSpec, VolumeSpec};

        let docker = DockerHandle::connect().unwrap();
        docker.ping().await.expect("docker daemon");

        let ns: envmux_core::NamespaceName = "envmux-prune-test".parse().unwrap();
        let labels = Labels::new(ns.clone(), Role::Workspace);
        let volume_name = "envmux-prune-test-vol";
        let container_name = "envmux-prune-test-ws";

        docker
            .create_volume(VolumeSpec {
                name: volume_name.to_owned(),
                labels: labels.clone().class(VolumeClass::Cache),
            })
            .await
            .expect("create volume");
        docker
            .pull_image("busybox:latest")
            .await
            .expect("pull busybox");
        let mut spec = ContainerSpec::new(container_name, "busybox:latest", labels);
        spec.cmd = Some(vec!["sleep".to_owned(), "infinity".to_owned()]);
        spec.mounts = vec![VolumeMountSpec::volume(volume_name, "/data", false)];
        // Created but never started: a stopped container in the default sweep.
        docker
            .create_container(spec)
            .await
            .expect("create container");

        let (containers, volumes, networks) = collect(&docker).await.unwrap();
        let plan = plan(&containers, &volumes, &networks, false);
        assert!(plan.remove_containers.iter().any(|n| n == container_name));
        assert!(plan.volumes.iter().any(|n| n == volume_name));
        execute(&docker, &plan).await.expect("execute prune");

        let (containers, volumes, _) = collect(&docker).await.unwrap();
        assert!(
            !containers.iter().any(|c| c.name == container_name),
            "container survived the prune"
        );
        assert!(
            !volumes.iter().any(|v| v.name == volume_name),
            "volume survived the prune"
        );
    }
}
