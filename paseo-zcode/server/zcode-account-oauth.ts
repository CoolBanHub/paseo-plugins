import { createHash } from "node:crypto";

/**
 * OAuth coding-plan accounts are different from the manual API-key providers:
 * ZCode stores an OAuth access token plus a small "project key location"
 * (organization / project / API key id). Model requests need a short-lived
 * project access token exchanged from those credentials, together with the
 * account scope hash the CLI validates on retries.
 *
 * This module mirrors the desktop app's AccountProviderRequestAuthService and
 * ProjectAccessTokenClient closely enough to resolve the same material for a
 * headless app-server session.
 */

export type AccountFamily = "bigmodel" | "zai";
export type PlanKind = "individual-coding-plan" | "team-coding-plan" | "start-plan";

export interface ProjectLocation {
  origin?: string;
  organizationId: string;
  projectId: string;
  apiKeyId: string;
}

export interface OAuthAccount {
  family: AccountFamily;
  planKind: PlanKind;
  accessToken: string;
  zcodeJwtToken?: string;
  accountIdentity: string;
  location?: ProjectLocation;
  organizationId?: string;
  projectId?: string;
  productId?: string;
}

export interface RequestAuth {
  apiKey?: string;
  apiKeyId?: string;
  accountScope?: string;
  headers?: Record<string, string>;
}

export interface AccountRequestAuthResult {
  headersApplied: boolean;
  requestAuth?: RequestAuth;
  errorMessage?: string;
}

export interface ProjectTokenMaterial {
  token: string;
  apiKeyId: string;
  expiresAt: number;
  fingerprint: string;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ResolveOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  clientVersion?: string;
}

export interface ProjectTokenOptions extends ResolveOptions {
  rejectedProjectTokenFingerprint?: string;
}

const DEFAULT_ORIGINS: Record<AccountFamily, string> = {
  bigmodel: "https://bigmodel.cn",
  zai: "https://api.z.ai",
};

const CACHE_MARGIN_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;

const tokenCache = new Map<string, ProjectTokenMaterial>();
const pendingTokens = new Map<string, Promise<ProjectTokenMaterial>>();
const discoveredLocations = new Map<string, ProjectLocation>();

export class ProjectTokenError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProjectTokenError";
    this.status = status;
  }
}

/** Clears in-memory project tokens. Exposed for tests and account switches. */
export function clearProjectTokenCache(): void {
  tokenCache.clear();
  pendingTokens.clear();
  discoveredLocations.clear();
}

/**
 * The CLI validates this digest on retries. It must match the desktop app's
 * formula exactly: family, plan kind, team tuple (or null), OAuth access token
 * and the shared zcode JWT token.
 */
export function accountScopeFor(oauth: OAuthAccount): string {
  const team = oauth.planKind === "team-coding-plan"
    ? [oauth.organizationId ?? "", oauth.projectId ?? "", oauth.productId ?? ""]
    : null;
  return createHash("sha256").update(JSON.stringify([
    oauth.family,
    oauth.planKind,
    team,
    oauth.accessToken.trim(),
    oauth.zcodeJwtToken?.trim() ?? null,
  ])).digest("hex");
}

/** Resolves the requestAuth payload for one runtime-headers request. */
export async function resolveAccountRequestAuth(
  oauth: OAuthAccount,
  params: Record<string, unknown> = {},
  options: ResolveOptions = {},
): Promise<AccountRequestAuthResult> {
  if (oauth.planKind === "start-plan") {
    const token = oauth.zcodeJwtToken?.trim();
    if (!token) return failure("缺少 ZCode 登录 JWT，请在 ZCode 客户端重新登录");
    return { headersApplied: true, requestAuth: { apiKey: token } };
  }

  const expectedScope = stringValue(params.expectedAccountScope);
  const scope = accountScopeFor(oauth);
  if (expectedScope && expectedScope !== scope) return failure("账号凭据已更新，请重试");

  try {
    const material = await resolveProjectToken(oauth, {
      ...options,
      rejectedProjectTokenFingerprint: stringValue(params.rejectedProjectTokenFingerprint),
    });
    return {
      headersApplied: true,
      requestAuth: {
        apiKey: material.token,
        apiKeyId: material.apiKeyId,
        accountScope: scope,
      },
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Returns a cached project token or exchanges the OAuth token for a new one. */
export async function resolveProjectToken(
  oauth: OAuthAccount,
  options: ProjectTokenOptions = {},
): Promise<ProjectTokenMaterial> {
  const now = options.now ?? Date.now;
  const location = oauth.location ?? await discoverProjectLocation(oauth, options);
  const key = tokenCacheKey(oauth, location);
  const rejected = options.rejectedProjectTokenFingerprint?.trim();
  const cached = tokenCache.get(key);

  if (cached && (!rejected || cached.fingerprint !== rejected) && cached.expiresAt - now() > CACHE_MARGIN_MS) {
    return cached;
  }
  if (cached) tokenCache.delete(key);

  const pending = pendingTokens.get(key);
  if (pending) {
    const material = await pending;
    if (!rejected || material.fingerprint !== rejected) return material;
  }

  const promise = exchangeProjectToken(oauth, location, options).then((material) => {
    tokenCache.set(key, material);
    return material;
  }).finally(() => {
    if (pendingTokens.get(key) === promise) pendingTokens.delete(key);
  });
  pendingTokens.set(key, promise);
  return promise;
}

async function exchangeProjectToken(
  oauth: OAuthAccount,
  location: ProjectLocation,
  options: ProjectTokenOptions,
): Promise<ProjectTokenMaterial> {
  const origin = (location.origin?.trim() || DEFAULT_ORIGINS[oauth.family]).replace(/\/+$/u, "");
  const accessToken = oauth.accessToken.trim();
  if (!accessToken) throw new ProjectTokenError("OAuth 登录凭据为空，请在 ZCode 客户端重新登录");

  const url = `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}`
    + `/projects/${encodeURIComponent(location.projectId)}`
    + `/api_keys/${encodeURIComponent(location.apiKeyId)}/access_tokens`;
  const response = await requestJson(options.fetchImpl ?? defaultFetch, url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      clientType: "zcode",
      clientVersion: options.clientVersion?.trim() || "unknown",
    }),
  });
  const data = readEnvelope(response.body);
  const record = asRecord(data);
  if (!record) throw new ProjectTokenError("项目 Token 响应格式无效");
  if (record.enable === false) throw new ProjectTokenError("账号套餐未开通项目 Token（project_token_disabled）");

  const token = stringValue(record.accessToken);
  if (!token) throw new ProjectTokenError("项目 Token 响应缺少 accessToken");
  const now = (options.now ?? Date.now)();
  return {
    token,
    apiKeyId: location.apiKeyId,
    expiresAt: normalizeExpiry(record, now),
    fingerprint: sha256(token),
  };
}

/** Discovers the default personal project and its `zcode-api-key` on first use. */
async function discoverProjectLocation(
  oauth: OAuthAccount,
  options: ResolveOptions,
): Promise<ProjectLocation> {
  if (oauth.planKind === "team-coding-plan") {
    throw new ProjectTokenError("团队套餐 OAuth 暂不支持，请在 ZCode 里改用 API Key 模式");
  }

  const origin = (oauth.location?.origin?.trim() || DEFAULT_ORIGINS[oauth.family]).replace(/\/+$/u, "");
  const cacheKey = `${oauth.family}\0${oauth.accountIdentity}\0${origin}`;
  const cached = discoveredLocations.get(cacheKey);
  if (cached) return cached;

  const accessToken = oauth.accessToken.trim();
  if (!accessToken) throw new ProjectTokenError("OAuth 登录凭据为空，请在 ZCode 客户端重新登录");
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const authorization = oauth.family === "zai" ? `Bearer ${accessToken}` : accessToken;
  const headers = { Authorization: authorization, "Content-Type": "application/json" };

  const customer = await requestJson(fetchImpl, `${origin}/api/biz/customer/getCustomerInfo`, {
    method: "GET",
    headers,
  });
  const customerData = asRecord(readEnvelope(customer.body));
  const organizations = Array.isArray(customerData?.organizations) ? customerData.organizations : [];
  const project = choosePersonalProject(organizations);

  const keysUrl = `${origin}/api/biz/v1/organization/${encodeURIComponent(project.organizationId)}`
    + `/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  const keysResponse = await requestJson(fetchImpl, keysUrl, { method: "GET", headers });
  const keysData = readEnvelope(keysResponse.body);
  const keys = Array.isArray(keysData) ? keysData.map(asRecord).filter(Boolean) : [];
  let key = keys.find((item) => item?.name === "zcode-api-key" && stringValue(item.apiKey));

  if (!key) {
    const created = await requestJson(fetchImpl, keysUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "zcode-api-key", usageScene: 1 }),
    });
    key = asRecord(readEnvelope(created.body)) ?? undefined;
  }

  const apiKey = stringValue(key?.apiKey);
  if (!apiKey) throw new ProjectTokenError("找不到可用的项目 API Key");
  const location: ProjectLocation = {
    origin,
    organizationId: project.organizationId,
    projectId: project.projectId,
    apiKeyId: apiKey,
  };
  discoveredLocations.set(cacheKey, location);
  return location;
}

function choosePersonalProject(organizations: unknown[]): { organizationId: string; projectId: string } {
  const parsed = organizations.map(asRecord).filter(Boolean).map((organization) => {
    const projects = Array.isArray(organization?.projects)
      ? organization.projects.map(asRecord).filter(Boolean).map((project) => ({
        projectId: stringValue(project?.projectId) ?? "",
        projectName: stringValue(project?.projectName) ?? "",
        projectType: String(project?.projectType ?? "").trim(),
      })).filter((project) => project.projectId)
      : [];
    return {
      organizationId: stringValue(organization?.organizationId) ?? "",
      organizationName: stringValue(organization?.organizationName) ?? "",
      projects,
    };
  }).filter((organization) => organization.organizationId && organization.projects.length);

  const personal = parsed.map((organization) => ({
    ...organization,
    projects: organization.projects.filter((project) => project.projectType !== "2"),
  })).filter((organization) => organization.projects.length);
  const pool = personal.length > 0 ? personal : parsed;
  const organization = pool.find((item) => item.organizationName.includes("默认机构")) ?? pool[0];
  const project = organization?.projects.find((item) => item.projectName.includes("默认项目")) ?? organization?.projects[0];
  if (!organization || !project) throw new ProjectTokenError("找不到可用的 BigModel 项目");
  return { organizationId: organization.organizationId, projectId: project.projectId };
}

function tokenCacheKey(oauth: OAuthAccount, location: ProjectLocation): string {
  return [
    oauth.family,
    oauth.accountIdentity,
    oauth.accessToken.trim(),
    location.origin ?? "",
    location.organizationId,
    location.projectId,
    location.apiKeyId,
  ].join("\0");
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, { ...init, signal: requestSignal(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new ProjectTokenError(error instanceof Error ? error.message : "项目 Token 网络请求失败");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const code = readCode(body);
    throw new ProjectTokenError(
      `项目 Token 请求失败（HTTP ${response.status}${code !== undefined ? ` / ${String(code)}` : ""}）`,
      response.status,
    );
  }
  return { status: response.status, body };
}

function readEnvelope(body: unknown): unknown {
  const record = asRecord(body);
  if (!record) throw new ProjectTokenError("项目 Token 响应格式无效");
  const code = readCode(record);
  if (code !== undefined && !isSuccessCode(code)) {
    throw new ProjectTokenError(`项目 Token 请求失败（${String(code)}）`, typeof code === "number" ? code : undefined);
  }
  if (!("data" in record)) throw new ProjectTokenError("项目 Token 响应缺少 data");
  return record.data;
}

function readCode(body: unknown): number | string | undefined {
  const record = asRecord(body);
  const code = record?.code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function isSuccessCode(code: number | string): boolean {
  return code === 0 || code === 200 || code === "0" || code === "200";
}

function normalizeExpiry(data: Record<string, unknown>, now: number): number {
  const expiresAt = Number(data.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  const expiresIn = Number(data.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return now + expiresIn * 1000;
  return now + 55 * 60 * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

function failure(message: string): AccountRequestAuthResult {
  return { headersApplied: false, errorMessage: message };
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);
