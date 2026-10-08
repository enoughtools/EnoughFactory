import type { ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { useHistoryScroll } from './use-history-scroll';
import { Button } from './ui';

export function HistoryPanel({ title, label, version, ready = true, actions, children, className = '' }: {
  title: string; label: string; version: unknown; ready?: boolean; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  const history = useHistoryScroll(version, ready);
  return <section className={`panel history-panel ${className}`} aria-label={title}>
    <header className="panel-header"><h2 className="panel-title">{title}</h2><div className="panel-actions">
      {!history.atLatest && <Button size="sm" variant="ghost" onClick={history.scrollToLatest}><ArrowDown size={13} />Latest</Button>}
      {actions}
    </div></header>
    <div className="history-scroll" ref={history.viewport} onScroll={history.onScroll} tabIndex={0} role="region" aria-label={label}>
      <div className="history-content" ref={history.content}>{children}</div>
    </div>
  </section>;
}
