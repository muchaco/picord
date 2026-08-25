import type { Message } from "discord.js";
import type { VoiceTranscriptionConfig } from "../types.js";

const TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function isAudioAttachment(attachment: { contentType?: string | null; name?: string | null }): boolean {
  if (attachment.contentType?.toLowerCase().startsWith("audio/")) {
    return true;
  }

  return /\.(?:ogg|oga|opus|mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(
    attachment.name ?? "",
  );
}

function isNativeVoiceMessage(
  message: Message,
  attachment: { contentType?: string | null; waveform?: string | null; duration?: number | null; name?: string | null },
): boolean {
  if (!isAudioAttachment(attachment)) {
    return false;
  }

  const messageFlags = message.flags as { has?: (flag: string) => boolean } | undefined;
  if (messageFlags?.has?.("IsVoiceMessage")) {
    return true;
  }

  // Discord's native voice-note payload includes both duration and waveform.
  return Boolean(attachment.waveform) && typeof attachment.duration === "number";
}

async function transcribeAttachment(
  url: string,
  filename: string,
  contentType: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Discord audio download failed (${response.status})`);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(`Discord audio attachment is empty: ${filename}`);
  }
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`Discord audio attachment exceeds 25 MB: ${filename}`);
  }

  const form = new FormData();
  form.append("model", model);
  form.append("response_format", "json");
  form.append("file", new Blob([bytes], { type: contentType || "audio/ogg" }), filename);

  const transcription = await fetch(TRANSCRIPTION_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!transcription.ok) {
    const detail = (await transcription.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`OpenAI transcription failed (${transcription.status}): ${detail}`);
  }

  const payload: unknown = await transcription.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("text" in payload) ||
    typeof payload.text !== "string" ||
    payload.text.trim().length === 0
  ) {
    throw new Error("OpenAI transcription returned no text");
  }

  return payload.text.trim();
}

export async function transcribeAudioAttachments(
  message: Message,
  config: Required<VoiceTranscriptionConfig>,
): Promise<string[]> {
  const voiceAttachments = [...message.attachments.values()].filter((attachment) =>
    isNativeVoiceMessage(message, attachment),
  );
  if (!config.enabled || voiceAttachments.length === 0) {
    return [];
  }

  const apiKey = (
    process.env.VOICE_TOOLS_OPENAI_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  );
  if (!apiKey) {
    throw new Error("VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY is required for Discord voice transcription");
  }

  return Promise.all(
    voiceAttachments.map((attachment) =>
      transcribeAttachment(
        attachment.url,
        attachment.name ?? "voice-message.ogg",
        attachment.contentType ?? "audio/ogg",
        apiKey,
        config.model,
      ),
    ),
  );
}
