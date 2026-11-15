import { createAgentSession, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
const HOME = process.env.HOME;
const rt = await ModelRuntime.create({});
console.log("home", HOME);
try {
  const resolved = resolveCliModel({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", modelRuntime: rt } as any);
  console.log("resolved", resolved.error ?? resolved.model?.id, resolved.model?.provider);
  const { session } = await createAgentSession({ cwd: "/tmp", model: resolved.model, modelRuntime: rt, sessionManager: SessionManager.inMemory() });
  const text = await session.prompt("Reply with exactly: ok");
  console.log("OK", String(text).slice(0, 80));
  session.dispose();
} catch (err) {
  console.log("ERR", (err as Error).message.slice(0, 400));
}
