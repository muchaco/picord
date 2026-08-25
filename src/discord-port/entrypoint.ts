import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startDiscordPortExtensionRuntime } from "./extension-bridge.js";

export default function discordPortExtension(pi: ExtensionAPI) {
  let stopHandle: (() => Promise<void>) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const started = await startDiscordPortExtensionRuntime({
      pi,
      cwd: ctx.cwd,
      notify: (message, level = "info") => {
        try {
          ctx.ui.notify(message, level);
        } catch (error) {
          // Headless Pi runs can replace the UI context while Discord remains active.
          // Keep diagnostics visible without letting a stale UI context kill the bot.
          console.error(
            `[picord] ${level}: ${message}`,
            error instanceof Error ? error.message : error,
          );
        }
      },
    });
    stopHandle = started.stop;
  });

  pi.on("session_shutdown", async () => {
    if (stopHandle) {
      await stopHandle();
      stopHandle = undefined;
    }
  });
}
