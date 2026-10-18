import {
  finite,
  type DecisionRecord,
  type OutcomeRecord,
  type BranchRecord,
} from "./types.js";
export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  confidence: number;
  accuracy: number;
}
export interface CalibrationSummary {
  count: number;
  ece: number;
  bins: ReliabilityBin[];
}
export interface CalibrationReport extends CalibrationSummary {
  branches: Record<string, CalibrationSummary>;
}
export function calibrate(
  decisions: readonly DecisionRecord[],
  outcomes: readonly OutcomeRecord[],
  branches: readonly BranchRecord[] = [],
  options: { branch?: string; bins?: number } = {},
): CalibrationReport {
  const count = options.bins ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 1000)
    throw new Error("bins must be an integer 1..1000");
  const records = new Map(decisions.map((d) => [d.id, d]));
  const linked = new Map<string, BranchRecord[]>();
  for (const b of branches) {
    const rows = linked.get(b.request_id) ?? [];
    rows.push(b);
    linked.set(b.request_id, rows);
  }
  const samples: Record<string, { confidence: number; accepted: number }[]> =
    Object.create(null);
  for (const o of outcomes) {
    const d = records.get(o.request_id);
    if (!d || d.stale || typeof o.payload.accepted !== "boolean") continue;
    const selectedBranch =
      typeof o.payload.branch === "string" ? o.payload.branch : undefined;
    const selectedKey =
      typeof o.payload.key === "string" ? o.payload.key : undefined;
    let candidates = (linked.get(d.id) ?? [])
      .filter(
        (b) =>
          (!selectedBranch || b.branch === selectedBranch) &&
          (!selectedKey || b.key === selectedKey),
      )
      .map((b) => ({ key: b.key, branch: b.branch }));
    if (!candidates.length) {
      const keys = Object.keys(d.answers);
      if (selectedKey && d.answers[selectedKey])
        candidates = [
          { key: selectedKey, branch: selectedBranch ?? selectedKey },
        ];
      else if (keys.length === 1)
        candidates = [{ key: keys[0]!, branch: selectedBranch ?? keys[0]! }];
    }
    const seen = new Set<string>();
    for (const c of candidates) {
      if ((options.branch && c.branch !== options.branch) || seen.has(c.branch))
        continue;
      seen.add(c.branch);
      const a = d.answers[c.key];
      if (!a || a.fallback) continue;
      finite(a.confidence, "confidence", 0, 1);
      (samples[c.branch] ??= []).push({
        confidence: a.confidence,
        accepted: Number(o.payload.accepted),
      });
    }
  }
  const summarize = (
    rows: { confidence: number; accepted: number }[],
  ): CalibrationSummary => {
    const bins: ReliabilityBin[] = Array.from({ length: count }, (_, i) => ({
      lower: i / count,
      upper: (i + 1) / count,
      count: 0,
      confidence: 0,
      accuracy: 0,
    }));
    for (const r of rows) {
      const b = bins[Math.min(count - 1, Math.floor(r.confidence * count))]!;
      b.count++;
      b.confidence += r.confidence;
      b.accuracy += r.accepted;
    }
    let ece = 0;
    for (const b of bins) {
      if (b.count) {
        b.confidence /= b.count;
        b.accuracy /= b.count;
        ece += (b.count / rows.length) * Math.abs(b.confidence - b.accuracy);
      }
    }
    return { count: rows.length, ece, bins };
  };
  return {
    ...summarize(Object.values(samples).flat()),
    branches: Object.fromEntries(
      Object.entries(samples).map(([name, rows]) => [name, summarize(rows)]),
    ),
  };
}
export const calibration = calibrate;
