import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AccountFamily,
  OAuthAccount,
  PlanKind,
  ProjectLocation,
} from "./zcode-account-oauth";

/**
 * Account providers (BigModel / Z.ai coding plans) are declared in ZCode's
 * built-in provider config but fail closed there (`entitled: false`): the
 * desktop app marks the connected ones entitled at runtime via
 * provider/updateAccountConfig and supplies their credentials through
 * interaction/requestProviderRuntimeHeaders. This module replicates that for
 * headless use.
 *
 * Two credential shapes are supported:
 * - manual API key: `account-provider:coding-plan:<provider>:account:<id>:api-key`
 * - OAuth account: `oauth:<family>:access_token` plus a `project-key-location`
 *   entry, exchanged for a project token by zcode-account-oauth.ts.
 *
 * An account's models are not listed here. The CLI resolves membership, order
 * and enablement from its built-in config plus the user's own provider rules,
 * which is what keeps a remotely released model selectable.
 */
export interface AccountProvider {
  providerId: string;
  family: AccountFamily;
  planKind?: PlanKind;
  apiKey?: string;
  oauth?: OAuthAccount;
}

export interface ReadAccountProvidersOptions {
  v2Dir?: string;
  onSkip?: (providerId: string, reason: string) => void;
  /** Injectable keyring reader for tests; defaults to the OS keychain. */
  keyStore?: CredentialKeyStore;
}

export interface OAuthTokenSet {
  family: AccountFamily;
  accessToken: string;
  zcodeJwtToken?: string;
  accountIdentity: string;
}

interface ProviderConfigFile {
  config?: {
    providerConfigRules?: { providerRules?: Array<Record<string, unknown>> };
  };
}

interface FamilySelection {
  kind?: string;
  organizationId?: string;
  projectId?: string;
  productId?: string;
}

interface SettingsFile {
  providerFamilyConnectionSelections?: Record<string, FamilySelection>;
}

interface StoredProjectLocation extends ProjectLocation {
  family: AccountFamily;
  accountId: string;
  team: unknown;
  usageScene?: number;
  selection?: string;
}

const ENC_PREFIX = "enc:v1:";
const ENC_V2_PREFIX = "enc:v2:";
const KEYCHAIN_SERVICE = "ZCode Credential Encryption";
const KEYCHAIN_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{24}$/;

/** Resolves the default credentials.json path used by the desktop app. */
export function defaultCredentialPath(): string {
  return resolve(join(homedir(), ".zcode", "v2", "credentials.json"));
}

/**
 * Reads the base64url keyring password the desktop app stores for one
 * credentials file. Injectable so tests can decrypt without a keychain.
 */
export interface CredentialKeyStore {
  readKey(credentialPath: string): string | undefined;
}

// Successful keychain reads are cached per credentials path; misses re-read so a
// login that creates the entry is picked up without a plugin reload.
const osKeyringCache = new Map<string, string>();

function readOsKeyringKey(credentialPath: string): string | undefined {
  const resolvedPath = resolve(credentialPath);
  const cached = osKeyringCache.get(resolvedPath);
  if (cached) return cached;
  // The desktop app indexes the entry by sha256 of the resolved file path.
  const account = createHash("sha256").update(resolvedPath).digest("hex");
  try {
    const current = platform();
    const output = current === "darwin"
      ? execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
      )
      : current === "linux"
        ? execFileSync(
          "secret-tool",
          ["lookup", "service", KEYCHAIN_SERVICE, "username", account],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
        )
        : undefined;
    const key = output?.trim();
    if (key && KEYCHAIN_KEY_PATTERN.test(key)) {
      osKeyringCache.set(resolvedPath, key);
      return key;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * `enc:v2:env:` keys wrap a managed secret: the ZCODE_CREDENTIAL_SECRET env
 * var, or a 32..4096-byte owner-only file next to the credentials (mirrors the
 * desktop app's resolveManagedSecret, including its both-sources refusal).
 */
function readManagedSecret(credentialPath: string): string | undefined {
  const envSecret = process.env.ZCODE_CREDENTIAL_SECRET;
  const envSecretFile = process.env.ZCODE_CREDENTIAL_SECRET_FILE;
  if (envSecret && envSecretFile) return undefined;
  if (envSecret) return envSecret;
  let file: string | undefined = envSecretFile;
  if (!file) {
    file = join(dirname(resolve(credentialPath)), "credential-secret");
    try {
      const st = statSync(file);
      if (!st.isFile()) return undefined;
      // The default file must stay owner-only, like the app's own check.
      if (platform() !== "win32" && (st.mode & 0o77) !== 0) return undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const content = readFileSync(file, "utf8");
    const size = Buffer.byteLength(content, "utf8");
    return size >= 32 && size <= 4096 ? content : undefined;
  } catch {
    return undefined;
  }
}

function openSealed(sealed: string, key: Buffer): string | undefined {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return undefined;
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** `enc:v2:<source>:<keyFingerprint>:<iv>.<tag>.<ciphertext>` (desktop app >= 2026-11). */
function decryptV2Credential(
  value: string,
  credentialPath: string,
  keyStore: CredentialKeyStore,
): string | undefined {
  const parts = value.slice(ENC_V2_PREFIX.length).split(":");
  if (parts.length !== 3) return undefined;
  const [source, fingerprint, sealed] = parts;
  if (!FINGERPRINT_PATTERN.test(fingerprint)) return undefined;

  const matchesFingerprint = (key: Buffer): boolean =>
    createHash("sha256").update(key).digest("hex").slice(0, 24) === fingerprint;

  if (source === "os") {
    const resolvedPath = resolve(credentialPath);
    let raw = keyStore.readKey(resolvedPath);
    if (!raw || !KEYCHAIN_KEY_PATTERN.test(raw)) return undefined;
    let key = Buffer.from(raw, "base64url");
    if (key.length !== 32) return undefined;
    if (!matchesFingerprint(key) && osKeyringCache.get(resolvedPath) === raw) {
      // The app may have rotated the key (re-login); re-read the keychain once.
      osKeyringCache.delete(resolvedPath);
      raw = keyStore.readKey(resolvedPath);
      if (!raw || !KEYCHAIN_KEY_PATTERN.test(raw)) return undefined;
      key = Buffer.from(raw, "base64url");
      if (key.length !== 32) return undefined;
    }
    if (!matchesFingerprint(key)) return undefined;
    return openSealed(sealed, key);
  }
  if (source === "env") {
    const secret = readManagedSecret(credentialPath);
    if (!secret) return undefined;
    const key = createHash("sha256").update(secret).digest();
    if (!matchesFingerprint(key)) return undefined;
    return openSealed(sealed, key);
  }
  return undefined;
}

export interface DecryptCredentialOptions {
  /** Credentials file the value came from; selects the keychain key. */
  credentialPath?: string;
  /** Keyring reader; defaults to the OS keychain (macOS / Linux). */
  keyStore?: CredentialKeyStore;
}

export function decryptCredential(value: string, options: DecryptCredentialOptions = {}): string | undefined {
  if (value.startsWith(ENC_V2_PREFIX)) {
    const credentialPath = options.credentialPath ?? defaultCredentialPath();
    return decryptV2Credential(value, credentialPath, options.keyStore ?? { readKey: readOsKeyringKey });
  }
  if (!value.startsWith(ENC_PREFIX)) return value;
  const secret =
    process.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const parts = value.slice(ENC_PREFIX.length).split(".").map(b64url);
  if (parts.length !== 3) return undefined;
  try {
    const [iv, tag, ciphertext] = parts;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString();
  } catch {
    return undefined;
  }
}

export function readAccountProviders(options: ReadAccountProvidersOptions = {}): AccountProvider[] {
  const v2Dir = options.v2Dir ?? defaultV2Dir();
  // v2 keyring keys are indexed by the resolved credentials.json path.
  const credentialPath = resolve(join(v2Dir, "credentials.json"));
  const keyStore = options.keyStore;
  try {
    const creds = readJsonFile<Record<string, unknown>>(join(v2Dir, "credentials.json"));
    const cfg = readJsonFile<ProviderConfigFile>(join(v2Dir, "provider_config.json"));
    if (!creds || !cfg) return [];
    const settings = readJsonFile<SettingsFile>(join(v2Dir, "setting.json"));

    const oauthSets = new Map<AccountFamily, OAuthTokenSet>();
    for (const family of ["bigmodel", "zai"] as const) {
      const set = readOAuthTokenSetFromCreds(creds, family, credentialPath, keyStore);
      if (set) oauthSets.set(family, set);
    }
    const locations = readProjectLocations(creds, credentialPath, keyStore);

    const rules = cfg.config?.providerConfigRules?.providerRules ?? [];
    const providers: AccountProvider[] = [];

    for (const rule of rules) {
      const providerId = String(rule?.providerId ?? "");
      if (!providerId.startsWith("account:")) continue;
      const family: AccountFamily | undefined = providerId.includes("bigmodel")
        ? "bigmodel"
        : providerId.includes("zai")
          ? "zai"
          : undefined;
      if (!family) continue;

      const planKind = planKindForProvider(providerId);
      const manualApiKey = readManualApiKey(creds, providerId, credentialPath, keyStore);
      const authSource = readAuthSource(creds, providerId, credentialPath, keyStore);
      const oauthSet = oauthSets.get(family);
      const selection = settings?.providerFamilyConnectionSelections?.[family];

      let oauth: OAuthAccount | undefined;
      if (oauthSet && planKind) {
        oauth = buildOAuthAccount(oauthSet, planKind, selection, locations);
      }

      let auth: Pick<AccountProvider, "apiKey" | "oauth"> | undefined;
      if (authSource === "manual") {
        if (manualApiKey) auth = { apiKey: manualApiKey };
        else options.onSkip?.(providerId, "缺少手动 API Key");
      } else if (authSource === "oauth") {
        if (oauth) auth = { oauth };
        else options.onSkip?.(providerId, oauthSkipReason(planKind, oauthSet));
      } else if (manualApiKey) {
        auth = { apiKey: manualApiKey };
      } else if (oauth) {
        auth = { oauth };
      } else {
        options.onSkip?.(providerId, oauthSet ? oauthSkipReason(planKind, oauthSet) : "未找到可用的账号凭据（OAuth 或 API Key 均不可用）");
      }

      if (!auth) continue;

      // The rule's modelOrder is only the user's ordering of models the CLI
      // already knows; an empty or stale one must not hide the account.
      providers.push({
        providerId,
        family,
        ...(planKind ? { planKind } : {}),
        ...auth,
      });
    }
    return providers;
  } catch {
    return [];
  }
}

/** Re-reads the OAuth token set so a desktop refresh is picked up between turns. */
export function readOAuthTokenSet(
  family: AccountFamily,
  v2Dir = defaultV2Dir(),
  keyStore?: CredentialKeyStore,
): OAuthTokenSet | undefined {
  try {
    const creds = readJsonFile<Record<string, unknown>>(join(v2Dir, "credentials.json"));
    const credentialPath = resolve(join(v2Dir, "credentials.json"));
    return creds ? readOAuthTokenSetFromCreds(creds, family, credentialPath, keyStore) : undefined;
  } catch {
    return undefined;
  }
}

function readOAuthTokenSetFromCreds(
  creds: Record<string, unknown>,
  family: AccountFamily,
  credentialPath: string,
  keyStore?: CredentialKeyStore,
): OAuthTokenSet | undefined {
  const accessToken = readEncryptedString(creds[`oauth:${family}:access_token`], credentialPath, keyStore);
  if (!accessToken) return undefined;
  const zcodeJwtToken = readEncryptedString(creds.zcodejwttoken, credentialPath, keyStore);
  const accountIdentity = readAccountIdentity(
    readEncryptedString(creds[`oauth:${family}:user_info`], credentialPath, keyStore),
  );
  if (!accountIdentity) return undefined;
  return {
    family,
    accessToken,
    ...(zcodeJwtToken ? { zcodeJwtToken } : {}),
    accountIdentity,
  };
}

function buildOAuthAccount(
  set: OAuthTokenSet,
  planKind: PlanKind,
  selection: FamilySelection | undefined,
  locations: StoredProjectLocation[],
): OAuthAccount | undefined {
  if (set.family === "zai") {
    // Z.ai needs an extra business-token exchange before the project-token
    // call; keep it on the manual API-key path for now.
    return undefined;
  }

  if (planKind === "start-plan") {
    if (selection?.kind && selection.kind !== "start-plan") return undefined;
    if (!set.zcodeJwtToken) return undefined;
    return {
      family: set.family,
      planKind,
      accessToken: set.accessToken,
      zcodeJwtToken: set.zcodeJwtToken,
      accountIdentity: set.accountIdentity,
    };
  }

  if (planKind === "team-coding-plan") {
    // Team plans need organization / project / product identity from settings
    // and a separate team key flow; keep them on the manual API-key path.
    return undefined;
  }

  if (selection?.kind && selection.kind !== "individual-coding-plan") return undefined;
  const location = findProjectLocation(locations, set.family, set.accountIdentity, planKind);
  return {
    family: set.family,
    planKind,
    accessToken: set.accessToken,
    ...(set.zcodeJwtToken ? { zcodeJwtToken: set.zcodeJwtToken } : {}),
    accountIdentity: set.accountIdentity,
    ...(location ? { location } : {}),
  };
}

function oauthSkipReason(planKind: PlanKind | undefined, set: OAuthTokenSet | undefined): string {
  if (!set) return "缺少 OAuth 账号凭据";
  if (set.family === "zai") return "Z.ai OAuth 暂不支持，请改用 API Key 模式";
  if (planKind === "team-coding-plan") return "团队套餐 OAuth 暂不支持，请改用 API Key 模式";
  if (planKind === "start-plan") return "缺少 Start Plan JWT 或当前连接不是 Start Plan";
  if (planKind === "individual-coding-plan") return "当前连接不是个人 Coding Plan";
  return "该账号类型暂不支持 OAuth";
}

function findProjectLocation(
  locations: StoredProjectLocation[],
  family: AccountFamily,
  accountIdentity: string,
  planKind: PlanKind,
): ProjectLocation | undefined {
  const wantsTeam = planKind === "team-coding-plan";
  const candidates = locations.filter(
    (location) =>
      location.family === family &&
      location.accountId === accountIdentity &&
      (wantsTeam ? location.team !== null && location.team !== undefined : location.team === null),
  );
  const preferred = candidates
    .slice()
    .sort((left, right) => locationScore(right) - locationScore(left))[0];
  if (!preferred) return undefined;
  return {
    ...(preferred.origin ? { origin: preferred.origin } : {}),
    organizationId: preferred.organizationId,
    projectId: preferred.projectId,
    apiKeyId: preferred.apiKeyId,
  };
}

function locationScore(location: StoredProjectLocation): number {
  let score = 0;
  if (location.usageScene === 1) score += 4;
  if (location.selection === "default") score += 2;
  else if (location.selection === "non-team") score += 1;
  return score;
}

function readProjectLocations(
  creds: Record<string, unknown>,
  credentialPath: string,
  keyStore?: CredentialKeyStore,
): StoredProjectLocation[] {
  const locations: StoredProjectLocation[] = [];
  for (const key of Object.keys(creds)) {
    if (!key.startsWith("project-key-location:v1:")) continue;
    try {
      const descriptor = JSON.parse(decodeURIComponent(key.slice("project-key-location:v1:".length))) as unknown;
      if (!Array.isArray(descriptor) || descriptor.length < 2) continue;
      const [origin, family, accountId, team, usageScene, selection] = descriptor;
      if (typeof origin !== "string" || (family !== "bigmodel" && family !== "zai")) continue;
      const value = readEncryptedString(creds[key], credentialPath, keyStore);
      if (!value) continue;
      const location = JSON.parse(value) as Record<string, unknown>;
      const organizationId = stringValue(location.organizationId);
      const projectId = stringValue(location.projectId);
      const apiKeyId = stringValue(location.apiKeyId);
      if (!organizationId || !projectId || !apiKeyId) continue;
      locations.push({
        origin: origin.replace(/\/+$/u, ""),
        family,
        accountId: typeof accountId === "string" ? accountId : String(accountId ?? ""),
        team,
        ...(typeof usageScene === "number" ? { usageScene } : {}),
        ...(typeof selection === "string" ? { selection } : {}),
        organizationId,
        projectId,
        apiKeyId,
      });
    } catch {
      continue;
    }
  }
  return locations;
}

function readManualApiKey(
  creds: Record<string, unknown>,
  providerId: string,
  credentialPath: string,
  keyStore?: CredentialKeyStore,
): string | undefined {
  const prefix = `account-provider:coding-plan:${providerId}:account:`;
  const apiKeyEntry = Object.keys(creds).find(
    (key) => key.startsWith(prefix) && key.endsWith(":api-key") && key.length > prefix.length + ":api-key".length,
  );
  return apiKeyEntry ? readEncryptedString(creds[apiKeyEntry], credentialPath, keyStore) : undefined;
}

function readAuthSource(
  creds: Record<string, unknown>,
  providerId: string,
  credentialPath: string,
  keyStore?: CredentialKeyStore,
): string | undefined {
  return readEncryptedString(creds[`account-provider:${providerId}:auth-source`], credentialPath, keyStore)
    ?.trim()
    .toLowerCase();
}

function readAccountIdentity(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = stringValue(parsed.id);
    if (id) return id;
    const profile = parsed.rawProfile;
    return profile && typeof profile === "object" && !Array.isArray(profile)
      ? stringValue((profile as Record<string, unknown>).user_id)
      : undefined;
  } catch {
    return undefined;
  }
}

function readEncryptedString(value: unknown, credentialPath: string, keyStore?: CredentialKeyStore): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return decryptCredential(value, { credentialPath, ...(keyStore ? { keyStore } : {}) })?.trim() || undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function defaultV2Dir(): string {
  return join(homedir(), ".zcode", "v2");
}

function planKindForProvider(providerId: string): PlanKind | undefined {
  if (providerId.endsWith("-individual-coding-plan")) return "individual-coding-plan";
  if (providerId.endsWith("-team-coding-plan")) return "team-coding-plan";
  if (providerId.endsWith("-start-plan")) return "start-plan";
  return undefined;
}

/** Reads the installed ZCode app version used in project-token requests. */
export function resolveZcodeAppVersion(cliPath?: string): string {
  const configured = process.env.ZCODE_APP_VERSION?.trim();
  if (configured) return configured;
  if (cliPath) {
    try {
      const info = readFileSync(join(dirname(cliPath), "..", "..", "Info.plist"), "utf8");
      const match = info.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u);
      if (match?.[1]?.trim()) return match[1].trim();
    } catch {
      // Fall through to the generic value.
    }
  }
  return "unknown";
}

/**
 * The builtin revision is a digest the CLI computes over the builtin provider
 * config; updateAccountConfig rejects mismatched values. The CLI logs the
 * exact value (configRevision[0], JSON-encoded) in provider_registry.ready
 * lines right after startup, so find the newest line written after the child
 * process spawned.
 */
export function readBuiltinRevision(spawnedAtMs: number): string | undefined {
  try {
    const dir = join(homedir(), ".zcode", "cli", "log");
    const today = new Date().toISOString().slice(0, 10);
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    const ordered = [
      ...files.filter((f) => f === `zcode-${today}.jsonl`),
      ...files.filter((f) => f !== `zcode-${today}.jsonl`),
    ];
    for (const file of ordered.slice(0, 2)) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.includes("provider_registry.ready")) continue;
        try {
          const entry = JSON.parse(line);
          const at = Date.parse(entry.timestamp ?? "");
          if (!Number.isFinite(at) || at < spawnedAtMs) continue;
          const raw = entry?.context?.configRevision;
          const revisionArray = typeof raw === "string" ? JSON.parse(raw) : raw;
          const rev = Array.isArray(revisionArray) ? revisionArray[0] : undefined;
          if (typeof rev === "string" && rev.startsWith("zcode-builtin:")) return rev;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The revision the CLI derives from a built-in provider config file:
 * `zcode-builtin:<file revision>:<sha256 of the resolved path>`. Unlike
 * readBuiltinRevision (a startup log line) this reflects the file as it is
 * now, so a remote release written by the desktop app is visible while the
 * app-server keeps running.
 */
export function builtinRevisionFor(builtinConfigPath: string | undefined): string | undefined {
  if (!builtinConfigPath) return undefined;
  try {
    const { revision } = JSON.parse(readFileSync(builtinConfigPath, "utf8")) as { revision?: unknown };
    if ((typeof revision !== "number" && typeof revision !== "string") || String(revision) === "") return undefined;
    return `zcode-builtin:${revision}:${createHash("sha256").update(resolve(builtinConfigPath)).digest("hex")}`;
  } catch {
    return undefined;
  }
}

/** Reads the newest turn.failed log entry for a session and returns the deepest error message. */
export function readLastTurnFailure(sessionId: string): string | undefined {
  try {
    const dir = join(homedir(), ".zcode", "cli", "log");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, 2);
    for (const file of files) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.includes('"turn.failed"')) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId !== sessionId) continue;
          let deepest: string | undefined;
          let node: unknown = entry.error;
          for (let depth = 0; depth < 6 && node && typeof node === "object"; depth++) {
            const current = node as Record<string, unknown>;
            if (typeof current.message === "string" && current.message.trim()) deepest = current.message.trim();
            node = current.cause;
          }
          if (deepest) return deepest;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Distinguishes registrations made in the same millisecond: the CLI keeps a snapshot whose revision it already holds. */
let registrationSequence = 0;

/** Registers account providers into the CLI's runtime provider registry. */
export async function registerAccountProviders(
  request: (method: string, params: Record<string, unknown>) => Promise<{ error?: unknown }>,
  providers: AccountProvider[],
  builtinRevision: string,
): Promise<void> {
  if (!providers.length) return;
  const providerMap: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const p of providers) {
    // Only the entitlement is set. A `builtinModelIds` value here would
    // replace the account's built-in model list instead of ordering it, which
    // is how newly released models used to go missing.
    providerMap[p.providerId] = {
      access: {
        type: "zhipu-account",
        entitled: true,
      },
    };
    states[p.providerId] = { availability: "available", entitled: true, current: true };
  }
  const response = await request("provider/updateAccountConfig", {
    revision: `paseo-zcode-${Date.now()}-${++registrationSequence}`,
    basedOnZCodeBuiltinRevision: builtinRevision,
    providers: providerMap,
    states,
  });
  if (response.error) {
    throw new Error(`updateAccountConfig failed: ${JSON.stringify(response.error).slice(0, 200)}`);
  }
}
