// Self-update from GitHub Releases: checks the latest release and installs its .vsix.
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSetting } from './settings';

const LAST_CHECK = 'jarvis.lastUpdateCheck';

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Check GitHub for a newer release. `silent` = automatic check (no "up to date" messages). */
export async function checkForUpdates(ctx: vscode.ExtensionContext, silent: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('jarvis');
  const repo = cfg.get<string>('updateRepo', '').trim();
  if (!repo) { if (!silent) vscode.window.showInformationMessage('Set "jarvis.updateRepo" (owner/repo) to enable updates from GitHub.'); return; }
  if (silent) {
    if (!getSetting<boolean>('autoUpdate', true)) return;
    const last = ctx.globalState.get<number>(LAST_CHECK, 0);
    if (Date.now() - last < 12 * 3600_000) return;
  }
  await ctx.globalState.update(LAST_CHECK, Date.now());

  let release: any;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jarvis-ai-chat' },
    });
    if (!res.ok) {
      if (!silent) vscode.window.showWarningMessage(res.status === 404
        ? `No public releases found at github.com/${repo}. Updates only work from a public repository.`
        : `Update check failed (${res.status}).`);
      return;
    }
    release = await res.json();
  } catch (e: any) {
    if (!silent) vscode.window.showWarningMessage(`Update check failed: ${e?.message ?? e}`);
    return;
  }

  const current = String(ctx.extension.packageJSON.version ?? '0.0.0');
  const latest = String(release.tag_name ?? '').replace(/^v/, '');
  const asset = (release.assets ?? []).find((a: any) => String(a.name).endsWith('.vsix'));
  if (!latest || !newer(latest, current) || !asset) {
    if (!silent) vscode.window.showInformationMessage(`Jarvis AI Chat & Code Assistant is up to date (v${current}).`);
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    `Jarvis AI Chat & Code Assistant ${latest} is available (you have ${current}).`, 'Update now', 'Release notes', 'Later');
  if (pick === 'Release notes') { vscode.env.openExternal(vscode.Uri.parse(release.html_url)); return; }
  if (pick !== 'Update now') return;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating Jarvis AI Chat & Code Assistant to ${latest}…` }, async () => {
    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'jarvis-ai-chat' } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const file = path.join(os.tmpdir(), asset.name);
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
  }).then(async () => {
    const r = await vscode.window.showInformationMessage(`Jarvis AI Chat & Code Assistant ${latest} installed. Reload to use it.`, 'Reload now');
    if (r) vscode.commands.executeCommand('workbench.action.reloadWindow');
  }, (e: any) => vscode.window.showErrorMessage(`Update failed: ${e?.message ?? e}`));
}
