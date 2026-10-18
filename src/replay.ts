import { SoftIf } from "./softif.js";
import { Policy } from "./policy.js";
import type { Answer, Backend, DecisionRecord, BranchRecord } from "./types.js";
export interface ReplayFlip {
  request_id: string;
  key: string;
  branch?: string;
  before: boolean | string | number | null;
  after: boolean | string | number | null;
}
export interface ReplayReport {
  total: number;
  comparisons: number;
  agreements: number;
  agreementRate: number;
  flips: ReplayFlip[];
  errors: { request_id: string; error: string }[];
}
export async function replay(
  records: readonly DecisionRecord[],
  backend: Backend,
  options: {
    policy?: Policy;
    branches?: readonly BranchRecord[];
    timeoutMs?: number;
  } = {},
): Promise<ReplayReport> {
  const report: ReplayReport = {
    total: records.length,
    comparisons: 0,
    agreements: 0,
    agreementRate: 0,
    flips: [],
    errors: [],
  };
  const policy = options.policy ?? new Policy();
  const soft = new SoftIf({
    backend,
    policy,
    defaultTimeoutMs: options.timeoutMs ?? 10_000,
  });
  const value = (a: Answer) =>
    a.type === "noul"
      ? a.p >= policy.threshold()
      : a.type === "choice"
        ? a.choice
        : Math.round(a.score);
  try {
    for (const record of records) {
      let result;
      try {
        result = await soft.decide(record.state, record.questions);
      } catch (e) {
        report.errors.push({
          request_id: record.id,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (result.error) {
        report.errors.push({ request_id: record.id, error: result.error });
        if (
          Object.keys(record.questions).some(
            (k) => (result[k] as Answer).fallback,
          )
        )
          continue;
      }
      const bs = options.branches?.filter((b) => b.request_id === record.id);
      if (bs?.length) {
        for (const b of bs) {
          const a = result[b.key] as Answer | undefined;
          if (!a) continue;
          const after =
            a.type === "noul"
              ? soft.when(a, b.branch)
              : a.type === "choice"
                ? (soft.pick(a, b.branch) ?? null)
                : a.score;
          report.comparisons++;
          if (b.value === after) report.agreements++;
          else
            report.flips.push({
              request_id: record.id,
              key: b.key,
              branch: b.branch,
              before: b.value,
              after,
            });
        }
      } else
        for (const [key, beforeAnswer] of Object.entries(record.answers)) {
          const a = result[key] as Answer | undefined;
          if (!a) continue;
          const before = value(beforeAnswer),
            after = value(a);
          report.comparisons++;
          if (before === after) report.agreements++;
          else report.flips.push({ request_id: record.id, key, before, after });
        }
    }
  } finally {
    await soft.close();
  }
  report.agreementRate = report.comparisons
    ? report.agreements / report.comparisons
    : 0;
  return report;
}
