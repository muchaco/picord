import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import discordPortExtension from "./discord-port/entrypoint.js";

export default function picordExtension(pi: ExtensionAPI) {
  if (process.env.PICORD_DISABLE_NESTED_RUNTIME === "1") return;
  return discordPortExtension(pi);
}