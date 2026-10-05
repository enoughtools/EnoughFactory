//! The in-session router: a loopback reverse proxy serving `[routes]` /
//! `[routing]` from `.envmux.toml`.
//!
//! It listens on 127.0.0.1 (configured port, default with fallback), reads
//! the Host header of each request, resolves the single-label host —
//! `{namespace}{delimiter}{workspace}{delimiter}{route}.{domain}` — against
//! every registered namespace, and proxies to the loopback port Docker
//! published for that workspace container's declared route port. Resolution
//! is per-request, so namespaces registered after the router started are
//! routable immediately.

use std::collections::BTreeMap;
use std::sync::Arc;

use envmux_config::Routing;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt as _, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio_util::sync::CancellationToken;

use crate::context::{Ctx, NamespaceCtx};

/// The router's default loopback listen port when no namespace configures one.
pub(crate) const DEFAULT_PORT: u16 = 8080;

/// How many consecutive ports to try upward from the preferred one.
const BIND_ATTEMPTS: u16 = 20;

// -- host resolution --------------------------------------------------------

/// A resolved routed host: which namespace/workspace/route the label named,
/// and the container port that route declares.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct HostMatch {
    pub namespace: String,
    pub workspace: String,
    pub route: String,
    pub container_port: u16,
}

/// Lowercase the host (hostnames are case-insensitive) and strip any `:port`.
fn normalize_host(host: &str) -> String {
    let host = host.trim();
    let host = match host.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => host,
    };
    host.to_ascii_lowercase()
}

/// Resolve a Host header value against a set of namespace routing configs.
///
/// The label is matched as `{ns}{d}{ws}{d}{route}.{domain}`: the namespace is
/// matched as a prefix and the route split off the right, so this stays
/// correct even for a user-requested workspace name containing the delimiter
/// — route names and namespaces reject `_` (config validation), and generated
/// workspace names are petnames: lowercase ASCII and hyphens.
pub(crate) fn resolve_host<'a>(
    host: &str,
    namespaces: impl IntoIterator<Item = (&'a str, &'a Routing, &'a BTreeMap<String, u16>)>,
) -> Option<HostMatch> {
    let host = normalize_host(host);
    for (ns, routing, routes) in namespaces {
        let suffix = format!(".{}", routing.effective_domain().to_ascii_lowercase());
        let Some(label) = host.strip_suffix(suffix.as_str()) else {
            continue;
        };
        // The routed host is a single label under the domain by design.
        if label.contains('.') {
            continue;
        }
        let d = routing.delimiter.as_str();
        let Some(rest) = label.strip_prefix(ns).and_then(|r| r.strip_prefix(d)) else {
            continue;
        };
        let Some((workspace, route)) = rest.rsplit_once(d) else {
            continue;
        };
        if workspace.is_empty() {
            continue;
        }
        if let Some(&container_port) = routes.get(route) {
            return Some(HostMatch {
                namespace: ns.to_owned(),
                workspace: workspace.to_owned(),
                route: route.to_owned(),
                container_port,
            });
        }
    }
    None
}

// -- resolvers --------------------------------------------------------------

/// Why a request could not be proxied.
pub(crate) enum RouteError {
    /// The host names nothing we know → 404 naming the expected pattern.
    NoRoute(String),
    /// The host resolved but there is nothing to proxy to → 502.
    NoBackend(String),
}

/// Turns a Host header value into the loopback port to proxy to.
///
/// The daemon's implementation consults registered namespaces and Docker;
/// tests substitute a stub — that seam is what keeps the proxy core testable
/// without Docker.
pub(crate) trait Resolve: Send + Sync + 'static {
    fn resolve(&self, host: &str) -> impl Future<Output = Result<u16, RouteError>> + Send;
}

/// One namespace's routing-relevant state, snapshotted per request.
struct NamespaceSnapshot {
    name: String,
    ns: Arc<NamespaceCtx>,
    routing: Routing,
    routes: BTreeMap<String, u16>,
}

/// The live resolver: registered namespaces → workspace container name → the
/// loopback port Docker published for the route's container port.
pub(crate) struct CtxResolver {
    ctx: Arc<Ctx>,
}

impl Resolve for CtxResolver {
    async fn resolve(&self, host: &str) -> Result<u16, RouteError> {
        let mut rows = Vec::new();
        {
            let namespaces = self.ctx.namespaces.read().await;
            for (name, ns) in namespaces.iter() {
                let resolved = ns.resolved.read().await;
                rows.push(NamespaceSnapshot {
                    name: name.clone(),
                    ns: Arc::clone(ns),
                    routing: resolved.config.routing.clone(),
                    routes: resolved.config.routes.clone(),
                });
            }
        }
        rows.sort_by(|a, b| a.name.cmp(&b.name));

        let matched = resolve_host(
            host,
            rows.iter()
                .map(|r| (r.name.as_str(), &r.routing, &r.routes)),
        )
        .ok_or_else(|| RouteError::NoRoute(no_route_message(host, &rows)))?;

        let ns = rows
            .iter()
            .find(|r| r.name == matched.namespace)
            .map(|r| Arc::clone(&r.ns))
            .expect("matched namespace came from this snapshot");
        let container = ns.workspace_container_name(&matched.workspace);
        match self
            .ctx
            .docker
            .published_port(&container, matched.container_port)
            .await
        {
            Ok(Some(port)) => Ok(port),
            Ok(None) => Err(RouteError::NoBackend(format!(
                "route {:?} maps to container port {} of {container}, but Docker publishes no loopback port for it; is the workspace running?",
                matched.route, matched.container_port
            ))),
            Err(e) => Err(RouteError::NoBackend(format!(
                "route {:?} resolved to workspace container {container}, which could not be inspected: {e}",
                matched.route
            ))),
        }
    }
}

fn no_route_message(host: &str, rows: &[NamespaceSnapshot]) -> String {
    rows.first().map_or_else(
        || format!("no route for host {host:?}: no namespaces are registered with this daemon"),
        |first| {
            format!(
                "no route for host {host:?}; expected {}",
                first
                    .routing
                    .host_for("<namespace>", "<workspace>", "<route>")
            )
        },
    )
}

// -- the proxy core ---------------------------------------------------------

type ProxyBody = BoxBody<Bytes, hyper::Error>;

fn text_response(status: StatusCode, message: &str) -> Response<ProxyBody> {
    let body = Full::new(Bytes::from(format!("{message}\n")))
        .map_err(|infallible| match infallible {})
        .boxed();
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body)
        .expect("static response builds")
}

/// Proxy one request. Routing problems never fail the connection: they become
/// 404/502 responses with a one-line explanation.
pub(crate) async fn handle<R: Resolve>(
    resolver: &R,
    mut req: Request<Incoming>,
) -> Response<ProxyBody> {
    let Some(host) = req
        .headers()
        .get(hyper::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(normalize_host)
    else {
        return text_response(
            StatusCode::NOT_FOUND,
            "request carries no usable Host header, and the router routes by host",
        );
    };

    let port = match resolver.resolve(&host).await {
        Ok(port) => port,
        Err(RouteError::NoRoute(msg)) => return text_response(StatusCode::NOT_FOUND, &msg),
        Err(RouteError::NoBackend(msg)) => return text_response(StatusCode::BAD_GATEWAY, &msg),
    };

    // Hygiene invariant: the router only ever dials 127.0.0.1, and only on a
    // port its resolver produced — for the live resolver, a port Docker
    // published on loopback for an envmux-labelled workspace container. It
    // cannot be steered at an arbitrary host or port, which is what makes a
    // listening localhost proxy safe to run.
    let stream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => s,
        Err(e) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("host {host} resolved, but connecting to 127.0.0.1:{port} failed: {e}"),
            );
        }
    };
    let (mut sender, conn) = match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    {
        Ok(pair) => pair,
        Err(e) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("HTTP handshake with 127.0.0.1:{port} failed: {e}"),
            );
        }
    };
    tokio::spawn(async move {
        if let Err(e) = conn.with_upgrades().await {
            tracing::debug!(error = %e, "router upstream connection ended with error");
        }
    });

    // Upgrade (WebSocket etc.) passthrough: capture both sides' upgrade
    // futures, and splice the raw byte streams once both have switched.
    let wants_upgrade = req.headers().contains_key(hyper::header::UPGRADE);
    let client_upgrade = hyper::upgrade::on(&mut req);
    let mut resp = match sender.send_request(req).await {
        Ok(r) => r,
        Err(e) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("proxying to 127.0.0.1:{port} failed: {e}"),
            );
        }
    };
    if wants_upgrade && resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        let server_upgrade = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            match tokio::try_join!(client_upgrade, server_upgrade) {
                Ok((client, server)) => {
                    let mut client = TokioIo::new(client);
                    let mut server = TokioIo::new(server);
                    if let Err(e) = tokio::io::copy_bidirectional(&mut client, &mut server).await {
                        tracing::debug!(error = %e, "upgraded stream ended with error");
                    }
                }
                Err(e) => tracing::debug!(error = %e, "completing protocol upgrade failed"),
            }
        });
    }
    resp.map(|body| body.boxed())
}

// -- listener ---------------------------------------------------------------

/// Bind on 127.0.0.1, trying `attempts` consecutive ports upward from
/// `preferred`. Returns the listener and the port it actually got.
pub(crate) async fn bind_with_fallback(
    preferred: u16,
    attempts: u16,
) -> std::io::Result<(tokio::net::TcpListener, u16)> {
    let mut last_err = None;
    for offset in 0..attempts {
        let Some(candidate) = preferred.checked_add(offset) else {
            break;
        };
        match tokio::net::TcpListener::bind(("127.0.0.1", candidate)).await {
            Ok(listener) => {
                let port = listener.local_addr()?.port();
                return Ok((listener, port));
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no bind attempts were possible")))
}

/// Accept loop: serve every connection with the proxy core until cancelled.
pub(crate) async fn serve<R: Resolve>(
    listener: tokio::net::TcpListener,
    resolver: Arc<R>,
    cancel: CancellationToken,
) {
    loop {
        let stream = tokio::select! {
            () = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _peer)) => stream,
                Err(e) => {
                    tracing::debug!(error = %e, "router accept failed");
                    continue;
                }
            },
        };
        let resolver = Arc::clone(&resolver);
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req| {
                let resolver = Arc::clone(&resolver);
                async move { Ok::<_, std::convert::Infallible>(handle(&*resolver, req).await) }
            });
            let conn = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            tokio::select! {
                () = cancel.cancelled() => {}
                served = conn => {
                    if let Err(e) = served {
                        tracing::debug!(error = %e, "router connection ended with error");
                    }
                }
            }
        });
    }
}

/// The port the router should try first: the first registered namespace's
/// `routing.port` (registration order is not tracked, so "first" is by name,
/// deterministically), else the compiled-in default. Disagreements are logged
/// — one daemon runs one router.
async fn preferred_port(ctx: &Ctx) -> u16 {
    let namespaces = ctx.namespaces.read().await;
    let mut names: Vec<&String> = namespaces.keys().collect();
    names.sort();
    let mut chosen: Option<(String, u16)> = None;
    for name in names {
        let Some(ns) = namespaces.get(name) else {
            continue;
        };
        let Some(port) = ns.resolved.read().await.config.routing.port else {
            continue;
        };
        match &chosen {
            None => chosen = Some((name.clone(), port)),
            Some((first, first_port)) if *first_port != port => tracing::warn!(
                namespace = %name,
                port,
                chosen_from = %first,
                chosen = first_port,
                "namespaces disagree on routing.port; the router uses the first"
            ),
            Some(_) => {}
        }
    }
    chosen.map_or(DEFAULT_PORT, |(_, port)| port)
}

/// Run the router component until cancelled. Spawned into the daemon's
/// JoinSet alongside the workers.
pub async fn run(ctx: Arc<Ctx>, cancel: CancellationToken) {
    let preferred = preferred_port(&ctx).await;
    let (listener, port) = match bind_with_fallback(preferred, BIND_ATTEMPTS).await {
        Ok(bound) => bound,
        Err(e) => {
            tracing::error!(preferred, error = %e, "router could not bind any loopback port; routing is disabled this session");
            ctx.event(
                "error",
                None,
                None,
                "router",
                &format!("could not bind a routing port starting at {preferred}: {e}"),
            )
            .await;
            // Stay alive: an unroutable session should not read as a crashed
            // daemon component and bring everything else down.
            cancel.cancelled().await;
            return;
        }
    };
    let _ = ctx.router_port.set(port);
    if port == preferred {
        tracing::info!(port, "in-session router listening on 127.0.0.1");
    } else {
        tracing::info!(
            preferred,
            port,
            "preferred router port was taken; in-session router listening on 127.0.0.1 at fallback"
        );
    }
    let resolver = Arc::new(CtxResolver {
        ctx: Arc::clone(&ctx),
    });
    serve(listener, resolver, cancel).await;
}

// -- tests ------------------------------------------------------------------

#[cfg(test)]
mod resolution_tests {
    use super::*;

    fn routing(domain: Option<&str>, delimiter: &str) -> Routing {
        Routing {
            port: None,
            domain: domain.map(str::to_owned),
            delimiter: delimiter.to_owned(),
        }
    }

    fn routes(pairs: &[(&str, u16)]) -> BTreeMap<String, u16> {
        pairs
            .iter()
            .map(|(name, port)| ((*name).to_owned(), *port))
            .collect()
    }

    #[test]
    fn resolves_an_exact_match() {
        let r = routing(Some("dev.test"), "_");
        let routes = routes(&[("web", 8080), ("editor", 3000)]);
        let m = resolve_host("acme_wobbly-otter_web.dev.test", [("acme", &r, &routes)])
            .expect("resolves");
        assert_eq!(
            m,
            HostMatch {
                namespace: "acme".into(),
                workspace: "wobbly-otter".into(),
                route: "web".into(),
                container_port: 8080,
            }
        );
    }

    #[test]
    fn the_platform_default_domain_resolves() {
        // Build the host with the same code that spells it in URLs, so this
        // test holds on every platform's default domain.
        let r = Routing::default();
        let routes = routes(&[("web", 8080)]);
        let host = r.host_for("acme", "wobbly-otter", "web");
        let m = resolve_host(&host, [("acme", &r, &routes)]).expect("resolves");
        assert_eq!(m.workspace, "wobbly-otter");
        assert_eq!(m.container_port, 8080);
    }

    #[test]
    fn the_wrong_domain_does_not_match() {
        let r = routing(Some("dev.test"), "_");
        let routes = routes(&[("web", 8080)]);
        assert_eq!(
            resolve_host("acme_ws_web.other.test", [("acme", &r, &routes)]),
            None
        );
        // A nested label under the right domain is not a routed host either.
        assert_eq!(
            resolve_host("evil.acme_ws_web.dev.test", [("acme", &r, &routes)]),
            None
        );
    }

    #[test]
    fn the_wrong_delimiter_count_does_not_match() {
        let r = routing(Some("dev.test"), "_");
        let routes = routes(&[("web", 8080)]);
        // Too few fields.
        assert_eq!(
            resolve_host("acme_web.dev.test", [("acme", &r, &routes)]),
            None
        );
        assert_eq!(resolve_host("acme.dev.test", [("acme", &r, &routes)]), None);
        // Empty workspace field.
        assert_eq!(
            resolve_host("acme__web.dev.test", [("acme", &r, &routes)]),
            None
        );
    }

    #[test]
    fn an_unknown_route_name_does_not_match() {
        let r = routing(Some("dev.test"), "_");
        let routes = routes(&[("web", 8080)]);
        assert_eq!(
            resolve_host("acme_ws_editor.dev.test", [("acme", &r, &routes)]),
            None
        );
    }

    #[test]
    fn custom_domain_and_delimiter_resolve() {
        let r = routing(Some("dev.example.test"), "--");
        let routes = routes(&[("web", 8080)]);
        let m = resolve_host(
            "acme--wobbly-otter--web.dev.example.test",
            [("acme", &r, &routes)],
        )
        .expect("resolves");
        // The workspace name contains single hyphens, the delimiter is a
        // double hyphen: the split cannot land inside the name.
        assert_eq!(m.workspace, "wobbly-otter");
        assert_eq!(m.route, "web");
    }

    #[test]
    fn hosts_match_case_insensitively_and_ports_are_stripped() {
        let r = routing(Some("dev.test"), "_");
        let routes = routes(&[("web", 8080)]);
        let m = resolve_host(
            "ACME_Wobbly-Otter_WEB.Dev.TEST:8081",
            [("acme", &r, &routes)],
        )
        .expect("hostnames are case-insensitive");
        assert_eq!(m.workspace, "wobbly-otter");
    }

    #[test]
    fn each_namespace_matches_under_its_own_config() {
        let acme = routing(Some("dev.test"), "_");
        let acme_routes = routes(&[("web", 8080)]);
        let beta = routing(Some("beta.test"), "--");
        let beta_routes = routes(&[("api", 9000)]);
        let namespaces = [("acme", &acme, &acme_routes), ("beta", &beta, &beta_routes)];
        let m = resolve_host("beta--ws--api.beta.test", namespaces).expect("resolves");
        assert_eq!(m.namespace, "beta");
        assert_eq!(m.container_port, 9000);
    }
}

#[cfg(test)]
mod listener_tests {
    use super::*;

    #[tokio::test]
    async fn bind_falls_back_when_the_preferred_port_is_taken() {
        // Occupy an ephemeral port (re-drawing away from the very top of the
        // range so the fallback window cannot run off the end of u16).
        let taken = loop {
            let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
            if l.local_addr().expect("addr").port() < u16::MAX - u16::from(BIND_ATTEMPTS) {
                break l;
            }
        };
        let taken_port = taken.local_addr().expect("addr").port();

        let (listener, port) = bind_with_fallback(taken_port, BIND_ATTEMPTS)
            .await
            .expect("a nearby port is free");
        assert_ne!(port, taken_port, "must skip the occupied port");
        assert!(
            port > taken_port && port <= taken_port + BIND_ATTEMPTS,
            "fallback stays within the attempt window: {port} vs {taken_port}"
        );
        assert_eq!(listener.local_addr().expect("addr").port(), port);
    }
}

#[cfg(test)]
mod proxy_tests {
    use http_body_util::BodyExt as _;

    use super::*;

    /// A tiny hyper backend standing in for a workspace container: echoes the
    /// request body and marks its responses with a header.
    async fn spawn_backend() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind backend");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let service = hyper::service::service_fn(|req: Request<Incoming>| async move {
                        let body = req.into_body().collect().await?.to_bytes();
                        Ok::<_, hyper::Error>(
                            Response::builder()
                                .header("x-proxied-backend", "yes")
                                .body(Full::new(body))
                                .expect("response builds"),
                        )
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        port
    }

    /// Resolver stub: one host maps to the backend, one resolves but has no
    /// backend, everything else is unknown.
    struct StubResolver {
        backend: u16,
    }

    impl Resolve for StubResolver {
        async fn resolve(&self, host: &str) -> Result<u16, RouteError> {
            match host {
                "acme_wobbly-otter_web.localhost" => Ok(self.backend),
                "acme_wobbly-otter_dead.localhost" => Err(RouteError::NoBackend(
                    "route \"dead\" has no published port".to_owned(),
                )),
                _ => Err(RouteError::NoRoute(
                    "no route; expected <namespace>_<workspace>_<route>.localhost".to_owned(),
                )),
            }
        }
    }

    async fn request(
        router_port: u16,
        host: &str,
        path: &str,
        body: &str,
    ) -> (StatusCode, hyper::HeaderMap, String) {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", router_port))
            .await
            .expect("connect to router");
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .expect("handshake");
        tokio::spawn(conn);
        let req = Request::builder()
            .method(hyper::Method::POST)
            .uri(path)
            .header(hyper::header::HOST, host)
            .body(Full::new(Bytes::from(body.to_owned())))
            .expect("request builds");
        let resp = sender.send_request(req).await.expect("response");
        let (parts, body) = resp.into_parts();
        let bytes = body.collect().await.expect("body").to_bytes();
        (
            parts.status,
            parts.headers,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    #[tokio::test]
    async fn requests_round_trip_through_the_proxy_without_docker() {
        let backend = spawn_backend().await;
        let (listener, router_port) = bind_with_fallback(0, 1).await.expect("bind router");
        let cancel = CancellationToken::new();
        tokio::spawn(serve(
            listener,
            Arc::new(StubResolver { backend }),
            cancel.clone(),
        ));

        // Round trip: status, body, and a backend header survive; the Host
        // is normalized (case, port) before it reaches the resolver.
        let (status, headers, body) = request(
            router_port,
            "ACME_Wobbly-Otter_WEB.LocalHost:1234",
            "/echo",
            "ping",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get("x-proxied-backend")
                .expect("backend header forwarded"),
            "yes"
        );
        assert_eq!(body, "ping");

        // Unresolvable host: 404 with the expected pattern in the body.
        let (status, _, body) = request(router_port, "nonsense.localhost", "/", "").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains("expected"), "{body}");

        // Resolvable but backendless: 502 with a useful body.
        let (status, _, body) =
            request(router_port, "acme_wobbly-otter_dead.localhost", "/", "").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.contains("dead"), "{body}");

        cancel.cancel();
    }
}
