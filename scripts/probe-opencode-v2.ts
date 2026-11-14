/**
 * Probe the local opencode v2 server: auth scheme, health endpoint, sessions.
 *
 * Kept as a script because the v2 driver is being built against it: the points
 * below are the ones the driver must reproduce, and a regression in the binary
 * (or a v3) should fail here first.
 *
 * What it established (opencode v2.3.0):
 *  - auth is HTTP Basic with user "opencode" and the password the server prints
 *  - the JSON API lives under /api/*; unknown paths answer the web app's HTML 200
 *  - there is no /api/health: /api/session and /api/provider are the cheap probes
 */
import { spawn } from "node:child_process";

const port = 40200 + Math.floor(Math.random() * 500);
const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});

const deadline = Date.now() + 20_000;
while (!/password\s+\S+/.test(output) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const password = /password\s+(\S+)/.exec(output)?.[1];
if (!password) {
  console.error("no password in the server output:\n" + output);
  child.kill();
  process.exit(1);
}
const url = "http://127.0.0.1:" + port;
const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");

async function call(path: string): Promise<void> {
  const res = await fetch(url + path, { headers: { authorization: auth } });
  const text = await res.text();
  const kind = (res.headers.get("content-type") ?? "").includes("json") ? "json" : "non-json";
  let summary = text.slice(0, 160).replace(/\s+/g, " ");
  if (kind === "json") {
    try {
      const body = JSON.parse(text) as { data?: unknown };
      summary = Array.isArray(body.data)
        ? body.data.length + " entries: " + JSON.stringify(body.data[0]).slice(0, 120)
        : JSON.stringify(body).slice(0, 160);
    } catch {
      /* keep the raw slice */
    }
  }
  console.log(res.status + " " + kind + " " + path + " -> " + summary);
}

try {
  await call("/api/session");
  await call("/api/provider");
  await call("/api/health");
} finally {
  child.kill();
}
