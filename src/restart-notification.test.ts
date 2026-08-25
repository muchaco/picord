import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acknowledgeRestartRecoveries,
  enqueueRestartRecoveries,
  readRestartRecoveries,
  resolveRestartRecoveryPath,
} from "./restart-notification.js";

const temporaryDirectories: string[] = [];

function createStatePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "picord-recovery-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "picord.state.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("restart recovery journal", () => {
  test("queued conversations survive a process restart", () => {
    const statePath = createStatePath();

    enqueueRestartRecoveries(statePath, [
      {
        channelId: "thread-101",
        conversationKey: "discord:guild:guild-1:thread:thread-101",
        interruptedAt: "2026-08-23T21:00:00.000Z",
      },
    ]);

    expect(readRestartRecoveries(statePath)).toEqual([
      {
        channelId: "thread-101",
        conversationKey: "discord:guild:guild-1:thread:thread-101",
        interruptedAt: "2026-08-23T21:00:00.000Z",
      },
    ]);
  });

  test("queueing the same conversation keeps its latest interruption", () => {
    const statePath = createStatePath();
    const conversationKey = "discord:guild:guild-1:thread:thread-101";

    enqueueRestartRecoveries(statePath, [
      { channelId: "thread-101", conversationKey, interruptedAt: "2026-08-23T21:00:00.000Z" },
    ]);
    enqueueRestartRecoveries(statePath, [
      { channelId: "thread-101", conversationKey, interruptedAt: "2026-08-23T21:05:00.000Z" },
    ]);

    expect(readRestartRecoveries(statePath)).toEqual([
      { channelId: "thread-101", conversationKey, interruptedAt: "2026-08-23T21:05:00.000Z" },
    ]);
  });

  test("acknowledging recovered conversations retains unresolved conversations", () => {
    const statePath = createStatePath();
    enqueueRestartRecoveries(statePath, [
      {
        channelId: "thread-101",
        conversationKey: "discord:guild:guild-1:thread:thread-101",
        interruptedAt: "2026-08-23T21:00:00.000Z",
      },
      {
        channelId: "thread-202",
        conversationKey: "discord:guild:guild-1:thread:thread-202",
        interruptedAt: "2026-08-23T21:01:00.000Z",
      },
    ]);

    acknowledgeRestartRecoveries(statePath, [
      "discord:guild:guild-1:thread:thread-101",
    ]);

    expect(readRestartRecoveries(statePath).map((entry) => entry.channelId)).toEqual([
      "thread-202",
    ]);
  });

  test("a malformed recovery journal is rejected", () => {
    const statePath = createStatePath();
    writeFileSync(resolveRestartRecoveryPath(statePath), '{"version":1,"entries":[{"channelId":7}]}\n');

    expect(() => readRestartRecoveries(statePath)).toThrow(
      "Invalid restart recovery file",
    );
  });
});
