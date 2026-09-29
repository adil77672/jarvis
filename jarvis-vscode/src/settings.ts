// Jarvis settings with a fallback: if VS Code refuses to write a setting (e.g. its schema
// isn't registered yet because the editor wasn't fully restarted after an update), keep the
// value in the extension's own storage instead of failing.
import * as vscode from 'vscode';

const OVERRIDES = 'jarvis.settingOverrides';
let ctx: vscode.ExtensionContext | undefined;

export function initSettings(context: vscode.ExtensionContext): void {
  ctx = context;
}

function overrides(): Record<string, unknown> {
  return ctx?.globalState.get<Record<string, unknown>>(OVERRIDES, {}) ?? {};
}

export function getSetting<T>(key: string, fallback: T): T {
  const o = overrides();
  if (key in o) return o[key] as T;
  return vscode.workspace.getConfiguration('jarvis').get<T>(key, fallback);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const o = { ...overrides() };
  try {
    await vscode.workspace.getConfiguration('jarvis').update(key, value, vscode.ConfigurationTarget.Global);
    delete o[key];
  } catch {
    o[key] = value;
  }
  await ctx?.globalState.update(OVERRIDES, o);
}

/** True when the running editor doesn't know this version's settings (needs a full restart). */
export function schemaIsStale(): boolean {
  return vscode.workspace.getConfiguration('jarvis').inspect('maxAgentSteps') === undefined;
}
