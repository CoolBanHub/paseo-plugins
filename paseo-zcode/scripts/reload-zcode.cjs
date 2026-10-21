const { execFile } = require("node:child_process");
const { readdirSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function storedAgentIds(paseoHome) {
  const root = join(paseoHome, "agents");
  const ids = new Set();
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const file of readdirSync(join(root, directory.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const agent = JSON.parse(readFileSync(join(root, directory.name, file.name), "utf8"));
      if (agent.provider !== "zcode") continue;
      if (typeof agent.id !== "string" || !agent.id) throw new Error("A saved ZCode agent has no ID; reload canceled");
      ids.add(agent.id);
    }
  }
  return [...ids];
}

function assertIdle(snapshots) {
  for (const agent of snapshots) {
    if (agent.Provider !== "zcode" || !["idle", "closed", "error"].includes(agent.Status)
      || (agent.PendingPermissions?.length ?? 0) > 0) {
      throw new Error(`Reload canceled: ZCode agent ${agent.Id ?? "unknown"} is ${agent.Status ?? "unavailable"}. Wait for its work to finish.`);
    }
  }
}

async function reloadZcode({
  paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo"),
  checkOnly = false,
  listAgentIds = storedAgentIds,
  run = (args) => execFileAsync("paseo", args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }),
} = {}) {
  const selectedHome = resolve(paseoHome);
  const snapshots = [];
  // Use live inspect responses. Saved lastStatus can be stale after a crash.
  // The local agent store supplies IDs because older hosts reject the global
  // directory query emitted by newer CLIs (background-workspace negotiation).
  for (const id of listAgentIds(selectedHome)) {
    const { stdout } = await run(["inspect", id, "--json", "--home", selectedHome]);
    const snapshot = JSON.parse(stdout);
    if (snapshot.Id !== id) throw new Error(`Unexpected inspection response for ${id}; reload canceled`);
    assertIdle([snapshot]);
    snapshots.push(snapshot);
  }
  if (checkOnly) return { checkedAgents: snapshots.length, reloaded: false };
  const { stdout } = await run(["plugin", "reload", "zcode", "--home", selectedHome]);
  return { checkedAgents: snapshots.length, reloaded: true, output: stdout };
}

module.exports = { assertIdle, reloadZcode };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    console.error("Usage: node scripts/reload-zcode.cjs [--check] (PASEO_HOME selects the local daemon)");
    process.exitCode = 1;
  } else {
    reloadZcode({ checkOnly: args.includes("--check") }).then((result) => {
      console.log(`Checked ${result.checkedAgents} ZCode agents: none are running or awaiting permission.`);
      if (result.output) process.stdout.write(result.output);
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
