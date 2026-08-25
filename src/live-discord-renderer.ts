import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import { toDiscordChunks } from "./conversation.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const MESSAGE_OPERATION_TIMEOUT_MS = 10_000;
const WORKING_STATUS = "🟡 Még dolgozom rajta";

export type PiLiveUpdate =
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_chunk_end" }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "run_state"; modelReference?: string; thinkingLevel?: string; supportsThinking?: boolean; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; args?: unknown; detail?: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; args?: unknown; detail?: unknown };

interface ToolEntry {
  callId: string;
  toolName: string;
  line: string;
  status: "running" | "done" | "failed";
  args?: unknown;
  detail?: string;
  outputDetail?: unknown;
}

interface AssistantEntry {
  kind: "assistant";
  text: string;
}

interface ThinkingEntry {
  kind: "thinking";
  text: string;
}

interface ToolTimelineEntry {
  kind: "tool";
  tool: ToolEntry;
}

type TimelineEntry = AssistantEntry | ThinkingEntry | ToolTimelineEntry;

export interface LiveMessagePayload {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;
}

interface EditableMessageHandle {
  edit: (payload: LiveMessagePayload) => Promise<void>;
}

interface LiveMessageTarget {
  createEditable: (payload: LiveMessagePayload) => Promise<EditableMessageHandle>;
  createFollowUp: (payload: LiveMessagePayload) => Promise<void>;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function countTripleBackticks(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

function ensureClosedCodeFence(text: string): string {
  return countTripleBackticks(text) % 2 === 0 ? text : `${text}\n\`\`\``;
}

function reopenFencePrefix(source: string): string {
  const matches = [...source.matchAll(/```([^\n`]*)?/g)];
  if (matches.length === 0 || matches.length % 2 === 0) return "";
  const last = matches[matches.length - 1];
  const language = (last[1] ?? "").trim();
  return language ? `\`\`\`${language}\n` : "```\n";
}

export function normalizeDiscordText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inCodeBlock = false;

  return lines
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }

      if (inCodeBlock) return line;

      if (/^#{1,6}\s+/.test(line)) {
        return `**${line.replace(/^#{1,6}\s+/, "").trim()}**`;
      }

      return line.replace(/^(\s*)[-*]\s+/u, "$1• ");
    })
    .join("\n")
    .trim();
}

export function chunkDiscordMarkdown(text: string, maxLength: number = 2000): string[] {
  const baseChunks = toDiscordChunks(text, maxLength);
  const chunks: string[] = [];
  let carryPrefix = "";

  for (const baseChunk of baseChunks) {
    const withPrefix = `${carryPrefix}${baseChunk}`;
    const closed = ensureClosedCodeFence(withPrefix).trim();
    chunks.push(closed || "Done.");
    carryPrefix = reopenFencePrefix(withPrefix);
  }

  return chunks.length > 0 ? chunks : ["Done."];
}

function summarizeValue(value: unknown, maxLength: number = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function extractPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  return summarizeValue(record.path)
    ?? summarizeValue(record.file_path)
    ?? summarizeValue(record.file)
    ?? summarizeValue(record.target)
    ?? summarizeValue(record.symbol_id)
    ?? summarizeValue(record.cwd);
}

function extractCommandArg(args: unknown): string | undefined {
  if (typeof args === "string") return summarizeValue(args, 100);
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  return summarizeValue(record.command, 100)
    ?? summarizeValue(record.pattern, 100)
    ?? summarizeValue(record.query)
    ?? summarizeValue(record.oldText, 60)
    ?? summarizeValue(record.content, 100)
    ?? summarizeValue(record.error, 100)
    ?? summarizeValue(record.stderr, 100)
    ?? summarizeValue(record.stdout, 100);
}

function formatEditDelta(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const edits = Array.isArray(record.edits) ? record.edits : undefined;
  if (!edits || edits.length === 0) return undefined;

  let added = 0;
  let removed = 0;
  for (const entry of edits) {
    if (!entry || typeof entry !== "object") continue;
    const editEntry = entry as Record<string, unknown>;
    const oldText = typeof editEntry.oldText === "string" ? editEntry.oldText : "";
    const newText = typeof editEntry.newText === "string" ? editEntry.newText : "";
    const oldLines = oldText.length === 0 ? 0 : oldText.split("\n").length;
    const newLines = newText.length === 0 ? 0 : newText.split("\n").length;
    if (newLines > oldLines) added += newLines - oldLines;
    if (oldLines > newLines) removed += oldLines - newLines;
  }

  if (added === 0 && removed === 0) return undefined;
  return `+${added} -${removed}`;
}

export function formatToolCall(toolName: string, args: unknown): string {
  const path = extractPathArg(args);
  const command = extractCommandArg(args);

  if (toolName === "subagent" && args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const scope = typeof record.agentScope === "string" ? ` [${record.agentScope}]` : "";
    if (typeof record.agent === "string") {
      const taskPreview = typeof record.task === "string" ? summarizeValue(record.task, 60) : undefined;
      return taskPreview
        ? `\`subagent\` \`${record.agent}${scope}\` \`${taskPreview}\``
        : `\`subagent\` \`${record.agent}${scope}\``;
    }
    if (Array.isArray(record.tasks)) {
      return `\`subagent\` \`parallel (${record.tasks.length} tasks)${scope}\``;
    }
    if (Array.isArray(record.chain)) {
      return `\`subagent\` \`chain (${record.chain.length} steps)${scope}\``;
    }
    return `\`subagent\`${scope ? ` \`${scope.trim()}\`` : ""}`;
  }

  if (toolName === "bash") {
    const cwd = path && command ? `${path} · ${command}` : command ?? path;
    if (cwd) return `\`bash\` \`${cwd}\``;
  }

  if (toolName === "edit") {
    const delta = formatEditDelta(args);
    if (path && delta) return `\`edit\` \`${path}\` \`${delta}\``;
    if (path) return `\`edit\` \`${path}\``;
  }

  if ((toolName === "read" || toolName === "write" || toolName === "find" || toolName === "ls") && path) {
    return `\`${toolName}\` \`${path}\``;
  }

  if (toolName === "grep") {
    const target = path ? `${path}${command ? ` ${command}` : ""}`.trim() : command;
    if (target) return `\`grep\` \`${target}\``;
  }

  if (path) return `\`${toolName}\` \`${path}\``;
  if (command) return `\`${toolName}\` \`${command}\``;
  return `\`${toolName}\``;
}

export function createChannelLiveMessageTarget(channel: {
  send: (options: { content?: string; embeds?: EmbedBuilder[]; components?: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>; allowedMentions: { parse: [] } }) => Promise<Message>;
}): LiveMessageTarget {
  const send = (payload: LiveMessagePayload) => channel.send({
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    allowedMentions: { parse: [] },
  });

  return {
    createEditable: async (payload) => {
      const message = await send(payload);
      return { edit: async (nextPayload) => { await message.edit(nextPayload); } };
    },
    createFollowUp: async (payload) => { await send(payload); },
  };
}

export function createInteractionLiveMessageTarget(interaction: ChatInputCommandInteraction, ephemeral: boolean = true): LiveMessageTarget {
  const followUp = (payload: LiveMessagePayload) => interaction.followUp({
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    allowedMentions: { parse: [] },
    ephemeral,
  });

  return {
    createEditable: async (payload) => {
      if (interaction.deferred || interaction.replied) {
        const message = await followUp(payload);
        return { edit: async (nextPayload) => { await message.edit(nextPayload); } };
      }

      await interaction.reply({ ...payload, ephemeral });
      return { edit: async (nextPayload) => { await interaction.editReply(nextPayload); } };
    },
    createFollowUp: async (payload) => { await followUp(payload); },
  };
}

export class LiveDiscordRunRenderer {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly timeline: TimelineEntry[] = [];
  private activeAssistantEntry?: AssistantEntry;
  private activeThinkingEntry?: ThinkingEntry;
  private thinkingActive = false;
  private thinkingVisible: boolean;
  private finalized = false;
  private finalDeliverySuccessful = false;
  private runModelReference?: string;
  private runThinkingLevel?: string;
  private runSupportsThinking?: boolean;
  private runContextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };

  private activeStatusMessage?: EditableMessageHandle;
  private readonly startedAt = Date.now();
  private statusTimer?: NodeJS.Timeout;
  private readonly operationTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly target: LiveMessageTarget,
    options?: { thinkingVisible?: boolean; operationTimeoutMs?: number; heartbeatIntervalMs?: number },
  ) {
    this.thinkingVisible = options?.thinkingVisible ?? false;
    this.operationTimeoutMs = options?.operationTimeoutMs ?? MESSAGE_OPERATION_TIMEOUT_MS;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    if (this.operationTimeoutMs <= 0) {
      throw new Error("Discord message operation timeout must be positive");
    }
    if (this.heartbeatIntervalMs <= 0) {
      throw new Error("Discord heartbeat interval must be positive");
    }
  }

  isFinalDeliverySuccessful(): boolean {
    return this.finalDeliverySuccessful;
  }

  /** Create the single live report before any assistant content arrives. */
  async showThinkingPlaceholder(): Promise<void> {
    if (this.activeStatusMessage || this.finalized) return;
    await this.createWorkingStatus();
    this.scheduleStatusUpdate();
  }

  private scheduleStatusUpdate(): void {
    if (this.statusTimer || this.finalized) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      void this.updateStatusMessage();
    }, this.heartbeatIntervalMs);
  }

  private async updateStatusMessage(): Promise<void> {
    if (this.finalized) return;

    try {
      if (!this.activeStatusMessage) {
        throw new Error("Heartbeat cannot update a missing working status message");
      }
      await withTimeout(
        this.activeStatusMessage.edit({ content: this.workingStatus() }),
        this.operationTimeoutMs,
        "Discord working status edit",
      );
    } catch (error) {
      console.error("[picord] Status update failed:", error);
    }
    this.scheduleStatusUpdate();
  }

  setSkillContext(_skillName: string, _args?: string): void {
    // Skill selection is internal runtime metadata, not user-facing progress.
  }

  async showAccessRequest(content: string, requestId?: string): Promise<void> {
    const summaryMatch = content.match(/Requested action:\s*(.+)/);
    const summary = summaryMatch ? summaryMatch[1]?.trim() : content;

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("🔒 Permission Request")
      .setDescription(summary || content)
      .setFooter({ text: requestId ? `Request ID: ${requestId}` : "Action requires owner approval" });

    const payload: LiveMessagePayload = {
      content: "",
      embeds: [embed],
      components: requestId
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`access:once:${requestId}`).setLabel("Allow once").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`access:always:${requestId}`).setLabel("Always allow").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`access:deny:${requestId}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
          )]
        : [],
    };

    await this.target.createFollowUp(payload);
  }

  async onUpdate(update: PiLiveUpdate): Promise<void> {
    if (this.finalized) return;

    if (update.type === "run_state") {
      this.runModelReference = update.modelReference ?? this.runModelReference;
      this.runThinkingLevel = update.thinkingLevel ?? this.runThinkingLevel;
      this.runSupportsThinking = update.supportsThinking ?? this.runSupportsThinking;
      this.runContextUsage = update.contextUsage ?? this.runContextUsage;
      return;
    }

    if (update.type === "assistant_delta") {
      if (!update.delta) return;
      this.activeAssistantEntry ??= this.createAssistantEntry();
      this.activeAssistantEntry.text += update.delta;
      return;
    }

    if (update.type === "assistant_chunk_end") {
      if (!this.activeAssistantEntry) {
        throw new Error("Assistant chunk ended without assistant text");
      }
      if (!this.activeAssistantEntry.text.trim()) {
        throw new Error("Assistant chunk ended with empty assistant text");
      }
      const completedChunk = this.activeAssistantEntry.text;
      this.activeAssistantEntry = undefined;
      await this.replaceStatusWithReport(completedChunk);
      await this.createWorkingStatus();
      return;
    }

    if (update.type === "thinking_start") {
      this.thinkingActive = true;
      if (this.thinkingVisible) {
        this.activeThinkingEntry = { kind: "thinking", text: "" };
        this.timeline.push(this.activeThinkingEntry);
      }
      return;
    }

    if (update.type === "thinking_delta") {
      if (!update.delta) return;
      if (this.thinkingVisible && this.activeThinkingEntry) {
        this.activeThinkingEntry.text += update.delta;
      }
      return;
    }

    if (update.type === "thinking_end") {
      this.thinkingActive = false;
      this.activeThinkingEntry = undefined;
      return;
    }

    // Tool activity is operational detail. Keep it out of the user-facing
    // transcript; failures still reach Discord through the final response.
    if (update.type === "tool_start") {
      const tool: ToolEntry = {
        callId: update.toolCallId,
        toolName: update.toolName,
        line: formatToolCall(update.toolName, update.args),
        status: "running",
        args: update.args,
      };
      this.tools.set(update.toolCallId, tool);
      return;
    }

    if (update.type === "tool_update") {
      const tool = this.tools.get(update.toolCallId);
      if (!tool) return;
      if (update.args !== undefined) {
        tool.args = update.args;
        tool.line = formatToolCall(update.toolName, update.args);
      }
      return;
    }

    if (update.type === "tool_end") {
      const tool = this.tools.get(update.toolCallId);
      if (!tool) return;
      tool.status = update.isError ? "failed" : "done";
      tool.detail = typeof update.detail === "string"
        ? summarizeValue(update.detail, 160)
        : undefined;
      return;
    }
  }

  /**
   * Seal current Discord messages — final flush, then stop editing them.
   * The renderer stays alive to create new follow-up messages for the continuation.
   * Used when the user interrupts mid-stream: their message appears in chat
   * naturally, and the AI continues in a new message below.
   */
  async sealCurrentMessages(): Promise<void> {
    if (this.finalized) return;
    if (this.activeAssistantEntry?.text.trim()) {
      const partialChunk = this.activeAssistantEntry.text;
      this.activeAssistantEntry = undefined;
      await this.replaceStatusWithReport(partialChunk);
      await this.createWorkingStatus();
    }

    this.timeline.length = 0;
    this.activeAssistantEntry = undefined;
    this.activeThinkingEntry = undefined;
    this.tools.clear();
  }

  async finalize(finalResponse: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.thinkingActive = false;

    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
    }

    await this.replaceStatusWithReport(finalResponse || "Done.");
    await withTimeout(
      this.target.createFollowUp({ content: this.completedStatus() }),
      this.operationTimeoutMs,
      "Discord completion notification creation",
    );
    this.finalDeliverySuccessful = true;
  }

  private createAssistantEntry(): AssistantEntry {
    const entry: AssistantEntry = { kind: "assistant", text: "" };
    this.timeline.push(entry);
    return entry;
  }

  private elapsedMinutes(): number {
    return Math.max(1, Math.floor((Date.now() - this.startedAt) / 60_000));
  }

  private workingStatus(): string {
    return `${WORKING_STATUS}… (${this.elapsedMinutes()} perc)`;
  }

  private completedStatus(): string {
    return `🟢 Készen vagyok (${this.elapsedMinutes()} perc)`;
  }

  private async createWorkingStatus(): Promise<void> {
    if (this.activeStatusMessage) {
      throw new Error("Cannot create a second working status message");
    }
    this.activeStatusMessage = await withTimeout(
      this.target.createEditable({ content: this.workingStatus() }),
      this.operationTimeoutMs,
      "Discord working status creation",
    );
  }

  private async replaceStatusWithReport(report: string): Promise<void> {
    const chunks = chunkDiscordMarkdown(normalizeDiscordText(report));
    const statusMessage = this.activeStatusMessage;
    if (!statusMessage) {
      for (const chunk of chunks) {
        await withTimeout(
          this.target.createFollowUp({ content: chunk }),
          this.operationTimeoutMs,
          "Discord report fallback creation",
        );
      }
      return;
    }

    await withTimeout(
      statusMessage.edit({ content: chunks[0] }),
      this.operationTimeoutMs,
      "Discord status-to-report edit",
    );
    this.activeStatusMessage = undefined;
    for (const chunk of chunks.slice(1)) {
      await withTimeout(
        this.target.createFollowUp({ content: chunk }),
        this.operationTimeoutMs,
        "Discord report continuation creation",
      );
    }
  }
}
