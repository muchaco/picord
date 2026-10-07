import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

function canonicalPath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

export function getPicordPackageRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

function isUnderRoot(candidatePath: string, root: string): boolean {
  const resolvedCandidate = canonicalPath(candidatePath);
  const resolvedRoot = canonicalPath(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function filterOutPicordExtensions(
  base: LoadExtensionsResult,
  picordRoot: string = getPicordPackageRoot(),
): LoadExtensionsResult {
  // Legacy MCP extensions must not shadow Pi's built-in MCP implementation.
  const excluded = (p: string) =>
    isUnderRoot(p, picordRoot) ||
    p.includes("pi-mcp-access") ||
    isUnderRoot(p, path.join(homedir(), ".pi/agent/extensions/mcp"));
  return {
    extensions: base.extensions.filter((extension) => !excluded(extension.resolvedPath)),
    errors: base.errors.filter((entry) => !excluded(entry.path)),
    runtime: {
      ...base.runtime,
      pendingProviderRegistrations: base.runtime.pendingProviderRegistrations.filter((entry) => {
        return !excluded(entry.extensionPath);
      }),
    },
  };
}
