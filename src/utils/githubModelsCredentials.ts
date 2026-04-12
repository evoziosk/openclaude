import { isBareMode, isEnvTruthy } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import { exchangeForCopilotToken } from '../services/github/deviceFlow.js'

/** JSON key in the shared OpenClaude secure storage blob. */
export const GITHUB_MODELS_STORAGE_KEY = 'githubModels' as const
export const GITHUB_MODELS_HYDRATED_ENV_MARKER =
  'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED' as const

const DEFAULT_GITHUB_MODELS_ACCOUNT_NAME = 'default'
const GITHUB_MODEL_ACCOUNT_QUERY_PARAM = 'account'

export type GithubModelsCredentialBlob = {
  accessToken?: string
  oauthAccessToken?: string
  activeAccountName?: string
  accounts?: GithubModelsCredentialAccount[]
}

export type GithubModelsCredentialAccount = {
  accountName: string
  accessToken: string
  oauthAccessToken?: string
}

type GithubTokenStatus = 'valid' | 'expired' | 'invalid_format'

function checkGithubTokenStatus(token: string): GithubTokenStatus {
  const expMatch = token.match(/exp=(\d+)/)
  if (expMatch) {
    const expSeconds = Number(expMatch[1])
    if (!Number.isNaN(expSeconds)) {
      return Date.now() >= expSeconds * 1000 ? 'expired' : 'valid'
    }
  }

  const parts = token.split('.')
  const looksLikeJwt =
    parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))
  if (looksLikeJwt) {
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
      const json = Buffer.from(padded, 'base64').toString('utf8')
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && parsed.exp) {
        return Date.now() >= (parsed.exp as number) * 1000 ? 'expired' : 'valid'
      }
    } catch {
      return 'invalid_format'
    }
  }

  return 'invalid_format'
}

function normalizeGithubAccountName(
  accountName: string | undefined,
  fallback = DEFAULT_GITHUB_MODELS_ACCOUNT_NAME,
): string {
  const trimmed = accountName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function findGithubAccountByName(
  accounts: GithubModelsCredentialAccount[],
  accountName: string,
): GithubModelsCredentialAccount | undefined {
  const normalized = accountName.trim().toLowerCase()
  return accounts.find(account => account.accountName.toLowerCase() === normalized)
}

function normalizeGithubCredentialBlob(
  blob: GithubModelsCredentialBlob | undefined,
): {
  accounts: GithubModelsCredentialAccount[]
  activeAccountName: string | undefined
} {
  const normalizedAccounts: GithubModelsCredentialAccount[] = []
  const seen = new Set<string>()

  const rawAccounts = Array.isArray(blob?.accounts) ? blob.accounts : []
  for (let index = 0; index < rawAccounts.length; index += 1) {
    const raw = rawAccounts[index]
    const token = raw?.accessToken?.trim()
    if (!token) {
      continue
    }

    const fallbackName =
      index === 0 ? DEFAULT_GITHUB_MODELS_ACCOUNT_NAME : `account-${index + 1}`
    const accountName = normalizeGithubAccountName(raw?.accountName, fallbackName)
    const key = accountName.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    normalizedAccounts.push({
      accountName,
      accessToken: token,
      oauthAccessToken: raw?.oauthAccessToken?.trim() || undefined,
    })
  }

  if (normalizedAccounts.length === 0) {
    const legacyToken = blob?.accessToken?.trim()
    if (legacyToken) {
      const legacyAccountName = normalizeGithubAccountName(blob?.activeAccountName)
      normalizedAccounts.push({
        accountName: legacyAccountName,
        accessToken: legacyToken,
        oauthAccessToken: blob?.oauthAccessToken?.trim() || undefined,
      })
      seen.add(legacyAccountName.toLowerCase())
    }
  }

  const requestedActive = blob?.activeAccountName?.trim()
  const activeAccountName = requestedActive
    ? findGithubAccountByName(normalizedAccounts, requestedActive)?.accountName
    : normalizedAccounts[0]?.accountName

  return {
    accounts: normalizedAccounts,
    activeAccountName,
  }
}

function buildGithubCredentialBlob(
  accounts: GithubModelsCredentialAccount[],
  activeAccountName?: string,
): GithubModelsCredentialBlob {
  const activeAccount =
    (activeAccountName && findGithubAccountByName(accounts, activeAccountName)) ||
    accounts[0]

  return {
    accessToken: activeAccount?.accessToken,
    oauthAccessToken: activeAccount?.oauthAccessToken,
    activeAccountName: activeAccount?.accountName,
    accounts,
  }
}

function splitModelQuery(model: string): { baseModel: string; params: URLSearchParams } {
  const trimmed = model.trim()
  const queryIndex = trimmed.indexOf('?')
  if (queryIndex === -1) {
    return {
      baseModel: trimmed,
      params: new URLSearchParams(),
    }
  }

  return {
    baseModel: trimmed.slice(0, queryIndex),
    params: new URLSearchParams(trimmed.slice(queryIndex + 1)),
  }
}

export function getGithubModelAccountName(model: string): string | undefined {
  const { params } = splitModelQuery(model)
  const accountName = params.get(GITHUB_MODEL_ACCOUNT_QUERY_PARAM)?.trim()
  return accountName && accountName.length > 0 ? accountName : undefined
}

export function withGithubModelAccount(model: string, accountName: string): string {
  const normalizedAccountName = accountName.trim()
  if (!normalizedAccountName) {
    return stripGithubModelAccount(model)
  }

  const { baseModel, params } = splitModelQuery(model)
  params.set(GITHUB_MODEL_ACCOUNT_QUERY_PARAM, normalizedAccountName)
  const query = params.toString()
  return query ? `${baseModel}?${query}` : baseModel
}

export function stripGithubModelAccount(model: string): string {
  const { baseModel, params } = splitModelQuery(model)
  params.delete(GITHUB_MODEL_ACCOUNT_QUERY_PARAM)
  const query = params.toString()
  return query ? `${baseModel}?${query}` : baseModel
}

export function listGithubModelsAccounts(): GithubModelsCredentialAccount[] {
  if (isBareMode()) return []
  try {
    const data = getSecureStorage().read() as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const normalized = normalizeGithubCredentialBlob(data?.githubModels)
    return normalized.accounts
  } catch {
    return []
  }
}

export async function listGithubModelsAccountsAsync(): Promise<GithubModelsCredentialAccount[]> {
  if (isBareMode()) return []
  try {
    const data = (await getSecureStorage().readAsync()) as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const normalized = normalizeGithubCredentialBlob(data?.githubModels)
    return normalized.accounts
  } catch {
    return []
  }
}

export function getActiveGithubModelsAccountName(): string | undefined {
  if (isBareMode()) return undefined
  try {
    const data = getSecureStorage().read() as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const normalized = normalizeGithubCredentialBlob(data?.githubModels)
    return normalized.activeAccountName
  } catch {
    return undefined
  }
}

export function setActiveGithubModelsAccount(
  accountName: string,
): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const normalizedRequested = accountName.trim()
  if (!normalizedRequested) {
    return { success: false, warning: 'Account name is empty.' }
  }

  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() || {}
  const prevBlob = (prev as Record<string, unknown>)[
    GITHUB_MODELS_STORAGE_KEY
  ] as GithubModelsCredentialBlob | undefined
  const normalized = normalizeGithubCredentialBlob(prevBlob)
  const selectedAccount = findGithubAccountByName(
    normalized.accounts,
    normalizedRequested,
  )

  if (!selectedAccount) {
    return {
      success: false,
      warning: `GitHub account '${normalizedRequested}' was not found.`,
    }
  }

  const merged = {
    ...(prev as Record<string, unknown>),
    [GITHUB_MODELS_STORAGE_KEY]: buildGithubCredentialBlob(
      normalized.accounts,
      selectedAccount.accountName,
    ),
  }
  return secureStorage.update(merged as typeof prev)
}

function resolveStoredGithubToken(accountName?: string): string | undefined {
  const accounts = listGithubModelsAccounts()
  if (accounts.length === 0) {
    return undefined
  }

  if (accountName) {
    return findGithubAccountByName(accounts, accountName)?.accessToken
  }

  const activeAccountName = getActiveGithubModelsAccountName()
  if (activeAccountName) {
    return findGithubAccountByName(accounts, activeAccountName)?.accessToken
  }

  return accounts[0]?.accessToken
}

export function resolveGithubTokenForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const requestedAccount = getGithubModelAccountName(model)
  if (requestedAccount) {
    return resolveStoredGithubToken(requestedAccount)
  }

  const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (envToken) {
    return envToken
  }

  return resolveStoredGithubToken()
}

export function readGithubModelsToken(accountName?: string): string | undefined {
  if (isBareMode()) return undefined
  return resolveStoredGithubToken(accountName)
}

export async function readGithubModelsTokenAsync(
  accountName?: string,
): Promise<string | undefined> {
  if (isBareMode()) return undefined
  try {
    const data = (await getSecureStorage().readAsync()) as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const normalized = normalizeGithubCredentialBlob(data?.githubModels)
    if (accountName) {
      return findGithubAccountByName(normalized.accounts, accountName)?.accessToken
    }

    const active =
      (normalized.activeAccountName &&
        findGithubAccountByName(
          normalized.accounts,
          normalized.activeAccountName,
        )) ||
      normalized.accounts[0]

    return active?.accessToken
  } catch {
    return undefined
  }
}

/**
 * If GitHub Models mode is on and no token is in the environment, copy the
 * stored token into process.env so the OpenAI shim and validation see it.
 */
export function hydrateGithubModelsTokenFromSecureStorage(): void {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }
  if (process.env.GH_TOKEN?.trim()) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }
  if (process.env.GITHUB_TOKEN?.trim()) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }
  if (isBareMode()) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }

  const t = readGithubModelsToken()
  if (t) {
    process.env.GITHUB_TOKEN = t
    process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER] = '1'
    return
  }

  delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
}

/**
 * Startup auto-refresh for GitHub Models mode.
 *
 * If a stored Copilot token is expired/invalid and an OAuth token is present,
 * exchange the OAuth token for a fresh Copilot token and persist it.
 */
export async function refreshGithubModelsTokenIfNeeded(): Promise<boolean> {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)) {
    return false
  }
  if (isBareMode()) {
    return false
  }

  try {
    const secureStorage = getSecureStorage()
    const data = secureStorage.read() as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const normalized = normalizeGithubCredentialBlob(data?.githubModels)

    if (normalized.accounts.length === 0) {
      return false
    }

    let refreshedAny = false
    const nextAccounts: GithubModelsCredentialAccount[] = []

    for (const account of normalized.accounts) {
      const status = checkGithubTokenStatus(account.accessToken)
      if (status === 'valid') {
        nextAccounts.push(account)
        continue
      }

      const oauthToken = account.oauthAccessToken?.trim() || ''
      if (!oauthToken) {
        nextAccounts.push(account)
        continue
      }

      const refreshed = await exchangeForCopilotToken(oauthToken)
      nextAccounts.push({
        accountName: account.accountName,
        accessToken: refreshed.token,
        oauthAccessToken: oauthToken,
      })
      refreshedAny = true
    }

    if (refreshedAny) {
      const merged = {
        ...(data as Record<string, unknown>),
        [GITHUB_MODELS_STORAGE_KEY]: buildGithubCredentialBlob(
          nextAccounts,
          normalized.activeAccountName,
        ),
      }
      const saved = secureStorage.update(merged as typeof data)
      if (!saved.success) {
        return false
      }
    }

    if (!process.env.GITHUB_TOKEN?.trim() && !process.env.GH_TOKEN?.trim()) {
      const activeAccountName =
        normalized.activeAccountName ?? nextAccounts[0]?.accountName
      const activeAccount =
        (activeAccountName &&
          findGithubAccountByName(nextAccounts, activeAccountName)) ||
        nextAccounts[0]
      if (activeAccount?.accessToken) {
        process.env.GITHUB_TOKEN = activeAccount.accessToken
      }
    }

    return refreshedAny
  } catch {
    return false
  }
}

export function saveGithubModelsToken(
  token: string,
  oauthToken?: string,
  accountName?: string,
): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const trimmed = token.trim()
  if (!trimmed) {
    return { success: false, warning: 'Token is empty.' }
  }

  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() || {}
  const prevGithubModels = (prev as Record<string, unknown>)[
    GITHUB_MODELS_STORAGE_KEY
  ] as GithubModelsCredentialBlob | undefined
  const normalized = normalizeGithubCredentialBlob(prevGithubModels)
  const targetAccountName = normalizeGithubAccountName(
    accountName,
    normalized.activeAccountName ?? DEFAULT_GITHUB_MODELS_ACCOUNT_NAME,
  )

  const oauthTrimmed = oauthToken?.trim()
  const existing = findGithubAccountByName(normalized.accounts, targetAccountName)

  const nextAccounts = normalized.accounts.filter(
    account => account.accountName.toLowerCase() !== targetAccountName.toLowerCase(),
  )
  nextAccounts.push({
    accountName: existing?.accountName ?? targetAccountName,
    accessToken: trimmed,
    oauthAccessToken: oauthTrimmed || existing?.oauthAccessToken?.trim() || undefined,
  })

  const merged = {
    ...(prev as Record<string, unknown>),
    [GITHUB_MODELS_STORAGE_KEY]: buildGithubCredentialBlob(
      nextAccounts,
      existing?.accountName ?? targetAccountName,
    ),
  }
  return secureStorage.update(merged as typeof prev)
}

export function clearGithubModelsToken(): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: true }
  }

  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() || {}
  const next = { ...(prev as Record<string, unknown>) }
  delete next[GITHUB_MODELS_STORAGE_KEY]
  return secureStorage.update(next as typeof prev)
}
