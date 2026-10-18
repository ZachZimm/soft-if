import { Policy } from "./policy.js";
import { validateQuestions } from "./questions.js";
import { RingLog } from "./log/ring.js";
import { Ticks } from "./ticks.js";
import { validateAnswers } from "./validation.js";
import {
  errorMessage,
  finite,
  type Answer,
  type Backend,
  type Band,
  type ChoiceAnswer,
  type Decision,
  type DecisionRecord,
  type LogSink,
  type NoulAnswer,
  type Questions,
  type WireResponse,
} from "./types.js";
export interface SoftIfOptions {
  backend: Backend;
  policy?: Policy;
  log?: LogSink;
  defaultTimeoutMs?: number;
  maxStateTokens?: number;
  stateOverflow?: "error" | "truncate";
  logStateMaxChars?: number;
}
export interface DecideOptions {
  name?: string;
  tick?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: string[];
  branches?: Record<string, string>;
}
export class SoftIf {
  readonly policy: Policy;
  readonly backend: Backend;
  readonly log: LogSink;
  private ticks = new Ticks();
  private completed = new Map<string, Decision>();
  private answers = new WeakMap<Answer, { id: string; key: string }>();
  private pending = new Set<Promise<void>>();
  private logTail?: Promise<void>;
  private active = new Set<Promise<unknown>>();
  private controllers = new Set<AbortController>();
  private closing?: Promise<void>;
  private errors: Error[] = [];
  private listeners = new Set<(e: Error) => void>();
  private unsubscribe: () => void;
  private closed = false;
  constructor(private options: SoftIfOptions) {
    this.backend = options.backend;
    this.policy = options.policy ?? new Policy();
    this.log = options.log ?? new RingLog();
    if (options.defaultTimeoutMs !== undefined)
      finite(options.defaultTimeoutMs, "defaultTimeoutMs", 1);
    this.unsubscribe = this.policy.subscribe((c) =>
      this.write(() => this.log.policy(c)),
    );
  }
  onError(fn: (e: Error) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private report(e: unknown) {
    const error = e instanceof Error ? e : new Error(String(e));
    this.errors.push(error);
    for (const fn of this.listeners) {
      try {
        fn(error);
      } catch {}
    }
  }
  private write(fn: () => void | Promise<void>) {
    const track = (task: Promise<void>) => {
      const pending = task.finally(() => {
        this.pending.delete(pending);
        if (this.logTail === pending) this.logTail = undefined;
      });
      this.logTail = pending;
      this.pending.add(pending);
    };
    if (this.logTail) {
      track(
        this.logTail.then(fn).then(
          () => {},
          (e) => this.report(e),
        ),
      );
      return;
    }
    try {
      const result = fn();
      if (result) track(Promise.resolve(result).catch((e) => this.report(e)));
    } catch (e) {
      this.report(e);
    }
  }
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
    if (this.errors.length) {
      const errors = this.errors.splice(0);
      throw new AggregateError(errors, "soft-if log writes failed");
    }
  }
  async ready(): Promise<void> {}
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.unsubscribe();
    for (const controller of this.controllers)
      controller.abort(new Error("SoftIf closed"));
    this.closing = (async () => {
      await Promise.allSettled(this.active);
      await this.flush();
    })();
    return this.closing;
  }
  decide<Q extends Questions>(
    state: string | Record<string, unknown>,
    questions: Q,
    options: DecideOptions = {},
  ): Promise<Decision<Q>> {
    if (this.closed) return Promise.reject(new Error("SoftIf is closed"));
    const task = this.runDecision(state, questions, options);
    this.active.add(task);
    task.then(
      () => this.active.delete(task),
      () => this.active.delete(task),
    );
    return task;
  }
  private async runDecision<Q extends Questions>(
    state: string | Record<string, unknown>,
    questions: Q,
    options: DecideOptions,
  ): Promise<Decision<Q>> {
    validateQuestions(questions);
    let stateText = typeof state === "string" ? state : JSON.stringify(state);
    if (typeof stateText !== "string")
      throw new Error("state must serialize to a string");
    const cap =
      this.options.maxStateTokens ??
      this.backend.capabilities().maxStateTokens ??
      4096;
    finite(cap, "maxStateTokens", 1);
    const overhead = Math.ceil(JSON.stringify(questions).length / 4) + 128;
    const available = Math.floor((cap - overhead) * 4);
    if (available < 0) throw new Error("Questions exceed token budget");
    if (stateText.length > available) {
      if (this.options.stateOverflow !== "truncate")
        throw new Error(
          `Estimated prompt exceeds ${cap} token budget; use stateOverflow: truncate explicitly`,
        );
      stateText = stateText.slice(0, available);
    }
    if (options.images?.length && !this.backend.capabilities().images)
      throw new Error("Backend does not support images");
    const branchTimeouts = Object.keys(questions)
      .map(
        (key) =>
          this.policy.branch(
            options.branches?.[key] ??
              (options.name ? `${options.name}.${key}` : key),
          ).timeoutMs,
      )
      .filter((n): n is number => n !== undefined);
    const timeout =
      options.timeoutMs ??
      (branchTimeouts.length
        ? Math.min(...branchTimeouts)
        : (this.options.defaultTimeoutMs ?? 400));
    finite(timeout, "timeoutMs", 1);
    const name = options.name;
    const tick = options.tick ?? this.ticks.next();
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw new Error("tick must be a nonnegative safe integer");
    if (name) this.ticks.begin(name, tick);
    const id = globalThis.crypto.randomUUID();
    const ts = Date.now();
    const started = performance.now();
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () =>
      controller.abort(options.signal?.reason ?? new Error("Request aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new Error(`Decision timeout after ${timeout}ms`)),
      timeout,
    );
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let response: WireResponse;
    let error: string | undefined;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      response = await Promise.race([
        this.backend.decide(
          { state: stateText, questions, images: options.images },
          { signal: controller.signal },
        ),
        new Promise<never>((_, reject) => {
          const rejectAfterRecovery = () => {
            abortTimer = setTimeout(() => reject(controller.signal.reason), 0);
          };
          if (controller.signal.aborted) rejectAfterRecovery();
          else
            controller.signal.addEventListener("abort", rejectAfterRecovery, {
              once: true,
            });
        }),
      ]);
      error = response.error;
      validateAnswers(response.answers, questions);
      response = { ...response, answers: structuredClone(response.answers) };
    } catch (e) {
      error = errorMessage(e);
      const answers: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        const branch =
          options.branches?.[key] ?? (name ? `${name}.${key}` : key);
        const fallback = this.policy.branch(branch).fallback;
        if (q.type === "noul") {
          const p =
            typeof fallback === "boolean"
              ? Number(fallback)
              : typeof fallback === "number"
                ? Math.max(0, Math.min(1, fallback))
                : 0;
          answers[key] = {
            type: "noul",
            p,
            confidence: 0,
            probabilities: { true: p, false: 1 - p },
            fallback: true,
          };
        } else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const chosen =
            typeof fallback === "string" && Object.hasOwn(q.criteria, fallback)
              ? fallback
              : keys[keys.length - 1]!;
          answers[key] = {
            type: "choice",
            choice: chosen,
            confidence: 0,
            probabilities: Object.fromEntries(
              keys.map((k) => [k, k === chosen ? 1 : 0]),
            ),
            fallback: true,
          };
        } else {
          const value =
            typeof fallback === "number"
              ? Math.max(0, Math.min(q.criteria.length - 1, fallback))
              : 0;
          const lo = Math.floor(value),
            hi = Math.ceil(value);
          answers[key] = {
            type: "score",
            score: value,
            confidence: 0,
            probabilities: Object.fromEntries(
              q.criteria.map((_, i) => [
                i,
                i === lo
                  ? hi === lo
                    ? 1
                    : hi - value
                  : i === hi
                    ? value - lo
                    : 0,
              ]),
            ),
            fallback: true,
          };
        }
      }
      response = {
        answers,
        backend: this.backend.name,
        tier: 1,
        attempts:
          e instanceof Error && "attempts" in e && Array.isArray(e.attempts)
            ? e.attempts
            : [
                {
                  backend: this.backend.name,
                  tier: 1,
                  latency_ms: performance.now() - started,
                  error,
                },
              ],
      };
    } finally {
      this.controllers.delete(controller);
      clearTimeout(timer);
      if (abortTimer) clearTimeout(abortTimer);
      options.signal?.removeEventListener("abort", abort);
    }
    const elapsed = performance.now() - started;
    const meta = {
      id,
      ts,
      name,
      tick,
      backend: response.backend ?? this.backend.name,
      tier: response.tier ?? 1,
      emulated:
        response.emulated === true ||
        Object.values(response.answers).some((a) => a.emulated === true),
      latency_ms: elapsed,
      stale: !!name && this.ticks.stale(name, tick),
      error,
      usage: response.usage,
      attempts: response.attempts ?? [
        {
          backend: response.backend ?? this.backend.name,
          tier: response.tier ?? 1,
          latency_ms: elapsed,
        },
      ],
    };
    const result = { ...meta, ...response.answers } as Decision<Q>;
    for (const [key, a] of Object.entries(response.answers)) {
      if (meta.emulated) a.emulated = true;
      const branch = options.branches?.[key] ?? (name ? `${name}.${key}` : key);
      a.band = this.policy.band(a, branch);
      a.branch = branch;
      this.answers.set(a, { id, key });
    }
    const record: DecisionRecord = {
      ...meta,
      state:
        this.options.logStateMaxChars === undefined
          ? stateText
          : stateText.slice(0, this.options.logStateMaxChars),
      questions: structuredClone(questions),
      answers: structuredClone(response.answers),
    };
    this.write(() => this.log.decision(record));
    if (name && !meta.stale) this.completed.set(name, result as Decision);
    return result;
  }
  band(answer: Answer, branch?: string): Band {
    return this.policy.band(answer, branch);
  }
  when(answer: NoulAnswer, branch: string): boolean {
    const b = this.policy.branch(branch);
    const band = this.band(answer, branch);
    const value =
      answer.fallback || band === "fallback"
        ? typeof b.fallback === "boolean"
          ? b.fallback
          : false
        : answer.emulated && band !== "act"
          ? false
          : answer.p >= this.policy.threshold(branch);
    this.branch(answer, branch, band, value);
    return value;
  }
  pick<K extends string>(
    answer: ChoiceAnswer<K>,
    branch: string,
  ): K | undefined {
    const band = this.band(answer, branch);
    const configured = this.policy.branch(branch).fallback;
    const value =
      band === "fallback"
        ? typeof configured === "string" &&
          Object.hasOwn(answer.probabilities, configured)
          ? (configured as K)
          : undefined
        : answer.choice;
    this.branch(answer, branch, band, value ?? null);
    return value;
  }
  private branch(
    answer: Answer,
    branch: string,
    band: Band,
    value: boolean | string | number | null,
  ) {
    const link = this.answers.get(answer);
    if (!link)
      throw new Error("Answer does not belong to this SoftIf instance");
    this.write(() =>
      this.log.branch({
        request_id: link.id,
        key: link.key,
        branch,
        band,
        ts: Date.now(),
        value,
      }),
    );
  }
  outcome(request_id: string, payload: Record<string, unknown>): void {
    this.write(() =>
      this.log.outcome({
        request_id,
        ts: Date.now(),
        payload: structuredClone(payload),
      }),
    );
  }
  latest(name: string): Decision | undefined {
    const result = this.completed.get(name);
    return result &&
      result.tick !== undefined &&
      !this.ticks.stale(name, result.tick)
      ? result
      : undefined;
  }
}
