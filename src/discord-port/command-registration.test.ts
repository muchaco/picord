import { describe, expect, it } from "vitest";
import { buildDiscordPortCommands } from "./command-registration.js";

describe("buildDiscordPortCommands", () => {
  it("includes the Discord-specific workflow commands we added", () => {
    const commands = buildDiscordPortCommands();
    const names = commands.map((command) => command.name);

    expect(names).toContain("queue");
    expect(names).toContain("add-project");
    expect(names).toContain("add-project-path");
    expect(names).toContain("project-list-available");
    expect(names).toContain("refresh-session");
    expect(names).toContain("abort");
    expect(names).toContain("stop");
    expect(names).toContain("model");
    expect(names).toContain("think");
    expect(names).toContain("session");
    expect(names).toContain("outside-workspace-access");
    expect(names).not.toContain("login-complete");
  });

  it("reserves /queue for native follow-up queueing", () => {
    const commands = buildDiscordPortCommands([
      { name: "queue", description: "skill collision", disableModelInvocation: false },
    ]);
    const queue = commands.find((command) => command.name === "queue");
    const promptOption = queue?.options?.find((option) => option.name === "prompt");

    expect(commands.filter((command) => command.name === "queue")).toHaveLength(1);
    expect(queue?.description).toBe("Queue a prompt to run after pi finishes current work");
    expect(promptOption).toBeDefined();
    expect(promptOption?.required).toBe(true);
  });

  it("registers /stop as an alias of /abort", () => {
    const commands = buildDiscordPortCommands();
    const abort = commands.find((command) => command.name === "abort");
    const stop = commands.find((command) => command.name === "stop");

    expect(stop).toBeDefined();
    expect(stop?.description).toBe(abort?.description);
    expect(stop?.options).toEqual(abort?.options);
  });

  it("registers /model as an alias of /use-model", () => {
    const commands = buildDiscordPortCommands();
    const useModel = commands.find((command) => command.name === "use-model");
    const model = commands.find((command) => command.name === "model");

    expect(useModel).toBeDefined();
    expect(model).toBeDefined();
    expect(model?.description).toBe(useModel?.description);
    expect(model?.options).toEqual(useModel?.options);
  });

  it("does not register duplicate command names from skills", () => {
    const commands = buildDiscordPortCommands([
      { name: "custom", description: "first", disableModelInvocation: false },
      { name: "custom", description: "second", disableModelInvocation: false },
    ]);

    expect(commands.filter((command) => command.name === "custom")).toHaveLength(1);
    expect(commands.find((command) => command.name === "custom")?.description).toBe("first");
  });

  it("registers /think with the expected levels", () => {
    const commands = buildDiscordPortCommands();
    const think = commands.find((command) => command.name === "think");
    const levelOption = think?.options?.find((option) => option.name === "level");
    const choices = levelOption && "choices" in levelOption ? levelOption.choices?.map((choice) => choice.name) : [];

    expect(think).toBeDefined();
    expect(choices).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });
});
