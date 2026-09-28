import { advanceTetris, tetrisGame } from '../games/tetris.js';
import type { ClientMessage, TetrisPlayerState, TetrisState } from '../shared/types.js';

type Action = Extract<ClientMessage, { type: `tetris.${string}` }>;
type Authority = { player: TetrisPlayerState; nextFallAt: number; serverNow: number; acknowledged: number };
type Pending = Action & { clientSequence: number; clientTime: number };

export class VersusPrediction {
  private state?: TetrisState;
  private pending: Pending[] = [];
  private nextSequence = 1;
  private clockOffset = 0;
  private offlineAt?: number;
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly id: string, private readonly currentRoom: () => { state?: TetrisState; status?: string } | undefined,
    private readonly paint: () => void, private readonly send: (message: Pending) => void) {
    this.timer = setInterval(() => this.advance(), 16);
  }

  get active() { return Boolean(this.state) && this.currentRoom()?.status === 'playing' && (this.offlineAt === undefined || Date.now() - this.offlineAt < 30_000); }
  get pendingCount() { return this.pending.length; }
  get lastSequence() { return this.nextSequence - 1; }

  connection(open: boolean) {
    if (open) { this.offlineAt = undefined; return; }
    this.offlineAt ??= Date.now();
  }

  sync(authority: Authority, visible?: TetrisState) {
    if (!authority?.player) return;
    this.clockOffset = authority.serverNow - Date.now();
    const room = this.currentRoom();
    const source = visible ?? room?.state;
    if (!source) return;
    this.pending = this.pending.filter(item => item.clientSequence > authority.acknowledged);
    this.nextSequence = Math.max(this.nextSequence, authority.acknowledged + 1);
    this.state = {
      ...structuredClone(source),
      players: { ...structuredClone(source.players), [this.id]: structuredClone(authority.player) },
      nextFallAt: authority.nextFallAt,
    };
    for (const item of this.pending) this.apply(item);
    this.advance(true);
  }

  queue(message: Action) {
    if (!this.active || this.pending.length >= 1000) return false;
    const item = { ...message, clientSequence: this.nextSequence++, clientTime: Date.now() + this.clockOffset } as Pending;
    this.pending.push(item);
    this.apply(item);
    this.paint();
    this.send(item);
    return true;
  }

  resend(expected = 1) { for (const item of this.pending) if (item.clientSequence >= expected) this.send(item); }

  private apply(item: Pending) {
    if (!this.state) return;
    const now = Math.max(item.clientTime, this.state.nextFallAt - 30_000);
    advanceTetris(this.state, now, this.id);
    try { tetrisGame.apply(this.state, { actorId: this.id, hostId: this.id, players: [], message: item, now }); }
    catch { /* The server remains authoritative after a stale local action. */ }
  }

  private advance(force = false) {
    if (!this.active || !this.state) return;
    const changed = advanceTetris(this.state, Date.now() + this.clockOffset, this.id);
    if (changed || force) this.paint();
  }

  player() { return this.state?.players[this.id]; }
  close() { clearInterval(this.timer); this.state = undefined; this.pending = []; }
}
