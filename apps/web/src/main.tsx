import React from 'react';
import { createRoot } from 'react-dom/client';
import '@enoughtools/ui-react/styles.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';

class RenderBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="empty-state"><h1>We couldn’t open this workspace.</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>Reload EnoughFactory</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><RenderBoundary><App /></RenderBoundary></React.StrictMode>);
