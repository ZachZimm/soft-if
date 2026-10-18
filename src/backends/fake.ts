import type { Backend, WireRequest, WireResponse, Answer } from "../types.js";
export interface FakeOptions {
  name?: string;
  delayMs?: number;
  error?: string;
  answers?: Record<string, Answer>;
  respond?: (req: WireRequest) => WireResponse | Promise<WireResponse>;
}
export function fake(options: FakeOptions = {}): Backend {
  return {
    name: options.name ?? "fake",
    capabilities: () => ({ images: true, maxStateTokens: 4096 }),
    async decide(req, { signal }) {
      if (signal.aborted) throw signal.reason;
      if (options.delayMs)
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(t);
            reject(signal.reason);
          };
          const t = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, options.delayMs);
          signal.addEventListener("abort", cancel, { once: true });
        });
      if (options.error) throw new Error(options.error);
      if (options.respond) return options.respond(req);
      const answers: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(req.questions)) {
        const supplied = options.answers?.[key];
        if (supplied) {
          answers[key] = structuredClone(supplied);
          continue;
        }
        if (q.type === "noul")
          answers[key] = {
            type: "noul",
            p: 0.9,
            confidence: 0.9,
            probabilities: { true: 0.9, false: 0.1 },
          };
        else {
          const keys =
            q.type === "choice"
              ? Object.keys(q.criteria)
              : q.criteria.map((_, i) => String(i));
          const probabilities = Object.fromEntries(
            keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / (keys.length - 1)]),
          );
          answers[key] =
            q.type === "choice"
              ? {
                  type: "choice",
                  choice: keys[0]!,
                  confidence: 0.9,
                  probabilities,
                }
              : {
                  type: "score",
                  score: keys.reduce(
                    (sum, k) => sum + Number(k) * probabilities[k]!,
                    0,
                  ),
                  confidence: 0.9,
                  probabilities,
                };
        }
      }
      return {
        answers,
        backend: options.name ?? "fake",
        latency_ms: options.delayMs ?? 0,
      };
    },
  };
}
