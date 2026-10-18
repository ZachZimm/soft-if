import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { Policy } from "../policy.js";
import { SQLiteLog } from "../log/sqlite.js";
import { validateQuestions } from "../questions.js";
import { validateAnswers } from "../validation.js";
import {
  finite,
  isRecord,
  text,
  errorMessage,
  type LogEvent,
  type DecisionRecord,
  type BranchRecord,
  type OutcomeRecord,
} from "../types.js";
export interface DebuggerOptions {
  policy: Policy;
  log: SQLiteLog;
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  observePolicy?: boolean;
}
const loops = new Set(["localhost", "127.0.0.1", "[::1]"]);
function allowedOrigin(origin: string, extra: readonly string[]): boolean {
  if (extra.includes(origin)) return true;
  if (["tauri://localhost", "http://tauri.localhost"].includes(origin))
    return true;
  try {
    const u = new URL(origin);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      loops.has(u.hostname) &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      [
        1420, 7331, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182,
        5183,
      ].includes(Number(u.port || (u.protocol === "https:" ? 443 : 80)))
    );
  } catch {
    return false;
  }
}
function validateEvent(value: unknown): LogEvent {
  if (!isRecord(value) || !isRecord(value.data))
    throw new Error("Invalid event envelope");
  const d = value.data;
  if (value.type === "decision") {
    text(d.id, "id");
    finite(d.ts, "ts", 0);
    text(d.backend, "backend");
    finite(d.tier, "tier", 1);
    finite(d.latency_ms, "latency_ms", 0);
    if (d.name !== undefined) text(d.name, "name");
    if (d.tick !== undefined) {
      finite(d.tick, "tick", 0);
      if (!Number.isSafeInteger(d.tick)) throw new Error("Invalid tick");
    }
    if (
      typeof d.state !== "string" ||
      typeof d.stale !== "boolean" ||
      typeof d.emulated !== "boolean"
    )
      throw new Error("Invalid decision");
    validateQuestions(d.questions);
    if (!isRecord(d.answers)) throw new Error("Invalid answers");
    validateAnswers(d.answers, d.questions);
    if (!Array.isArray(d.attempts) || d.attempts.length > 100)
      throw new Error("Invalid attempts");
    for (const a of d.attempts) {
      if (!isRecord(a)) throw new Error("Invalid attempt");
      text(a.backend, "backend");
      finite(a.tier, "tier", 1);
      finite(a.latency_ms, "latency_ms", 0);
      if (a.error !== undefined && typeof a.error !== "string")
        throw new Error("Invalid error");
    }
    if (d.error !== undefined && typeof d.error !== "string")
      throw new Error("Invalid error");
    return { type: "decision", data: d as unknown as DecisionRecord };
  }
  if (value.type === "branch") {
    text(d.request_id, "request_id");
    text(d.key, "key");
    text(d.branch, "branch");
    finite(d.ts, "ts", 0);
    if (
      !["act", "confirm", "fallback"].includes(d.band as string) ||
      (!["boolean", "string", "number"].includes(typeof d.value) &&
        d.value !== null)
    )
      throw new Error("Invalid branch");
    if (typeof d.value === "number") finite(d.value, "value");
    return { type: "branch", data: d as unknown as BranchRecord };
  }
  if (value.type === "outcome") {
    text(d.request_id, "request_id");
    finite(d.ts, "ts", 0);
    if (!isRecord(d.payload)) throw new Error("Invalid outcome");
    return { type: "outcome", data: d as unknown as OutcomeRecord };
  }
  throw new Error("Only decision, branch, outcome events may be posted");
}
async function body(req: IncomingMessage, max: number) {
  if (
    !req.headers["content-type"]?.toLowerCase().startsWith("application/json")
  )
    throw Object.assign(new Error("Expected application/json"), {
      status: 415,
    });
  if (Number(req.headers["content-length"]) > max)
    throw Object.assign(new Error("Request body too large"), { status: 413 });
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > max)
      throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON");
  }
}
export async function startDebugger(options: DebuggerOptions) {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("Debugger must bind to localhost");
  const clients = new Set<ServerResponse>();
  const max = options.maxBodyBytes ?? 1024 * 1024;
  finite(max, "maxBodyBytes", 1, 16 * 1024 * 1024);
  for (const origin of options.allowedOrigins ?? []) {
    if (origin === "*" || origin === "null")
      throw new Error("allowedOrigins must be exact origins");
    new URL(origin);
  }
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const snapshot = (n = 200) => ({
    ...options.log.snapshot(n),
    policy: options.policy.snapshot(),
  });
  const publish = (event: LogEvent) => {
    for (const client of clients) {
      if (client.writableLength > 1024 * 1024) {
        client.destroy();
        clients.delete(client);
        continue;
      }
      client.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
      );
    }
  };
  const unsubscribe = options.log.subscribe(publish);
  const policyUnsubscribe =
    options.observePolicy === false
      ? () => {}
      : options.policy.subscribe((c) => options.log.policy(c));
  const server = createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host;
      if (!hostHeader) {
        json(res, 403, { error: "Missing Host" });
        return;
      }
      let hostUrl: URL;
      try {
        hostUrl = new URL(`http://${hostHeader}`);
      } catch {
        json(res, 403, { error: "Invalid Host" });
        return;
      }
      if (
        !loops.has(hostUrl.hostname) ||
        hostUrl.username ||
        hostUrl.password
      ) {
        json(res, 403, { error: "Host must be localhost" });
        return;
      }
      const origin = req.headers.origin;
      if (origin && !allowedOrigin(origin, options.allowedOrigins ?? [])) {
        json(res, 403, { error: "Origin not allowed" });
        return;
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", hostUrl);
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true, version: 1 });
        return;
      }
      if (req.method === "GET" && url.pathname === "/snapshot") {
        const n = Number(url.searchParams.get("limit") ?? 200);
        if (!Number.isInteger(n) || n < 1 || n > 2000)
          throw new Error("limit must be 1..2000");
        json(res, 200, snapshot(n));
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        if (clients.size >= 100) {
          json(res, 503, { error: "Too many SSE clients" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        try {
          const html = await readFile(new URL("./page.html", import.meta.url));
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(html);
        } catch {
          json(res, 503, { error: "Debugger page is not installed" });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/events") {
        const payload = await body(req, max);
        if (
          !isRecord(payload) ||
          !Array.isArray(payload.events) ||
          payload.events.length < 1 ||
          payload.events.length > 100
        )
          throw new Error("events must contain 1..100 records");
        const events = payload.events.map(validateEvent);
        options.log.ingest(events);
        json(res, 200, { ok: true, count: events.length });
        return;
      }
      if (req.method === "POST" && url.pathname === "/policy/reset") {
        const payload = await body(req, max);
        if (
          !isRecord(payload) ||
          Object.keys(payload).some((key) => key !== "branch")
        )
          throw new Error("Expected {branch:string}");
        const branch = text(payload.branch, "branch");
        const policy = options.policy.snapshot();
        if (Object.hasOwn(policy.branches, branch)) {
          const settings = { ...policy.branches[branch] };
          delete settings.threshold;
          delete settings.act;
          delete settings.confirm;
          policy.branches[branch] = settings;
        }
        options.policy.replace(policy);
        json(res, 200, { policy: options.policy.snapshot() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/policy") {
        const patch = await body(req, max);
        if (!isRecord(patch)) throw new Error("Policy must be an object");
        options.policy.update(patch);
        json(res, 200, { policy: options.policy.snapshot() });
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent)
        json(res, (e as { status?: number }).status ?? 400, {
          error: errorMessage(e),
        });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7331, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch((e) => {
    clearInterval(heartbeat);
    unsubscribe();
    policyUnsubscribe();
    throw e;
  });
  const address = server.address();
  const port =
    typeof address === "object" && address
      ? address.port
      : (options.port ?? 7331);
  let closed = false;
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    port,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      policyUnsubscribe();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
