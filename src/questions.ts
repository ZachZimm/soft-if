import {
  finite,
  isRecord,
  text,
  type ChoiceQuestion,
  type NoulQuestion,
  type ScoreQuestion,
  type Questions,
} from "./types.js";
export const RESERVED = new Set([
  "id",
  "ts",
  "name",
  "tick",
  "backend",
  "tier",
  "emulated",
  "latency_ms",
  "stale",
  "error",
  "usage",
  "attempts",
  "__proto__",
  "constructor",
  "prototype",
]);
export function noul(instructions: string): NoulQuestion {
  return { type: "noul", instructions: text(instructions, "instructions") };
}
export function choice<const K extends string>(
  instructions: string,
  criteria: Record<K, string>,
): ChoiceQuestion<K> {
  if (
    !isRecord(criteria) ||
    Object.keys(criteria).length < 2 ||
    Object.keys(criteria).length > 255
  )
    throw new Error("choice requires 2..255 options");
  for (const [k, v] of Object.entries(criteria)) {
    text(k, "choice key");
    text(v, "choice description");
    if (["__proto__", "constructor", "prototype"].includes(k))
      throw new Error("Unsafe choice key");
  }
  return {
    type: "choice",
    instructions: text(instructions, "instructions"),
    criteria: { ...criteria },
  };
}
export function score(
  instructions: string,
  criteria: readonly string[],
): ScoreQuestion {
  finite(criteria?.length, "score levels", 2, 10);
  for (const s of criteria) text(s, "score label");
  return {
    type: "score",
    instructions: text(instructions, "instructions"),
    criteria: [...criteria],
  };
}
export function validateQuestions(qs: unknown): asserts qs is Questions {
  if (
    !isRecord(qs) ||
    Object.keys(qs).length < 1 ||
    Object.keys(qs).length > 255
  )
    throw new Error("questions requires 1..255 entries");
  for (const [key, q] of Object.entries(qs)) {
    text(key, "question key");
    if (RESERVED.has(key)) throw new Error(`Reserved question key: ${key}`);
    if (!isRecord(q)) throw new Error(`Invalid question ${key}`);
    if (q.type === "noul") noul(q.instructions as string);
    else if (q.type === "choice")
      choice(q.instructions as string, q.criteria as Record<string, string>);
    else if (q.type === "score") {
      if (!Array.isArray(q.criteria))
        throw new Error("score criteria must be array");
      score(q.instructions as string, q.criteria);
    } else throw new Error(`Unknown question type: ${q.type}`);
  }
}
