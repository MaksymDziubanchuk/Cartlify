// What one socket may send: every frame is read and parsed, a message is a write to the database
// and a turn of the paid model of the bot, a typing event goes to every socket of the chat. Over a
// limit the socket is closed (1008 TOO_MANY_MESSAGES); the frame itself is at most 16 KB, ws
// closes a bigger one before the app reads it (the options of @fastify/websocket in src/app.ts)

type Limit = { max: number; windowMs: number };

// a start and a stop of typing each once a second: a person who types a letter and stops sends
// both within a second, one count for the two closed the socket
const LIMITS = {
  frames: { max: 30, windowMs: 10_000 },
  messages: { max: 5, windowMs: 10_000 },
  typingStart: { max: 1, windowMs: 1_000 },
  typingStop: { max: 1, windowMs: 1_000 },
} as const satisfies Record<string, Limit>;

export type SocketLimitKind = keyof typeof LIMITS;

// the limit an event of the client counts toward besides the frames, if any
export function limitKindOf(type: string): SocketLimitKind | null {
  if (type === 'message:send') return 'messages';
  if (type === 'typing:start') return 'typingStart';
  if (type === 'typing:stop') return 'typingStop';
  return null;
}

// the counts of one socket, each in a window of fixed length
export class SocketLimits {
  private windows = new Map<SocketLimitKind, { count: number; resetAt: number }>();

  // counts one more event of the kind; false when it is over the limit
  allow(kind: SocketLimitKind, now = Date.now()): boolean {
    let window = this.windows.get(kind);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + LIMITS[kind].windowMs };
      this.windows.set(kind, window);
    }

    window.count += 1;
    return window.count <= LIMITS[kind].max;
  }
}
