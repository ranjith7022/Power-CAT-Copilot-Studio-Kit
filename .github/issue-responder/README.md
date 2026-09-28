# Issue Responder

A GitHub Actions bot that posts a first reply on newly opened issues, grounded in
this repository's documentation and how maintainers answered past issues. Replies are
drafted by GitHub Copilot through [`actions/ai-inference`](https://github.com/actions/ai-inference)
(Copilot CLI provider).

```
Issue opened ──▶ .github/workflows/issue-responder.yml
                   ├─ 1. gather.js   — reads the issue, ranks the most relevant doc
                   │                   sections, finds similar past issues + recent
                   │                   maintainer answers
                   ├─ 2. actions/ai-inference — Copilot drafts a grounded reply
                   ├─ 3. finalize.js — removes unverified links, adds the footer
                   └─ 4. gh issue comment — posts it (skipped in dry run)
```

## Setup

1. **Enable Issues** on the repository (forks have Issues disabled by default:
   *Settings → General → Features → Issues*).
2. **Add a secret** named `COPILOT_GITHUB_TOKEN` (*Settings → Secrets and variables
   → Actions*). Use a **fine-grained** personal access token
   (<https://github.com/settings/personal-access-tokens/new>) from an account with a
   Copilot plan, with the account permission **Copilot Requests** set to read-only.
   Classic tokens (`ghp_…`) are rejected by the Copilot CLI.
3. *(Recommended for the first rollout)* add a repository **variable** (not a secret)
   `ISSUE_RESPONDER_DRY_RUN` = `true`. Automatic runs then write the draft to the
   job summary instead of commenting.
4. Test from *Actions → Issue Responder → Run workflow* with an issue number
   (manual runs default to dry run).

To check reply quality against real maintainer answers, replay an upstream issue.
Replays are always dry runs:

```powershell
gh workflow run issue-responder.yml -f issue_repo=microsoft/Power-CAT-Copilot-Studio-Kit `
  -f issue_number=867 -f force=true
```

A replay can see issues and answers posted after the replayed issue, so it
slightly overstates quality.

## Files

| File | Purpose |
|---|---|
| `.github/workflows/issue-responder.yml` | Trigger (`issues.opened` + manual dispatch), inference, posting |
| `.github/issue-responder/gather.js` | Fetches the issue, applies skip rules, holds the reply/tone rules, writes `_bot/system.txt` + `_bot/prompt.txt` |
| `.github/issue-responder/context.js` | Doc ranking, similar-issue search, recent-issues digest |
| `.github/issue-responder/finalize.js` | Link verification and footer |

## How docs are selected

The Kit has about 60 markdown guides (roughly 500 KB), which is too much for one
prompt. For each issue, `context.js`:

- sends an **index** of every doc (path, title, link) so the model can point to the right page
- always includes excerpts of `README.md`, `TROUBLESHOOT.md` and `SUPPORT.md`
- splits the remaining docs into heading sections and adds the highest-scoring
  sections (TF-IDF keyword match, with file names and headings weighted higher)
  until the 40k character budget is used

The `docs/` folder (built GitHub Pages site) and solution folders are skipped.

## How past issues are used

Maintainer answers are the most reliable source. They often contain known service
problems, workarounds, and setup values the docs don't have. Past issues are
searched in this repo and in `microsoft/Power-CAT-Copilot-Studio-Kit`
(`KNOWLEDGE_REPOS` in the workflow):

- **Similar issues:** several keyword searches (best match and most recently
  updated), then local re-ranking by keyword overlap, recency, and whether the
  issue was answered. The top 6 go in with the report, maintainer replies, and the
  reporter's follow-ups (for example, "this fixed it").
- **Recent issues digest:** issues updated in the last 60 days that have a
  maintainer reply, one line each. This catches known problems that share a root
  cause but not wording. For example, "Dormant agents = total agents" is caused by
  the usage-API restriction in #855.

## Reply style

The rules in `gather.js` follow how the maintainers reply: "Hi @author, thanks for
reporting this.", the likely cause, numbered steps with **bold** UI names, at most
three targeted diagnostic requests (Kit release, **Logs** table rows, failed
flow run error details), and "Thank you." at the end. Replies are 60–180 words, never
promise fixes or timelines, and never close the issue.

## Safety rails

- Skips pull requests, bot-authored issues, closed issues, and issues that
  already have comments (override with the `force` input on manual runs).
- The job does not run for bot senders, which prevents reply loops.
- The Copilot CLI runs with no tools enabled. The bot only posts text.
- The prompt treats the issue body as untrusted data and forbids invented
  features and links.
- `finalize.js` unlinks any URL that isn't in the prompt or a file in the repo.
- Every reply is marked as automated.

## Local testing

```powershell
$env:GITHUB_TOKEN = (gh auth token)
$env:REPO = "microsoft/Power-CAT-Copilot-Studio-Kit"
$env:ISSUE_NUMBER = "123"
$env:FORCE = "true"
node .github/issue-responder/gather.js
Get-Content _bot/prompt.txt   # what Copilot will receive
```

## Tuning

| What | Where |
|---|---|
| Model | `model:` on the *Draft reply with Copilot* step (empty = CLI default) |
| Reply rules | `SYSTEM_RULES` in `gather.js` |
| Core docs / skipped folders | `CORE_DOCS`, `SKIPPED_DIRS` in `context.js` |
| Past-issue sources | `KNOWLEDGE_REPOS` in the workflow |
| Budgets | `MAX_TOTAL_DOC_CHARS`, `MAX_SIMILAR_ISSUES`, `RECENT_DAYS`, `MAX_RECENT_ISSUES` in `context.js` |
