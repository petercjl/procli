import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class CliError extends Error {
  constructor(code, message, details, exitCode = 1) {
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function configPath(env = process.env, platform = process.platform) {
  if (env.PROCLI_CONFIG_PATH) return path.resolve(env.PROCLI_CONFIG_PATH);
  const base =
    platform === "win32"
      ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "procli", "config.json");
}

export async function readConfig(file = configPath()) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      schemaVersion: 1,
      currentProfile: "nas",
      profiles: {},
      ...data,
      profiles: data.profiles || {},
    };
  } catch (error) {
    if (error.code === "ENOENT")
      return { schemaVersion: 1, currentProfile: "nas", profiles: {} };
    if (error instanceof SyntaxError)
      throw new CliError("CONFIG_INVALID", `配置文件不是有效 JSON：${file}`);
    throw error;
  }
}

export async function writeConfig(data, file = configPath()) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

export function normalizeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError("ARGUMENT", "--url 必须是有效的 HTTP(S) 地址");
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new CliError("ARGUMENT", "--url 只支持 HTTP(S)");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function selectedProfileName(options, config, env = process.env) {
  return String(options.profile || env.PROCLI_PROFILE || config.currentProfile || "nas");
}

export function resolveProfile(options, config, env = process.env) {
  const name = selectedProfileName(options, config, env);
  const profile = config.profiles[name];
  if (!profile)
    throw new CliError(
      "PROFILE_NOT_CONFIGURED",
      `Profile “${name}”尚未配置，请先运行 procli profile add ${name} --url <服务地址> --environment development|production`,
      { profile: name },
    );
  return { name, ...profile };
}

function credentialPath(profileName, file = configPath()) {
  if (!/^[a-zA-Z0-9._-]+$/.test(profileName))
    throw new CliError("ARGUMENT", "Profile 名称只能包含字母、数字、点、下划线和连字符");
  return path.join(path.dirname(file), "credentials", `${profileName}.token`);
}

export async function saveToken(profileName, token, file = configPath()) {
  if (!token || token.length < 24)
    throw new CliError("AUTH_FAILED", "服务端没有返回有效的 CLI 凭证");
  const dest = credentialPath(profileName, file);
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const temp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, token, { flag: "wx", mode: 0o600 });
  await fs.rename(temp, dest);
  await fs.chmod(dest, 0o600).catch(() => {});
  return dest;
}

export async function readToken(profileName, file = configPath()) {
  try {
    return (await fs.readFile(credentialPath(profileName, file), "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function deleteToken(profileName, file = configPath()) {
  const dest = credentialPath(profileName, file);
  try {
    await fs.unlink(dest);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
