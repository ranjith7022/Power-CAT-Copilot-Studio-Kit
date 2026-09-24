/**
 * Context gathering for the issue responder:
 *  - collectDocs():       picks the most relevant sections of the Kit's
 *                         markdown docs for a given issue
 *  - findSimilarIssues(): searches closed issues that look like the new one
 *
 * No dependencies — uses the global fetch (Node 18+) and fs/promises.
 */

const fs = require("fs/promises");
const path = require("path");

const API_ROOT = "https://api.github.com";

/* Limits to keep prompts (and rate limits) under control */
const MAX_TOTAL_DOC_CHARS = 60_000;
const MAX_CHUNK_CHARS = 4_000;
const MAX_SIMILAR_ISSUES = 5;
const MAX_COMMENTS_PER_ISSUE = 3;
const KEYWORD_ATTEMPTS = [6, 3, 1]; // progressively narrower searches

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "copilot-studio-kit-issue-responder",
  };
}

function truncate(text, maxChars) {
  const clean = String(text ?? "");
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars) + "\n…[truncated]";
}

const STOPWORDS = new Set([
  "the","and","for","with","this","that","not","are","was","but","has","have",
  "how","what","when","why","who","can","does","did","from","your","you","our",
  "their","its","all","any","out","use","using","after","before","while","into",
  "then","than","them","there","here","which","will","would","should","could",
  "may","might","must","been","being","were","also","just","very","some","such",
  "only","own","same","too","each","other","more","most","get","got","make",
  "made","try","tried","need","want","help","please","new","issue","error",
  "bug","feature","request","description","steps","reproduce","expected",
  "actual","behavior","behaviour","environment","additional","context","logs",
  "response","version","browser","tenant","type","go","click","observe",
  "problem","statement","proposed","solution","none","https","http","www",
  "com","github","microsoft","copilot","studio","kit",
]);

/** Significant lowercase words from free text, in order of first appearance. */
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function extractKeywords(text, maxWords) {
  return [...new Set(tokenize(text))].slice(0, maxWords);
}

/* ------------------------------------------------------------------ */
/* Documentation                                                      */
/* ------------------------------------------------------------------ */

const DOC_EXTENSIONS = new Set([".md", ".mdx"]);

// docs/ is the built GitHub Pages site; the others hold solution/source files.
const SKIPPED_DIRS = new Set([
  ".git", ".github", "node_modules", "dist", "build", "out", "vendor", "coverage",
  "docs", "media", "CopilotStudioAccelerator", "CopilotstudioAcceleratorResources",
  "PowerCAT.PackageDeployer.Package",
]);

const SKIPPED_FILES = new Set(["code_of_conduct.md", "license.md"]);

// Always sent (truncated) so the model knows the Kit's scope and common fixes.
const CORE_DOCS = [
  { file: "README.md", maxChars: 5_000 },
  { file: "TROUBLESHOOT.md", maxChars: 6_000 },
  { file: "SUPPORT.md", maxChars: 2_000 },
];

async function walkMarkdown(dir, base, files) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walkMarkdown(fullPath, base, files);
    } else if (
      DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      !SKIPPED_FILES.has(entry.name.toLowerCase())
    ) {
      files.push(path.relative(base, fullPath).split(path.sep).join("/"));
    }
  }
  return files;
}

/** Splits markdown into heading-delimited sections (h1–h3), capped in size. */
function chunkMarkdown(file, raw) {
  const chunks = [];
  let heading = "(intro)";
  let buffer = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
        chunks.push({ file, heading, text: text.slice(i, i + MAX_CHUNK_CHARS) });
      }
    }
    buffer = [];
  };
  let inFence = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence && /^#{1,3}\s+(.*)/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

/** TF-IDF-style scoring; file names and headings count extra. */
function rankChunks(chunks, keywords) {
  const df = new Map();
  const tokenized = chunks.map((c) => {
    const counts = new Map();
    for (const w of tokenize(c.text)) counts.set(w, (counts.get(w) || 0) + 1);
    for (const w of counts.keys()) df.set(w, (df.get(w) || 0) + 1);
    return counts;
  });
  const n = chunks.length;
  return chunks
    .map((chunk, i) => {
      const meta = `${chunk.file} ${chunk.heading}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        const idf = Math.log((n + 1) / (1 + (df.get(kw) || 0)));
        const tf = Math.min(tokenized[i].get(kw) || 0, 5);
        score += idf * (tf + (meta.includes(kw) ? 4 : 0));
      }
      return { ...chunk, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function readText(repoRoot, relPath) {
  return fs.readFile(path.join(repoRoot, relPath), "utf8").catch(() => "");
}

/**
 * Collects the documentation most relevant to an issue.
 * @param {string} repoRoot checked-out repository root
 * @param {string} issueText issue title + body
 * @param {string} repo "<owner>/<name>", used to build file links
 * @returns {Promise<string>} markdown sections for the prompt
 */
async function collectDocs(repoRoot, issueText, repo) {
  const allFiles = (await walkMarkdown(repoRoot, repoRoot, [])).sort();
  const link = (f) => `https://github.com/${repo}/blob/main/${encodeURI(f)}`;
  const sections = [];
  let used = 0;

  // 1. Index of every doc so the model can point people to the right page.
  const index = [];
  for (const file of allFiles) {
    const raw = await readText(repoRoot, file);
    const title = /^#\s+(.*)/m.exec(raw)?.[1]?.trim() || file;
    index.push(`- ${file} — ${title} (${link(file)})`);
  }
  const indexText = `### Documentation index\n${index.join("\n")}`;
  sections.push(indexText);
  used += indexText.length;

  // 2. Core docs.
  const coreFiles = new Set();
  for (const { file, maxChars } of CORE_DOCS) {
    const raw = await readText(repoRoot, file);
    if (!raw.trim()) continue;
    coreFiles.add(file);
    const excerpt = truncate(raw, maxChars);
    used += excerpt.length;
    sections.push(`### File: ${file} (${link(file)})\n${excerpt}`);
  }

  // 3. Most relevant sections from everything else.
  const chunks = [];
  for (const file of allFiles) {
    if (coreFiles.has(file)) continue;
    chunks.push(...chunkMarkdown(file, await readText(repoRoot, file)));
  }
  const keywords = extractKeywords(issueText, 25);
  let picked = 0;
  for (const chunk of rankChunks(chunks, keywords)) {
    if (used + chunk.text.length > MAX_TOTAL_DOC_CHARS) continue;
    used += chunk.text.length;
    picked++;
    sections.push(
      `### File: ${chunk.file} — section "${chunk.heading}" (${link(chunk.file)})\n${chunk.text}`
    );
  }

  console.log(
    `  → ${allFiles.length} doc files indexed, ${coreFiles.size} core, ` +
      `${picked} relevant section(s), ~${used} chars`
  );
  return sections.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* Previously resolved issues                                         */
/* ------------------------------------------------------------------ */

async function searchClosedIssues(token, repo, query, excludeNumber) {
  const params = new URLSearchParams({
    q: `repo:${repo} is:issue is:closed ${query}`,
    per_page: String(MAX_SIMILAR_ISSUES + 1),
  });
  const res = await fetch(`${API_ROOT}/search/issues?${params}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error(`Issue search failed (${res.status}).`);
  const data = await res.json();
  return (data.items ?? [])
    .filter((item) => item.number !== excludeNumber)
    .slice(0, MAX_SIMILAR_ISSUES);
}

async function fetchLastComments(token, repo, issueNumber) {
  const res = await fetch(
    `${API_ROOT}/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
    { headers: ghHeaders(token) }
  );
  if (!res.ok) return [];
  const all = await res.json();
  return all.slice(-MAX_COMMENTS_PER_ISSUE).map((c) => ({
    user: c.user?.login ?? "unknown",
    body: truncate(c.body, 1200),
  }));
}

/**
 * Finds closed issues similar to the given one. Tries progressively shorter
 * keyword lists so we still get results when keywords don't co-occur.
 */
async function findSimilarIssues({ token, repo, issue }) {
  const keywords = extractKeywords(`${issue.title} ${issue.body}`, 10);

  for (const count of KEYWORD_ATTEMPTS) {
    const words = keywords.slice(0, count);
    if (words.length === 0) break;

    const items = await searchClosedIssues(token, repo, words.join(" "), issue.number);
    if (items.length === 0) continue;

    const detailed = [];
    for (const item of items) {
      detailed.push({
        number: item.number,
        title: item.title,
        url: item.html_url,
        stateReason: item.state_reason,
        body: truncate(item.body, 1500),
        comments: await fetchLastComments(token, repo, item.number),
      });
    }
    console.log(`  → matched with keywords: "${words.join(" ")}"`);
    return detailed;
  }

  return [];
}

module.exports = { ghHeaders, collectDocs, findSimilarIssues };
