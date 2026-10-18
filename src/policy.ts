import {
  finite,
  isRecord,
  type Answer,
  type Band,
  type BranchPolicy,
  type PolicyChange,
  type PolicyData,
  type PolicyInput,
} from "./types.js";
export class Policy {
  protected data: PolicyData;
  private listeners = new Set<(c: PolicyChange) => void>();
  private errors = new Set<(e: Error) => void>();
  constructor(input: PolicyInput = {}) {
    this.data = Policy.validate(input);
  }
  static validate(input: unknown): PolicyData {
    if (!isRecord(input)) throw new Error("Policy must be an object");
    for (const k of Object.keys(input))
      if (!["bands", "branches", "allowEmulated"].includes(k))
        throw new Error(`Unknown policy field ${k}`);
    if (input.bands !== undefined && !isRecord(input.bands))
      throw new Error("bands must be an object");
    const bands = { act: 0.85, confirm: 0.6, ...(input.bands as object) };
    for (const k of Object.keys(bands))
      if (!["act", "confirm"].includes(k)) throw new Error(`Unknown band ${k}`);
    finite(bands.act, "act", 0, 1);
    finite(bands.confirm, "confirm", 0, 1);
    if (bands.act < bands.confirm) throw new Error("act must be >= confirm");
    if (input.branches !== undefined && !isRecord(input.branches))
      throw new Error("branches must be an object");
    const branches: Record<string, BranchPolicy> = Object.create(null);
    for (const [name, b] of Object.entries(input.branches ?? {})) {
      if (!name || !isRecord(b)) throw new Error("Invalid branch policy");
      for (const [k, v] of Object.entries(b)) {
        if (k === "timeoutMs") finite(v, `${name}.timeoutMs`, 1, 300_000);
        else if (["threshold", "act", "confirm"].includes(k))
          finite(v, `${name}.${k}`, 0, 1);
        else if (k === "fallback") {
          if (
            !["boolean", "string", "number"].includes(typeof v) ||
            (typeof v === "number" && !Number.isFinite(v))
          )
            throw new Error("Invalid fallback");
        } else throw new Error(`Unknown branch setting ${k}`);
      }
      if (
        ((b.act ?? bands.act) as number) <
        ((b.confirm ?? bands.confirm) as number)
      )
        throw new Error("branch act must be >= confirm");
      branches[name] = { ...b };
    }
    if (
      input.allowEmulated !== undefined &&
      typeof input.allowEmulated !== "boolean"
    )
      throw new Error("allowEmulated must be boolean");
    return { bands, branches, allowEmulated: input.allowEmulated === true };
  }
  snapshot(): PolicyData {
    return structuredClone(this.data);
  }
  update(patch: PolicyInput): void {
    if (!isRecord(patch)) throw new Error("Policy patch must be an object");
    if (patch.bands !== undefined && !isRecord(patch.bands))
      throw new Error("bands must be an object");
    if (patch.branches !== undefined && !isRecord(patch.branches))
      throw new Error("branches must be an object");
    const before = this.snapshot();
    const branches: Record<string, BranchPolicy> = Object.assign(
      Object.create(null),
      before.branches,
    );
    for (const [name, branch] of Object.entries(patch.branches ?? {})) {
      if (!isRecord(branch)) throw new Error("Invalid branch policy");
      branches[name] = { ...before.branches[name], ...branch };
    }
    const next = Policy.validate({
      ...before,
      ...patch,
      bands: { ...before.bands, ...patch.bands },
      branches,
    });
    this.data = next;
    const names = Object.keys(patch.branches ?? {});
    const branch =
      names.length === 1 && !patch.bands && patch.allowEmulated === undefined
        ? names[0]!
        : "*";
    const c = {
      ts: Date.now(),
      branch,
      before: branch === "*" ? before : (before.branches[branch] ?? null),
      after: branch === "*" ? this.snapshot() : this.data.branches[branch],
      policy: this.snapshot(),
    };
    for (const fn of this.listeners) fn(c);
  }
  replace(input: PolicyInput): void {
    const next = Policy.validate(input);
    const before = this.snapshot();
    this.data = next;
    const c = {
      ts: Date.now(),
      branch: "*",
      before,
      after: this.snapshot(),
      policy: this.snapshot(),
    };
    for (const fn of this.listeners) fn(c);
  }
  branch(name?: string): BranchPolicy {
    return { ...(name ? this.data.branches[name] : {}) };
  }
  band(answer: Answer, branch?: string): Band {
    if (answer.fallback) return "fallback";
    const b = this.branch(branch);
    const p = answer.confidence;
    let band: Band =
      p >= (b.act ?? this.data.bands.act)
        ? "act"
        : p >= (b.confirm ?? this.data.bands.confirm)
          ? "confirm"
          : "fallback";
    if (answer.emulated && !this.data.allowEmulated && band === "act")
      band = "confirm";
    return band;
  }
  threshold(branch?: string): number {
    return (
      this.branch(branch).threshold ??
      this.branch(branch).act ??
      this.data.bands.act
    );
  }
  subscribe(fn: (c: PolicyChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onError(fn: (e: Error) => void): () => void {
    this.errors.add(fn);
    return () => this.errors.delete(fn);
  }
  protected report(e: Error): void {
    for (const fn of this.errors) fn(e);
  }
  close(): void {}
}
