import type { Approval, Attempt, Chat, ControllerRun, FactoryTask, Goal, Project, Session } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import type { SessionController } from './sessions.ts';
import type { Store } from './store.ts';
import { HttpError, now } from './util.ts';

interface RemovalGroup { id: string; archivedAt: string; projectIds: string[]; sessionIds: string[]; restoredAt?: string; }
interface WorkerReceipt {
  id: string; status: string; sessionId?: string; chatId?: string; cancellationAcknowledged?: boolean;
  project?: Project; goal?: Goal; workspace?: { sessionId?: string }; result?: { status: string; error?: string; sessionId?: string };
}

/** Catalog removal preserves source, chats, factory authority and immutable evidence. */
export class CatalogRemoval {
  constructor(private store: Store, private sessions: SessionController, private deviceId: () => string, private changed: () => void) {}

  archiveSession(sessionId: string): Session {
    const session = this.sessions.record(sessionId);
    this.local(session);
    if (session.archivedAt) return session;
    this.sessions.assertCanArchive(sessionId);
    this.assertNoWork(new Set([sessionId]));
    const archived = { ...session, archivedAt: now() };
    this.store.set('sessions', archived); this.changed(); return archived;
  }

  restoreSession(sessionId: string): Session {
    const session = this.sessions.record(sessionId);
    this.local(session);
    const project = this.store.get<Project>('projects', session.projectId);
    if (project) this.sessions.assertActiveProject(project);
    if (!session.archivedAt) return session;
    const restored = { ...session, archivedAt: undefined };
    this.store.set('sessions', restored); this.changed(); return restored;
  }

  archiveProject(projectId: string): Project {
    const project = this.project(projectId);
    this.local(project);
    if (project.internal) throw new HttpError(409, 'Factory workspace projects are managed through their environments.');
    if (project.archivedAt) return project;
    const projects = this.descendants(projectId), projectIds = new Set(projects.map(item => item.id));
    const sessions = this.store.list<Session>('sessions').filter(item => projectIds.has(item.projectId));
    const sessionIds = new Set(sessions.map(item => item.id));
    if (this.store.list<Goal>('goals').some(goal => projectIds.has(goal.projectId) && !['completed', 'failed', 'canceled'].includes(goal.status))) {
      throw new HttpError(409, 'Complete or cancel this project’s goals before removing it.', 'PROJECT_IN_USE');
    }
    for (const session of sessions) this.sessions.assertCanArchive(session.id);
    this.assertNoWork(sessionIds, projectIds);
    const at = now();
    const group: RemovalGroup = { id: project.id, archivedAt: at, projectIds: projects.filter(item => !item.archivedAt).map(item => item.id), sessionIds: sessions.filter(item => !item.archivedAt).map(item => item.id) };
    this.store.transaction(() => {
      for (const item of projects.filter(item => !item.archivedAt)) this.store.set('projects', { ...item, archivedAt: at });
      for (const item of sessions.filter(item => !item.archivedAt)) this.store.set('sessions', { ...item, archivedAt: at });
      this.store.set('catalog-removals', group);
    });
    this.changed(); return this.project(project.id);
  }

  restoreProject(projectId: string): Project {
    const project = this.project(projectId);
    this.local(project);
    if (project.internal) throw new HttpError(409, 'Restore the source project before restoring its factory workspace.');
    if (!project.archivedAt) return project;
    const group = this.store.get<RemovalGroup>('catalog-removals', project.id);
    this.store.transaction(() => {
      this.store.set('projects', { ...project, archivedAt: undefined });
      if (group && group.archivedAt === project.archivedAt) {
        for (const id of group.projectIds) {
          const item = this.store.get<Project>('projects', id);
          if (item?.archivedAt === group.archivedAt) this.store.set('projects', { ...item, archivedAt: undefined });
        }
        for (const id of group.sessionIds) {
          const item = this.store.get<Session>('sessions', id);
          if (item?.archivedAt === group.archivedAt) this.store.set('sessions', { ...item, archivedAt: undefined });
        }
        this.store.set<RemovalGroup>('catalog-removals', { ...group, restoredAt: now() });
      }
    });
    this.changed(); return this.project(project.id);
  }

  private project(id: string): Project {
    const project = this.store.get<Project>('projects', id);
    if (!project) throw new HttpError(404, 'Project not found.');
    return project;
  }

  private local(record: Project | Session): void {
    if (record.deviceId !== this.deviceId()) throw new HttpError(409, 'Removal and restoration belong to the owning device.', 'DEVICE_OWNERSHIP_CHANGED');
  }

  private descendants(projectId: string): Project[] {
    const projects = this.store.list<Project>('projects'), ids = new Set([projectId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const project of projects) if (project.sourceProjectId && ids.has(project.sourceProjectId) && !ids.has(project.id)) { ids.add(project.id); expanded = true; }
    }
    return projects.filter(item => ids.has(item.id));
  }

  private assertNoWork(sessionIds: Set<string>, projectIds = new Set<string>()): void {
    const chats = this.store.list<Chat>('chats'), chatById = new Map(chats.map(chat => [chat.id, chat]));
    const sessionRef = (sessionId?: string, chatId?: string): boolean => (!!sessionId && sessionIds.has(sessionId)) || (!!chatId && sessionIds.has(chatById.get(chatId)?.sessionId ?? ''));
    if (chats.some(chat => sessionIds.has(chat.sessionId) && ['running', 'waiting'].includes(chat.status)) ||
      this.store.list<Approval>('approvals').some(approval => approval.status === 'pending' && sessionIds.has(approval.sessionId))) {
      throw new HttpError(409, 'An agent is still working or awaiting input in this environment.', 'ENVIRONMENT_IN_USE');
    }
    const tasks = this.store.list<FactoryTask>('tasks'), taskById = new Map(tasks.map(task => [task.id, task]));
    const attempts = this.store.list<Attempt>('attempts'), details = new Map(this.store.list<AttemptDetail>('factory-attempt-details').map(detail => [detail.id, detail]));
    const goalIds = new Set(this.store.list<Goal>('goals').filter(goal => projectIds.has(goal.projectId)).map(goal => goal.id));
    if (attempts.some(attempt => {
      const detail = details.get(attempt.id), task = taskById.get(attempt.taskId);
      const related = sessionRef(attempt.sessionId, attempt.chatId) || sessionRef(detail?.workspace?.sessionId) || sessionRef(detail?.result?.sessionId, detail?.result?.chatId) ||
        (!!task && (sessionRef(task.sessionId) || goalIds.has(task.goalId)));
      return related && (['created', 'running', 'unknown'].includes(attempt.status) || detail?.cancellation === 'requested' || (!!task && task.currentAttemptId === attempt.id && ['running', 'review'].includes(task.status)));
    }) || tasks.some(task => sessionRef(task.sessionId) && ['running', 'review'].includes(task.status)) ||
      this.store.list<ControllerRun>('factory-controller-runs').some(run => (sessionRef(run.sessionId, run.chatId) || goalIds.has(run.goalId)) && ['starting', 'running'].includes(run.status))) {
      throw new HttpError(409, 'Factory work or an unknown execution outcome still owns this environment. Reconcile it before removal.', 'FACTORY_WORK_IN_USE');
    }
    if (this.store.list<WorkerReceipt>('factory-workers').some(worker => {
      const related = sessionRef(worker.sessionId, worker.chatId) || sessionRef(worker.workspace?.sessionId) || sessionRef(worker.result?.sessionId) ||
        (!!worker.project && (projectIds.has(worker.project.id) || projectIds.has(worker.project.sourceProjectId ?? ''))) || (!!worker.goal && projectIds.has(worker.goal.projectId));
      // Older journals wrote the exact acknowledgment receipt before the typed flag was introduced.
      const acknowledged = worker.cancellationAcknowledged === true || (worker.cancellationAcknowledged === undefined && worker.result?.status === 'failed' && worker.result.error === 'Cancellation acknowledged by the owning service.');
      return related && (['preparing', 'prepared', 'running', 'unknown'].includes(worker.status) || (worker.status === 'canceled' && !acknowledged));
    })) throw new HttpError(409, 'The factory worker has not confirmed that this environment’s work ended.', 'FACTORY_WORK_IN_USE');
  }
}
