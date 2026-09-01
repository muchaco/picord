import { describe, expect, test } from "vitest";
import { LiveDiscordRunRenderer, type LiveMessagePayload } from "./live-discord-renderer.js";

function createRecordingTarget() {
  const messages: string[] = [];
  const edits: string[] = [];
  const content = (payload: LiveMessagePayload) => payload.content ?? "";

  return {
    messages,
    edits,
    target: {
      createEditable: async (payload: LiveMessagePayload) => {
        const index = messages.push(content(payload)) - 1;
        return {
          edit: async (nextPayload: LiveMessagePayload) => {
            messages[index] = content(nextPayload);
            edits.push(content(nextPayload));
          },
        };
      },
      createFollowUp: async (payload: LiveMessagePayload) => {
        messages.push(content(payload));
      },
    },
  };
}

describe("Discord live report rendering", () => {
  test("the initial live message says that work is in progress", async () => {
    const recording = createRecordingTarget();
    const renderer = new LiveDiscordRunRenderer(recording.target);

    await renderer.showThinkingPlaceholder();

    expect(recording.messages).toEqual(["🟡 Még dolgozom rajta… (1 perc)"]);
  });

  test("text deltas remain hidden until their assistant chunk ends", async () => {
    const recording = createRecordingTarget();
    const renderer = new LiveDiscordRunRenderer(recording.target);
    await renderer.showThinkingPlaceholder();

    await renderer.onUpdate({ type: "assistant_delta", delta: "A feltárás kész; " });
    await renderer.onUpdate({ type: "assistant_delta", delta: "most jön az implementáció." });

    expect(recording.messages).toEqual(["🟡 Még dolgozom rajta… (1 perc)"]);

    await renderer.onUpdate({ type: "assistant_chunk_end" });

    expect(recording.messages).toEqual([
      "A feltárás kész; most jön az implementáció.",
      "🟡 Még dolgozom rajta… (1 perc)",
    ]);
  });

  test("each completed assistant chunk replaces the current status and creates a new status", async () => {
    const recording = createRecordingTarget();
    const renderer = new LiveDiscordRunRenderer(recording.target);
    await renderer.showThinkingPlaceholder();

    await renderer.onUpdate({ type: "assistant_delta", delta: "Első update." });
    await renderer.onUpdate({ type: "assistant_chunk_end" });
    await renderer.onUpdate({ type: "assistant_delta", delta: "Második update." });
    await renderer.onUpdate({ type: "assistant_chunk_end" });

    expect(recording.messages).toEqual([
      "Első update.",
      "Második update.",
      "🟡 Még dolgozom rajta… (1 perc)",
    ]);
    expect(recording.edits).toEqual(["Első update.", "Második update."]);
  });

  test("heartbeat edits the live message without creating a notification message", async () => {
    const recording = createRecordingTarget();
    const renderer = new LiveDiscordRunRenderer(recording.target, { heartbeatIntervalMs: 10 });
    await renderer.showThinkingPlaceholder();

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(recording.messages).toHaveLength(1);
    expect(recording.messages[0]).toContain("Még dolgozom rajta");
    expect(recording.edits.length).toBeGreaterThan(0);
  });

  test("tool activity and hidden reasoning never appear in the live report", async () => {
    const recording = createRecordingTarget();
    const renderer = new LiveDiscordRunRenderer(recording.target);
    await renderer.showThinkingPlaceholder();

    await renderer.onUpdate({ type: "thinking_start" });
    await renderer.onUpdate({
      type: "tool_start",
      toolCallId: "secret-call",
      toolName: "bash",
      args: { command: "cat /internal/secret" },
    });

    expect(recording.messages.join("\n")).not.toMatch(/bash|cat \/internal|secret-call|Thinking/);
  });

  test("multiple assistant turns share one renderer and finalize exactly once", async () => {
    const recording = createRecordingTarget();
    const renderer = new LiveDiscordRunRenderer(recording.target);
    await renderer.showThinkingPlaceholder();
    await renderer.onUpdate({ type: "assistant_delta", delta: "Köztes riport." });
    await renderer.onUpdate({ type: "assistant_chunk_end" });
    await renderer.onUpdate({
      type: "tool_start",
      toolCallId: "second-turn-tool",
      toolName: "bash",
      args: { command: "npm test" },
    });
    await renderer.onUpdate({
      type: "tool_end",
      toolCallId: "second-turn-tool",
      toolName: "bash",
      isError: false,
    });
    await renderer.onUpdate({ type: "assistant_delta", delta: "Második kör." });
    await renderer.onUpdate({ type: "assistant_chunk_end" });

    await renderer.finalize("Köztes riport.Második kör.");
    await renderer.finalize("Ezt már nem szabad kézbesíteni.");

    expect(recording.messages).toEqual([
      "Köztes riport.",
      "Második kör.",
      "🟢 Készen vagyok (1 perc)",
    ]);
    expect(renderer.isFinalDeliverySuccessful()).toBe(true);
  });

  test("finalize does not redeliver an already streamed final chunk after progress reports", async () => {
    const recording = createRecordingTarget();
    const renderer = new LiveDiscordRunRenderer(recording.target);
    await renderer.showThinkingPlaceholder();

    await renderer.onUpdate({ type: "assistant_delta", delta: "Köztes állapot." });
    await renderer.onUpdate({ type: "assistant_chunk_end" });
    await renderer.onUpdate({ type: "assistant_delta", delta: "Végső riport." });
    await renderer.onUpdate({ type: "assistant_chunk_end" });

    await renderer.finalize("Végső riport.");

    expect(recording.messages).toEqual([
      "Köztes állapot.",
      "Végső riport.",
      "🟢 Készen vagyok (1 perc)",
    ]);
    expect(recording.messages.filter((message) => message === "Végső riport.")).toHaveLength(1);
  });

  test("a missing working status falls back to a new report message", async () => {
    const reports: string[] = [];
    const renderer = new LiveDiscordRunRenderer({
      createEditable: async () => {
        throw new Error("Discord status creation failed");
      },
      createFollowUp: async ({ content }) => {
        if (content) reports.push(content);
      },
    });

    await expect(renderer.showThinkingPlaceholder()).rejects.toThrow(
      "Discord status creation failed",
    );
    await renderer.finalize("report");

    expect(reports).toEqual(["report", "🟢 Készen vagyok (1 perc)"]);
    expect(renderer.isFinalDeliverySuccessful()).toBe(true);
  });

  test.each([
    ["message operation", { operationTimeoutMs: 0 }, "Discord message operation timeout must be positive"],
    ["heartbeat", { heartbeatIntervalMs: 0 }, "Discord heartbeat interval must be positive"],
  ])("a non-positive %s timeout is rejected", (_label, options, expected) => {
    const target = createRecordingTarget().target;
    expect(() => new LiveDiscordRunRenderer(target, options)).toThrow(expected);
  });

  test("ending a chunk without assistant text is rejected", async () => {
    const renderer = new LiveDiscordRunRenderer(createRecordingTarget().target);
    await expect(renderer.onUpdate({ type: "assistant_chunk_end" }))
      .rejects.toThrow("Assistant chunk ended without assistant text");
  });
});
