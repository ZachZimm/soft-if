export class Ticks {
  private value = 0;
  private newest = new Map<string, number>();
  next(): number {
    return ++this.value;
  }
  begin(name: string, tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw new Error("tick must be a nonnegative safe integer");
    this.value = Math.max(this.value, tick);
    this.newest.set(name, Math.max(tick, this.newest.get(name) ?? -1));
  }
  stale(name: string, tick: number): boolean {
    return tick < (this.newest.get(name) ?? tick);
  }
}
