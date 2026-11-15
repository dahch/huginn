import { createAgentSession, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
const t0 = Date.now();
const rt: any = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 20_000 });
console.log("create ms", Date.now() - t0, "models", rt.getModels("commandcode").length);
const resolved: any = resolveCliModel({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", modelRuntime: rt });
console.log("resolved", resolved.error ?? resolved.model?.id);
if (resolved.model) {
  const { session } = await createAgentSession({ cwd: "/tmp", model: resolved.model, modelRuntime: rt, sessionManager: SessionManager.inMemory() });
  const text = await session.prompt("Reply with exactly: ok");
  console.log("OK", String(text).slice(0, 60));
  session.dispose();
}
