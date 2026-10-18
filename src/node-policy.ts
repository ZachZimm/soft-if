import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  watchFile,
  unwatchFile,
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { Policy as CorePolicy } from "./policy.js";
import type { PolicyData, PolicyInput } from "./types.js";
export class Policy extends CorePolicy {
  private stop?: () => void;
  private path?: string;
  static fromFile(
    path: string,
    options: { watch?: boolean; intervalMs?: number } = {},
  ): Policy {
    const full = resolve(path.replace(/^~(?=\/)/, homedir()));
    const policy = new Policy(JSON.parse(readFileSync(full, "utf8")));
    policy.path = full;
    if (options.watch) {
      const reload = () => {
        try {
          const parsed = CorePolicy.validate(
            JSON.parse(readFileSync(full, "utf8")),
          );
          if (JSON.stringify(parsed) !== JSON.stringify(policy.snapshot()))
            CorePolicy.prototype.replace.call(policy, parsed);
        } catch (e) {
          policy.report(e instanceof Error ? e : new Error(String(e)));
        }
      };
      watchFile(
        full,
        { interval: options.intervalMs ?? 100, persistent: false },
        reload,
      );
      policy.stop = () => unwatchFile(full, reload);
    }
    return policy;
  }
  private persist(data: PolicyData) {
    if (!this.path) return;
    const temp = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", {
        mode: statSync(this.path).mode & 0o777,
      });
      renameSync(temp, this.path);
    } catch (e) {
      try {
        unlinkSync(temp);
      } catch {}
      throw e;
    }
  }
  override update(patch: PolicyInput) {
    const preview = new CorePolicy(this.snapshot());
    preview.update(patch);
    this.persist(preview.snapshot());
    super.update(patch);
  }
  override replace(input: PolicyInput) {
    const data = CorePolicy.validate(input);
    this.persist(data);
    super.replace(data);
  }
  override close() {
    this.stop?.();
    this.stop = undefined;
  }
}
