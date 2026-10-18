import type {
  LogSink,
  LogEvent,
  DecisionRecord,
  BranchRecord,
  OutcomeRecord,
  PolicyChange,
} from "../types.js";
export class RingLog implements LogSink {
  private entries: LogEvent[];
  private cursor = 0;
  private count = 0;
  private listeners = new Set<(e: LogEvent) => void>();
  constructor(readonly capacity = 2000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000)
      throw new Error("Invalid ring capacity");
    this.entries = new Array(capacity);
  }
  private push(e: LogEvent) {
    const copy = structuredClone(e);
    this.entries[this.cursor] = copy;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    for (const fn of this.listeners) fn(structuredClone(copy));
  }
  decision(data: DecisionRecord) {
    this.push({ type: "decision", data });
  }
  branch(data: BranchRecord) {
    this.push({ type: "branch", data });
  }
  outcome(data: OutcomeRecord) {
    this.push({ type: "outcome", data });
  }
  policy(data: PolicyChange) {
    this.push({ type: "policy", data });
  }
  events(): LogEvent[] {
    return Array.from({ length: this.count }, (_, i) =>
      structuredClone(
        this.entries[
          (this.cursor - this.count + i + this.capacity) % this.capacity
        ]!,
      ),
    );
  }
  decisions(): DecisionRecord[] {
    return this.events()
      .filter(
        (e): e is Extract<LogEvent, { type: "decision" }> =>
          e.type === "decision",
      )
      .map((e) => e.data);
  }
  get(id: string) {
    return this.decisions().find((d) => d.id === id);
  }
  subscribe(fn: (e: LogEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
