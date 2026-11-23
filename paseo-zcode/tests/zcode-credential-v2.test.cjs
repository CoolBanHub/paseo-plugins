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

const PROVIDER = "account:bigmodel-individual-coding-plan";

function makeKey() {
  return crypto.randomBytes(32);
}

function fingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function seal(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function osValue(plaintext, key) {
  return `enc:v2:os:${fingerprint(key)}:${seal(plaintext, key)}`;
}

function envValue(plaintext, secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  return `enc:v2:env:${fingerprint(key)}:${seal(plaintext, key)}`;
}

function keyStoreReturning(raw) {
  return { readKey: () => raw };
}

function projectKey(origin, family, accountId, team, selection = "non-team", usageScene = 1) {
  const descriptor = [origin, family, accountId, team, usageScene, selection];
  return `project-key-location:v1:${encodeURIComponent(JSON.stringify(descriptor))}`;
}

function makeV2Dir(t, credentials, rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-credv2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credentials));
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({
    config: {
      providerConfigRules: { providerRules: rules ?? [{ providerId: PROVIDER, config: { modelOrder: ["GLM-5.3"] } }] },
    },
  }));
  return dir;
}

const savedSecret = process.env.ZCODE_CREDENTIAL_SECRET;
const savedSecretFile = process.env.ZCODE_CREDENTIAL_SECRET_FILE;
test.beforeEach(() => {
  delete process.env.ZCODE_CREDENTIAL_SECRET;
  delete process.env.ZCODE_CREDENTIAL_SECRET_FILE;
});
test.after(() => {
  if (savedSecret === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET;
  else process.env.ZCODE_CREDENTIAL_SECRET = savedSecret;
  if (savedSecretFile === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET_FILE;
  else process.env.ZCODE_CREDENTIAL_SECRET_FILE = savedSecretFile;
});

test("decrypts enc:v2:os with the keyring key", () => {
  const key = makeKey();
  const raw = key.toString("base64url");
  const value = osValue("secret-token", key);
  const plaintext = accounts.decryptCredential(value, {
    credentialPath: "/tmp/zcode-credv2/credentials.json",
    keyStore: keyStoreReturning(raw),
  });
  assert.equal(plaintext, "secret-token");
});

test("rejects an enc:v2:os value sealed with another key", () => {
  const key = makeKey();
  const value = osValue("secret-token", key);
  const result = accounts.decryptCredential(value, {
    credentialPath: "/tmp/zcode-credv2/credentials.json",
    keyStore: keyStoreReturning(makeKey().toString("base64url")),
  });
  assert.equal(result, undefined);
});

test("rejects an enc:v2:os value when the keyring has no entry", () => {
  const key = makeKey();
  const value = osValue("secret-token", key);
  const result = accounts.decryptCredential(value, {
    credentialPath: "/tmp/zcode-credv2/credentials.json",
    keyStore: keyStoreReturning(undefined),
  });
  assert.equal(result, undefined);
});

test("rejects malformed enc:v2 values", () => {
  const key = makeKey();
  const raw = key.toString("base64url");
  const options = { credentialPath: "/tmp/zcode-credv2/credentials.json", keyStore: keyStoreReturning(raw) };
  const sealed = osValue("secret-token", key).split(":").pop();
  assert.equal(accounts.decryptCredential(`enc:v2:win:${fingerprint(key)}:${sealed}`, options), undefined);
  assert.equal(accounts.decryptCredential(`enc:v2:os:${fingerprint(key)}:${sealed}:extra`, options), undefined);
  assert.equal(accounts.decryptCredential(`enc:v2:os:NOTAHASH:${sealed}`, options), undefined);
  assert.equal(accounts.decryptCredential(`enc:v2:os:${fingerprint(key)}:${sealed}+bad`, options), undefined);
  assert.equal(accounts.decryptCredential(`enc:v2:os:${fingerprint(key)}:a.b`, options), undefined);
});

test("decrypts enc:v2:env from ZCODE_CREDENTIAL_SECRET", () => {
  const secret = "a".repeat(40);
  const value = envValue("managed-token", secret);
  process.env.ZCODE_CREDENTIAL_SECRET = secret;
  const plaintext = accounts.decryptCredential(value, { credentialPath: "/tmp/zcode-credv2/credentials.json" });
  assert.equal(plaintext, "managed-token");
});

test("decrypts enc:v2:env from the owner-only credential-secret file", (t) => {
  const dir = makeV2Dir(t, {});
  const secret = "b".repeat(48);
  fs.writeFileSync(path.join(dir, "credential-secret"), secret, { mode: 0o600 });
  const value = envValue("managed-token", secret);
  const plaintext = accounts.decryptCredential(value, {
    credentialPath: path.join(dir, "credentials.json"),
  });
  assert.equal(plaintext, "managed-token");
});

test("rejects the default credential-secret file with loose permissions or bad size", (t) => {
  const dir = makeV2Dir(t, {});
  const credentialPath = path.join(dir, "credentials.json");
  const secret = "c".repeat(48);

  const loose = envValue("managed-token", secret);
  fs.writeFileSync(path.join(dir, "credential-secret"), secret, { mode: 0o644 });
  assert.equal(accounts.decryptCredential(loose, { credentialPath }), undefined);

  fs.chmodSync(path.join(dir, "credential-secret"), 0o600);
  fs.writeFileSync(path.join(dir, "credential-secret"), "too-short", { mode: 0o600 });
  assert.equal(accounts.decryptCredential(loose, { credentialPath }), undefined);
});

test("refuses enc:v2:env when both managed secret sources are configured", (t) => {
  const dir = makeV2Dir(t, {});
  const secret = "d".repeat(48);
  process.env.ZCODE_CREDENTIAL_SECRET = secret;
  process.env.ZCODE_CREDENTIAL_SECRET_FILE = path.join(dir, "credential-secret");
  const value = envValue("managed-token", secret);
  assert.equal(accounts.decryptCredential(value, { credentialPath: path.join(dir, "credentials.json") }), undefined);
});

test("keeps enc:v1 decryption working", () => {
  const fallback = `zcode-credential-fallback:${process.platform}:${os.homedir()}:${os.userInfo().username}`;
  const key = crypto.createHash("sha256").update(fallback).digest();
  const value = `enc:v1:${seal("legacy-token", key)}`;
  assert.equal(accounts.decryptCredential(value), "legacy-token");
});

test("returns plaintext values untouched", () => {
  assert.equal(accounts.decryptCredential("plain-token"), "plain-token");
});

test("readAccountProviders discovers an OAuth plan from enc:v2:os credentials", (t) => {
  const key = makeKey();
  const raw = key.toString("base64url");
  const dir = makeV2Dir(t, {
    "oauth:bigmodel:access_token": osValue("oauth-token", key),
    "zcodejwttoken": osValue("jwt-token", key),
    "oauth:bigmodel:user_info": osValue(JSON.stringify({ id: "user-1", displayName: "tester" }), key),
    [`account-provider:${PROVIDER}:auth-source`]: osValue("oauth", key),
    [projectKey("https://bigmodel.cn", "bigmodel", "user-1", null)]: osValue(
      JSON.stringify({ organizationId: "org-1", projectId: "proj-1", apiKeyId: "key-1" }),
      key,
    ),
  });
  fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({
    providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
  }));

  const providers = accounts.readAccountProviders({ v2Dir: dir, keyStore: keyStoreReturning(raw) });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].providerId, PROVIDER);
  assert.equal(providers[0].apiKey, undefined);
  assert.equal(providers[0].oauth?.accessToken, "oauth-token");
  assert.equal(providers[0].oauth?.accountIdentity, "user-1");
  assert.ok(!("models" in providers[0]), "the plugin must not carry a model list");
});
