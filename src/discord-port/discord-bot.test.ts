import { describe, expect, test, vi } from "vitest";
import type { LiveDiscordRunRenderer } from "../live-discord-renderer.js";
import type { DiscordPortRuntimeAdapter } from "./types.js";
import {
  registerReadyLiveRenderer,
  steerActiveDiscordRun,
} from "./discord-bot.js";

function createAdapter(streaming: boolean) {
  return {
    isStreaming: vi.fn(() => streaming),
    steer: vi.fn(async () => true),
    abort: vi.fn(),
    respond: vi.fn(),
    registerLiveRenderer: vi.fn(),
    clearLiveRenderer: vi.fn(),
    sealLiveRenderer: vi.fn(),
  } as unknown as DiscordPortRuntimeAdapter;
}

describe("normal Discord message steering", () => {
  test.each([
    "discord:dm:123",
    "discord:guild:1:thread:456",
  ])("an active %s run is steered without replacing the run", async (conversationKey) => {
    const adapter = createAdapter(true);

    await expect(
      steerActiveDiscordRun(adapter, conversationKey, "new instruction"),
    ).resolves.toBe(true);

    expect(adapter.steer).toHaveBeenCalledWith(conversationKey, "new instruction");
    expect(adapter.abort).not.toHaveBeenCalled();
    expect(adapter.respond).not.toHaveBeenCalled();
    expect(adapter.registerLiveRenderer).not.toHaveBeenCalled();
    expect(adapter.clearLiveRenderer).not.toHaveBeenCalled();
    expect(adapter.sealLiveRenderer).not.toHaveBeenCalled();
  });

  test("steering preserves native image content", async () => {
    const adapter = createAdapter(true);
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
    };

    await steerActiveDiscordRun(adapter, "discord:dm:123", "inspect", [image]);

    expect(adapter.steer).toHaveBeenCalledWith(
      "discord:dm:123",
      "inspect",
      [image],
    );
  });

  test("multiple messages are passed to the native steering queue in order", async () => {
    const adapter = createAdapter(true);
    const conversationKey = "discord:dm:123";

    await Promise.all([
      steerActiveDiscordRun(adapter, conversationKey, "first"),
      steerActiveDiscordRun(adapter, conversationKey, "second"),
      steerActiveDiscordRun(adapter, conversationKey, "third"),
    ]);

    expect(adapter.steer).toHaveBeenNthCalledWith(1, conversationKey, "first");
    expect(adapter.steer).toHaveBeenNthCalledWith(2, conversationKey, "second");
    expect(adapter.steer).toHaveBeenNthCalledWith(3, conversationKey, "third");
    expect(adapter.respond).not.toHaveBeenCalled();
  });

  test("an idle message remains available to start a new respond run", async () => {
    const adapter = createAdapter(false);

    await expect(
      steerActiveDiscordRun(adapter, "discord:dm:123", "start"),
    ).resolves.toBe(false);

    expect(adapter.steer).not.toHaveBeenCalled();
  });

  test("a streaming conversation without a session fails diagnostically", async () => {
    const adapter = createAdapter(true);
    vi.mocked(adapter.steer).mockResolvedValue(false);

    await expect(
      steerActiveDiscordRun(adapter, "discord:dm:123", "continue"),
    ).rejects.toThrow("Streaming conversation has no steerable session");
  });

  test("a failed working status registers no renderer and starts no run", async () => {
    const adapter = createAdapter(false);
    const renderer = {
      showThinkingPlaceholder: vi.fn(async () => {
        throw new Error("Discord status creation failed");
      }),
    } as unknown as LiveDiscordRunRenderer;

    await expect(
      registerReadyLiveRenderer(
        adapter,
        "discord:dm:123",
        renderer,
        7,
      ),
    ).rejects.toThrow("Discord status creation failed");

    expect(adapter.registerLiveRenderer).not.toHaveBeenCalled();
    expect(adapter.respond).not.toHaveBeenCalled();
  });
});
