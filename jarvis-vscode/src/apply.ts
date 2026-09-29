// Apply a code block from the chat to a workspace file, after showing a diff.
import * as path from 'path';
import * as vscode from 'vscode';

/** Serves proposed file contents to the diff editor. */
export class ProposalProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'jarvis-proposed';
  private contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(relPath: string, text: string): vscode.Uri {
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.contents.set(key, text);
    return vscode.Uri.from({ scheme: ProposalProvider.scheme, path: '/' + relPath, query: key });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? '';
  }
}

/** Resolve a model-supplied path to a file inside the workspace, or throw. */
export function resolveWorkspacePath(relPath: string): { uri: vscode.Uri; rel: string } {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('Open a folder first so Jarvis knows where to write files.');
  let rel = relPath.trim().replace(/^["'`]|["'`]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
  // Accept paths that start with the workspace folder's own name.
  if (rel.startsWith(ws.name + '/')) rel = rel.slice(ws.name.length + 1);
  rel = path.posix.normalize(rel);
  if (!rel || rel === '.' || path.posix.isAbsolute(rel) || rel.startsWith('../') || rel === '..') {
    throw new Error(`"${relPath}" is outside the open folder; Jarvis only writes inside it.`);
  }
  return { uri: vscode.Uri.joinPath(ws.uri, rel), rel };
}

/** Returns the relative path written, or undefined if the user cancelled. */
export async function applyCode(provider: ProposalProvider, relPath: string, code: string): Promise<string | undefined> {
  const { uri, rel } = resolveWorkspacePath(relPath);
  let existing: vscode.TextDocument | undefined;
  try {
    await vscode.workspace.fs.stat(uri);
    existing = await vscode.workspace.openTextDocument(uri);
  } catch { /* new file */ }

  const text = code.endsWith('\n') ? code : code + '\n';
  const proposed = provider.set(rel, text);
  const left = existing ? uri : provider.set(rel, '');
  await vscode.commands.executeCommand('vscode.diff', left, proposed,
    `${rel} ${existing ? '' : '(new file) '}↔ Jarvis proposal`, { preview: true });

  let detail = existing
    ? 'The file will be replaced with the version on the right. You can undo with ⌘Z / Ctrl+Z.'
    : 'A new file will be created.';
  if (existing) {
    const oldLines = existing.lineCount;
    const newLines = text.split('\n').length;
    if (oldLines > 20 && newLines < oldLines * 0.5) {
      detail += `\n\n⚠ The proposal has ${newLines} lines but the file has ${oldLines}. It may be only a snippet; check the diff before applying.`;
    }
  }
  const choice = await vscode.window.showInformationMessage(
    `Apply Jarvis's changes to ${rel}?`, { modal: true, detail }, 'Apply');
  if (choice !== 'Apply') return undefined;

  const edit = new vscode.WorkspaceEdit();
  if (existing) {
    const full = new vscode.Range(existing.positionAt(0), existing.positionAt(existing.getText().length));
    edit.replace(uri, full, text);
  } else {
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not write ${rel}.`);
  const doc = await vscode.workspace.openTextDocument(uri);
  await doc.save();
  await vscode.window.showTextDocument(doc, { preview: false });
  return rel;
}
