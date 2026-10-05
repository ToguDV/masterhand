import assert from "node:assert/strict"
import { test } from "node:test"
import { ACTIONS, COMPOSE_FILES, composeArgs, DEV_SERVICE, ENV_FILE, targetFor } from "./dev-docker.mjs"

test("composeArgs uses the deployment stack plus the dev override and env file", () => {
  const args = composeArgs(["up", "--build"])
  assert.deepEqual(args.slice(0, 1 + COMPOSE_FILES.length + 2), [
    "compose",
    ...COMPOSE_FILES,
    "--env-file",
    ENV_FILE,
  ])
  assert.deepEqual(args.slice(-2), ["up", "--build"])
})

test("the dev stack runs the web front end except for the server target", () => {
  assert.equal(targetFor("web"), "web")
  assert.equal(targetFor("server"), "server")
  assert.equal(targetFor("desktop"), "web")
  assert.equal(targetFor("mobile"), "web")
})

test("supported actions are stable", () => {
  assert.deepEqual(ACTIONS, ["web", "server", "desktop", "mobile", "stop", "restart", "logs"])
})

test("restart targets the hot-reloading service on the dev stack", () => {
  assert.deepEqual(composeArgs(["restart", DEV_SERVICE]).slice(-2), ["restart", "masterhand"])
})
