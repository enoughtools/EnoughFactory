import { createHash } from 'node:crypto';
import type { BrowserObservation } from '@enoughfactory/browser-inspection';
import type { InspectionAuthority } from '@enoughfactory/contracts';
import type { ParsedBrowserObservation } from './inspection-browser-observation.ts';

// These service-owned functions never contain agent arguments or expected values.
export const browserPageIdentityFunction = '() => ({version:1, href:document.URL, timeOrigin:performance.timeOrigin})';
export const browserFormValueFunction = `(element) => {
  const result = {version:1, href:element.ownerDocument.URL, timeOrigin:element.ownerDocument.defaultView.performance.timeOrigin, connected:element.isConnected, tag:element.tagName.toLowerCase()};
  const input = element instanceof HTMLInputElement;
  const type = input ? element.type.toLowerCase() : undefined;
  if (input && (type === 'password' || type === 'hidden')) return {...result, type, excluded:true};
  if (!(input || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return {...result, unsupported:true};
  const value = element.value;
  if (typeof value !== 'string' || value.length > 65536) return {...result, overBound:true};
  return {...result, ...(type ? {type} : {}), value};
}`;

type Read = { stage: string; tool: string; arguments: Record<string, unknown>; result?: unknown; lease?: unknown; error?: string; omittedSha256?: string; omittedBytes?: number };
export interface BrowserFormBinding { backendSessionId: string; sourceSha256: string; authority: InspectionAuthority; }
export type BrowserFormCall = (tool: string, args: Record<string, unknown>) => Promise<BrowserObservation>;
interface Page { href: string; timeOrigin: number; tab: number; }
export interface BrowserFormFrame { binding: BrowserFormBinding; reads: Read[]; page?: Page; reason?: string; invalidated?: boolean; }
const maxBytes = 65536;

function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function resultText(observation: BrowserObservation): string | undefined {
  if (observation.result.isError || !Array.isArray(observation.result.content) || observation.result.content.some(block => block.type !== 'text')) return undefined;
  const text = observation.result.content.map(block => block.text ?? '').join('\n');
  return Buffer.byteLength(text) <= 256 * 1024 ? text : undefined;
}
function resultJson(observation: BrowserObservation): Record<string, unknown> | undefined {
  const text = resultText(observation); if (!text) return undefined;
  const headings = [...text.matchAll(/^### Result[ \t]*\r?$/gm)];
  if (headings.length !== 1) return undefined;
  const content = text.slice(headings[0]!.index! + headings[0]![0].length).split(/^### /m)[0]!.trim();
  try { const value: unknown = JSON.parse(content); return plain(value) ? value : undefined; } catch { return undefined; }
}
function owned(observation: BrowserObservation, binding: BrowserFormBinding): boolean {
  const lease = observation.lease, a = binding.authority;
  return !!lease && lease.id === binding.backendSessionId && lease.source?.snapshotSha256 === binding.sourceSha256 && lease.goalId === a.goalId && lease.taskId === a.taskId && lease.attemptId === a.attemptId && lease.authorityGeneration === a.authorityGeneration;
}
async function read(frame: BrowserFormFrame, call: BrowserFormCall, stage: string, tool: string, args: Record<string, unknown>): Promise<BrowserObservation | undefined> {
  const record: Read = { stage, tool, arguments: args }; frame.reads.push(record);
  try {
    const observation = await call(tool, args);
    const bytes = Buffer.from(JSON.stringify(observation.result));
    if (bytes.length > 256 * 1024) { record.omittedSha256 = createHash('sha256').update(bytes).digest('hex'); record.omittedBytes = bytes.length; frame.reason = 'The exact form read exceeded its evidence bound.'; return undefined; }
    if (frame.reads.reduce((size, prior) => size + (prior.result ? Buffer.byteLength(JSON.stringify(prior.result)) : 0), 0) + bytes.length > 512 * 1024) { record.omittedSha256 = createHash('sha256').update(bytes).digest('hex'); record.omittedBytes = bytes.length; frame.reason = 'Exact form results exceed their shared evidence bound.'; return undefined; }
    record.result = observation.result; record.lease = { id: observation.lease?.id, sessionId: observation.lease?.sessionId, goalId: observation.lease?.goalId, taskId: observation.lease?.taskId, attemptId: observation.lease?.attemptId, authorityGeneration: observation.lease?.authorityGeneration, source: observation.lease?.source };
    if (!owned(observation, frame.binding)) { frame.reason = 'The exact form read belongs to another browser/source authority.'; frame.invalidated = true; return undefined; }
    return observation;
  } catch (error) { record.error = (error as Error).message.slice(0, 1024); frame.reason = 'The exact form read was not confirmed.'; return undefined; }
}
async function page(frame: BrowserFormFrame, call: BrowserFormCall, stage: string): Promise<Page | undefined> {
  const tabs = await read(frame, call, `${stage}-tabs`, 'browser_tabs', { action: 'list' });
  const current = tabs && resultText(tabs)?.match(/^\s*- (\d+): \(current\) /gm);
  if (!current || current.length !== 1) { frame.reason ??= 'The current browser tab could not be confirmed.'; return undefined; }
  const identity = await read(frame, call, `${stage}-page`, 'browser_evaluate', { function: browserPageIdentityFunction });
  const value = identity && resultJson(identity);
  if (!value || value.version !== 1 || typeof value.href !== 'string' || value.href.length > 8192 || typeof value.timeOrigin !== 'number' || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0) { frame.reason ??= 'The current browser document could not be confirmed.'; return undefined; }
  return { href: value.href, timeOrigin: value.timeOrigin, tab: Number(/\d+/.exec(current[0]!)![0]) };
}
export async function beginBrowserFormObservation(binding: BrowserFormBinding, supported: string[], call: BrowserFormCall): Promise<BrowserFormFrame> {
  const frame: BrowserFormFrame = { binding, reads: [] };
  if (!supported.includes('browser_evaluate') || !supported.includes('browser_tabs')) { frame.reason = 'The browser does not provide exact form-value observation.'; return frame; }
  frame.page = await page(frame, call, 'before'); return frame;
}
function samePage(a: Page, b: Page): boolean { return a.href === b.href && a.timeOrigin === b.timeOrigin && a.tab === b.tab; }

/** Replace editable snapshot scalars only with fixed, owned, page-bound DOM reads. */
export async function completeBrowserFormObservation(frame: BrowserFormFrame, parsed: ParsedBrowserObservation, snapshotText: string, call: BrowserFormCall) {
  const elements = parsed.elements.map(element => ({ ...element }));
  for (const field of parsed.formFields) delete elements[field.index]!.value;
  let complete = parsed.formFields.length === 0;
  const raw = { version: 1, binding: frame.binding, snapshotSha256: createHash('sha256').update(snapshotText).digest('hex'), fields: parsed.formFields, reads: frame.reads, complete, reason: frame.reason };
  const output = () => ({ elements, raw, observationCurrent: !frame.invalidated });
  if (!frame.page) return output();
  const urls = [...snapshotText.matchAll(/^- Page URL: (.+)\r?$/gm)];
  if (urls.length !== 1 || urls[0]![1]!.replace(/\r$/, '') !== frame.page.href) {
    frame.invalidated = true; raw.reason = 'The snapshot document differs from the original observed page.'; return output();
  }
  const values = new Map<number, string>(); let total = 0, excluded = false;
  if (parsed.formFields.length > 64) frame.reason = 'The snapshot field inventory exceeds its observation bound.';
  if (!frame.reason) for (const field of parsed.formFields) {
    if (!field.identifier || !/^(?:f\d+)?e\d+$/.test(field.identifier)) { frame.reason = 'An editable snapshot field has no original reference.'; break; }
    const observation = await read(frame, call, `field:${field.identifier}`, 'browser_evaluate', { target: field.identifier, element: field.label, function: browserFormValueFunction });
    const value = observation && resultJson(observation);
    if (value && (value.href !== frame.page.href || value.timeOrigin !== frame.page.timeOrigin || value.connected !== true)) { frame.invalidated = true; frame.reason = 'An exact field read belongs to another document.'; break; }
    if (!value || value.version !== 1 || !['input', 'textarea', 'select'].includes(String(value.tag))) { frame.reason ??= 'An exact field read is missing or unsupported.'; break; }
    if (value.excluded === true && (value.type === 'password' || value.type === 'hidden')) { excluded = true; continue; }
    if (value.type === 'password' || value.type === 'hidden' || typeof value.value !== 'string' || Buffer.byteLength(value.value) > maxBytes || value.overBound || value.unsupported) { frame.reason = 'An exact field value is unavailable or exceeds its evidence bound.'; break; }
    total += Buffer.byteLength(value.value); if (total > maxBytes) { frame.reason = 'Exact form values exceed their shared evidence bound.'; break; }
    values.set(field.index, value.value);
  }
  const after = await page(frame, call, 'after');
  if (!after || !samePage(frame.page, after)) { frame.invalidated = true; frame.reason ??= 'The browser tab/document changed during the exact form read.'; }
  if (frame.reason || frame.invalidated) { raw.complete = false; raw.reason = frame.reason; return output(); }
  for (const [index, value] of values) elements[index]!.value = value;
  complete = !excluded && values.size === parsed.formFields.length;
  raw.complete = complete; raw.reason = excluded ? 'Secure fields are excluded from exact form evidence.' : frame.reason;
  return output();
}
