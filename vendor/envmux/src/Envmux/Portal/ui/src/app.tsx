import { useEffect, useState } from "react"

import {
  ask,
  roomStreamUrl,
  send,
  usePoll,
  useSession,
  type Agent,
  type Agents as AgentList,
  type ChatLine,
  type LogLine,
  type Room as RoomState,
  type RoomEntry,
  type SessionState,
  type Task,
} from "./session"
import { Shell, TaskOutput } from "./terminal"

/**
 * What is in the big pane on the right.
 *
 * Tabs are opened rather than routed: the log is always there, a task's output
 * appears when you ask to watch it, and a shell appears when you ask for one.
 * Every tab that has been opened stays mounted and is hidden rather than
 * unmounted, because unmounting a shell would end it and unmounting a tail
 * would lose its scrollback.
 */
type Tab =
  | { id: "log"; kind: "log" }
  | { id: "room"; kind: "room" }
  | { id: string; kind: "task"; name: string }
  | { id: string; kind: "shell"; tool?: string; label: string }

export function App() {
  const { state, connected } = useSession()
  const [tabs, setTabs] = useState<Tab[]>([
    { id: "log", kind: "log" },
    { id: "room", kind: "room" },
  ])
  const [open, setOpen] = useState("log")
  const [shells, setShells] = useState(0)

  useEffect(() => {
    document.title = state ? `${state.project} / ${state.session}` : "envmux"
  }, [state])

  if (!state) {
    return (
      <div className="waiting">
        {connected ? "reading the session…" : "envmux is not answering — is the session still running?"}
      </div>
    )
  }

  const watch = (name: string) => {
    const id = `task:${name}`
    setTabs(current => (current.some(t => t.id === id) ? current : [...current, { id, kind: "task", name }]))
    setOpen(id)
  }

  // Every shell is its own tab, numbered so that three of them are tellable
  // apart — the server keeps no names, because it keeps nothing at all.
  const shell = (tool?: string) => {
    const nth = shells + 1
    const id = `shell:${nth}`
    setShells(nth)
    setTabs(current => [...current, { id, kind: "shell", tool, label: `${tool ?? "shell"} ${nth}` }])
    setOpen(id)
  }

  const close = (id: string) => {
    setTabs(current => current.filter(t => t.id !== id))
    setOpen(current => (current === id ? "log" : current))
  }

  return (
    <div className="app">
      <Header state={state} connected={connected} />

      <div className="body">
        <aside>
          <Routes state={state} />
          <Tasks state={state} onWatch={watch} />
          <Services state={state} />
          <RemoteAgents onRoom={() => setOpen("room")} />
          <About state={state} />
        </aside>

        <main>
          <nav className="tabs">
            {tabs.map(tab => (
              <span key={tab.id} className={tab.id === open ? "tab on" : "tab"}>
                <button onClick={() => setOpen(tab.id)}>
                  {tab.kind === "log"
                    ? "session log"
                    : tab.kind === "room"
                      ? "room"
                      : tab.kind === "task"
                        ? tab.name
                        : tab.label}
                </button>
                {tab.kind !== "log" && tab.kind !== "room" && (
                  <button className="close" title="close this tab" onClick={() => close(tab.id)}>
                    ×
                  </button>
                )}
              </span>
            ))}
            <button className="tab new" onClick={() => shell()} disabled={!state.address}>
              + shell
            </button>

            {/* One per mounted coding tool. The point of mounting a tool's
                state is that it arrives signed in, and the shortest distance
                between a session and that is a button. */}
            {state.tools.map(tool => (
              <button
                key={tool}
                className="tab new tool"
                onClick={() => shell(tool)}
                disabled={!state.address}
                title={`open ${tool} in this instance`}
              >
                + {tool}
              </button>
            ))}
          </nav>

          {tabs.map(tab =>
            tab.kind === "log" ? (
              <Log key={tab.id} lines={state.log} active={open === tab.id} />
            ) : tab.kind === "room" ? (
              <Room key={tab.id} active={open === tab.id} />
            ) : tab.kind === "task" ? (
              <TaskOutput key={tab.id} name={tab.name} active={open === tab.id} />
            ) : (
              <Shell key={tab.id} active={open === tab.id} tool={tab.tool} />
            ),
          )}
        </main>
      </div>
    </div>
  )
}

function Header({ state, connected }: { state: SessionState; connected: boolean }) {
  const [said, setSaid] = useState("")

  const devContainer = state.editorAttach === "devcontainer"

  const editor = async () => {
    // The dev-container attach brings the Docker endpoint up itself, so this can
    // take a moment the first time — say so rather than looking stuck.
    if (devContainer) setSaid("starting the Docker endpoint…")
    const response = await ask("/editor")
    const answer = (await response.json()) as { uri?: string; opened?: boolean; error?: string }
    setSaid(answer.error ?? (answer.opened ? "opening your editor…" : "no editor"))
    if (answer.uri) await navigator.clipboard?.writeText(answer.uri).catch(() => undefined)
  }

  const browser = async () => {
    const response = await ask("/browser")
    const answer = (await response.json()) as { opened?: boolean; url?: string; error?: string }
    setSaid(answer.error ?? (answer.opened ? `opening a browser at ${answer.url} in the instance…` : "no browser"))
  }

  const restart = async () => {
    if (!confirm("Restart the tasks from .envmux.json as it is now?")) return
    await ask("/restart")
    setSaid("restarting…")
  }

  return (
    <header>
      <h1>
        {state.project} <span className="slash">/</span> {state.session}
      </h1>

      <dl className="identity">
        <Fact name="branch" value={state.branch} />
        <Fact name="image" value={state.image} />
        <Fact name="port" value={String(state.port)} />
        <Fact name="address" value={state.address || "—"} />
      </dl>

      <div className="doing">
        {state.failed ? (
          <span className="bad">{state.failed}</span>
        ) : state.phase ? (
          <span className="busy">{state.phase}…</span>
        ) : state.ready ? (
          <span className="good">running</span>
        ) : (
          <span className="busy">starting…</span>
        )}
        {!connected && <span className="bad">stream lost</span>}
        {said && <span className="said">{said}</span>}
      </div>

      <div className="actions">
        <button
          onClick={editor}
          disabled={!state.editor}
          title={
            devContainer
              ? "attach as a dev container — starts the envmux docker endpoint if needed"
              : "attach over SSH"
          }
        >
          {devContainer ? "open in VS Code (dev container)" : "open in VS Code"}
        </button>
        <button
          onClick={browser}
          disabled={!state.browserPort}
          title={`a browser whose localhost is this instance, through socks5 on 127.0.0.1:${state.browserPort}`}
        >
          open a browser in the instance
        </button>
        <button onClick={restart}>restart session</button>
      </div>
    </header>
  )
}

function Fact({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd title={value}>{value}</dd>
    </>
  )
}

function Routes({ state }: { state: SessionState }) {
  return (
    <section>
      <h2>routes</h2>
      {state.routes.length === 0 ? (
        <p className="none">none declared</p>
      ) : (
        <ul className="routes">
          {state.routes.map(route => (
            <li key={route.name}>
              <span className="top">
                {route.portal ? (
                  <a href={route.url} target="_blank" rel="noreferrer">
                    {route.name}
                  </a>
                ) : (
                  // Only the session's browser can reach a route: localhost
                  // there is the instance. This tab's browser is not that one,
                  // so a route is opened by asking envmux to open it.
                  <button
                    className="link"
                    onClick={() => ask(`/browser?open=${encodeURIComponent(route.url)}`)}
                    title={`open ${route.url} in the session's browser`}
                  >
                    {route.name}
                  </button>
                )}
                {!route.portal && <span className="port">:{route.port}</span>}
                {route.portal && <span className="tag portal">portal</span>}
              </span>
              <span className="under" title={route.url}>
                {route.portal ? route.hostname : route.url}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The tasks, and the three things you can do to one.
 *
 * The buttons call straight back into the session — the same methods the `k`
 * key and `/task restart` reach — so a task restarted from a browser tab and
 * one restarted from the window are the same act, and both are visible in both
 * places a moment later.
 */
function Tasks({ state, onWatch }: { state: SessionState; onWatch: (name: string) => void }) {
  return (
    <section>
      <h2>tasks</h2>
      {state.tasks.length === 0 ? (
        <p className="none">none declared</p>
      ) : (
        <ul className="tasks">
          {state.tasks.map(task => (
            <li key={task.name}>
              <span className="top">
                <button className="name" onClick={() => onWatch(task.name)} title="watch its output">
                  {task.internal && <span className="own">*</span>}
                  {task.name}
                </button>
                <span className={`status ${health(task)}`}>{task.status}</span>
                <span className="doings">
                  <button onClick={() => ask(`/tasks/${task.name}/restart`)} title="restart">
                    ↻
                  </button>
                  <button onClick={() => ask(`/tasks/${task.name}/stop`)} title="stop">
                    ■
                  </button>
                  <button onClick={() => ask(`/tasks/${task.name}/start`)} title="start">
                    ▶
                  </button>
                </span>
              </span>
              <span className="under" title={task.lastLine}>
                {task.lastLine || task.command}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function health(task: Task): string {
  if (task.state === "running") return "good"
  if (task.state === "exited") return task.status === "done" ? "good" : "bad"
  if (task.state === "failed" || task.state === "blocked") return "bad"
  return "busy"
}

function Services({ state }: { state: SessionState }) {
  if (state.services.length === 0) return null

  return (
    <section>
      <h2>services</h2>
      <ul className="services">
        {state.services.map(service => (
          <li key={service.name}>
            <span className="name">{service.name}</span>
            <span className="what">{service.type}</span>
            <span className="port">
              {service.host}:{service.port}
            </span>
            {service.persist && <span className="tag">persisted</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The remote agents delegated from this repository, and a way to start one.
 *
 * Read off the same registry `envmux agent ls` reads — one started from a
 * terminal shows up here a few seconds later, and one started here shows up
 * there — so this is a view of shared files rather than of this session. The
 * stop button writes the same stop file the command does.
 */
function RemoteAgents({ onRoom }: { onRoom: () => void }) {
  const listed = usePoll<AgentList>("/agents", 5000)
  const [delegating, setDelegating] = useState(false)
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [said, setSaid] = useState("")

  const start = async () => {
    setSaid("starting…")
    const response = await send("/agents", { name, prompt })
    const answer = (await response.json()) as { error?: string; branch?: string }
    if (!response.ok) {
      setSaid(answer.error ?? "could not start it")
      return
    }
    setSaid(`started on ${answer.branch ?? name}`)
    setName("")
    setPrompt("")
    setDelegating(false)
    onRoom()
  }

  const stop = async (agent: Agent) => {
    if (!confirm(`Stop ${agent.name}? Its session ends and its commits come back onto ${agent.branch}.`)) return
    await ask(`/agents/${encodeURIComponent(agent.name)}/stop`)
  }

  return (
    <section className="agents">
      <h2>
        remote agents
        <button className="small" onClick={() => setDelegating(current => !current)} title="start a remote agent on a task">
          {delegating ? "cancel" : "+ delegate"}
        </button>
      </h2>

      {delegating && (
        <form
          className="delegate"
          onSubmit={event => {
            event.preventDefault()
            void start()
          }}
        >
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="name — becomes envmux/<name>"
            pattern="[A-Za-z0-9][A-Za-z0-9_./-]*"
            required
          />
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder="the task, as you would brief a colleague who has the repository but none of your context"
            rows={5}
            required
          />
          <button type="submit" disabled={!name || !prompt}>
            start
          </button>
        </form>
      )}

      {said && <p className="said">{said}</p>}

      {!listed || listed.agents.length === 0 ? (
        <p className="none">none — {listed?.room ?? "the room"} is quiet</p>
      ) : (
        <ul className="tasks">
          {listed.agents.map(agent => (
            <li key={agent.name}>
              <span className="top">
                <button className="name" onClick={onRoom} title={`@${agent.nick} in the room`}>
                  {agent.name}
                </button>
                <span className={`status ${agentHealth(agent)}`}>{agent.state}</span>
                <span className="doings">
                  {isActive(agent) && (
                    <button onClick={() => stop(agent)} title="stop — its commits come back">
                      ■
                    </button>
                  )}
                </span>
              </span>
              <span className="under" title={agent.summary}>
                {agent.result
                  ? agent.result.commitsAhead > 0
                    ? `${agent.result.commitsAhead} commit(s) on ${agent.result.branch}`
                    : "nothing committed"
                  : agent.summary}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function isActive(agent: Agent): boolean {
  return ["launching", "starting", "running", "finishing"].includes(agent.state)
}

function agentHealth(agent: Agent): string {
  if (agent.state === "running") return "good"
  if (agent.state === "finished") return "good"
  if (agent.state === "failed") return "bad"
  return "busy"
}

/**
 * The room: the last hour of `.context/chatroom/`, then every line as it lands.
 *
 * One read for the recent hour, then a websocket opened from the cursor that
 * read handed back, so nothing between the two is missed. Each message is one
 * physical line: a parsed one starts a new message, a continuation folds into
 * the last. If the socket will not open — or drops and will not reopen — the
 * tab goes back to polling the same endpoint, which is slower and never wrong.
 */
function useRoom(active: boolean): RoomState | null {
  const [room, setRoom] = useState<RoomState | null>(null)
  const [fallback, setFallback] = useState(false)
  const polled = usePoll<RoomState>("/chat", 3000, active && fallback)

  useEffect(() => {
    if (!active || fallback) return
    let socket: WebSocket | null = null
    let stopped = false

    const open = async () => {
      try {
        const response = await fetch("/api/chat")
        if (!response.ok) throw new Error(String(response.status))
        const recent = (await response.json()) as RoomState
        if (stopped) return
        setRoom(recent)

        socket = new WebSocket(roomStreamUrl(recent.cursor))
        socket.onmessage = event => {
          const entry = JSON.parse(event.data as string) as RoomEntry
          setRoom(current => (current ? { ...current, lines: append(current.lines, entry), cursor: entry.cursor } : current))
        }
        // A socket that closes is not retried here: the poll is the retry, and
        // it is the version of this that has no failure mode.
        socket.onerror = () => setFallback(true)
        socket.onclose = () => {
          if (!stopped) setFallback(true)
        }
      } catch {
        if (!stopped) setFallback(true)
      }
    }

    void open()

    return () => {
      stopped = true
      socket?.close()
    }
  }, [active, fallback])

  return fallback ? polled : room
}

/** One more physical line onto the parsed room: a message starts, or the last one continues. */
function append(lines: ChatLine[], entry: RoomEntry): ChatLine[] {
  if (entry.line) return [...lines, entry.line]
  if (!entry.raw.startsWith("    ") || lines.length === 0) return lines
  const last = lines[lines.length - 1]
  return [...lines.slice(0, -1), { ...last, text: `${last.text}\n${entry.raw.slice(4)}`, raw: `${last.raw}\n${entry.raw}` }]
}

/**
 * The room as a pane, and a line into it.
 *
 * Plain lines rather than a terminal, because the room is plain lines — the
 * files the agents append to with `printf`, read back and shown as they are.
 * Speaking here is the same append `envmux agent say` does, as `chef` unless
 * another name is given, and the remote side has it the moment it is written.
 */
function Room({ active }: { active: boolean }) {
  const room = useRoom(active)
  const [text, setText] = useState("")
  const [nick, setNick] = useState("chef")
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (!follow || !active) return
    document.getElementById("room-end")?.scrollIntoView({ block: "end" })
  }, [room, follow, active])

  const say = async () => {
    if (!text.trim()) return
    await send("/chat", { nick, text })
    setText("")
  }

  const watch = (event: React.UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget
    setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 24)
  }

  return (
    <div className={active ? "pane room" : "pane room hidden"}>
      <div className="lines" onScroll={watch}>
        {!room || room.lines.length === 0 ? (
          <p className="none">
            nothing in {room?.path ?? ".context/chatroom"} yet — the last hour of the room shows here
          </p>
        ) : (
          room.lines.map((line, index) => (
            <p key={`${line.at}-${index}`} className={line.isEvent ? "event" : ""}>
              <span className="at">{line.at}</span>
              {line.room && <span className="tag">{line.room}</span>}
              {line.isEvent ? (
                <span className="who">* {line.name} </span>
              ) : (
                <span className="who">{line.name}: </span>
              )}
              {line.text}
            </p>
          ))
        )}
        <span id="room-end" />
      </div>

      <form
        className="say"
        onSubmit={event => {
          event.preventDefault()
          void say()
        }}
      >
        <input
          className="nick"
          value={nick}
          onChange={event => setNick(event.target.value)}
          pattern="[a-z][a-z0-9_-]{0,23}"
          title="your name in the room: lowercase, starting with a letter"
          required
        />
        <input
          className="text"
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="@feat-login one thought, one line"
        />
        <button type="submit" disabled={!text.trim()}>
          say
        </button>
      </form>
    </div>
  )
}

/** The parts of the session that are worth knowing once and not watching. */
function About({ state }: { state: SessionState }) {
  return (
    <section className="about">
      <h2>session</h2>
      <dl>
        <Fact name="workdir" value={state.workdir} />
        <Fact name="shell" value={state.shell} />
        <Fact name="from" value={state.base} />
        <Fact name="domain" value={state.domain} />
      </dl>
    </section>
  )
}

/**
 * The session log.
 *
 * Rendered as lines rather than into a terminal: it arrives as levelled records
 * with timestamps, and colouring those is the page's job. Following is the
 * default and is given up the moment you scroll away from the bottom.
 */
function Log({ lines, active }: { lines: LogLine[]; active: boolean }) {
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (!follow || !active) return
    const bottom = document.getElementById("log-end")
    bottom?.scrollIntoView({ block: "end" })
  }, [lines, follow, active])

  const watch = (event: React.UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget
    setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 24)
  }

  return (
    <div className={active ? "pane log" : "pane log hidden"} onScroll={watch}>
      {lines.map((line, index) => (
        <p key={`${line.at}-${index}`} className={line.level}>
          <span className="at">{line.at.slice(11, 19)}</span>
          {line.message}
        </p>
      ))}
      <span id="log-end" />
    </div>
  )
}
