export interface ParsedBrowserObservation {
  uiTree: string;
  elements: Array<{ label: string; identifier?: string; value?: string }>;
  elementIds: string[];
  /** Snapshot-listed editable controls; raw snapshot text is not exact form-value evidence. */
  formFields: Array<{ index: number; identifier?: string; label: string }>;
  /** Incomplete/unsupported structure may support positive inspection, never an absence assertion. */
  truncated: boolean;
}
const maxBytes = 64 * 1024, maxElements = 2000;
const empty = (): ParsedBrowserObservation => ({ uiTree: '', elements: [], elementIds: [], formFields: [], truncated: true });
const roles = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem text iframe').split(' '));
const inputs = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
// The pinned renderer silently omits names longer than 900 characters. For these
// controls an absent name cannot distinguish a genuinely empty name from loss.
const namedControls = new Set('button link dialog alertdialog heading textbox searchbox combobox spinbutton slider checkbox radio switch menuitem menuitemcheckbox menuitemradio option tab treeitem'.split(' '));

function scalar(value: string): string | undefined {
  if (!value) return '';
  if (value.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'string' ? parsed : undefined; }
    catch { return undefined; }
  }
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : undefined;
  // No YAML aliases, tags, multiline values, collections or comments are interpreted.
  if (/^[!&*|>{\[]/.test(value) || /\s#/.test(value)) return undefined;
  return value;
}

/**
 * Parse only Playwright MCP's actual snapshot section. Its surrounding response can
 * contain console logs, generated code and errors; those must never become UI nodes.
 * The intentionally small grammar fails absence checks closed as formats evolve.
 */
export function parseBrowserObservation(input: string): ParsedBrowserObservation {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 512 * 1024) return empty();
  // Pinned @playwright/mcp 0.0.82 uses "Snapshot"; older builds used "Page Snapshot".
  const headings = [...input.matchAll(/^### (?:Page )?Snapshot[ \t]*\r?$/gim)];
  if (headings.length !== 1) return empty();
  const afterHeading = input.slice(headings[0]!.index! + headings[0]![0].length);
  const section = /^\r?\n```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/i.exec(afterHeading);
  if (!section) return empty();
  const original = section[1]!;
  const bytes = Buffer.from(original), truncatedBytes = bytes.length > maxBytes;
  const uiTree = (truncatedBytes ? bytes.subarray(0, maxBytes).toString('utf8') : original);
  const output: ParsedBrowserObservation = { uiTree, elements: [], elementIds: [], formFields: [], truncated: truncatedBytes };
  const refs = new Set<string>();
  const parents = new Map<number, { role: string; element: ParsedBrowserObservation['elements'][number] }>();
  let previousIndent = -2, nodes = 0;
  for (const line of uiTree.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.includes('\t')) { output.truncated = true; continue; }
    const listed = /^( *)- (.*)$/.exec(line);
    if (!listed) { output.truncated = true; continue; }
    const indent = listed[1]!.length;
    let body = listed[2]!;
    if (indent % 2 !== 0 || indent > previousIndent + 2 || (nodes === 0 && indent !== 0)) output.truncated = true;
    previousIndent = indent; nodes++;
    // The pinned serializer quotes the whole key when a name contains ': ' or ' #'.
    if (body.startsWith("'")) {
      const quoted = /^'((?:[^']|'')*)'(?::(.*))?$/.exec(body);
      if (!quoted) { output.truncated = true; continue; }
      body = quoted[1]!.replaceAll("''", "'") + (quoted[2] === undefined ? '' : `:${quoted[2]}`);
    }
    // URL/placeholder metadata is not the node's actual value or visible label.
    if (/^\/(?:url|placeholder): /.test(body)) continue;
    const node = /^([a-zA-Z][a-zA-Z0-9-]*)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]\r\n]*\])*)(?::(?: (.*))?)?$/.exec(body);
    if (!node) { output.truncated = true; continue; }
    const role = node[1]!, name = node[2] === undefined ? undefined : scalar(node[2]), attributes = node[3]!, rawValue = node[4];
    if (!roles.has(role)) { output.truncated = true; continue; }
    const nodeValue = rawValue === undefined ? undefined : scalar(rawValue);
    if (node[2] !== undefined && name === undefined || rawValue !== undefined && nodeValue === undefined) { output.truncated = true; continue; }
    if (namedControls.has(role) && !name) output.truncated = true;
    const referenceMatches = [...attributes.matchAll(/\[ref=([a-zA-Z0-9_-]{1,512})\]/g)];
    if (referenceMatches.length > 1 || attributes.includes('[ref=') && !referenceMatches.length) { output.truncated = true; continue; }
    const identifier = referenceMatches[0]?.[1];
    if (identifier && refs.has(identifier)) { output.truncated = true; continue; }
    if (output.elements.length >= maxElements) { output.truncated = true; break; }
    if (identifier) { refs.add(identifier); output.elementIds.push(identifier); }
    // Unnamed text/status nodes expose their visible content as a label. Input
    // values remain separate so ref/checked/level metadata cannot satisfy values.
    const label = name ?? (nodeValue && !inputs.has(role) ? nodeValue : role);
    const element = { label, ...(identifier ? { identifier } : {}), ...(nodeValue === undefined ? {} : { value: nodeValue }) };
    const parent = parents.get(indent - 2);
    if (role === 'text' && nodeValue !== undefined && parent && inputs.has(parent.role)) parent.element.value = parent.element.value === undefined ? nodeValue : `${parent.element.value}\n${nodeValue}`;
    for (const level of parents.keys()) if (level >= indent) parents.delete(level);
    parents.set(indent, { role, element });
    if (inputs.has(role)) output.formFields.push({ index: output.elements.length, ...(identifier ? { identifier } : {}), label });
    output.elements.push(element);
  }
  if (!nodes) output.truncated = true;
  return output;
}
