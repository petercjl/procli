import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CliError, configPath } from "./config.mjs";
import { inspectTarget, request, uploadRequest } from "./client.mjs";
import { compileHtmlReport } from "./html-report.mjs";

const enc = encodeURIComponent;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const need = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new CliError("PUBLISH_BUNDLE_INVALID", `${name} 必须是非空文本`);
  return value.trim();
};

function parseDwsOutput(stdout) {
  try { return JSON.parse(stdout); } catch { /* Some dws operations print progress beside JSON. */ }
  let result = null;
  for (let start = 0; start < stdout.length; start++) {
    if (stdout[start] !== "{") continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < stdout.length; end++) {
      const ch = stdout[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(stdout.slice(start, end + 1));
          if (parsed && typeof parsed === "object" && parsed.status && parsed.operation) result = parsed;
        } catch { /* Continue looking for a complete operation receipt. */ }
        start = end;
        break;
      }
    }
  }
  return result;
}

export async function readPublishBundle(file) {
  const absolute = path.resolve(file);
  let bundle;
  try { bundle = JSON.parse(await fs.readFile(absolute, "utf8")); }
  catch (error) { throw new CliError("PUBLISH_BUNDLE_INVALID", `无法读取内容包：${error.message}`); }
  if (bundle.schemaVersion !== 1) throw new CliError("PUBLISH_BUNDLE_INVALID", "内容包 schemaVersion 必须为 1");
  for (const key of ["title", "summary"]) need(bundle[key], key);
  const content = bundle.contentMarkdown || bundle.humanMarkdown || bundle.knowledgeMarkdown;
  need(content, "contentMarkdown");
  bundle.humanMarkdown = need(bundle.humanMarkdown || content, "humanMarkdown");
  bundle.knowledgeMarkdown = need(bundle.knowledgeMarkdown || content, "knowledgeMarkdown");
  if (bundle.currentMarkdown != null) need(bundle.currentMarkdown, "currentMarkdown");
  if (bundle.topics != null && (!Array.isArray(bundle.topics) || bundle.topics.some((v) => typeof v !== "string")))
    throw new CliError("PUBLISH_BUNDLE_INVALID", "topics 必须是文本数组");
  if (bundle.analysisDate && !/^\d{4}-\d{2}-\d{2}$/.test(bundle.analysisDate))
    throw new CliError("PUBLISH_BUNDLE_INVALID", "analysisDate 必须是 YYYY-MM-DD");
  const hashInput = JSON.stringify(bundle);
  let html = null;
  let wikiCoverage = null;
  let wikiMarkdown = bundle.knowledgeMarkdown;
  if (bundle.htmlReport) {
    const filename = path.resolve(path.dirname(absolute), bundle.htmlReport);
    const stat = await fs.stat(filename).catch(() => null);
    if (!stat?.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024)
      throw new CliError("PUBLISH_BUNDLE_INVALID", "HTML 报告必须是 1 字节至 20 MB 的普通文件");
    html = { path: filename, name: path.basename(filename), size: stat.size, sha256: digest(await fs.readFile(filename)) };
    const full = await compileHtmlReport(filename);
    wikiCoverage = full.coverage;
    wikiMarkdown = `${full.markdown.trim()}\n\n---\n\n## 项目定向补充\n\n${bundle.knowledgeMarkdown.trim()}\n`;
    if (wikiMarkdown.length > 48_000)
      throw new CliError("PUBLISH_HTML_COVERAGE_FAILED", "完整报告与项目补充超过当前 Wiki 全文回读上限，须先支持多页存储与读取");
  }
  return { bundle, html, wikiMarkdown, wikiCoverage, hash: digest(hashInput + (html?.sha256 || "")) };
}

async function runDws(args, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PROCLI_DWS_BIN || "dws", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.on("error", (error) => { clearTimeout(timer); reject(new CliError("DWS_UNAVAILABLE", error.message)); });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      let result;
      result = parseDwsOutput(stdout);
      if (!result) return reject(new CliError("DWS_RESPONSE_INVALID", "钉钉命令未返回可识别的完整回执", { exitCode: code, stdoutBytes: Buffer.byteLength(stdout), stderr: stderr.slice(-500) }));
      if (code !== 0 || result.ok === false || result.status !== "success" || result.complete !== true)
        return reject(new CliError("DWS_COMMIT_UNCERTAIN", "钉钉操作未确认完成，请核对文档后再续传", { operation: result.operation, status: result.status, data: result.data, stderr: stderr.slice(-500) }));
      resolve(result.data || result.content || {});
    });
    child.stdin.end(input || "");
  });
}

async function saveJournal(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

function journalPath(key) {
  return path.join(path.dirname(configPath()), "publish", `${digest(key)}.json`);
}

async function getJournal(file, identity, { repair = false } = {}) {
  let previous;
  try { previous = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous && previous.identity !== identity && !repair)
    throw new CliError("PUBLISH_KEY_CONFLICT", "该幂等键已用于另一个目标或不同内容包");
  return previous || { identity, steps: {}, createdAt: new Date().toISOString() };
}

function managedDescription(existing, summary, url) {
  const begin = "<!-- procli:publish:start -->", end = "<!-- procli:publish:end -->";
  const block = `${begin}\n研究摘要：${summary}\n钉钉文档：${url}\n${end}`;
  const source = String(existing || "");
  const start = source.indexOf(begin), finish = source.indexOf(end);
  if (start >= 0 && finish > start) return source.slice(0, start) + block + source.slice(finish + end.length);
  return [source.trim(), block].filter(Boolean).join("\n\n");
}

export async function publishTask(options, profile) {
  const projectName = need(options.project, "--project");
  const taskName = need(options.task, "--task");
  const bundleFile = need(options.bundle, "--bundle");
  const { bundle, html, wikiMarkdown, wikiCoverage, hash } = await readPublishBundle(bundleFile);
  const target = await inspectTarget(profile);
  const project = (await request(profile, `/api/v1/projects/resolve/by-name?name=${enc(projectName)}`)).data.project;
  const task = (await request(profile, `/api/v1/projects/${enc(project.id)}/tasks/resolve/by-name?name=${enc(taskName)}`)).data.task;
  const prefix = `/api/v1/projects/${enc(project.id)}`;
  const node = task.stage;
  if (!node) throw new CliError("PUBLISH_TASK_INVALID", "任务缺少所属节点 stage");
  const repairJournal = options["repair-wiki"] && options["repair-journal"] ? path.resolve(options["repair-journal"]) : null;
  if (repairJournal && (path.dirname(repairJournal) !== path.join(path.dirname(configPath()), "publish") || !/^[a-f0-9]{64}\.json$/.test(path.basename(repairJournal))))
    throw new CliError("PUBLISH_REPAIR_UNAVAILABLE", "修复记录文件名无效");
  const key = options["idempotency-key"] || (repairJournal ? path.basename(repairJournal, ".json") : crypto.randomUUID());
  const dwsArgs = options["dws-profile"] ? ["--profile", options["dws-profile"]] : [];
  const identity = digest(JSON.stringify([profile.name, profile.url, options["dws-profile"] || "default", project.id, task.id, hash]));
  const file = repairJournal || journalPath(key);
  const previous = await getJournal(file, identity, { repair: Boolean(options["repair-wiki"]) });
  if (options["repair-wiki"] && (!previous.steps?.knowledgeInput || previous.steps.knowledgeInput.taskId !== task.id || previous.steps.knowledgeInput.title !== bundle.title || previous.steps.artifactInput?.sha256 !== html?.sha256 || previous.steps.document?.nodeId !== previous.steps.knowledgeInput.sourceNodeId))
    throw new CliError("PUBLISH_REPAIR_UNAVAILABLE", "原提交记录与目标任务、来源文档或 HTML 文件不匹配");
  const compile = (await request(profile, `${prefix}/knowledge/compile/context?node=${enc(node)}`)).data;
  if (compile.sources?.length && !bundle.currentMarkdown && !previous.steps.knowledge && !previous.steps.knowledgeInput && !options["repair-wiki"])
    throw new CliError("PUBLISH_CURRENT_REQUIRED", "该节点已有知识来源，内容包须提供融合现有来源的 currentMarkdown", { sourceIds: compile.sources.map((s) => s.knowledgeId) });
  if (bundle.currentMarkdown && !bundle.currentMarkdown.includes("[K:NEW]"))
    throw new CliError("PUBLISH_CITATION_MISSING", "currentMarkdown 必须用 [K:NEW] 引用本次报告");
  if (bundle.currentMarkdown && !previous.steps.knowledgeInput) {
    for (const source of compile.sources || [])
      if (!bundle.currentMarkdown.includes(`[K:${source.knowledgeId}]`))
        throw new CliError("PUBLISH_CITATION_MISSING", `currentMarkdown 缺少现有来源 [K:${source.knowledgeId}]`);
  }
  if (options["repair-wiki"] && (!html || !previous.steps.knowledgeInput || !previous.steps.knowledge || !previous.steps.document))
    throw new CliError("PUBLISH_REPAIR_UNAVAILABLE", "Wiki 修复需要同一幂等键的完整原提交记录和 HTML 报告");
  if (options["dry-run"]) return { target, project: { id: project.id, name: project.name }, task: { id: task.id, title: task.title, node }, idempotencyKey: key, bundleHash: hash, html, wikiCoverage, steps: options["repair-wiki"] ? ["knowledge.recompile-fulltext", "knowledge.compile"] : ["dingtalk.create", ...(html ? ["dingtalk.embed-html", "task.artifact"] : []), "knowledge.ingest", "knowledge.compile", "task.update"], writePerformed: false };
  if (!options.yes) throw new CliError("CONFIRMATION_REQUIRED", "提交会创建钉钉文档并更新项目任务和 Wiki；确认后增加 --yes");
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let lockHandle;
  try { lockHandle = await fs.open(lock, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid;
    try { pid = Number((await fs.readFile(lock, "utf8")).trim()); } catch { /* An interrupted lock may be empty. */ }
    let alive = !Number.isSafeInteger(pid) || pid <= 0;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; }
      catch (check) { alive = check.code === "EPERM"; }
    }
    if (alive) throw new CliError("PUBLISH_IN_PROGRESS", "同一幂等键的提交正在运行", { journal: file, lock, pid });
    await fs.unlink(lock).catch(() => {});
    try { lockHandle = await fs.open(lock, "wx", 0o600); }
    catch { throw new CliError("PUBLISH_IN_PROGRESS", "提交锁状态发生变化，请稍后重试", { journal: file, lock }); }
  }
  await lockHandle.writeFile(String(process.pid));
  let journal;
  try {
    journal = await getJournal(file, identity, { repair: Boolean(options["repair-wiki"]) });
    const commit = async (step, value) => { journal.steps[step] = value; journal.updatedAt = new Date().toISOString(); await saveJournal(file, journal); };
    if (options["repair-wiki"]) {
      const base = journal.steps.knowledgeInput;
      const knowledgeId = journal.steps.knowledge.id;
      if (!journal.steps.fullWikiKnowledge) {
        let input = journal.steps.fullWikiKnowledgeInput;
        if (!input) {
          const ctx = (await request(profile, `${prefix}/knowledge/context?taskId=${enc(task.id)}`)).data;
          input = { ...base, contextToken: ctx.contextToken, wikiContent: wikiMarkdown };
          const preview = await request(profile, `${prefix}/knowledge/preview`, { method: "POST", body: input });
          if (preview.data.action === "already-current") throw new CliError("KNOWLEDGE_ALREADY_CURRENT", "Wiki 全文已经入库");
          await commit("fullWikiKnowledgeInput", input);
        }
        const written = await request(profile, `${prefix}/knowledge`, { method: "POST", body: input, idempotencyKey: `${key}:full-wiki-knowledge`, timeoutMs: 30000 });
        if (written.data.knowledge.id !== knowledgeId) throw new CliError("OUTPUT_CONTRACT_FAILED", "Wiki 修复写到了不同知识条目");
        const check = (await request(profile, `${prefix}/knowledge/query?taskId=${enc(task.id)}`)).data;
        const report = check.results?.find((item) => item.knowledgeId === knowledgeId);
        if (!report?.content?.startsWith(wikiMarkdown.trim()) || report.truncated)
          throw new CliError("OUTPUT_CONTRACT_FAILED", "Wiki 全文回读不完整");
        await commit("fullWikiKnowledge", { id: knowledgeId, compiledHash: report.source.compiledHash });
      }
      if (!journal.steps.fullWikiCompiled) {
        let input = journal.steps.fullWikiCompileInput;
        if (!input) {
          const ctx = (await request(profile, `${prefix}/knowledge/compile/context?node=${enc(node)}`)).data;
          const ids = ctx.sources.map((source) => source.knowledgeId);
          const fallback = `# ${project.name}｜${node}当前知识\n\n${bundle.knowledgeMarkdown}\n\n[K:${knowledgeId}] ${bundle.title}`;
          const body = (bundle.currentMarkdown || ctx.current?.content || fallback).replaceAll("[K:NEW]", `[K:${knowledgeId}]`).trim();
          const content = `${body}\n\n## Wiki 完整报告\n\n[读取报告全文](./knowledge/${knowledgeId}.md)\n`;
          for (const id of ids) if (!content.includes(`[K:${id}]`)) throw new CliError("PUBLISH_CITATION_MISSING", `当前知识缺少来源引用 [K:${id}]`);
          input = { node, content, sourceIds: ids, changeSummary: "补全报告 Wiki 全文与表格", contextToken: ctx.contextToken, currentVersion: ctx.current?.version ?? null };
          await request(profile, `${prefix}/knowledge/compile/preview`, { method: "POST", body: input });
          await commit("fullWikiCompileInput", input);
        }
        const written = await request(profile, `${prefix}/knowledge/compile`, { method: "POST", body: input, idempotencyKey: `${key}:full-wiki-compile`, timeoutMs: 30000 });
        const check = (await request(profile, `${prefix}/knowledge/query?node=${enc(node)}`)).data;
        if (check.compilationStatus !== "current" || check.results?.[0]?.contentHash !== written.data.contentHash)
          throw new CliError("OUTPUT_CONTRACT_FAILED", "当前 Wiki 回读失败");
        await commit("fullWikiCompiled", { version: written.data.version });
      }
      return { target, project: { id: project.id, name: project.name }, task: { id: task.id, title: task.title, node }, idempotencyKey: key, journal: file, knowledge: journal.steps.fullWikiKnowledge, compiled: journal.steps.fullWikiCompiled, wikiCoverage, verification: "wiki-fulltext-after-readback" };
    }
    if (!journal.steps.document) {
      if (journal.steps.documentAttempted) throw new CliError("DWS_COMMIT_UNCERTAIN", "上次文档创建结果未知，请人工核对后处理", { journal: file });
      await commit("documentAttempted", true);
      const data = await runDws(["doc", "+create", "--name", bundle.title, "--content", "-", ...(bundle.workspaceId ? ["--workspace", bundle.workspaceId] : []), ...dwsArgs, "--format", "json"], { input: bundle.humanMarkdown });
      if (!data.nodeId || data.verified !== true) throw new CliError("DWS_COMMIT_UNCERTAIN", "文档创建回执缺少已验证 nodeId", { journal: file, data });
      await commit("document", { nodeId: data.nodeId, url: data.documentUrl || data.url || `https://alidocs.dingtalk.com/i/nodes/${enc(data.nodeId)}`, sourceVersion: data.version || `readback-${new Date().toISOString()}` });
    }
    const doc = journal.steps.document;
    if (html && !journal.steps.htmlEmbedded) {
      if (journal.steps.htmlAttempted) {
        const blockId = options["recover-html-block"];
        if (!blockId) throw new CliError("DWS_COMMIT_UNCERTAIN", "HTML 附件插入结果未知，请核对文档后用 --recover-html-block 指定真实区块 ID 续传", { journal: file, nodeId: doc.nodeId });
        const listed = await runDws(["doc", "+media-list", "--node", doc.nodeId, ...dwsArgs, "--format", "json"]);
        const found = listed.media?.find((item) => item.blockId === blockId && item.name === html.name && item.type === "text/html");
        if (!found) throw new CliError("DWS_RECOVERY_MISMATCH", "指定区块与该文档中的 HTML 附件不匹配", { journal: file, nodeId: doc.nodeId, blockId });
        await commit("htmlEmbedded", { blockId, resourceId: found.resourceId, recoveredByReadback: true });
      } else {
        await commit("htmlAttempted", true);
        const media = await runDws(["doc", "+media-insert", "--node", doc.nodeId, "--file", `./${html.name}`, "--mime-type", "text/html", "--name", html.name, ...dwsArgs, "--format", "json", "--yes"], { cwd: path.dirname(html.path) });
        if (!media.blockId) throw new CliError("DWS_COMMIT_UNCERTAIN", "附件插入回执缺少 blockId", { journal: file });
        await commit("htmlEmbedded", { blockId: media.blockId });
      }
    }
    const fetched = await runDws(["doc", "+fetch", "--node", doc.nodeId, ...dwsArgs, "--format", "json"]);
    const markdown = fetched.content?.markdown || fetched.markdown;
    if (typeof markdown !== "string" || !markdown.includes(bundle.humanMarkdown.trim().slice(0, 40)))
      throw new CliError("DWS_READBACK_FAILED", "钉钉文档正文回读与提交内容不匹配", { journal: file, nodeId: doc.nodeId });
    if (html && !journal.steps.artifact) {
      const ctx = journal.steps.artifactInput ? null : (await request(profile, `${prefix}/tasks/${enc(task.id)}/write-context`)).data;
      const body = journal.steps.artifactInput || { contextToken: ctx.contextToken, taskVersion: ctx.task.version, name: html.name, size: html.size, sha256: html.sha256 };
      if (!journal.steps.artifactInput) {
        await request(profile, `${prefix}/tasks/${enc(task.id)}/artifacts/upload-preview`, { method: "POST", body });
        await commit("artifactInput", body);
      }
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) form.append(k, String(v));
      form.append("file", new Blob([await fs.readFile(html.path)]), html.name);
      const uploaded = await uploadRequest(profile, `${prefix}/tasks/${enc(task.id)}/artifacts/upload`, form, `${key}:artifact`);
      const readback = (await request(profile, `${prefix}/tasks/by-id/${enc(task.id)}`)).data;
      if (!readback.artifacts?.some((a) => a.id === uploaded.data.artifact.id && a.sha256 === html.sha256)) throw new CliError("OUTPUT_CONTRACT_FAILED", "HTML 任务附件回读失败");
      await commit("artifact", { id: uploaded.data.artifact.id, sha256: html.sha256 });
    }
    if (!journal.steps.knowledge) {
      const ctx = journal.steps.knowledgeInput ? null : (await request(profile, `${prefix}/knowledge/context?taskId=${enc(task.id)}`)).data;
      const input = journal.steps.knowledgeInput || { contextToken: ctx.contextToken, taskId: task.id, title: bundle.title, workspaceId: bundle.workspaceId || "", sourceNodeId: doc.nodeId, sourceUrl: doc.url, sourceVersion: doc.sourceVersion, content: markdown, wikiContent: wikiMarkdown, analysisDate: bundle.analysisDate || "", platform: bundle.platform || "", topics: bundle.topics || [] };
      if (!journal.steps.knowledgeInput) {
        await request(profile, `${prefix}/knowledge/preview`, { method: "POST", body: input });
        await commit("knowledgeInput", input);
      }
      const written = await request(profile, `${prefix}/knowledge`, { method: "POST", body: input, idempotencyKey: `${key}:knowledge`, timeoutMs: 30000 });
      const readback = (await request(profile, `${prefix}/knowledge/query?taskId=${enc(task.id)}`)).data;
      if (!readback.results?.some((r) => r.knowledgeId === written.data.knowledge.id && r.source?.contentHash === written.data.knowledge.contentHash && (!html || (!r.truncated && r.content?.startsWith(wikiMarkdown.trim()))))) throw new CliError("OUTPUT_CONTRACT_FAILED", "知识入库后全文回读失败");
      await commit("knowledge", { id: written.data.knowledge.id });
    }
    if (!journal.steps.compiled) {
      let input = journal.steps.compileInput;
      if (!input) {
        const ctx = (await request(profile, `${prefix}/knowledge/compile/context?node=${enc(node)}`)).data;
        const ids = ctx.sources.map((s) => s.knowledgeId);
        const body = bundle.currentMarkdown?.replaceAll("[K:NEW]", `[K:${journal.steps.knowledge.id}]`) || `# ${project.name}｜${node}当前知识\n\n${bundle.knowledgeMarkdown.trim()}\n\n## 来源\n\n[K:${journal.steps.knowledge.id}] ${bundle.title}：${doc.url}\n`;
        const content = html ? `${body.trim()}\n\n## Wiki 完整报告\n\n[读取报告全文](./knowledge/${journal.steps.knowledge.id}.md)\n` : body;
        for (const id of ids) if (!content.includes(`[K:${id}]`)) throw new CliError("PUBLISH_CITATION_MISSING", `当前知识缺少来源引用 [K:${id}]`, { journal: file });
        input = { node, content, sourceIds: ids, changeSummary: bundle.summary, contextToken: ctx.contextToken, currentVersion: ctx.current?.version ?? null };
        await request(profile, `${prefix}/knowledge/compile/preview`, { method: "POST", body: input });
        await commit("compileInput", input);
      }
      const written = await request(profile, `${prefix}/knowledge/compile`, { method: "POST", body: input, idempotencyKey: `${key}:compile`, timeoutMs: 30000 });
      const check = (await request(profile, `${prefix}/knowledge/query?node=${enc(node)}`)).data;
      if (check.compilationStatus !== "current" || check.results?.[0]?.contentHash !== written.data.contentHash) throw new CliError("OUTPUT_CONTRACT_FAILED", "当前 Wiki 编译回读失败");
      await commit("compiled", { version: written.data.version });
    }
    if (!journal.steps.taskUpdated) {
      let body = journal.steps.taskInput;
      if (!body) {
        const ctx = (await request(profile, `${prefix}/tasks/${enc(task.id)}/write-context`)).data;
        const description = managedDescription(ctx.task.description, bundle.summary, doc.url);
        body = { contextToken: ctx.contextToken, taskVersion: ctx.task.version, patch: { description } };
        await request(profile, `${prefix}/tasks/${enc(task.id)}/update-preview`, { method: "POST", body });
        await commit("taskInput", body);
      }
      await request(profile, `${prefix}/tasks/${enc(task.id)}/update`, { method: "PATCH", body, idempotencyKey: `${key}:task` });
      const check = (await request(profile, `${prefix}/tasks/by-id/${enc(task.id)}`)).data;
      if (check.task?.description !== body.patch.description) throw new CliError("OUTPUT_CONTRACT_FAILED", "任务卡更新回读失败");
      await commit("taskUpdated", true);
    }
    return { target, project: { id: project.id, name: project.name }, task: { id: task.id, title: task.title, node }, idempotencyKey: key, journal: file, document: doc, htmlEmbedded: journal.steps.htmlEmbedded || null, artifact: journal.steps.artifact || null, knowledge: journal.steps.knowledge, compiled: journal.steps.compiled, wikiCoverage, verification: "publish-after-readback" };
  } catch (error) {
    if (error instanceof CliError) error.details = { ...(error.details || {}), journal: file, completedSteps: Object.keys(journal?.steps || {}).filter((s) => !s.endsWith("Attempted")) };
    throw error;
  } finally {
    await lockHandle.close();
    await fs.unlink(lock).catch(() => {});
  }
}
