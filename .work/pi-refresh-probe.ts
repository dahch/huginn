import { createAgentSession, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
const rt: any = await ModelRuntime.create({});
console.log("before", rt.getRegisteredProviderIds(), rt.getModels().length);
const res = await rt.refresh();
console.log("refresh", JSON.stringify(res).slice(0, 200));
console.log("after", rt.getModels().length, rt.getAllModels("commandcode").length);
const resolved: any = resolveCliModel({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", modelRuntime: rt });
console.log("resolved", resolved.error ?? resolved.model?.id);
if (resolved.model) {
  const { session } = await createAgentSession({ cwd: "/tmp", model: resolved.model, modelRuntime: rt, sessionManager: SessionManager.inMemory() });
  const text = await session.prompt("Reply with exactly: ok");
  console.log("OK", String(text).slice(0, 60));
  session.dispose();
}
