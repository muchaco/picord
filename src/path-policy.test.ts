import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { AccessApprovalManager } from "./access-approval.js";
import { extractBashPathTokens, shellTextForPathTokenScan, WorkspaceGuard } from "./path-policy.js";

describe("bash path token extraction", () => {
  test("keeps real unquoted filesystem paths visible to the guard", () => {
    expect(extractBashPathTokens("cat /etc/passwd ./local ../parent ~/.ssh/config .env.local")).toEqual([
      "/etc/passwd",
      "./local",
      "../parent",
      "~/.ssh/config",
      ".env.local",
    ]);
  });

  test("does not treat quoted API routes, URLs, regexes, or issue refs as filesystem paths", () => {
    const command = String.raw`curl "https://example.test/api/items" -d '{"route":"/config/tags","note":"see #18/#19/#20","regex":"/server\\.tool\\(/"}'`;

    expect(extractBashPathTokens(command)).toEqual([]);
  });

  test("does not treat unquoted URL and word-internal slash fragments as filesystem paths", () => {
    const command = "git clone https://github.com/earendil-works/pi.git && echo JSON/YAML && echo route=/config/tags";

    expect(extractBashPathTokens(command)).toEqual([]);
  });

  test("does not scan heredoc bodies as shell path tokens", () => {
    const command = String.raw`cat >payload.json <<'EOF_PAYLOAD'
{"route":"/api/tasks","docs":"JSON/YAML","issues":"#18/#19/#20"}
EOF_PAYLOAD
cat ./payload.json`;

    expect(extractBashPathTokens(command)).toEqual(["./payload.json"]);
  });

  test("masks heredoc bodies before token scanning", () => {
    const command = "python3 - <<'PY'\npath='/api/items'\nprint('JSON/YAML')\nPY";

    expect(shellTextForPathTokenScan(command)).not.toContain("/api/items");
    expect(shellTextForPathTokenScan(command)).not.toContain("JSON/YAML");
  });

  test("does not fail bash authorization for route-like absolute arguments with missing parents", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "picord-path-policy-"));
    try {
      const approvals = new AccessApprovalManager(undefined, async () => {});
      const guard = new WorkspaceGuard(workspaceRoot, undefined, approvals);
      const bash = await guard.createBashOperations({ conversationKey: "c", workspaceKey: "w" });

      await expect(bash.exec("printf '%s\\n' /config/tags", workspaceRoot, { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
