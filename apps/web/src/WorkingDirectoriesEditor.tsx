import { useId, useRef, useState } from 'react';
import type { WorkingDirectory } from '@enoughfactory/contracts';
import { Folder, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import { Button, Input } from './ui';
import './working-directories.css';

export type { WorkingDirectory } from '@enoughfactory/contracts';
export interface WorkingDirectoriesEditorProps {
  value: WorkingDirectory[];
  onChange: (value: WorkingDirectory[]) => void;
  canBrowse: boolean;
  disabled?: boolean;
  primaryPath?: string;
  deviceName?: string;
}

const MAX_DIRECTORIES = 8;
const DIRECTORY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;

function normalizedPath(value: string): string {
  const trimmed = value.trim();
  if (/^[\\/]+$/.test(trimmed)) return trimmed[0]!;
  if (/^[a-zA-Z]:[\\/]+$/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.replace(/[\\/]+$/, '');
}

export function normalizeWorkingDirectories(value: WorkingDirectory[]): WorkingDirectory[] {
  return value.map(directory => ({ ...directory, name: directory.name.trim(), path: normalizedPath(directory.path) }));
}

export function workingDirectoryError(value: WorkingDirectory[], primaryPath?: string): string | null {
  if (value.length > MAX_DIRECTORIES) return `Add up to ${MAX_DIRECTORIES} additional folders.`;
  const names = new Set<string>();
  const paths = new Set<string>();
  const primary = primaryPath ? normalizedPath(primaryPath) : '';
  for (const [index, directory] of normalizeWorkingDirectories(value).entries()) {
    const label = `Folder ${index + 1}`;
    if (!directory.path) return `${label}: enter a folder path or remove this row.`;
    if (!directory.name) return `${label}: enter a name for its workspace directory.`;
    if (!DIRECTORY_NAME.test(directory.name)) return `${label}: use 1–48 letters, numbers, dots, underscores or hyphens, starting with a letter or number.`;
    if (names.has(directory.name)) return `${label}: each folder needs a unique name.`;
    if (directory.path === primary) return `${label}: the primary repository is already included.`;
    if (paths.has(directory.path)) return `${label}: this folder path is already included.`;
    names.add(directory.name);
    paths.add(directory.path);
  }
  return null;
}

function nameFromPath(path: string): string {
  const basename = normalizedPath(path).split(/[\\/]/).at(-1) ?? '';
  const name = basename.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 48);
  return name || 'folder';
}

export function WorkingDirectoriesEditor({ value, onChange, canBrowse, disabled = false, primaryPath, deviceName }: WorkingDirectoriesEditorProps) {
  const prefix = useId();
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const current = useRef({ value, onChange, disabled });
  current.current = { value, onChange, disabled };
  const updateDirectory = (id: string, changes: Partial<WorkingDirectory>) => {
    if (current.current.disabled) return;
    current.current.onChange(current.current.value.map(directory => directory.id === id ? { ...directory, ...changes } : directory));
    setPickerError(null);
  };
  async function browse(id: string) {
    setPickerError(null);
    setPickingId(id);
    try {
      if (!window.enoughFactory) throw new Error('Folder browsing is only available for the desktop’s own device. Enter the path instead.');
      const path = await window.enoughFactory.pickDirectory();
      if (!path || current.current.disabled) return;
      const directory = current.current.value.find(item => item.id === id);
      if (!directory) return;
      updateDirectory(id, { path: normalizedPath(path), ...(!directory.name.trim() ? { name: nameFromPath(path) } : {}) });
    } catch (cause) {
      setPickerError(cause instanceof Error ? cause.message : 'The folder picker could not be opened. Enter the path instead.');
    } finally { setPickingId(null); }
  }
  return <section className="working-directories" aria-labelledby={`${prefix}-heading`}>
    {primaryPath?.trim() && <div className="working-directories-primary"><div><LockKeyhole size={13} aria-hidden="true" /><strong>Primary repository</strong></div><code>{primaryPath}</code></div>}
    <div className="section-heading working-directories-heading">
      <h3 id={`${prefix}-heading`}>Additional repositories and folders</h3>
      <Button type="button" variant="ghost" size="sm" disabled={disabled || value.length >= MAX_DIRECTORIES} onClick={() => { setPickerError(null); onChange([...value, { id: crypto.randomUUID(), name: '', path: '' }]); }}><Plus size={14} />Add folder</Button>
    </div>
    <p className="field-hint">Primary repository integrates automatically. Edits in additional folders are retained and exportable, and applied separately.</p>
    <div className="working-directories-rows">
      {value.map((directory, index) => {
        const pathId = `${prefix}-${directory.id}-path`;
        const nameId = `${prefix}-${directory.id}-name`;
        const mountId = `${prefix}-${directory.id}-mount`;
        return <div className="working-directory-row" key={directory.id}>
          <div className="working-directory-row-header"><span><Folder size={13} aria-hidden="true" />Folder {index + 1}</span><Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={`Remove folder ${index + 1}${directory.name ? ` (${directory.name})` : ''}`} onClick={() => { setPickerError(null); onChange(value.filter(item => item.id !== directory.id)); }}><Trash2 size={14} /></Button></div>
          <div className="working-directory-fields">
            <div className="form-field working-directory-path"><label htmlFor={pathId}>Folder path{deviceName ? ` on ${deviceName}` : ''}</label><div className="path-input"><Input id={pathId} required value={directory.path} disabled={disabled} spellCheck={false} placeholder="/home/you/code/library" onChange={event => updateDirectory(directory.id, { path: event.target.value })} onBlur={() => { if (directory.path.trim() && !directory.name.trim()) updateDirectory(directory.id, { name: nameFromPath(directory.path) }); }} />{canBrowse && <Button type="button" variant="outline" size="icon" disabled={disabled || pickingId !== null} aria-label={`Choose folder ${index + 1}`} onClick={() => void browse(directory.id)}><Folder size={15} /></Button>}</div></div>
            <div className="form-field working-directory-name"><label htmlFor={nameId}>Workspace name</label><Input id={nameId} required pattern={'[a-zA-Z0-9][a-zA-Z0-9._\\-]{0,47}'} maxLength={48} value={directory.name} disabled={disabled} spellCheck={false} aria-describedby={mountId} placeholder="library" onChange={event => updateDirectory(directory.id, { name: event.target.value })} /></div>
          </div>
          <div className="working-directory-mount" id={mountId}><span>Isolated writable snapshot</span><code>/workspaces/{directory.name.trim() || '<name>'}</code></div>
        </div>;
      })}
    </div>
    {pickerError && <div className="error-banner working-directories-error" role="alert">{pickerError}</div>}
    <p className="field-hint working-directories-future">Changes apply to future workspaces. Running workspaces keep their existing snapshots.</p>
  </section>;
}
