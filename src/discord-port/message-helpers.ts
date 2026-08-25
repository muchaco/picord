import type { ChatInputCommandInteraction, Message } from "discord.js";
import { toDiscordChunks } from "../conversation.js";
import type { PicordRuntimeConfig, PromptImageContent, PromptInput } from "../types.js";
import { transcribeAudioAttachments } from "./voice-transcription.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<PromptImageContent["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function sniffImageMime(bytes: Uint8Array): PromptImageContent["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = Buffer.from(bytes.slice(0, 6)).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.slice(0, 4)).toString("ascii");
    const webp = Buffer.from(bytes.slice(8, 12)).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return undefined;
}

async function fetchDiscordImage(
  attachment: { url: string; contentType: string | null; size: number },
): Promise<PromptImageContent> {
  const attachmentUrl = new URL(attachment.url);
  const isDiscordAttachmentHost =
    attachmentUrl.protocol === "https:" &&
    (attachmentUrl.hostname === "cdn.discordapp.com" ||
      attachmentUrl.hostname === "media.discordapp.net");
  if (!isDiscordAttachmentHost) {
    throw new Error("Discord image URL is not an allowed Discord CDN URL");
  }

  const mimeType = attachment.contentType?.split(";", 1)[0].trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType as PromptImageContent["mimeType"])) {
    throw new Error(`Unsupported Discord image MIME type: ${mimeType || "unknown"}`);
  }

  if (attachment.size > MAX_IMAGE_BYTES) {
    throw new Error(`Discord image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Discord image download failed with HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new Error(`Discord image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Discord image download returned an empty response");
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Discord image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }

  const detectedMimeType = sniffImageMime(bytes);
  if (!detectedMimeType) {
    throw new Error("Discord image response does not contain a supported image signature");
  }

  return {
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType: detectedMimeType,
  };
}

export function buildPromptFromMessage(message: Message, promptText: string): string {
  const attachments = [...message.attachments.values()]
    .map((attachment) => `- ${attachment.name ?? "attachment"}: ${attachment.url}`)
    .join("\n");

  return [
    "[Discord message]",
    `Author: ${message.author.tag} (${message.author.id})`,
    message.guild ? `Guild: ${message.guild.name} (${message.guild.id})` : "Guild: DM",
    `Channel: ${message.channel.id}`,
    message.channel.isThread() ? `Thread: ${message.channel.name}` : undefined,
    `Timestamp: ${message.createdAt.toISOString()}`,
    attachments ? `Attachments:\n${attachments}` : undefined,
    "",
    promptText,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export async function buildPromptFromDiscordMessage(
  message: Message,
  promptText: string,
  config: PicordRuntimeConfig,
): Promise<PromptInput> {
  const imageAttachments = [...message.attachments.values()].filter(
    (attachment) => attachment.contentType?.toLowerCase().startsWith("image/"),
  );
  const content = await Promise.all(
    imageAttachments.map((attachment) =>
      fetchDiscordImage({
        url: attachment.url,
        contentType: attachment.contentType,
        size: attachment.size,
      }),
    ),
  );

  const transcriptions = await transcribeAudioAttachments(message, config.voiceTranscription);
  const transcriptionText = transcriptions.length > 0
    ? [
        "[Voice message transcription]",
        ...transcriptions.map((text, index) => `${index + 1}. ${text}`),
      ].join("\n")
    : "";

  return {
    text: buildPromptFromMessage(
      message,
      [promptText, transcriptionText].filter(Boolean).join("\n\n"),
    ),
    content,
  };
}

export function buildPromptFromInteraction(interaction: ChatInputCommandInteraction, promptText: string): string {
  return [
    "[Discord slash command]",
    `Author: ${interaction.user.tag} (${interaction.user.id})`,
    interaction.guild ? `Guild: ${interaction.guild.name} (${interaction.guild.id})` : "Guild: DM",
    `Channel: ${interaction.channelId}`,
    interaction.channel?.isThread() ? `Thread: ${interaction.channel.name}` : undefined,
    `Timestamp: ${new Date().toISOString()}`,
    "",
    promptText,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export async function sendTextResponse(
  channel: { send: (options: { content: string; allowedMentions: { parse: [] } }) => Promise<unknown> },
  content: string,
): Promise<void> {
  const chunks = toDiscordChunks(content || "Done.");
  for (const chunk of chunks) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

export async function replyToMessage(message: Message, content: string): Promise<void> {
  const chunks = toDiscordChunks(content || "Done.");
  const [firstChunk, ...remainingChunks] = chunks;
  if (!firstChunk) {
    return;
  }

  await message.reply({
    content: firstChunk,
    allowedMentions: { parse: [], repliedUser: false },
  });

  for (const chunk of remainingChunks) {
    if ("send" in message.channel) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }
}

export async function replyToInteraction(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const chunks = toDiscordChunks(content || "Done.");
  const [firstChunk, ...remainingChunks] = chunks;
  if (!firstChunk) {
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(firstChunk);
  } else {
    await interaction.reply({ content: firstChunk, ephemeral: true });
  }

  for (const chunk of remainingChunks) {
    await interaction.followUp({ content: chunk, allowedMentions: { parse: [] }, ephemeral: true });
  }
}
