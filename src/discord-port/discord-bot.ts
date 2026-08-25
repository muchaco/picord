import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
} from "discord.js";
import {
  LiveDiscordRunRenderer,
  createChannelLiveMessageTarget,
} from "../live-discord-renderer.js";
import { canAccessDiscordMessage } from "./access-control.js";
import { buildPromptFromDiscordMessage, replyToMessage } from "./message-helpers.js";
import { registerDiscordPortInteractionHandler } from "./interaction-handler.js";
import { DiscordPortRuntime } from "./runtime.js";
import type { DiscordPortRuntimeAdapter } from "./types.js";
import type { AccountManager } from "./multi-auth-integration.js";

/**
 * Truncate error messages for display, especially rate limit errors.
 * By default, shows compact 1-line summary. Verbose mode shows full error.
 */
export function truncateErrorMessage(text: string, verbose = false): string {
  if (verbose) {
    return text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
  }

  // Rate limit errors - ultra compact
  if (/\b429\b/i.test(text) || /rate.limit|quota.exceeded/i.test(text)) {
    return "Provider Error: Rate limited.";
  }

  // Multi-auth errors - extract provider name only
  if (/multi-auth rotation/i.test(text)) {
    const m = text.match(/failed for ([\w-]+):/i);
    return m ? `Provider Error: ${m[1]} auth failed.` : "Provider Error: Auth failed.";
  }

  // Discord API errors - hide technical noise
  if (/Unknown Message/i.test(text)) {
    return "Message was deleted or unavailable.";
  }
  if (/Unknown Interaction|Interaction has already been acknowledged/i.test(text)) {
    return "Interaction expired. Please retry the command.";
  }

  // Default: first sentence only, max 150 chars
  const sentence = (text.split(/[.\n]/)[0] || "").trim().replace(/\s+/g, " ");
  return sentence.length > 150 ? sentence.slice(0, 147) + "..." : sentence;
}

function isThreadChannel(channel: Message["channel"]): boolean {
  return (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread
  );
}

function isProjectTextChannel(
  channel: Message["channel"],
  runtime: DiscordPortRuntime,
): channel is TextChannel {
  return (
    channel.type === ChannelType.GuildText &&
    runtime.adapter.isManagedProjectChannel(channel.id)
  );
}

const EMPTY_THREAD_NAME = "picord session";

function getMessagePrompt(message: Message): string {
  return message.content
    .replace(/<@!?(\d+)>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAutoThreadName(message: Message): string {
  return (getMessagePrompt(message) || EMPTY_THREAD_NAME).slice(0, 80);
}

function isPromptlessMention(message: Message): boolean {
  return getMessagePrompt(message).length === 0 && message.attachments.size === 0;
}

function isHostControlChannel(
  message: Message,
  runtime: DiscordPortRuntime,
): boolean {
  if (!message.inGuild()) {
    return false;
  }

  if (runtime.adapter.config.hostChannelId) {
    return message.channelId === runtime.adapter.config.hostChannelId;
  }

  return (
    message.channel.type === ChannelType.GuildText &&
    message.channel.name.toLowerCase() ===
      runtime.adapter.config.hostChannelName
  );
}

export async function steerActiveDiscordRun(
  adapter: DiscordPortRuntimeAdapter,
  conversationKey: string,
  promptText: string,
  promptContent?: import("../types.js").PromptImageContent[],
): Promise<boolean> {
  if (!adapter.isStreaming(conversationKey)) {
    return false;
  }

  const steered = promptContent?.length
    ? await adapter.steer(conversationKey, promptText, promptContent)
    : await adapter.steer(conversationKey, promptText);
  if (!steered) {
    throw new Error(
      `Streaming conversation has no steerable session: ${conversationKey}`,
    );
  }
  return true;
}

export async function registerReadyLiveRenderer(
  adapter: DiscordPortRuntimeAdapter,
  conversationKey: string,
  renderer: LiveDiscordRunRenderer,
  runId?: number,
): Promise<void> {
  await renderer.showThinkingPlaceholder();
  adapter.registerLiveRenderer(conversationKey, renderer, runId);
}

export function createDiscordPortClient(
  enableMessageContent: boolean = true,
): Client {
  return new Client({
    intents: enableMessageContent
      ? [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ]
      : [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
        ],
    partials: [Partials.Channel],
  });
}

export function registerDiscordPortBot({
  client,
  runtime,
  enableMessageContent = true,
  onReload,
  onInfo,
  onWarning,
  onError,
  multiAuthAccountManager,
}: {
  client: Client;
  runtime: DiscordPortRuntime;
  enableMessageContent?: boolean;
  onReload?: () => void;
  onInfo?: (message: string) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
  multiAuthAccountManager?: AccountManager;
}) {
  registerDiscordPortInteractionHandler({
    client,
    runtime,
    _onReload: onReload,
    multiAuthAccountManager,
  });
  const latestRunIds = new Map<string, number>();

  const nextRunId = (conversationKey: string): number => {
    const runId = (latestRunIds.get(conversationKey) ?? 0) + 1;
    latestRunIds.set(conversationKey, runId);
    return runId;
  };

  const isLatestRun = (conversationKey: string, runId: number): boolean =>
    latestRunIds.get(conversationKey) === runId;

  if (enableMessageContent) {
    client.on(Events.MessageCreate, async (message) => {
      try {
        if (message.author.bot) {
          return;
        }

        const promptText = message.content.trim();
        if (!promptText && message.attachments.size === 0) {
          return;
        }

        const access = await canAccessDiscordMessage(
          runtime.adapter.config,
          runtime.adapter,
          message,
        );
        if (!access.allowed) {
          // Only explain the denial when the bot is explicitly mentioned;
          // otherwise stay silent so the channel isn't spammed.
          if (message.mentions.has(client.user?.id ?? "")) {
            await replyToMessage(
              message,
              access.reason ?? "You are not allowed to use this bot here.",
            );
          }
          return;
        }

        if (!message.inGuild()) {
          const conversationKey = `discord:dm:${message.channelId}`;

          const messagePrompt = await buildPromptFromDiscordMessage(message, promptText, runtime.adapter.config);
          if (
            await steerActiveDiscordRun(
              runtime.adapter,
              conversationKey,
              messagePrompt.text,
              messagePrompt.content,
            )
          ) {
            return;
          }











          if ("sendTyping" in message.channel) {
            await message.channel.sendTyping().catch(() => undefined);
          }

          const runId = nextRunId(conversationKey);
          const thinkingVisible = runtime.adapter.getThinkingVisibility(conversationKey);
          const renderer = new LiveDiscordRunRenderer(
            createChannelLiveMessageTarget(message.channel),
            { thinkingVisible },
          );
          await registerReadyLiveRenderer(
            runtime.adapter,
            conversationKey,
            renderer,
            runId,
          );
          try {
            const dmResponse = await runtime.adapter.respond({
              conversationKey,
              workspaceKey: `discord:dm:${message.channelId}`,
              sessionName: `dm-${message.author.username}`,
              promptText: messagePrompt.text,
              promptContent: messagePrompt.content,
              runId,
            });
            if (!isLatestRun(conversationKey, runId)) {
              return;
            }
            await renderer.finalize(dmResponse);
          } catch (error) {
            if (!isLatestRun(conversationKey, runId)) {
              return;
            }
            console.error(`[picord] DM respond failed:
`, error);
          await renderer.finalize(`❌ ${truncateErrorMessage(String(error))}`).catch(() => undefined);
          return;
          } finally {
            runtime.adapter.clearLiveRenderer(conversationKey, renderer);
          }
          return;
        }

        if (isHostControlChannel(message, runtime)) {
          return;
        }

        if (isThreadChannel(message.channel)) {
          const thread = message.channel as Parameters<
            typeof runtime.continueThread
          >[0]["thread"];
          // Unarchive if the thread lapsed into archive while idle, so the
          // response isn't rejected with Discord's archived-thread error.
          if (thread.archived) {
            await thread.setArchived(false).catch(() => undefined);
          }
          if (thread.name === EMPTY_THREAD_NAME && !isPromptlessMention(message)) {
            await thread.setName(buildAutoThreadName(message)).catch(() => undefined);
          }

          const binding = runtime.bindThread(thread);

          const messagePrompt = await buildPromptFromDiscordMessage(message, promptText, runtime.adapter.config);
          if (
            await steerActiveDiscordRun(
              runtime.adapter,
              binding.conversationKey,
              messagePrompt.text,
              messagePrompt.content,
            )
          ) {
            return;
          }

          if ("sendTyping" in message.channel) {
            await message.channel.sendTyping().catch(() => undefined);
          }

          const runId = nextRunId(binding.conversationKey);
          const thinkingVisible = runtime.adapter.getThinkingVisibility(binding.conversationKey);
          const renderer = new LiveDiscordRunRenderer(
            createChannelLiveMessageTarget(thread),
            { thinkingVisible },
          );
          await registerReadyLiveRenderer(
            runtime.adapter,
            binding.conversationKey,
            renderer,
            runId,
          );
          try {
            const response = await runtime.adapter.respond({
              conversationKey: binding.conversationKey,
              workspaceKey: binding.workspaceKey,
              sessionName: binding.sessionName,
              promptText: messagePrompt.text,
              promptContent: messagePrompt.content,
              runId,
            });
            if (!isLatestRun(binding.conversationKey, runId)) {
              return;
            }
            await renderer.finalize(response);
          } catch (error) {
            if (!isLatestRun(binding.conversationKey, runId)) {
              return;
            }
            console.error(`[picord] DM respond failed:
`, error);
          await renderer.finalize(`❌ ${truncateErrorMessage(String(error))}`).catch(() => undefined);
          return;
          } finally {
            runtime.adapter.clearLiveRenderer(
              binding.conversationKey,
              renderer,
            );
          }
          return;
        }

        if (!isProjectTextChannel(message.channel, runtime)) {
          return;
        }

        // Only auto-create threads when the bot is mentioned, so channel
        // chatter doesn't spawn sessions.
        if (!message.mentions.has(client.user?.id ?? "")) {
          return;
        }

        const thread = await message.startThread({
          name: buildAutoThreadName(message),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: "picord auto-started session thread",
        });
        await thread.members.add(message.author.id).catch(() => undefined);

        if (isPromptlessMention(message)) {
          await thread.send(
            "Thread ready. Set the model/thinking level here first, then send your task.",
          );
          return;
        }

        await thread.sendTyping().catch(() => undefined);

        const binding = runtime.bindThread(thread);
        const runId = nextRunId(binding.conversationKey);
        const thinkingVisible = runtime.adapter.getThinkingVisibility(binding.conversationKey);
        const renderer = new LiveDiscordRunRenderer(
          createChannelLiveMessageTarget(thread),
          { thinkingVisible },
        );
        await registerReadyLiveRenderer(
          runtime.adapter,
          binding.conversationKey,
          renderer,
          runId,
        );
        try {
          const initialPrompt = await buildPromptFromDiscordMessage(
            message,
            promptText,
            runtime.adapter.config,
          );
          const response = await runtime.adapter.respond({
            conversationKey: binding.conversationKey,
            workspaceKey: binding.workspaceKey,
            sessionName: binding.sessionName,
            promptText: [
              initialPrompt.text,
              "",
              `[Session thread context]`,
              `ThreadId: ${thread.id}`,
              `WorkspaceChannel: ${thread.parentId ?? "unknown"}`,
            ].join("\n"),
            promptContent: initialPrompt.content,
            runId,
          });
          if (!isLatestRun(binding.conversationKey, runId)) {
            return;
          }
          await renderer.finalize(response);
        } catch (error) {
          if (!isLatestRun(binding.conversationKey, runId)) {
            return;
          }
          console.error(`[picord] DM respond failed:
`, error);
          await renderer.finalize(`❌ ${truncateErrorMessage(String(error))}`).catch(() => undefined);
          return;
        } finally {
          runtime.adapter.clearLiveRenderer(binding.conversationKey, renderer);
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const truncatedText = truncateErrorMessage(text);
        onError?.(`discord-port message flow error: ${truncatedText}`);
        await replyToMessage(message, `picord error: ${truncatedText}`).catch(
          () => undefined,
        );
      }
    });
  }

  client.once(Events.ClientReady, () => {
    onInfo?.(`discord-port connected as ${client.user?.tag ?? "Discord bot"}`);
  });

  client.on(Events.Error, (error) => {
    const text = error instanceof Error ? error.message : String(error);
    const truncatedText = truncateErrorMessage(text);
    if (
      text.includes("Unknown interaction") ||
      text.includes("Interaction has already been acknowledged")
    ) {
      onWarning?.(`discord-port ignored stale interaction error: ${text}`);
      return;
    }
    onError?.(`discord-port client error: ${truncatedText}`);
  });
}

export async function startDiscordPortBot({
  token,
  adapter,
  client,
  enableMessageContent = true,
  onReload,
  onInfo,
  onWarning,
  onError,
  multiAuthAccountManager,
}: {
  token: string;
  adapter: DiscordPortRuntimeAdapter;
  client?: Client;
  enableMessageContent?: boolean;
  onReload?: () => void;
  onInfo?: (message: string) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
  multiAuthAccountManager?: AccountManager;
}) {
  const resolvedClient =
    client ?? createDiscordPortClient(enableMessageContent);
  const runtime = new DiscordPortRuntime(resolvedClient, adapter);
  registerDiscordPortBot({
    client: resolvedClient,
    runtime,
    enableMessageContent,
    onReload,
    onInfo,
    onWarning,
    onError,
    multiAuthAccountManager,
  });
  await resolvedClient.login(token);
  return { client: resolvedClient, runtime };
}
