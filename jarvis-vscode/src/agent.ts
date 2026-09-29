// Agent mode: actions the model asks for (write files, run commands) and running them.
import { exec, execFile } from 'child_process';
import * as vscode from 'vscode';

export type Action =
  | { kind: 'write'; path: string; code: string }
  | { kind: 'run'; command: string }
  | { kind: 'read'; paths: string[] }
  | { kind: 'list'; path: string }
  | { kind: 'plan'; items: PlanItem[] };

export interface PlanItem { text: string; done: boolean }

/** Parse "- [ ] step" / "- [x] step" (or numbered) lines. */
export function parsePlan(body: string): PlanItem[] {
  return body.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(?:[-*]|\d+[.)])?\s*\[( |x|X|✓)\]\s*(.+)$/);
    if (m) return { text: m[2].trim(), done: m[1] !== ' ' };
    const plain = l.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    return plain ? { text: plain[1].trim(), done: false } : undefined;
  }).filter((x): x is PlanItem => !!x).slice(0, 20);
}

/** Find ```lang path=…``` file blocks and ```bash run``` command blocks in a reply. */
export function parseActions(reply: string): Action[] {
  const actions: Action[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (let m; (m = re.exec(reply));) {
    const info = m[1].trim();
    const body = m[2].replace(/\n$/, '');
    const path = info.match(/(?:^|\s)(?:path|file|filename)=["'`]?([^\s"'`]+)/i)?.[1];
    if (path) {
      actions.push({ kind: 'write', path, code: body });
      continue;
    }
    if (/^(plan|todo|tasks)$/i.test(info)) {
      const items = parsePlan(body);
      if (items.length) actions.push({ kind: 'plan', items });
      continue;
    }
    if (/^read$/i.test(info)) {
      const paths = body.split('\n').map(l => l.trim().replace(/^[-*]\s+/, '').replace(/^@/, '')).filter(Boolean).slice(0, 10);
      if (paths.length) actions.push({ kind: 'read', paths });
      continue;
    }
    if (/^(list|ls)$/i.test(info)) {
      actions.push({ kind: 'list', path: body.trim().split('\n')[0].replace(/^@/, '') || '.' });
      continue;
    }
    if (/^(?:bash|sh|shell|zsh|console|terminal|powershell|cmd)\s+run\b/i.test(info) || /^run$/i.test(info)) {
      const command = body.split('\n').map(l => l.replace(/^\s*\$\s?/, '')).filter(l => l.trim() && !l.trim().startsWith('#')).join('\n').trim();
      if (command) actions.push({ kind: 'run', command });
    }
  }
  return actions;
}

/** Commands that always need explicit approval, even with "always allow". */
export function isDangerous(command: string): boolean {
  return /\brm\s+(-\w*[rf]\w*\s+)+|\bsudo\b|\bmkfs|\bdd\s+if=|>\s*\/dev\/|\bshutdown\b|\breboot\b|git\s+push\b[^\n]*(--force|-f)\b|git\s+reset\s+--hard|git\s+clean\s+-\w*f|chmod\s+-R\s+777|curl[^|\n]*\|\s*(ba|z)?sh|:\(\)\s*\{/i.test(command);
}

export interface RunResult {
  code: number;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 6000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, 2000) + `\n… [${s.length - 5000} characters cut] …\n` + s.slice(-3000) : s;
}

export function runCommand(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<RunResult> {
  return new Promise(resolve => {
    const child = exec(command, {
      cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === 'win32' ? undefined : (process.env.SHELL || '/bin/sh'),
      env: { ...process.env, CI: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
    }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '');
      const timedOut = !!err && (err as any).killed && (err as any).signal === 'SIGTERM';
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, output: clip(out.trim()), timedOut });
    });
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}

export function runFile(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, output: clip(out), timedOut: false });
    });
  });
}

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\r/g;

/**
 * Run a command in a visible "Jarvis" terminal and capture its output via shell integration
 * (VS Code 1.93+). Returns undefined when shell integration isn't available, so callers can fall back.
 */
export async function runInTerminal(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<RunResult | undefined> {
  const w: any = vscode.window;
  if (typeof w.onDidEndTerminalShellExecution !== 'function') return undefined;
  let term: any = w.terminals.find((t: any) => t.name === 'Jarvis' && t.exitStatus === undefined);
  if (!term) term = w.createTerminal({ name: 'Jarvis', cwd });
  term.show(true);
  const si: any = term.shellIntegration ?? await new Promise(resolve => {
    const d = w.onDidChangeTerminalShellIntegration((e: any) => { if (e.terminal === term) { d.dispose(); resolve(e.shellIntegration); } });
    setTimeout(() => { d.dispose(); resolve(undefined); }, 5000);
  });
  if (!si) return undefined;

  const execution = si.executeCommand(command);
  let exitCode: number | undefined;
  const ended = new Promise<void>(resolve => {
    const d = w.onDidEndTerminalShellExecution((e: any) => {
      if (e.execution === execution) { exitCode = e.exitCode; d.dispose(); resolve(); }
    });
  });
  let out = '';
  let timedOut = false;
  const interrupt = () => term.sendText('\x03', false);
  const timer = setTimeout(() => { timedOut = true; interrupt(); }, timeoutMs);
  signal?.addEventListener('abort', interrupt, { once: true });
  try {
    for await (const data of execution.read()) out += data;
    await Promise.race([ended, new Promise(r => setTimeout(r, 3000))]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', interrupt);
  }
  return { code: exitCode ?? (timedOut ? 124 : 0), output: clip(out.replace(ANSI, '').trim()), timedOut };
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Extra system-prompt text that teaches the model how to act in the project. */
export const AGENT_PROMPT = [
  'AGENT MODE is on: you are a coding agent working directly in the user\'s project, like Cursor or Claude Code.',
  '- When the user asks you to create, build, change, fix, update or write something, DO IT yourself with file blocks. Never tell the user how to do it manually, and never ask them to copy code into files.',
  '- For tasks with several steps, start with a plan: a fenced block with the info string `plan` containing a checklist, e.g.\n```plan\n- [ ] Read the current files\n- [ ] Create index.html\n- [ ] Run the tests\n```\nThen do the steps one or two at a time. After each step output the updated `plan` block with finished steps marked - [x]. Keep going until every step is done.',
  '- To create or change a file, output its COMPLETE new content in a fenced block whose info string is the language followed by path=<path relative to the project root>, e.g. ```ts path=src/utils/math.ts . Jarvis asks the user for permission, then writes it.',
  '- To run a shell command in the project folder, put it alone in a fenced block with the info string `bash run`, e.g.\n```bash run\nnpm test\n```\nJarvis asks for permission, runs it, and sends you the output so you can continue.',
  '- To read project files, list their paths (one per line) in a fenced block with the info string `read`, e.g.\n```read\nsrc/app.ts\npackage.json\n```\nTo see what is in a folder, use a `list` block with the folder path. Jarvis sends you the contents.',
  '- Do one logical step at a time. After reads or commands you will receive the results.',
  '- Do NOT ask which file to use. "This file" / "these files" means the file open in the editor (shown below). Otherwise use a file from the project list, or choose a sensible new path yourself (e.g. docs/FLOW.md) and create it.',
  '- Act first, then say briefly what you did. Only ask a question when the task truly cannot be done without the answer — never ask for details you can reasonably decide yourself.',
].join('\n');
