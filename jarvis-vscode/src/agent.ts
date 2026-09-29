// Agent mode: actions the model asks for (write files, run commands) and running them.
import { exec, execFile } from 'child_process';
import * as vscode from 'vscode';

export type Action =
  | { kind: 'write'; path: string; code: string }
  | { kind: 'run'; command: string };

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

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Extra system-prompt text that teaches the model how to act in the project. */
export const AGENT_PROMPT = [
  'AGENT MODE is on: you can work directly in the user\'s project.',
  '- To create or change a file, output its COMPLETE new content in a fenced block whose info string is the language followed by path=<path relative to the project root>, e.g. ```ts path=src/utils/math.ts . Jarvis asks the user for permission, then writes it.',
  '- To run a shell command in the project folder, put it alone in a fenced block with the info string `bash run`, e.g.\n```bash run\nnpm test\n```\nJarvis asks for permission, runs it, and sends you the output so you can continue.',
  '- Do one logical step at a time. After commands run you will receive their output.',
  '- If you need information only the user has, ask a short question instead of guessing.',
].join('\n');
