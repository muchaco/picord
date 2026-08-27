import { describe, expect, test, vi } from "vitest";
import type { PiSessionPool } from "../pi-session.js";
import type { PicordRuntimeConfig } from "../types.js";
import {
  abortActiveSession,
  abortAndResetSession,
} from "./interaction-handler.js";
import { PiSessionPoolAdapter } from "./pi-runtime-adapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createAdapter(overrides: Partial<PiSessionPool> = {}) {
  const pool = {
    respond: vi.fn(),
    abort: vi.fn(async () => true),
    steer: vi.fn(async () => true),
    followUp: vi.fn(async () => true),
    hasSessionBinding: vi.fn(() => true),
    ...overrides,
  } as unknown as PiSessionPool;
  const adapter = new PiSessionPoolAdapter(
    {} as PicordRuntimeConfig,
    pool,
    new Map(),
  );
  return { adapter, pool };
}

const request = {
  conversationKey: "discord:guild:1:thread:2",
  workspaceKey: "discord:guild:1:workspace:3",
  sessionName: "long task",
  promptText: "continue",
};

describe("Discord agent runs", () => {
  test("an active run remains running beyond three minutes", async () => {
    vi.useFakeTimers();
    const response = deferred<string>();
    const { adapter, pool } = createAdapter({
      respond: vi.fn(() => response.promise),
    });

    const result = adapter.respond(request);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1);

    expect(pool.abort).not.toHaveBeenCalled();
    response.resolve("finished");
    await expect(result).resolves.toBe("finished");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test("steering forwards native image content to the session pool", async () => {
    const { adapter, pool } = createAdapter();
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
    };

    await expect(
      adapter.steer(request.conversationKey, "inspect", [image]),
    ).resolves.toBe(true);

    expect(pool.steer).toHaveBeenCalledWith(
      request.conversationKey,
      "inspect",
      [image],
    );
  });

  test("follow-up forwards native image content to the session pool", async () => {
    const { adapter, pool } = createAdapter();
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
    };

    await expect(
      adapter.followUp(request.conversationKey, "later", [image]),
    ).resolves.toBe(true);

    expect(pool.followUp).toHaveBeenCalledWith(
      request.conversationKey,
      "later",
      [image],
    );
  });

  test("explicit cancellation still aborts the current run", async () => {
    const { adapter, pool } = createAdapter();

    await expect(adapter.abort(request.conversationKey)).resolves.toBe(true);

    expect(pool.abort).toHaveBeenCalledWith(request.conversationKey);
  });

  test("stopping waits for respond() while preserving the session", async () => {
    let respondDone = false;
    const abort = vi.fn(async () => true);
    const waitForRespondDone = vi.fn(async () => {
      respondDone = true;
    });

    await expect(
      abortActiveSession(
        { abort, waitForRespondDone },
        request.conversationKey,
      ),
    ).resolves.toBe(true);

    expect(abort).toHaveBeenCalledWith(request.conversationKey);
    expect(waitForRespondDone).toHaveBeenCalledWith(request.conversationKey);
    expect(respondDone).toBe(true);
  });

  test("session refresh remains an abort followed by reset", async () => {
    const abort = vi.fn(async () => true);
    const reset = vi.fn(async () => true);

    await abortAndResetSession({ abort, reset }, request.conversationKey);

    expect(abort).toHaveBeenCalledWith(request.conversationKey);
    expect(reset).toHaveBeenCalledWith(request.conversationKey);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(
      reset.mock.invocationCallOrder[0],
    );
  });

  test("finishing and cancellation do not remove the session binding", async () => {
    const hasSessionBinding = vi.fn(() => true);
    const { adapter } = createAdapter({
      respond: vi.fn(async () => "finished"),
      hasSessionBinding,
    });

    await adapter.respond(request);
    await adapter.abort(request.conversationKey);

    expect(adapter.hasBoundSession(request.conversationKey)).toBe(true);
    expect(hasSessionBinding).toHaveBeenCalledWith(request.conversationKey);
  });
});
