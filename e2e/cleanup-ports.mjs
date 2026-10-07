#!/usr/bin/env node
/**
 * Frees the E2E-reserved ports before Playwright starts its webServers.
 *
 * A killed run (Ctrl-C, shell timeout, OOM) orphans the mock-opencode/BFF
 * processes, and Playwright never reaps another run's orphans. With
 * `reuseExistingServer: false` (deliberate: a stale server would serve the
 * previous build and state) the next run then dies with "port is already
 * used". So every `test:e2e` invocation frees both ports first.
 *
 * The ports are E2E-reserved (WORKFLOW.md: no conflict with `npm run dev`),
 * so anything listening there is by definition a stale harness server.
 * SIGTERM first (lets tsx/node exit cleanly), SIGKILL to survivors.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

// Must mirror MOCK_PORT/BFF_PORT in playwright.config.ts.
const PORTS = [4097, 8788];
const TERM_GRACE_MS = 2000;

/** Inodes of LISTEN sockets on the port, via /proc (Linux, no dependencies). */
function procNetInodes(port) {
  const inodes = new Set();
  const want = port.toString(16).toLowerCase();
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
      const sep = fields[1].lastIndexOf(":");
      if (sep === -1 || fields[1].slice(sep + 1).toLowerCase() !== want) continue;
      if (fields[3] !== "0A") continue; // LISTEN only
      inodes.add(fields[9]);
    }
  }
  return inodes;
}

/** PIDs holding any of the inodes, found by scanning per-process fd dirs. */
function pidsHolding(inodes) {
  const pids = new Set();
  if (inodes.size === 0) return pids;
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
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
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) {
        pids.add(pid);
        break;
      }
    }
  }
  return pids;
}

/** Fallback for non-Linux hosts: PIDs via lsof. */
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
for (const port of PORTS) {
  const pids = useProc ? pidsHolding(procNetInodes(port)) : pidsFromLsof(port);
  for (const pid of pids) {
    if (!victims.has(pid)) victims.set(pid, []);
    victims.get(pid).push(port);
  }
}

if (victims.size === 0) {
  console.log(`[cleanup-ports] ports ${PORTS.join(", ")} already free`);
  process.exit(0);
}

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
