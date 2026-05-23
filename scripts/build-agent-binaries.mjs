#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = join(root, "apps/agent/src/cli.ts");
const releaseRoot = join(root, "dist/releases");
const localOutput = join(root, "dist/workspace-viewer-agent");

const targets = {
  "linux-x64": {
    bunTarget: "bun-linux-x64",
    output: "workspace-viewer-agent"
  },
  "linux-arm64": {
    bunTarget: "bun-linux-arm64",
    output: "workspace-viewer-agent"
  },
  "darwin-x64": {
    bunTarget: "bun-darwin-x64",
    output: "workspace-viewer-agent"
  },
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    output: "workspace-viewer-agent"
  },
  "windows-x64": {
    bunTarget: "bun-windows-x64",
    output: "workspace-viewer-agent.exe"
  }
};

const args = process.argv.slice(2);
const selectedTargets = parseTargets(args);

run("pnpm", ["--filter", "@workspace-viewer/protocol", "build"]);

for (const targetName of selectedTargets) {
  const target = targets[targetName];
  const outputPath = join(releaseRoot, targetName, target.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  run("bun", [
    "build",
    "--compile",
    `--target=${target.bunTarget}`,
    `--outfile=${outputPath}`,
    entrypoint
  ]);
  console.log(`built ${targetName}: ${relative(outputPath)}`);
}

const currentTarget = currentPlatformTarget();
if (selectedTargets.includes(currentTarget)) {
  const currentOutput = join(releaseRoot, currentTarget, targets[currentTarget].output);
  await mkdir(dirname(localOutput), { recursive: true });
  await rm(localOutput, { force: true });
  run("cp", [currentOutput, localOutput]);
  console.log(`updated ${relative(localOutput)} from ${currentTarget}`);
}

function parseTargets(values) {
  if (values.includes("--help") || values.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (values.includes("--current")) {
    return [currentPlatformTarget()];
  }

  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--target") {
      const target = values[index + 1];
      if (!target) fail("--target requires a target name");
      result.push(assertTarget(target));
      index += 1;
      continue;
    }
    if (value.startsWith("--target=")) {
      result.push(assertTarget(value.slice("--target=".length)));
      continue;
    }
    fail(`Unknown argument: ${value}`);
  }

  return result.length > 0 ? unique(result) : Object.keys(targets);
}

function currentPlatformTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  fail(`Unsupported current platform: ${platform}-${arch}`);
}

function assertTarget(value) {
  if (!Object.hasOwn(targets, value)) {
    fail(`Unknown target "${value}". Expected one of: ${Object.keys(targets).join(", ")}`);
  }
  return value;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function printHelp() {
  console.log(`Usage:
  node scripts/build-agent-binaries.mjs [--current] [--target <target> ...]

Targets:
  ${Object.keys(targets).join("\n  ")}

Default builds every target into dist/releases/<target>/ and refreshes
dist/workspace-viewer-agent when the current platform target is included.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
