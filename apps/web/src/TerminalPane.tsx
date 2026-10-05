import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Plus, TerminalSquare, X } from 'lucide-react';
import { Button, EmptyState } from './ui';
import type { DeviceClient } from './api';
import type { Session } from '@enoughfactory/contracts';

function TerminalSurface({ client, sessionId, terminalId }: { client: DeviceClient; sessionId: string; terminalId: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState('Connecting');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!element.current) return;
    let attached = true;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.35, theme: { background: '#20251e', foreground: '#e8ece3', cursor: '#e8ece3', selectionBackground: '#515c48' }, convertEol: false });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current); fit.fit();
    const socket = client.socket(`/api/sessions/${encodeURIComponent(sessionId)}/terminal?terminalId=${encodeURIComponent(terminalId)}`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { setConnection('Connected'); socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); terminal.focus(); };
    socket.onmessage = event => {
      if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
      else {
        try { const message = JSON.parse(event.data) as { type: string; data?: string; error?: string }; if (message.type === 'output' && message.data) terminal.write(message.data); else if (message.error) { setConnection('Unavailable'); terminal.writeln(`\r\n${message.error}`); } }
        catch { terminal.write(event.data); }
      }
    };
    socket.onclose = () => { if (attached) setConnection('Disconnected'); };
    socket.onerror = () => { if (attached) setConnection('Unavailable'); };
    const input = terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); });
    const resize = terminal.onResize(({ cols, rows }) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows })); });
    const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* Hidden terminal tabs have no measurable area. */ } }); observer.observe(element.current);
    return () => { attached = false; observer.disconnect(); input.dispose(); resize.dispose(); socket.close(); terminal.dispose(); };
  }, [client, sessionId, terminalId, generation]);
  return <div className="terminal-wrapper"><div className="terminal-connection" role="status">{connection}{['Disconnected', 'Unavailable'].includes(connection) && <button className="terminal-reconnect" onClick={() => { setConnection('Connecting'); setGeneration(value => value + 1); }}>Reconnect</button>}</div><div className="terminal-surface" ref={element} /></div>;
}

export function TerminalPane({ client, session }: { client: DeviceClient; session: Session }) {
  const key = `enoughfactory.terminals.${session.id}`;
  const [tabs, setTabs] = useState<{ id: string; name: string }[]>(() => {
    try {
      const previous = JSON.parse(localStorage.getItem(key) ?? 'null') as { id: string; name: string }[] | null;
      if (Array.isArray(previous) && previous.length && previous.every(tab => typeof tab.id === 'string' && /^terminal-[\w-]+$/.test(tab.id) && typeof tab.name === 'string')) return previous;
    } catch { /* Recover the session even if a display preference is damaged. */ }
    return [{ id: `terminal-${crypto.randomUUID()}`, name: 'Terminal 1' }];
  });
  const [selected, setSelected] = useState(tabs[0]!.id);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(tabs)); } catch { /* The running shell remains owned by the device if preferences are unavailable. */ } }, [key, tabs]);
  if (session.status !== 'ready') return <EmptyState icon={<TerminalSquare size={32} />} title="Your terminal is waiting">Terminals connect when the environment is ready. A disconnected device keeps its running sessions.</EmptyState>;
  return <div className="terminal-pane"><div className="terminal-tabs">{tabs.map(tab => <div className={`terminal-tab ${selected === tab.id ? 'active' : ''}`} key={tab.id}><button onClick={() => setSelected(tab.id)}><TerminalSquare size={14} />{tab.name}</button>{tabs.length > 1 && <button aria-label={`Close ${tab.name}`} onClick={() => { const next = tabs.filter(item => item.id !== tab.id); setTabs(next); if (selected === tab.id) setSelected(next[0]!.id); }}><X size={12} /></button>}</div>)}<Button variant="ghost" size="icon" aria-label="New terminal" onClick={() => { const tab = { id: `terminal-${crypto.randomUUID()}`, name: `Terminal ${tabs.length + 1}` }; setTabs([...tabs, tab]); setSelected(tab.id); }}><Plus size={14} /></Button></div>{tabs.map(tab => <div className="terminal-tab-content" hidden={tab.id !== selected} key={tab.id}><TerminalSurface client={client} sessionId={session.id} terminalId={tab.id} /></div>)}</div>;
}
