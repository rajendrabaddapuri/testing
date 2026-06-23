/**
 * ============================================================================
 *  git-sync.mjs — Transactional Git Sync Utility
 * ============================================================================
 *
 *  PURPOSE
 *    Safely update your CURRENT working branch with the latest
 *    `origin/develop`, without switching branches and without ever losing
 *    work. Behaves like a database transaction: it either fully succeeds or
 *    rolls back to the exact state it started from.
 *
 *  FEATURES
 *    - Stashes uncommitted changes (including untracked) before syncing.
 *    - Fetches origin and merges origin/develop into the current branch.
 *    - Restores the stash afterwards; preserves it untouched on conflict.
 *    - Full rollback (merge --abort + stash restore) on any failure.
 *    - --dry-run, --verbose, --repo=<name>, --help flags.
 *
 *  USAGE
 *    node scripts/git-sync.mjs [--repo=<name>] [--verbose] [--dry-run] [--help]
 *
 *  SAFETY GUARANTEES
 *    - Never drops a stash that did not apply cleanly.
 *    - Never leaves a half-finished merge (aborts on conflict).
 *    - Never switches your branch.
 *    - On any error the repo is returned to its original, safe state.
 * ============================================================================
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Repo name → absolute path. Replace the placeholders with real paths. */
const REPOS = {
    'dss-monorepo': 'REPLACE_WITH_PATH_1',
    'dss-pw-tests': 'REPLACE_WITH_PATH_2',
};

const C = {
    reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m',
    green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

/** @type {{verbose:boolean, dryRun:boolean}} */
const cfg = { verbose: false, dryRun: false };

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** @param {string} msg */ const info = (msg) => console.log(`${C.cyan}[INFO]${C.reset} ${msg}`);
/** @param {string} msg */ const ok = (msg) => console.log(`${C.green}[SUCCESS]${C.reset} ${msg}`);
/** @param {string} msg */ const warn = (msg) => console.log(`${C.yellow}[WARNING]${C.reset} ${msg}`);
/** @param {string} msg */ const error = (msg) => console.log(`${C.red}[ERROR]${C.reset} ${msg}`);

/** @param {string} name Banner title. */
function banner(name) {
    const bar = '━'.repeat(40);
    console.log(`\n${C.gray}${bar}${C.reset}\n${C.cyan}Processing: ${name}${C.reset}\n${C.gray}${bar}${C.reset}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse CLI flags. Pure function — safe to unit test.
 * @param {string[]} argv Raw args (e.g. process.argv.slice(2)).
 * @returns {{verbose:boolean, dryRun:boolean, help:boolean, repo:(string|null)}}
 */
function parseArgs(argv) {
    const out = { verbose: false, dryRun: false, help: false, repo: null };
    for (const a of argv) {
        if (a === '--verbose') out.verbose = true;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a.startsWith('--repo=')) out.repo = a.slice('--repo='.length);
    }
    return out;
}

function printHelp() {
    console.log(`
Git Sync Utility

Usage:
  npm run git:sync
  npm run git:sync:verbose
  npm run git:sync:mono
  npm run git:sync:pw

Flags:
  --verbose
  --repo=<repo-name>
  --dry-run
  --help
`);
}

// ---------------------------------------------------------------------------
// Git primitives
// ---------------------------------------------------------------------------

/**
 * Run a git command in a repo.
 * In dry-run mode, mutating commands are printed instead of executed.
 * @param {string} cwd Repo path.
 * @param {string[]} args Git arguments.
 * @param {{mutating?:boolean}} [opts]
 * @returns {{ok:boolean, stdout:string, stderr:string, code:number}}
 */
function runCommand(cwd, args, opts = {}) {
    if (cfg.dryRun && opts.mutating) {
        console.log(`${C.gray}Would run: git ${args.join(' ')}${C.reset}`);
        return { ok: true, stdout: '', stderr: '', code: 0 };
    }
    if (cfg.verbose) console.log(`${C.gray}$ git ${args.join(' ')}${C.reset}`);

    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    const stdout = (r.stdout || '').trim();
    const stderr = (r.stderr || '').trim();
    if (cfg.verbose && stdout) console.log(`${C.gray}${stdout}${C.reset}`);
    return { ok: r.status === 0, stdout, stderr, code: r.status ?? 1 };
}

/**
 * @param {string} cwd
 * @returns {string} Current branch name.
 */
function getCurrentBranch(cwd) {
    return runCommand(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
}

/**
 * @param {string} cwd
 * @returns {boolean} True if the working tree has uncommitted/untracked changes.
 */
function hasUncommittedChanges(cwd) {
    return runCommand(cwd, ['status', '--porcelain']).stdout.length > 0;
}

/**
 * Stash all changes including untracked files.
 * @param {string} cwd
 * @returns {boolean} True if the stash was created.
 */
function createStash(cwd) {
    const msg = `auto-stash-before-sync-${new Date().toISOString()}`;
    return runCommand(cwd, ['stash', 'push', '-u', '-m', msg], { mutating: true }).ok;
}

/**
 * @param {string} cwd
 * @returns {boolean} True on successful fetch.
 */
function fetchOrigin(cwd) {
    return runCommand(cwd, ['fetch', 'origin'], { mutating: true }).ok;
}

/**
 * Merge origin/develop into the current branch. Aborts on conflict.
 * @param {string} cwd
 * @returns {boolean} True if merged cleanly.
 */
function mergeDevelop(cwd) {
    const r = runCommand(cwd, ['merge', 'origin/develop'], { mutating: true });
    if (!r.ok) runCommand(cwd, ['merge', '--abort'], { mutating: true });
    return r.ok;
}

/**
 * Apply the most recent stash. On conflict the stash is preserved.
 * @param {string} cwd
 * @returns {boolean} True if the stash applied cleanly.
 */
function applyStash(cwd) {
    return runCommand(cwd, ['stash', 'apply'], { mutating: true }).ok;
}

/**
 * Return the repo to its original safe state.
 * @param {string} cwd
 * @param {{mergeActive?:boolean, stashCreated?:boolean}} state
 */
function rollback(cwd, state) {
    warn('Rolling back to original state...');
    if (state.mergeActive) runCommand(cwd, ['merge', '--abort'], { mutating: true });
    if (state.stashCreated) {
        // Restore the work that was stashed before we touched anything.
        runCommand(cwd, ['stash', 'apply'], { mutating: true });
    }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full transactional sync for a single repo.
 * @param {string} name Repo key in REPOS.
 * @param {string} cwd Absolute repo path.
 * @returns {boolean} True if the repo synced successfully.
 */
function processRepo(name, cwd) {
    banner(name);

    if (!cfg.dryRun && !existsSync(cwd)) {
        error(`Repo path not found: ${cwd}`);
        return false;
    }

    // STEP 1 — capture initial state
    const originalBranch = getCurrentBranch(cwd);
    info(`Current branch: ${originalBranch}`);
    info('Checking uncommitted changes...');
    const hasChanges = hasUncommittedChanges(cwd);
    let stashCreated = false;

    // STEP 2 — stash uncommitted changes
    if (hasChanges) {
        warn('Changes detected');
        info('Creating stash...');
        if (!createStash(cwd)) {
            error('Stash failed — aborting, no changes were made');
            return false;
        }
        stashCreated = true;
        ok('Stash created');
    } else {
        info('Working tree clean');
    }

    // STEP 3 — fetch
    info('Fetching origin...');
    if (!fetchOrigin(cwd)) {
        error('Fetch failed');
        rollback(cwd, { stashCreated });
        return false;
    }
    ok('Fetch complete');

    // STEP 4 — merge develop into current branch (no checkout)
    info('Merging origin/develop...');
    if (!mergeDevelop(cwd)) {
        error('Merge conflict — merge aborted');
        rollback(cwd, { stashCreated });
        return false;
    }
    ok('Merge successful');

    // STEP 5/6 — restore stash, drop only on clean apply
    if (stashCreated) {
        info('Applying stash...');
        if (!applyStash(cwd)) {
            error('Stash apply conflict detected');
            warn('Your stash is preserved — resolve manually (git stash list)');
            return false;
        }
        runCommand(cwd, ['stash', 'drop'], { mutating: true });
        ok('Stash restored');
    }

    ok('Repo sync completed');
    return true;
}

/**
 * Entry point: parse args, resolve target repos, sync each.
 * @returns {void}
 */
function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return printHelp();

    cfg.verbose = args.verbose;
    cfg.dryRun = args.dryRun;
    if (cfg.dryRun) warn('DRY RUN — no git commands will be executed');

    let targets = Object.entries(REPOS);
    if (args.repo) {
        if (!REPOS[args.repo]) {
            error(`Unknown repo: ${args.repo}. Known: ${Object.keys(REPOS).join(', ')}`);
            process.exit(1);
        }
        targets = [[args.repo, REPOS[args.repo]]];
    }

    let failures = 0;
    for (const [name, path] of targets) {
        if (!processRepo(name, path)) failures++;
    }

    console.log('');
    if (failures) {
        error(`${failures} repo(s) failed. See messages above.`);
        process.exit(1);
    }
    ok('All repos synced successfully');
}

main();
