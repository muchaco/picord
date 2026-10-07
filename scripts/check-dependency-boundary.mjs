#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const expectedPiVersion = "1.0.0";
const forbiddenScope = "@mariozechner/pi-";
const failures = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules", "docs"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(target);
      continue;
    }
    if (!entry.name.endsWith(".ts") && entry.name !== "package.json") continue;
    if (fs.readFileSync(target, "utf8").includes(forbiddenScope)) {
      failures.push(`${path.relative(root, target)} references ${forbiddenScope}`);
    }
  }
}

visit(root);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const packageName of [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
]) {
  if (packageJson.devDependencies?.[packageName] !== expectedPiVersion) {
    failures.push(`${packageName} must be pinned to ${expectedPiVersion} in devDependencies`);
  }
  if (!packageJson.peerDependencies?.[packageName]) {
    failures.push(`${packageName} must be declared as a peer dependency`);
  }
  if (packageJson.peerDependenciesMeta?.[packageName]?.optional !== true) {
    failures.push(`${packageName} must be an optional peer to prevent production nesting`);
  }
}

const oldRuntimeDirectory = path.join(root, "node_modules", "@mariozechner");
if (fs.existsSync(oldRuntimeDirectory)) {
  const oldPiPackages = fs.readdirSync(oldRuntimeDirectory).filter((name) => name.startsWith("pi-"));
  if (oldPiPackages.length > 0) {
    failures.push(`old Pi runtime packages are installed: ${oldPiPackages.join(", ")}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Dependency boundary is clean for Pi ${expectedPiVersion}.\n`);
