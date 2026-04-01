![Banner](banner.svg)

# multi-persona-review 🎭

Three AI experts review your code simultaneously.

One diff. Three angles. Two minutes.

---

## What it does

Sends your git diff to 3 Claude AI personas at the same time — in parallel — using `Promise.all()`. Each reviewer has a completely different lens:

| Persona | Focus |
|---|---|
| 🔐 **The Paranoid Security Reviewer** | OWASP vulns, injection, secrets, auth bypasses |
| ⚡ **The Performance Monk** | N+1 queries, O(n²), blocking calls, memory leaks |
| 🤔 **The Junior Dev Who Asks Why** | Confusing names, magic numbers, missing error handling |

---

## Install

```bash
git clone https://github.com/NickCirv/multi-persona-review
cd multi-persona-review
npm link   # makes `mpr` available globally
```

Or run directly:

```bash
node index.js
```

---

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here
```

No key? It still works — shows what each persona would look for.

---

## Usage

```bash
# Review last commit (default)
mpr

# Review specific range
mpr --diff main..HEAD

# Review only one file
mpr --file src/auth.js

# Only specific personas
mpr --personas security
mpr --personas security,performance

# Save review to ./reviews/
mpr --save

# Full help
mpr --help
```

---

## Example output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MULTI-PERSONA REVIEW
  Diff: HEAD~1..HEAD  |  3 reviewers  |  parallel
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Calling 3 reviewers in parallel... done in 2.3s

🔐 THE PARANOID SECURITY REVIEWER
─────────────────────────────────
CRITICAL: Line 47 — SQL query built with string concatenation
  sql = "SELECT * FROM users WHERE id = " + userId
  Fix: Use parameterized queries: db.query("...WHERE id = $1", [userId])

HIGH: Line 23 — API key hardcoded in source
  const KEY = "sk-prod-abc123..."
  Fix: Move to environment variable, add to .gitignore

⚡ THE PERFORMANCE MONK
─────────────────────────
SIGNIFICANT: Lines 12-34 — N+1 query pattern detected
  User.findAll() followed by user.getPosts() inside loop
  Fix: Use eager loading with JOIN or Promise.all()
  Current: O(n) queries. Target: O(1).

MINOR: Line 67 — Synchronous fs.readFileSync in request handler
  Fix: Use fs.promises.readFile() to avoid blocking the event loop

🤔 THE JUNIOR DEV WHO ASKS WHY
────────────────────────────────
Why does processUser() also send emails? Shouldn't that be separate?
What happens if userId is null on line 47?
What does the magic number 3600 mean on line 89? Shouldn't it be MAX_SESSION_SECONDS?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VERDICT: 1 CRITICAL | 1 HIGH | 1 SIGNIFICANT | 1 MINOR | 3 QUESTIONS
Review took: 2.3 seconds (parallel)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Why parallel?

All 3 API calls fire simultaneously via `Promise.all()`. Instead of 3 sequential calls (~6-9s), you get all 3 results in the time of the slowest single call (~2-3s).

```js
// All 3 fire at the same time
const [security, performance, clarity] = await Promise.all([
  callClaude(apiKey, PERSONAS.security, diff),
  callClaude(apiKey, PERSONAS.performance, diff),
  callClaude(apiKey, PERSONAS.clarity, diff),
]);
```

---

## Requirements

- Node.js >= 18
- Git repository
- `ANTHROPIC_API_KEY` (optional — works without it in mock mode)

---

## Model

Uses `claude-haiku-4-5-20251001` — fast and cheap. 400 tokens per persona, 3 parallel calls.

---

## License

MIT
