import {
  finite,
  isRecord,
  errorMessage,
  type Answer,
  type Questions,
  type WireResponse,
  type WireRequest,
  type Backend,
} from "../types.js";
import { validateQuestions } from "../questions.js";
export class ResponseParseError extends Error {
  constructor(
    message: string,
    public readonly rawBody: string,
  ) {
    super(`${message}; raw body: ${rawBody.slice(0, 8192)}`);
    this.name = "ResponseParseError";
  }
}
function probabilities(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, number> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new Error(`${label}: probabilities must match criteria keys`);
  const entries = keys.map(
    (k) => [k, finite(value[k], `${label}.${k}`, 0, 1)] as const,
  );
  const sum = entries.reduce((a, [, p]) => a + p, 0);
  if (Math.abs(sum - 1) > 0.005)
    throw new Error(`${label}: probabilities sum to ${sum}`);
  return Object.fromEntries(entries);
}
export function parseSystemOne(
  body: unknown,
  qs: Questions,
  rawBody?: string,
): WireResponse {
  try {
    if (!isRecord(body) || !isRecord(body.answers))
      throw new Error("Missing answers map");
    const answers: Record<string, Answer> = Object.create(null);
    for (const [key, q] of Object.entries(qs)) {
      const a = body.answers[key];
      if (!isRecord(a)) throw new Error(`Missing answer ${key}`);
      if (a.type !== undefined && a.type !== q.type)
        throw new Error(`Wrong type for ${key}`);
      if (q.type === "noul") {
        const p = finite(a.noul ?? a.p, key, 0, 1);
        answers[key] = {
          type: "noul",
          p,
          confidence:
            a.confidence === undefined
              ? Math.max(p, 1 - p)
              : finite(a.confidence, "confidence", 0, 1),
          probabilities: { false: 1 - p, true: p },
        };
      } else {
        const keys =
          q.type === "choice"
            ? Object.keys(q.criteria)
            : q.criteria.map((_, i) => String(i));
        const ps = probabilities(a.probabilities, keys, key);
        const confidence =
          a.confidence === undefined
            ? Math.max(...Object.values(ps))
            : finite(a.confidence, "confidence", 0, 1);
        if (q.type === "choice") {
          if (
            typeof a.choice !== "string" ||
            !Object.hasOwn(q.criteria, a.choice)
          )
            throw new Error(`Invalid choice ${key}`);
          answers[key] = {
            type: "choice",
            choice: a.choice,
            probabilities: ps,
            confidence,
          };
        } else
          answers[key] = {
            type: "score",
            score: finite(a.score, key, 0, q.criteria.length - 1),
            probabilities: ps,
            confidence,
            legend: Object.fromEntries(q.criteria.map((s, i) => [i, s])),
          };
      }
    }
    const usage = isRecord(body.usage) ? body.usage : undefined;
    if (usage)
      for (const k of ["input_tokens", "output_tokens"])
        if (usage[k] !== undefined) finite(usage[k], `usage.${k}`, 0);
    let latency_ms: number | undefined;
    if (
      body.latency_ms !== undefined ||
      body.duration_ms !== undefined ||
      body.latency !== undefined
    )
      latency_ms = finite(
        body.latency_ms ?? body.duration_ms ?? body.latency,
        "latency_ms",
        0,
      );
    return { answers, usage, latency_ms };
  } catch (e) {
    throw new ResponseParseError(
      errorMessage(e),
      rawBody ?? JSON.stringify(body),
    );
  }
}
export async function readBody(
  response: Response,
  maxBytes = 4 * 1024 * 1024,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    raw = "";
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > maxBytes)
        throw new Error(`Response exceeds ${maxBytes} bytes`);
      raw += decoder.decode(r.value, { stream: true });
    }
    raw += decoder.decode();
    return raw;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export interface SystemOneOptions {
  url?: string;
  model?: string;
  name?: string;
  fetch?: typeof fetch;
  maxStateTokens?: number;
  headers?: Record<string, string>;
}
export function systemone(
  options: SystemOneOptions = {},
  requiresModel = false,
): Backend {
  const base = (options.url ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const url = base.endsWith("/v1/systemone") ? base : `${base}/v1/systemone`;
  return {
    name: options.name ?? (requiresModel ? "ollama" : "llamacpp"),
    capabilities: () => ({
      images: true,
      maxStateTokens: options.maxStateTokens ?? 4096,
    }),
    async decide(req: WireRequest, { signal }) {
      validateQuestions(req.questions);
      const payload = { ...req, model: options.model ?? req.model };
      if (!requiresModel && !payload.model) delete payload.model;
      if (requiresModel && !payload.model)
        throw new Error("Ollama requires model");
      const started = performance.now();
      const res = await (options.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify(payload),
        signal,
      });
      const raw = await readBody(res);
      if (!res.ok)
        throw new Error(`${url}: HTTP ${res.status}: ${raw.slice(0, 8192)}`);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ResponseParseError("Invalid JSON", raw);
      }
      const parsed = parseSystemOne(body, req.questions, raw);
      return {
        ...parsed,
        backend: options.name ?? (requiresModel ? "ollama" : "llamacpp"),
        latency_ms: parsed.latency_ms ?? performance.now() - started,
      };
    },
  };
}
