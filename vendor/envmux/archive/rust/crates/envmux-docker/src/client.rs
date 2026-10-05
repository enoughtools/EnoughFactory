//! The labelled client: connection, labelled create builders, and filtered
//! list/inspect/remove operations.

use std::collections::HashMap;

use bollard::Docker;
use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, RemoveContainerOptions,
    StartContainerOptions, StopContainerOptions,
};
use bollard::models::{
    ContainerSummary, HealthConfig, HostConfig, Mount, MountTypeEnum, Network, Volume,
};
use bollard::network::{CreateNetworkOptions, ListNetworksOptions};
use bollard::volume::{CreateVolumeOptions, ListVolumesOptions, RemoveVolumeOptions};
use envmux_core::{Labels, NamespaceName, labels as l};

use crate::DockerError;

/// Cheap-to-clone handle over the bollard client.
#[derive(Clone)]
pub struct DockerHandle {
    inner: Docker,
}

/// Alias for call sites that prefer the trait-object-free concrete type.
pub type DockerClient = DockerHandle;

/// A mount for a container spec: a named volume or a host bind.
///
/// Binds exist for the mirror and shadow repositories, which host git must
/// reach directly; workspace *source* never binds to the host.
#[derive(Debug, Clone)]
pub struct VolumeMountSpec {
    /// Volume name, or host path for a bind mount.
    pub volume: String,
    pub target: String,
    pub read_only: bool,
    pub bind: bool,
}

impl VolumeMountSpec {
    #[must_use]
    pub fn volume(name: impl Into<String>, target: impl Into<String>, read_only: bool) -> Self {
        Self {
            volume: name.into(),
            target: target.into(),
            read_only,
            bind: false,
        }
    }

    #[must_use]
    pub fn bind(host_path: impl Into<String>, target: impl Into<String>, read_only: bool) -> Self {
        Self {
            volume: host_path.into(),
            target: target.into(),
            read_only,
            bind: true,
        }
    }
}

/// Everything needed to create a labelled container.
pub struct ContainerSpec {
    pub name: String,
    pub image: String,
    pub labels: Labels,
    pub env: Vec<String>,
    pub cmd: Option<Vec<String>>,
    pub entrypoint: Option<Vec<String>>,
    pub user: Option<String>,
    pub working_dir: Option<String>,
    pub network: Option<String>,
    /// DNS aliases on the attached network.
    pub network_aliases: Vec<String>,
    pub mounts: Vec<VolumeMountSpec>,
    pub health: Option<HealthConfig>,
    pub nano_cpus: Option<i64>,
    pub memory_bytes: Option<i64>,
    /// Run with Docker privileged mode. Callers must expose this only through
    /// an explicitly dangerous opt-in.
    pub privileged: bool,
    /// Keep the container alive with an idle init command when the image has
    /// no long-running entrypoint (workspaces: `sleep infinity`).
    pub init_idle: bool,
    /// Container ports published to loopback with an ephemeral host port
    /// (service admin endpoints only; workspaces publish nothing).
    pub loopback_ports: Vec<u16>,
}

impl ContainerSpec {
    #[must_use]
    pub fn new(name: impl Into<String>, image: impl Into<String>, labels: Labels) -> Self {
        Self {
            name: name.into(),
            image: image.into(),
            labels,
            env: Vec::new(),
            cmd: None,
            entrypoint: None,
            user: None,
            working_dir: None,
            network: None,
            network_aliases: Vec::new(),
            mounts: Vec::new(),
            health: None,
            nano_cpus: None,
            memory_bytes: None,
            privileged: false,
            init_idle: false,
            loopback_ports: Vec::new(),
        }
    }
}

/// A labelled named volume.
pub struct VolumeSpec {
    pub name: String,
    pub labels: Labels,
}

/// A labelled user-defined bridge network.
pub struct NetworkSpec {
    pub name: String,
    pub labels: Labels,
}

fn label_filter(namespace: Option<&NamespaceName>) -> HashMap<String, Vec<String>> {
    let mut filters = HashMap::new();
    let mut labels = vec![format!("{}={}", l::LABEL_SCHEMA, l::LABEL_SCHEMA_VERSION)];
    if let Some(ns) = namespace {
        labels.push(format!("{}={}", l::LABEL_NAMESPACE, ns));
    }
    filters.insert("label".to_owned(), labels);
    filters
}

impl DockerHandle {
    /// Connect over the local socket / named pipe.
    pub fn connect() -> Result<Self, DockerError> {
        Ok(Self {
            inner: Docker::connect_with_local_defaults()?,
        })
    }

    /// Escape hatch for operations this wrapper does not cover. Callers in
    /// the daemon should prefer the typed methods.
    #[must_use]
    pub fn raw(&self) -> &Docker {
        &self.inner
    }

    pub async fn ping(&self) -> Result<(), DockerError> {
        self.inner.ping().await?;
        Ok(())
    }

    // -- containers ---------------------------------------------------------

    pub async fn create_container(&self, spec: ContainerSpec) -> Result<String, DockerError> {
        let mounts: Vec<Mount> = spec
            .mounts
            .iter()
            .map(|m| Mount {
                target: Some(m.target.clone()),
                source: Some(m.volume.clone()),
                typ: Some(if m.bind {
                    MountTypeEnum::BIND
                } else {
                    MountTypeEnum::VOLUME
                }),
                read_only: Some(m.read_only),
                ..Default::default()
            })
            .collect();

        let port_bindings = if spec.loopback_ports.is_empty() {
            None
        } else {
            let mut map = HashMap::new();
            for port in &spec.loopback_ports {
                map.insert(
                    format!("{port}/tcp"),
                    Some(vec![bollard::models::PortBinding {
                        host_ip: Some("127.0.0.1".to_owned()),
                        host_port: Some(String::new()), // ephemeral
                    }]),
                );
            }
            Some(map)
        };

        let host_config = HostConfig {
            mounts: if mounts.is_empty() {
                None
            } else {
                Some(mounts)
            },
            network_mode: spec.network.clone(),
            nano_cpus: spec.nano_cpus,
            memory: spec.memory_bytes,
            privileged: Some(spec.privileged),
            init: Some(true),
            port_bindings,
            ..Default::default()
        };
        let exposed_ports = if spec.loopback_ports.is_empty() {
            None
        } else {
            Some(
                spec.loopback_ports
                    .iter()
                    .map(|p| (format!("{p}/tcp"), HashMap::new()))
                    .collect(),
            )
        };

        let networking_config = spec.network.as_ref().map(|net| {
            let mut endpoints = HashMap::new();
            endpoints.insert(
                net.clone(),
                bollard::models::EndpointSettings {
                    aliases: if spec.network_aliases.is_empty() {
                        None
                    } else {
                        Some(spec.network_aliases.clone())
                    },
                    ..Default::default()
                },
            );
            bollard::container::NetworkingConfig {
                endpoints_config: endpoints,
            }
        });

        let cmd = if spec.init_idle && spec.cmd.is_none() {
            Some(vec!["sleep".to_owned(), "infinity".to_owned()])
        } else {
            spec.cmd.clone()
        };

        let config = Config {
            image: Some(spec.image.clone()),
            cmd,
            entrypoint: spec.entrypoint.clone(),
            env: if spec.env.is_empty() {
                None
            } else {
                Some(spec.env.clone())
            },
            user: spec.user.clone(),
            working_dir: spec.working_dir.clone(),
            labels: Some(spec.labels.to_map()),
            healthcheck: spec.health.clone(),
            exposed_ports,
            host_config: Some(host_config),
            networking_config,
            ..Default::default()
        };

        let created = self
            .inner
            .create_container(
                Some(CreateContainerOptions {
                    name: spec.name.clone(),
                    platform: None,
                }),
                config,
            )
            .await?;
        Ok(created.id)
    }

    pub async fn start_container(&self, name: &str) -> Result<(), DockerError> {
        self.inner
            .start_container(name, None::<StartContainerOptions<String>>)
            .await?;
        Ok(())
    }

    pub async fn stop_container(&self, name: &str, timeout_secs: i64) -> Result<(), DockerError> {
        match self
            .inner
            .stop_container(name, Some(StopContainerOptions { t: timeout_secs }))
            .await
        {
            Ok(()) => Ok(()),
            Err(e) => {
                let e = DockerError::from(e);
                if e.is_not_found() { Ok(()) } else { Err(e) }
            }
        }
    }

    /// Remove a container; tolerates 404 so destroy steps stay idempotent.
    pub async fn remove_container(&self, name: &str) -> Result<(), DockerError> {
        match self
            .inner
            .remove_container(
                name,
                Some(RemoveContainerOptions {
                    force: true,
                    v: false,
                    ..Default::default()
                }),
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(e) => {
                let e = DockerError::from(e);
                if e.is_not_found() { Ok(()) } else { Err(e) }
            }
        }
    }

    /// List envmux containers, optionally narrowed to a namespace. Never
    /// lists the world.
    pub async fn list_containers(
        &self,
        namespace: Option<&NamespaceName>,
    ) -> Result<Vec<ContainerSummary>, DockerError> {
        Ok(self
            .inner
            .list_containers(Some(ListContainersOptions {
                all: true,
                filters: label_filter(namespace),
                ..Default::default()
            }))
            .await?)
    }

    pub async fn inspect_container(
        &self,
        name: &str,
    ) -> Result<bollard::models::ContainerInspectResponse, DockerError> {
        Ok(self.inner.inspect_container(name, None).await?)
    }

    /// The loopback host port a container port was published to, if any.
    pub async fn published_port(
        &self,
        name: &str,
        container_port: u16,
    ) -> Result<Option<u16>, DockerError> {
        let inspect = self.inspect_container(name).await?;
        Ok(inspect
            .network_settings
            .and_then(|n| n.ports)
            .and_then(|p| p.get(&format!("{container_port}/tcp")).cloned())
            .flatten()
            .and_then(|bindings| {
                bindings
                    .iter()
                    .find_map(|b| b.host_port.as_ref().and_then(|hp| hp.parse().ok()))
            }))
    }

    /// Health state per the container's own healthcheck: `None` when no
    /// healthcheck is configured or the container is not running.
    pub async fn container_healthy(&self, name: &str) -> Result<Option<bool>, DockerError> {
        let inspect = self.inspect_container(name).await?;
        let health = inspect.state.as_ref().and_then(|s| s.health.as_ref());
        Ok(health
            .and_then(|h| h.status)
            .map(|s| matches!(s, bollard::models::HealthStatusEnum::HEALTHY)))
    }

    // -- volumes ------------------------------------------------------------

    pub async fn create_volume(&self, spec: VolumeSpec) -> Result<(), DockerError> {
        self.inner
            .create_volume(CreateVolumeOptions {
                name: spec.name.clone(),
                labels: spec.labels.to_map(),
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    pub async fn remove_volume(&self, name: &str) -> Result<(), DockerError> {
        match self
            .inner
            .remove_volume(name, Some(RemoveVolumeOptions { force: true }))
            .await
        {
            Ok(()) => Ok(()),
            Err(e) => {
                let e = DockerError::from(e);
                if e.is_not_found() { Ok(()) } else { Err(e) }
            }
        }
    }

    pub async fn list_volumes(
        &self,
        namespace: Option<&NamespaceName>,
    ) -> Result<Vec<Volume>, DockerError> {
        let resp = self
            .inner
            .list_volumes(Some(ListVolumesOptions {
                filters: label_filter(namespace),
            }))
            .await?;
        Ok(resp.volumes.unwrap_or_default())
    }

    // -- networks -----------------------------------------------------------

    pub async fn create_network(&self, spec: NetworkSpec) -> Result<(), DockerError> {
        self.inner
            .create_network(CreateNetworkOptions {
                name: spec.name.clone(),
                driver: "bridge".to_owned(),
                labels: spec.labels.to_map(),
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    pub async fn list_networks(
        &self,
        namespace: Option<&NamespaceName>,
    ) -> Result<Vec<Network>, DockerError> {
        Ok(self
            .inner
            .list_networks(Some(ListNetworksOptions {
                filters: label_filter(namespace),
            }))
            .await?)
    }

    pub async fn remove_network(&self, name: &str) -> Result<(), DockerError> {
        match self.inner.remove_network(name).await {
            Ok(()) => Ok(()),
            Err(e) => {
                let e = DockerError::from(e);
                if e.is_not_found() { Ok(()) } else { Err(e) }
            }
        }
    }

    // -- images -------------------------------------------------------------

    pub async fn pull_image(&self, reference: &str) -> Result<(), DockerError> {
        use futures_util::TryStreamExt as _;
        self.inner
            .create_image(
                Some(bollard::image::CreateImageOptions {
                    from_image: reference.to_owned(),
                    ..Default::default()
                }),
                None,
                None,
            )
            .try_collect::<Vec<_>>()
            .await?;
        Ok(())
    }

    pub async fn image_exists(&self, reference: &str) -> Result<bool, DockerError> {
        match self.inner.inspect_image(reference).await {
            Ok(_) => Ok(true),
            Err(e) => {
                let e = DockerError::from(e);
                if e.is_not_found() { Ok(false) } else { Err(e) }
            }
        }
    }

    // -- events -------------------------------------------------------------

    /// Subscribe to die/destroy events on envmux-labelled containers. Events
    /// are a hint; reconciliation remains the source of truth.
    pub fn events(
        &self,
        namespace: Option<&NamespaceName>,
    ) -> impl futures_util::Stream<
        Item = Result<bollard::models::EventMessage, bollard::errors::Error>,
    > + use<> {
        let mut filters = label_filter(namespace);
        filters.insert("type".to_owned(), vec!["container".to_owned()]);
        filters.insert(
            "event".to_owned(),
            vec!["die".to_owned(), "destroy".to_owned(), "stop".to_owned()],
        );
        self.inner
            .events(Some(bollard::system::EventsOptions::<String> {
                since: None,
                until: None,
                filters,
            }))
    }
}
