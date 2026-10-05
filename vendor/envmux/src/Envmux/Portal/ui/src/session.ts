import { useEffect, useState } from "react"

/**
 * The session, exactly as `PortalState` serialises it.
 *
 * Hand-written rather than generated: the whole API is one object and two verbs,
 * and a code generator to keep them in step would be more moving parts than the
 * thing it was keeping in step. If these drift, the page shows `undefined` in
 * one field — which is why nothing here is destructured into a shape that would
 * throw instead.
 */
export interface Route {
  name: string
  port: number
  url: string
  hostname: string
  /**
   * Whether this is the portal — this page — rather than something in the
   * instance. It is on loopback rather than at the session's own address, its
   * URL carries the token, and it has no port on the instance to show.
   */
  portal: boolean
}

export interface Task {
  name: string
  command: string
  /** A word for the state: running, done, exit 1, waiting, blocked. */
  status: string
  state: string
  kind: string
  /** A task envmux declared rather than the config. Nothing does, at present. */
  internal: boolean
  runs: number
  startedAt?: string
  lastLine: string
}

export interface Service {
  name: string
  type: string
  image: string
  host: string
  port: number
  persist: boolean
}

export interface LogLine {
  at: string
  level: string
  message: string
}

export interface SessionState {
  project: string
  session: string
  branch: string
  base: string
  image: string
  /** The address the instance holds on the bridge, once it has one. */
  address: string
  instanceName: string
  workdir: string
  shell: string
  domain: string
  port: number
  /** What it is doing right now, or empty once it is up. */
  phase: string
  ready: boolean
  failed?: string
  startedAt: string
  /** The URI an editor opens the instance at, once it has an address (ssh-remote or attached-container). */
  editor?: string
  /** How the editor attaches: "ssh" or "devcontainer". */
  editorAttach: "ssh" | "devcontainer"
  /** The loopback port of the session's SOCKS proxy, or 0 when it has none. */
  browserPort: number
  routes: Route[]
  tasks: Task[]
  services: Service[]
  /**
   * The mounted coding tools there is something to open: claude, codex, gemini,
   * opencode. Not `gh`, whose state is mounted so that git is authenticated
   * rather than so that anybody sits in front of it.
   */
  tools: string[]
  log: LogLine[]
}

/** Whether the stream is currently connected, and the last session it carried. */
export interface Live {
  state: SessionState | null
  connected: boolean
}

/**
 * Follow the session.
 *
 * One EventSource for the whole page: every part of it is a view of the same
 * snapshot, which arrives whole rather than as a diff. The browser reconnects a
 * dropped stream on its own — which is what happens when the session is
 * restarted or the process goes away and comes back — so there is no retry loop
 * here, only the flag that says which of those is happening.
 */
export function useSession(): Live {
  const [state, setState] = useState<SessionState | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const source = new EventSource("/api/events")

    source.addEventListener("state", event => {
      setState(JSON.parse((event as MessageEvent<string>).data) as SessionState)
      setConnected(true)
    })

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)

    return () => source.close()
  }, [])

  return { state, connected }
}

/** Ask envmux to do something. Nothing comes back but whether it was accepted. */
export async function ask(path: string): Promise<Response> {
  return fetch(`/api${path}`, { method: "POST" })
}

/** Ask envmux to do something with a body: start an agent, say a line. */
export async function send(path: string, body: unknown): Promise<Response> {
  return fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * One remote agent, exactly as `AgentRecord` serialises it — and as it sits in
 * `.envmux/agents/<name>.json`, which is the same shape.
 */
export interface Agent {
  name: string
  project: string
  branch: string
  instance: string
  nick: string
  summary: string
  startedAt: string
  pid: number
  /** launching, starting, running, finishing, finished, stopped, failed. */
  state: string
  exitCode?: number
  result?: { branch: string; head: string; commitsAhead: number; dirtyFiles: number }
  endedAt?: string
  delegator: string
}

export interface Agents {
  room: string
  directory: string
  agents: Agent[]
}

/** One line of the room, as `ChatLine` serialises it. */
export interface ChatLine {
  at: string
  room?: string
  name: string
  isEvent: boolean
  text: string
  raw: string
}

export interface Room {
  room: string
  path: string
  names: string[]
  lines: ChatLine[]
  /** Where the room ends as of this read — what the stream is opened from. */
  cursor: string
}

/**
 * One physical line of the room as the stream pushes it: the bucket it landed
 * in, the line as written, its parse when it is the first line of a message
 * (null for a continuation), and the cursor after it.
 */
export interface RoomEntry {
  bucket: string
  raw: string
  line: ChatLine | null
  cursor: string
}

/**
 * The websocket URL for the room's stream, from a cursor the opening read
 * handed back — so nothing said between that read and the connection is missed.
 */
export function roomStreamUrl(cursor: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws"
  return `${scheme}://${location.host}/api/chat/ws?after=${encodeURIComponent(cursor)}`
}

/**
 * Read something from the API on an interval.
 *
 * Polled rather than streamed, because what is behind these endpoints is a
 * directory that other processes write — the command line, an agent's own
 * session — and the portal is one reader of it among several rather than the
 * owner of a change to push. The room has a stream of its own; this is what the
 * agent list uses, and what the room falls back to when its socket will not open.
 */
export function usePoll<T>(path: string, every: number, active = true): T | null {
  const [value, setValue] = useState<T | null>(null)

  useEffect(() => {
    if (!active) return
    let stopped = false

    const read = async () => {
      try {
        const response = await fetch(`/api${path}`)
        if (response.ok && !stopped) setValue((await response.json()) as T)
      } catch {
        // The session is going away, or the network blinked. The next tick asks again.
      }
    }

    void read()
    const timer = setInterval(read, every)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [path, every, active])

  return value
}

/**
 * The websocket URL for a fresh shell, sized for the terminal that will show it.
 *
 * With a tool named, the shell is that tool: envmux checks the name against the
 * ones this session actually mounted and execs it, so quitting it ends the
 * shell the way quitting `claude` in a terminal does.
 */
export function shellUrl(cols: number, rows: number, tool?: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws"
  const named = tool ? `&tool=${encodeURIComponent(tool)}` : ""
  return `${scheme}://${location.host}/api/shell?cols=${cols}&rows=${rows}${named}`
}
