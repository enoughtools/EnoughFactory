import type { EvaluationResponse, PlanResponse, PlannedTask } from "./types.js";
import { FactoryDecisionError } from "./errors.js";

/** Parse the last JSON object even when a provider wraps it in explanatory prose. */
export function readJsonObject(text: string): Record<string, unknown> {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]!);
  candidates.unshift(text.trim());
  const objects: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, quoted = false, escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { objects.push(text.slice(i, j + 1)); i = j; break; }
    }
  }
  candidates.push(...objects.reverse());
  for (const value of candidates) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* A provider may include prose before the structured response. */ }
  }
  throw new FactoryDecisionError("The agent did not return a structured factory decision. Its conversation is retained; a corrected response is required.");
}

function strings(value: unknown, name: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new FactoryDecisionError(`${name} must contain non-empty strings.`);
  return [...new Set(value.map(item => (item as string).trim()))];
}

export function readTasks(value: unknown): PlannedTask[] {
  if (!Array.isArray(value)) throw new FactoryDecisionError("The plan must contain a tasks array.");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new FactoryDecisionError(`Task ${index + 1} is invalid.`);
    const item = entry as Record<string, unknown>;
    if (typeof item.key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(item.key)) throw new FactoryDecisionError(`Task ${index + 1} needs a stable key.`);
    if (seen.has(item.key)) throw new FactoryDecisionError(`Task key ${item.key} is repeated.`);
    seen.add(item.key);
    if (typeof item.title !== "string" || !item.title.trim() || typeof item.description !== "string" || !item.description.trim()) throw new FactoryDecisionError(`Task ${item.key} needs a title and actionable description.`);
    return { key: item.key, title: item.title.trim(), description: item.description.trim(), dependsOn: strings(item.dependsOn, `${item.key}.dependsOn`), checks: strings(item.checks, `${item.key}.checks`), ...(typeof item.deviceId === "string" ? { deviceId: item.deviceId } : {}) };
  });
}

export function validateDependencies(tasks: PlannedTask[], completedKeys: Set<string> = new Set()): void {
  const byKey = new Map(tasks.map(task => [task.key, task]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key) || completedKeys.has(key)) return;
    if (visiting.has(key)) throw new FactoryDecisionError(`Task dependency cycle includes ${key}.`);
    const task = byKey.get(key);
    if (!task) throw new FactoryDecisionError(`Task dependency ${key} does not exist.`);
    visiting.add(key);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(key); visited.add(key);
  };
  for (const task of tasks) visit(task.key);
}

export function readPlan(text: string): PlanResponse {
  const object = readJsonObject(text);
  if (typeof object.summary !== "string" || !object.summary.trim()) throw new FactoryDecisionError("The plan needs a summary.");
  const criteria = strings(object.criteria, "criteria", true);
  if (!criteria.length) throw new FactoryDecisionError("The plan needs explicit completion criteria.");
  return { summary: object.summary.trim(), criteria, tasks: readTasks(object.tasks), checks: strings(object.checks, "checks") };
}

export function readEvaluation(text: string): EvaluationResponse {
  const object = readJsonObject(text);
  if (typeof object.complete !== "boolean" || typeof object.summary !== "string" || !Array.isArray(object.criteria)) throw new FactoryDecisionError("Evaluation must contain complete, summary and a criteria evidence array.");
  const criteria = object.criteria.map(entry => {
    if (!entry || typeof entry !== "object") throw new FactoryDecisionError("Criterion evidence is invalid.");
    const item = entry as Record<string, unknown>;
    if (typeof item.criterion !== "string" || typeof item.satisfied !== "boolean") throw new FactoryDecisionError("Each criterion needs its original text and a satisfied boolean.");
    return { criterion: item.criterion, satisfied: item.satisfied, evidence: strings(item.evidence, "criterion evidence", true) };
  });
  return { complete: object.complete, summary: object.summary, criteria,
    ...(object.additionalTasks === undefined ? {} : { additionalTasks: readTasks(object.additionalTasks) }),
    ...(typeof object.waitReason === "string" ? { waitReason: object.waitReason } : {}),
    ...(typeof object.wakeCondition === "string" ? { wakeCondition: object.wakeCondition } : {}) };
}
