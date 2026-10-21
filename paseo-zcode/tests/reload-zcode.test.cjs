const assert = require("node:assert/strict");
const test = require("node:test");
const { reloadZcode } = require("../scripts/reload-zcode.cjs");

function fixture(inspection) {
  const calls = [];
  return {
    calls,
    options: {
      paseoHome: "/mock/paseo-home",
      listAgentIds: () => ["agent-zcode"],
      run: async (args) => {
        calls.push(args);
        if (args[0] !== "inspect") return { stdout: "reloaded\n" };
        if (inspection instanceof Error) throw inspection;
        return { stdout: JSON.stringify({ Id: "agent-zcode", Provider: "zcode", PendingPermissions: [], ...inspection }) };
      },
    },
  };
}

for (const status of ["running", "initializing", "unknown"]) {
  test(`reload never runs while live status is ${status}`, async () => {
    const f = fixture({ Status: status });
    await assert.rejects(reloadZcode(f.options), /Reload canceled/);
    assert.ok(f.calls.every((args) => args[0] === "inspect"));
  });
}

test("reload never runs if live inspection fails", async () => {
  const f = fixture(new Error("daemon unavailable"));
  await assert.rejects(reloadZcode(f.options), /daemon unavailable/);
  assert.ok(f.calls.every((args) => args[0] === "inspect"));
});

test("reload never interrupts an agent awaiting permission", async () => {
  const f = fixture({ Status: "idle", PendingPermissions: [{ id: "permission" }] });
  await assert.rejects(reloadZcode(f.options), /Reload canceled/);
  assert.ok(f.calls.every((args) => args[0] === "inspect"));
});

test("check mode reads live state without reloading", async () => {
  const f = fixture({ Status: "idle" });
  assert.deepEqual(await reloadZcode({ ...f.options, checkOnly: true }), { checkedAgents: 1, reloaded: false });
  assert.ok(f.calls.every((args) => args[0] === "inspect"));
});

test("idle agents permit reloading only the selected local daemon", async () => {
  const f = fixture({ Status: "idle" });
  const result = await reloadZcode(f.options);
  assert.equal(result.reloaded, true);
  assert.deepEqual(f.calls.at(-1), ["plugin", "reload", "zcode", "--home", "/mock/paseo-home"]);
});
