// Files and images attached to a chat message.
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface Attachment {
  id: string;
  kind: 'text' | 'image' | 'folder';
  name: string;
  size: number;
  /** For text files. */
  text?: string;
  /** For images: data:image/...;base64,... */
  dataUrl?: string;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Build an attachment from raw bytes; throws a user-readable Error if unsupported. */
export function fromBytes(name: string, bytes: Uint8Array): Attachment {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mime = IMAGE_MIME[ext];
  if (mime) {
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${name} is larger than 5 MB.`);
    return {
      id: newId(), kind: 'image', name, size: bytes.length,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    };
  }
  if (/\.(mp4|mov|m4v|webm|avi|mkv|wmv|flv)$/i.test(name)) {
    throw new Error(`${name}: videos can't be sent to AI models here yet. Attach a screenshot of the part you mean, or describe it.`);
  }
  if (bytes.subarray(0, 8000).includes(0)) {
    throw new Error(`${name} looks like a binary file (PDF, Word, etc.). Supported: text/code files, images, zip files and folders.`);
  }
  let text = new TextDecoder().decode(bytes);
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + `\n… [truncated, file has ${text.length} characters]`;
  }
  return { id: newId(), kind: 'text', name, size: bytes.length, text };
}

export async function fromUri(uri: vscode.Uri): Promise<Attachment> {
  const name = vscode.workspace.asRelativePath(uri, false);
  if (/\.zip$/i.test(name) && uri.scheme === 'file') return fromZip(uri.fsPath, basename(name));
  // Prefer the editor's (possibly unsaved) text when the file is open.
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (doc && !IMAGE_MIME[name.split('.').pop()?.toLowerCase() ?? '']) {
    const text = doc.getText();
    return { id: newId(), kind: 'text', name, size: text.length, text: text.slice(0, MAX_TEXT_CHARS) };
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) return fromFolder(uri.fsPath, name);
  return fromBytes(name, await vscode.workspace.fs.readFile(uri));
}

export function fromEditor(editor: vscode.TextEditor, selectionOnly: boolean): Attachment {
  const doc = editor.document;
  const name = vscode.workspace.asRelativePath(doc.uri, false);
  const useSel = selectionOnly && !editor.selection.isEmpty;
  const text = useSel ? doc.getText(editor.selection) : doc.getText();
  const label = useSel
    ? `${name}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`
    : name;
  return { id: newId(), kind: 'text', name: label, size: text.length, text: text.slice(0, MAX_TEXT_CHARS) };
}

// ---------- folders & zips ----------

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'target', '.next', '.cache', '.idea', '.vscode', 'coverage', '__MACOSX']);
const SKIP_FILES = /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|7z|rar|mp[34]|mov|wav|woff2?|ttf|otf|exe|dll|so|dylib|bin|lock|pyc|class|jar|DS_Store)$|^\.env(\.|$)|package-lock\.json$/i;

/** Folder budget: characters of file contents to include. */
function folderBudget(): number {
  return vscode.workspace.getConfiguration('jarvis').get<number>('maxFolderChars', 60000);
}

export async function walk(root: string, rel = '', out: string[] = [], limit = 3000): Promise<string[]> {
  if (out.length >= limit) return out;
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= limit) break;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, r, out, limit);
    } else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Tree listing plus the contents of text files, up to the folder budget. */
export async function fromFolder(dir: string, displayName: string): Promise<Attachment> {
  const files = await walk(dir);
  const budget = folderBudget();
  const parts: string[] = [];
  let used = 0, included = 0, skipped = 0;
  for (const f of files) {
    if (SKIP_FILES.test(f)) { skipped++; continue; }
    let buf: Buffer;
    try {
      const st = await fs.stat(path.join(dir, f));
      if (st.size > 100_000) { skipped++; continue; }
      buf = await fs.readFile(path.join(dir, f));
    } catch { skipped++; continue; }
    if (buf.subarray(0, 8000).includes(0)) { skipped++; continue; }
    const text = buf.toString('utf8');
    if (used + text.length > budget) { skipped++; continue; }
    const lang = f.split('.').pop() ?? '';
    parts.push(`--- ${f} ---\n\`\`\`${lang}\n${text}\n\`\`\``);
    used += text.length;
    included++;
  }
  const tree = files.slice(0, 500).join('\n') + (files.length > 500 ? `\n… and ${files.length - 500} more` : '');
  const name = displayName.replace(/\/?$/, '/');
  const text = [
    `Folder ${name} — ${files.length} files (${included} included below${skipped ? `, ${skipped} skipped: binary, large or over the size budget` : ''}).`,
    ...parts,
    `File tree of ${name}:\n${tree}`,
  ].join('\n\n');
  return { id: newId(), kind: 'folder', name, size: used, text };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, err => (err ? reject(err) : resolve())));
}

/** Extract a zip to a temp folder and attach it like a folder. */
export async function fromZip(zipPath: string, displayName: string): Promise<Attachment> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-zip-'));
  try {
    try {
      await run('tar', ['-xf', zipPath, '-C', dir]);        // bsdtar: macOS, Windows 10+
    } catch {
      await run('unzip', ['-q', '-o', zipPath, '-d', dir]);  // Linux
    }
    const a = await fromFolder(dir, displayName);
    return { ...a, name: displayName };
  } catch (e: any) {
    throw new Error(`Could not open ${displayName}: ${e?.message ?? e}`);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fromZipBytes(name: string, base64: string): Promise<Attachment> {
  const tmp = path.join(os.tmpdir(), `jarvis-${newId()}.zip`);
  await fs.writeFile(tmp, Buffer.from(base64, 'base64'));
  try { return await fromZip(tmp, name); } finally { fs.rm(tmp, { force: true }).catch(() => {}); }
}

/** One attached file, clearly delimited so the model knows it is file content. */
export function textBlock(a: Attachment): string {
  if (a.kind === 'folder') return `--- Attached ${a.name.endsWith('.zip') ? 'zip' : 'folder'}: ${a.name} ---\n${a.text}\n--- End of ${a.name} ---`;
  const lang = a.name.split('.').pop()?.split(':')[0] ?? '';
  return `--- Attached file: ${a.name} ---\n\`\`\`${lang}\n${a.text}\n\`\`\`\n--- End of ${a.name} ---`;
}

/** The user's turn: attached files first, then the question, with explicit framing. */
export function composeUserText(question: string, attachments: Attachment[] = []): string {
  const files = attachments.filter(a => a.kind === 'text' || a.kind === 'folder');
  const images = attachments.filter(a => a.kind === 'image');
  if (!files.length && !images.length) return question;
  const names = [...files, ...images].map(a => a.name).join(', ');
  const parts = [`I have attached ${files.length + images.length} file(s): ${names}. Read them carefully and use their contents to answer.`];
  parts.push(...files.map(textBlock));
  parts.push(`My question: ${question || (files.length ? 'Summarize what these files contain and what they do.' : 'Describe this image.')}`);
  return parts.join('\n\n');
}
