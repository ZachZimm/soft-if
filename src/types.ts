export type Band = "act" | "confirm" | "fallback";
export type NoulQuestion = { type: "noul"; instructions: string };
export type ChoiceQuestion<K extends string = string> = {
  type: "choice";
  instructions: string;
  criteria: Record<K, string>;
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: readonly string[];
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;
export interface AnswerBase {
  confidence: number;
  probabilities: Record<string, number>;
  emulated?: boolean;
  fallback?: boolean;
  band?: Band;
  branch?: string;
}
export interface NoulAnswer extends AnswerBase {
  type: "noul";
  p: number;
}
export interface ChoiceAnswer<K extends string = string> extends AnswerBase {
  type: "choice";
  choice: K;
}
export interface ScoreAnswer extends AnswerBase {
  type: "score";
  score: number;
  legend?: Record<string, string>;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type AnswerFor<Q extends Question> =
  Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends NoulQuestion
      ? NoulAnswer
      : ScoreAnswer;
export type AnswersFor<Q extends Questions> = {
  [K in keyof Q]: AnswerFor<Q[K]>;
};
export interface WireRequest {
  model?: string;
  state: string;
  questions: Questions;
  images?: string[];
}
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
}
export interface TierAttempt {
  backend: string;
  tier: number;
  latency_ms: number;
  error?: string;
}
export interface WireResponse {
  answers: Record<string, Answer>;
  usage?: Usage;
  latency_ms?: number;
  backend?: string;
  tier?: number;
  emulated?: boolean;
  attempts?: TierAttempt[];
  error?: string;
}
export interface Backend {
  name: string;
  decide(
    req: WireRequest,
    opts: { signal: AbortSignal },
  ): Promise<WireResponse>;
  capabilities(): { images: boolean; maxStateTokens?: number };
}
export interface DecisionMeta {
  id: string;
  ts: number;
  name?: string;
  tick?: number;
  backend: string;
  tier: number;
  emulated: boolean;
  latency_ms: number;
  stale: boolean;
  error?: string;
  usage?: Usage;
  attempts: TierAttempt[];
}
export type Decision<Q extends Questions = Questions> = DecisionMeta &
  AnswersFor<Q>;
export interface DecisionRecord extends DecisionMeta {
  state: string;
  questions: Questions;
  answers: Record<string, Answer>;
}
export interface BranchRecord {
  request_id: string;
  key: string;
  branch: string;
  band: Band;
  ts: number;
  value: boolean | string | number | null;
}
export interface OutcomeRecord {
  request_id: string;
  ts: number;
  payload: Record<string, unknown>;
}
export interface BranchPolicy {
  timeoutMs?: number;
  threshold?: number;
  act?: number;
  confirm?: number;
  fallback?: boolean | string | number;
}
export interface PolicyData {
  bands: { act: number; confirm: number };
  branches: Record<string, BranchPolicy>;
  allowEmulated: boolean;
}
export interface PolicyInput {
  bands?: Partial<PolicyData["bands"]>;
  branches?: Record<string, BranchPolicy>;
  allowEmulated?: boolean;
}
export interface PolicyChange {
  ts: number;
  branch: string;
  before: unknown;
  after: unknown;
  policy: PolicyData;
}
export type LogEvent =
  | { type: "decision"; data: DecisionRecord }
  | { type: "branch"; data: BranchRecord }
  | { type: "outcome"; data: OutcomeRecord }
  | { type: "policy"; data: PolicyChange };
export interface LogSink {
  decision(record: DecisionRecord): void | Promise<void>;
  branch(record: BranchRecord): void | Promise<void>;
  outcome(record: OutcomeRecord): void | Promise<void>;
  policy(change: PolicyChange): void | Promise<void>;
}
export interface Snapshot {
  policy: PolicyData;
  decisions: DecisionRecord[];
  branches: BranchRecord[];
  outcomes: OutcomeRecord[];
}
export const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export function finite(
  x: unknown,
  label: string,
  min = -Infinity,
  max = Infinity,
): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max)
    throw new Error(`${label} must be a finite number in [${min}, ${max}]`);
  return x;
}
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
export function text(x: unknown, label: string): string {
  if (typeof x !== "string" || !x.trim())
    throw new Error(`${label} must be nonempty text`);
  return x;
}
