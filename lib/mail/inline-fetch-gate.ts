/** Browser-side admission gate for one bounded Mail fetch class. */
export class MailFetchGate {
  private active = 0;
  private sequence = 0;
  private scheduled = false;
  private readonly queue: Array<{
    readonly signal: AbortSignal;
    readonly priority: number;
    readonly sequence: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly onAbort: () => void;
  }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("mail fetch limit is invalid");
    }
  }

  async run<T>(
    signal: AbortSignal,
    task: () => Promise<T>,
    priority = 0,
  ): Promise<T> {
    await this.acquire(signal, priority);
    try {
      if (signal.aborted) throw abortError();
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal, priority: number): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (!Number.isFinite(priority)) {
      return Promise.reject(new Error("mail fetch priority is invalid"));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        priority,
        sequence: this.sequence++,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.scheduleDrain();
    });
  }

  private release(): void {
    this.active--;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    this.queue.sort(
      (left, right) =>
        right.priority - left.priority || left.sequence - right.sequence,
    );
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      this.active++;
      waiter.resolve();
    }
  }
}

export const mailContentFetchGate = new MailFetchGate(2);
export const mailCidFetchGate = new MailFetchGate(2);

function abortError(): Error {
  return Object.assign(new Error("mail fetch aborted"), {
    name: "AbortError",
  });
}
