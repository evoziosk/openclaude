# Multi-Account for a Single Provider + Usage Stats — Full Extraction

This document describes the complete implementation of two features in Arctic (a TypeScript AI coding CLI):
1. **Multi-account support for a single provider** (concretely implemented for the "Antigravity" provider — Google's internal AI backend)
2. **Per-provider usage stats** — rate limits, quota tracking, cost, token breakdown, and TUI/CLI presentation

It is structured so that another AI can reimplement both features in a fork of opencode or openclaude.

---

## Part 1 — Multi-Account for a Single Provider

### Overview

The design allows a user to have **N OAuth accounts** for the same provider. When any account hits a 429 rate-limit, the system **automatically rotates** to the next available account. Accounts are tracked per **model family** (Claude vs Gemini) so that an account that is rate-limited for one family can still be used for the other.

### Storage file: `~/.arctic/antigravity-accounts.json`

There are 3 versions of the schema (v1 → v2 → v3, auto-migrated on load):

```typescript
// v3 — current format
interface AccountStorageV3 {
  version: 3;
  accounts: AccountMetadataV3[];
  activeIndex: number;           // legacy field — kept for back-compat
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

interface AccountMetadataV3 {
  email?: string;
  refreshToken: string;             // packed: "{refreshToken}|{projectId}|{managedProjectId}"
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;                  // ms timestamp
  lastUsed: number;                 // ms timestamp
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitStateV3;
}

interface RateLimitStateV3 {
  claude?: number;                   // ms timestamp when rate limit resets
  "gemini-antigravity"?: number;
  "gemini-cli"?: number;
}
```

**Key design detail:** The `refreshToken` field is a pipe-delimited composite string:
`{actualRefreshToken}|{projectId}|{managedProjectId}`

This is parsed/serialized by `parseRefreshParts` / `formatRefreshParts`.

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/types.ts`

```typescript
export type ModelFamily = "claude" | "gemini";
export type QuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";
export type HeaderStyle = "antigravity" | "gemini-cli";

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface RateLimitStateV3 {
  claude?: number;
  "gemini-antigravity"?: number;
  "gemini-cli"?: number;
}

export interface AccountMetadataV3 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitStateV3;
}

export interface AccountStorageV3 {
  version: 3;
  accounts: AccountMetadataV3[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

// v2 (legacy)
export interface RateLimitState {
  claude?: number;
  gemini?: number;
}
export interface AccountMetadata {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
}
export interface AccountStorage {
  version: 2;
  accounts: AccountMetadata[];
  activeIndex: number;
}

// v1 (legacy)
export interface AccountMetadataV1 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  isRateLimited?: boolean;
  rateLimitResetTime?: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}
export interface AccountStorageV1 {
  version: 1;
  accounts: AccountMetadataV1[];
  activeIndex: number;
}

export type AnyAccountStorage = AccountStorageV1 | AccountStorage | AccountStorageV3;

export interface ManagedAccount {
  index: number;
  email?: string;
  addedAt: number;
  lastUsed: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitStateV3;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}

export interface AntigravityAuthorization {
  url: string;
  verifier: string;
  projectId?: string;
}

export interface AntigravityTokenExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email?: string;
  projectId?: string;
}

export interface AntigravityTokenExchangeFailed {
  type: "failed";
  error: string;
}

export type AntigravityTokenExchangeResult =
  | AntigravityTokenExchangeSuccess
  | AntigravityTokenExchangeFailed;

export interface AntigravityOAuthState {
  verifier: string;
  projectId?: string;
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/auth-helpers.ts`

```typescript
import type { AuthDetails, OAuthAuthDetails, RefreshParts } from "./types";

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

export function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === "oauth";
}

// Format: {refreshToken}|{projectId}|{managedProjectId}
export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
  };
}

export function formatRefreshParts(parts: RefreshParts): string {
  const projectSegment = parts.projectId ?? "";
  const base = `${parts.refreshToken}|${projectSegment}`;
  return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

export function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== "number") {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/constants.ts`

```typescript
export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
export const ANTIGRAVITY_CLIENT_SECRET = "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"

export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]

export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback"

// Endpoint fallback order for API calls (daily → autopush → prod)
export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com"
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com"
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com"

export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD,
] as const

// Prod-first order for project discovery (loadCodeAssist works best on prod)
export const ANTIGRAVITY_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const

export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY

export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc"

// Header styles — each has its own quota bucket for Gemini
export const ANTIGRAVITY_HEADERS = {
  "User-Agent": "antigravity/1.20.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const

export const GEMINI_CLI_HEADERS = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
} as const

export type HeaderStyle = "antigravity" | "gemini-cli"
export const ANTIGRAVITY_PROVIDER_ID = "antigravity"
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/storage.ts`

```typescript
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AccountStorageV3, AccountStorage, AccountStorageV1,
  AccountMetadataV3, AnyAccountStorage, RateLimitStateV3, RateLimitState, ModelFamily, HeaderStyle
} from "./types";

export type { ModelFamily, HeaderStyle, AccountStorageV3, RateLimitStateV3, AccountMetadataV3 };

function getConfigDir(): string {
  return join(homedir(), ".arctic");
}

export function getStoragePath(): string {
  return join(getConfigDir(), "antigravity-accounts.json");
}

function migrateV1ToV2(v1: AccountStorageV1): AccountStorage {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitState = {};
      if (acc.isRateLimited && acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes.gemini = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v1.activeIndex,
  };
}

export function migrateV2ToV3(v2: AccountStorage): AccountStorageV3 {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitStateV3 = {};
      if (acc.rateLimitResetTimes?.claude && acc.rateLimitResetTimes.claude > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude;
      }
      if (acc.rateLimitResetTimes?.gemini && acc.rateLimitResetTimes.gemini > Date.now()) {
        rateLimitResetTimes["gemini-antigravity"] = acc.rateLimitResetTimes.gemini;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v2.activeIndex,
  };
}

export async function loadAccounts(): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath();
    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(data.accounts)) {
      console.warn("[arctic-antigravity-auth] Invalid storage format, ignoring");
      return null;
    }

    let storage: AccountStorageV3;

    if (data.version === 1) {
      const v2 = migrateV1ToV2(data);
      storage = migrateV2ToV3(v2);
      await saveAccounts(storage).catch(() => {});
    } else if (data.version === 2) {
      storage = migrateV2ToV3(data);
      await saveAccounts(storage).catch(() => {});
    } else if (data.version === 3) {
      storage = data;
    } else {
      return null;
    }

    if (typeof storage.activeIndex !== "number" || !Number.isInteger(storage.activeIndex)) {
      storage.activeIndex = 0;
    }
    if (storage.activeIndex < 0 || storage.activeIndex >= storage.accounts.length) {
      storage.activeIndex = 0;
    }

    return storage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error("[arctic-antigravity-auth] Failed to load account storage:", error);
    return null;
  }
}

export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
  const path = getStoragePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(storage, null, 2), "utf-8");
}

export async function clearAccounts(): Promise<void> {
  try {
    await fs.unlink(getStoragePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[arctic-antigravity-auth] Failed to clear account storage:", error);
    }
  }
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/accounts.ts`

This is the core `AccountManager` class — copy this entirely for any reimplementation.

```typescript
import { formatRefreshParts, parseRefreshParts } from "./auth-helpers";
import { loadAccounts, saveAccounts, type AccountStorageV3, type AccountMetadataV3 } from "./storage";
import type { OAuthAuthDetails, RefreshParts, ManagedAccount, QuotaKey, ModelFamily, HeaderStyle } from "./types";

function nowMs(): number { return Date.now(); }

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value < 0 ? 0 : Math.floor(value);
}

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle): QuotaKey {
  if (family === "claude") return "claude";
  return headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
  const resetTime = account.rateLimitResetTimes[key];
  return resetTime !== undefined && nowMs() < resetTime;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily): boolean {
  if (family === "claude") return isRateLimitedForQuotaKey(account, "claude");
  // Gemini is available if EITHER quota pool is free
  return (
    isRateLimitedForQuotaKey(account, "gemini-antigravity") &&
    isRateLimitedForQuotaKey(account, "gemini-cli")
  );
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  const keys: QuotaKey[] = ["claude", "gemini-antigravity", "gemini-cli"];
  for (const key of keys) {
    if (account.rateLimitResetTimes[key] !== undefined && now >= account.rateLimitResetTimes[key]!) {
      delete account.rateLimitResetTimes[key];
    }
  }
}

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Algorithm:
 * 1. Stay on the current account until it hits a 429.
 * 2. On 429, record the rate limit reset time for the specific quota key.
 * 3. Next request: if current account is still rate-limited for the family → rotate.
 * 4. Rotation: find any non-rate-limited account via round-robin cursor.
 * 5. Rate limits are tracked per QuotaKey so Claude and Gemini quotas are independent.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private cursor = 0;
  private currentAccountIndexByFamily: Record<ModelFamily, number> = {
    claude: -1,
    gemini: -1,
  };
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

  static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
    const stored = await loadAccounts();
    return new AccountManager(authFallback, stored);
  }

  constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null) {
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;

    if (stored && stored.accounts.length === 0) {
      this.accounts = [];
      this.cursor = 0;
      return;
    }

    if (stored && stored.accounts.length > 0) {
      this.accounts = stored.accounts
        .map((acc: AccountMetadataV3, index: number): ManagedAccount | null => {
          if (!acc.refreshToken) return null;
          const parts = parseRefreshParts(acc.refreshToken);
          return {
            index,
            email: acc.email,
            addedAt: acc.addedAt,
            lastUsed: acc.lastUsed,
            parts,
            rateLimitResetTimes: acc.rateLimitResetTimes || {},
            lastSwitchReason: acc.lastSwitchReason,
          };
        })
        .filter((a): a is ManagedAccount => a !== null);

      this.cursor = clampNonNegativeInt(stored.activeIndex, 0);
      if (this.accounts.length > 0) {
        this.cursor = this.cursor % this.accounts.length;
        const defaultIndex = this.cursor;
        this.currentAccountIndexByFamily.claude =
          clampNonNegativeInt(stored.activeIndexByFamily?.claude, defaultIndex) % this.accounts.length;
        this.currentAccountIndexByFamily.gemini =
          clampNonNegativeInt(stored.activeIndexByFamily?.gemini, defaultIndex) % this.accounts.length;
      }
      return;
    }

    // Seed from single auth fallback (first login)
    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh);
      if (parts.refreshToken) {
        const now = nowMs();
        this.accounts = [{
          index: 0, email: undefined, addedAt: now, lastUsed: 0, parts,
          access: authFallback.access, expires: authFallback.expires,
          rateLimitResetTimes: {},
        }];
        this.cursor = 0;
        this.currentAccountIndexByFamily.claude = 0;
        this.currentAccountIndexByFamily.gemini = 0;
      }
    }
  }

  getAccountCount(): number { return this.accounts.length; }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({
      ...a,
      parts: { ...a.parts },
      rateLimitResetTimes: { ...a.rateLimitResetTimes },
    }));
  }

  getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
    const idx = this.currentAccountIndexByFamily[family];
    if (idx >= 0 && idx < this.accounts.length) return this.accounts[idx] ?? null;
    return null;
  }

  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation", family: ModelFamily): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndexByFamily[family] = account.index;
  }

  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = nowMs();
    if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) return false;
    return true;
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = nowMs();
  }

  /**
   * Main per-request entry point.
   * Returns current account if still valid, otherwise rotates.
   */
  getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
    const current = this.getCurrentAccountForFamily(family);
    if (current) {
      clearExpiredRateLimits(current);
      if (!isRateLimitedForFamily(current, family)) {
        current.lastUsed = nowMs();
        return current;
      }
    }
    const next = this.getNextForFamily(family);
    if (next) this.currentAccountIndexByFamily[family] = next.index;
    return next;
  }

  getNextForFamily(family: ModelFamily): ManagedAccount | null {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });
    if (available.length === 0) return null;
    const account = available[this.cursor % available.length];
    if (!account) return null;
    this.cursor++;
    account.lastUsed = nowMs();
    return account;
  }

  /**
   * Call this after receiving a 429 response.
   * @param retryAfterMs  how long to wait (from Retry-After header or default)
   * @param headerStyle   which quota pool was rate-limited (for Gemini)
   */
  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = "antigravity",
  ): void {
    const key = getQuotaKey(family, headerStyle);
    account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
  }

  isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle): boolean {
    clearExpiredRateLimits(account);
    return isRateLimitedForQuotaKey(account, getQuotaKey(family, headerStyle));
  }

  /** For Gemini: returns which header style's quota is still available */
  getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily): HeaderStyle | null {
    clearExpiredRateLimits(account);
    if (family === "claude") {
      return isRateLimitedForQuotaKey(account, "claude") ? null : "antigravity";
    }
    if (!isRateLimitedForQuotaKey(account, "gemini-antigravity")) return "antigravity";
    if (!isRateLimitedForQuotaKey(account, "gemini-cli")) return "gemini-cli";
    return null;
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account);
    if (idx < 0) return false;
    this.accounts.splice(idx, 1);
    this.accounts.forEach((acc, index) => { acc.index = index; });
    if (this.accounts.length === 0) {
      this.cursor = 0;
      this.currentAccountIndexByFamily.claude = -1;
      this.currentAccountIndexByFamily.gemini = -1;
      return true;
    }
    if (this.cursor > idx) this.cursor -= 1;
    this.cursor = this.cursor % this.accounts.length;
    for (const family of ["claude", "gemini"] as ModelFamily[]) {
      if (this.currentAccountIndexByFamily[family] > idx) this.currentAccountIndexByFamily[family] -= 1;
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) this.currentAccountIndexByFamily[family] = -1;
    }
    return true;
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
    account.parts = parseRefreshParts(auth.refresh);
    account.access = auth.access;
    account.expires = auth.expires;
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    };
  }

  /** Minimum ms to wait before any account becomes available for the family */
  getMinWaitTimeForFamily(family: ModelFamily): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });
    if (available.length > 0) return 0;

    const waitTimes: number[] = [];
    for (const a of this.accounts) {
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude;
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()));
      } else {
        const t1 = a.rateLimitResetTimes["gemini-antigravity"];
        const t2 = a.rateLimitResetTimes["gemini-cli"];
        // Account becomes available when EITHER pool expires
        const accountWait = Math.min(
          t1 !== undefined ? Math.max(0, t1 - nowMs()) : Infinity,
          t2 !== undefined ? Math.max(0, t2 - nowMs()) : Infinity,
        );
        if (accountWait !== Infinity) waitTimes.push(accountWait);
      }
    }
    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }

  getAccounts(): ManagedAccount[] { return [...this.accounts]; }

  async saveToDisk(): Promise<void> {
    const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude);
    const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini);
    const storage: AccountStorageV3 = {
      version: 3,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        lastSwitchReason: a.lastSwitchReason,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: { claude: claudeIndex, gemini: geminiIndex },
    };
    await saveAccounts(storage);
  }
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/token.ts`

```typescript
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_PROVIDER_ID } from "./constants";
import { formatRefreshParts, parseRefreshParts } from "./auth-helpers";
import type { OAuthAuthDetails, RefreshParts } from "./types";
import { Auth } from "../index";

export class AntigravityTokenRefreshError extends Error {
  code?: string;
  description?: string;
  status: number;
  statusText: string;
  constructor(options: { message: string; code?: string; description?: string; status: number; statusText: string }) {
    super(options.message);
    this.name = "AntigravityTokenRefreshError";
    this.code = options.code;
    this.description = options.description;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}

export async function refreshAccessToken(auth: OAuthAuthDetails): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) return undefined;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: parts.refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new AntigravityTokenRefreshError({
      message: `Token refresh failed (${response.status} ${response.statusText})`,
      status: response.status,
      statusText: response.statusText,
    });
  }

  const payload = await response.json() as { access_token: string; expires_in: number; refresh_token?: string };
  const refreshedParts: RefreshParts = {
    refreshToken: payload.refresh_token ?? parts.refreshToken,
    projectId: parts.projectId,
    managedProjectId: parts.managedProjectId,
  };
  return {
    ...auth,
    access: payload.access_token,
    expires: Date.now() + payload.expires_in * 1000,
    refresh: formatRefreshParts(refreshedParts),
  };
}

/** Ensures access token is valid (5 min buffer), refreshes and persists if needed */
export async function ensureValidToken(auth: OAuthAuthDetails): Promise<OAuthAuthDetails> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) throw new Error("No refresh token available");
  const needsRefresh = !auth.access || !auth.expires || auth.expires <= Date.now() + 5 * 60 * 1000;
  if (!needsRefresh) return auth;
  const refreshed = await refreshAccessToken(auth);
  if (!refreshed) throw new Error("Failed to refresh access token");
  await Auth.set(ANTIGRAVITY_PROVIDER_ID, refreshed as Extract<Auth.Info, { type: "oauth" }>);
  return refreshed;
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/oauth.ts`

```typescript
import { generatePKCE } from "@openauthjs/openauth/pkce";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES, ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_HEADERS } from "./constants";
import type { AntigravityAuthorization, AntigravityTokenExchangeResult, AntigravityOAuthState } from "./types";

function encodeState(payload: AntigravityOAuthState): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodeState(state: string): AntigravityOAuthState {
  const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

export async function authorizeAntigravity(projectId?: string): Promise<AntigravityAuthorization> {
  const pkce = await generatePKCE() as { challenge: string; verifier: string };
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", encodeState({ verifier: pkce.verifier, projectId }));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return { url: url.toString(), verifier: pkce.verifier, projectId };
}

async function fetchProjectID(accessToken: string): Promise<string> {
  const loadHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": ANTIGRAVITY_HEADERS["Client-Metadata"],
  };
  const endpoints = Array.from(new Set<string>([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]));
  for (const base of endpoints) {
    const response = await fetch(`${base}/v1internal:loadCodeAssist`, {
      method: "POST", headers: loadHeaders,
      body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
    });
    if (!response.ok) continue;
    const data = await response.json();
    if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) return data.cloudaicompanionProject;
    if (data.cloudaicompanionProject?.id) return data.cloudaicompanionProject.id;
  }
  return "";
}

export async function exchangeAntigravity(code: string, state: string): Promise<AntigravityTokenExchangeResult> {
  try {
    const { verifier, projectId } = decodeState(state);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code, grant_type: "authorization_code",
        redirect_uri: ANTIGRAVITY_REDIRECT_URI, code_verifier: verifier,
      }),
    });
    if (!tokenResponse.ok) return { type: "failed", error: await tokenResponse.text() };
    const tokenPayload = await tokenResponse.json() as { access_token: string; expires_in: number; refresh_token: string };
    const userInfo = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
    }).then((r) => r.ok ? r.json() as Promise<{ email?: string }> : {});
    if (!tokenPayload.refresh_token) return { type: "failed", error: "Missing refresh token" };
    const effectiveProjectId = projectId ?? await fetchProjectID(tokenPayload.access_token);
    return {
      type: "success",
      refresh: `${tokenPayload.refresh_token}|${effectiveProjectId || ""}`,
      access: tokenPayload.access_token,
      expires: Date.now() + tokenPayload.expires_in * 1000,
      email: (userInfo as any).email,
      projectId: effectiveProjectId,
    };
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : "Unknown error" };
  }
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/server.ts`

Local HTTP server that receives the OAuth callback on `http://127.0.0.1:51121/oauth-callback`.

```typescript
import http from "node:http";

export interface OAuthServerInfo {
  port: number;
  close: () => void;
  waitForCallback: () => Promise<{ code: string; state: string } | null>;
}

export function startLocalOAuthServer(): Promise<OAuthServerInfo> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== "/oauth-callback") { res.statusCode = 404; res.end("Not found"); return; }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) { res.statusCode = 400; res.end("Missing code or state"); return; }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("Login successful. You can close this window.");
    (server as any)._lastCallback = { code, state };
  });

  return new Promise((resolve) => {
    server.listen(51121, "127.0.0.1", () => {
      resolve({
        port: 51121,
        close: () => server.close(),
        waitForCallback: async () => {
          for (let i = 0; i < 600; i++) {  // 60s timeout
            await new Promise<void>((r) => setTimeout(r, 100));
            if ((server as any)._lastCallback) return (server as any)._lastCallback;
          }
          return null;
        },
      });
    }).on("error", () => {
      resolve({ port: 51121, close: () => {}, waitForCallback: async () => null });
    });
  });
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/project.ts`

Resolves the Google Cloud project ID from the API.

```typescript
import { ANTIGRAVITY_HEADERS, ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_DEFAULT_PROJECT_ID } from "./constants";
import { formatRefreshParts, parseRefreshParts } from "./auth-helpers";
import type { OAuthAuthDetails, ProjectContextResult } from "./types";

export async function loadManagedProject(accessToken: string, projectId?: string): Promise<any | null> {
  const loadHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": ANTIGRAVITY_HEADERS["Client-Metadata"],
  };
  const endpoints = Array.from(new Set<string>([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]));
  for (const base of endpoints) {
    const response = await fetch(`${base}/v1internal:loadCodeAssist`, {
      method: "POST", headers: loadHeaders,
      body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
    });
    if (response.ok) return await response.json();
  }
  return null;
}

export async function resolveProjectContext(auth: OAuthAuthDetails): Promise<ProjectContextResult> {
  if (!auth.access) return { auth, effectiveProjectId: "" };
  const parts = parseRefreshParts(auth.refresh);
  if (parts.managedProjectId) return { auth, effectiveProjectId: parts.managedProjectId };
  const loadPayload = await loadManagedProject(auth.access, parts.projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID);
  const managedProjectId =
    typeof loadPayload?.cloudaicompanionProject === "string"
      ? loadPayload.cloudaicompanionProject
      : loadPayload?.cloudaicompanionProject?.id;
  if (managedProjectId) {
    const updatedAuth = { ...auth, refresh: formatRefreshParts({ ...parts, managedProjectId }) };
    return { auth: updatedAuth, effectiveProjectId: managedProjectId };
  }
  return { auth, effectiveProjectId: parts.projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID };
}
```

---

### Source file: `packages/arctic/src/auth/antigravity-oauth/cache.ts`

In-memory cache for OAuth tokens and Claude thinking-block signatures.

```typescript
import { accessTokenExpired } from "./auth-helpers";
import type { OAuthAuthDetails } from "./types";
import { createHash } from "node:crypto";

// ---- OAuth access token cache ----

const authCache = new Map<string, OAuthAuthDetails>();

export function resolveCachedAuth(auth: OAuthAuthDetails): OAuthAuthDetails {
  const key = auth.refresh?.trim();
  if (!key) return auth;
  const cached = authCache.get(key);
  if (!cached) { authCache.set(key, auth); return auth; }
  if (!accessTokenExpired(auth)) { authCache.set(key, auth); return auth; }
  if (!accessTokenExpired(cached)) return cached;
  authCache.set(key, auth);
  return auth;
}

export function storeCachedAuth(auth: OAuthAuthDetails): void {
  const key = auth.refresh?.trim();
  if (key) authCache.set(key, auth);
}

export function clearCachedAuth(refresh?: string): void {
  if (!refresh) { authCache.clear(); return; }
  const key = refresh.trim();
  if (key) authCache.delete(key);
}

// ---- Claude thinking-block signature cache ----
// Required for multi-turn conversations with Claude thinking models.
// Each turn that includes a thinking block must carry the server-issued signature.

interface SignatureEntry { signature: string; timestamp: number; }

const signatureCache = new Map<string, Map<string, SignatureEntry>>();
const SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES_PER_SESSION = 100;

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function cacheSignature(sessionId: string, text: string, signature: string): void {
  if (!sessionId || !text || !signature) return;
  let sessionCache = signatureCache.get(sessionId);
  if (!sessionCache) { sessionCache = new Map(); signatureCache.set(sessionId, sessionCache); }
  if (sessionCache.size >= MAX_ENTRIES_PER_SESSION) {
    const now = Date.now();
    for (const [key, entry] of sessionCache.entries()) {
      if (now - entry.timestamp > SIGNATURE_CACHE_TTL_MS) sessionCache.delete(key);
    }
    if (sessionCache.size >= MAX_ENTRIES_PER_SESSION) {
      const oldest = [...sessionCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, Math.floor(MAX_ENTRIES_PER_SESSION / 4));
      for (const [key] of oldest) sessionCache.delete(key);
    }
  }
  sessionCache.set(hashText(text), { signature, timestamp: Date.now() });
}

export function getCachedSignature(sessionId: string, text: string): string | undefined {
  if (!sessionId || !text) return undefined;
  const sessionCache = signatureCache.get(sessionId);
  if (!sessionCache) return undefined;
  const entry = sessionCache.get(hashText(text));
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
    sessionCache.delete(hashText(text));
    return undefined;
  }
  return entry.signature;
}

export function clearSignatureCache(sessionId?: string): void {
  if (sessionId) signatureCache.delete(sessionId);
  else signatureCache.clear();
}
```

---

### Auth key format for multi-connection support

`packages/arctic/src/auth/index.ts`

```typescript
// Single connection:  auth["codex"] = { type: "codex", ... }
// Named connection:   auth["codex:work"] = { type: "codex", ... }
//                     auth["codex:personal"] = { type: "codex", ... }

export function parseKey(key: string): { provider: string; connection?: string } {
  const parts = key.split(":");
  if (parts.length === 1) return { provider: parts[0] };
  return { provider: parts[0], connection: parts.slice(1).join(":") };
}

export function formatKey(provider: string, connection?: string): string {
  if (!connection) return provider;
  return `${provider}:${connection}`;
}

export async function listConnections(provider: string): Promise<Array<{ key: string; connection?: string; info: Info }>> {
  const auth = await all();
  const connections: Array<{ key: string; connection?: string; info: Info }> = [];
  for (const [key, info] of Object.entries(auth)) {
    const parsed = parseKey(key);
    if (parsed.provider === provider) connections.push({ key, connection: parsed.connection, info });
  }
  return connections;
}
```

The auth file is stored at `~/.arctic/data/auth.json` — a flat JSON dict of `{ [key]: Auth.Info }`.

---

## Part 2 — Usage Stats Implementation

### Overview

Two separate systems:

| System | Location | What it does |
|---|---|---|
| `arctic stats` CLI | `cli/cmd/stats.ts` | Local aggregation of token/cost/session data from storage. ASCII charts. |
| `arctic usage` / `/usage` | `provider/usage.ts`, `session/usage.ts` | Live quota fetch from each provider's API. |
| TUI Stats dialog | `tui/component/dialog-stats.tsx` | Interactive TUI for stats (heatmap, models, cost) |
| TUI Usage dialog | `tui/component/dialog-usage.tsx` | Interactive TUI for live quota per provider |

---

### Source file: `packages/arctic/src/provider/usage.ts` (abridged — key types and structure)

```typescript
import z from "zod";

export namespace ProviderUsage {
  export type TimePeriod = "session" | "daily" | "weekly" | "monthly";

  export const RateLimitWindowSummary = z.object({
    usedPercent: z.number().nullable(),        // 0–100
    windowMinutes: z.number().nullable().optional(),
    resetsAt: z.number().nullable().optional(), // Unix timestamp (seconds)
    label: z.string().optional(),
  });
  export type RateLimitWindowSummary = z.infer<typeof RateLimitWindowSummary>;

  export const CreditsSummary = z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().optional(),
  });
  export type CreditsSummary = z.infer<typeof CreditsSummary>;

  export const TokenUsage = z.object({
    total: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
    cached: z.number().optional(),
    cacheCreation: z.number().optional(),
  });
  export type TokenUsage = z.infer<typeof TokenUsage>;

  export const CostSummary = z.object({
    totalCost: z.number().optional(),
    inputCost: z.number().optional(),
    outputCost: z.number().optional(),
    cacheCreationCost: z.number().optional(),
    cacheReadCost: z.number().optional(),
  });
  export type CostSummary = z.infer<typeof CostSummary>;

  export const Record = z.object({
    providerID: z.string(),
    providerName: z.string(),
    planType: z.string().optional(),          // human-readable plan/tier name
    allowed: z.boolean().optional(),          // false = access blocked
    limitReached: z.boolean().optional(),
    limits: z.object({
      primary: RateLimitWindowSummary.optional(),   // e.g. 5-hour window
      secondary: RateLimitWindowSummary.optional(), // e.g. weekly window
    }).optional(),
    credits: CreditsSummary.optional(),
    tokenUsage: TokenUsage.optional(),        // aggregated from local session data
    costSummary: CostSummary.optional(),
    fetchedAt: z.number(),
    error: z.string().optional(),
    accountId: z.string().optional(),
    accountUsername: z.string().optional(),
  });
  export type Record = z.infer<typeof Record>;

  // Registry of provider-specific fetchers
  // Key = providerID (exact match, including connection IDs)
  // Falls back to base provider if no direct match
  const usageFetchers: Record<string, UsageFetcher> = {
    codex:                         fetchCodexUsage,
    "zai-coding-plan":             fetchSessionUsage,
    "minimax-coding-plan":         fetchMinimaxUsage,
    minimax:                       fetchMinimaxUsage,
    anthropic:                     fetchAnthropicUsage,
    "@ai-sdk/anthropic":           fetchAnthropicUsage,
    openrouter:                    fetchSessionUsage,
    "@openrouter/ai-sdk-provider": fetchSessionUsage,
    "github-copilot":              fetchGithubCopilotUsageWrapper,
    google:                        fetchGoogleUsage,
    "kimi-for-coding":             fetchKimiUsage,
    antigravity:                   fetchAntigravityUsage,
    alibaba:                       fetchAlibabaUsage,
  };

  /**
   * Main entry point.
   * @param targetProviders  undefined = all configured providers
   * @param options.sessionID  for session-scoped token usage
   * @param options.timePeriod  "session" | "daily" | "weekly" | "monthly"
   */
  export async function fetch(
    targetProviders?: string | string[],
    options?: { sessionID?: string; timePeriod?: TimePeriod },
  ): Promise<Record[]>;
}
```

---

### Per-provider fetcher API contract

Every fetcher implements:

```typescript
type UsageFetcher = (input: {
  provider: Provider.Info;
  sessionID?: string;
  timePeriod?: TimePeriod;
}) => Promise<Omit<Record, "providerID" | "providerName" | "fetchedAt">>;
```

---

### Session-based generic fetcher

Used for providers without a usage API (openrouter, zai, etc.) — scans stored messages.

```typescript
async function fetchSessionUsage(input): Promise<...> {
  // 1. Determine time window from timePeriod
  // 2. Read assistant messages for this provider from Storage
  // 3. Filter by time window
  // 4. Sum: input/output/cacheRead/cacheWrite tokens
  // 5. Compute cost via Pricing.calculateCostAsync(modelID, tokens)
  // 6. Return tokenUsage + costSummary
}

function getTimeFilter(period: TimePeriod, now: number): (timestamp: number) => boolean {
  switch (period) {
    case "session": return () => true; // filtered by sessionID separately
    case "daily": {
      const start = new Date(now); start.setHours(0,0,0,0);
      return (t) => t >= start.getTime();
    }
    case "weekly": {
      const start = new Date(now);
      const daysToMonday = start.getDay() === 0 ? 6 : start.getDay() - 1;
      start.setDate(start.getDate() - daysToMonday); start.setHours(0,0,0,0);
      return (t) => t >= start.getTime();
    }
    case "monthly": {
      const start = new Date(now); start.setDate(1); start.setHours(0,0,0,0);
      return (t) => t >= start.getTime();
    }
  }
}
```

---

### Provider-specific API endpoints

| Provider | URL | Auth type | Key response fields |
|---|---|---|---|
| `codex` | `{codexBaseUrl}/backend-api/codex/usage` | Codex/OAuth JWT | `plan_type`, `rate_limit.{primary,secondary}_window`, `credits.{has_credits,unlimited,balance}` |
| `anthropic` | `https://api.anthropic.com/api/oauth/usage` | OAuth Bearer | `five_hour.utilization`, `five_hour.resets_at`, `seven_day.utilization`, `seven_day.resets_at` |
| `zai-coding-plan` | `https://api.z.ai/api/monitor/usage/quota/limit` | API key Bearer | `data.limits[]` with `type`, `usage`, `remaining`, `percentage`, `currentValue` |
| `minimax` | `https://platform.minimax.io/v1/api/openplatform/coding_plan/remains?GroupId=X` | API key Bearer | `model_remains[0].current_interval_total_count`, `.current_interval_usage_count`, `.remains_time` |
| `github-copilot` | GitHub Copilot seats API | OAuth/API key | `copilot_plan`, `access_type_sku`, `quota_snapshots.{model}.{entitlement,remaining,unlimited,percent_remaining}`, `quota_reset_date_utc` |
| `google` | `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | OAuth Bearer | `buckets[].{modelId,tokenType,remainingFraction,resetTime}` |
| `kimi-for-coding` | `https://api.kimi.com/coding/v1/usages` | API key Bearer | `usage` (weekly detail), `limits[].detail.{limit,remaining,reset_at}`, `limits[].window.{duration,timeUnit}` |
| `antigravity` | Via `fetchAntigravityModels(accessToken)` | OAuth Bearer | `[].{displayName,remainingFraction,resetTime}` |
| `alibaba` | Local storage only | — | Counts today's assistant messages vs hardcoded 2000/day |

---

### Source file: `packages/arctic/src/session/usage-format.ts`

Self-contained renderer. No external dependencies.

```typescript
export type RateLimitWindowSummary = {
  usedPercent: number | null;
  windowMinutes?: number | null;
  resetsAt?: number | null;
};

export type CreditsSummary = { hasCredits: boolean; unlimited: boolean; balance?: string };
export type CostSummary = { totalCost?: number; inputCost?: number; outputCost?: number; cacheCreationCost?: number; cacheReadCost?: number };

export type UsageRecordSummary = {
  providerID: string;
  providerName: string;
  planType?: string;
  allowed?: boolean;
  limitReached?: boolean;
  limits?: { primary?: RateLimitWindowSummary; secondary?: RateLimitWindowSummary };
  credits?: CreditsSummary;
  tokenUsage?: { total?: number; input?: number; output?: number; cached?: number; cacheCreation?: number };
  costSummary?: CostSummary;
  fetchedAt: number;
  error?: string;
};

const BAR_SEGMENTS = 20;
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
const CARD_PADDING = 2;
const HELP_URL = "https://chatgpt.com/codex/settings/usage";

export function formatUsageSummary(records: UsageRecordSummary[], now = Date.now()): string {
  const content: string[] = [];
  content.push(`Usage summary · ${new Date(now).toISOString()}`);
  content.push("");
  content.push(`Visit ${HELP_URL} for up-to-date`);
  content.push("information on rate limits and credits");

  if (records.length === 0) {
    content.push(""); content.push("No providers are configured for usage tracking.");
    return renderCard(content);
  }

  records.forEach((record, index) => {
    const plan = record.planType ? ` (plan: ${record.planType})` : "";
    content.push(""); content.push(`${record.providerName}${plan}`);
    if (record.error) { content.push(`  Error   : ${record.error}`); return; }
    content.push(`  Access  : ${formatAccess(record)}`);
    if (record.credits) content.push(`  Credits : ${formatCredits(record.credits)}`);
    const tokensLine = formatTokenUsage(record.tokenUsage);
    if (tokensLine) content.push(`  Tokens  : ${tokensLine}`);
    const costLine = formatCost(record.costSummary);
    if (costLine) content.push(`  Cost    : ${costLine}`);
    const limitLines = formatLimits(record.limits, now);
    if (limitLines) { content.push("  Limits"); content.push(...limitLines.map((l) => `    ${l}`)); }
    if (index < records.length - 1) { content.push(""); content.push("  ───────────────────────────────────────────────"); }
  });

  return renderCard(content);
}

function renderCard(lines: string[]): string {
  const contentWidth = Math.max(...lines.map((l) => l.length), 0) + 2;
  const h = `╭${"─".repeat(contentWidth + CARD_PADDING * 2)}╮`;
  const b = `╰${"─".repeat(contentWidth + CARD_PADDING * 2)}╯`;
  return [h, ...lines.map((l) => `│${" ".repeat(CARD_PADDING)}${l.padEnd(contentWidth)}${" ".repeat(CARD_PADDING)}│`), b].join("\n");
}

function formatAccess(record: UsageRecordSummary): string {
  if (record.allowed === false) return record.limitReached ? "blocked, limit reached" : "blocked";
  if (record.limitReached) return "allowed, limit reached";
  if (record.allowed === true) return "allowed";
  return "unknown";
}

function renderProgressBar(percentRemaining: number): string {
  const ratio = Math.max(0, Math.min(100, percentRemaining)) / 100;
  const filled = Math.round(ratio * BAR_SEGMENTS);
  return `[${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_SEGMENTS - filled)}]`;
}

function formatRemaining(window: RateLimitWindowSummary): string {
  if (typeof window.usedPercent !== "number") return "usage unknown";
  const pct = Math.max(0, 100 - window.usedPercent);
  return `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}% ${renderProgressBar(pct)}`;
}

function formatReset(resetsAt: number | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined;
  const resetDate = new Date(resetsAt * 1000);
  const diff = Math.max(0, Math.round((resetDate.getTime() - now) / 60000));
  const h = Math.floor(diff / 60), m = Math.floor(diff % 60);
  const rel = diff > 0 ? `in ${h}h ${m}m` : "now";
  return `resets ${rel} (${resetDate.toISOString()})`;
}

function formatCredits(credits: CreditsSummary): string {
  if (credits.unlimited) return "unlimited plan";
  if (!credits.hasCredits) return "not included with this plan";
  if (credits.balance) return `balance ${credits.balance}`;
  return "available";
}

function formatTokenUsage(usage: UsageRecordSummary["tokenUsage"]): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.total != null) parts.push(`total ${formatCompactNumber(usage.total)}`);
  if (usage.input != null) parts.push(`input ${formatCompactNumber(usage.input)}`);
  if (usage.output != null) parts.push(`output ${formatCompactNumber(usage.output)}`);
  if (usage.cached != null) parts.push(`cached ${formatCompactNumber(usage.cached)}`);
  if (usage.cacheCreation != null) parts.push(`cache writes ${formatCompactNumber(usage.cacheCreation)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function formatCost(cost: CostSummary | undefined): string | undefined {
  if (!cost || cost.totalCost == null) return undefined;
  const parts: string[] = [`total ${formatCurrency(cost.totalCost)}`];
  if (cost.inputCost) parts.push(`input ${formatCurrency(cost.inputCost)}`);
  if (cost.outputCost) parts.push(`output ${formatCurrency(cost.outputCost)}`);
  if (cost.cacheReadCost) parts.push(`cache read ${formatCurrency(cost.cacheReadCost)}`);
  if (cost.cacheCreationCost) parts.push(`cache write ${formatCurrency(cost.cacheCreationCost)}`);
  return parts.join(" · ");
}

function formatCurrency(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.00001) return "<$0.00001";
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

function formatCompactNumber(value: number): string {
  const units = [
    { value: 1_000_000_000_000, suffix: "T" },
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "k" },
  ];
  for (const unit of units) {
    if (Math.abs(value) >= unit.value) {
      const scaled = value / unit.value;
      return `${scaled.toFixed(Math.abs(scaled) < 10 ? 1 : 0).replace(/\.0$/, "")}${unit.suffix}`;
    }
  }
  return Math.round(value) === value ? value.toString() : value.toFixed(1).replace(/\.0$/, "");
}

function formatLimits(limits: UsageRecordSummary["limits"], now: number): string[] | undefined {
  if (!limits) return undefined;
  const rows: string[] = [];
  if (limits.primary) {
    const rem = formatRemaining(limits.primary);
    const rst = formatReset(limits.primary.resetsAt ?? undefined, now) ?? "reset unknown";
    rows.push(`Primary   ${rem}  ·  ${rst}`);
  }
  if (limits.secondary) {
    const rem = formatRemaining(limits.secondary);
    const rst = formatReset(limits.secondary.resetsAt ?? undefined, now) ?? "reset unknown";
    rows.push(`Secondary ${rem}  ·  ${rst}`);
  }
  return rows.length ? rows : undefined;
}
```

---

### Source file: `packages/arctic/src/session/usage.ts`

The `/usage` slash command handler — inserts usage as a synthetic message in the session.

```typescript
export namespace SessionUsage {
  export async function run(input: { sessionID: string; agent: string; model: { providerID: string; modelID: string } }): Promise<MessageV2.WithParts> {
    // 1. Insert synthetic user message with text "/usage"
    const parentID = (await createSyntheticUserMessage(input)).info.id;
    const now = Date.now();

    // 2. Insert temporary "Fetching usage..." assistant message
    const loaderMessage = await Session.updateMessage({ /* ... finish: "usage" */ });
    await Session.updatePart({ /* text: "Fetching usage..." */ });

    // 3. Fetch from all providers
    let summaryText = "";
    try {
      const usageRecords = await ProviderUsage.fetch(undefined, { sessionID: input.sessionID });
      summaryText = formatUsageSummary(usageRecords);
    } catch (error) {
      summaryText = `Failed to fetch usage: ${error instanceof Error ? error.message : String(error)}`;
    }

    // 4. Remove temp message, insert final message with summary card
    await Session.removeMessage({ sessionID: input.sessionID, messageID: loaderMessage.id });
    const assistant = await Session.updateMessage({ /* ... finish: "usage" */ });
    const part = await Session.updatePart({ /* text: summaryText */ });

    return { info: assistant, parts: [part] };
  }
}
```

---

### Stats data structure (for `arctic stats` CLI and TUI stats dialog)

```typescript
interface SessionStats {
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
  longestSession: number;      // ms
  peakHour: number;            // 0–23
  modelUsage: Record<string, { count: number; tokens: number; cost: number }>;
  dailyActivity: Record<string, number>;   // date string → session count
  dailyCost: Record<string, number>;       // date string → cost
  hourlyActivity: Record<number, number>;  // hour → session count
  tokenBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costPerDay: number;
  costPerSession: number;
}
```

---

### CLI stats command features

`packages/arctic/src/cli/cmd/stats.ts`

```
arctic stats [--view all|overview|models|cost] [--json] [--date today|yesterday|YYYY-MM-DD] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

**Rendering pipeline:**
1. `parseDateFilter` → optional `{ from: Date, to: Date, label: string }`
2. `aggregateStats(dateFilter?)` → reads all `MessageV2.Info` from storage, aggregates into `SessionStats`
3. `displayStats(stats, view, dateFilter)` → renders one or more panels:
   - **Overview**: activity heatmap + summary stat cols + streak info
   - **Models**: ranked table by tokens used
   - **Cost**: breakdown by input/output/cache + per-day and per-session average

**Activity heatmap** (ASCII, git-style):
```
    Jan        Feb
Mon ░ ░ ▓ ░ ░ ▓ ▓
Wed ░ █ ░ ▓ ░ ░ ░
Fri ░ ░ ░ ░ ░ ▓ ░
```
Colors: 5 heat levels using ANSI 256-color codes.

---

## Reimplementation Guide for opencode / openclaude

### Multi-account

1. **New storage file** — add `~/.opencode/provider-accounts.json` (or per-provider variant). Use the `AccountStorageV3` schema from above.

2. **Copy `AccountManager`** — it has zero opencode-specific imports. It only needs:
   - `parseRefreshParts` / `formatRefreshParts` (from `auth-helpers.ts`)
   - `loadAccounts` / `saveAccounts` (from `storage.ts`)

3. **In the provider's HTTP interceptor:**
   ```typescript
   // Before each request:
   const account = accountManager.getCurrentOrNextForFamily(family);
   if (!account) throw new Error("All accounts rate-limited, retry in Xms");

   // On 429 response:
   const retryAfter = parseRetryAfter(response); // from Retry-After header
   accountManager.markRateLimited(account, retryAfter, family, headerStyle);
   await accountManager.saveToDisk();
   // then retry with a new account

   // Show toast when account switches (debounced):
   if (accountManager.shouldShowAccountToast(newAccount.index)) {
     showToast(`Switched to account ${newAccount.email ?? newAccount.index + 1}`);
     accountManager.markToastShown(newAccount.index);
   }
   ```

4. **Two Gemini header styles** — implement the `ANTIGRAVITY_HEADERS` vs `GEMINI_CLI_HEADERS` pattern. Use `getAvailableHeaderStyle()` to pick which one to send; on 429, mark that style's quota and retry with the other.

5. **Token refresh** — copy `ensureValidToken` / `refreshAccessToken` from `token.ts`. Call before every request.

6. **Named connections** — store as `"providerID:connectionName"` in the auth file. Use `parseKey` / `formatKey` to build the key. List all connections for a provider with `listConnections(providerID)`.

### Usage stats

1. **Copy `ProviderUsage` namespace** from `provider/usage.ts`. Adapt imports:
   - Replace `Auth.get` with opencode's auth lookup
   - Replace `Provider.list()` with opencode's provider registry
   - Replace `Storage.list/read` with opencode's message store
   - Replace `Pricing.calculateCostAsync` with opencode's cost calculator

2. **Copy `formatUsageSummary`** from `session/usage-format.ts` — zero dependencies, copy as-is.

3. **Add one fetcher per provider** — implement the `UsageFetcher` signature, register in `usageFetchers`. Use the API table above for endpoints, auth, and response fields.

4. **`/usage` slash command** — detect `/usage` input, call `ProviderUsage.fetch(undefined, { sessionID })`, render with `formatUsageSummary`, insert as a message. No multi-account logic needed here.

5. **Stats aggregation** — read all assistant messages, group by date/model/hour, use `Pricing.calculateCost` per message. The `SessionStats` interface above is the target shape. Render with ANSI codes per the heatmap algorithm in `dialog-stats.tsx`.
