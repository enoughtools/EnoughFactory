export interface GoalDraft {
  title: string;
  objective: string;
  specification: string;
  /** One completion criterion per line, matching the goal editor. */
  criteria: string;
  sessionId?: string;
  chatId?: string;
}

function emptyDraft(): GoalDraft {
  return { title: '', objective: '', specification: '', criteria: '' };
}

function draftFields(value: unknown): GoalDraft {
  const draft = emptyDraft();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return draft;
  const fields = value as Record<string, unknown>;
  for (const key of ['title', 'objective', 'specification', 'criteria'] as const) {
    if (typeof fields[key] === 'string') draft[key] = fields[key];
  }
  for (const key of ['sessionId', 'chatId'] as const) {
    if (typeof fields[key] === 'string' && fields[key].trim()) draft[key] = fields[key].trim();
  }
  return draft;
}

export function readGoalDraft(key: string): GoalDraft {
  try {
    return draftFields(JSON.parse(localStorage.getItem(key) ?? 'null'));
  } catch {
    return emptyDraft();
  }
}

export function saveGoalDraft(key: string, draft: GoalDraft): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(draftFields(draft)));
    return true;
  } catch {
    return false;
  }
}

export function clearGoalDraft(key: string, submitted?: GoalDraft): void {
  try {
    if (submitted && JSON.stringify(readGoalDraft(key)) !== JSON.stringify(draftFields(submitted))) return;
    localStorage.removeItem(key);
  } catch { /* The editor also works when local storage is unavailable. */ }
}

/** Preserve the complete specification in the existing durable goal contract. */
export function goalObjective(draft: GoalDraft): string {
  const objective = draft.objective.trim(), specification = draft.specification.trim();
  return specification ? `${objective}${objective ? '\n\n' : ''}## Specification\n${specification}` : objective;
}

function proposalFields(value: unknown): Partial<GoalDraft> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const allowed = new Set(['title', 'objective', 'specification', 'criteria']);
  if (Object.keys(fields).some(key => !allowed.has(key))) return null;
  const proposal: Partial<GoalDraft> = {};
  for (const key of ['title', 'objective', 'specification'] as const) {
    if (Object.hasOwn(fields, key)) {
      if (typeof fields[key] !== 'string') return null;
      proposal[key] = fields[key];
    }
  }
  if (Object.hasOwn(fields, 'criteria')) {
    if (!Array.isArray(fields.criteria) || fields.criteria.some(criterion => typeof criterion !== 'string')) return null;
    proposal.criteria = fields.criteria.map(criterion => criterion.trim()).filter(Boolean).join('\n');
  }
  if (!proposal.objective?.trim() && !proposal.specification?.trim()) return null;
  return proposal;
}

/** Only a structured proposal can replace editor fields; prose is never a fallback. */
export function parseGoalProposal(text: string): Partial<GoalDraft> | null {
  try { return proposalFields(JSON.parse(text.trim())); } catch { /* A provider may wrap the JSON in a code fence. */ }
  // Fence boundaries must be lines: a specification can itself contain quoted code fences.
  const fences = [...text.matchAll(/^[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim)];
  const candidate = fences.at(-1)?.[1];
  if (!candidate) return null;
  try { return proposalFields(JSON.parse(candidate.trim())); } catch { return null; }
}
