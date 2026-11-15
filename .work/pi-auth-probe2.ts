import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
const auth = JSON.parse(fs.readFileSync(os.homedir() + "/.pi/agent/auth.json", "utf8"));
console.log("auth shape", Object.fromEntries(Object.entries(auth).map(([k, v]: any) => [k, v.type])));
const rt = await ModelRuntime.create();
console.log("rt keys", Object.getOwnPropertyNames(Object.getPrototypeOf(rt)).slice(0, 40));
for (const k of ["getApiKey", "apiKey", "hasApiKey", "getAuth"]) {
  const fn = (rt as any)[k];
  if (typeof fn === "function") { try { console.log(k, String(await fn.call(rt, "commandcode")).slice(0, 20)); } catch (e) { console.log(k, "threw", (e as Error).message.slice(0,80)); } }
}
try {
  const r: any = resolveCliModel({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", modelRuntime: rt });
  console.log("res", JSON.stringify(r, (k, v) => (k === "modelRuntime" ? undefined : v)).slice(0, 500));
} catch (e) { console.log("resolve threw", (e as Error).message.slice(0,200)); }
