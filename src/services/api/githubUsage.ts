import {
  getActiveGithubModelsAccountName,
  getGithubModelAccountName,
  listGithubModelsAccounts,
  resolveGithubTokenForModel,
} from '../../utils/githubModelsCredentials.js'
import { parseOpenAIDuration } from './withRetry.js'

const GITHUB_API_BASE_URL = 'https://api.github.com'

type GithubUsageHttpError = Error & {
  status?: number
  body?: string
}

type CopilotQuotaSnapshot = {
  entitlement?: number
  remaining?: number
  percentRemaining?: number
  unlimited: boolean
  name: string
}

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
}

export type GithubUsageData = {
  endpoint: string
  model: string
  planType?: string
  accountId?: string
  accountUsername?: string
  requests?: GithubUsageWindow
  tokens?: GithubUsageWindow
}

export type FetchGithubUsageOptions = {
  baseUrl?: string
  model?: string
  processEnv?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

function parsePositiveNumber(raw: string | null): number | undefined {
  if (!raw) return undefined
  const value = Number.parseFloat(raw.trim())
  if (!Number.isFinite(value) || value < 0) {
    return undefined
  }
  return value
}

function parseResetAt(raw: string | null, nowMs: number): string | undefined {
  if (!raw) return undefined
  const normalized = raw.trim()
  if (!normalized) return undefined

  const openaiDuration = parseOpenAIDuration(normalized)
  if (openaiDuration !== null) {
    return new Date(nowMs + openaiDuration).toISOString()
  }

  const numeric = Number.parseFloat(normalized)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined
  }

  if (numeric > 10_000_000) {
    return new Date(Math.round(numeric * 1000)).toISOString()
  }

  return new Date(nowMs + Math.round(numeric * 1000)).toISOString()
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function buildWindow(
  limit: number | undefined,
  remaining: number | undefined,
  resetsAt: string | undefined,
): GithubUsageWindow | undefined {
  if (limit === undefined && remaining === undefined && !resetsAt) {
    return undefined
  }

  let usedPercent: number | undefined
  if (limit !== undefined && limit > 0 && remaining !== undefined) {
    usedPercent = clampPercent(((limit - remaining) / limit) * 100)
  }

  return {
    limit,
    remaining,
    usedPercent,
    resetsAt,
  }
}

function hasWindowData(window: GithubUsageWindow | undefined): boolean {
  if (!window) return false
  return (
    window.limit !== undefined ||
    window.remaining !== undefined ||
    window.usedPercent !== undefined ||
    window.resetsAt !== undefined
  )
}

export function parseGithubUsageHeaders(
  headers: Headers,
  nowMs: number = Date.now(),
): Pick<GithubUsageData, 'requests' | 'tokens'> {
  const requestWindow = buildWindow(
    parsePositiveNumber(headers.get('x-ratelimit-limit-requests')),
    parsePositiveNumber(headers.get('x-ratelimit-remaining-requests')),
    parseResetAt(headers.get('x-ratelimit-reset-requests'), nowMs),
  )

  const tokenWindow = buildWindow(
    parsePositiveNumber(headers.get('x-ratelimit-limit-tokens')),
    parsePositiveNumber(headers.get('x-ratelimit-remaining-tokens')),
    parseResetAt(headers.get('x-ratelimit-reset-tokens'), nowMs),
  )

  if (hasWindowData(requestWindow) || hasWindowData(tokenWindow)) {
    return {
      requests: requestWindow,
      tokens: tokenWindow,
    }
  }

  return {
    requests: buildWindow(
      parsePositiveNumber(headers.get('x-ratelimit-limit')),
      parsePositiveNumber(headers.get('x-ratelimit-remaining')),
      parseResetAt(headers.get('x-ratelimit-reset'), nowMs),
    ),
  }
}

function normalizeAuthToken(raw: string): string {
  const trimmed = raw.trim()
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+/i, '').trim()
  }
  if (/^token\s+/i.test(trimmed)) {
    return trimmed.replace(/^token\s+/i, '').trim()
  }
  return trimmed
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

function isAuthFailure(error: unknown): boolean {
  const status = (error as GithubUsageHttpError | undefined)?.status
  return status === 400 || status === 401 || status === 403
}

function createHttpError(status: number, body: string): GithubUsageHttpError {
  const err = new Error(`GitHub usage error ${status}: ${body}`) as GithubUsageHttpError
  err.status = status
  err.body = body
  return err
}

function getAuthSchemesForToken(_token: string): string[] {
  // Match GitHub API style used by Copilot usage clients.
  return ['token', 'Bearer']
}

type GithubApiJsonResponse = {
  data: unknown
  headers: Headers
}

function buildGithubApiHeaders(authorization: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: authorization,
    'User-Agent': 'OpenClaude',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function fetchGithubApiJson(
  path: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GithubApiJsonResponse> {
  const schemes = getAuthSchemesForToken(token)
  let lastStatus: number | undefined
  let lastBody = 'unknown error'

  for (const scheme of schemes) {
    const response = await fetchImpl(`${GITHUB_API_BASE_URL}${path}`, {
      method: 'GET',
      headers: buildGithubApiHeaders(`${scheme} ${token}`),
      signal: AbortSignal.timeout(5000),
    })

    if (response.ok) {
      const data = await response.json().catch(() => ({}))
      return {
        data,
        headers: response.headers,
      }
    }

    lastStatus = response.status
    lastBody = await response.text().catch(() => 'unknown error')

    if (!(response.status === 400 || response.status === 401 || response.status === 403)) {
      break
    }
  }

  throw createHttpError(lastStatus ?? 500, lastBody)
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

function parseQuotaSnapshots(payload: CopilotUsageResponse): CopilotQuotaSnapshot[] {
  const raw = payload.quota_snapshots
  if (!raw || typeof raw !== 'object') {
    return []
  }

  const snapshots: CopilotQuotaSnapshot[] = []

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

    snapshots.push({
      name,
      entitlement,
      remaining,
      percentRemaining,
      unlimited: Boolean(record.unlimited),
    })
  }

  return snapshots
}

type PickedQuota = {
  snapshot: CopilotQuotaSnapshot
  unlimited: boolean
}

function pickPrimaryQuota(
  snapshots: CopilotQuotaSnapshot[],
): PickedQuota | undefined {
  // Prefer finite (non-unlimited) quotas sorted by lowest percent remaining
  const finite = snapshots.filter(snapshot => !snapshot.unlimited)
  const primary = finite
    .filter(snapshot => snapshot.percentRemaining !== undefined)
    .sort(
      (left, right) =>
        (left.percentRemaining ?? Number.POSITIVE_INFINITY) -
        (right.percentRemaining ?? Number.POSITIVE_INFINITY),
    )[0]

  if (primary) {
    return { snapshot: primary, unlimited: false }
  }

  // Fall back to any finite snapshot even without percentRemaining
  const finiteAny = finite[0]
  if (finiteAny) {
    return { snapshot: finiteAny, unlimited: false }
  }

  // All snapshots are unlimited — return the first one so we can display it
  const unlimitedFirst = snapshots[0]
  if (unlimitedFirst) {
    return { snapshot: unlimitedFirst, unlimited: true }
  }

  return undefined
}

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

function resolveAuthCandidates(model: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()

  const pushToken = (raw: string | undefined): void => {
    if (!raw) return
    const normalized = normalizeAuthToken(raw)
    if (!normalized) return
    if (seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  pushToken(resolveOauthTokenForModel(model))
  pushToken(env.GITHUB_TOKEN?.trim())
  pushToken(env.GH_TOKEN?.trim())
  pushToken(resolveGithubTokenForModel(model, env))

  return candidates
}

function formatPlanType(payload: CopilotUsageResponse): string | undefined {
  const accessType = asString(payload.access_type_sku)
  const plan = asString(payload.copilot_plan)
  if (accessType && plan) {
    return `${accessType} - ${plan}`
  }
  return accessType ?? plan
}

function normalizeCopilotUsage(
  payload: CopilotUsageResponse,
  user: GithubUserResponse | null,
): Pick<GithubUsageData, 'planType' | 'accountId' | 'accountUsername' | 'requests' | 'tokens'> {
  const snapshots = parseQuotaSnapshots(payload)
  const picked = pickPrimaryQuota(snapshots)
  const resetsAt = parseResetDateFromPayload(payload)

  let requests: GithubUsageWindow | undefined
  if (picked) {
    const { snapshot, unlimited } = picked
    if (unlimited) {
      // Plan has unlimited quota — surface it clearly with the unlimited flag
      requests = {
        limit: snapshot.entitlement,
        remaining: snapshot.remaining,
        resetsAt,
        unlimited: true,
      }
    } else {
      requests = {
        limit: snapshot.entitlement,
        remaining: snapshot.remaining,
        usedPercent:
          snapshot.percentRemaining !== undefined
            ? clampPercent(100 - snapshot.percentRemaining)
            : undefined,
        resetsAt,
      }
    }
  }

  return {
    planType: formatPlanType(payload),
    accountId:
      user && user.id !== undefined && user.id !== null
        ? String(user.id)
        : undefined,
    accountUsername: asString(user?.login),
    requests,
    tokens: undefined,
  }
}

export function hasGithubUsageQuotaData(usage: GithubUsageData): boolean {
  const requests = usage.requests
  const tokens = usage.tokens

  const hasRequests =
    requests?.unlimited === true ||
    requests?.usedPercent !== undefined ||
    requests?.remaining !== undefined ||
    requests?.limit !== undefined
  const hasTokens =
    tokens?.unlimited === true ||
    tokens?.usedPercent !== undefined ||
    tokens?.remaining !== undefined ||
    tokens?.limit !== undefined

  return Boolean(hasRequests || hasTokens)
}
export async function fetchGithubUsage(
  options: FetchGithubUsageOptions = {},
): Promise<GithubUsageData> {
  const processEnv = options.processEnv ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  const model = options.model ?? processEnv.OPENAI_MODEL ?? 'github:copilot'

  const authCandidates = resolveAuthCandidates(model, processEnv)
  if (authCandidates.length === 0) {
    throw new Error(
      'GitHub Copilot auth is required. Run /onboard-github to sign in.',
    )
  }

  let lastError: unknown
  for (const token of authCandidates) {
    try {
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

      const normalized = normalizeCopilotUsage(
        usageResponse.data as CopilotUsageResponse,
        githubUser,
      )
      const headerFallback = parseGithubUsageHeaders(usageResponse.headers)

      return {
        endpoint: GITHUB_API_BASE_URL,
        model,
        ...normalized,
        requests: normalized.requests ?? headerFallback.requests,
        tokens: normalized.tokens ?? headerFallback.tokens,
      }
    } catch (error) {
      lastError = error
      if (isAuthFailure(error)) {
        continue
      }
      throw error
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }

  throw new Error('Failed to load GitHub Copilot usage data.')
}



