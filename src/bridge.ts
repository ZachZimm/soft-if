import { Policy } from "./policy.js";
import {
  errorMessage,
  isRecord,
  type LogEvent,
  type LogSink,
  type PolicyData,
} from "./types.js";
export interface BridgeEventSource {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  close(): void;
}
export interface BridgeStatus {
  state: "idle" | "connecting" | "connected" | "error" | "closed";
  pending: number;
  error?: string;
}
export interface BrowserBridgeOptions {
  url?: string;
  policy: Policy;
  fetch?: typeof fetch;
  eventSourceFactory?: (url: string) => BridgeEventSource;
  maxQueue?: number;
}
export function createBrowserBridge(options: BrowserBridgeOptions) {
  const base = (options.url ?? "http://localhost:7331").replace(/\/$/, "");
  const request = options.fetch ?? fetch;
  const queue: LogEvent[] = [];
  let source: BridgeEventSource | undefined;
  let state: BridgeStatus["state"] = "idle",
    lastError: string | undefined;
  let inflight: Promise<void> | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;
  let sourceOpen = false;
  const errors = new Set<(e: Error) => void>(),
    statuses = new Set<(s: BridgeStatus) => void>();
  const status = (): BridgeStatus => ({
    state,
    pending: queue.length,
    error: lastError,
  });
  const notify = () => {
    for (const fn of statuses) {
      try {
        fn(status());
      } catch {}
    }
  };
  const fail = (e: unknown) => {
    const error = e instanceof Error ? e : new Error(errorMessage(e));
    lastError = error.message;
    if (!closed) state = "error";
    for (const fn of errors) {
      try {
        fn(error);
      } catch {}
    }
    notify();
    return error;
  };
  const enqueue = (event: LogEvent) => {
    if (closed) throw fail(new Error("Bridge is closed"));
    if (queue.length >= (options.maxQueue ?? 2000))
      throw fail(new Error("Bridge queue is full"));
    queue.push(structuredClone(event));
    notify();
  };
  const log: LogSink = {
    decision: (data) => enqueue({ type: "decision", data }),
    branch: (data) => enqueue({ type: "branch", data }),
    outcome: (data) => enqueue({ type: "outcome", data }),
    policy: () => {
      /* server owns policy writes; clients receive them through SSE */
    },
  };
  const policy = (data: unknown) => {
    if (!isRecord(data)) throw new Error("Invalid policy event");
    options.policy.replace(data as unknown as PolicyData);
  };
  const flush = (): Promise<void> => {
    if (inflight) return inflight;
    if (!queue.length) return Promise.resolve();
    if (closed) return Promise.reject(fail(new Error("Bridge is closed")));
    const operation = (async () => {
      try {
        while (queue.length) {
          const batch = queue.slice(0, 100);
          const res = await request(`${base}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok)
            throw new Error(
              `Bridge POST /events HTTP ${res.status}: ${(await res.text()).slice(0, 1024)}`,
            );
          const reply = await res.json();
          if (
            !isRecord(reply) ||
            reply.ok !== true ||
            reply.count !== batch.length
          )
            throw new Error("Invalid bridge acknowledgement");
          queue.splice(0, batch.length);
          notify();
        }
        if (sourceOpen) {
          lastError = undefined;
          state = "connected";
        }
        notify();
      } catch (e) {
        throw fail(e);
      }
    })();
    inflight = operation;
    const clear = () => {
      if (inflight === operation) inflight = undefined;
    };
    operation.then(clear, clear);
    return operation;
  };
  const connect = (): Promise<void> => {
    if (connecting) return connecting;
    if (closed) return Promise.reject(fail(new Error("Bridge is closed")));
    if (source && state === "connected") return Promise.resolve();
    const operation = (async () => {
      state = "connecting";
      notify();
      try {
        const res = await request(`${base}/snapshot`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Bridge GET /snapshot HTTP ${res.status}`);
        const snap = await res.json();
        if (!isRecord(snap)) throw new Error("Invalid bridge snapshot");
        policy(snap.policy);
        if (closed) throw new Error("Bridge is closed");
        source?.close();
        sourceOpen = false;
        const factory =
          options.eventSourceFactory ??
          ((url) => new EventSource(url) as unknown as BridgeEventSource);
        source = factory(`${base}/events`);
        source.addEventListener("open", () => {
          if (closed) return;
          sourceOpen = true;
          state = "connected";
          lastError = undefined;
          notify();
        });
        source.addEventListener("error", () => {
          sourceOpen = false;
          if (!closed)
            fail(
              new Error("Bridge SSE connection failed; EventSource will retry"),
            );
        });
        source.addEventListener("policy", (event) => {
          try {
            const c = JSON.parse(event.data);
            policy(c.policy);
          } catch (e) {
            fail(e);
          }
        });
        source.addEventListener("snapshot", (event) => {
          try {
            policy(JSON.parse(event.data).policy);
          } catch (e) {
            fail(e);
          }
        });
        state = "connecting";
        lastError = undefined;
        notify();
      } catch (e) {
        source?.close();
        source = undefined;
        throw fail(e);
      }
    })();
    connecting = operation;
    const clear = () => {
      if (connecting === operation) connecting = undefined;
    };
    operation.then(clear, clear);
    return operation;
  };
  return {
    log,
    connect,
    flush,
    close() {
      closed = true;
      source?.close();
      source = undefined;
      sourceOpen = false;
      state = "closed";
      notify();
    },
    status,
    onError(fn: (e: Error) => void) {
      errors.add(fn);
      return () => errors.delete(fn);
    },
    onStatus(fn: (s: BridgeStatus) => void) {
      statuses.add(fn);
      return () => statuses.delete(fn);
    },
  };
}
