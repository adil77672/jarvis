// Text-to-speech using the operating system's built-in voice (no API needed).
import { ChildProcess, spawn } from 'child_process';

/** Turn Markdown into something pleasant to listen to. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code shown in the chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

export class Speaker {
  private proc?: ChildProcess;

  get speaking(): boolean {
    return !!this.proc;
  }

  /** Speak text; resolves when finished or stopped. */
  speak(markdown: string): Promise<void> {
    this.stop();
    const text = speakable(markdown);
    if (!text) return Promise.resolve();
    let proc: ChildProcess;
    if (process.platform === 'darwin') {
      proc = spawn('say', ['-r', '195', text]);
    } else if (process.platform === 'win32') {
      proc = spawn('powershell', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())']);
      proc.stdin?.end(text);
    } else {
      proc = spawn('spd-say', ['-w', text]);
      proc.on('error', () => { this.proc = spawn('espeak', [text]); });
    }
    this.proc = proc;
    return new Promise(resolve => {
      const done = () => { if (this.proc === proc) this.proc = undefined; resolve(); };
      proc.on('exit', done);
      proc.on('error', done);
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}
