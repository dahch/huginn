import { createAgentSession, createAgentSessionServices, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const services: any = await createAgentSessionServices({ cwd: "/tmp", agentDir: dir });
console.log("providers", services.modelRuntime.getRegisteredProviderIds?.());
console.log("models", services.modelRuntime.getModels("commandcode").length, "diag", services.diagnostics?.length);
const resolved: any = resolveCliModel({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", modelRuntime: services.modelRuntime });
console.log("resolved", resolved.error ?? resolved.model?.id);
if (resolved.model) {
  const { session } = await createAgentSession({ cwd: "/tmp", model: resolved.model });
  const text = await session.prompt("Reply with exactly: ok");
  console.log("OK", String(text).slice(0, 60));
  session.dispose();
}
