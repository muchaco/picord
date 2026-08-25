import { describe, expect, test, vi } from "vitest";
import { createDiscordExtensionUIContext } from "./extension-bindings.js";

describe("nested extension notifications", () => {
  test("operational notifications are logged without entering the Discord transcript", async () => {
    const onLog = vi.fn();
    const notifyLiveUpdate = vi.fn(async () => undefined);
    const ui = createDiscordExtensionUIContext({
      conversationKey: "discord:guild:guild-1:thread:thread-101",
      onLog,
      notifyLiveUpdate,
    });

    ui.notify("MCP connected: hostinger", "info");
    await Promise.resolve();

    expect(onLog).toHaveBeenCalledWith("info", "MCP connected: hostinger");
    expect(notifyLiveUpdate).not.toHaveBeenCalled();
  });
});
