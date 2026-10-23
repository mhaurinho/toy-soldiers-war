import { createMatch, type MatchOptions } from './world';
import type { Command } from './types';

interface Init extends MatchOptions {
  type: 'init';
  fastForward: number;
}

type Incoming =
  | Init
  | { type: 'command'; command: Command }
  | { type: 'pause'; paused: boolean }
  | { type: 'stop' }
  | { type: 'blast'; x: number; z: number };

let paused = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let match: ReturnType<typeof createMatch> | null = null;

function loop() {
  if (!match) return;
  if (!paused && !match.over) {
    match.step();
    const snapshot = match.snapshot();
    postMessage({ type: 'snapshot', snapshot });
    if (match.over) postMessage({ type: 'over', snapshot });
  }
  timer = setTimeout(loop, 50);
}

self.onmessage = (event: MessageEvent<Incoming>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    if (timer) clearTimeout(timer);
    match = createMatch(msg);
    const ticks = Math.max(0, msg.fastForward | 0);
    for (let i = 0; i < ticks; i++) match.step();
    postMessage({ type: 'ready', seed: msg.seed, hash: match.hash });
    postMessage({ type: 'snapshot', snapshot: match.snapshot() });
    if (match.over) postMessage({ type: 'over', snapshot: match.snapshot() });
    loop();
    return;
  }
  if (!match) return;
  if (msg.type === 'command') match.submit(msg.command);
  else if (msg.type === 'blast') {
    match.explode(msg.x, msg.z, 160, 4.2);
    postMessage({ type: 'snapshot', snapshot: match.snapshot() });
  } else if (msg.type === 'pause') paused = msg.paused;
  else if (msg.type === 'stop') {
    if (timer) clearTimeout(timer);
    match = null;
  }
};
