import { useEffect, useState } from 'react';
import { Button } from '@enoughtools/ui-react/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@enoughtools/ui-react/accordion';
import { formatBytes, parseReleaseManifest, platformLabel, type ReleaseManifest } from './releases';

type Route = 'home' | 'docs' | 'downloads' | 'not-found';
type Autonomy = 'manual' | 'assisted' | 'autonomous';
const fallback: ReleaseManifest = { schemaVersion: 1, product: 'EnoughFactory', version: '0.1.0', status: 'preparing', publishedAt: null, sourceUrl: null, artifacts: [] };
const modes: Record<Autonomy, { label: string; title: string; body: string; actions: string[] }> = {
  manual: { label: 'Manual', title: 'You choose the next move.', body: 'Open an environment, talk to an agent and decide what happens next. Everything stays together in the workbench.', actions: ['Choose a task', 'Work with an agent', 'Review the result'] },
  assisted: { label: 'Assisted', title: 'A plan you can steer.', body: 'Let the factory organize the work and suggest its next step. Keep decisions close while agents handle the execution.', actions: ['Make a plan', 'Approve the next task', 'Inspect the evidence'] },
  autonomous: { label: 'Autonomous', title: 'A goal the factory keeps pursuing.', body: 'Set the outcome. The factory breaks it into work, coordinates agents, evaluates results and continues through repair or replanning.', actions: ['Plan and dispatch', 'Evaluate and repair', 'Continue toward the goal'] },
};

function routeFromPath(path: string): Route {
  if (path.replace(/\/$/, '') === '/docs') return 'docs';
  if (path.replace(/\/$/, '') === '/downloads') return 'downloads';
  return path === '/' ? 'home' : 'not-found';
}

export function App({ initialPath, initialManifest }: { initialPath?: string; initialManifest?: ReleaseManifest }) {
  const route = routeFromPath(initialPath ?? (typeof window === 'undefined' ? '/' : window.location.pathname));
  const [release, setRelease] = useState(initialManifest ?? fallback);
  const [releaseState, setReleaseState] = useState<'loading' | 'ready' | 'error'>(initialManifest ? 'ready' : 'loading');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/downloads/manifest.json', { signal: controller.signal, cache: 'no-cache' })
      .then(response => { if (!response.ok) throw new Error('Release catalog unavailable'); return response.json(); })
      .then(value => { setRelease(parseReleaseManifest(value)); setReleaseState('ready'); })
      .catch(error => { if (error.name !== 'AbortError') setReleaseState('error'); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const title = route === 'docs' ? 'Guide' : route === 'downloads' ? 'Downloads' : route === 'not-found' ? 'Page not found' : 'Your devices. One software factory.';
    document.title = `EnoughFactory — ${title}`;
  }, [route]);

  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header wrap">
      <a className="wordmark" href="/" aria-label="EnoughFactory home"><img src="/brand/mark-ink.svg" width="34" height="34" alt="" /><span>Enough<span className="wordmark-module">Factory</span></span></a>
      <nav aria-label="Main navigation">
        <a href="/#how-it-works">How it works</a>
        <a href="/docs" aria-current={route === 'docs' ? 'page' : undefined}>Guide</a>
        <Button asChild variant="ink" className="header-download"><a href="/downloads" aria-current={route === 'downloads' ? 'page' : undefined}>Get EnoughFactory</a></Button>
      </nav>
    </header>
    <main id="main">
      {route === 'home' ? <Home release={release} /> : route === 'docs' ? <Guide release={release} /> : route === 'downloads' ? <Downloads release={release} state={releaseState} /> : <div className="wrap inner-page"><p className="eyebrow">404 / Page not found</p><h1>This page is unavailable.</h1><p className="page-intro">Find the current release or start with the product guide.</p><div className="hero-actions"><Button asChild variant="accent"><a href="/downloads">Downloads</a></Button><a className="text-link" href="/docs">Read the guide</a></div></div>}
    </main>
    <footer className="site-footer wrap">
      <div><a className="wordmark" href="/">Enough<span className="wordmark-module">Factory</span></a><p>Software worth putting to work.</p></div>
      <nav aria-label="Footer navigation"><a href="/docs">Guide</a><a href="/downloads">Downloads</a>{release.status === 'published' && <a href="/app">Browser app</a>}{release.sourceUrl ? <a href={release.sourceUrl}>Source code</a> : <a href="/docs#open-source">Open source</a>}<a href="https://ui.enoughtools.com">Made with EnoughUI</a></nav>
      <span className="footer-note">An Enough tool. Open source.</span>
    </footer>
  </>;
}

function ReleaseStatus({ release }: { release: ReleaseManifest }) {
  return <span className="release-status">{release.status === 'published' ? `Version ${release.version} · Mac & Linux` : 'In development · Mac & Linux'}</span>;
}

function Home({ release }: { release: ReleaseManifest }) {
  return <>
    <section className="hero wrap">
      <div className="hero-copy">
        <p className="eyebrow">Open software for agentic development</p>
        <h1>Your devices.<br /><em>One software factory.</em></h1>
        <p className="hero-description">Bring your environments, agents and machines into one workspace. Give them a goal, see the work unfold and decide how much the factory does on its own.</p>
        <div className="hero-actions"><Button asChild variant="accent" size="lg"><a href="/downloads">Get EnoughFactory</a></Button><a className="text-link" href={release.status === 'published' ? '/app' : '/docs'}>{release.status === 'published' ? 'Open in browser' : 'Read the guide'}</a></div>
        <ReleaseStatus release={release} />
      </div>
      <div className="hero-index" aria-label="The factory at a glance">
        <p className="index-heading">The work, together.</p>
        <a href="#workbench"><span className="index-number">01</span><div><strong>A place to work</strong><span>Environments, agents, changes.</span></div><span aria-hidden="true">+</span></a>
        <a href="#devices"><span className="index-number">02</span><div><strong>The machines you own</strong><span>Mac, Linux, connected.</span></div><span aria-hidden="true">+</span></a>
        <a href="#autonomy"><span className="index-number">03</span><div><strong>A goal to work toward</strong><span>Plan, execute, evaluate, continue.</span></div><span aria-hidden="true">+</span></a>
        <div className="index-footnote"><img src="/brand/mark-blue.svg" width="28" height="28" alt="" /><span>Built to run on your devices.<br />Built to be yours.</span></div>
      </div>
    </section>

    <section className="workbench-section" id="workbench">
      <div className="wrap workbench-grid">
        <div><p className="eyebrow">01 / The workbench</p><h2>Less switching.<br />More making.</h2></div>
        <div><p className="section-lead">An isolated environment deserves a complete workspace.</p><p>Start a session, follow your services, talk to an agent and inspect the changes. Terminals, previews, activity and Git results belong in the same place.</p><a className="text-link" href="/docs#first-session">Your first session</a></div>
      </div>
      <div className="wrap feature-columns">
        <article><span className="feature-label">Environment</span><h3>A clean place for each task.</h3><p>Envmux supplies isolated Docker environments. Keep project work separate and recover the changes when a session ends.</p></article>
        <article><span className="feature-label">Agent</span><h3>The conversation and the work.</h3><p>Follow agent activity, steer a turn and inspect what it produces. Your session continues when you close the app window.</p></article>
        <article><span className="feature-label">Result</span><h3>Evidence you can inspect.</h3><p>See source changes, task attempts and checks alongside the work that created them. Know what happened and what comes next.</p></article>
      </div>
    </section>

    <section className="devices-section wrap" id="devices">
      <div className="section-heading"><div><p className="eyebrow">02 / Connected devices</p><h2>Use the room you already have.</h2></div><p>Your laptop is a workspace. Your Linux machine is one too. Connect the devices you own and put their capacity to work.</p></div>
      <div className="device-diagram" aria-label="Architecture: EnoughFactory connects to device services on a Mac and two Linux machines. Each device owns its isolated environments and local conversations.">
        <div className="diagram-coordinator"><span>EnoughFactory</span><strong>One view of the work</strong><small>Desktop app or browser</small></div>
        <div className="diagram-connection"><span>Authenticated connections · WebRTC</span></div>
        <div className="diagram-devices">{[['Mac', 'Your everyday workspace'], ['Linux', 'Your always-on machine'], ['Linux', 'Room for parallel work']].map(([name, desc], index) => <div className="diagram-device" key={index}><span className="device-icon" aria-hidden="true">{index === 0 ? '▰' : '▤'}</span><strong>{name}</strong><small>{desc}</small><span className="device-divider" /><p>Device service<br />Isolated environments<br />Local conversations</p></div>)}</div>
        <p className="diagram-caption">Architecture diagram. Your device list reflects the machines you pair.</p>
      </div>
      <div className="device-notes"><p><strong>The work stays where it runs.</strong> Each device owns its live sessions and chats. If it goes offline, those tools wait for its return.</p><p><strong>Your window can close.</strong> The device service keeps execution and connections alive independently of the interface.</p></div>
    </section>

    <section className="autonomy-section" id="autonomy"><div className="wrap">
      <div className="section-heading"><div><p className="eyebrow">03 / A goal, pursued</p><h2>Choose how the factory works.</h2></div><p>Stay hands-on, work with a plan or give the factory responsibility for the next action.</p></div>
      <AutonomyExplorer />
      <div className="policy-note"><span className="eyebrow">A separate choice</span><h3>You own the approval policy.</h3><p>Autonomy chooses what happens next. Approvals decide how supported permission requests are handled. Use Approve all, your own rules or manual review. Agents run with full access inside their containers.</p><a className="text-link" href="/docs#policies">Understand the controls</a></div>
    </div></section>

    <section className="how-section wrap" id="how-it-works">
      <p className="eyebrow">From a repository to a result</p><h2>Give the work somewhere to go.</h2>
      <ol className="steps"><li><span>01</span><h3>Add a project.</h3><p>Connect a Git repository and prepare its isolated development environment.</p></li><li><span>02</span><h3>Choose the outcome.</h3><p>Start with a session or define a goal and what successful completion means.</p></li><li><span>03</span><h3>Put agents to work.</h3><p>Choose an agent, a device and the level of autonomy that suits the project.</p></li><li><span>04</span><h3>Follow the result.</h3><p>Inspect progress, changes and checks. Steer the factory whenever you need to.</p></li></ol>
    </section>

    <section className="open-section"><div className="wrap open-grid"><div><p className="eyebrow">Open by design</p><h2>A factory you can understand.<br /><em>And make your own.</em></h2></div><div><p>EnoughFactory is open source. The app, device service, coordination logic and protocols are part of the product you can inspect, modify and run yourself.</p><p>Use your own machines and agent accounts. Self-host connection services when you need them. Your project does not require an Enough cloud subscription.</p><Button asChild variant="outline" size="lg"><a href={release.sourceUrl ?? '/docs#open-source'}>{release.sourceUrl ? 'Explore the source' : 'Read about the architecture'}</a></Button></div></div></section>

    <section className="faq-section wrap"><p className="eyebrow">A few useful details</p><div className="faq-grid"><h2>Before you put it to work.</h2><Accordion type="single" collapsible>
      <AccordionItem value="requirements"><AccordionTrigger>What do I need to run it?</AccordionTrigger><AccordionContent>A Mac or Linux device, a Docker-compatible engine and a Git repository. Connect your own supported agent account or API credentials. See the <a href="/docs#requirements">installation guide</a> for platform and runtime details.</AccordionContent></AccordionItem>
      <AccordionItem value="offline"><AccordionTrigger>What happens when a device is offline?</AccordionTrigger><AccordionContent>Its chats, live tools and sessions are unavailable until it returns. EnoughFactory keeps device ownership and last-known state visible. A missing connection does not mean the work failed.</AccordionContent></AccordionItem>
      <AccordionItem value="permissions"><AccordionTrigger>Can agents make their own decisions?</AccordionTrigger><AccordionContent>Yes. Autonomous mode lets the factory plan, execute, evaluate and choose its next action. Combine it with Approve all to handle supported approval requests automatically. Agent access remains inside the provisioned container.</AccordionContent></AccordionItem>
      <AccordionItem value="cost"><AccordionTrigger>Does EnoughFactory include model usage?</AccordionTrigger><AccordionContent>No. You bring your own agent accounts or API access. Provider charges, quotas and authentication apply to those accounts. The core EnoughFactory product is open source.</AccordionContent></AccordionItem>
    </Accordion></div></section>
    <section className="final-cta wrap"><h2>Your next goal has a home.</h2><div><Button asChild variant="accent" size="lg"><a href="/downloads">Get EnoughFactory</a></Button><a className="text-link" href="/docs">Start with the guide</a></div></section>
  </>;
}

function AutonomyExplorer() {
  const [mode, setMode] = useState<Autonomy>('autonomous');
  const active = modes[mode];
  return <div className="autonomy-explorer"><div className="mode-buttons" aria-label="Explore autonomy modes">{(Object.keys(modes) as Autonomy[]).map(key => <Button key={key} variant={mode === key ? 'accent' : 'outline'} aria-pressed={mode === key} onClick={() => setMode(key)}>{modes[key].label}</Button>)}</div><div className="mode-content" aria-live="polite"><div><h3>{active.title}</h3><p>{active.body}</p><span className="mode-disclaimer">An explanation of the controls, not a live factory.</span></div><ol className="mode-actions">{active.actions.map((action, index) => <li key={action}><span>0{index + 1}</span>{action}</li>)}</ol></div></div>;
}

function Downloads({ release, state }: { release: ReleaseManifest; state: 'loading' | 'ready' | 'error' }) {
  return <div className="wrap inner-page"><p className="eyebrow">Put it to work</p><h1>Get EnoughFactory.</h1><p className="page-intro">The desktop workspace for Mac and Linux. Your devices supply the environments. Your agent accounts supply the models.</p>
    {state === 'loading' ? <div className="release-message" role="status"><h2>Checking available downloads.</h2><p>Loading the release catalog.</p></div> : state === 'error' ? <div className="release-message" role="alert"><h2>The release catalog is unavailable.</h2><p>Please reload this page to try again. No unverified download links are shown.</p></div> : release.status !== 'published' ? <div className="release-message"><span className="eyebrow">Version {release.version} / In development</span><h2>The first release is being prepared.</h2><p>Mac and Linux installers will appear here when the release artifacts are available. You can read the guide and architecture in the meantime.</p><Button asChild variant="outline"><a href="/docs">Read the guide</a></Button></div> : <>
      <div className="release-heading"><h2>Version {release.version}</h2><span>Released {new Date(release.publishedAt!).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}</span></div>
      <div className="download-grid">{release.artifacts.map(artifact => <article className="download-card" key={artifact.filename}><span className="eyebrow">{artifact.format}</span><h3>{platformLabel(artifact.platform, artifact.arch)}</h3><p>{formatBytes(artifact.bytes)} · {artifact.signing === 'signed' ? 'Signed build' : 'Unsigned build'}</p><Button asChild variant="accent"><a href={artifact.url} download={artifact.filename}>Download</a></Button><details><summary>Verify this download</summary><p>SHA-256</p><code className="checksum">{artifact.sha256}</code></details></article>)}</div>
      <p className="release-note">{release.artifacts.some(a => a.signing === 'unsigned') ? 'Unsigned packages may require your operating system’s explicit permission to open. Verify their checksums and use the installation guide.' : 'Verify package checksums before installation.'} <a href="/docs#installation">Installation guide</a>.</p>
      <div className="release-message"><h2>Prefer your browser?</h2><p>Open the same workspace in your browser and connect a paired device. Its device service owns execution and local conversations.</p><Button asChild variant="outline"><a href="/app">Open the browser app</a></Button></div>
    </>}
    <div className="download-info"><div><h3>Prepare your machine.</h3><p>Have a Docker-compatible engine running before you start your first environment. On Mac, an OSS Colima/Lima setup is supported alongside existing Docker-compatible engines.</p><a className="text-link" href="/docs#requirements">Requirements</a></div><div><h3>Run it on your own terms.</h3><p>The source, device service and connection services are self-hostable. Keep the same workspace across the devices you pair.</p><a className="text-link" href="/docs#self-hosting">Self-hosting</a></div></div>
  </div>;
}

function Guide({ release }: { release: ReleaseManifest }) {
  const sections = [['requirements', 'Requirements'], ['installation', 'Installation'], ['first-session', 'Your first session'], ['agents', 'Agents and goals'], ['policies', 'Autonomy and approvals'], ['devices', 'Connect devices'], ['architecture', 'Architecture'], ['self-hosting', 'Self-hosting'], ['open-source', 'Open source']];
  return <div className="wrap guide-layout"><aside className="guide-navigation"><p className="eyebrow">The guide</p><nav aria-label="Guide sections">{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav></aside><article className="guide-content"><p className="eyebrow">EnoughFactory / Guide</p><h1>A place for the work.</h1><p className="page-intro">Start with an isolated session. Add agents and devices. Let a goal bring the work together.</p>{release.status !== 'published' && <p className="guide-notice">The first release is in development. This guide describes the product workflow; installers and release-specific instructions appear with the published release.</p>}
    <section id="requirements"><h2>Requirements</h2><ul><li>A supported Mac or Linux device. Release targets are Apple Silicon Mac and Linux x64/ARM64.</li><li>A running Docker-compatible engine with capacity for the environments you create.</li><li>A Git repository and the project’s environment configuration.</li><li>Your own account or API credentials for the agent runtime you use.</li></ul><p>EnoughFactory does not include provider subscriptions or model usage. Authentication and quotas come from the connected agent account.</p></section>
    <section id="installation"><h2>Installation</h2><p>Choose the package that matches your operating system and processor from <a href="/downloads">Downloads</a>. Check its SHA-256 checksum before installation. Packages identify whether they are signed.</p><p>Open the desktop app and follow its setup checks for Docker and agent runtimes. The app connects to a device service that owns execution independently of the window. Closing the app detaches the interface; explicitly stopping a session ends its environment.</p><p>The source distribution includes device service installation and removal instructions for each supported operating system.</p></section>
    <section id="first-session"><h2>Your first session</h2><ol><li>Add a local Git repository as a project.</li><li>Review its environment setup and create a session.</li><li>Follow startup progress, then open services, output, a terminal or an application preview.</li><li>Make changes yourself or work with an agent.</li><li>Inspect the Changes view and stop the session when you are ready to recover its work through Git.</li></ol><p>Envmux owns the environment lifecycle. EnoughFactory gives that environment one workspace with clear progress, errors and recoverable results.</p></section>
    <section id="agents"><h2>Agents and goals</h2><p>Choose a supported agent and connect its provider account. Conversations, tool activity and artifacts are stored on the device that owns the session. A disconnected device makes that conversation unavailable until it returns.</p><p>A goal adds completion criteria, a plan and persistent work records. The factory chooses tasks, places attempts on eligible devices and evaluates their evidence. A completed agent turn does not automatically complete the goal.</p><p>When a result needs repair, autonomous mode chooses the next action and continues. When authentication, a budget or a genuine missing input prevents progress, the workspace shows what it needs.</p></section>
    <section id="policies"><h2>Autonomy and approvals</h2><p>These are independent settings.</p><dl><dt>Manual</dt><dd>You choose each next task.</dd><dt>Assisted</dt><dd>The factory helps plan the work and proposes the next action.</dd><dt>Autonomous</dt><dd>The factory chooses, executes and evaluates next actions toward the goal.</dd></dl><dl><dt>Approve all</dt><dd>Enough handles supported approval requests automatically, including when the window is closed.</dd><dt>Rules</dt><dd>Your configured policy handles matching requests. Unresolved requests appear in the workspace.</dd><dt>Manual approvals</dt><dd>Review the request in Enough and return a decision to the waiting runtime.</dd></dl><p>Agents receive full permissions inside their containers. Runtime adapters report the approval requests they actually support. Some full-access routes emit no approval requests; selective policies do not promise a separate decision for every effect inside an allowed command.</p></section>
    <section id="devices"><h2>Connect devices</h2><p>Install the device service on each machine and pair it through the app’s invitation flow. Paired devices authenticate their identities before accepting control.</p><p>WebRTC is the preferred connection between devices. Signaling helps them discover and negotiate a connection; an optional TURN relay supports networks where a direct connection fails.</p><p>Keep chats on their owning device. An offline machine’s live tools are unavailable, while Enough keeps ownership and last-known state visible. Unknown execution state is reconciled before the factory retries work.</p></section>
    <section id="architecture"><h2>Architecture</h2><p>The shared React interface runs in Electron or a browser. A device service owns local sessions, runtime connections, approvals and networking. A selected coordinator keeps durable goals, tasks and attempts.</p><p>Envmux supplies isolated environments. Git and ArtifactFS workspace providers supply source. Transactional coordination records and evidence manifests remain separate from the workspace filesystem.</p><p>Remote previews use an authenticated HTTP/WebSocket gateway over the device connection. A WebRTC data channel is a transport, rather than a browser URL.</p></section>
    <section id="self-hosting"><h2>Self-hosting</h2><p>The device service and signaling service ship with the source. Configure signaling and optional relay services for your network. The signaling service exchanges presence and connection negotiation; it does not store your conversations or own your goals.</p><p>Use the version-matched source instructions for setup, service startup, removal and configuration. Keep provider credentials on the appropriate device and configure project integrations deliberately.</p>{release.sourceUrl && <Button asChild variant="outline"><a href={release.sourceUrl}>Open the source instructions</a></Button>}</section>
    <section id="open-source"><h2>Open source</h2><p>EnoughFactory’s application code is MIT licensed. Upstream licenses and notices accompany the release, including envmux and EnoughUI. Supplied typefaces retain their SIL Open Font License notices.</p><p>Contributions should keep the complete product understandable: coherent interface, replaceable adapters, durable state and meaningful verification. The repository’s contributor guide describes local setup and the checks relevant to a change.</p>{release.sourceUrl ? <a className="text-link" href={release.sourceUrl}>Browse the repository</a> : <p>The public repository address will appear in the release catalog when the release is published.</p>}</section>
  </article></div>;
}
