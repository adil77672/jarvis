// Image generation via Pollinations (free, no key) and saving into the workspace.
import * as vscode from 'vscode';

/**
 * Returns the image prompt if the message asks for an image, else undefined.
 * Accepts "/image …" and natural requests like "generate an image of …" (typos tolerated).
 */
export function parseImageRequest(text: string): string | undefined {
  const t = text.trim();
  const slash = t.match(/^\/(?:image|img|imagine|draw)\b\s*([\s\S]*)$/i);
  if (slash) return slash[1].trim();
  // "draw a dragon"
  const draw = t.match(/^(?:please\s+|pls\s+|can you\s+|could you\s+)*(?:draw|sketch|paint)\s+(?:me\s+)?([\s\S]+)$/i);
  if (draw) return draw[1].trim();
  const verb = String.raw`(?:gen\w*|gn\w*rat\w*|creat\w*|make|design|render)`;
  const noun = String.raw`(?:im\w*g\w*|img|pic\w*|photo\w*|png|jpe?g|drawing|illustration|logo|icon|wallpaper|artwork)`;
  const re = new RegExp(
    String.raw`^(?:please\s+|pls\s+|can you\s+|could you\s+|now\s+)*${verb}\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?${noun}s?\b` +
    String.raw`(?:\s+(?:of|showing|with|for|about|that shows))?[\s:,-]*([\s\S]*)$`,
    'i',
  );
  const m = t.match(re);
  if (m) return m[1].trim();
  // Short "<subject> image" requests, e.g. "flying bird image", "sunset png".
  const tail = t.match(/^([\w\s,'-]{2,60}?)\s+(?:im\w*g\w*|img|pic\w*|photo|png|jpe?g|wallpaper)$/i);
  const notRequest = /^(what|whats|what's|explain|describe|show|where|why|how|is|are|can|could|this|that|the|my|fix|open|read|see|look|check|analy\w*|in|about|which|who|when|does|do|no|any|i)\b/i;
  if (tail && !notRequest.test(tail[1])) return tail[1].trim();
  return undefined;
}

export function slugify(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5);
  return (words.join('-') || 'image').slice(0, 48);
}

export async function fetchImage(
  prompt: string,
  size: string,
  signal: AbortSignal,
  onRetry?: (waitSecs: number, attempt: number) => void,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const [w, h] = (size.match(/^(\d{2,4})x(\d{2,4})$/)?.slice(1) ?? ['1024', '1024']).map(Number);
  // The free tier rate-limits anonymous users (HTTP 402/429); back off and retry.
  const waits = [8, 20];
  for (let attempt = 0; ; attempt++) {
    const seed = Math.floor(Math.random() * 1e9);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&seed=${seed}`;
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      throw new Error(`Could not reach the image service: ${e?.message ?? e}`);
    }
    if (res.ok) {
      const mime = res.headers.get('content-type') ?? 'image/jpeg';
      if (!mime.startsWith('image/')) throw new Error(`Image service returned ${mime} instead of an image.`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
    }
    const busy = res.status === 402 || res.status === 429 || res.status >= 500;
    if (busy && attempt < waits.length) {
      onRetry?.(waits[attempt], attempt + 1);
      await sleep(waits[attempt] * 1000, signal);
      continue;
    }
    if (busy) throw new Error('The free image service is busy right now (it limits requests per minute). Try again in a minute.');
    throw new Error(`Image service error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    }, { once: true });
  });
}

/** Save into <workspace>/<folder>/<name>, or ask where to save when no folder is open. */
export async function saveImage(name: string, bytes: Uint8Array): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.getConfiguration('jarvis').get<string>('imageFolder', '').trim();
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(name), filters: { Images: ['png', 'jpg'] }, saveLabel: 'Save image',
    });
    if (!target) return undefined;
    await vscode.workspace.fs.writeFile(target, bytes);
    return target;
  }
  const dir = folder && folder !== '.' ? vscode.Uri.joinPath(ws.uri, folder) : ws.uri;
  await vscode.workspace.fs.createDirectory(dir);
  let target = vscode.Uri.joinPath(dir, name);
  // Never overwrite an existing file.
  for (let i = 2; await exists(target); i++) {
    target = vscode.Uri.joinPath(dir, name.replace(/(\.\w+)$/, `-${i}$1`));
  }
  await vscode.workspace.fs.writeFile(target, bytes);
  return target;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}
