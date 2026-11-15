import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const rt: any = await ModelRuntime.create();
console.log("providers", rt.getRegisteredProviderIds?.());
const models = rt.getModels?.("commandcode");
console.log("models count", Array.isArray(models) ? models.length : String(models?.length));
console.log(JSON.stringify(Array.isArray(models) ? models.slice(0,5).map((m: any) => m.id ?? m.modelId ?? m) : models).slice(0, 400));
