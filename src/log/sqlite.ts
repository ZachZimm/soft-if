import { DatabaseSync } from "node:sqlite";
import type {
  DecisionRecord,
  BranchRecord,
  OutcomeRecord,
  PolicyChange,
  LogEvent,
  LogSink,
  PolicyData,
  Snapshot,
} from "../types.js";
export interface TimeRange {
  from?: number;
  to?: number;
  limit?: number;
}
const limit = (v: number | undefined, max = 100_000) =>
  Math.max(1, Math.min(max, Math.floor(v ?? max)));
export class SQLiteLog implements LogSink {
  readonly db: DatabaseSync;
  private listeners = new Set<(e: LogEvent) => void>();
  private seenPolicyChanges = new WeakSet<PolicyChange>();
  private ownedPolicy: PolicyData = {
    bands: { act: 0.85, confirm: 0.6 },
    branches: {},
    allowEmulated: false,
  };
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,name TEXT,tick INTEGER,backend TEXT,tier INTEGER,emulated INTEGER,latency_ms REAL,state TEXT,questions TEXT,stale INTEGER DEFAULT 0,error TEXT,record_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS answers(request_id TEXT NOT NULL REFERENCES requests(id),key TEXT NOT NULL,type TEXT,choice TEXT,score REAL,p REAL,confidence REAL,probabilities TEXT,band TEXT,branch TEXT,PRIMARY KEY(request_id,key));
 CREATE TABLE IF NOT EXISTS outcomes(request_id TEXT PRIMARY KEY REFERENCES requests(id),ts INTEGER,payload TEXT);
 CREATE TABLE IF NOT EXISTS policy_changes(ts INTEGER,branch TEXT,before TEXT,after TEXT,policy TEXT);
 CREATE TABLE IF NOT EXISTS branches(request_id TEXT NOT NULL REFERENCES requests(id),key TEXT NOT NULL,branch TEXT NOT NULL,band TEXT,ts INTEGER NOT NULL,value TEXT,UNIQUE(request_id,key,branch,ts));
 CREATE INDEX IF NOT EXISTS request_time ON requests(ts); CREATE INDEX IF NOT EXISTS branch_name ON branches(branch,ts); PRAGMA user_version=1;`);
    const previous = this.db
      .prepare("SELECT policy FROM policy_changes ORDER BY rowid DESC LIMIT 1")
      .get();
    if (previous) this.ownedPolicy = JSON.parse(previous.policy as string);
  }
  private store(event: LogEvent) {
    const r = event.data;
    if (event.type === "decision") {
      const d = event.data;
      const inserted = this.db
        .prepare(
          "INSERT INTO requests(id,ts,name,tick,backend,tier,emulated,latency_ms,state,questions,stale,error,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(
          d.id,
          d.ts,
          d.name ?? null,
          d.tick ?? null,
          d.backend,
          d.tier,
          Number(d.emulated),
          d.latency_ms,
          d.state,
          JSON.stringify(d.questions),
          Number(d.stale),
          d.error ?? null,
          JSON.stringify(d),
        );
      if (!inserted.changes) return false;
      const st = this.db.prepare(
        "INSERT INTO answers(request_id,key,type,choice,score,p,confidence,probabilities,band,branch) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      for (const [key, a] of Object.entries(d.answers))
        st.run(
          d.id,
          key,
          a.type,
          a.type === "choice" ? a.choice : null,
          a.type === "score" ? a.score : null,
          a.type === "noul" ? a.p : null,
          a.confidence,
          JSON.stringify(a.probabilities),
          a.band ?? null,
          a.branch ?? null,
        );
    } else if (event.type === "branch") {
      const d = event.data;
      const a = this.db
        .prepare("SELECT 1 FROM answers WHERE request_id=? AND key=?")
        .get(d.request_id, d.key);
      if (!a) throw new Error("Branch references unknown answer");
      const inserted = this.db
        .prepare(
          "INSERT INTO branches(request_id,key,branch,band,ts,value) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(
          d.request_id,
          d.key,
          d.branch,
          d.band,
          d.ts,
          JSON.stringify(d.value),
        );
      if (!inserted.changes) return false;
      this.db
        .prepare(
          "UPDATE answers SET band=?,branch=? WHERE request_id=? AND key=?",
        )
        .run(d.band, d.branch, d.request_id, d.key);
    } else if (event.type === "outcome") {
      const d = event.data;
      this.db
        .prepare(
          "INSERT INTO outcomes(request_id,ts,payload) VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET ts=excluded.ts,payload=excluded.payload",
        )
        .run(d.request_id, d.ts, JSON.stringify(d.payload));
    } else {
      const d = event.data;
      this.db
        .prepare(
          "INSERT INTO policy_changes(ts,branch,before,after,policy) VALUES(?,?,?,?,?)",
        )
        .run(
          d.ts,
          d.branch,
          JSON.stringify(d.before ?? null),
          JSON.stringify(d.after ?? null),
          JSON.stringify(d.policy),
        );
      this.ownedPolicy = d.policy;
    }
    return true;
  }
  ingest(events: LogEvent[]): void {
    const published: LogEvent[] = [];
    const batchPolicyChanges = new Set<PolicyChange>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        if (event.type === "policy") {
          if (
            this.seenPolicyChanges.has(event.data) ||
            batchPolicyChanges.has(event.data)
          )
            continue;
          batchPolicyChanges.add(event.data);
        }
        if (this.store(event)) published.push(event);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    // Mark only committed changes, before subscribers can observe them again.
    for (const change of batchPolicyChanges) this.seenPolicyChanges.add(change);
    for (const e of published)
      for (const fn of this.listeners) fn(structuredClone(e));
  }
  decision(data: DecisionRecord) {
    this.ingest([{ type: "decision", data }]);
  }
  branch(data: BranchRecord) {
    this.ingest([{ type: "branch", data }]);
  }
  outcome(data: OutcomeRecord) {
    this.ingest([{ type: "outcome", data }]);
  }
  policy(data: PolicyChange) {
    this.ingest([{ type: "policy", data }]);
  }
  get(id: string): DecisionRecord | undefined {
    const row = this.db
      .prepare("SELECT record_json FROM requests WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.record_json as string) : undefined;
  }
  decisions(range: TimeRange = {}): DecisionRecord[] {
    return this.db
      .prepare(
        "SELECT record_json FROM requests WHERE ts>=? AND ts<=? ORDER BY ts,id LIMIT ?",
      )
      .all(
        range.from ?? 0,
        range.to ?? Number.MAX_SAFE_INTEGER,
        limit(range.limit),
      )
      .map((r) => JSON.parse(r.record_json as string));
  }
  branches(range: TimeRange & { branch?: string } = {}): BranchRecord[] {
    const sql =
      "SELECT request_id,key,branch,band,ts,value FROM branches WHERE ts>=? AND ts<=?" +
      (range.branch ? " AND branch=?" : "") +
      " ORDER BY ts,rowid LIMIT ?";
    const params: (string | number)[] = [
      range.from ?? 0,
      range.to ?? Number.MAX_SAFE_INTEGER,
    ];
    if (range.branch) params.push(range.branch);
    params.push(limit(range.limit));
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => ({
        ...r,
        value: JSON.parse(r.value as string),
      })) as unknown as BranchRecord[];
  }
  outcomes(): OutcomeRecord[] {
    return this.db
      .prepare("SELECT * FROM outcomes ORDER BY ts")
      .all()
      .map((r) => ({
        request_id: r.request_id as string,
        ts: r.ts as number,
        payload: JSON.parse(r.payload as string),
      }));
  }
  policyChanges(): PolicyChange[] {
    return this.db
      .prepare("SELECT * FROM policy_changes ORDER BY rowid")
      .all()
      .map((r) => ({
        ts: r.ts as number,
        branch: r.branch as string,
        before: JSON.parse(r.before as string),
        after: JSON.parse(r.after as string),
        policy: JSON.parse(r.policy as string),
      }));
  }
  snapshot(n = 200): Snapshot {
    const count = limit(n, 2000);
    const decisions = this.db
      .prepare(
        "SELECT record_json FROM requests ORDER BY ts DESC,rowid DESC LIMIT ?",
      )
      .all(count)
      .reverse()
      .map((r) => JSON.parse(r.record_json as string));
    return {
      policy: structuredClone(this.ownedPolicy),
      decisions,
      branches: this.db
        .prepare(
          "SELECT request_id,key,branch,band,ts,value FROM branches ORDER BY ts DESC,rowid DESC LIMIT ?",
        )
        .all(count)
        .reverse()
        .map((r) => ({
          ...r,
          value: JSON.parse(r.value as string),
        })) as unknown as BranchRecord[],
      outcomes: this.db
        .prepare("SELECT * FROM outcomes ORDER BY ts DESC LIMIT ?")
        .all(count)
        .reverse()
        .map((r) => ({
          request_id: r.request_id as string,
          ts: r.ts as number,
          payload: JSON.parse(r.payload as string),
        })),
    };
  }
  subscribe(fn: (e: LogEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  close() {
    this.listeners.clear();
    this.db.close();
  }
}
