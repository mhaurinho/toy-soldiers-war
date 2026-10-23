export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
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

  private burst(ctx: AudioContext): AudioBufferSourceNode {
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 0.45);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let s = 1;
      for (let i = 0; i < len; i++) {
        s = (s * 16807) % 2147483647;
        data[i] = (s / 2147483647) * 2 - 1;
      }
      this.noise = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    return src;
  }

  shot(kind: 'bullet' | 'shell' | 'rocket' | 'missile' | 'bomb' = 'bullet') {
    const ctx = this.ac();
    if (!ctx) return;
    if (ctx.currentTime - this.lastShot < 0.035) return;
    this.lastShot = ctx.currentTime;
    const src = this.burst(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = kind === 'bullet' ? 'highpass' : 'bandpass';
    filter.frequency.value = kind === 'shell' || kind === 'bomb' ? 240 : kind === 'rocket' || kind === 'missile' ? 520 : 1800;
    const g = ctx.createGain();
    const loud = kind === 'bullet' ? 0.045 : 0.07;
    g.gain.setValueAtTime(loud, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (kind === 'bullet' ? 0.05 : 0.12));
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start();
    src.stop(ctx.currentTime + 0.16);
  }

  boom(size = 1) {
    const ctx = this.ac();
    if (!ctx) return;
    const src = this.burst(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(180 + size * 40, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.16, 0.05 + size * 0.02), ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.34);
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start();
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(70 + size * 8, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(28, ctx.currentTime + 0.3);
    og.gain.setValueAtTime(Math.min(0.12, 0.03 + size * 0.015), ctx.currentTime);
    og.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.32);
    o.connect(og).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.34);
    src.stop(ctx.currentTime + 0.36);
  }

  melt() {
    const ctx = this.ac();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(320, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.22);
    g.gain.setValueAtTime(0.04, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.24);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.26);
  }
}
