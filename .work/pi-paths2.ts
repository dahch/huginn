import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
for (const opts of [
  { authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") },
  { authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false },
]) {
  const rt: any = await ModelRuntime.create(opts as any);
  console.log(JSON.stringify(opts).includes("allowModelNetwork") ? "with-explicit-false" : "plain", "providers", rt.getRegisteredProviderIds(), "models", rt.getModels("commandcode").length);
  const r: any = resolveCliModel({ cliProvider: "commandcode", cliModel: "deepseek/deepseek-v4.1-flash", modelRuntime: rt });
  console.log("  resolved", r.error ?? r.model?.id);
}
