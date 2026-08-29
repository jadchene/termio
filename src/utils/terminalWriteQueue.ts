const DEFAULT_MAX_QUEUED_CHARS = 16 * 1024 * 1024;
const TRUNCATION_NOTICE = '\r\n\x1b[33m[终端渲染积压超过 16 MiB，已丢弃最旧内容]\x1b[0m\r\n';

export class TerminalWriteQueue {
  private readonly chunks: string[] = [];
  private head = 0;
  private headOffset = 0;
  private queuedChars = 0;
  private truncated = false;

  public constructor(private readonly maxQueuedChars = DEFAULT_MAX_QUEUED_CHARS) {}

  public append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.queuedChars += data.length;
    let overflow = this.queuedChars - this.maxQueuedChars;
    while (overflow > 0 && this.head < this.chunks.length) {
      const available = this.chunks[this.head].length - this.headOffset;
      if (overflow >= available) {
        this.queuedChars -= available;
        overflow -= available;
        this.head += 1;
        this.headOffset = 0;
      } else {
        this.headOffset += overflow;
        this.queuedChars -= overflow;
        overflow = 0;
      }
      this.truncated = true;
    }
    this.compact();
  }

  public take(maxChars: number): string {
    let remaining = Math.max(1, maxChars);
    let result = '';
    if (this.truncated) {
      result = TRUNCATION_NOTICE;
      remaining = Math.max(1, remaining - result.length);
      this.truncated = false;
    }
    while (remaining > 0 && this.head < this.chunks.length) {
      const chunk = this.chunks[this.head];
      const available = chunk.length - this.headOffset;
      const size = Math.min(remaining, available);
      result += chunk.slice(this.headOffset, this.headOffset + size);
      this.headOffset += size;
      this.queuedChars -= size;
      remaining -= size;
      if (this.headOffset === chunk.length) {
        this.head += 1;
        this.headOffset = 0;
      }
    }
    this.compact();
    return result;
  }

  public get length(): number {
    return this.queuedChars;
  }

  private compact(): void {
    if (this.head === 0 || (this.head < 128 && this.head * 2 < this.chunks.length)) return;
    this.chunks.splice(0, this.head);
    this.head = 0;
  }
}
