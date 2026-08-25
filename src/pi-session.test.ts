import { describe, expect, test, vi } from "vitest";
import { assertRespondCanStart, steerAgentSession } from "./pi-session.js";

describe("Pi session steering", () => {
  test("steering does not abort a running Bash tool", async () => {
    const session = {
      steer: vi.fn(async () => undefined),
      abortBash: vi.fn(),
      isBashRunning: true,
    };

    await steerAgentSession(session, "change course");

    expect(session.steer).toHaveBeenCalledWith("change course");
    expect(session.abortBash).not.toHaveBeenCalled();
  });

  test("the one-at-a-time SDK queue receives every steering message", async () => {
    const session = { steer: vi.fn(async () => undefined) };

    await steerAgentSession(session, "first");
    await steerAgentSession(session, "second");

    expect(session.steer.mock.calls).toEqual([["first"], ["second"]]);
  });
});

describe("respond concurrency invariant", () => {
  test.each([
    ["respond-active", "Concurrent respond() is forbidden"],
    ["session-streaming", "Session is already streaming"],
  ] as const)("%s fails fast with a diagnostic", (state, diagnostic) => {
    expect(() => assertRespondCanStart("discord:dm:123", state)).toThrow(
      diagnostic,
    );
  });

  test("idle state permits respond", () => {
    expect(() => assertRespondCanStart("discord:dm:123", "idle")).not.toThrow();
  });
});
