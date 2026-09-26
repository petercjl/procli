import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileHtmlReport } from "../src/html-report.mjs";

const bin = fileURLToPath(new URL("../bin/procli.mjs", import.meta.url));
const run = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => resolve({ code, json: JSON.parse(stdout), stderr }));
});

test("HTML report conversion preserves visible headings, narrative and every table row", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "procli-html-report-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, "report.html");
  await fs.writeFile(file, "<html><head><script>hidden script</script></head><body><nav>menu only</nav><main><section hidden><h1>Market evidence</h1><p>Growth needs verification.</p><table><thead><tr><th>Category</th><th>Growth</th></tr></thead><tbody><tr><td>Pans</td><td>42%</td></tr><tr><td>Boards</td><td>31%</td></tr></tbody></table></section></main></body></html>");
  const result = await compileHtmlReport(file);
  assert.deepEqual(result.coverage, { headings: 1, tables: 1, rows: 3, markdownRows: 3, markdownChars: result.markdown.length });
  assert.match(result.markdown, /Growth needs verification/);
  assert.match(result.markdown, /\| Boards \| 31% \|/);
  assert.doesNotMatch(result.markdown, /menu only|hidden script/);
  await fs.writeFile(file, "<html><body><p>Report outside main</p></body></html>");
  await assert.rejects(compileHtmlReport(file), { code: "PUBLISH_HTML_CONTENT_INVALID" });
});

test("publish previews without mutation, then writes document, HTML evidence, Wiki and task once", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "procli-publish-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dws = path.join(temp, "fake-dws.mjs");
  await fs.writeFile(dws, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const operation = args[1];
if (operation === "+create") { fs.readFileSync(0, "utf8"); fs.appendFileSync(process.env.DWS_LOG, "create\\n"); console.log(JSON.stringify({ok:true,status:"success",complete:true,data:{nodeId:"doc-1",verified:true,documentUrl:"https://alidocs.dingtalk.com/i/nodes/doc-1"}})); }
else if (operation === "+media-insert") { fs.appendFileSync(process.env.DWS_LOG, "media\\n"); console.log("Upload completed"); }
else if (operation === "+media-list") { console.log("Reading media..."); console.log(JSON.stringify({ok:true,status:"success",complete:true,operation:"doc.media_list",data:{media:[{blockId:"block-1",name:"report.html",type:"text/html",resourceId:"resource-1"}]}})); }
else if (operation === "+fetch") console.log(JSON.stringify({status:"success",complete:true,content:{markdown:"# Human report\\n\\nEvidence body"}}));
else process.exit(2);
`, { mode: 0o755 });
  const html = path.join(temp, "report.html");
  await fs.writeFile(html, "<html><body><main><h1>Complete evidence</h1><p>Evidence supports further study in this market.</p><table><thead><tr><th>Category</th><th>Growth</th></tr></thead><tbody><tr><td>Pans</td><td>42%</td></tr></tbody></table></main></body></html>");
  const bundle = path.join(temp, "bundle.json");
  await fs.writeFile(bundle, JSON.stringify({ schemaVersion: 1, title: "Report", summary: "Evidence supports further study.", humanMarkdown: "# Human report\n\nEvidence body", knowledgeMarkdown: "# Wiki report\n\nEvidence body", htmlReport: "./report.html", analysisDate: "2026-09-26", platform: "Taobao", topics: ["kitchen"] }));
  const calls = [];
  let artifact = null, knowledge = null, compiled = null, description = "Existing task content";
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = raw.length && req.headers["content-type"]?.includes("application/json") ? JSON.parse(raw.toString()) : {};
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    const send = (data) => res.end(JSON.stringify({ ok: true, data }));
    if (req.url === "/api/health") return send({ environment: "development", instanceId: "publish-test", apiVersion: "1" });
    if (req.url?.startsWith("/api/v1/projects/resolve/by-name?")) return send({ project: { id: "project-1", name: "Kitchen" } });
    if (req.url?.includes("/tasks/resolve/by-name?")) return send({ task: { id: "task-1", title: "Research", stage: "Market" } });
    if (req.url?.endsWith("/knowledge/compile/context?node=Market")) return send({ contextToken: "compile-token", sources: knowledge ? [{ knowledgeId: "knowledge-1" }] : [], current: null });
    if (req.url?.endsWith("/tasks/task-1/write-context")) return send({ contextToken: "task-token", task: { version: 1, description } });
    if (req.url?.endsWith("/artifacts/upload-preview")) return send({ action: "upload" });
    if (req.url?.endsWith("/artifacts/upload") && req.method === "POST") { artifact = { id: "artifact-1", sha256: /[a-f0-9]{64}/.exec(raw.toString())?.[0] }; return send({ artifact }); }
    if (req.url?.endsWith("/tasks/by-id/task-1")) return send({ task: { id: "task-1", description }, artifacts: artifact ? [artifact] : [] });
    if (req.url?.endsWith("/knowledge/context?taskId=task-1")) return send({ contextToken: "knowledge-token" });
    if (req.url?.endsWith("/knowledge/preview")) return send({ action: "create" });
    if (req.url?.endsWith("/knowledge") && req.method === "POST") { knowledge = { id: "knowledge-1", contentHash: "source-hash", compiledHash: "compiled-hash", wikiContent: body.wikiContent }; return send({ knowledge }); }
    if (req.url?.includes("/knowledge/query?taskId=")) return send({ results: knowledge ? [{ knowledgeId: knowledge.id, source: { contentHash: knowledge.contentHash, compiledHash: knowledge.compiledHash }, content: knowledge.wikiContent, truncated: false }] : [] });
    if (req.url?.endsWith("/knowledge/compile/preview")) return send({ action: "compile" });
    if (req.url?.endsWith("/knowledge/compile") && req.method === "POST") { compiled = { version: 1, contentHash: "current-hash" }; return send(compiled); }
    if (req.url?.includes("/knowledge/query?node=")) return send({ compilationStatus: compiled ? "current" : "missing", results: compiled ? [compiled] : [] });
    if (req.url?.endsWith("/tasks/task-1/update-preview")) return send({ changes: body.patch });
    if (req.url?.endsWith("/tasks/task-1/update") && req.method === "PATCH") { description = body.patch.description; return send({ task: { version: 2 }, changes: body.patch }); }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: req.url } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = { PROCLI_CONFIG_PATH: path.join(temp, "config.json"), PROCLI_DWS_BIN: dws, DWS_LOG: path.join(temp, "dws.log") };
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await run(["profile", "add", "local", "--url", url, "--environment", "development"], env)).code, 0);
  const args = ["task", "publish", "--profile", "local", "--project", "Kitchen", "--task", "Research", "--bundle", bundle, "--idempotency-key", "publish-1", "--json"];
  const preview = await run([...args, "--dry-run"], env);
  assert.equal(preview.code, 0);
  assert.equal(preview.json.data.writePerformed, false);
  assert.equal(calls.some((c) => c.method !== "GET"), false);
  const denied = await run(args, env);
  assert.equal(denied.json.error.code, "CONFIRMATION_REQUIRED");
  const uncertain = await run([...args, "--yes"], env);
  assert.equal(uncertain.json.error.code, "DWS_RESPONSE_INVALID");
  assert.equal((await fs.readFile(env.DWS_LOG, "utf8")).split("create").length - 1, 1);
  const published = await run([...args, "--recover-html-block", "block-1", "--yes"], env);
  assert.equal(published.code, 0, JSON.stringify(published.json));
  assert.equal(published.json.data.verification, "publish-after-readback");
  assert.equal(published.json.data.htmlEmbedded.blockId, "block-1");
  assert.match(description, /Existing task content/);
  assert.match(description, /Evidence supports further study/);
  const compilation = calls.find((c) => c.url?.endsWith("/knowledge/compile") && c.method === "POST");
  assert.match(compilation.body.content, /\[K:knowledge-1\]/);
  const again = await run([...args, "--yes"], env);
  assert.equal(again.code, 0);
  assert.equal((await fs.readFile(env.DWS_LOG, "utf8")).split("create").length - 1, 1);
  assert.equal((await fs.readFile(env.DWS_LOG, "utf8")).split("media").length - 1, 1);
  const repair = await run([...args, "--repair-wiki", "--repair-journal", published.json.data.journal, "--yes"], env);
  assert.equal(repair.code, 0, JSON.stringify(repair.json));
  assert.equal(repair.json.data.verification, "wiki-fulltext-after-readback");
  assert.match(knowledge.wikiContent, /\| Pans \| 42% \|/);
  assert.equal((await fs.readFile(env.DWS_LOG, "utf8")).split("create").length - 1, 1);
  const another = await run([...args.map((value) => value === "publish-1" ? "publish-2" : value), "--dry-run"], env);
  assert.equal(another.json.error.code, "PUBLISH_CURRENT_REQUIRED");
  assert.equal((await fs.stat(published.json.data.journal)).mode & 0o777, 0o600);
});
