#!/usr/bin/env node
/**
 * Frees the whole E2E port block before Playwright starts, and wipes the E2E
 * scratch root a killed run left behind.
 *
 * A killed run (Ctrl-C, shell timeout, OOM) orphans the mock-opencode/BFF
 * servers of its workers and leaves their scratch state (SQLite, workspaces,
 * cloudflared die file) on disk. The per-worker servers are spawned and torn
 * down by the worker-scoped `harness` fixture in `e2e/fixtures.ts`; when the
 * run dies nothing else reaps them, and the next run would either die with
 * "port is already used" or silently read a stale server's state. So every
 * `test:e2e` invocation frees the whole reserved per-worker block and wipes
 * the scratch root first.
 *
 * The ports are E2E-reserved (no conflict with `npm run dev`: opencode 4096,
 * BFF 8787, Vite 5173; production preview pool 3200-3299), so anything
 * listening there is by definition a stale harness server. Worker N (0-based)
 * uses mock port 4097+N and BFF port 8788+N; every worker of the maximum
 * block is swept, so a killed run with any `--workers` up to the maximum is
 * reclaimed without knowing which workers actually ran.
 * SIGTERM first (lets tsx/node exit cleanly), SIGKILL to survivors.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";

// MUST mirror e2e/paths.ts (E2E_MOCK_BASE_PORT, E2E_BFF_BASE_PORT,
// E2E_MAX_WORKERS, E2E_SCRATCH_ROOT): the static guard in
// scripts/e2e-harness.test.mjs pins both sides together.
const MOCK_BASE = 4097;
const BFF_BASE = 8788;
const MAX_WORKERS = 8;
const SCRATCH_ROOT = "/tmp/masterhand-e2e";
const TERM_GRACE_MS = 2000;

/** The full reserved block, derived: mock 4097..4104, BFF 8788..8795. */
const PORTS = [
  ...Array.from({ length: MAX_WORKERS }, (_, index) => MOCK_BASE + index),
  ...Array.from({ length: MAX_WORKERS }, (_, index) => BFF_BASE + index),
];

/**
 * Single pass over /proc/net/{tcp,tcp6}: inode -> wanted ports listening on it
 * (LISTEN sockets only, "0A"). Built once for the whole block so the per-fd
 * scan below only walks /proc once, however many ports are swept.
 */
function listenInodesFor(ports) {
  const wanted = new Map();
  for (const port of ports) wanted.set(port.toString(16).toLowerCase(), port);
  const byInode = new Map();
  for (const file of ["tcp", "tcp6"]) {
    let text;
    try {
      text = readFileSync(`/proc/net/${file}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      if (fields[3] !== "0A") continue; // LISTEN only
      const sep = fields[1].lastIndexOf(":");
      if (sep === -1) continue;
      const port = wanted.get(fields[1].slice(sep + 1).toLowerCase());
      if (port === undefined) continue;
      const inode = fields[9];
      if (!byInode.has(inode)) byInode.set(inode, []);
      const held = byInode.get(inode);
      if (!held.includes(port)) held.push(port);
    }
  }
  return byInode;
}

/** Single pass over every process's fds: pid -> ports of the block it holds. */
function pidsHolding(byInode) {
  const victims = new Map();
  if (byInode.size === 0) return victims;
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return victims;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // exited or unreadable
    }
    const ports = new Set();
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      const held = match ? byInode.get(match[1]) : undefined;
      if (!held) continue;
      for (const port of held) ports.add(port);
    }
    if (ports.size > 0) victims.set(pid, [...ports].sort((a, b) => a - b));
  }
  return victims;
}

/** Fallback for non-Linux hosts: PIDs on the port via lsof (per-port loop). */
function pidsFromLsof(port) {
  const pids = new Set();
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid);
    }
  } catch {
    // Nothing listening, or lsof missing — either way nothing to kill.
  }
  return pids;
}

function describe(pid) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .slice(0, 4)
      .join(" ");
    return cmd ? `${cmd} (pid ${pid})` : `pid ${pid}`;
  } catch {
    return `pid ${pid}`;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let useProc = false;
try {
  readdirSync("/proc/net");
  useProc = true;
} catch {
  console.log("[cleanup-ports] no /proc, falling back to lsof");
}

/** pid -> ports it holds. */
const victims = new Map();
if (useProc) {
  for (const [pid, ports] of pidsHolding(listenInodesFor(PORTS))) victims.set(pid, ports);
} else {
  for (const port of PORTS) {
    for (const pid of pidsFromLsof(port)) {
      if (!victims.has(pid)) victims.set(pid, []);
      victims.get(pid).push(port);
    }
  }
}

if (victims.size === 0) {
  console.log(`[cleanup-ports] ports ${PORTS.join(", ")} already free`);
} else {
  for (const [pid, ports] of victims) {
    console.log(`[cleanup-ports] SIGTERM ${describe(pid)} (holding port ${ports.join(", ")})`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Exited between the scan and the signal.
    }
  }

  await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));

  for (const [pid] of victims) {
    if (!alive(pid)) continue;
    console.log(`[cleanup-ports] SIGKILL pid ${pid}`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Exited while we waited.
    }
  }
}

// Only after the stale servers are reaped: a killed run's worker state
// (SQLite, workspaces, die files) must never leak into the next one.
rmSync(SCRATCH_ROOT, { recursive: true, force: true });
console.log(`[cleanup-ports] wiped ${SCRATCH_ROOT}`);
