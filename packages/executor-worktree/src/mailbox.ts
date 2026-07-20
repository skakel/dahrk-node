/**
 * A minimal push/close async queue. Human turns are pushed in; a consumer (the Claude SDK's
 * `query()`, the edge's per-job turn feed, the elicit router's conversation channel) drains it as an
 * AsyncIterable. Ported from the S2 spike.
 */
export class ManagedMailbox<T> implements AsyncIterable<T> {
  private readonly q: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.q.push(value);
  }

  end(): void {
    this.done = true;
    let w: ((r: IteratorResult<T>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.q.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
