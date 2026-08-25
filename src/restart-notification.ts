import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RestartNotification {
  channelId: string;
  requestedByUserId: string;
  requestedByTag?: string;
  requestedAt: string;
}

export function resolveRestartNotificationPath(statePath: string): string {
  return `${path.resolve(statePath)}.restart-notification.json`;
}

export function writeRestartNotification(statePath: string, notification: RestartNotification): string {
  const notificationPath = resolveRestartNotificationPath(statePath);
  writeFileSync(notificationPath, `${JSON.stringify(notification, null, 2)}\n`, "utf8");
  return notificationPath;
}

export function readRestartNotification(statePath: string): RestartNotification | undefined {
  const notificationPath = resolveRestartNotificationPath(statePath);
  if (!existsSync(notificationPath)) {
    return undefined;
  }

  const parsed = JSON.parse(readFileSync(notificationPath, "utf8")) as Partial<RestartNotification>;
  if (typeof parsed.channelId !== "string" || typeof parsed.requestedByUserId !== "string" || typeof parsed.requestedAt !== "string") {
    throw new Error(`Invalid restart notification file: ${notificationPath}`);
  }

  return {
    channelId: parsed.channelId,
    requestedByUserId: parsed.requestedByUserId,
    requestedByTag: typeof parsed.requestedByTag === "string" ? parsed.requestedByTag : undefined,
    requestedAt: parsed.requestedAt,
  };
}

export function clearRestartNotification(statePath: string): void {
  const notificationPath = resolveRestartNotificationPath(statePath);
  if (!existsSync(notificationPath)) {
    return;
  }
  rmSync(notificationPath, { force: true });
}

export interface RestartRecovery {
  channelId: string;
  conversationKey: string;
  interruptedAt: string;
}

interface RestartRecoveryFile {
  version: 1;
  entries: RestartRecovery[];
}

export function resolveRestartRecoveryPath(statePath: string): string {
  return `${path.resolve(statePath)}.restart-recovery.json`;
}

function isRestartRecovery(value: unknown): value is RestartRecovery {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RestartRecovery>;
  return (
    typeof entry.channelId === "string" &&
    entry.channelId.length > 0 &&
    typeof entry.conversationKey === "string" &&
    entry.conversationKey.length > 0 &&
    typeof entry.interruptedAt === "string" &&
    entry.interruptedAt.length > 0
  );
}

export function readRestartRecoveries(statePath: string): RestartRecovery[] {
  const recoveryPath = resolveRestartRecoveryPath(statePath);
  if (!existsSync(recoveryPath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(recoveryPath, "utf8")) as Partial<RestartRecoveryFile>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(isRestartRecovery)
    ) {
      throw new Error("invalid recovery journal shape");
    }
    return parsed.entries;
  } catch (error) {
    throw new Error(`Invalid restart recovery file: ${recoveryPath}`, { cause: error });
  }
}

function writeRestartRecoveries(statePath: string, entries: RestartRecovery[]): void {
  const recoveryPath = resolveRestartRecoveryPath(statePath);
  if (entries.length === 0) {
    rmSync(recoveryPath, { force: true });
    return;
  }
  if (!entries.every(isRestartRecovery)) {
    throw new Error("Cannot write an invalid restart recovery entry");
  }

  const temporaryPath = `${recoveryPath}.${process.pid}.tmp`;
  const journal: RestartRecoveryFile = { version: 1, entries };
  writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, recoveryPath);
}

export function enqueueRestartRecoveries(
  statePath: string,
  entries: RestartRecovery[],
): void {
  if (entries.length === 0) return;
  if (!entries.every(isRestartRecovery)) {
    throw new Error("Cannot enqueue an invalid restart recovery entry");
  }

  const byConversation = new Map(
    readRestartRecoveries(statePath).map((entry) => [entry.conversationKey, entry]),
  );
  for (const entry of entries) {
    byConversation.set(entry.conversationKey, entry);
  }
  writeRestartRecoveries(statePath, [...byConversation.values()]);
}

export function acknowledgeRestartRecoveries(
  statePath: string,
  conversationKeys: string[],
): void {
  if (conversationKeys.length === 0) return;
  const acknowledged = new Set(conversationKeys);
  writeRestartRecoveries(
    statePath,
    readRestartRecoveries(statePath).filter(
      (entry) => !acknowledged.has(entry.conversationKey),
    ),
  );
}
