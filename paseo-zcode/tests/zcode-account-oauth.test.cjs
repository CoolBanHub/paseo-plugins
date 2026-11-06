const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

const accounts = require("../server/zcode-account.ts");
const oauth = require("../server/zcode-account-oauth.ts");

const PROVIDER = "account:bigmodel-individual-coding-plan";
const START_PLAN = "account:bigmodel-start-plan";

function makeV2Dir(t, { credentials, rules, modelRules = [], settings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-oauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credentials ?? {}));
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({
    config: {
      providerConfigRules: { providerRules: rules ?? [] },
      modelConfigRules: { providerModelRules: modelRules },
    },
  }));
  if (settings !== undefined) fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify(settings));
  return dir;
}

function projectKey(origin, family, accountId, team, selection = "non-team", usageScene = 1) {
  const descriptor = [origin, family, accountId, team, usageScene, selection];
  return `project-key-location:v1:${encodeURIComponent(JSON.stringify(descriptor))}`;
}

function individualRule(models = ["GLM-5.3", "GLM-5.3-Flash"]) {
  return [{ providerId: PROVIDER, config: { modelOrder: models } }];
}

function selection(kind, extra = {}) {
  return { providerFamilyConnectionSelections: { bigmodel: { kind, ...extra } } };
}

function oauthAccount(overrides = {}) {
  return {
    family: "bigmodel",
    planKind: "individual-coding-plan",
    accessToken: "oauth-token",
    zcodeJwtToken: "jwt-token",
    accountIdentity: "user-1",
    location: {
      origin: "https://bigmodel.cn",
      organizationId: "org-1",
      projectId: "proj-1",
      apiKeyId: "key-1",
    },
    ...overrides,
  };
}

function success(body) {
  return { ok: true, status: 200, json: async () => body };
}

test.beforeEach(() => oauth.clearProjectTokenCache());

test("reads an OAuth BigModel account without a manual API key", (t) => {
  const dir = makeV2Dir(t, {
    credentials: {
      "oauth:bigmodel:access_token": "oauth-token",
      "zcodejwttoken": "jwt-token",
      "oauth:bigmodel:user_info": JSON.stringify({ id: "user-1", displayName: "tester" }),
      [`account-provider:${PROVIDER}:auth-source`]: "oauth",
      [projectKey("https://bigmodel.cn", "bigmodel", "user-1", null)]: JSON.stringify({
        organizationId: "org-1",
        projectId: "proj-1",
        apiKeyId: "key-1",
      }),
    },
    rules: individualRule(),
    settings: selection("individual-coding-plan"),
  });

  const providers = accounts.readAccountProviders({ v2Dir: dir });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].providerId, PROVIDER);
  assert.equal(providers[0].apiKey, undefined);
  assert.equal(providers[0].oauth?.accessToken, "oauth-token");
  assert.equal(providers[0].oauth?.accountIdentity, "user-1");
  assert.deepEqual(providers[0].oauth?.location, {
    origin: "https://bigmodel.cn",
    organizationId: "org-1",
    projectId: "proj-1",
    apiKeyId: "key-1",
  });
  assert.deepEqual(providers[0].models, ["GLM-5.3", "GLM-5.3-Flash"]);
});

test("keeps the manual API-key path when auth-source is manual", (t) => {
  const dir = makeV2Dir(t, {
    credentials: {
      "oauth:bigmodel:access_token": "oauth-token",
      "oauth:bigmodel:user_info": JSON.stringify({ id: "user-1" }),
      [`account-provider:coding-plan:${PROVIDER}:account:user-1:api-key`]: "manual-key",
      [`account-provider:${PROVIDER}:auth-source`]: "manual",
    },
    rules: individualRule(),
  });

  const providers = accounts.readAccountProviders({ v2Dir: dir });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].apiKey, "manual-key");
  assert.equal(providers[0].oauth, undefined);
});

test("uses the shared JWT token for a selected Start Plan", (t) => {
  const dir = makeV2Dir(t, {
    credentials: {
      "oauth:bigmodel:access_token": "oauth-token",
      "zcodejwttoken": "jwt-token",
      "oauth:bigmodel:user_info": JSON.stringify({ id: "user-1" }),
    },
    rules: [{ providerId: START_PLAN, config: { modelOrder: ["GLM-5.3-Flash"] } }],
    settings: selection("start-plan"),
  });

  const providers = accounts.readAccountProviders({ v2Dir: dir });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].oauth?.planKind, "start-plan");
  assert.equal(providers[0].oauth?.zcodeJwtToken, "jwt-token");
});

test("skips OAuth accounts without a user identity and reports the reason", (t) => {  const skipped = [];
  const dir = makeV2Dir(t, {
    credentials: {
      "oauth:bigmodel:access_token": "oauth-token",
      "zcodejwttoken": "jwt-token",
    },
    rules: individualRule(),
  });

  const providers = accounts.readAccountProviders({
    v2Dir: dir,
    onSkip: (providerId, reason) => skipped.push({ providerId, reason }),
  });
  assert.deepEqual(providers, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /OAuth/);
});

test("does not silently use Z.ai OAuth credentials", (t) => {
  const skipped = [];
  const dir = makeV2Dir(t, {
    credentials: {
      "oauth:zai:access_token": "zai-token",
      "oauth:zai:user_info": JSON.stringify({ id: "user-zai" }),
      "zcodejwttoken": "jwt-token",
    },
    rules: [{ providerId: "account:zai-individual-coding-plan", config: { modelOrder: ["GLM-5.3"] } }],
    settings: { providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } } },
  });

  const providers = accounts.readAccountProviders({
    v2Dir: dir,
    onSkip: (_providerId, reason) => skipped.push(reason),
  });
  assert.deepEqual(providers, []);
  assert.match(skipped[0] ?? "", /Z\.ai OAuth/);
});

test("derives the account scope with the desktop app's formula", () => {
  const individual = oauthAccount({ accessToken: "  oauth-token  " });
  const expectedIndividual = crypto.createHash("sha256")
    .update(JSON.stringify(["bigmodel", "individual-coding-plan", null, "oauth-token", "jwt-token"]))
    .digest("hex");
  assert.equal(oauth.accountScopeFor(individual), expectedIndividual);

  const team = oauthAccount({
    planKind: "team-coding-plan",
    organizationId: "org-1",
    projectId: "proj-1",
    productId: "product-1",
  });
  const expectedTeam = crypto.createHash("sha256")
    .update(JSON.stringify(["bigmodel", "team-coding-plan", ["org-1", "proj-1", "product-1"], "oauth-token", "jwt-token"]))
    .digest("hex");
  assert.equal(oauth.accountScopeFor(team), expectedTeam);
});

test("exchanges the OAuth token for a project token and caches it", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return success({ code: 0, data: { accessToken: "pat-1", expiresIn: 3600, expiresAt: 2_000_000_000 } });
  };
  const now = () => 1_800_000_000_000;
  const account = oauthAccount();

  const first = await oauth.resolveAccountRequestAuth(account, {}, { fetchImpl, now, clientVersion: "3.17.2" });
  assert.equal(first.headersApplied, true);
  assert.equal(first.requestAuth?.apiKey, "pat-1");
  assert.equal(first.requestAuth?.apiKeyId, "key-1");
  assert.equal(first.requestAuth?.accountScope, oauth.accountScopeFor(account));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api_keys\/key-1\/access_tokens$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(JSON.parse(calls[0].init.body).clientType, "zcode");
  assert.equal(JSON.parse(calls[0].init.body).clientVersion, "3.17.2");

  const second = await oauth.resolveAccountRequestAuth(account, {}, { fetchImpl, now, clientVersion: "3.17.2" });
  assert.equal(second.requestAuth?.apiKey, "pat-1");
  assert.equal(calls.length, 1, "the project token is cached");
});

test("refreshes the project token when the CLI rejects its fingerprint", async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return success({ code: 0, data: { accessToken: `pat-${count}`, expiresIn: 3600 } });
  };
  const now = () => 1_800_000_000_000;
  const account = oauthAccount();
  const rejected = crypto.createHash("sha256").update("pat-1").digest("hex");

  const first = await oauth.resolveAccountRequestAuth(account, {}, { fetchImpl, now });
  assert.equal(first.requestAuth?.apiKey, "pat-1");

  const second = await oauth.resolveAccountRequestAuth(
    account,
    { rejectedProjectTokenFingerprint: rejected },
    { fetchImpl, now },
  );
  assert.equal(second.requestAuth?.apiKey, "pat-2");
  assert.equal(count, 2);
});

test("rejects a request whose expected account scope is stale", async () => {
  let calls = 0;
  const result = await oauth.resolveAccountRequestAuth(
    oauthAccount(),
    { expectedAccountScope: "0".repeat(64) },
    { fetchImpl: async () => { calls += 1; return success({ code: 0, data: { accessToken: "pat" } }); } },
  );
  assert.equal(result.headersApplied, false);
  assert.match(result.errorMessage ?? "", /账号凭据/);
  assert.equal(calls, 0);
});

test("reports a disabled project token instead of handing out a blank key", async () => {
  const result = await oauth.resolveAccountRequestAuth(oauthAccount(), {}, {
    fetchImpl: async () => success({ code: 0, data: { enable: false } }),
  });
  assert.equal(result.headersApplied, false);
  assert.match(result.errorMessage ?? "", /project_token_disabled/);
});

test("discovers a personal project and its zcode-api-key on first use", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
      return success({
        code: 0,
        data: {
          organizations: [{
            organizationId: "org-1",
            organizationName: "默认机构",
            projects: [{ projectId: "proj-1", projectName: "默认项目", projectType: 1 }],
          }],
        },
      });
    }
    if (url.endsWith("/api_keys")) {
      return success({ code: 0, data: [{ name: "zcode-api-key", apiKey: "discovered-key", keyType: 1 }] });
    }
    return success({ code: 0, data: { accessToken: "discovered-pat", expiresIn: 3600 } });
  };

  const result = await oauth.resolveAccountRequestAuth(
    oauthAccount({ location: undefined }),
    {},
    { fetchImpl, now: () => 1_800_000_000_000 },
  );
  assert.equal(result.headersApplied, true);
  assert.equal(result.requestAuth?.apiKey, "discovered-pat");
  assert.equal(result.requestAuth?.apiKeyId, "discovered-key");
  assert.equal(calls.length, 3);
  assert.match(calls[0], /\/api\/biz\/customer\/getCustomerInfo$/);
  assert.match(calls[1], /\/organizations?\/org-1\/projects\/proj-1\/api_keys$/);
  assert.match(calls[2], /\/api_keys\/discovered-key\/access_tokens$/);
});

test("returns the shared JWT token for Start Plan requests", async () => {
  const result = await oauth.resolveAccountRequestAuth({
    family: "bigmodel",
    planKind: "start-plan",
    accessToken: "oauth-token",
    zcodeJwtToken: "jwt-token",
    accountIdentity: "user-1",
  });
  assert.deepEqual(result, { headersApplied: true, requestAuth: { apiKey: "jwt-token" } });
});

test("registration keeps the account access shape accepted by the CLI", async () => {
  const calls = [];
  await accounts.registerAccountProviders(
    async (method, params) => {
      calls.push({ method, params });
      return {};
    },
    [{
      providerId: PROVIDER,
      family: "bigmodel",
      planKind: "individual-coding-plan",
      models: ["GLM-5.3"],
      oauth: oauthAccount(),
    }],
    "zcode-builtin:test",
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "provider/updateAccountConfig");
  assert.deepEqual(calls[0].params.providers[PROVIDER], {
    builtinModelIds: ["GLM-5.3"],
    access: { type: "zhipu-account", entitled: true },
  });
});
