#!/usr/bin/env node
/**
 * Run a command under a hard resident-memory limit.
 *
 * Why this exists: `--max-old-space-size` bounds V8's *old space* only. The
 * runaway that took this machine to ~170 GB was not old space — it was native
 * allocation (thousands of `Intl.DateTimeFormat` instances per second) plus
 * several overlapping test processes, and no V8 flag would have stopped it. A
 * limit that actually holds has to watch the operating system's view of the
 * process tree and kill it.
 *
 * Usage:
 *   node scripts/guard.mjs [--limit-mb N] -- <command> [args...]
 *
 * Environment:
 *   DSH_TEST_RSS_LIMIT_MB   limit in MB (default 1024)
 *   DSH_GUARD_POLL_MS       poll interval in ms (default 200)
 *   DSH_GUARD_NO_LOG=1      do not append to the run log
 *   DSH_GUARD_LOG_ABOVE_MB  only log runs whose peak reaches this many MB (default 0 = every run)
 *   DSH_GUARD_LOG_DIR       where the run log lives (default ~/.dsh/logs/guard)
 *
 * By default every run appends one JSON line to `~/.dsh/logs/guard/YYYY-MM-DD.log`: what ran, the
 * peak resident memory of the whole process tree, and how it ended. The default is "every run"
 * because the run that blows up cannot be predicted in advance — the line before the kill is the
 * only record of what led to it. `--log-above-mb N` keeps the log signal-dense if you prefer
 * (a killed run is always logged). Writing is best-effort and never changes an exit code.
 *
 * Exits with the child's code, or 124 when the limit was exceeded.
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Parse the small option surface, then the command after `--`. */
function parseArguments(argv) {
  const options = {
    limitMb: Number(process.env.DSH_TEST_RSS_LIMIT_MB ?? 1024),
    logAboveMb: Number(process.env.DSH_GUARD_LOG_ABOVE_MB ?? 0),
    pollMs: Number(process.env.DSH_GUARD_POLL_MS ?? 200),
    command: null,
    args: [],
  };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--') {
      options.command = argv[index + 1] ?? null;
      options.args = argv.slice(index + 2);
      break;
    }
    if (token === '--limit-mb') {
      options.limitMb = Number(argv[index + 1]);
      index += 2;
      continue;
    }
    if (token === '--log-above-mb') {
      options.logAboveMb = Number(argv[index + 1]);
      index += 2;
      continue;
    }
    options.command = token;
    options.args = argv.slice(index + 1);
    break;
  }
  return options;
}

/**
 * Resident memory of a process tree, in kilobytes.
 * @param rootPid - the tree's root.
 * @returns total RSS across the root and every descendant.
 */
function treeRssKb(rootPid) {
  let rows;
  try {
    rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return 0;
  }
  const byParent = new Map();
  const rss = new Map();
  for (const line of rows.split('\n')) {
    const [pid, ppid, value] = line.trim().split(/\s+/);
    if (pid === undefined || ppid === undefined || value === undefined) continue;
    rss.set(Number(pid), Number(value));
    const children = byParent.get(Number(ppid)) ?? [];
    children.push(Number(pid));
    byParent.set(Number(ppid), children);
  }
  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    for (const child of byParent.get(pid) ?? []) stack.push(child);
  }
  return total;
}

/**
 * SIGKILL a process tree, children first.
 * @param rootPid - the tree's root.
 */
function killTree(rootPid) {
  try {
    execFileSync('pkill', ['-9', '-P', String(rootPid)]);
  } catch {
    /* no children, or already gone */
  }
  try {
    process.kill(rootPid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Append one line to today's guard log.
 *
 * Best-effort by design: a logging failure must never turn a successful run into a failed one,
 * and a guard that cannot write must still guard.
 * @param record - the run summary to serialize.
 */
function logRun(record) {
  if (process.env.DSH_GUARD_NO_LOG === '1') return;
  try {
    const dir = process.env.DSH_GUARD_LOG_DIR ?? path.join(homedir(), '.dsh', 'logs', 'guard');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(path.join(dir, `${day}.log`), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.command === null) {
  console.error('guard: no command given. Usage: node scripts/guard.mjs [--limit-mb N] -- <command> [args...]');
  process.exit(2);
}

// Use the very node running this guard, so the child cannot drift to a different
// installation than the one the flags were chosen for.
const command = options.command === 'node' ? process.execPath : options.command;
const child = spawn(command, options.args, { stdio: 'inherit' });
let peakKb = 0;
let exceeded = false;

const poll = setInterval(() => {
  if (child.exitCode !== null) return;
  const totalKb = treeRssKb(child.pid);
  if (totalKb > peakKb) peakKb = totalKb;
  if (totalKb > options.limitMb * 1024 && !exceeded) {
    exceeded = true;
    console.error(`\nguard: process tree reached ${(totalKb / 1024).toFixed(0)} MB, above the ${options.limitMb} MB limit — killing it.`);
    killTree(child.pid);
  }
}, options.pollMs);

/** Report the peak, record the run, and mirror the child's outcome. */
function finish(code, signal) {
  clearInterval(poll);
  const peakMb = peakKb / 1024;
  console.log(`guard: peak process-tree memory ${peakMb.toFixed(0)} MB (limit ${options.limitMb} MB)`);
  const exitCode = exceeded ? 124 : (signal === null ? (code ?? 0) : 1);
  if (peakMb < options.logAboveMb && !exceeded) return process.exit(exitCode);
  logRun({
    at: new Date().toISOString(),
    command: options.command,
    args: options.args,
    limitMb: options.limitMb,
    peakMb: Number(peakMb.toFixed(1)),
    exceeded,
    exitCode,
    signal: signal ?? null,
  });
  process.exit(exitCode);
}

child.on('exit', finish);
child.on('error', (error) => {
  clearInterval(poll);
  console.error(`guard: could not start ${options.command}: ${error.message}`);
  logRun({
    at: new Date().toISOString(),
    command: options.command,
    args: options.args,
    limitMb: options.limitMb,
    peakMb: Number((peakKb / 1024).toFixed(1)),
    exceeded: false,
    exitCode: 127,
    signal: null,
    error: error.message,
  });
  process.exit(127);
});
