export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
