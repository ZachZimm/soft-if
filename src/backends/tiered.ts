import { Policy } from "../policy.js";
import { validateAnswers } from "../validation.js";
import {
  errorMessage,
  finite,
  type Backend,
  type Band,
  type TierAttempt,
  type WireResponse,
} from "../types.js";
export class TieredError extends Error {
  constructor(
    message: string,
    readonly attempts: TierAttempt[],
  ) {
    super(message);
    this.name = "TieredError";
  }
}
export function tiered(
  backends: readonly Backend[],
  options: {
    escalateBelow?: Band;
    policy?: Policy;
    tierTimeoutMs?: number;
  } = {},
): Backend {
  if (!backends.length) throw new Error("tiered requires at least one backend");
  if (options.tierTimeoutMs !== undefined)
    finite(options.tierTimeoutMs, "tierTimeoutMs", 1, 300_000);
  const policy = options.policy ?? new Policy();
  const rank = { fallback: 0, confirm: 1, act: 2 };
  return {
    name: `tiered(${backends.map((b) => b.name).join(",")})`,
    capabilities: () => ({
      images: backends.every((b) => b.capabilities().images),
      maxStateTokens: Math.min(
        ...backends.map((b) => b.capabilities().maxStateTokens ?? 4096),
      ),
    }),
    async decide(req, { signal }) {
      let best: WireResponse | undefined;
      const attempts: TierAttempt[] = [];
      for (let i = 0; i < backends.length; i++) {
        const backend = backends[i]!;
        const started = performance.now();
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const timer = options.tierTimeoutMs
          ? setTimeout(
              () => controller.abort(new Error(`Tier ${i + 1} timeout`)),
              options.tierTimeoutMs,
            )
          : undefined;
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          const result = await Promise.race([
            backend.decide(req, { signal: controller.signal }),
            new Promise<never>((_, reject) => {
              if (controller.signal.aborted) reject(controller.signal.reason);
              else
                controller.signal.addEventListener(
                  "abort",
                  () => reject(controller.signal.reason),
                  { once: true },
                );
            }),
          ]);
          validateAnswers(result.answers, req.questions);
          if (result.emulated)
            for (const a of Object.values(result.answers)) a.emulated = true;
          attempts.push({
            backend: backend.name,
            tier: i + 1,
            latency_ms: performance.now() - started,
          });
          best = {
            ...result,
            backend: result.backend ?? backend.name,
            tier: i + 1,
          };
          const needs = Object.values(result.answers).some(
            (a) =>
              rank[policy.band(a)] <= rank[options.escalateBelow ?? "confirm"],
          );
          if (!needs) break;
        } catch (e) {
          attempts.push({
            backend: backend.name,
            tier: i + 1,
            latency_ms: performance.now() - started,
            error: errorMessage(e),
          });
        } finally {
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
        if (signal.aborted) break;
      }
      if (!best)
        throw new TieredError(
          attempts.map((a) => `${a.backend}: ${a.error}`).join("; "),
          attempts,
        );
      return {
        ...best,
        attempts,
        error:
          attempts
            .filter((a) => a.error)
            .map((a) => `${a.backend}: ${a.error}`)
            .join("; ") || best.error,
      };
    },
  };
}
