#!/usr/bin/env node

import { execFileSync } from 'child_process';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── PERSONAS ─────────────────────────────────────────────────────────────────

const PERSONAS = {
  security: {
    icon: '🔐',
    name: 'THE PARANOID SECURITY REVIEWER',
    system: `You are an extremely paranoid security engineer. You have seen every OWASP vulnerability in production. Review this code ONLY for security issues. Look for: SQL injection, XSS, command injection, hardcoded secrets/API keys, authentication bypasses, insecure dependencies, exposed sensitive data, SSRF, path traversal, race conditions. Be concise — list issues as: CRITICAL/HIGH/MEDIUM/LOW: description + line reference + how to fix. If no issues found, say "Clean. For now." Never compliment the code.`,
  },
  performance: {
    icon: '⚡',
    name: 'THE PERFORMANCE MONK',
    system: `You are a performance-obsessed engineer who has optimized systems at scale. Review this code ONLY for performance issues. Look for: N+1 queries, unnecessary loops, missing indexes (if DB), synchronous blocking calls where async would work, memory leaks, large payloads, missing caching opportunities, inefficient algorithms (O(n²) where O(n) exists), excessive object creation. Rate each issue: BLOCKING/SIGNIFICANT/MINOR. Include Big-O analysis where relevant. Never discuss security or readability.`,
  },
  clarity: {
    icon: '🤔',
    name: 'THE JUNIOR DEV WHO ASKS WHY',
    system: `You are a smart junior developer reviewing this code for the first time. You ask honest questions about things that aren't clear. Your review is: "Why does this..." / "What happens if..." / "Shouldn't this be..." questions. Focus on: confusing variable names, unexplained magic numbers, missing comments on complex logic, functions that do too many things, error handling gaps, edge cases not handled. List as questions, not criticisms. Be genuine — if something is clear, don't ask about it.`,
  },
};

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    diffRange: 'HEAD~1',
    file: null,
    personas: 'all',
    save: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--diff':
        opts.diffRange = args[++i];
        break;
      case '--file':
        opts.file = args[++i];
        break;
      case '--personas':
        opts.personas = args[++i];
        break;
      case '--save':
        opts.save = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
multi-persona-review 🎭  — 3 AI experts review your code simultaneously

USAGE
  mpr [options]
  node index.js [options]

OPTIONS
  --diff RANGE       Git diff range (default: HEAD~1)
                     Examples: main..HEAD, HEAD~3..HEAD, abc123..def456
  --file PATH        Review a specific file's diff only
  --personas LIST    Which personas to use: all | security | performance | clarity
                     Comma-separated for multiple: security,performance
  --save             Save review to ./reviews/TIMESTAMP-review.md
  --help, -h         Show this help

EXAMPLES
  mpr                              Review last commit with all 3 personas
  mpr --diff main..HEAD            Review everything since branching from main
  mpr --file src/auth.js           Review only auth.js changes
  mpr --personas security          Only the paranoid security reviewer
  mpr --save                       Save output to ./reviews/

SETUP
  export ANTHROPIC_API_KEY=your_key_here
  `);
}

// ─── GIT DIFF ────────────────────────────────────────────────────────────────

const MAX_DIFF_CHARS = 4000;

function getDiff(opts) {
  try {
    // Build git args safely using execFileSync (no shell injection)
    let gitArgs;
    if (opts.file) {
      gitArgs = ['diff', opts.diffRange, 'HEAD', '--', opts.file];
    } else {
      gitArgs = ['diff', opts.diffRange, 'HEAD'];
    }

    let diff = execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    if (!diff.trim()) {
      // Try without trailing HEAD for ranges like main..HEAD
      const altArgs = opts.file
        ? ['diff', opts.diffRange, '--', opts.file]
        : ['diff', opts.diffRange];
      diff = execFileSync('git', altArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    }

    if (!diff.trim()) {
      return { diff: null, truncated: false };
    }

    const truncated = diff.length > MAX_DIFF_CHARS;
    if (truncated) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + '\n\n[... diff truncated at 4000 chars ...]';
    }

    return { diff, truncated };
  } catch (err) {
    return { diff: null, truncated: false, error: err.message };
  }
}

// ─── ANTHROPIC API CALL ───────────────────────────────────────────────────────

function callClaude(apiKey, persona, diffContent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: persona.system,
      messages: [
        {
          role: 'user',
          content: `Review this git diff:\n\n\`\`\`diff\n${diffContent}\n\`\`\``,
        },
      ],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'API error'));
          } else {
            resolve(parsed.content?.[0]?.text || 'No response');
          }
        } catch (e) {
          reject(new Error('Failed to parse API response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timed out after 30s'));
    });

    req.write(body);
    req.end();
  });
}

// ─── VERDICT PARSER ──────────────────────────────────────────────────────────

function parseVerdict(reviews) {
  const counts = {
    CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0,
    SIGNIFICANT: 0, BLOCKING: 0, MINOR: 0, QUESTIONS: 0,
  };

  if (reviews.security) {
    const text = reviews.security;
    counts.CRITICAL += (text.match(/\bCRITICAL\b/g) || []).length;
    counts.HIGH += (text.match(/\bHIGH\b/g) || []).length;
    counts.MEDIUM += (text.match(/\bMEDIUM\b/g) || []).length;
    counts.LOW += (text.match(/\bLOW\b/g) || []).length;
  }

  if (reviews.performance) {
    const text = reviews.performance;
    counts.BLOCKING += (text.match(/\bBLOCKING\b/g) || []).length;
    counts.SIGNIFICANT += (text.match(/\bSIGNIFICANT\b/g) || []).length;
    counts.MINOR += (text.match(/\bMINOR\b/g) || []).length;
  }

  if (reviews.clarity) {
    const text = reviews.clarity;
    counts.QUESTIONS += (text.match(/\?/g) || []).length;
  }

  const parts = [];
  if (counts.CRITICAL) parts.push(`${counts.CRITICAL} CRITICAL`);
  if (counts.BLOCKING) parts.push(`${counts.BLOCKING} BLOCKING`);
  if (counts.HIGH) parts.push(`${counts.HIGH} HIGH`);
  if (counts.SIGNIFICANT) parts.push(`${counts.SIGNIFICANT} SIGNIFICANT`);
  if (counts.MEDIUM) parts.push(`${counts.MEDIUM} MEDIUM`);
  if (counts.LOW) parts.push(`${counts.LOW} LOW`);
  if (counts.MINOR) parts.push(`${counts.MINOR} MINOR`);
  if (counts.QUESTIONS) parts.push(`${counts.QUESTIONS} QUESTIONS`);

  return parts.length ? parts.join(' | ') : 'No issues flagged';
}

// ─── MOCK REVIEWS (no API key) ────────────────────────────────────────────────

function getMockReview(personaKey) {
  const mocks = {
    security: `[No API key — here's what I'd look for]

CRITICAL watch: String concatenation in queries, eval() usage, exec() with user input
HIGH watch: Hardcoded credentials, tokens, or passwords anywhere in the diff
HIGH watch: Missing authentication/authorization checks on new endpoints
MEDIUM watch: User input used in file paths (path traversal risk)
MEDIUM watch: Missing input validation or sanitization
LOW watch: Dependencies added without pinned versions

Run with ANTHROPIC_API_KEY set for real analysis.`,

    performance: `[No API key — here's what I'd look for]

BLOCKING watch: New loops inside loops (O(n²) patterns)
BLOCKING watch: Database queries inside loops (N+1 problem)
SIGNIFICANT watch: Synchronous file reads in request handlers
SIGNIFICANT watch: Missing Promise.all() where independent async calls could run in parallel
MINOR watch: Unnecessary object/array spreading when mutation is safe
MINOR watch: Missing memoization for expensive pure functions

Run with ANTHROPIC_API_KEY set for real analysis.`,

    clarity: `[No API key — here's what I'd ask]

Why does this function do more than one thing?
What happens if the input is null or undefined here?
What does this magic number mean — shouldn't it be a named constant?
Shouldn't this error be handled rather than silently swallowed?
Why is this variable named 'data' — what kind of data?

Run with ANTHROPIC_API_KEY set for real analysis.`,
  };

  return mocks[personaKey] || 'No mock available.';
}

// ─── SAVE TO FILE ─────────────────────────────────────────────────────────────

function saveReview(content) {
  const dir = path.join(process.cwd(), 'reviews');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = path.join(dir, `${ts}-review.md`);

  fs.writeFileSync(filename, content, 'utf8');
  return filename;
}

// ─── PERSONA KEY RESOLUTION ───────────────────────────────────────────────────

function getPersonaKeys(personas) {
  if (personas === 'all') return ['security', 'performance', 'clarity'];
  return personas
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => PERSONAS[p]);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const LINE = '\u2501'.repeat(51);
const THIN = '\u2500'.repeat(33);

async function main() {
  const opts = parseArgs(process.argv);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const personaKeys = getPersonaKeys(opts.personas);

  if (!personaKeys.length) {
    console.error('No valid personas specified. Use: all | security | performance | clarity');
    process.exit(1);
  }

  // Get diff
  const { diff, truncated, error } = getDiff(opts);

  const diffLabel = opts.file
    ? `${opts.diffRange}..HEAD — ${opts.file}`
    : `${opts.diffRange}..HEAD`;

  if (error) {
    console.error(`\nFailed to get git diff: ${error}`);
    console.error('Make sure you are inside a git repository.\n');
    process.exit(1);
  }

  if (!diff) {
    console.log('\nNo diff found. Nothing to review.');
    console.log(`Tried: git diff ${opts.diffRange} HEAD\n`);
    process.exit(0);
  }

  // Header
  console.log('');
  console.log(LINE);
  console.log('  MULTI-PERSONA REVIEW');
  console.log(`  Diff: ${diffLabel}  |  ${personaKeys.length} reviewer${personaKeys.length !== 1 ? 's' : ''}  |  parallel`);
  console.log(LINE);

  if (truncated) {
    console.log('');
    console.log('  Warning: Diff truncated at 4000 chars');
  }

  if (!apiKey) {
    console.log('');
    console.log('  No ANTHROPIC_API_KEY — showing mock reviews');
    console.log('  Set your key: export ANTHROPIC_API_KEY=sk-ant-...');
  } else {
    console.log('');
    process.stdout.write(`Calling ${personaKeys.length} reviewer${personaKeys.length !== 1 ? 's' : ''} in parallel...`);
  }

  const startTime = Date.now();

  // Run all persona calls in parallel with Promise.all()
  const reviewPromises = personaKeys.map((key) => {
    if (!apiKey) {
      return Promise.resolve(getMockReview(key));
    }
    return callClaude(apiKey, PERSONAS[key], diff).catch((err) => err);
  });

  const results = await Promise.all(reviewPromises);
  const timeTaken = (Date.now() - startTime) / 1000;

  if (apiKey) {
    process.stdout.write(` done in ${timeTaken.toFixed(1)}s\n`);
  }

  // Map results
  const reviews = {};
  personaKeys.forEach((key, i) => {
    reviews[key] = results[i];
  });

  // Build full output string for optional save
  const outputLines = [];

  for (const key of personaKeys) {
    const persona = PERSONAS[key];
    const review = reviews[key];

    outputLines.push('');
    outputLines.push(`${persona.icon} ${persona.name}`);
    outputLines.push(THIN);

    if (review instanceof Error) {
      outputLines.push(`ERROR: ${review.message}`);
    } else {
      outputLines.push(review);
    }
  }

  outputLines.push('');
  outputLines.push(LINE);

  const verdictStr = parseVerdict(reviews);
  outputLines.push(`VERDICT: ${verdictStr}`);
  outputLines.push(`Review took: ${timeTaken.toFixed(1)} seconds (parallel)`);
  outputLines.push(LINE);
  outputLines.push('');

  const fullOutput = outputLines.join('\n');
  console.log(fullOutput);

  // Save if requested
  if (opts.save) {
    const header = [
      LINE,
      '  MULTI-PERSONA REVIEW',
      `  Diff: ${diffLabel}  |  ${personaKeys.length} reviewers  |  parallel`,
      LINE,
      '',
    ].join('\n');
    const saved = saveReview(header + fullOutput);
    console.log(`Saved to: ${saved}\n`);
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
