import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./config.mjs";

export const skillSource = fileURLToPath(new URL("../skill/project-management/", import.meta.url));
const skillName = "project-management";
const packageName = "@petercjl/procli";
const sealSeekDisplay = {
  title: "procli 项目管理",
  description: "用 procli 自然语言解析并安全管理项目、任务、节点与项目知识。",
};

function targetRoot(agent) {
  const roots = {
    codex: path.join(os.homedir(), ".codex", "skills"),
    agents: path.join(os.homedir(), ".agents", "skills"),
    sealseek: path.join(os.homedir(), ".sealseek", "workspaces", process.env.SEALSEEK_WORKSPACE || "default", "skills"),
    openclaw: path.join(os.homedir(), ".openclaw", "skills"),
  };
  if (!roots[agent]) throw new CliError("ARGUMENT", "--agent 必须是 codex、agents、sealseek 或 openclaw");
  return roots[agent];
}

async function digest(root) {
  const hash = crypto.createHash("sha256");
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        hash.update(path.relative(root, full));
        hash.update(await fs.readFile(full));
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function isProcliSource(root) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.resolve(root, "../..", "package.json"), "utf8"));
    return pkg.name === packageName && path.basename(root) === skillName;
  } catch {
    return false;
  }
}

async function readManifest(file, schema) {
  try {
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      throw new CliError("SKILL_MANIFEST_INVALID", `Skill manifest 格式无效：${file}`);
    return { manifest, exists: true };
  } catch (error) {
    if (error.code === "ENOENT") return { manifest: { schema_version: schema, version: Date.now(), skills: {} }, exists: false };
    if (error instanceof SyntaxError) throw new CliError("SKILL_MANIFEST_INVALID", `Skill manifest 不是合法 JSON：${file}`);
    throw error;
  }
}

async function registerManifest(file, schema, version) {
  const { manifest, exists } = await readManifest(file, schema);
  const previous = manifest[skillName] || {};
  manifest[skillName] = {
    ...previous,
    enabled: previous.enabled ?? true,
    channels: previous.channels ?? ["all"],
    source: "customized",
    ...sealSeekDisplay,
    category_name: "项目管理",
    current_version: version,
    updated_at: new Date().toISOString(),
  };
  manifest.version = Date.now();
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (exists) await fs.copyFile(file, `${file}.bak-procli-${Date.now()}-${crypto.randomUUID()}`);
  const temporary = `${file}.procli-${process.pid}-${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}

function sealSeekPaths(root) {
  const workspace = path.dirname(root);
  if (path.basename(root) !== "skills" || path.basename(path.dirname(workspace)) !== "workspaces")
    throw new CliError("SKILL_TARGET_LAYOUT", "SealSeek 目标目录必须是 workspaces/<workspace>/skills，可用 --target-dir 指定");
  const home = path.dirname(path.dirname(workspace));
  return { workspaceManifest: path.join(workspace, "skill.json"), pool: path.join(home, "skill_pool") };
}

async function ensureSealSeekRegistration(root, destination) {
  const { workspaceManifest, pool } = sealSeekPaths(root);
  const metaFile = path.join(destination, ".install-meta.json");
  let currentMeta;
  try { currentMeta = JSON.parse(await fs.readFile(metaFile, "utf8")); } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!currentMeta?.title || !currentMeta?.description)
    await fs.writeFile(metaFile, JSON.stringify(sealSeekDisplay, null, 2) + "\n", { flag: currentMeta ? "w" : "wx" });
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  await registerManifest(workspaceManifest, "workspace-skill-manifest.v1", pkg.version);
  await fs.mkdir(pool, { recursive: true });
  await registerManifest(path.join(pool, "skill.json"), "skill-pool-manifest.v1", pkg.version);
  const poolLink = path.join(pool, skillName);
  try {
    const stat = await fs.lstat(poolLink);
    if (!stat.isSymbolicLink()) throw new CliError("SKILL_TARGET_OCCUPIED", `Skill pool 目标不是软链接：${poolLink}`);
    const resolved = await fs.realpath(poolLink);
    if (resolved === await fs.realpath(destination)) return;
    if (!(await isProcliSource(resolved))) throw new CliError("SKILL_TARGET_OCCUPIED", `Skill pool 已有其他目标：${poolLink}`);
    await fs.unlink(poolLink);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.symlink(destination, poolLink, process.platform === "win32" ? "junction" : "dir");
}

export async function skillStatus(agent, customRoot) {
  const root = customRoot ? path.resolve(customRoot) : targetRoot(agent);
  const destination = path.join(root, skillName);
  const sourceDigest = await digest(skillSource);
  let stat;
  try { stat = await fs.lstat(destination); } catch (error) {
    if (error.code === "ENOENT") return { skill: skillName, source: skillSource, sourceDigest, targetRoot: root, destination, state: "absent", managed: false, current: false };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const resolved = await fs.realpath(destination);
    const current = resolved === await fs.realpath(skillSource);
    const managed = current || await isProcliSource(resolved);
    return { skill: skillName, source: skillSource, sourceDigest, targetRoot: root, destination, state: current ? "current" : managed ? "outdated" : "foreign-link", mode: "link", managed, current, resolved };
  }
  try {
    const marker = JSON.parse(await fs.readFile(path.join(destination, ".procli-managed.json"), "utf8"));
    if (marker.package !== packageName) throw new CliError("SKILL_TARGET_OCCUPIED", `目标已有非 procli 管理的 Skill：${destination}`);
    const current = marker.sourceDigest === sourceDigest;
    return { skill: skillName, source: skillSource, sourceDigest, targetRoot: root, destination, state: current ? "current" : "outdated", mode: "copy", managed: true, current };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError)
      return { skill: skillName, source: skillSource, sourceDigest, targetRoot: root, destination, state: "foreign-directory", mode: "copy", managed: false, current: false };
    throw error;
  }
}

export async function installSkill({ agent, customRoot, mode = "auto", update = false }) {
  const status = await skillStatus(agent, customRoot);
  const selectedMode = mode === "auto" ? (agent === "sealseek" || process.platform === "win32" ? "copy" : "link") : mode;
  if (!["link", "copy"].includes(selectedMode)) throw new CliError("ARGUMENT", "--mode 必须是 auto、link 或 copy");
  if (agent === "sealseek" && selectedMode !== "copy")
    throw new CliError("SKILL_MODE_UNSUPPORTED", "SealSeek 需要实体 Skill 目录，请使用 --mode copy");
  if (agent === "sealseek") sealSeekPaths(status.targetRoot);
  if (status.current && status.mode === selectedMode) {
    if (agent === "sealseek") await ensureSealSeekRegistration(status.targetRoot, status.destination);
    return status;
  }
  if (status.state !== "absent" && !status.managed)
    throw new CliError("SKILL_TARGET_OCCUPIED", `目标已有非 procli 管理的 Skill：${status.destination}`);
  if (status.state !== "absent" && !update)
    throw new CliError("SKILL_UPDATE_REQUIRED", "Skill 已存在，请使用 procli skill update");
  await fs.mkdir(status.targetRoot, { recursive: true });
  const staging = path.join(status.targetRoot, `.project-management-install-${crypto.randomUUID()}`);
  if (selectedMode === "link") await fs.symlink(skillSource, staging, process.platform === "win32" ? "junction" : "dir");
  else {
    await fs.cp(skillSource, staging, { recursive: true, errorOnExist: true });
    await fs.writeFile(path.join(staging, ".procli-managed.json"), JSON.stringify({ sourceDigest: status.sourceDigest, package: packageName }, null, 2) + "\n", { flag: "wx" });
  }
  let backup;
  try {
    if (status.managed) {
      backup = path.join(status.targetRoot, `.project-management-backup-${Date.now()}-${crypto.randomUUID()}`);
      await fs.rename(status.destination, backup);
    }
    await fs.rename(staging, status.destination);
  } catch (error) {
    if (backup) await fs.rename(backup, status.destination);
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (agent === "sealseek") await ensureSealSeekRegistration(status.targetRoot, status.destination);
  return skillStatus(agent, customRoot);
}
