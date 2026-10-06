import { useEffect, useState } from 'react';
import type { FactoryState, GoalStatus } from '@enoughfactory/contracts';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@enoughtools/ui-react';
import { ChevronDown, Folder, LayoutGrid, Monitor, Network, Plus, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import './factory-sidebar-goals.css';
import { BuildVersion } from './BuildVersion';

const brandMark = new URL('./assets/mark-ink.svg', import.meta.url).href;
const navigation = [
  { id: 'workbench', label: 'Workbench', icon: LayoutGrid },
  { id: 'devices', label: 'Devices', icon: Monitor },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
] as const;
const goalStatusLabels: Record<GoalStatus, string> = {
  draft: 'Draft', planning: 'Planning', running: 'Running', paused: 'Paused',
  waiting: 'Waiting', completed: 'Complete', failed: 'Failed', canceled: 'Canceled',
};

export interface FactorySidebarProps {
  state?: FactoryState | null;
  view: string;
  projectId?: string | null;
  goalId?: string;
  sessionSelected: boolean;
  error?: string | null;
  desktopVersion?: string;
  onNavigate: (view: string) => void;
  onProject: (id: string) => void;
  onGoal: (id: string) => void;
  onStartGoal: (projectId?: string) => void;
  onAddProject: () => void;
  onConnect: () => void;
  onRefresh: () => void;
}

export function FactorySidebar({ state, view, projectId, goalId, sessionSelected, error, desktopVersion, onNavigate, onProject, onGoal, onStartGoal, onAddProject, onConnect, onRefresh }: FactorySidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const activeGoal = view === 'goals' && !sessionSelected ? state?.goals.find(goal => goal.id === goalId) : undefined;
  const activeGoalProjectId = activeGoal?.projectId;
  const onlineWorkers = state?.devices.filter(device => device.platform !== 'browser' && device.online).length ?? 0;
  const pending = state?.approvals.filter(approval => approval.status === 'pending').length ?? 0;
  useEffect(() => {
    if (!activeGoalProjectId) return;
    setCollapsed(previous => {
      if (!previous.has(activeGoalProjectId)) return previous;
      const next = new Set(previous);
      next.delete(activeGoalProjectId);
      return next;
    });
  }, [activeGoalProjectId, goalId]);
  const toggleProject = (id: string) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return <Sidebar collapsible="none" className="factory-sidebar factory-sidebar-goals" aria-label="Factory navigation">
    <SidebarHeader>
      <a className="brand" href="#" onClick={event => { event.preventDefault(); onNavigate('workbench'); }}>
        <span className="brand-mark" aria-hidden="true"><img src={brandMark} width={32} height={32} alt="" /></span>
        <span className="brand-wordmark">Enough<span>Factory</span></span>
      </a>
      <BuildVersion className="sidebar-header-version" desktopVersion={desktopVersion} serviceVersion={state?.version} serviceOnline={!!state && !error} />
    </SidebarHeader>
    <SidebarContent>
      <nav className="nav-section" aria-label="Workspace">
        <div className="nav-label">Workspace</div>
        {navigation.map(item => {
          const selected = view === item.id && !sessionSelected;
          return <button type="button" className={`nav-item ${selected ? 'active' : ''}`} aria-current={selected ? 'page' : undefined} key={item.id} onClick={() => onNavigate(item.id)}>
            <item.icon className="nav-icon" size={17} /><span>{item.label}</span>
            {item.id === 'approvals' && pending > 0 && <span className="nav-count">{pending}</span>}
            {item.id === 'devices' && state && <span className="nav-count">{state.devices.filter(device => device.online).length}</span>}
          </button>;
        })}
      </nav>
      <nav className="nav-section project-section" aria-label="Projects and goals">
        <div className="nav-label"><span>Projects</span><button type="button" aria-label="Add project" title="Add project" onClick={onAddProject} disabled={!state}><Plus size={14} /></button></div>
        {state?.projects.length ? state.projects.map(project => {
          const goals = state.goals.filter(goal => goal.projectId === project.id).sort((left, right) => {
            const leftArchived = left.status === 'completed' || left.status === 'canceled';
            const rightArchived = right.status === 'completed' || right.status === 'canceled';
            return Number(leftArchived) - Number(rightArchived) || right.updatedAt.localeCompare(left.updatedAt);
          });
          const expanded = !collapsed.has(project.id);
          const selected = projectId === project.id && !sessionSelected && !activeGoal && (view === 'workbench' || view === 'goals');
          return <div className="factory-project-nav" key={project.id}>
            <div className="factory-project-nav-heading">
              <button type="button" className={`nav-item factory-project-link ${selected ? 'active' : ''}`} aria-current={selected ? 'page' : undefined} onClick={() => onProject(project.id)} title={project.name}>
                <Folder size={16} /><span>{project.name}</span>
              </button>
              <button type="button" className="factory-project-action" onClick={() => onStartGoal(project.id)} aria-label={`Start goal in ${project.name}`} title="Start goal"><Plus size={14} /></button>
              {goals.length > 0 && <button type="button" className="factory-project-action factory-project-collapse" aria-expanded={expanded} aria-controls={`factory-project-goals-${project.id}`} aria-label={`${expanded ? 'Collapse' : 'Expand'} goals in ${project.name}`} title={expanded ? 'Collapse goals' : 'Expand goals'} onClick={() => toggleProject(project.id)}><ChevronDown size={13} /></button>}
            </div>
            <div className="factory-project-goals" id={`factory-project-goals-${project.id}`} hidden={!expanded}>
              {goals.length ? goals.map(goal => {
                const goalSelected = activeGoal?.id === goal.id;
                const title = goal.title || 'Untitled goal';
                return <button type="button" key={goal.id} className={`nav-item factory-goal-link ${goalSelected ? 'active' : ''}`} aria-current={goalSelected ? 'page' : undefined} onClick={() => onGoal(goal.id)} title={`${title} · ${goalStatusLabels[goal.status]}`}>
                  <span className={`status-dot state-${goal.status}`} aria-hidden="true" />
                  <span className="factory-goal-link-copy"><span className="factory-goal-title">{title}</span><span className="factory-goal-status">{goalStatusLabels[goal.status]}</span></span>
                </button>;
              }) : <button type="button" className="factory-empty-goals" onClick={() => onStartGoal(project.id)}><Plus size={12} /><span>Start a goal</span></button>}
            </div>
          </div>;
        }) : <p className="sidebar-hint">{state ? 'No projects. Use + to add a repository.' : 'Connect a device to view projects.'}</p>}
      </nav>
    </SidebarContent>
    <SidebarFooter className="sidebar-footer">
      <button type="button" className={`nav-item ${view === 'settings' ? 'active' : ''}`} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><Settings2 size={17} /><span>Settings</span></button>
      <button type="button" className="device-status" onClick={() => state && !error ? onNavigate('devices') : onConnect()} title={state ? `Workspace hosted by ${state.device.name}. Open Devices to manage the computers available for work.` : 'Connect to a workspace'}>
        <span className={`status-dot state-${error ? 'offline' : state ? 'ready' : 'starting'}`} aria-hidden="true" />
        <div><strong>{error ? 'Workspace offline' : state ? 'Workspace connected' : 'Connect workspace'}</strong><span>{error ? `Last connected to ${state?.device.name ?? 'device'}` : state ? `${state.device.name} · ${onlineWorkers} device${onlineWorkers === 1 ? '' : 's'} online` : 'No device connected'}</span></div>
        <Network size={15} />
      </button>
      <div className="sidebar-build-row"><BuildVersion desktopVersion={desktopVersion} serviceVersion={state?.version} serviceOnline={!!state && !error} /><button type="button" className="sidebar-refresh" aria-label="Refresh workspace" title="Refresh workspace" onClick={onRefresh}><RefreshCw size={13} /></button></div>
    </SidebarFooter>
  </Sidebar>;
}
