/**
 * Lockstep boundary.
 *
 * The simulation in `src/sim/world.ts` is a pure function of (seed, spawn specs,
 * ordered commands). Peers never send positions. A future Colyseus room — or a
 * WebRTC host — only has to:
 *
 * 1. Agree on `COMMAND_VERSION`, the terrain seed and both SpawnSpec lists.
 * 2. Broadcast `Command` messages. Each command already carries the tick it
 *    should apply on (`INPUT_DELAY_TICKS` ahead of the sender's last snapshot).
 * 3. Compare `Snapshot.hash` every few ticks and request a full snapshot if a
 *    client drifts.
 *
 * Pathfinding runs inside the sim, not on a client's wall clock, so a worker
 * thread on each peer reproduces the same paths. The worker (`src/sim/worker.ts`)
 * is the local stand-in for that remote host.
 */
export { COMMAND_VERSION, INPUT_DELAY_TICKS } from '../sim/constants';
export type { Command, Snapshot } from '../sim/types';
