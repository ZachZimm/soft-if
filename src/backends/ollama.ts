import { systemone, type SystemOneOptions } from "./systemone.js";
export function ollama(options: SystemOneOptions = {}) {
  return systemone({ model: "clef-flash-q8:latest", ...options }, true);
}
