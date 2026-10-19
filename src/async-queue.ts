interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** A small single-consumer asynchronous queue with explicit failure semantics. */
export class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private closed = false;
  private failure: unknown;

  public constructor(private readonly maximumSize = Number.POSITIVE_INFINITY) {}

  public push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(value);
      return;
    }

    if (this.values.length >= this.maximumSize) {
      throw new RangeError(`asynchronous queue exceeded its ${this.maximumSize} item limit`);
    }
    this.values.push(value);
  }

  public tryTake(): T | undefined {
    return this.values.shift();
  }

  public take(): Promise<T> {
    const value = this.tryTake();
    if (value !== undefined) {
      return Promise.resolve(value);
    }
    if (this.closed) {
      return Promise.reject(this.failure ?? new Error("asynchronous queue is closed"));
    }

    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  public close(failure?: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = failure;
    if (this.values.length > 0) {
      return;
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(failure ?? new Error("asynchronous queue is closed"));
    }
  }
}
