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
const MAX_TOTAL_DOC_CHARS = 40_000;
const MAX_CHUNK_CHARS = 4_000;
const MAX_SIMILAR_ISSUES = 6;
const MAX_CANDIDATES = 20; // per search query, before local re-ranking
const MAX_COMMENTS_PER_ISSUE = 4;
const MAX_COMMENT_CHARS = 1_800;
const MIN_SIMILARITY = 4; // drops weak one-word matches
const RECENT_DAYS = 60;
const MAX_RECENT_ISSUES = 30;
const RECENT_ANSWER_CHARS = 500;

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

/** fetch() with a few retries for transient network errors and 5xx responses. */
async function fetchWithRetry(url, options, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status < 500 || i >= attempts) return res;
    } catch (err) {
      if (i >= attempts) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * i));
  }
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
/* Past issues (closed + open) and how maintainers answered them      */
/* ------------------------------------------------------------------ */

const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]);

/** Removes screenshots/HTML noise that wastes prompt space. */
function cleanBody(text) {
  return String(text ?? "")
    .replace(/<img[^>]*>/gi, "[screenshot]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[screenshot]")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function searchIssues(token, repos, query, sort) {
  const scope = repos.map((r) => `repo:${r}`).join(" ");
  const params = new URLSearchParams({
    q: `${scope} is:issue ${query}`,
    per_page: String(MAX_CANDIDATES),
  });
  if (sort) params.set("sort", sort);
  const res = await fetchWithRetry(`${API_ROOT}/search/issues?${params}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) {
    console.log(`  ! issue search failed (${res.status}) for "${query}"`);
    return [];
  }
  return (await res.json()).items ?? [];
}

function repoOf(item) {
  return item.repository_url.replace(`${API_ROOT}/repos/`, "");
}

/** Maintainer answers plus the reporter's own follow-ups (often "this fixed it"). */
async function fetchUsefulComments(token, repo, item) {
  const res = await fetchWithRetry(`${API_ROOT}/repos/${repo}/issues/${item.number}/comments?per_page=100`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) return [];
  const reporter = item.user?.login;
  return (await res.json())
    .filter((c) => c.user?.type !== "Bot" && !/automated first response/i.test(String(c.body)))
    .map((c) => ({
      user: c.user?.login ?? "unknown",
      role: MAINTAINER_ROLES.has(c.author_association)
        ? "maintainer"
        : c.user?.login === reporter
          ? "reporter"
          : "community",
      body: truncate(cleanBody(c.body), MAX_COMMENT_CHARS),
    }))
    .filter((c) => c.role !== "community")
    .slice(-MAX_COMMENTS_PER_ISSUE);
}

/**
 * Finds past issues similar to the given one across `repos`. Runs a few broad
 * searches, then re-ranks candidates locally by keyword overlap (title matches
 * weighted higher), so one unusual word in the new issue can't sink recall.
 */
async function findSimilarIssues({ token, repos, issue, issueRepo }) {
  const titleWords = extractKeywords(issue.title, 6);
  const allWords = extractKeywords(`${issue.title} ${cleanBody(issue.body)}`, 12);
  // Best-match searches find the closest wording; "updated" searches surface
  // recent known issues whose maintainer answers reflect the current state.
  const searches = [
    [titleWords.slice(0, 3).join(" ")],
    [titleWords.slice(0, 2).join(" ")],
    [allWords.slice(0, 2).join(" ")],
    ...titleWords.slice(0, 3).map((w) => [`${w} in:title`]),
    [titleWords.slice(0, 2).join(" "), "updated"],
    [`${titleWords[0] || ""} in:title`, "updated"],
  ].filter(([q], i, arr) => q.replace("in:title", "").trim() && arr.findIndex((a) => a.join() === arr[i].join()) === i);

  const candidates = new Map();
  for (const [q, sort] of searches) {
    for (const item of await searchIssues(token, repos, q, sort)) {
      const repo = repoOf(item);
      if (repo.toLowerCase() === issueRepo.toLowerCase() && item.number === issue.number) continue;
      if (item.title.trim() === issue.title.trim() && cleanBody(item.body) === cleanBody(issue.body)) continue; // a copy of this issue
      if (item.state_reason === "not_planned" && (item.comments ?? 0) === 0) continue;
      candidates.set(`${repo}#${item.number}`, { ...item, repo });
    }
  }
  if (candidates.size === 0) return [];

  const list = [...candidates.values()];
  const docs = list.map((it) => ({
    title: new Set(tokenize(it.title)),
    body: new Set(tokenize(cleanBody(it.body).slice(0, 4000))),
  }));
  const df = new Map();
  for (const d of docs) for (const w of new Set([...d.title, ...d.body])) df.set(w, (df.get(w) || 0) + 1);
  const n = list.length;
  const scored = list
    .map((it, i) => {
      let score = 0;
      for (const kw of allWords) {
        const idf = Math.log((n + 1) / (1 + (df.get(kw) || 0))) + 0.5;
        if (docs[i].title.has(kw)) score += 3 * idf;
        else if (docs[i].body.has(kw)) score += idf;
      }
      if ((it.comments ?? 0) > 0) score *= 1.2; // answered issues are more useful
      const ageDays = (Date.now() - Date.parse(it.updated_at)) / 86_400_000;
      score *= 1 + 0.6 * Math.exp(-ageDays / 60); // prefer the current state of things
      return { it, score };
    })
    .filter((s) => s.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SIMILAR_ISSUES);

  const detailed = [];
  for (const { it, score } of scored) {
    detailed.push({
      ref: `${it.repo}#${it.number}`,
      title: it.title,
      url: it.html_url,
      state: it.state === "open" ? "open" : `closed: ${it.state_reason || "completed"}`,
      score: Math.round(score * 10) / 10,
      body: truncate(cleanBody(it.body), 1200),
      comments: await fetchUsefulComments(token, it.repo, it),
    });
  }
  console.log(
    `  → ${candidates.size} candidates from ${searches.length} searches; top: ` +
      detailed.map((d) => `${d.ref}(${d.score})`).join(", ")
  );
  return detailed;
}

/**
 * One-line summaries of recently active, maintainer-answered issues. Keyword
 * search misses issues that share a root cause but not wording (e.g. "dormant
 * agents wrong" vs "usage API returns 403"); the model can connect those itself.
 */
async function recentIssuesDigest({ token, repos, issue, issueRepo, exclude }) {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const scope = repos.map((r) => `repo:${r}`).join(" ");
  const params = new URLSearchParams({
    q: `${scope} is:issue comments:>0 updated:>=${since}`,
    sort: "updated",
    per_page: String(MAX_RECENT_ISSUES + 10),
  });
  const res = await fetchWithRetry(`${API_ROOT}/search/issues?${params}`, { headers: ghHeaders(token) });
  if (!res.ok) {
    console.log(`  ! recent-issue search failed (${res.status})`);
    return [];
  }
  const items = ((await res.json()).items ?? [])
    .map((it) => ({ ...it, repo: repoOf(it) }))
    .filter((it) => {
      const ref = `${it.repo}#${it.number}`;
      const self = it.repo.toLowerCase() === issueRepo.toLowerCase() && it.number === issue.number;
      const copy = it.title.trim() === issue.title.trim() && cleanBody(it.body) === cleanBody(issue.body);
      return !self && !copy && !exclude.has(ref);
    });

  const digest = [];
  for (let i = 0; i < items.length && digest.length < MAX_RECENT_ISSUES; i += 8) {
    const batch = await Promise.all(
      items.slice(i, i + 8).map(async (it) => {
        const comments = await fetchUsefulComments(token, it.repo, it);
        const answers = comments.filter((c) => c.role === "maintainer").slice(-2);
        if (answers.length === 0) return null;
        const summary = answers
          .map((c) => c.body.replace(/\s+/g, " ").slice(0, RECENT_ANSWER_CHARS / answers.length))
          .join(" … ");
        const state = it.state === "open" ? "open" : "closed";
        return `- ${it.html_url} [${state}] "${it.title}" — latest maintainer replies: ${summary}`;
      })
    );
    digest.push(...batch.filter(Boolean));
  }
  const result = digest.slice(0, MAX_RECENT_ISSUES);
  console.log(`  → ${result.length} recent maintainer-answered issue(s) since ${since}`);
  return result;
}

module.exports = { ghHeaders, collectDocs, findSimilarIssues, recentIssuesDigest, cleanBody };