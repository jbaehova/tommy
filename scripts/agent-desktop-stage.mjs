// Stages the pinned agent-desktop build, the Computer Use driver, for one package target.
//
// electron-builder calls `beforePack` before it copies `extraResources`, once per target, so each
// package carries only its own platform's files. Run directly (`bun run prepare:agent-desktop`), it
// stages the build for this computer, which is what a development checkout reads.
//
// The lock entry is an allowlist: only the files it names leave the archive, and each one must have
// its digest, so an upstream layout change stops the build instead of shipping a surprise file.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const stageDirectory = join(root, ".tommy-build", "agent-desktop");
const cacheDirectory = join(root, ".tommy-build", "agent-desktop-cache");

// builder-util `Arch`: ia32 0, x64 1, armv7l 2, arm64 3, universal 4.
const BUILDER_ARCH = { 1: "x64", 3: "arm64" };

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function lockEntry() {
  const lock = JSON.parse(await readFile(join(root, "native-runtime.lock.json"), "utf8"));
  const entry = lock.agentDesktop;
  if (!entry?.artifacts || !entry.repository || !entry.tag)
    throw new Error("native-runtime.lock.json has no agentDesktop entry.");
  return entry;
}

async function download(url, expected, path) {
  try {
    const cached = await readFile(path);
    if (sha256(cached) === expected) return cached;
  } catch {
    // Not cached yet.
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`Digest mismatch for ${url}: expected ${expected}, got ${actual}.`);
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

/** Writes the driver for one target to `.tommy-build/agent-desktop`, or leaves it empty for a target it has no build for. */
export async function stageAgentDesktop(platform, arch) {
  const entry = await lockEntry();
  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });
  const artifact = entry.artifacts[`${platform}-${arch}`];
  if (!artifact) {
    console.log(`agent-desktop: no pinned build for ${platform}-${arch}; the package has no Computer Use driver.`);
    return;
  }

  const base = `${entry.repository}/releases/download/${entry.tag}`;
  const archive = join(cacheDirectory, artifact.asset);
  await download(`${base}/${artifact.asset}`, artifact.assetSha256, archive);
  const extracted = await mkdtemp(join(root, ".tommy-build", "agent-desktop-extract-"));
  try {
    await run("tar", ["-xzf", archive, "-C", extracted, ...Object.keys(artifact.files)]);
    for (const [name, digest] of Object.entries(artifact.files)) {
      const source = join(extracted, name);
      const actual = sha256(await readFile(source));
      if (actual !== digest) throw new Error(`Digest mismatch for ${name} in ${artifact.asset}.`);
      const target = join(stageDirectory, name);
      await copyFile(source, target);
      await chmod(target, 0o755);
    }
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }

  const licenseUrl = `${entry.repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${entry.tag}/LICENSE`;
  const license = await download(licenseUrl, entry.licenseSha256, join(cacheDirectory, `LICENSE-${entry.tag}`));
  await writeFile(join(stageDirectory, "LICENSE"), license);
  console.log(`agent-desktop: staged ${entry.version} for ${platform}-${arch}.`);
}

export async function beforePack(context) {
  const arch = BUILDER_ARCH[context.arch];
  if (!arch) throw new Error(`agent-desktop: unsupported package architecture ${context.arch}.`);
  await stageAgentDesktop(context.electronPlatformName, arch);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await stageAgentDesktop(process.platform, process.arch);
}
