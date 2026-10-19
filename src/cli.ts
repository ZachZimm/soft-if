#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  SoftIf,
  Policy,
  SQLiteLog,
  ollama,
  llamacpp,
  openaiEmulated,
  fake,
  noul,
  choice,
  score,
  calibrate,
  replay,
  startDebugger,
  type Backend,
  type Questions,
} from "./node.js";
const HELP = `softif ask --state TEXT --noul 'key=question' [--choice 'key=a:description,b:description']
softif replay --db soft-if.db --from TIMESTAMP --backend ollama
softif calib --db soft-if.db [--branch launcher.action]
softif debug --db soft-if.db [--policy policy.json] [--port 7331] [--demo]
softif bench --backend ollama [--count 200] [--question-counts 1,4,12]

Common flags: --backend fake|ollama|llamacpp|openai|bonsai|lab-clef27b, --url, --model,
--timeout 10000, --policy FILE, --json. OpenAI also accepts --api-key-file.
Bonsai/OpenAI defaults: BONSAI_URL or http://localhost:9090/v1,
BONSAI_MODEL or bonsai-2-27b, BONSAI_API_KEY_FILE, OPENAI_API_KEY.
Named backends: --backend-config FILE with {name:{type,url,model}}.
Choice/score prompts may use 'key=Prompt?|a:description,b:description'.
Score levels: --score 'urgency=How urgent?|later,soon,now'.
`;
const options = {
  state: { type: "string" },
  "state-file": { type: "string" },
  noul: { type: "string", multiple: true },
  choice: { type: "string", multiple: true },
  score: { type: "string", multiple: true },
  questions: { type: "string" },
  backend: { type: "string" },
  url: { type: "string" },
  model: { type: "string" },
  "api-key-file": { type: "string" },
  "backend-config": { type: "string" },
  db: { type: "string" },
  policy: { type: "string" },
  timeout: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  branch: { type: "string" },
  bins: { type: "string" },
  port: { type: "string" },
  count: { type: "string" },
  "question-counts": { type: "string" },
  warmup: { type: "string" },
  demo: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;
type Values = ReturnType<typeof argumentsFor>;
function argumentsFor(args: string[]) {
  return parseArgs({ args, options, allowPositionals: true }).values;
}
function numeric(
  v: string | undefined,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
) {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`Expected number in [${min}, ${max}], got ${v}`);
  return n;
}
function timestamp(v: string | undefined, fallback: number) {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (Number.isFinite(n)) return numeric(v, fallback);
  const date = Date.parse(v);
  if (!Number.isFinite(date)) throw new Error(`Invalid timestamp ${v}`);
  return date;
}
function backend(v: Values): Backend {
  let type = v.backend ?? "ollama";
  let profile: Record<string, string> = {};
  if (v["backend-config"]) {
    const all = JSON.parse(readFileSync(v["backend-config"], "utf8"));
    profile = all[type] ?? {};
    if (!profile.type) throw new Error(`No backend profile ${type}`);
    type = profile.type;
  }
  const url = v.url ?? profile.url;
  const model = v.model ?? profile.model;
  if (type === "fake") return fake();
  if (type === "ollama")
    return ollama({ url, model: model ?? "clef-flash-q8:latest" });
  if (type === "llamacpp" || type === "lab-clef27b") {
    const lab = type === "lab-clef27b";
    const endpoint = url ?? (lab ? process.env.SOFTIF_LAB_URL : undefined);
    if (lab && !endpoint)
      throw new Error(
        "lab-clef27b needs --url, SOFTIF_LAB_URL, or --backend-config",
      );
    return llamacpp({
      url: endpoint,
      model,
      name: lab ? "lab-clef27b" : undefined,
    });
  }
  if (type === "openai" || type === "bonsai")
    return openaiEmulated({
      url: url ?? process.env.BONSAI_URL ?? "http://localhost:9090/v1",
      model: model ?? process.env.BONSAI_MODEL ?? "bonsai-2-27b",
      apiKey: process.env.OPENAI_API_KEY,
      apiKeyFile: v["api-key-file"] ?? process.env.BONSAI_API_KEY_FILE,
      thinking: false,
    });
  throw new Error(`Unknown backend ${type}`);
}
function readQuestions(v: Values): Questions {
  const qs: Questions = v.questions
    ? JSON.parse(readFileSync(v.questions, "utf8"))
    : {};
  const insert = (
    spec: string,
    build: (prompt: string, criteria: string) => Questions[string],
  ) => {
    const split = spec.indexOf("=");
    if (split < 1) throw new Error(`Expected key=question: ${spec}`);
    const key = spec.slice(0, split);
    if (Object.hasOwn(qs, key)) throw new Error(`Duplicate question ${key}`);
    const rest = spec.slice(split + 1),
      bar = rest.indexOf("|");
    qs[key] = build(
      bar < 0 ? key : rest.slice(0, bar),
      bar < 0 ? rest : rest.slice(bar + 1),
    );
  };
  for (const spec of v.noul ?? []) insert(spec, (_, text) => noul(text));
  for (const spec of v.choice ?? [])
    insert(spec, (prompt, criteria) => {
      const pairs = criteria.split(",").map((c) => {
        const i = c.indexOf(":");
        if (i < 1) throw new Error(`Expected option:description: ${c}`);
        return [c.slice(0, i), c.slice(i + 1)] as const;
      });
      if (new Set(pairs.map((p) => p[0])).size !== pairs.length)
        throw new Error("Duplicate choice key");
      return choice(prompt, Object.fromEntries(pairs));
    });
  for (const spec of v.score ?? [])
    insert(spec, (prompt, criteria) => score(prompt, criteria.split(",")));
  if (!Object.keys(qs).length)
    throw new Error("Supply --noul, --choice, --score, or --questions");
  return qs;
}
const loadPolicy = (v: Values) =>
  v.policy ? Policy.fromFile(v.policy, { watch: true }) : new Policy();
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args,
    options,
    allowPositionals: true,
  });
  const command = positionals[0];
  if (v.help || !command) {
    console.log(HELP);
    return;
  }
  if (positionals.length !== 1)
    throw new Error("Unexpected positional arguments");
  if (command === "ask") {
    const policy = loadPolicy(v);
    const soft = new SoftIf({
      backend: backend(v),
      policy,
      log: v.db ? { sqlite: v.db } : undefined,
      defaultTimeoutMs: numeric(v.timeout, 10_000, 1),
    });
    try {
      const state = v["state-file"]
        ? readFileSync(v["state-file"], "utf8")
        : v.state;
      if (state === undefined)
        throw new Error("Supply --state or --state-file");
      const result = await soft.decide(state, readQuestions(v));
      console.log(JSON.stringify(result, null, 2));
      if (result.error) process.exitCode = 1;
    } finally {
      await soft.close();
      policy.close();
    }
    return;
  }
  if (command === "replay" || command === "calib") {
    const db = new SQLiteLog(v.db ?? "soft-if.db");
    const policy = loadPolicy(v);
    try {
      const records = db.decisions({
        from: timestamp(v.from, 0),
        to: timestamp(v.to, Number.MAX_SAFE_INTEGER),
      });
      if (command === "replay") {
        const report = await replay(records, backend(v), {
          policy,
          branches: db.branches(),
          timeoutMs: numeric(v.timeout, 10_000, 1),
        });
        if (v.json) console.log(JSON.stringify(report, null, 2));
        else {
          console.table(report.flips);
          console.log(
            `${report.agreements}/${report.comparisons} agree (${(100 * report.agreementRate).toFixed(1)}%); ${report.errors.length} errors`,
          );
          if (report.errors.length)
            console.error(JSON.stringify(report.errors));
        }
        if (report.errors.length) process.exitCode = 1;
      } else {
        const report = calibrate(records, db.outcomes(), db.branches(), {
          branch: v.branch,
          bins: numeric(v.bins, 10, 1, 1000),
        });
        if (v.json) console.log(JSON.stringify(report, null, 2));
        else {
          console.table(report.bins.filter((b) => b.count));
          console.log(`n=${report.count}; ECE=${report.ece.toFixed(6)}`);
        }
      }
    } finally {
      db.close();
      policy.close();
    }
    return;
  }
  if (command === "debug") {
    const db = new SQLiteLog(v.db ?? "soft-if.db");
    const policy = v.policy ? loadPolicy(v) : new Policy(db.snapshot().policy);
    let server: Awaited<ReturnType<typeof startDebugger>>;
    try {
      server = await startDebugger({
        log: db,
        policy,
        port: numeric(v.port, 7331, 0, 65535),
        observePolicy: !v.demo,
      });
    } catch (e) {
      db.close();
      policy.close();
      throw e;
    }
    console.log(server.url);
    const soft = v.demo
      ? new SoftIf({ backend: fake(), policy, log: db })
      : undefined;
    let running = false;
    let tick = 0;
    const timer = soft
      ? setInterval(async () => {
          if (running) return;
          running = true;
          try {
            const r = await soft.decide(
              `Demo input ${++tick}`,
              {
                file: noul("Local file?"),
                action: choice("Action?", {
                  file: "Local file",
                  web: "Web search",
                }),
              },
              { name: "demo", tick },
            );
            soft.when(r.file, "demo.file");
            soft.pick(r.action, "demo.action");
          } catch (e) {
            console.error(e);
          } finally {
            running = false;
          }
        }, 500)
      : undefined;
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    if (timer) clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 5));
    await soft?.close();
    await server.close();
    db.close();
    policy.close();
    return;
  }
  if (command === "bench") {
    const count = numeric(v.count, 200, 1, 100_000);
    if (!Number.isInteger(count)) throw new Error("count must be integer");
    const counts = (v["question-counts"] ?? "1,4,12")
      .split(",")
      .map((s) => numeric(s, 1, 1, 255));
    if (counts.some((n) => !Number.isInteger(n)))
      throw new Error("question counts must be integers");
    const warmup = numeric(v.warmup, 1, 0, 100);
    if (!Number.isInteger(warmup)) throw new Error("warmup must be integer");
    const model = backend(v);
    const soft = new SoftIf({
      backend: model,
      defaultTimeoutMs: numeric(v.timeout, 30_000, 1),
    });
    const reports: unknown[] = [];
    const state =
      "A user is searching for a local document about the quarterly engineering budget. Available actions include opening a file, searching the web, or running a command. "
        .repeat(8)
        .slice(0, 1200);
    try {
      for (const n of counts) {
        const qs = Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `q${i}`,
            noul(`Does the user want a local document? Check ${i}.`),
          ]),
        );
        for (let i = 0; i < warmup; i++) await soft.decide(state, qs);
        const timings: number[] = [];
        const errors: string[] = [];
        const tiers: Record<string, number[]> = {};
        for (let i = 0; i < count; i++) {
          const r = await soft.decide(state, qs);
          if (r.error) errors.push(r.error);
          if (
            !Object.keys(qs).some(
              (k) => (r[k] as { fallback?: boolean }).fallback,
            )
          )
            timings.push(r.latency_ms);
          for (const a of r.attempts) {
            if (!a.error)
              (tiers[`${a.tier}:${a.backend}`] ??= []).push(a.latency_ms);
          }
          if ((i + 1) % 25 === 0)
            console.error(`${model.name} ${n} questions: ${i + 1}/${count}`);
        }
        const stats = (xs: number[]) => {
          const sorted = [...xs].sort((a, b) => a - b);
          const quantile = (p: number) =>
            sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
          return {
            n: xs.length,
            p50_ms: quantile(0.5),
            p95_ms: quantile(0.95),
          };
        };
        reports.push({
          backend: model.name,
          questions: n,
          requests: count,
          state_chars: state.length,
          estimated_state_tokens: Math.ceil(state.length / 4),
          ...stats(timings),
          failures: errors.length,
          errors: [...new Set(errors)],
          tiers: Object.fromEntries(
            Object.entries(tiers).map(([k, xs]) => [k, stats(xs)]),
          ),
        });
      }
    } finally {
      await soft.close();
    }
    console.log(
      JSON.stringify(
        { measured_at: new Date().toISOString(), reports },
        null,
        2,
      ),
    );
    if (reports.some((r) => (r as { failures: number }).failures))
      process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command ${command}\n${HELP}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((e) => {
    console.error(`softif: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
