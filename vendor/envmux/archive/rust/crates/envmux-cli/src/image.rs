//! Foreground image operations.
//!
//! The daemon builds images too, but it does so detached, streaming BuildKit
//! output into a log file — correct for a background service, opaque for a
//! developer iterating on a Dockerfile. `envmux image build` is the visible
//! path: the same tag the daemon would build (so registration finds it and
//! skips), with the docker CLI's own progress on this terminal. run-dev uses
//! it to front-load the slow part of a first session.

use anyhow::{Context as _, bail};

/// Build (or pull) the project's image in the foreground. `force` rebuilds
/// or re-pulls even when the image is already present.
pub async fn build(force: bool) -> anyhow::Result<()> {
    let root = crate::repo_root(&std::env::current_dir()?)?;
    let resolved = envmux_config::resolve_dir(&root).map_err(|e| anyhow::anyhow!("{e}"))?;
    let docker = envmux_docker::DockerHandle::connect().context("connecting to Docker")?;

    if let Some(reference) = &resolved.config.image.reference {
        if !force && docker.image_exists(reference).await? {
            println!("image {reference} already present");
            return Ok(());
        }
        run_docker(vec!["pull".into(), reference.clone()]).await?;
        return Ok(());
    }

    let dockerfile = resolved
        .config
        .image
        .dockerfile
        .as_deref()
        .expect("validation guarantees one image source");
    let tag = image_tag(&resolved)?;
    if !force && docker.image_exists(&tag).await? {
        println!("image {tag} already built for this config (--force rebuilds)");
        return Ok(());
    }

    let request = envmux_docker::BuildRequest {
        tag: tag.clone(),
        dockerfile: envmux_docker::resolve_dockerfile(&root, dockerfile),
        context: root.join(resolved.config.image.context.as_deref().unwrap_or(".")),
        build_args: resolved.config.image.args.clone(),
    };
    let mut argv = envmux_docker::build_argv(&request);
    // build_argv asks for line-oriented output because its usual reader is a
    // log file. A developer at a terminal gets BuildKit's live progress —
    // and a docker CLI without buildx gets no --progress at all, because
    // the legacy builder dies on the flag.
    {
        use std::io::IsTerminal as _;
        if std::io::stderr().is_terminal() || !envmux_docker::buildkit_available().await {
            argv.retain(|arg| arg != "--progress=plain");
        }
    }
    println!("building {tag} from {dockerfile}");
    run_docker(argv).await
}

/// Print the exact tag the daemon will look for — reference or built.
pub fn print_tag() -> anyhow::Result<()> {
    let root = crate::repo_root(&std::env::current_dir()?)?;
    let resolved = envmux_config::resolve_dir(&root).map_err(|e| anyhow::anyhow!("{e}"))?;
    match &resolved.config.image.reference {
        Some(reference) => println!("{reference}"),
        None => println!("{}", image_tag(&resolved)?),
    }
    Ok(())
}

fn image_tag(resolved: &envmux_config::ResolvedConfig) -> anyhow::Result<String> {
    let ns = crate::namespace_from_cwd()?;
    Ok(resolved.hash.image_tag(&ns))
}

/// Run the docker CLI with this terminal's stdio — visibility is the point.
async fn run_docker(argv: Vec<String>) -> anyhow::Result<()> {
    let status = tokio::process::Command::new("docker")
        .args(&argv)
        .status()
        .await
        .context("running the docker CLI (is it installed?)")?;
    if !status.success() {
        bail!(
            "docker {} failed ({status})",
            argv.first().map_or("", |s| s)
        );
    }
    Ok(())
}
