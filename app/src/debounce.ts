// A trailing debouncer that can also be flushed immediately (used to force
// a final recovery/state save on shutdown instead of waiting out the timer).

export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void | Promise<void>) | null = null;

  constructor(private readonly delayMs: number) {}

  schedule(fn: () => void | Promise<void>): void {
    this.pending = fn;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = this.pending;
      this.pending = null;
      void run?.();
    }, this.delayMs);
  }

  /** Run the pending call now, if any, and cancel the timer. Returns a
   * promise that resolves once that call's own work (e.g. the underlying
   * disk write) has actually finished, not just been kicked off — callers
   * that need the write to be durable before proceeding (e.g. on app quit)
   * must await this rather than treating a call to flush() as synchronous. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.pending;
    this.pending = null;
    await run?.();
  }
}
