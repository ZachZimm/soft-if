import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  SoftIf as CoreSoftIf,
  type SoftIfOptions as CoreOptions,
} from "./softif.js";
import { SQLiteLog } from "./log/sqlite.js";
import { RingLog } from "./log/ring.js";
import { startDebugger } from "./debugger/server.js";
import {
  openaiEmulated as coreOpenAI,
  type OpenAIOptions,
} from "./backends/openai.js";
import type { LogEvent, LogSink } from "./types.js";
export * from "./index.js";
export { Policy } from "./node-policy.js";
export { SQLiteLog } from "./log/sqlite.js";
export { startDebugger } from "./debugger/server.js";
export type { DebuggerOptions } from "./debugger/server.js";
export * from "./replay.js";
export interface SoftIfOptions extends Omit<CoreOptions, "log"> {
  log?: LogSink | { sqlite: string; ring?: number };
  debugger?: { port?: number; host?: string; allowedOrigins?: string[] };
}
export class SoftIf extends CoreSoftIf {
  private owned?: SQLiteLog;
  private debug?: Awaited<ReturnType<typeof startDebugger>>;
  private readiness: Promise<void>;
  private ringUnsubscribe?: () => void;
  readonly ring?: RingLog;
  constructor(options: SoftIfOptions) {
    let owned: SQLiteLog | undefined;
    let ring: RingLog | undefined;
    let log: LogSink | undefined;
    let unsubscribe: (() => void) | undefined;
    if (options.log && "sqlite" in options.log) {
      owned = new SQLiteLog(options.log.sqlite);
      ring = new RingLog(options.log.ring ?? 2000);
      unsubscribe = owned.subscribe((e: LogEvent) => {
        if (e.type === "decision") ring!.decision(e.data);
        else if (e.type === "branch") ring!.branch(e.data);
        else if (e.type === "outcome") ring!.outcome(e.data);
        else ring!.policy(e.data);
      });
      log = owned;
    } else log = options.log;
    if (options.debugger && !owned && !(log instanceof SQLiteLog)) {
      owned = new SQLiteLog(":memory:");
      log = owned;
    }
    super({ ...options, log });
    this.owned = owned;
    this.ring = ring;
    this.ringUnsubscribe = unsubscribe;
    this.readiness = options.debugger
      ? startDebugger({
          policy: this.policy,
          log: log as SQLiteLog,
          ...options.debugger,
          observePolicy: false,
        }).then((s) => {
          this.debug = s;
        })
      : Promise.resolve();
    this.readiness.catch(() => {});
  }
  override ready(): Promise<void> {
    return this.readiness;
  }
  override async close() {
    let failure: unknown;
    try {
      await this.readiness;
    } catch (e) {
      failure = e;
    }
    try {
      await super.close();
    } catch (e) {
      failure ??= e;
    }
    await this.debug?.close();
    this.ringUnsubscribe?.();
    this.owned?.close();
    this.owned = undefined;
    if (failure) throw failure;
  }
}
export interface NodeOpenAIOptions extends OpenAIOptions {
  apiKeyFile?: string;
}
export function openaiEmulated(options: NodeOpenAIOptions) {
  const path = options.apiKeyFile?.replace(/^~(?=\/)/, homedir());
  const apiKey =
    options.apiKey ?? (path ? readFileSync(path, "utf8").trim() : undefined);
  return coreOpenAI({ ...options, apiKey });
}
