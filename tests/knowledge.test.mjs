import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/procli.mjs", import.meta.url));
const run = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.on("close", (code) => resolve({ code, json: JSON.parse(stdout) }));
});

test("knowledge context, preview, production confirmation, ingest and query", async (t) => {
  const calls = [];
  let knowledge = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    const send = (data) => res.end(JSON.stringify({ ok: true, data }));
    if (req.url === "/api/health")
      return send({ environment: "production", instanceId: "knowledge-test", apiVersion: "1" });
    if (req.url?.startsWith("/api/v1/projects/resolve/by-name?"))
      return send({ project: { id: "project-1", name: "Test" } });
    if (req.url?.includes("/tasks/resolve/by-name?"))
      return send({ task: { id: "task-1", title: "调研", stage: "市场调研" } });
    if (req.url?.endsWith("/knowledge/context" + "?taskId=task-1"))
      return send({ project: { id: "project-1", name: "Test", projectVersion: 3 },
        task: { id: "task-1", title: "调研", stage: "市场调研" },
        knowledge: [], contextToken: "context-3" });
    if (req.url?.startsWith("/api/v1/projects/project-1/knowledge/index?"))
      return send({ project: { id: "project-1", name: "Test" },
        contextToken: "context-3",
        indexPath: "wiki/index.md", queryPath: "wiki/queries/index.md",
        topicIndexPath: "wiki/topics/index.md", nodes: [{ name: "市场调研",
          path: "wiki/nodes/%E5%B8%82%E5%9C%BA%E8%B0%83%E7%A0%94/index.md",
          count: 1, reports: [] }] });
    if (req.url?.endsWith("/knowledge/reindex/preview"))
      return send({ dryRun: true, project: { id: "project-1", projectVersion: 3 },
        nodeCount: 1, knowledgeCount: 1, moves: [] });
    if (req.url?.endsWith("/knowledge/reindex") && req.method === "POST")
      return send({ project: { id: "project-1", projectVersion: 4 },
        nodeCount: 1, knowledgeCount: 1,
        indexPath: "wiki/index.md", queryPath: "wiki/queries/index.md",
        topicIndexPath: "wiki/topics/index.md" });
    if (req.url?.endsWith("/knowledge/preview"))
      return send({ dryRun: true, action: "create", source: {
        nodeId: body.sourceNodeId, workspaceId: body.workspaceId,
      } });
    if (req.url?.endsWith("/knowledge") && req.method === "POST") {
      knowledge = { id: "knowledge-1", contentHash: "hash-1", compiledHash: "wiki-hash-1" };
      return send({ project: { id: "project-1", projectVersion: 4 },
        task: { id: "task-1" }, knowledge,
        snapshot: { snapshotPath: "wiki/raw/knowledge-1/version.md" } });
    }
    if (req.url?.includes("/knowledge/query?"))
      return send({ project: { id: "project-1", name: "Test" },
        count: knowledge ? 1 : 0, results: knowledge ? [{
          knowledgeId: "knowledge-1", source: { contentHash: "hash-1", compiledHash: "wiki-hash-1", version: "v1" },
          content: "研究结论", task: { stage: "市场调研" },
        }] : [] });
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: req.url } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "procli-knowledge-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(temp, "config.json") };
  const file = path.join(temp, "source.md");
  const wikiFile = path.join(temp, "knowledge.md");
  await fs.writeFile(file, "模拟调研\n");
  await fs.writeFile(wikiFile, "# 研究结论\n\n有待验证的市场机会。\n");
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await run(["profile", "add", "nas", "--url", url,
    "--environment", "production"], env)).code, 0);
  const context = await run(["knowledge", "context", "--project", "Test",
    "--task", "调研", "--json"], env);
  assert.equal(context.json.data.contextToken, "context-3");
  const index = await run(["knowledge", "index", "--project", "Test",
    "--node", "市场调研", "--json"], env);
  assert.equal(index.json.data.nodes[0].name, "市场调研");
  const args = ["knowledge", "ingest", "--project", "Test", "--task", "调研",
    "--title", "模拟报告", "--source-node", "node-1",
    "--source-url", "https://alidocs.dingtalk.com/i/nodes/node-1",
    "--source-version", "v1", "--workspace", "space-1", "--file", file,
    "--wiki-file", wikiFile,
    "--analysis-date", "2026-09-16", "--platform", "跨平台公开资料",
    "--topics", "容量,保冷,竞品",
    "--context-token", "context-3", "--idempotency-key", "attempt-1", "--json"];
  const missingWiki = await run(args.filter((arg, index) =>
    arg !== "--wiki-file" && args[index - 1] !== "--wiki-file"), env);
  assert.equal(missingWiki.json.error.code, "WIKI_FILE_INVALID");
  const preview = await run([...args, "--dry-run"], env);
  assert.equal(preview.json.data.action, "create");
  assert.equal(calls.filter((call) => call.url?.endsWith("/knowledge") &&
    call.method === "POST").length, 0);
  const denied = await run(args, env);
  assert.equal(denied.json.error.code, "CONFIRMATION_REQUIRED");
  const written = await run([...args, "--yes"], env);
  assert.equal(written.json.data.verification, "knowledge-write-after-readback");
  const post = calls.find((call) => call.url?.endsWith("/knowledge") && call.method === "POST");
  assert.equal(post.body.workspaceId, "space-1");
  assert.equal(post.body.content, "模拟调研\n");
  assert.equal(post.body.wikiContent, "# 研究结论\n\n有待验证的市场机会。\n");
  assert.equal(post.body.analysisDate, "2026-09-16");
  assert.equal(post.body.platform, "跨平台公开资料");
  assert.deepEqual(post.body.topics, ["容量", "保冷", "竞品"]);
  const query = await run(["knowledge", "query", "--project", "Test",
    "--node", "市场调研", "--topic", "保冷", "--from", "2026-01-01", "--json"], env);
  assert.equal(query.json.data.count, 1);
  assert.match(query.json.data.results[0].content, /研究结论/);
  assert(calls.some((call) => call.url?.includes("topic=%E4%BF%9D%E5%86%B7") &&
    call.url.includes("from=2026-01-01")));
  const reindexArgs = ["knowledge", "reindex", "--project", "Test",
    "--context-token", "context-3", "--idempotency-key", "reindex-1", "--json"];
  const reindexPreview = await run([...reindexArgs, "--dry-run"], env);
  assert.equal(reindexPreview.json.data.knowledgeCount, 1);
  const reindexed = await run([...reindexArgs, "--yes"], env);
  assert.equal(reindexed.json.data.verification, "knowledge-index-after-readback");
});

test("node compilation reads prior synthesis, requires all sources, and verifies current page", async (t) => {
  const calls = [];
  let version = 1;
  const ids = ["source-2025", "source-2026"];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    const send = (data) => res.end(JSON.stringify({ ok: true, data }));
    if (req.url === "/api/health")
      return send({ environment: "production", instanceId: "compile-test", apiVersion: "1" });
    if (req.url?.startsWith("/api/v1/projects/resolve/by-name?"))
      return send({ project: { id: "project-1", name: "ERM" } });
    if (req.url?.includes("/knowledge/compile/context?"))
      return send({ project: { id: "project-1", name: "ERM", projectVersion: 8 },
        node: "市场调研", contextToken: "token-8", sources: ids.map((knowledgeId) => ({ knowledgeId })),
        current: { version: 1, content: "# 既有判断", isCurrent: false } });
    if (req.url?.endsWith("/knowledge/compile/preview"))
      return send({ dryRun: true, sourceCount: body.sourceIds.length,
        previousVersion: body.currentVersion, nextVersion: 2 });
    if (req.url?.endsWith("/knowledge/compile") && req.method === "POST") {
      version = 2;
      return send({ node: "市场调研", version, contentHash: "compiled-hash", sourceCount: 2 });
    }
    if (req.url?.includes("/knowledge/query?node="))
      return send({ compilationStatus: "current", count: 1,
        results: [{ version, contentHash: "compiled-hash", content: "# 综合判断" }] });
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: req.url } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "procli-compile-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(temp, "config.json") };
  const file = path.join(temp, "current.md");
  await fs.writeFile(file, "# 综合判断\n\n[K:source-2025] [K:source-2026]\n");
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await run(["profile", "add", "nas", "--url", url,
    "--environment", "production"], env)).code, 0);
  const context = await run(["knowledge", "compile-context", "--project", "ERM",
    "--node", "市场调研", "--json"], env);
  assert.equal(context.json.data.current.content, "# 既有判断");
  const args = ["knowledge", "compile", "--project", "ERM", "--node", "市场调研",
    "--file", file, "--source-ids", ids.join(","), "--change-summary", "对比两期证据",
    "--context-token", "token-8", "--current-version", "1",
    "--idempotency-key", "compile-1", "--json"];
  const preview = await run([...args, "--dry-run"], env);
  assert.equal(preview.json.data.sourceCount, 2);
  const denied = await run(args, env);
  assert.equal(denied.json.error.code, "CONFIRMATION_REQUIRED");
  const written = await run([...args, "--yes"], env);
  assert.equal(written.json.data.verification, "knowledge-compilation-after-readback");
  assert.deepEqual(calls.find((call) => call.url?.endsWith("/knowledge/compile") &&
    call.method === "POST").body.sourceIds, ids);
  assert.equal((await run(["knowledge", "query", "--project", "ERM",
    "--node", "市场调研", "--json"], env)).json.data.compilationStatus, "current");
});
