import {
  getActiveGithubModelsAccountName,
  getGithubModelAccountName,
  listGithubModelsAccounts,
} from '../../utils/githubModelsCredentials.js'

const GITHUB_API_BASE_URL = 'https://api.github.com'

type CopilotUsageResponse = {
  access_type_sku?: unknown
  copilot_plan?: unknown
  quota_reset_date_utc?: unknown
  quota_reset_date?: unknown
  quota_snapshots?: unknown
}

type GithubUserResponse = {
  id?: unknown
  login?: unknown
}

export type GithubUsageWindow = {
  limit?: number
  remaining?: number
  usedPercent?: number
  resetsAt?: string
  unlimited?: boolean
  limitReached?: boolean
}

/** Per-category quota detail for display (e.g. "chat: unlimited", "premium_interactions: 38/300") */
export type GithubQuotaDetail = {
  name: string
  label: string // e.g. "unlimited" or "38/300"
  unlimited: boolean
}

export type GithubUsageData = {
  endpoint: string
  model: string
  /** Plan name, single line (e.g. "free educational quota - individual") */
  planType?: string
  accountId?: string
  accountUsername?: string
  /** Per-category quota summaries for display */
  quotaDetails?: GithubQuotaDetail[]
  /** Single primary usage window — the finite quota with lowest remaining %.
   *  undefined when ALL quotas are unlimited (no bar to show). */
  requests?: GithubUsageWindow
  tokens?: GithubUsageWindow
  /** True when every quota category is unlimited */
  allUnlimited?: boolean
  /** Raw API response for debug purposes */
  _debug?: {
    rawPayload?: unknown
    tokenType?: string
  }
}

export type FetchGithubUsageOptions = {
  baseUrl?: string
  model?: string
  processEnv?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

// ---------------------------------------------------------------------------
// Auth helpers — OAuth token with Bearer scheme ONLY
// ---------------------------------------------------------------------------

/**
 * Resolve the OAuth access token for the given model string.
 *
 * The reference Copilot usage implementation uses ONLY the OAuth token (the one
 * stored as `oauthAccessToken` in the credential blob) — NOT the Copilot
 * session JWT (`accessToken`). Using the Copilot JWT against the
 * `/copilot_internal/user` endpoint may succeed (HTTP 200) but return a
 * response body *without* `quota_snapshots`, causing the bars to never render.
 */
function resolveOauthTokenForModel(model: string): string | undefined {
  const accounts = listGithubModelsAccounts()
  if (accounts.length === 0) {
    return undefined
  }

  const requestedAccountName = getGithubModelAccountName(model)
  if (requestedAccountName) {
    return (
      accounts.find(
        account =>
          account.accountName.toLowerCase() === requestedAccountName.toLowerCase(),
      )?.oauthAccessToken ?? undefined
    )
  }

  const activeAccountName = getActiveGithubModelsAccountName()
  if (activeAccountName) {
    const active = accounts.find(
      account => account.accountName.toLowerCase() === activeAccountName.toLowerCase(),
    )
    if (active?.oauthAccessToken) {
      return active.oauthAccessToken
    }
  }

  return accounts[0]?.oauthAccessToken
}

function resolveAuthToken(model: string, env: NodeJS.ProcessEnv): string | undefined {
  // Priority: OAuth token from secure storage > GITHUB_TOKEN env > GH_TOKEN env
  const oauthToken = resolveOauthTokenForModel(model)
  if (oauthToken) {
    return oauthToken
  }

  const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (envToken) {
    // Strip any "bearer " / "token " prefix if present
    const cleaned = envToken.replace(/^(bearer|token)\s+/i, '').trim()
    return cleaned || undefined
  }

  return undefined
}

// ---------------------------------------------------------------------------
// GitHub API fetch — single auth scheme (Bearer)
// ---------------------------------------------------------------------------

function buildGithubApiHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'OpenClaude',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function fetchGithubApiJson(
  path: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ data: unknown; headers: Headers }> {
  const response = await fetchImpl(`${GITHUB_API_BASE_URL}${path}`, {
    method: 'GET',
    headers: buildGithubApiHeaders(token),
    signal: AbortSignal.timeout(8000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error')
    const err = new Error(
      `GitHub usage error ${response.status}: ${body}`,
    ) as Error & { status?: number; body?: string }
    err.status = response.status
    err.body = body
    throw err
  }

  const data = await response.json().catch(() => ({}))
  return { data, headers: response.headers }
}

// ---------------------------------------------------------------------------
// Quota parsing — matching reference implementation
// ---------------------------------------------------------------------------

type ParsedQuotaSnapshot = {
  name: string
  entitlement?: number
  remaining?: number
  percentRemaining?: number
  unlimited: boolean
}

function parseQuotaSnapshots(payload: CopilotUsageResponse): ParsedQuotaSnapshot[] {
  const raw = payload.quota_snapshots
  if (!raw || typeof raw !== 'object') {
    return []
  }

  const snapshots: ParsedQuotaSnapshot[] = []

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue
    }

    const record = value as Record<string, unknown>
    const entitlement = asNumber(record.entitlement)
    const remaining = asNumber(record.remaining)
    let percentRemaining = asNumber(record.percent_remaining)

    if (
      percentRemaining === undefined &&
      entitlement !== undefined &&
      entitlement > 0 &&
      remaining !== undefined
    ) {
      percentRemaining = clampPercent((remaining / entitlement) * 100)
    }

    // The API returns unlimited:true for genuinely unlimited categories
    // (chat, completions) AND sometimes for categories with finite quotas
    // (premium_interactions with entitlement=300, remaining=262).
    //
    // For truly unlimited categories the API sends entitlement:0, remaining:0
    // (NOT null/undefined). So:
    //   - If unlimited:true AND entitlement > 0 → finite (has real quota)
    //   - If unlimited:true AND entitlement <= 0 or missing → truly unlimited
    //   - If unlimited:false → always finite
    const isUnlimited =
      Boolean(record.unlimited) &&
      (entitlement === undefined || entitlement <= 0)

    snapshots.push({
      name,
      entitlement,
      remaining,
      percentRemaining,
      unlimited: isUnlimited,
    })
  }

  return snapshots
}

function parseResetDateFromPayload(payload: CopilotUsageResponse): string | undefined {
  const raw =
    asString(payload.quota_reset_date_utc) ?? asString(payload.quota_reset_date)
  if (!raw) return undefined

  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  return date.toISOString()
}

function formatPlanType(payload: CopilotUsageResponse): string | undefined {
  const accessType = asString(payload.access_type_sku)
  const plan = asString(payload.copilot_plan)

  if (accessType && plan) {
    return `${accessType.replace(/_/g, ' ')} - ${plan}`
  }
  const raw = accessType ?? plan
  return raw ? raw.replace(/_/g, ' ') : undefined
}

function buildQuotaDetails(snapshots: ParsedQuotaSnapshot[]): GithubQuotaDetail[] {
  return snapshots.map(snap => {
    if (snap.unlimited) {
      return { name: snap.name, label: 'unlimited', unlimited: true }
    }
    if (snap.entitlement !== undefined && snap.remaining !== undefined) {
      const used = snap.entitlement - snap.remaining
      return {
        name: snap.name,
        label: `${used.toLocaleString()}/${snap.entitlement.toLocaleString()}`,
        unlimited: false,
      }
    }
    return { name: snap.name, label: 'unknown', unlimited: false }
  })
}

// ---------------------------------------------------------------------------
// Normalization — the core logic
// ---------------------------------------------------------------------------

function normalizeCopilotUsage(
  payload: CopilotUsageResponse,
  user: GithubUserResponse | null,
): Pick<
  GithubUsageData,
  'planType' | 'quotaDetails' | 'accountId' | 'accountUsername' | 'requests' | 'tokens' | 'allUnlimited'
> {
  const snapshots = parseQuotaSnapshots(payload)
  const resetsAt = parseResetDateFromPayload(payload)

  const accountId =
    user && user.id !== undefined && user.id !== null
      ? String(user.id)
      : undefined
  const accountUsername = asString(user?.login)
  const planType = formatPlanType(payload)
  const quotaDetails = buildQuotaDetails(snapshots)

  // If quota_snapshots is missing, empty, or has no valid entries → unlimited
  if (snapshots.length === 0) {
    return {
      planType,
      quotaDetails,
      accountId,
      accountUsername,
      requests: undefined,
      tokens: undefined,
      allUnlimited: true,
    }
  }

  // Check if ALL snapshots are unlimited
  const allUnlimited = snapshots.every(snap => snap.unlimited)
  if (allUnlimited) {
    return {
      planType,
      quotaDetails,
      accountId,
      accountUsername,
      requests: undefined,
      tokens: undefined,
      allUnlimited: true,
    }
  }

  // Mix of finite and unlimited — pick the finite snapshot with lowest percentRemaining
  const finite = snapshots.filter(snap => !snap.unlimited)
  const sorted = [...finite]
    .filter(snap => snap.percentRemaining !== undefined)
    .sort(
      (left, right) =>
        (left.percentRemaining ?? Infinity) - (right.percentRemaining ?? Infinity),
    )

  const primary = sorted[0] ?? finite[0]

  let requests: GithubUsageWindow | undefined
  if (primary) {
    const usedPercent =
      primary.percentRemaining !== undefined
        ? clampPercent(100 - primary.percentRemaining)
        : undefined

    requests = {
      limit: primary.entitlement,
      remaining: primary.remaining,
      usedPercent,
      resetsAt,
      limitReached:
        primary.percentRemaining !== undefined
          ? primary.percentRemaining <= 0
          : undefined,
    }
  }

  return {
    planType,
    quotaDetails,
    accountId,
    accountUsername,
    requests,
    tokens: undefined,
    allUnlimited: false,
  }
}

// ---------------------------------------------------------------------------
// Header fallback (kept for edge cases, but NOT primary path)
// ---------------------------------------------------------------------------

function parsePositiveNumber(raw: string | null): number | undefined {
  if (!raw) return undefined
  const value = Number.parseFloat(raw.trim())
  if (!Number.isFinite(value) || value < 0) {
    return undefined
  }
  return value
}

export function parseGithubUsageHeaders(
  headers: Headers,
  _nowMs: number = Date.now(),
): Pick<GithubUsageData, 'requests' | 'tokens'> {
  const reqLimit = parsePositiveNumber(headers.get('x-ratelimit-limit-requests'))
  const reqRemaining = parsePositiveNumber(
    headers.get('x-ratelimit-remaining-requests'),
  )
  const tokLimit = parsePositiveNumber(headers.get('x-ratelimit-limit-tokens'))
  const tokRemaining = parsePositiveNumber(
    headers.get('x-ratelimit-remaining-tokens'),
  )

  const hasReqTokens =
    reqLimit !== undefined || reqRemaining !== undefined
  const hasTokTokens =
    tokLimit !== undefined || tokRemaining !== undefined

  if (hasReqTokens || hasTokTokens) {
    return {
      requests: hasReqTokens
        ? {
            limit: reqLimit,
            remaining: reqRemaining,
            usedPercent:
              reqLimit && reqLimit > 0 && reqRemaining !== undefined
                ? clampPercent(((reqLimit - reqRemaining) / reqLimit) * 100)
                : undefined,
          }
        : undefined,
      tokens: hasTokTokens
        ? {
            limit: tokLimit,
            remaining: tokRemaining,
            usedPercent:
              tokLimit && tokLimit > 0 && tokRemaining !== undefined
                ? clampPercent(((tokLimit - tokRemaining) / tokLimit) * 100)
                : undefined,
          }
        : undefined,
    }
  }

  // Fall back to generic rate limit headers
  const genLimit = parsePositiveNumber(headers.get('x-ratelimit-limit'))
  const genRemaining = parsePositiveNumber(headers.get('x-ratelimit-remaining'))

  if (genLimit !== undefined || genRemaining !== undefined) {
    return {
      requests: {
        limit: genLimit,
        remaining: genRemaining,
        usedPercent:
          genLimit && genLimit > 0 && genRemaining !== undefined
            ? clampPercent(((genLimit - genRemaining) / genLimit) * 100)
            : undefined,
      },
    }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function hasGithubUsageQuotaData(usage: GithubUsageData): boolean {
  // allUnlimited means we have quota data (all unlimited) — it's still valid data
  if (usage.allUnlimited) {
    return true
  }

  const requests = usage.requests
  const tokens = usage.tokens

  const hasRequests =
    requests?.usedPercent !== undefined ||
    requests?.remaining !== undefined ||
    requests?.limit !== undefined
  const hasTokens =
    tokens?.usedPercent !== undefined ||
    tokens?.remaining !== undefined ||
    tokens?.limit !== undefined

  return Boolean(hasRequests || hasTokens)
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function fetchGithubUsage(
  options: FetchGithubUsageOptions = {},
): Promise<GithubUsageData> {
  const processEnv = options.processEnv ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  const model = options.model ?? processEnv.OPENAI_MODEL ?? 'github:copilot'

  const token = resolveAuthToken(model, processEnv)
  if (!token) {
    throw new Error(
      'GitHub Copilot OAuth token is required. Run /onboard-github to sign in.',
    )
  }

  // Fetch both endpoints concurrently
  const usagePromise = fetchGithubApiJson(
    '/copilot_internal/user',
    token,
    fetchImpl,
  )
  const userPromise = fetchGithubApiJson('/user', token, fetchImpl)
    .then(value => value.data as GithubUserResponse)
    .catch(() => null)

  const [usageResponse, githubUser] = await Promise.all([
    usagePromise,
    userPromise,
  ])

  const rawPayload = usageResponse.data as CopilotUsageResponse
  const normalized = normalizeCopilotUsage(rawPayload, githubUser)

  // If normalization produced quota data, use it directly — no header fallback
  // The header fallback was the old path; quota_snapshots is the correct source
  if (hasGithubUsageQuotaData({ endpoint: '', model: '', ...normalized })) {
    return {
      endpoint: GITHUB_API_BASE_URL,
      model,
      ...normalized,
      _debug: {
        rawPayload,
        tokenType: 'oauth',
      },
    }
  }

  // Last resort: header fallback (unlikely to have useful data for Copilot)
  const headerFallback = parseGithubUsageHeaders(usageResponse.headers)

  return {
    endpoint: GITHUB_API_BASE_URL,
    model,
    ...normalized,
    requests: normalized.requests ?? headerFallback.requests,
    tokens: normalized.tokens ?? headerFallback.tokens,
    _debug: {
      rawPayload,
      tokenType: 'oauth-header-fallback',
    },
  }
}
