import { describe, expect, test, vi } from "vitest";
import type { Message } from "discord.js";
import { buildPromptFromDiscordMessage } from "./message-helpers.js";
import type { PicordRuntimeConfig } from "../types.js";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function createImageMessage(
  attachment: Record<string, unknown> = {
    name: "diagram.png",
    url: "https://cdn.discordapp.com/attachments/diagram.png",
    contentType: "image/png",
    size: PNG_SIGNATURE.byteLength,
  },
): Message {
  return {
    author: { tag: "Ada#0001", id: "42" },
    guild: null,
    channel: { id: "dm-1", isThread: () => false },
    createdAt: new Date("2026-08-25T20:00:00.000Z"),
    attachments: new Map([[String(attachment.name), attachment]]),
  } as unknown as Message;
}

const config = {
  voiceTranscription: { enabled: false },
} as unknown as PicordRuntimeConfig;

describe("Discord image prompt content", () => {
  test("a valid image attachment becomes native image content instead of URL-only metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PNG_SIGNATURE, {
      status: 200,
      headers: { "content-type": "image/png" },
    })));

    const prompt = await buildPromptFromDiscordMessage(
      createImageMessage(),
      "What is shown?",
      config,
    );

    expect(prompt.text).toContain("What is shown?");
    expect(prompt.text).toContain("diagram.png");
    expect(prompt.text).toContain("https://cdn.discordapp.com/attachments/diagram.png");
    expect(prompt.content).toEqual([
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      },
    ]);
  });

  test("multiple valid image attachments become multiple native image parts", async () => {
    const secondImage = {
      name: "screenshot.png",
      url: "https://cdn.discordapp.com/attachments/screenshot.png",
      contentType: "image/png",
      size: PNG_SIGNATURE.byteLength,
    };
    const message = createImageMessage();
    message.attachments.set("screenshot.png", secondImage as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PNG_SIGNATURE, { status: 200 })));

    const prompt = await buildPromptFromDiscordMessage(message, "Compare them", config);

    expect(prompt.content).toHaveLength(2);
    expect(prompt.content.every((part) => part.type === "image")).toBe(true);
  });

  test("an unsupported image MIME type fails before downloading the attachment", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      buildPromptFromDiscordMessage(
        createImageMessage({
          name: "vector.svg",
          url: "https://cdn.discordapp.com/attachments/vector.svg",
          contentType: "image/svg+xml",
          size: 10,
        }),
        "Inspect it",
        config,
      ),
    ).rejects.toThrow("Unsupported Discord image MIME type");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("an oversized image fails before downloading the attachment", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      buildPromptFromDiscordMessage(
        createImageMessage({
          name: "huge.png",
          url: "https://cdn.discordapp.com/attachments/huge.png",
          contentType: "image/png",
          size: 33 * 1024 * 1024,
        }),
        "Inspect it",
        config,
      ),
    ).rejects.toThrow("exceeds");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("an HTTP image download failure is reported instead of becoming URL-only context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    await expect(
      buildPromptFromDiscordMessage(createImageMessage(), "Inspect it", config),
    ).rejects.toThrow("HTTP 503");
  });

  test("an empty image response fails instead of creating empty image content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(), { status: 200 })));

    await expect(
      buildPromptFromDiscordMessage(createImageMessage(), "Inspect it", config),
    ).rejects.toThrow("empty response");
  });

  test("a message without images keeps plain text behavior and does not fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const message = createImageMessage({
      name: "notes.txt",
      url: "https://cdn.discordapp.com/attachments/notes.txt",
      contentType: "text/plain",
      size: 12,
    });

    const prompt = await buildPromptFromDiscordMessage(message, "Read this", config);

    expect(prompt.text).toContain("Read this");
    expect(prompt.content).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
