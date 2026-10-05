import type { ReactNode } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from '@enoughtools/ui-react';
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react';

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-illustration" aria-hidden="true">{icon}</div><h2 className="empty-title">{title}</h2><div className="empty-description">{children}</div>{action}</div>;
}
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1 className="page-title">{title}</h1>{description && <p className="page-description">{description}</p>}</div>{actions && <div className="header-actions">{actions}</div>}</header>;
}
export function Panel({ title, actions, children, className = '' }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{title && <div className="panel-header"><h2 className="panel-title">{title}</h2>{actions && <div className="panel-actions">{actions}</div>}</div>}<div className="panel-body">{children}</div></section>;
}
export function Status({ state, label }: { state: string; label?: string }) {
  return <span className={`badge-status state-${state}`}><span className={`status-dot state-${state}`} />{label ?? state.replaceAll('_', ' ')}</span>;
}
export function Loading({ children = 'Connecting to your workspace…' }: { children?: ReactNode }) {
  return <div className="empty-state" role="status"><LoaderCircle className="loading-spinner" size={24} /><div className="empty-description">{children}</div></div>;
}
export function Modal({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description: string; children: ReactNode }) {
  return <Dialog open={open} onOpenChange={(value: boolean) => !value && onClose()}><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export { Button, Input, ArrowUpRight, X };
