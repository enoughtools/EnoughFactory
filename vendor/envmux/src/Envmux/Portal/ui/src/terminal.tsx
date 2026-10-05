import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

import { shellUrl } from "./session"

/** The palette the terminal window uses, so the two look like one product. */
const theme = {
  background: "#0a0118",
  foreground: "#d8dce3",
  cursor: "#ff2bd6",
  selectionBackground: "#3a2d52",
  black: "#0a0118",
  brightBlack: "#6b5f8a",
  red: "#ff3864",
  green: "#39ff14",
  yellow: "#ffd166",
  blue: "#00f0ff",
  magenta: "#ff2bd6",
  cyan: "#00f0ff",
  white: "#d8dce3",
}

/**
 * An xterm bound to a div, kept in step with the size of it.
 *
 * The resize is observed on the element rather than on the window, because the
 * three things that change a pane's size are a window resize, a layout change,
 * and a hidden pane becoming visible — and only the element sees all three. A
 * pane that is not on screen has no width, and is left alone until it has one:
 * fitting to a zero-width box would tell the far end the terminal is one column
 * wide, and everything drawn after that would be wrong.
 */
function useTerminal(readOnly: boolean, onResize?: (cols: number, rows: number) => void) {
  const host = useRef<HTMLDivElement>(null)
  const [terminal, setTerminal] = useState<Terminal | null>(null)

  // The callback is read through a ref so that a new closure on every render
  // does not tear the terminal down and build it again.
  const resized = useRef(onResize)
  useEffect(() => {
    resized.current = onResize
  })

  useEffect(() => {
    const element = host.current
    if (!element) return

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      theme,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      convertEol: false,
      scrollback: 5000,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)

    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (element.offsetWidth === 0) return
        try {
          fit.fit()
        } catch {
          // Not laid out yet. The observer fires again when it is.
        }
        resized.current?.(term.cols, term.rows)
      })
    }

    const observer = new ResizeObserver(sync)
    observer.observe(element)
    sync()
    setTerminal(term)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      term.dispose()
      setTerminal(null)
    }
  }, [readOnly])

  return { host, terminal }
}

/**
 * One task's output, followed.
 *
 * Read-only in the strong sense: there is no pty on the other end of this and
 * nothing to type into. It is the tail you leave open on a dev server — the
 * same bytes the terminal window shows in its task pane, and the same bytes a
 * headless run prints.
 */
export function TaskOutput({ name, active }: { name: string; active: boolean }) {
  const { host, terminal } = useTerminal(true)

  useEffect(() => {
    if (!terminal) return

    // The backlog arrives first and the stream continues from it, so this is
    // everything the task has said — not everything it says from now on.
    const source = new EventSource(`/api/tasks/${encodeURIComponent(name)}/output`)
    source.onmessage = event => terminal.write(`${event.data}\r\n`)

    return () => {
      source.close()
      terminal.clear()
    }
  }, [terminal, name])

  return (
    <div className={active ? "pane" : "pane hidden"}>
      <div className="terminal" ref={host} />
    </div>
  )
}

/**
 * A shell in the instance, latched — this socket is an attachment to it.
 *
 * Closing the tab ends the shell, because the socket is the shell — there is
 * nothing on the far side holding it open, by design. When one ends, the
 * terminal keeps what it said and offers another: a new socket, a new exec, the
 * same scrollback above it.
 *
 * With `tool` named, the shell *is* that tool — the session mounted its state
 * from this machine, so it opens signed in.
 */
export function Shell({ active, tool }: { active: boolean; tool?: string }) {
  const socket = useRef<WebSocket | null>(null)
  const start = useRef<() => void>(() => {})
  const [closed, setClosed] = useState(false)

  const { host, terminal } = useTerminal(false, (cols, rows) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ resize: { cols, rows } }))
    }
  })

  useEffect(() => {
    if (!terminal) return

    const encode = new TextEncoder()
    const decode = new TextDecoder()
    let current: WebSocket | null = null
    let gone = false

    const open = () => {
      const opening = new WebSocket(shellUrl(terminal.cols, terminal.rows, tool))
      opening.binaryType = "arraybuffer"
      current = opening
      socket.current = opening
      setClosed(false)

      opening.onmessage = event =>
        terminal.write(
          typeof event.data === "string"
            ? event.data
            : decode.decode(new Uint8Array(event.data as ArrayBuffer)),
        )

      opening.onopen = () => terminal.focus()

      // A socket that was replaced is not this shell ending — it is the last
      // one, closing after another was opened in the same terminal.
      opening.onclose = () => {
        if (gone || current !== opening) return
        setClosed(true)
      }
    }

    start.current = open

    const typed = terminal.onData(data => {
      if (current?.readyState === WebSocket.OPEN) current.send(encode.encode(data))
    })

    open()

    return () => {
      gone = true
      start.current = () => {}
      typed.dispose()
      current?.close()
    }
  }, [terminal, tool])

  // Focus follows the tab: a shell you have just switched to should take what
  // you type next without a click first.
  useEffect(() => {
    if (active) terminal?.focus()
  }, [active, terminal])

  return (
    <div className={active ? "pane" : "pane hidden"}>
      <div className="terminal" ref={host} />
      {closed && (
        <button className="again" onClick={() => start.current()}>
          {tool ? `start ${tool} again here` : "start another shell here"}
        </button>
      )}
    </div>
  )
}
