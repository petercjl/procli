import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import {
  CliError,
  configPath,
  deleteToken,
  normalizeUrl,
  readConfig,
  readToken,
  resolveProfile,
  saveToken,
  selectedProfileName,
  writeConfig,
} from "./config.mjs";
import { inspectTarget, request, uploadRequest } from "./client.mjs";
import { installSkill, skillSource, skillStatus } from "./skill.mjs";

const VERSION = "0.6.0";
const help = `procli ${VERSION} — Agent-first project management CLI

Profile（默认 nas）：
  profile add NAME --url URL --environment development|production
  profile list | current | use NAME | remove NAME

认证：
  auth login [--profile NAME] [--no-open] [--timeout-ms 300000]
  auth status|logout [--profile NAME]

项目：
  directory list
  task list --project PROJECT_NAME
  task get --project PROJECT_NAME --task TASK_NAME
  knowledge context --project PROJECT_NAME --task TASK_NAME
  knowledge source-context --project PROJECT_NAME --knowledge-id ID
  knowledge source-check --project PROJECT_NAME --knowledge-id ID --context-token TOKEN
                         [--idempotency-key KEY] [--dry-run] [--yes]
  knowledge index --project PROJECT_NAME [--node NODE_NAME]
  knowledge compile-context --project PROJECT_NAME --node NODE_NAME
  knowledge compile --project PROJECT_NAME --node NODE_NAME --file CURRENT_MARKDOWN
                    --source-ids ID[,ID...] --change-summary TEXT --context-token TOKEN
                    [--current-version NUMBER] [--idempotency-key KEY] [--dry-run] [--yes]
  knowledge reindex --project PROJECT_NAME --context-token TOKEN
                    [--idempotency-key KEY] [--dry-run] [--yes]
  knowledge ingest --project PROJECT_NAME --task TASK_NAME --title TITLE
                   --source-node DINGTALK_NODE_ID --source-url HTTPS_URL
                   --source-version VERSION --file SOURCE_MARKDOWN --wiki-file KNOWLEDGE_MARKDOWN
                   [--workspace DINGTALK_WORKSPACE_ID] [--platform PLATFORM]
                   [--analysis-date YYYY-MM-DD] [--topics TOPIC[,TOPIC...]]
                   --context-token TOKEN [--idempotency-key KEY] [--dry-run] [--yes]
  knowledge query --project PROJECT_NAME [--node NODE_NAME] [--task TASK_NAME]
                  [--platform PLATFORM] [--topic TOPIC] [--from YYYY-MM-DD]
                  [--to YYYY-MM-DD] [--q SEARCH_TEXT] [--reports]
  node create-context --project PROJECT_NAME
  node create --project PROJECT_NAME --name NODE_NAME --context-token TOKEN
              [--before-node NODE_NAME | --after-node NODE_NAME]
              [--idempotency-key KEY] [--dry-run] [--yes]
  node delete-context --project PROJECT_NAME --node NODE_NAME
  node delete --project PROJECT_NAME --node NODE_NAME --confirm-node NODE_NAME
              [--dependency-policy block|detach]
              [--idempotency-key KEY] [--dry-run] [--yes]
  node restore --deletion-id ID --confirm-node NODE_NAME
               [--idempotency-key KEY] [--dry-run] [--yes]
  task create-context --project PROJECT_NAME
  task update-context --project PROJECT_NAME --task TASK_NAME
  task update --project PROJECT_NAME --task TASK_NAME --context-token TOKEN --task-version NUMBER
              [--owner MEMBER] [--reviewer MEMBER] [--due-date YYYY-MM-DD|--clear-due-date]
              [--priority low|medium|high] [--description TEXT] [--criteria TEXT]
              [--progress 0..100] [--idempotency-key KEY] [--dry-run] [--yes]
  task start|submit|approve|reject --project PROJECT_NAME --task TASK_NAME
              --context-token TOKEN --task-version NUMBER [--reason TEXT]
              [--idempotency-key KEY] [--dry-run] [--yes]
  run start --project PROJECT_NAME --task TASK_NAME --skill SKILL_NAME
            --context-token TOKEN --task-version NUMBER [--skill-version VERSION]
            [--input TEXT] [--idempotency-key KEY] [--dry-run] [--yes]
  run finish-context --project PROJECT_NAME --task TASK_NAME --run-id RUN_ID
  run finish --project PROJECT_NAME --task TASK_NAME --run-id RUN_ID
             --context-token TOKEN --task-version NUMBER --run-version NUMBER
             --status completed|failed [--output TEXT] [--knowledge-id ID]
             [--artifact-id ID] [--quality TEXT] [--idempotency-key KEY]
             [--dry-run] [--yes]
  artifact upload --project PROJECT_NAME --task TASK_NAME --file FILE
                  --context-token TOKEN --task-version NUMBER
                  [--idempotency-key KEY] [--dry-run] [--yes]
  notification list
  notification bind --member MEMBER_ID --dingtalk-user-id USER_ID [--yes]
  notification requeue --id NOTIFICATION_ID --confirm-not-delivered --yes
  notification dispatch [--identity bot|user] [--dry-run] [--yes]
  notification worker [--identity bot|user] [--interval-ms 15000] --yes
  task create --project PROJECT_NAME --node NODE_NAME --title TASK_NAME
              --context-token TOKEN [--description TEXT] [--criteria TEXT]
              [--owner MEMBER] [--reviewer MEMBER] [--priority low|medium|high|低|中|高]
              [--due-date YYYY-MM-DD] [--depends-on TASK_NAME[,TASK_NAME...]]
              [--before-task TASK_NAME | --after-task TASK_NAME]
              [--idempotency-key KEY] [--dry-run] [--yes]
  task delete-context --project PROJECT_NAME --task TASK_NAME
  task delete --project PROJECT_NAME --task TASK_NAME
              --confirm-task TASK_NAME [--dependency-policy block|detach|rewire]
              [--rewire-to TASK_NAME] [--idempotency-key KEY] [--dry-run] [--yes]
  trash list [--project PROJECT_NAME]
  trash get --deletion-id ID
  task restore --deletion-id ID --confirm-task TASK_NAME
               [--idempotency-key KEY] [--dry-run] [--yes]
  project create --name NAME [--goal TEXT] [--type product] [--sop-file FILE]
                 [--mode agent] [--idempotency-key KEY] [--dry-run] [--yes]
  project delete --name NAME --confirm-name NAME --yes
                 [--idempotency-key KEY] [--dry-run]

发现与安装：
  capabilities [--profile NAME]
  doctor [--profile NAME]
  skill source
  skill status|install|update --agent codex|agents|sealseek|openclaw [--mode auto|link|copy]

全局：--profile NAME --json
Profile 选择顺序：--profile > PROCLI_PROFILE > profile use > nas。`;

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      if (
        ["json", "yes", "dry-run", "no-open", "help", "version", "reports",
          "clear-due-date", "confirm-not-delivered"].includes(key)
      )
        options[key] = true;
      else {
        if (!argv[i + 1] || argv[i + 1].startsWith("--"))
          throw new CliError("ARGUMENT", `缺少 --${key} 的值`);
        options[key] = argv[++i];
      }
    } else positional.push(value);
  }
  return { options, positional };
}

function required(options, key) {
  if (typeof options[key] !== "string" || !options[key].trim())
    throw new CliError("ARGUMENT", `缺少 --${key}`);
  return options[key].trim();
}

function output(data, ok = true) {
  console.log(JSON.stringify({ ok, data }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function readSopFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new CliError("SOP_FILE_INVALID", `无法读取 SOP JSON：${file}`, {
      cause: error.message,
    });
  }
  const nodes = Array.isArray(parsed) ? parsed : parsed?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0)
    throw new CliError(
      "SOP_FILE_INVALID",
      "SOP 文件必须是非空节点数组，或包含 nodes 数组",
    );
  nodes.forEach((node, index) => {
    if (typeof node?.name !== "string" || !node.name.trim())
      throw new CliError(
        "SOP_NODE_INCOMPLETE",
        `SOP 第 ${index + 1} 个节点缺少 name`,
      );
    if (typeof node?.description !== "string" || !node.description.trim())
      throw new CliError(
        "SOP_NODE_INCOMPLETE",
        `SOP 节点“${node.name}”缺少 description`,
      );
  });
  return {
    nodes: nodes.map(({ name, description }) => ({
      name: name.trim(),
      description: description.trim(),
    })),
  };
}

async function openUrl(url) {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function sendDingtalkNotification(notification, identity) {
  const executable = process.env.PROCLI_DWS_BIN || "dws";
  const args = ["chat", "+messages-send", "--as", identity,
    "--text", notification.message, "--format", "json", "--yes"];
  if (process.env.PROCLI_DWS_PROFILE)
    args.push("--profile", process.env.PROCLI_DWS_PROFILE);
  if (identity === "bot") {
    const robotCode = process.env.PROCLI_DINGTALK_ROBOT_CODE;
    if (!robotCode)
      throw new CliError("NOTIFICATION_NOT_CONFIGURED",
        "缺少 PROCLI_DINGTALK_ROBOT_CODE，未发送钉钉消息");
    args.push("--robot-code", robotCode, "--users", notification.dingtalkUserId);
  } else if (identity === "user") {
    args.push("--user", notification.dingtalkUserId,
      "--idempotency-key", notification.dedupeKey);
  } else throw new CliError("ARGUMENT", "--identity 只能是 bot 或 user");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString().slice(0, 50000); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 5000); });
    child.on("error", (error) => reject(new CliError("DWS_UNAVAILABLE", error.message)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new CliError("DWS_RESPONSE_UNKNOWN",
        stderr.trim().slice(0, 500) || `dws 退出码 ${code}，需核对投递结果`));
      try {
        const payload = JSON.parse(stdout);
        if (payload.ok === false || payload.error || payload.failed > 0 ||
            payload.failedCount > 0 || payload.data?.failed > 0 ||
            payload.complete === false ||
            (payload.status && payload.status !== "success"))
          return reject(new CliError("DWS_RESPONSE_UNKNOWN",
            "dws 未返回完整成功回执，需核对实际投递结果"));
        resolve({ receipt: crypto.createHash("sha256").update(stdout).digest("hex") });
      } catch {
        reject(new CliError("DWS_RESPONSE_UNKNOWN", "dws 返回无法核验，需人工检查发送结果"));
      }
    });
  });
}

async function fetchDingtalkMarkdown(nodeId) {
  const executable = process.env.PROCLI_DWS_BIN || "dws";
  return new Promise((resolve, reject) => {
    const args = ["doc", "+fetch", "--node", nodeId, "--scope", "full", "--format", "json"];
    if (process.env.PROCLI_DWS_PROFILE)
      args.push("--profile", process.env.PROCLI_DWS_PROFILE);
    const child = spawn(executable, args,
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 5000); });
    child.on("error", (error) => reject(new CliError("DWS_UNAVAILABLE", error.message)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new CliError("DWS_READ_FAILED",
        stderr.trim().slice(0, 500) || `dws 退出码 ${code}`));
      try {
        const payload = JSON.parse(stdout);
        if (payload.complete !== true || payload.status !== "success")
          throw new Error("钉钉正文读取未完整成功");
        const markdown = payload.data?.content?.markdown ?? payload.content?.markdown;
        if (typeof markdown !== "string" || !markdown.trim())
          throw new Error("未得到完整 Markdown 正文");
        resolve(markdown.trim());
      } catch (error) {
        reject(new CliError("DWS_RESPONSE_UNKNOWN", error.message));
      }
    });
  });
}

async function dispatchOneNotification(profile, identity) {
  const claimed = (await request(profile, "/api/v1/notifications/claim",
    { method: "POST", body: {} })).data;
  const item = claimed.notification;
  if (!item) return claimed;
  let result = "delivered";
  let receipt = "";
  let errorMessage = "";
  try {
    receipt = (await sendDingtalkNotification(item, identity)).receipt;
  } catch (error) {
    result = ["DWS_UNAVAILABLE", "NOTIFICATION_NOT_CONFIGURED"]
      .includes(error.code) ? "failed" : "unknown";
    errorMessage = error.message;
  }
  const recorded = await request(profile,
    `/api/v1/notifications/${encodeURIComponent(item.id)}/delivery`,
    { method: "POST", body: { leaseToken: item.leaseToken,
      result, receipt, error: errorMessage } });
  return { notificationId: item.id, ...recorded.data };
}

async function authLogin(profile, options) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const verifierHash = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("hex");
  const started = await request(profile, "/api/auth/cli/start", {
    method: "POST",
    body: { verifierHash, clientName: `procli/${VERSION}` },
    token: "",
  });
  if (!options["no-open"]) await openUrl(started.data.verificationUrl);
  process.stderr.write(
    `请在浏览器完成钉钉授权：${started.data.verificationUrl}\n`,
  );
  const timeoutMs = Math.max(10000, Number(options["timeout-ms"] || 300000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Number(started.data.intervalMs || 1500)),
    );
    const response = await fetch(profile.url + "/api/auth/cli/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: started.data.requestId, verifier }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (response.status === 202) continue;
    if (!response.ok || !payload.ok)
      throw new CliError(
        payload?.error?.code || "AUTH_FAILED",
        payload?.error?.message || "CLI 授权失败",
      );
    await saveToken(profile.name, payload.data.token);
    return {
      profile: profile.name,
      url: profile.url,
      authenticated: true,
      member: payload.data.member,
      expiresAt: payload.data.expiresAt,
    };
  }
  throw new CliError("AUTH_TIMEOUT", "等待钉钉授权超时，请重新运行 auth login");
}

async function resolveProject(profile, name) {
  return (
    await request(
      profile,
      `/api/v1/projects/resolve/by-name?name=${encodeURIComponent(name)}`,
    )
  ).data.project;
}

async function resolveTask(profile, project, name) {
  return (await request(profile,
    `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(name)}`)).data.task;
}

async function taskWriteContext(profile, project, task) {
  return (await request(profile,
    `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/write-context`)).data;
}

const exactKey = (value) =>
  String(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("zh-CN");

function exactNamed(items, reference, fields, code, label) {
  const key = exactKey(reference);
  const matches = items.filter((item) =>
    fields.some((field) => exactKey(item[field]) === key),
  );
  if (!matches.length) throw new CliError(code, `${label}不存在：${reference}`);
  if (matches.length > 1)
    throw new CliError(`${code}_AMBIGUOUS`, `${label}不唯一：${reference}`, {
      candidates: matches.map((item) => ({
        id: item.id,
        title: item.title,
        name: item.name,
      })),
    });
  return matches[0];
}

async function taskCreateContext(profile, project) {
  return (
    await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/task-create-context`,
    )
  ).data;
}

async function nodeCreateContext(profile, project) {
  return (
    await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/node-create-context`,
    )
  ).data;
}

function taskCreateInput(options, context) {
  const node = exactNamed(
    context.nodes,
    required(options, "node"),
    ["name"],
    "NODE_NOT_FOUND",
    "节点",
  );
  const resolveTask = (name) =>
    exactNamed(context.tasks, name, ["id", "title"], "TASK_NOT_FOUND", "任务");
  const dependencies = String(options["depends-on"] || "")
    .split(/[,，]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((name) => resolveTask(name).id);
  const before = options["before-task"]
    ? resolveTask(options["before-task"])
    : null;
  const after = options["after-task"]
    ? resolveTask(options["after-task"])
    : null;
  if (before && after)
    throw new CliError(
      "ARGUMENT",
      "--before-task 和 --after-task 不能同时使用",
    );
  return {
    contextToken: required(options, "context-token"),
    title: required(options, "title"),
    stage: node.name,
    description: options.description || "",
    criteria: options.criteria || "",
    owner: options.owner || "",
    reviewer: options.reviewer || "",
    priority: options.priority || "medium",
    dueDate: options["due-date"] || "",
    skill: options.skill || "",
    dependencies,
    beforeTaskId: before?.id || "",
    afterTaskId: after?.id || "",
  };
}

export async function main(argv) {
  const { options, positional } = parseArgs(argv);
  const [group, command] = positional;
  if (options.version || group === "version")
    return output({ version: VERSION });
  if (!group || group === "help" || options.help) return console.log(help);
  const file = configPath();
  const config = await readConfig(file);

  if (group === "profile") {
    if (command === "add") {
      const name = positional[2];
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name))
        throw new CliError("ARGUMENT", "请提供有效 Profile 名称");
      const environment = required(options, "environment");
      if (!["development", "production"].includes(environment))
        throw new CliError(
          "ARGUMENT",
          "--environment 必须是 development 或 production",
        );
      const candidate = {
        name,
        url: normalizeUrl(required(options, "url")),
        environment,
      };
      const target = await inspectTarget(candidate);
      config.profiles[name] = {
        url: candidate.url,
        environment,
        instanceId: target.instanceId,
      };
      await writeConfig(config, file);
      return output({
        profile: name,
        ...config.profiles[name],
        verified: true,
      });
    }
    if (command === "list")
      return output({
        currentProfile: config.currentProfile || "nas",
        profiles: config.profiles,
      });
    if (command === "current") {
      const name = selectedProfileName(options, config);
      return output({
        selectedBy: options.profile
          ? "flag"
          : process.env.PROCLI_PROFILE
            ? "environment"
            : "default",
        profile: name,
        ...(config.profiles[name] || { configured: false }),
      });
    }
    if (command === "use") {
      const name = positional[2];
      if (!config.profiles[name])
        throw new CliError(
          "PROFILE_NOT_CONFIGURED",
          `Profile “${name}”尚未配置`,
        );
      config.currentProfile = name;
      await writeConfig(config, file);
      return output({ currentProfile: name, ...config.profiles[name] });
    }
    if (command === "remove") {
      const name = positional[2];
      if (!config.profiles[name])
        throw new CliError(
          "PROFILE_NOT_CONFIGURED",
          `Profile “${name}”尚未配置`,
        );
      delete config.profiles[name];
      if (config.currentProfile === name) config.currentProfile = "nas";
      await writeConfig(config, file);
      await deleteToken(name, file);
      return output({ removed: name, currentProfile: config.currentProfile });
    }
    throw new CliError("UNKNOWN_COMMAND", "未知 profile 命令");
  }

  if (group === "skill") {
    if (command === "source")
      return output({ skill: "project-management", source: skillSource });
    const agent = options.agent || "";
    if (command === "status")
      return output(await skillStatus(agent, options["target-dir"]));
    if (command === "install")
      return output(
        await installSkill({
          agent,
          customRoot: options["target-dir"],
          mode: options.mode || "auto",
        }),
      );
    if (command === "update")
      return output(
        await installSkill({
          agent,
          customRoot: options["target-dir"],
          mode: options.mode || "auto",
          update: true,
        }),
      );
    throw new CliError("UNKNOWN_COMMAND", "未知 skill 命令");
  }

  const profile = resolveProfile(options, config);
  if (group === "doctor") {
    const checks = {
      node: {
        ok: Number(process.versions.node.split(".")[0]) >= 20,
        version: process.versions.node,
      },
      config: { ok: true, path: file },
      profile: { ok: true, ...profile },
    };
    try {
      checks.server = { ok: true, ...(await inspectTarget(profile)) };
    } catch (error) {
      checks.server = { ok: false, code: error.code, message: error.message };
    }
    const token = await readToken(profile.name, file);
    if (!token) checks.auth = { ok: false, code: "AUTH_REQUIRED" };
    else {
      try {
        checks.auth = {
          ok: true,
          ...(await request(profile, "/api/auth/cli/status", { token })).data,
        };
      } catch (error) {
        checks.auth = { ok: false, code: error.code, message: error.message };
      }
    }
    const ok = Object.values(checks).every((item) => item.ok);
    return output({ checks }, ok);
  }
  if (group === "capabilities") {
    const manifest = JSON.parse(
      await fs.readFile(
        new URL("../capabilities.json", import.meta.url),
        "utf8",
      ),
    );
    let server;
    try {
      server = (await request(profile, "/api/capabilities", { token: "" }))
        .data;
    } catch (error) {
      server = { available: false, code: error.code };
    }
    return output({
      cli: manifest,
      server,
      target: await inspectTarget(profile),
    });
  }
  if (group === "auth") {
    if (command === "login") return output(await authLogin(profile, options));
    if (command === "status") {
      const token = await readToken(profile.name, file);
      if (!token)
        throw new CliError(
          "AUTH_REQUIRED",
          `Profile “${profile.name}”尚未登录`,
        );
      return output({
        profile: profile.name,
        url: profile.url,
        ...(await request(profile, "/api/auth/cli/status", { token })).data,
      });
    }
    if (command === "logout") {
      const token = await readToken(profile.name, file);
      if (token)
        await request(profile, "/api/auth/cli/revoke", {
          method: "POST",
          token,
        }).catch(() => {});
      const removed = await deleteToken(profile.name, file);
      return output({
        profile: profile.name,
        loggedOut: true,
        localCredentialRemoved: removed,
      });
    }
    throw new CliError("UNKNOWN_COMMAND", "未知 auth 命令");
  }
  if (group === "notification") {
    const target = await inspectTarget(profile);
    if (command === "list") {
      const result = await request(profile, "/api/v1/notifications/outbox");
      return output({ target, notifications: result.data });
    }
    if (command === "bind") {
      const memberId = required(options, "member");
      const dingtalkUserId = required(options, "dingtalk-user-id");
      if (target.environment === "production" && !options.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "生产环境成员路由绑定需 --yes");
      const result = await request(profile,
        `/api/v1/notifications/members/${encodeURIComponent(memberId)}/routing`,
        { method: "PUT", body: { dingtalkUserId },
          idempotencyKey: options["idempotency-key"] || crypto.randomUUID() });
      return output({ target, ...result.data });
    }
    if (command === "requeue") {
      if (!options["confirm-not-delivered"] || !options.yes)
        throw new CliError("CONFIRMATION_REQUIRED",
          "人工核对钉钉中未投递后，使用 --confirm-not-delivered --yes");
      const id = required(options, "id");
      const result = await request(profile,
        `/api/v1/notifications/${encodeURIComponent(id)}/requeue`,
        { method: "POST", body: { confirmNotDelivered: true },
          idempotencyKey: options["idempotency-key"] || crypto.randomUUID() });
      return output({ target, ...result.data });
    }
    if (command === "dispatch" || command === "worker") {
      const identity = options.identity || "bot";
      if (!["bot", "user"].includes(identity))
        throw new CliError("ARGUMENT", "通知身份只能为 bot 或 user");
      if (options["dry-run"]) {
        const result = await request(profile, "/api/v1/notifications/outbox");
        return output({ target, identity, dryRun: true, notifications: result.data });
      }
      if (!options.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "发送钉钉消息需要 --yes 确认");
      if (identity === "bot" && !process.env.PROCLI_DINGTALK_ROBOT_CODE)
        throw new CliError("NOTIFICATION_NOT_CONFIGURED",
          "缺少 PROCLI_DINGTALK_ROBOT_CODE，未领取通知");
      if (command === "dispatch")
        return output({ target, identity, ...(await dispatchOneNotification(profile, identity)) });
      const intervalMs = Number(options["interval-ms"] || 15000);
      if (!Number.isInteger(intervalMs) || intervalMs < 5000)
        throw new CliError("ARGUMENT", "轮询间隔至少 5000 毫秒");
      process.stderr.write(`通知 worker 已启动：${target.profile} / ${identity}\n`);
      while (true) {
        const result = await dispatchOneNotification(profile, identity);
        if (result.notificationId || result.skipped)
          process.stdout.write(JSON.stringify({ target, ...result }) + "\n");
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    throw new CliError("UNKNOWN_COMMAND", "未知 notification 命令");
  }
  if (group === "directory" && command === "list") {
    const target = await inspectTarget(profile);
    const result = await request(profile, "/api/v1/directory");
    return output({ target, ...result.data });
  }
  if (group === "task" && command === "list") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const result = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks`,
    );
    return output({ target, ...result.data });
  }
  if (group === "task" && command === "get") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const taskName = required(options, "task");
    const result = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(taskName)}`,
    );
    return output({ target, ...result.data });
  }
  if (group === "knowledge" && command === "context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const task = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(required(options, "task"))}`,
    );
    const result = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/context?taskId=${encodeURIComponent(task.data.task.id)}`,
    );
    return output({ target, ...result.data });
  }
  if (group === "knowledge" && ["source-context", "source-check"].includes(command)) {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const knowledgeId = required(options, "knowledge-id");
    const prefix = `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge`;
    const context = (await request(profile,
      `${prefix}/${encodeURIComponent(knowledgeId)}/source-context`)).data;
    if (command === "source-context") return output({ target, ...context });
    const contextToken = required(options, "context-token");
    if (contextToken !== context.contextToken)
      throw new CliError("PROJECT_STATE_CHANGED", "知识来源状态已变化，请重新读取 source-context");
    const markdown = await fetchDingtalkMarkdown(context.source.nodeId);
    const observedContentHash = crypto.createHash("sha256").update(markdown).digest("hex");
    const observedVersion = `sha256:${observedContentHash}`;
    const body = { contextToken, knowledgeId, observedVersion, observedContentHash };
    const preview = await request(profile, `${prefix}/source-check-preview`,
      { method: "POST", body });
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED",
        "目标是生产环境；确认记录钉钉来源检查结果后增加 --yes");
    const written = await request(profile, `${prefix}/source-check`,
      { method: "POST", body, idempotencyKey });
    const readback = (await request(profile,
      `${prefix}/${encodeURIComponent(knowledgeId)}/source-context`)).data;
    if (readback.source.observedContentHash !== observedContentHash ||
        readback.source.syncStatus !== written.data.syncStatus)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "知识来源检查后回读不一致");
    return output({ target, idempotencyKey, ...written.data,
      verification: "knowledge-source-check-after-readback" });
  }
  if (group === "knowledge" && command === "index") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const params = new URLSearchParams();
    if (options.node) params.set("node", options.node);
    const result = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/index?${params}`);
    return output({ target, ...result.data });
  }
  if (group === "knowledge" && command === "compile-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const node = required(options, "node");
    const result = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/compile/context?node=${encodeURIComponent(node)}`);
    return output({ target, ...result.data });
  }
  if (group === "knowledge" && command === "compile") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    let content;
    try { content = await fs.readFile(required(options, "file"), "utf8"); }
    catch (error) {
      throw new CliError("WIKI_FILE_INVALID", "无法读取当前知识正文文件", { cause: error.message });
    }
    const sourceIds = required(options, "source-ids").split(",")
      .map((value) => value.trim()).filter(Boolean);
    const input = {
      node: required(options, "node"), content, sourceIds,
      changeSummary: required(options, "change-summary"),
      contextToken: required(options, "context-token"),
      currentVersion: options["current-version"] == null ? null :
        Number(options["current-version"]),
    };
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    const preview = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/compile/preview`,
      { method: "POST", body: input });
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED",
        "目标是生产环境；确认更新节点当前知识后请增加 --yes",
        { target, preview: preview.data });
    const written = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/compile`,
      { method: "POST", body: input, idempotencyKey, timeoutMs: 30000 });
    const readback = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/query?node=${encodeURIComponent(input.node)}`);
    const result = readback.data.results[0];
    if (readback.data.compilationStatus !== "current" ||
        result?.version !== written.data.version ||
        result?.contentHash !== written.data.contentHash)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "当前知识编译后回读不一致");
    return output({ target, idempotencyKey, ...written.data,
      verification: "knowledge-compilation-after-readback" });
  }
  if (group === "knowledge" && command === "reindex") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const input = { contextToken: required(options, "context-token") };
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    const preview = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/reindex/preview`,
      { method: "POST", body: input });
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED",
        "目标是生产环境；确认重建知识索引后请增加 --yes",
        { target, preview: preview.data });
    const written = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/reindex`,
      { method: "POST", body: input, idempotencyKey });
    const readback = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/index?`);
    if (readback.data.nodes.length !== written.data.nodeCount ||
        readback.data.nodes.reduce((total, node) => total + node.count, 0) !==
          written.data.knowledgeCount)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "知识索引重建后回读不一致");
    return output({ target, idempotencyKey, ...written.data,
      verification: "knowledge-index-after-readback" });
  }
  if (group === "knowledge" && command === "ingest") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const task = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(required(options, "task"))}`,
    );
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/context?taskId=${encodeURIComponent(task.data.task.id)}`,
    );
    let content;
    let wikiContent;
    try {
      content = await fs.readFile(required(options, "file"), "utf8");
    } catch (error) {
      throw new CliError("SOURCE_FILE_INVALID", "无法读取来源正文文件", {
        cause: error.message,
      });
    }
    try {
      wikiContent = await fs.readFile(required(options, "wiki-file"), "utf8");
    } catch (error) {
      throw new CliError("WIKI_FILE_INVALID", "无法读取 Wiki 知识正文文件", {
        cause: error.message,
      });
    }
    const input = {
      contextToken: required(options, "context-token"),
      taskId: task.data.task.id,
      title: required(options, "title"),
      workspaceId: options.workspace || "",
      sourceNodeId: required(options, "source-node"),
      sourceUrl: required(options, "source-url"),
      sourceVersion: required(options, "source-version"),
      content,
      wikiContent,
      analysisDate: options["analysis-date"] || "",
      platform: options.platform || "",
      topics: options.topics ? options.topics.split(",").map((value) => value.trim()).filter(Boolean) : [],
    };
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    let preview;
    try {
      preview = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/preview`,
        { method: "POST", body: input },
      );
    } catch (error) {
      if (options["dry-run"] || error.code !== "PROJECT_STATE_CHANGED")
        throw error;
      // Unknown prior result: the service resolves the original idempotency
      // key before checking this now-stale project context token.
      preview = null;
    }
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认编译钉钉资料后请增加 --yes",
        { target, preview: preview?.data || null },
      );
    const written = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge`,
      { method: "POST", body: input, idempotencyKey, timeoutMs: 30000 },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/query?taskId=${encodeURIComponent(task.data.task.id)}`,
    );
    const found = readback.data.results.find(
      (item) => item.knowledgeId === written.data.knowledge.id,
    );
    if (
      !found ||
      found.source.contentHash !== written.data.knowledge.contentHash ||
      found.source.compiledHash !== written.data.knowledge.compiledHash ||
      found.source.version !== input.sourceVersion
    )
      throw new CliError("OUTPUT_CONTRACT_FAILED", "知识编译后的回读不一致", {
        knowledgeId: written.data.knowledge.id,
      });
    return output({
      target,
      idempotencyKey,
      ...written.data,
      verification: "knowledge-write-after-readback",
    });
  }
  if (group === "knowledge" && command === "query") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    let taskId = "";
    if (options.task) {
      const resolved = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(options.task)}`,
      );
      taskId = resolved.data.task.id;
    }
    const params = new URLSearchParams();
    if (taskId) params.set("taskId", taskId);
    if (options.node) params.set("node", options.node);
    if (options.q) params.set("q", options.q);
    if (options.reports) params.set("view", "reports");
    for (const key of ["platform", "topic", "from", "to"])
      if (options[key]) params.set(key, options[key]);
    const result = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/query?${params}`,
    );
    return output({ target, ...result.data });
  }
  if (group === "node" && command === "create-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await nodeCreateContext(profile, project);
    return output({ target, ...context });
  }
  if (group === "node" && command === "create") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await nodeCreateContext(profile, project);
    const input = {
      contextToken: required(options, "context-token"),
      name: required(options, "name"),
      beforeNode: options["before-node"] || "",
      afterNode: options["after-node"] || "",
    };
    if (input.beforeNode && input.afterNode)
      throw new CliError(
        "ARGUMENT",
        "--before-node 和 --after-node 不能同时使用",
      );
    for (const reference of [input.beforeNode, input.afterNode].filter(Boolean))
      exactNamed(context.nodes, reference, ["name"], "NODE_NOT_FOUND", "节点");
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    let preview;
    try {
      preview = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/preview`,
        { method: "POST", body: input },
      );
    } catch (error) {
      if (options["dry-run"] || error.code !== "PROJECT_STATE_CHANGED")
        throw error;
      preview = null;
    }
    if (options["dry-run"])
      return output({
        target,
        idempotencyKey,
        currentContext: {
          projectVersion: context.project.projectVersion,
          contextToken: context.contextToken,
        },
        ...preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认添加节点后请增加 --yes",
        { target, preview: preview?.data || null },
      );
    const created = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes`,
      { method: "POST", body: input, idempotencyKey },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/by-name?name=${encodeURIComponent(input.name)}`,
    );
    if (
      readback.data.node.name !== created.data.node.name ||
      readback.data.node.order !== created.data.node.order ||
      Number(readback.data.project.projectVersion) <
        Number(created.data.project.projectVersion)
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "节点写入后的回读结果与创建结果不一致",
        { node: input.name },
      );
    return output({
      target,
      idempotencyKey,
      project: readback.data.project,
      node: readback.data.node,
      audit: created.data.audit,
      verification: "write-after-readback",
    });
  }
  if (group === "node" && command === "delete-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const node = required(options, "node");
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(node)}/delete-context`,
    );
    return output({ target, ...context.data });
  }
  if (group === "node" && command === "delete") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const node = required(options, "node");
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(node)}/delete-context`,
    );
    const dependencyPolicy = options["dependency-policy"] || "block";
    if (!["block", "detach"].includes(dependencyPolicy))
      throw new CliError(
        "ARGUMENT",
        "--dependency-policy 必须是 block 或 detach",
      );
    const preview = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(context.data.node.name)}/delete-preview`,
      {
        method: "POST",
        body: {
          contextToken: context.data.contextToken,
          dependencyPolicy,
        },
      },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedNode = required(options, "confirm-node");
    if (confirmedNode !== context.data.node.name)
      throw new CliError(
        "DELETE_CONFIRMATION_MISMATCH",
        "--confirm-node 必须与当前节点名称完全一致",
      );
    if (!preview.data.canDelete)
      throw new CliError(
        "DEPENDENTS_EXIST",
        "其他节点存在下游任务，请明确使用 --dependency-policy detach",
        { preview: preview.data },
      );
    if (
      preview.data.permissions.requiresAdmin &&
      !preview.data.permissions.canDeleteWithContent
    )
      throw new CliError(
        "ADMIN_REQUIRED",
        "节点中包含已有产出的任务，只有管理员可以删除",
        { preview: preview.data },
      );
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认删除节点后请增加 --yes",
        { target, preview: preview.data },
      );
    const deleted = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(context.data.node.name)}`,
      {
        method: "DELETE",
        body: {
          contextToken: context.data.contextToken,
          impactHash: preview.data.impactHash,
          confirmNode: confirmedNode,
          dependencyPolicy,
        },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deleted.data.deletionId)}`,
    );
    if (
      readback.data.id !== deleted.data.deletionId ||
      readback.data.scopeType !== "node" ||
      readback.data.state !== "completed"
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "节点删除后的回收记录与请求不一致",
        { deletionId: deleted.data.deletionId },
      );
    return output({
      target,
      idempotencyKey,
      ...deleted.data,
      verification: "delete-after-readback",
    });
  }
  if (group === "node" && command === "restore") {
    const target = await inspectTarget(profile);
    const deletionId = required(options, "deletion-id");
    const batch = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}`,
    );
    if (batch.data.scopeType !== "node")
      throw new CliError(
        "RESTORE_SCOPE_MISMATCH",
        "该回收记录不是节点删除记录",
      );
    const preview = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore-preview`,
      { method: "POST", body: {} },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedNode = required(options, "confirm-node");
    if (confirmedNode !== batch.data.nodeName)
      throw new CliError(
        "RESTORE_CONFIRMATION_MISMATCH",
        "--confirm-node 必须与回收记录中的节点名称完全一致",
      );
    if (!preview.data.canRestore)
      throw new CliError("RESTORE_CONFLICT", "当前节点存在恢复冲突", {
        preview: preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认恢复节点后请增加 --yes",
        { target, preview: preview.data },
      );
    const restored = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore`,
      {
        method: "POST",
        body: { confirmNode: confirmedNode },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(restored.data.project.id)}/nodes/by-name?name=${encodeURIComponent(restored.data.node.name)}`,
    );
    if (readback.data.node.name !== restored.data.node.name)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "恢复后的节点回读失败", {
        deletionId,
      });
    return output({
      target,
      idempotencyKey,
      ...restored.data,
      verification: "restore-after-readback",
    });
  }
  if (group === "task" && command === "update-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const task = await resolveTask(profile, project, required(options, "task"));
    const context = await taskWriteContext(profile, project, task);
    return output({ target, ...context });
  }
  if (group === "task" && command === "update") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const task = await resolveTask(profile, project, required(options, "task"));
    const context = await taskWriteContext(profile, project, task);
    const contextToken = required(options, "context-token");
    const taskVersion = Number(required(options, "task-version"));
    if (contextToken !== context.contextToken || taskVersion !== context.task.version)
      throw new CliError("PROJECT_STATE_CHANGED", "任务写前状态已变化，请重新读取 update-context");
    const patch = {};
    for (const key of ["owner", "reviewer", "priority", "description", "criteria"])
      if (options[key] !== undefined) patch[key] = options[key];
    if (options["due-date"] !== undefined) patch.dueDate = options["due-date"];
    if (options["clear-due-date"]) {
      if (options["due-date"] !== undefined)
        throw new CliError("ARGUMENT", "--due-date 与 --clear-due-date 不能同时使用");
      patch.dueDate = "";
    }
    if (options.progress !== undefined) patch.progress = Number(options.progress);
    const body = { contextToken, taskVersion, patch };
    const prefix = `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}`;
    const preview = await request(profile, `${prefix}/update-preview`,
      { method: "POST", body });
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED",
        "目标是生产环境；核对任务变更后增加 --yes", { preview: preview.data });
    const written = await request(profile, `${prefix}/update`,
      { method: "PATCH", body, idempotencyKey });
    const readback = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/by-id/${encodeURIComponent(task.id)}`);
    if (readback.data.task.version !== written.data.task.version ||
        Object.entries(written.data.changes).some(([key, value]) =>
          readback.data.task[key] !== value))
      throw new CliError("OUTPUT_CONTRACT_FAILED", "任务更新后回读不一致");
    return output({ target, idempotencyKey, ...written.data,
      verification: "task-update-after-readback" });
  }
  if (group === "task" && ["start", "submit", "approve", "reject"].includes(command)) {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const task = await resolveTask(profile, project, required(options, "task"));
    const context = await taskWriteContext(profile, project, task);
    const contextToken = required(options, "context-token");
    const taskVersion = Number(required(options, "task-version"));
    if (contextToken !== context.contextToken || taskVersion !== context.task.version)
      throw new CliError("PROJECT_STATE_CHANGED", "任务写前状态已变化，请重新读取 update-context");
    const body = { contextToken, taskVersion, reason: options.reason || "" };
    const prefix = `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/actions/${command}`;
    const preview = await request(profile, `${prefix}/preview`,
      { method: "POST", body });
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED",
        "目标是生产环境；核对任务状态动作后增加 --yes", { preview: preview.data });
    const written = await request(profile, prefix,
      { method: "POST", body, idempotencyKey });
    const readback = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/by-id/${encodeURIComponent(task.id)}`);
    if (readback.data.task.version !== written.data.task.version ||
        readback.data.task.status !== written.data.nextStatus)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "任务动作后回读不一致");
    return output({ target, idempotencyKey, ...written.data,
      verification: "task-action-after-readback" });
  }
  if (group === "run" && ["start", "finish-context", "finish"].includes(command)) {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const task = await resolveTask(profile, project, required(options, "task"));
    const prefix = `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/runs`;
    if (command === "finish-context") {
      const result = await request(profile,
        `${prefix}/${encodeURIComponent(required(options, "run-id"))}/finish-context`);
      return output({ target, ...result.data });
    }
    const context = await taskWriteContext(profile, project, task);
    const contextToken = required(options, "context-token");
    const taskVersion = Number(required(options, "task-version"));
    if (contextToken !== context.contextToken || taskVersion !== context.task.version)
      throw new CliError("PROJECT_STATE_CHANGED", "运行写前状态已变化，请重新读取任务写前快照");
    const body = { contextToken, taskVersion };
    let endpoint;
    if (command === "start") {
      Object.assign(body, { skill: required(options, "skill"),
        skillVersion: options["skill-version"] || "unspecified", input: options.input || "" });
      endpoint = `${prefix}/start`;
    } else {
      Object.assign(body, { runVersion: Number(required(options, "run-version")),
        status: required(options, "status"), output: options.output || "",
        knowledgeId: options["knowledge-id"] || "", artifactId: options["artifact-id"] || "",
        quality: options.quality || "" });
      endpoint = `${prefix}/${encodeURIComponent(required(options, "run-id"))}/finish`;
      const fresh = await request(profile, `${endpoint}-context`);
      if (fresh.data.run.version !== body.runVersion ||
          fresh.data.contextToken !== contextToken)
        throw new CliError("RUN_STATE_CHANGED", "运行状态已变化，请重新读取 finish-context");
    }
    const preview = await request(profile, `${endpoint}-preview`, { method: "POST", body });
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED",
        "目标是生产环境；核对运行与交付物后增加 --yes", { preview: preview.data });
    const written = await request(profile, endpoint,
      { method: "POST", body, idempotencyKey });
    const readback = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/by-id/${encodeURIComponent(task.id)}`);
    if (readback.data.task.version !== written.data.task.version ||
        !readback.data.runs?.some((run) => run.id === written.data.run.id &&
          run.status === written.data.run.status))
      throw new CliError("OUTPUT_CONTRACT_FAILED", "Agent 运行写入后回读不一致");
    return output({ target, idempotencyKey, ...written.data,
      verification: "run-after-readback" });
  }
  if (group === "artifact" && command === "upload") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const task = await resolveTask(profile, project, required(options, "task"));
    const context = await taskWriteContext(profile, project, task);
    const contextToken = required(options, "context-token");
    const taskVersion = Number(required(options, "task-version"));
    if (contextToken !== context.contextToken || taskVersion !== context.task.version)
      throw new CliError("PROJECT_STATE_CHANGED", "任务状态已变化，请重新读取 update-context");
    const file = required(options, "file");
    const fileStat = await fs.stat(file).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size < 1 || fileStat.size > 20 * 1024 * 1024)
      throw new CliError("ARGUMENT", "交付物必须是 1 字节至 20 MB 的普通文件");
    const content = await fs.readFile(file);
    const body = { contextToken, taskVersion,
      name: file.split(/[\\/]/).pop(), size: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex") };
    const prefix = `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/artifacts`;
    const preview = await request(profile, `${prefix}/upload-preview`,
      { method: "POST", body });
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED", "目标是生产环境；核对上传交付物后增加 --yes");
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) form.append(key, String(value));
    form.append("file", new Blob([content]), body.name);
    const written = await uploadRequest(profile, `${prefix}/upload`, form, idempotencyKey);
    const readback = await request(profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/by-id/${encodeURIComponent(task.id)}`);
    if (!readback.data.artifacts?.some((item) =>
      item.id === written.data.artifact.id && item.sha256 === body.sha256))
      throw new CliError("OUTPUT_CONTRACT_FAILED", "交付物上传后回读不一致");
    return output({ target, idempotencyKey, ...written.data,
      verification: "artifact-upload-after-readback" });
  }
  if (group === "task" && command === "create-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await taskCreateContext(profile, project);
    return output({ target, ...context });
  }
  if (group === "task" && command === "delete-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const resolved = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(required(options, "task"))}`,
    );
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(resolved.data.task.id)}/delete-context`,
    );
    return output({ target, ...context.data });
  }
  if (group === "task" && command === "delete") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const requestedTask = required(options, "task");
    const resolved = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(requestedTask)}`,
    );
    const task = resolved.data.task;
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/delete-context`,
    );
    const dependencyPolicy = options["dependency-policy"] || "block";
    let replacementTaskId = "";
    if (dependencyPolicy === "rewire") {
      const replacement = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(required(options, "rewire-to"))}`,
      );
      replacementTaskId = replacement.data.task.id;
    }
    const preview = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/delete-preview`,
      {
        method: "POST",
        body: {
          contextToken: context.data.contextToken,
          dependencyPolicy,
          replacementTaskId,
        },
      },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedTask = required(options, "confirm-task");
    if (confirmedTask !== task.title)
      throw new CliError(
        "DELETE_CONFIRMATION_MISMATCH",
        "--confirm-task 必须与当前任务名称完全一致",
      );
    if (!preview.data.canDelete)
      throw new CliError(
        "DEPENDENTS_EXIST",
        "存在下游任务，请明确使用 --dependency-policy detach 或 rewire",
        { preview: preview.data },
      );
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认删除任务后请增加 --yes",
        { target, preview: preview.data },
      );
    const deleted = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}`,
      {
        method: "DELETE",
        body: {
          contextToken: context.data.contextToken,
          impactHash: preview.data.impactHash,
          confirmTask: confirmedTask,
          dependencyPolicy,
          replacementTaskId,
        },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deleted.data.deletionId)}`,
    );
    if (
      readback.data.id !== deleted.data.deletionId ||
      readback.data.state !== "completed"
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "删除后的回收记录与请求不一致",
        { deletionId: deleted.data.deletionId },
      );
    return output({
      target,
      idempotencyKey,
      ...deleted.data,
      verification: "delete-after-readback",
    });
  }
  if (group === "trash" && command === "list") {
    const target = await inspectTarget(profile);
    let query = "";
    if (options.project) {
      const project = await resolveProject(profile, options.project);
      query = `?projectId=${encodeURIComponent(project.id)}`;
    }
    const result = await request(profile, `/api/v1/trash${query}`);
    return output({ target, count: result.data.length, items: result.data });
  }
  if (group === "trash" && command === "get") {
    const target = await inspectTarget(profile);
    const result = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(required(options, "deletion-id"))}`,
    );
    return output({ target, ...result.data });
  }
  if (group === "task" && command === "restore") {
    const target = await inspectTarget(profile);
    const deletionId = required(options, "deletion-id");
    const batch = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}`,
    );
    const preview = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore-preview`,
      { method: "POST", body: {} },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedTask = required(options, "confirm-task");
    if (confirmedTask !== batch.data.taskTitle)
      throw new CliError(
        "RESTORE_CONFIRMATION_MISMATCH",
        "--confirm-task 必须与回收记录中的任务名称完全一致",
      );
    if (!preview.data.canRestore)
      throw new CliError("RESTORE_CONFLICT", "当前任务存在恢复冲突", {
        preview: preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认恢复任务后请增加 --yes",
        { target, preview: preview.data },
      );
    const restored = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore`,
      {
        method: "POST",
        body: { confirmTask: confirmedTask },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(restored.data.project.id)}/tasks/by-id/${encodeURIComponent(restored.data.task.id)}`,
    );
    if (readback.data.task.id !== restored.data.task.id)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "恢复后的任务回读失败", {
        deletionId,
      });
    return output({
      target,
      idempotencyKey,
      ...restored.data,
      verification: "restore-after-readback",
    });
  }
  if (group === "task" && command === "create") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await taskCreateContext(profile, project);
    const input = taskCreateInput(options, context);
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    let preview;
    try {
      preview = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/preview`,
        { method: "POST", body: input },
      );
    } catch (error) {
      if (options["dry-run"] || error.code !== "PROJECT_STATE_CHANGED")
        throw error;
      // A retry after an unknown write result may legitimately carry the old
      // context token. The write endpoint resolves the original idempotency
      // key before evaluating that stale token; a new attempt still fails.
      preview = null;
    }
    if (options["dry-run"])
      return output({
        target,
        idempotencyKey,
        currentContext: {
          projectVersion: context.project.projectVersion,
          contextToken: context.contextToken,
        },
        ...preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认添加任务后请增加 --yes",
        { target, preview: preview?.data || null },
      );
    const created = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks`,
      { method: "POST", body: input, idempotencyKey },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/by-id/${encodeURIComponent(created.data.task.id)}`,
    );
    if (
      readback.data.task.id !== created.data.task.id ||
      readback.data.task.title !== input.title ||
      readback.data.task.stage !== input.stage ||
      Number(readback.data.project.projectVersion) <
        Number(created.data.project.projectVersion)
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "任务写入后的回读结果与创建结果不一致",
        { taskId: created.data.task.id },
      );
    return output({
      target,
      idempotencyKey,
      project: readback.data.project,
      task: readback.data.task,
      audit: created.data.audit,
      verification: "write-after-readback",
    });
  }
  if (group === "project" && command === "create") {
    const target = await inspectTarget(profile);
    const type = options.type || "product";
    if (type !== "product")
      throw new CliError(
        "FEATURE_UNSUPPORTED",
        `${type === "shop" ? "店铺" : type === "company" ? "企业" : "该类型"}项目尚未开放`,
      );
    const input = {
      name: required(options, "name"),
      goal: options.goal || "",
      type,
      template: options.template || "product-sop-v1",
      mode: options.mode || "agent",
    };
    if (options["sop-file"]) input.sop = await readSopFile(options["sop-file"]);
    if (!["product-sop-v1", "ecommerce-v1"].includes(input.template))
      throw new CliError("ARGUMENT", "当前只支持商品项目 SOP 模板");
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ dryRun: true, target, input, idempotencyKey });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认创建后请增加 --yes",
        { target, input },
      );
    const result = await request(profile, "/api/v1/projects", {
      method: "POST",
      body: input,
      idempotencyKey,
    });
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(result.data.project.id)}`,
    );
    if (
      readback.data.project.id !== result.data.project.id ||
      readback.data.tasks.count !== result.data.tasks.count ||
      readback.data.wiki.count !== result.data.wiki.count
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "项目写入后的回读结果与创建结果不一致",
        {
          projectId: result.data.project.id,
        },
      );
    return output({
      target,
      idempotencyKey,
      ...readback.data,
      audit: result.data.audit,
      verification: "write-after-readback",
    });
  }
  if (group === "project" && command === "delete") {
    const target = await inspectTarget(profile);
    const name = required(options, "name");
    const confirmedName = required(options, "confirm-name");
    if (name !== confirmedName)
      throw new CliError(
        "DELETE_CONFIRMATION_MISMATCH",
        "--confirm-name 必须与 --name 完全一致",
      );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"]) {
      const found = await request(
        profile,
        `/api/v1/projects/resolve/by-name?name=${encodeURIComponent(name)}`,
      );
      return output({
        dryRun: true,
        target,
        preview: {
          project: { id: found.data.project.id, name: found.data.project.name },
          taskCount: found.data.taskCount,
          wikiCount: found.data.wikiCount,
          recoverable: true,
        },
        idempotencyKey,
        requiresAdmin: true,
      });
    }
    if (!options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "删除项目必须增加 --yes，并提供完全一致的 --confirm-name",
        { target, projectName: name },
      );
    const result = await request(profile, "/api/v1/projects/by-name", {
      method: "DELETE",
      body: { expectedName: name },
      idempotencyKey,
    });
    const readback = await request(
      profile,
      `/api/v1/deleted-projects/${encodeURIComponent(result.data.projectId)}`,
    );
    if (!readback.data.project.deletedAt || readback.data.project.name !== name)
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "删除后的回读结果与请求不一致",
        { projectId: result.data.projectId },
      );
    return output({
      target,
      idempotencyKey,
      ...result.data,
      verification: "soft-delete-readback",
    });
  }
  throw new CliError("UNKNOWN_COMMAND", "未知命令，运行 procli help 查看用法");
}
