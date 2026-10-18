import { systemone, type SystemOneOptions } from "./systemone.js";
export function llamacpp(options: SystemOneOptions = {}) {
  return systemone({ url: "http://127.0.0.1:8080", ...options });
}
