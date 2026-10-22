export class Sfx {
  private ctx: AudioContext | null = null;
  enabled = true;
  private lastShot = 0;

  constructor() {
    try {
      this.enabled = localStorage.getItem('soldadinhos-sfx') !== '0';
    } catch {
      this.enabled = true;
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem('soldadinhos-sfx', this.enabled ? '1' : '0');
    } catch {
      /* ignore */
    }
    return this.enabled;
  }

  private ac(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  blip() {
    const ctx = this.ac();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 540;
    o.type = 'triangle';
    g.gain.setValueAtTime(0.04, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.08);
  }

  shot() {
    const ctx = this.ac();
    if (!ctx) return;
    if (ctx.currentTime - this.lastShot < 0.04) return;
    this.lastShot = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(180, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.06);
    g.gain.setValueAtTime(0.03, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.08);
  }

  boom() {
    const ctx = this.ac();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.28);
    g.gain.setValueAtTime(0.05, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.32);
  }
}
