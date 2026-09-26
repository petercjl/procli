import fs from "node:fs/promises";
import { load } from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { CliError } from "./config.mjs";

const normalized = (value) => String(value || "").replace(/\s+/g, " ").trim();

export async function compileHtmlReport(file) {
  const html = await fs.readFile(file, "utf8");
  const $ = load(html);
  const main = $("main").first();
  if (!main.length) throw new CliError("PUBLISH_HTML_CONTENT_INVALID", "HTML 报告缺少 main 正文，无法保证 Wiki 全文完整");
  main.find("script, style, noscript, template, input, select, textarea").remove();
  const headings = main.find("h1, h2, h3, h4, h5, h6").map((_, element) => normalized($(element).text())).get();
  const rows = main.find("table tr").length;
  const tables = main.find("table").length;
  if (!headings.length || normalized(main.text()).length < 20)
    throw new CliError("PUBLISH_HTML_CONTENT_INVALID", "HTML 报告正文缺少可核对的标题和内容");
  const converter = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  converter.use(gfm);
  converter.addRule("visibleButtons", {
    filter: "button",
    replacement: (content) => content.trim(),
  });
  const markdown = converter.turndown(main.html() || "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  const plainMarkdown = normalized(markdown.replace(/[\\*_#`]/g, ""));
  const missingHeadings = headings.filter((heading) => !plainMarkdown.includes(heading));
  const markdownRows = markdown.split("\n").filter((line) => /^\|.*\|$/.test(line.trim()) && !/^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim())).length;
  if (missingHeadings.length || markdownRows < rows || markdown.length > 100_000)
    throw new CliError("PUBLISH_HTML_COVERAGE_FAILED", "HTML 转 Wiki 的标题、表格行或正文长度校验未通过", {
      headings: headings.length, missingHeadings: missingHeadings.slice(0, 10), tables,
      sourceRows: rows, markdownRows, markdownChars: markdown.length,
    });
  return { markdown, coverage: { headings: headings.length, tables, rows, markdownRows, markdownChars: markdown.length } };
}
