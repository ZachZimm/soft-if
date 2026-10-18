import { finite, isRecord, type Answer, type Questions } from "./types.js";

/** Validate normalized backend answers without changing native score/confidence. */
export function validateAnswers(
  value: unknown,
  questions: Questions,
): asserts value is Record<string, Answer> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== Object.keys(questions).length ||
    Object.keys(value).some((k) => !Object.hasOwn(questions, k))
  )
    throw new Error("Backend answers must exactly match question keys");
  for (const [key, q] of Object.entries(questions)) {
    const a = value[key];
    if (!isRecord(a) || a.type !== q.type)
      throw new Error(`Backend omitted or mistyped ${key}`);
    finite(a.confidence, `${key}.confidence`, 0, 1);
    for (const flag of ["emulated", "fallback"])
      if (a[flag] !== undefined && typeof a[flag] !== "boolean")
        throw new Error(`${key}.${flag} must be boolean`);
    const keys =
      q.type === "noul"
        ? Object.keys(isRecord(a.probabilities) ? a.probabilities : {})
        : q.type === "choice"
          ? Object.keys(q.criteria)
          : q.criteria.map((_, i) => String(i));
    if (
      !isRecord(a.probabilities) ||
      Object.keys(a.probabilities).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(a.probabilities as object, k))
    )
      throw new Error(`${key}: probabilities must match criteria`);
    if (q.type === "noul" && keys.length !== 2)
      throw new Error(`${key}: noul requires two probabilities`);
    let sum = 0;
    for (const k of keys)
      sum += finite(a.probabilities[k], `${key}.probabilities.${k}`, 0, 1);
    if (Math.abs(sum - 1) > 0.005)
      throw new Error(`${key}: probabilities must sum to one`);
    if (q.type === "noul") {
      finite(a.p, `${key}.p`, 0, 1);
      if (Math.abs((a.probabilities.true as number) - (a.p as number)) > 0.005)
        throw new Error(`${key}: noul probability disagrees with p`);
    } else if (q.type === "score")
      finite(a.score, `${key}.score`, 0, q.criteria.length - 1);
    else if (
      typeof a.choice !== "string" ||
      !Object.hasOwn(q.criteria, a.choice)
    )
      throw new Error(`Invalid choice ${key}`);
  }
}
