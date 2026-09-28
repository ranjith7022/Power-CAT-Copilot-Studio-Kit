#!/usr/bin/env node
/**
 * Step 3 of the issue responder — turn the model's draft into the final comment.
 *
 * Every link in the draft must point at something the model was actually given:
 * a URL that appears in the prompt, or a markdown file that exists in this repo.
 * Other links are unlinked (the text is kept), so a hallucinated URL never ships.
 *
 * Env: RESPONSE_FILE (model output), PROMPT_DIR (default "_bot"), REPO,
 *      OUT_FILE (default "comment.md").
 */

const fs = require("fs");
const path = require("path");

const FOOTER =
  "<sub>🤖 This is an automated first response based on the Copilot Agent Kit documentation " +
  "and past issues, so it may be incomplete. A maintainer will follow up.</sub>";

function normalize(url) {
  return url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
}

function isAllowed(url, promptUrls, repo, repoRoot) {
  if (promptUrls.has(normalize(url))) return true;
  const prefix = `https://github.com/${repo}/blob/main/`.toLowerCase();
  if (url.toLowerCase().startsWith(prefix)) {
    const rel = decodeURI(url.slice(prefix.length).replace(/[#?].*$/, ""));
    return fs.existsSync(path.join(repoRoot, rel));
  }
  return false;
}

function main() {
  const promptDir = process.env.PROMPT_DIR || "_bot";
  const repo = process.env.REPO;
  const draft = fs.readFileSync(process.env.RESPONSE_FILE, "utf8").trim();
  const prompt = fs.readFileSync(path.join(promptDir, "prompt.txt"), "utf8");

  const promptUrls = new Set(
    (prompt.match(/https?:\/\/[^\s)\]>"'`]+/g) || []).map((u) => normalize(u.replace(/[.,;:]+$/, "")))
  );

  const removed = [];
  const check = (url) => {
    const ok = isAllowed(url, promptUrls, repo, process.cwd());
    if (!ok) removed.push(url);
    return ok;
  };

  let body = draft
    // [text](url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, text, url) => (check(url) ? m : text))
    // bare URLs (links kept above are also re-checked here, harmlessly)
    .replace(/(^|[\s(])(https?:\/\/[^\s)<>]+)/g, (m, lead, url) => {
      const clean = url.replace(/[.,;:]+$/, "");
      return check(clean) ? m : lead + url.slice(clean.length);
    });

  if (removed.length) console.log(`Removed ${removed.length} unverified link(s):\n  ${removed.join("\n  ")}`);
  else console.log("All links verified.");

  body = `${body}\n\n---\n${FOOTER}\n`;
  fs.writeFileSync(process.env.OUT_FILE || "comment.md", body);
}

main();
