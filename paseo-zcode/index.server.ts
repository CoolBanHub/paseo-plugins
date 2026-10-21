import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createZcodeProvider } from "./server/zcode-provider";
import { createZcodeUsageSource } from "./server/zcode-usage";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createZcodeProvider());
  server.registerUsageSource(createZcodeUsageSource());
  return () => {};
}
