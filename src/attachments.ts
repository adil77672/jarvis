// Files and images attached to a chat message.
import * as vscode from 'vscode';

export interface Attachment {
  id: string;
  kind: 'text' | 'image';
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
  if (bytes.subarray(0, 8000).includes(0)) {
    throw new Error(`${name} looks like a binary file (PDF, zip, etc.). Only text/code files and images are supported.`);
  }
  let text = new TextDecoder().decode(bytes);
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + `\n… [truncated, file has ${text.length} characters]`;
  }
  return { id: newId(), kind: 'text', name, size: bytes.length, text };
}

export async function fromUri(uri: vscode.Uri): Promise<Attachment> {
  const name = vscode.workspace.asRelativePath(uri, false);
  // Prefer the editor's (possibly unsaved) text when the file is open.
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (doc && !IMAGE_MIME[name.split('.').pop()?.toLowerCase() ?? '']) {
    const text = doc.getText();
    return { id: newId(), kind: 'text', name, size: text.length, text: text.slice(0, MAX_TEXT_CHARS) };
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) throw new Error(`${name} is a folder; attach files instead.`);
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

/** Text that goes before the user's question, e.g. fenced file contents. */
export function textBlock(a: Attachment): string {
  const lang = a.name.split('.').pop()?.split(':')[0] ?? '';
  return `File: ${a.name}\n\`\`\`${lang}\n${a.text}\n\`\`\``;
}
