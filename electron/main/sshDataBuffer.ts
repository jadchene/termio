// Keep interactive applications (Vim, shells) responsive while still coalescing
// bursts into one renderer IPC message.
const DEFAULT_FLUSH_DELAY_MS = 1;
const DEFAULT_MAX_IPC_CHUNK = 64 * 1024;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_HIGH_WATERMARK = 768 * 1024;
const DEFAULT_LOW_WATERMARK = 256 * 1024;
const TRUNCATION_NOTICE = "\r\n[Termio: terminal output truncated to protect application memory]\r\n";

interface PausableShell {
  pause(): unknown;
  resume(): unknown;
}

interface SshDataBufferOptions {
  send: (connectionId: number, data: string) => void;
  getShell: (connectionId: number) => PausableShell | undefined;
  flushDelayMs?: number;
  maxIpcChunk?: number;
  maxBuffer?: number;
  highWatermark?: number;
  lowWatermark?: number;
}

const safeSliceStart = (text: string, start: number): number => {
  const normalized = Math.max(0, start);
  const code = text.charCodeAt(normalized);
  return code >= 0xdc00 && code <= 0xdfff ? normalized + 1 : normalized;
};

const safeSliceEnd = (text: string, end: number): number => {
  const normalized = Math.min(text.length, end);
  const code = text.charCodeAt(normalized - 1);
  return code >= 0xd800 && code <= 0xdbff ? normalized - 1 : normalized;
};

export class SshDataBuffer {
  private readonly buffers = new Map<number, string>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly paused = new Set<number>();
  private readonly flushDelayMs: number;
  private readonly maxIpcChunk: number;
  private readonly maxBuffer: number;
  private readonly highWatermark: number;
  private readonly lowWatermark: number;

  public constructor(private readonly options: SshDataBufferOptions) {
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.maxIpcChunk = options.maxIpcChunk ?? DEFAULT_MAX_IPC_CHUNK;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.highWatermark = options.highWatermark ?? DEFAULT_HIGH_WATERMARK;
    this.lowWatermark = options.lowWatermark ?? DEFAULT_LOW_WATERMARK;
    if (!(this.lowWatermark < this.highWatermark && this.highWatermark <= this.maxBuffer)) {
      throw new Error('Invalid SSH data buffer watermarks.');
    }
  }

  public enqueue(connectionId: number, data: string): void {
    let next = (this.buffers.get(connectionId) || '') + data;
    if (next.length > this.maxBuffer) {
      const notice = TRUNCATION_NOTICE.slice(0, this.maxBuffer);
      const retainedLength = Math.max(0, this.maxBuffer - notice.length);
      const retainedStart = safeSliceStart(next, next.length - retainedLength);
      next = notice + (retainedLength > 0 ? next.slice(retainedStart) : '');
    }
    this.buffers.set(connectionId, next);
    if (next.length >= this.highWatermark && !this.paused.has(connectionId)) {
      this.options.getShell(connectionId)?.pause();
      this.paused.add(connectionId);
    }
    if (next.length >= this.maxIpcChunk) {
      this.flush(connectionId);
    } else if (!this.timers.has(connectionId)) {
      const timer = setTimeout(() => this.flush(connectionId), this.flushDelayMs);
      this.timers.set(connectionId, timer);
    }
  }

  public flush(connectionId: number, flushAll = false): void {
    const timer = this.timers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(connectionId);
    const data = this.buffers.get(connectionId);
    if (!data) {
      this.resumeIfNeeded(connectionId, 0);
      return;
    }
    if (flushAll) {
      this.buffers.delete(connectionId);
      let start = 0;
      while (start < data.length) {
        let end = safeSliceEnd(data, start + this.maxIpcChunk);
        if (end <= start) end = Math.min(data.length, start + 2);
        this.options.send(connectionId, data.slice(start, end));
        start = end;
      }
      this.resumeIfNeeded(connectionId, 0);
      return;
    }
    let chunkEnd = safeSliceEnd(data, this.maxIpcChunk);
    if (chunkEnd <= 0) chunkEnd = Math.min(data.length, 2);
    const chunk = data.slice(0, chunkEnd);
    const rest = data.slice(chunkEnd);
    if (rest) this.buffers.set(connectionId, rest);
    else this.buffers.delete(connectionId);
    this.options.send(connectionId, chunk);
    this.resumeIfNeeded(connectionId, rest.length);
    if (rest) {
      const nextTimer = setTimeout(() => this.flush(connectionId), 0);
      this.timers.set(connectionId, nextTimer);
    }
  }

  public bufferedLength(connectionId: number): number {
    return this.buffers.get(connectionId)?.length ?? 0;
  }

  private resumeIfNeeded(connectionId: number, bufferedLength: number): void {
    if (bufferedLength > this.lowWatermark || !this.paused.delete(connectionId)) return;
    this.options.getShell(connectionId)?.resume();
  }
}
