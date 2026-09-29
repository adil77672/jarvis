// Voice input: record the microphone with ffmpeg, transcribe with Whisper (Groq or OpenAI).
import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const DICTATION_HINT =
  'Tip: you can also use your computer\'s dictation in the chat box. macOS: press Fn twice (or Edit → Start Dictation). Windows: press Win+H.';

export function hasFfmpeg(): Promise<boolean> {
  return new Promise(resolve => execFile('ffmpeg', ['-version'], err => resolve(!err)));
}

function inputArgs(): string[] | undefined {
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-i', ':0'];
  if (process.platform === 'linux') return ['-f', 'pulse', '-i', 'default'];
  return undefined; // Windows needs a named dshow device; use Win+H dictation instead
}

export class Recorder {
  private proc?: ChildProcess;
  private file?: string;
  private stderr = '';

  get recording(): boolean {
    return !!this.proc;
  }

  async start(): Promise<void> {
    const input = inputArgs();
    if (!input) throw new Error(`Voice recording isn't supported on this OS yet. ${DICTATION_HINT}`);
    if (!(await hasFfmpeg())) throw new Error(`Voice input needs ffmpeg (brew install ffmpeg). ${DICTATION_HINT}`);
    this.file = path.join(os.tmpdir(), `jarvis-voice-${Date.now()}.wav`);
    this.stderr = '';
    this.proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', '16000', '-t', '120', '-y', this.file]);
    this.proc.stderr?.on('data', d => { this.stderr += String(d); });
    this.proc.on('exit', () => { this.proc = undefined; });
  }

  /** Stop recording; returns the WAV file path. */
  async stop(): Promise<string> {
    const proc = this.proc;
    const file = this.file;
    if (!file) throw new Error('Not recording.');
    if (proc) {
      await new Promise<void>(resolve => {
        proc.once('exit', () => resolve());
        proc.stdin?.write('q');
        setTimeout(() => proc.kill('SIGINT'), 1500);
      });
    }
    this.proc = undefined;
    try {
      const st = await fs.stat(file);
      if (st.size < 2000) throw new Error('empty');
    } catch {
      throw new Error(`No audio was recorded. Allow microphone access for your editor in System Settings → Privacy & Security → Microphone. ${this.stderr.trim().slice(0, 200)}`);
    }
    return file;
  }

  /**
   * Hands-free: record until the speaker pauses (~1.2s of silence after speech), then return the WAV path.
   * Returns undefined if nothing was said within the time limit or it was cancelled.
   */
  async recordUntilSilence(maxMs = 30_000): Promise<string | undefined> {
    const input = inputArgs();
    if (!input) throw new Error(`Live voice isn't supported on this OS yet. ${DICTATION_HINT}`);
    if (!(await hasFfmpeg())) throw new Error(`Live voice needs ffmpeg (brew install ffmpeg). ${DICTATION_HINT}`);
    const file = path.join(os.tmpdir(), `jarvis-live-${Date.now()}.wav`);
    this.file = file;
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'info', ...input,
      '-af', 'silencedetect=noise=-35dB:d=1.2', '-ac', '1', '-ar', '16000', '-t', String(Math.ceil(maxMs / 1000)), '-y', file]);
    this.proc = proc;
    let spoke = false;
    let err = '';
    return new Promise(resolve => {
      const stopNow = () => { proc.stdin?.write('q'); setTimeout(() => proc.kill('SIGINT'), 1500); };
      proc.stderr?.on('data', d => {
        const s = String(d);
        err += s;
        if (/silence_end/.test(s)) spoke = true;                 // speech began after initial silence
        const start = s.match(/silence_start:\s*([\d.]+)/);
        // Silence after speech ends the turn. A first silence starting well after 0s means
        // the user started talking immediately, so that also counts as speech.
        if (start && (spoke || Number(start[1]) > 0.8)) { spoke = true; stopNow(); }
      });
      proc.on('exit', async () => {
        if (this.proc === proc) this.proc = undefined;
        try {
          const st = await fs.stat(file);
          resolve(spoke && st.size > 8000 ? file : undefined);
        } catch {
          if (/Permission|not authorized|denied/i.test(err)) this.lastError = 'Microphone access denied. Allow it for your editor in System Settings → Privacy & Security → Microphone.';
          resolve(undefined);
        }
      });
    });
  }

  lastError = '';

  cancel(): void {
    this.proc?.kill('SIGINT');
    this.proc = undefined;
  }
}

export async function transcribe(file: string, provider: 'groq' | 'openai', apiKey: string): Promise<string> {
  const base = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
  const bytes = await fs.readFile(file);
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'voice.wav');
  try {
    const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    const body = await res.text();
    if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
    return String(JSON.parse(body).text ?? '').trim();
  } finally {
    fs.rm(file, { force: true }).catch(() => {});
  }
}
