import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8")

const dockerfile = read("deploy", "opencode.Dockerfile")
const compose = read("deploy", "docker-compose.yml")
const envExample = read("deploy", ".env.example")
const devEnvExample = read("deploy", ".env.dev.example")
const drill = read("deploy", "agent-exec-drill.sh")

// Shell continuations split a command over several lines; join them so the
// assertions read the command that actually runs, not a fragment of it.
const dockerfileFlat = dockerfile.replace(/\\\n/g, " ")

/** One compose service block, so an arg cannot pass by living in another service. */
function serviceBlock(name) {
  const start = compose.search(new RegExp(`^  ${name}:$`, "m"))
  assert.ok(start >= 0, `missing compose service ${name}`)
  const rest = compose.slice(start + 1)
  const end = rest.search(/^  [a-z][a-z0-9-]*:$/m)
  return end < 0 ? rest : rest.slice(0, end)
}

// The agent toolbox bakes developer tooling into the image at build time.
// It must never be solved by granting root: `agent-exec` keeps dropping every
// shell to uid 1001 (ADR-22), and the toolbox only changes what is installed,
// not who may run it.

test("the agent toolbox is selectable and defaults to full", () => {
  assert.match(dockerfileFlat, /ARG AGENT_TOOLBOX=full/)
  assert.match(dockerfileFlat, /case "\$\{AGENT_TOOLBOX\}" in/)
  assert.match(dockerfileFlat, /minimal\) packages="" ;;/)
  assert.match(dockerfileFlat, /standard\|full\)/)
  // An unknown value must fail the build instead of silently building minimal.
  assert.match(dockerfileFlat, /AGENT_TOOLBOX must be minimal\|standard\|full/)
})

test("standard installs the day-to-day build and database tooling", () => {
  const packages = [
    "python3",
    "python3-venv",
    "python3-pip",
    "make",
    "g++",
    "pkg-config",
    "sqlite3",
    "postgresql-client",
    "mariadb-client-core",
    "redis-tools",
    "jq",
    "less",
    "file",
    "tree",
    "zip",
    "procps",
    "lsof",
    "netcat-openbsd",
    "bind9-dnsutils",
    "iproute2",
    "openssh-client",
    "git-lfs",
    "shellcheck",
  ]
  const declared = new Set(
    (dockerfileFlat.match(/packages="(python3[^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean),
  )
  for (const name of packages) {
    assert.ok(declared.has(name), `missing ${name}`)
  }
})

test("full adds ffmpeg on top of the standard set", () => {
  assert.match(dockerfileFlat, /packages="\$packages ffmpeg"/)
})

test("the toolbox never adds elevation", () => {
  // `sudo`/`docker` in an install line would hand the agent root, and any
  // setuid helper other than agent-exec widens the attack surface.
  const installs = dockerfileFlat
    .split("\n")
    .filter((line) => /apt-get install|packages=/.test(line))
    .join("\n")
  assert.doesNotMatch(installs, /\bsudo\b/)
  assert.doesNotMatch(installs, /\b(docker|podman|nerdctl)\b/)
  // openssh-client ships setuid ssh-keysign; the agent never needs it.
  assert.match(dockerfileFlat, /chmod u-s \/usr\/lib\/openssh\/ssh-keysign/)
  assert.match(dockerfileFlat, /\[ ! -u \/usr\/lib\/openssh\/ssh-keysign \]/)
  // The dropper and the runtime user stay exactly as ADR-22 requires, and the
  // last USER wins: a later USER root would silently undo the drop.
  assert.match(dockerfileFlat, /chmod 4755/)
  const users = [...dockerfileFlat.matchAll(/^USER (\S+)$/gm)].map((match) => match[1])
  assert.ok(users.length > 0, "the image must select a runtime user")
  assert.equal(users.at(-1), "node")
  assert.ok(!users.includes("root"), "the runtime image must never run as root")
})

test("package managers are wired inside the toolbox, not for minimal", () => {
  assert.match(dockerfileFlat, /corepack enable/)
  const toolboxRun = dockerfileFlat.slice(
    dockerfileFlat.indexOf('case "${AGENT_TOOLBOX}"'),
    dockerfileFlat.indexOf("RUN npm install -g @opencode/cli"),
  )
  assert.match(toolboxRun, /corepack enable/, "corepack must run inside the non-empty toolbox branch")
})

test("the opencode CLI keeps only the platform variants it can run", () => {
  assert.match(dockerfileFlat, /rm -rf \/usr\/local\/lib\/node_modules\/@opencode\/cli\/node_modules\/@opencode\/\*-musl/)
  // Deleting with a glob is a silent no-op if the layout changes; assert it.
  assert.match(dockerfileFlat, /-name '\*-musl' -print -quit/)
})

test("the browser is pinned, opt-out, and owned by the agent uid", () => {
  assert.match(dockerfileFlat, /ARG PLAYWRIGHT_VERSION=1\.\d+\.\d+/)
  assert.match(dockerfileFlat, /ARG PLAYWRIGHT_BROWSERS=auto/)
  assert.match(dockerfileFlat, /case "\$\{PLAYWRIGHT_BROWSERS\}" in/)
  assert.match(dockerfileFlat, /auto\) if \[ "\$\{AGENT_TOOLBOX\}" = "full" \]/)
  assert.match(dockerfileFlat, /PLAYWRIGHT_BROWSERS_PATH=\/home\/agent\/\.cache\/ms-playwright/)
  assert.match(dockerfileFlat, /playwright install chromium/)
  // `--with-deps` pulls the Xvfb/Mesa/LLVM stack and a large font set; the
  // explicit list plus the drill's real launch keeps that waste out.
  assert.doesNotMatch(dockerfileFlat, /playwright install --with-deps/)
  assert.match(dockerfileFlat, /chown -R agent:node \/home\/agent\/\.cache/)
})

test("build metadata does not invalidate the layers above it", () => {
  // The tier is read by the drill at runtime; placing ENV before the layers
  // that consume the args made every tier change reinstall everything.
  const env = dockerfileFlat.indexOf("ENV AGENT_TOOLBOX")
  assert.ok(env > 0, "the drill needs the baked tier")
  assert.ok(env > dockerfileFlat.indexOf("chown -R agent:node /home/agent/.cache"))
})

test("compose passes the toolbox args to the opencode service only", () => {
  const opencode = serviceBlock("opencode")
  assert.match(opencode, /AGENT_TOOLBOX:\s*\$\{AGENT_TOOLBOX:-full\}/)
  assert.match(opencode, /PLAYWRIGHT_BROWSERS:\s*\$\{PLAYWRIGHT_BROWSERS:-auto\}/)
  assert.match(opencode, /PLAYWRIGHT_VERSION:\s*\$\{PLAYWRIGHT_VERSION:-1\.\d+\.\d+\}/)
  assert.doesNotMatch(serviceBlock("masterhand"), /AGENT_TOOLBOX|PLAYWRIGHT_/)
})

test("both env examples document the toolbox", () => {
  for (const [label, example] of [
    ["deploy/.env.example", envExample],
    ["deploy/.env.dev.example", devEnvExample],
  ]) {
    assert.match(example, /^AGENT_TOOLBOX=full$/m, `${label} must document AGENT_TOOLBOX`)
    assert.match(example, /^PLAYWRIGHT_BROWSERS=auto$/m, `${label} must document PLAYWRIGHT_BROWSERS`)
    assert.match(example, /^PLAYWRIGHT_VERSION=1\.\d+\.\d+$/m, `${label} must document PLAYWRIGHT_VERSION`)
  }
})

test("the runtime drill executes the toolbox and proves there is no elevation", () => {
  // Presence is not enough: the drill must run each tool and assert the
  // negatives in every tier (they used to live inside the non-minimal branch).
  for (const command of ["python3", "make", "g++", "psql", "sqlite3", "redis-cli", "jq", "pnpm", "ffmpeg"]) {
    assert.ok(drill.includes(command), `drill does not check ${command}`)
  }
  assert.match(drill, /python3 -m venv/)
  assert.match(drill, /g\+\+ -O0/)
  assert.match(drill, /playwright screenshot/)
  assert.match(drill, /test -w \/usr\/local\/bin/)
  assert.match(drill, /command -v sudo/)
  assert.match(drill, /command -v \$runtime/)
  assert.match(drill, /ssh-keysign/)
  assert.match(drill, /npm prefix -g/)
  assert.match(drill, /AGENT_TOOLBOX/)
  // Probes must not trust the agent-writable PATH entry.
  assert.match(drill, /PATH_NO_AGENT=\/usr\/local\/bin:\/usr\/bin:\/bin/)
})
