import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'

import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js'
import { formatCost } from 'src/cost-tracker.js'
import { getSubscriptionType } from 'src/utils/auth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type GithubUsageData,
  type GithubUsageSnapshot,
  fetchGithubUsage,
  type GithubUsageWindow,
} from '../../services/api/githubUsage.js'
import {
  GITHUB_COPILOT_BASE_URL,
  shouldUseCodexTransport,
} from '../../services/api/providerConfig.js'
import {
  type ExtraUsage,
  fetchUtilization,
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import { formatResetText } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import {
  getOpenAIContextWindow,
  getOpenAIMaxOutputTokens,
} from '../../utils/model/openaiContextWindows.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import {
  getProviderProfiles,
} from '../../utils/providerProfiles.js'
import type { ProviderProfile } from '../../utils/config.js'
import {
  listGithubModelsAccounts,
  withGithubModelAccount,
} from '../../utils/githubModelsCredentials.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { ProgressBar } from '../design-system/ProgressBar.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import {
  isEligibleForOverageCreditGrant,
  OverageCreditUpsell,
} from '../LogoV2/OverageCreditUpsell.js'
import { CodexUsage } from './CodexUsage.js'

type LimitBarProps = {
  title: string
  limit: RateLimit
  maxWidth: number
  showTimeInReset?: boolean
  extraSubtext?: string
}

function LimitBar({
  title,
  limit,
  maxWidth,
  showTimeInReset = true,
  extraSubtext,
}: LimitBarProps): React.ReactNode {
  const { utilization, resets_at: resetsAt } = limit
  if (utilization === null) {
    return null
  }

  const usedText = `${Math.floor(utilization)}% used`
  let subtext = resetsAt
    ? `Resets ${formatResetText(resetsAt, true, showTimeInReset)}`
    : undefined

  if (extraSubtext) {
    subtext = subtext ? `${extraSubtext} - ${subtext}` : extraSubtext
  }

  if (maxWidth >= 62) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={utilization / 100}
            width={50}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          <Text>{usedText}</Text>
        </Box>
        {subtext ? <Text dimColor>{subtext}</Text> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{title}</Text>
        {subtext ? (
          <>
            <Text> </Text>
            <Text dimColor>- {subtext}</Text>
          </>
        ) : null}
      </Text>
      <ProgressBar
        ratio={utilization / 100}
        width={maxWidth}
        fillColor="rate_limit_fill"
        emptyColor="rate_limit_empty"
      />
      <Text>{usedText}</Text>
    </Box>
  )
}

type AnthropicUsageProps = {
  subtitle?: string
}

function AnthropicUsage({ subtitle }: AnthropicUsageProps): React.ReactNode {
  const [utilization, setUtilization] = useState<Utilization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { columns } = useTerminalSize()
  const maxWidth = Math.min(columns - 2, 80)

  const loadUtilization = React.useCallback(async () => {
    setError(null)
    try {
      const data = await fetchUtilization()
      setUtilization(data)
    } catch (err) {
      logError(err as Error)
      const axiosError = err as { response?: { data?: unknown } }
      const responseBody = axiosError.response?.data
        ? jsonStringify(axiosError.response.data)
        : undefined
      setError(
        responseBody
          ? `Failed to load usage data: ${responseBody}`
          : 'Failed to load usage data',
      )
    }
  }, [])

  useEffect(() => {
    void loadUtilization()
  }, [loadUtilization])

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization()
    },
    {
      context: 'Settings',
      isActive: !!error,
    },
  )

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="Esc"
              description="cancel"
            />
          </Byline>
        </Text>
      </Box>
    )
  }

  if (!utilization) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Loading usage data...</Text>
        <Text dimColor>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="cancel"
          />
        </Text>
      </Box>
    )
  }

  const subscriptionType = getSubscriptionType()
  const showSonnetBar =
    subscriptionType === 'max' ||
    subscriptionType === 'team' ||
    subscriptionType === null

  const limits = [
    {
      title: 'Current session',
      limit: utilization.five_hour,
    },
    {
      title: 'Current week (all models)',
      limit: utilization.seven_day,
    },
    ...(showSonnetBar
      ? [
          {
            title: 'Current week (Sonnet only)',
            limit: utilization.seven_day_sonnet,
          },
        ]
      : []),
  ]

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      {limits.some(({ limit }) => limit) ? null : (
        <Text dimColor>/usage is only available for subscription plans.</Text>
      )}

      {limits.map(({ title, limit }) =>
        limit ? (
          <LimitBar key={title} title={title} limit={limit} maxWidth={maxWidth} />
        ) : null,
      )}

      {utilization.extra_usage ? (
        <ExtraUsageSection
          extraUsage={utilization.extra_usage}
          maxWidth={maxWidth}
        />
      ) : null}

      {isEligibleForOverageCreditGrant() ? (
        <OverageCreditUpsell maxWidth={maxWidth} />
      ) : null}

      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}

const EXTRA_USAGE_SECTION_TITLE = 'Extra usage'

type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage
  maxWidth: number
}

function ExtraUsageSection({
  extraUsage,
  maxWidth,
}: ExtraUsageSectionProps): React.ReactNode {
  const subscriptionType = getSubscriptionType()
  const isProOrMax = subscriptionType === 'pro' || subscriptionType === 'max'
  if (!isProOrMax) {
    return null
  }

  if (!extraUsage.is_enabled) {
    if (!extraUsageCommand.isEnabled()) {
      return null
    }

    return (
      <Box flexDirection="column">
        <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor>Extra usage not enabled - /extra-usage to enable</Text>
      </Box>
    )
  }

  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor>Unlimited</Text>
      </Box>
    )
  }

  if (
    typeof extraUsage.used_credits !== 'number' ||
    typeof extraUsage.utilization !== 'number'
  ) {
    return null
  }

  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2)
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2)
  const now = new Date()
  const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  return (
    <LimitBar
      title={EXTRA_USAGE_SECTION_TITLE}
      limit={{
        utilization: extraUsage.utilization,
        resets_at: oneMonthReset.toISOString(),
      }}
      showTimeInReset={false}
      extraSubtext={`${formattedUsedCredits} / ${formattedMonthlyLimit} spent`}
      maxWidth={maxWidth}
    />
  )
}

type ProviderUsageKind = 'anthropic' | 'codex' | 'github' | 'unsupported'

type ProviderUsageTabSpec = {
  id: string
  title: string
  kind: ProviderUsageKind
  model?: string
  baseUrl?: string
}

function isCodexProfile(profile: ProviderProfile): boolean {
  return shouldUseCodexTransport(profile.model, profile.baseUrl)
}

function isGithubProfile(profile: ProviderProfile): boolean {
  const model = profile.model.trim().toLowerCase()
  const baseUrl = profile.baseUrl.trim().toLowerCase()
  return (
    model.startsWith('github:') ||
    baseUrl.includes('api.githubcopilot.com') ||
    baseUrl.includes('models.github.ai') ||
    baseUrl.endsWith('.github.ai/inference')
  )
}

function buildProviderUsageTabs(): ProviderUsageTabSpec[] {
  const currentProvider = getAPIProvider()
  const tabs: ProviderUsageTabSpec[] = [
    {
      id: 'current',
      title: 'Current',
      kind:
        currentProvider === 'firstParty'
          ? 'anthropic'
          : currentProvider === 'codex'
            ? 'codex'
            : currentProvider === 'github'
              ? 'github'
              : 'unsupported',
      model: process.env.OPENAI_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE,
    },
  ]

  for (const profile of getProviderProfiles()) {
    tabs.push({
      id: `profile:${profile.id}`,
      title: profile.name,
      kind:
        profile.provider === 'anthropic'
          ? 'anthropic'
          : isCodexProfile(profile)
            ? 'codex'
            : isGithubProfile(profile)
              ? 'github'
              : 'unsupported',
      model: profile.model,
      baseUrl: profile.baseUrl,
    })
  }

  return tabs
}

function GithubUsageBar({
  title,
  window,
  maxWidth,
}: {
  title: string
  window: GithubUsageWindow
  maxWidth: number
}): React.ReactNode {
  // Unlimited plan — show clearly, with optional reset date
  if (window.unlimited) {
    const subtext = window.resetsAt
      ? `Resets ${formatResetText(window.resetsAt, true, true)}`
      : undefined
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text color="green">Unlimited</Text>
        {subtext ? <Text dimColor>{subtext}</Text> : null}
      </Box>
    )
  }

  const usedPercent = window.usedPercent
  if (usedPercent === undefined) {
    const remainingText =
      window.remaining !== undefined && window.limit !== undefined
        ? `${window.remaining.toLocaleString()} / ${window.limit.toLocaleString()} remaining`
        : window.remaining !== undefined
          ? `${window.remaining.toLocaleString()} remaining`
          : window.limit !== undefined
            ? `Limit: ${window.limit.toLocaleString()}`
            : 'Remaining usage unavailable'

    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <ProgressBar
          ratio={0}
          width={Math.min(50, maxWidth)}
          fillColor="rate_limit_fill"
          emptyColor="rate_limit_empty"
        />
        <Text dimColor>{remainingText}</Text>
      </Box>
    )
  }

  const normalized = Math.max(0, Math.min(100, usedPercent))
  const usedText = `${Math.floor(normalized)}% used`
  const limitReached = window.limitReached
  const remainingText =
    window.remaining !== undefined
      ? `${window.remaining.toLocaleString()} remaining`
      : undefined
  const subtext =
    window.resetsAt && remainingText
      ? `${remainingText} - Resets ${formatResetText(window.resetsAt, true, true)}`
      : window.resetsAt
        ? `Resets ${formatResetText(window.resetsAt, true, true)}`
        : remainingText

  if (maxWidth >= 62) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={normalized / 100}
            width={50}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          <Text color={limitReached ? 'red' : undefined}>{usedText}</Text>
        </Box>
        {subtext ? <Text dimColor>{subtext}</Text> : null}
        {limitReached ? <Text color="red">Limit reached!</Text> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{title}</Text>
        {subtext ? (
          <>
            <Text> </Text>
            <Text dimColor>- {subtext}</Text>
          </>
        ) : null}
      </Text>
      <ProgressBar
        ratio={normalized / 100}
        width={maxWidth}
        fillColor="rate_limit_fill"
        emptyColor="rate_limit_empty"
      />
      <Text color={limitReached ? 'red' : undefined}>{usedText}</Text>
      {limitReached ? <Text color="red">Limit reached!</Text> : null}
    </Box>
  )
}

/**
 * Renders a single GitHub quota snapshot as a labeled bar (or "Unlimited" text).
 *
 * Follows the same pattern as CodexUsageLimitBar: receives `usedPercent` (0-100,
 * percentage USED — NOT remaining), renders ProgressBar with ratio = usedPercent / 100.
 */
function GithubSnapshotBar({
  snapshot,
  maxWidth,
}: {
  snapshot: GithubUsageSnapshot
  maxWidth: number
}): React.ReactNode {
  // Capitalize first letter: "premium_requests" → "Premium_requests"
  const displayName =
    snapshot.name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

  // ── Truly unlimited? ──────────────────────────────────────────────────
  // The GitHub API sends unlimited:true on ALL snapshots, even ones with
  // finite entitlement/remaining. Treat as unlimited ONLY when there are
  // no finite values.
  const isReallyUnlimited =
    snapshot.unlimited &&
    (snapshot.entitlement === undefined || snapshot.entitlement <= 0) &&
    snapshot.remaining === undefined

  if (isReallyUnlimited) {
    return (
      <Box flexDirection="column">
        <Text bold>{displayName}</Text>
        <Text color="green">Unlimited</Text>
      </Box>
    )
  }

  // ── Compute usedPercent (0-100, percentage USED) ──────────────────────
  // Priority: service-provided usedPercent > derive from entitlement/remaining
  let usedPercent = snapshot.usedPercent
  if (
    usedPercent === undefined &&
    snapshot.entitlement !== undefined &&
    snapshot.entitlement > 0 &&
    snapshot.remaining !== undefined
  ) {
    usedPercent =
      ((snapshot.entitlement - snapshot.remaining) / snapshot.entitlement) * 100
  }

  // Clamp to [0, 100]
  const normalized =
    usedPercent !== undefined ? Math.max(0, Math.min(100, usedPercent)) : 0

  const usedText =
    usedPercent !== undefined ? `${Math.floor(normalized)}% used` : undefined
  const limitReached =
    snapshot.percentRemaining !== undefined && snapshot.percentRemaining <= 0

  // Build subtext (remaining count + reset)
  const remainingText =
    snapshot.remaining !== undefined && snapshot.entitlement !== undefined
      ? `${snapshot.remaining.toLocaleString()} / ${snapshot.entitlement.toLocaleString()} remaining`
      : snapshot.remaining !== undefined
        ? `${snapshot.remaining.toLocaleString()} remaining`
        : undefined

  // ── Wide layout (≥62 cols) ────────────────────────────────────────────
  if (maxWidth >= 62) {
    return (
      <Box flexDirection="column">
        <Text bold>{displayName}</Text>
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={normalized / 100}
            width={50}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          {usedText ? (
            <Text color={limitReached ? 'red' : undefined}>{usedText}</Text>
          ) : null}
        </Box>
        {remainingText ? <Text dimColor>{remainingText}</Text> : null}
        {limitReached ? <Text color="red">Limit reached!</Text> : null}
      </Box>
    )
  }

  // ── Narrow layout ─────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      <Text bold>{displayName}</Text>
      <ProgressBar
        ratio={normalized / 100}
        width={maxWidth}
        fillColor="rate_limit_fill"
        emptyColor="rate_limit_empty"
      />
      {usedText ? (
        <Text color={limitReached ? 'red' : undefined}>{usedText}</Text>
      ) : null}
      {remainingText ? <Text dimColor>{remainingText}</Text> : null}
      {limitReached ? <Text color="red">Limit reached!</Text> : null}
    </Box>
  )
}

type GithubAccountUsageResult = {
  accountName: string
  usage?: GithubUsageData
  error?: string
}

/**
 * Container for all GitHub usage bars for a single account.
 *
 * Renders metadata (account, plan, endpoint, model) followed by one bar
 * per quota snapshot.  Uses a proper <Box> container — NOT a Fragment —
 * to ensure Ink's layout engine measures children correctly.
 */
function GithubUsageBars({
  usage,
  maxWidth,
}: {
  usage: GithubUsageData
  maxWidth: number
}): React.ReactNode {
  // planType may contain newlines from formatPlanType — only show the first line
  const planLine = usage.planType?.split('\n')[0]

  // Per-snapshot bars (preferred — gives one bar per quota category)
  const snapshots = usage.quotaSnapshots
  const hasSnapshots = snapshots !== undefined && snapshots.length > 0

  // Reset date (shown once, not per-snapshot)
  const resetsAt = usage.requests?.resetsAt

  return (
    <Box flexDirection="column" gap={1}>
      {usage.accountUsername ? (
        <Text dimColor>
          Account: @{usage.accountUsername}
          {usage.accountId ? ` (${usage.accountId})` : ''}
        </Text>
      ) : null}
      {planLine ? <Text dimColor>Plan: {planLine}</Text> : null}
      <Text dimColor>Endpoint: {usage.endpoint}</Text>
      <Text dimColor>Model: {usage.model}</Text>

      {hasSnapshots
        ? snapshots.map(snap => (
            <GithubSnapshotBar
              key={`snap-${snap.name}`}
              snapshot={snap}
              maxWidth={maxWidth}
            />
          ))
        : null}

      {!hasSnapshots && usage.requests ? (
        <GithubUsageBar
          key="requests"
          title="Requests"
          window={usage.requests}
          maxWidth={maxWidth}
        />
      ) : null}

      {!hasSnapshots && usage.tokens ? (
        <GithubUsageBar
          key="tokens"
          title="Tokens"
          window={usage.tokens}
          maxWidth={maxWidth}
        />
      ) : null}

      {!hasSnapshots && !usage.requests && !usage.tokens ? (
        <Text dimColor>No usage quota data is available for this account.</Text>
      ) : null}

      {resetsAt ? (
        <Text dimColor>
          Resets {formatResetText(resetsAt, true, true)}
        </Text>
      ) : null}
    </Box>
  )
}

function GithubUsage({
  baseUrl,
  model,
  subtitle,
}: {
  baseUrl?: string
  model?: string
  subtitle?: string
}): React.ReactNode {
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [accountResults, setAccountResults] = useState<
    GithubAccountUsageResult[] | null
  >(null)
  const { columns } = useTerminalSize()
  const maxWidth = Math.min(columns - 2, 80)

  const loadUsage = React.useCallback(async () => {
    setFatalError(null)
    setAccountResults(null)

    try {
      const fallbackModel = model ?? 'github:copilot'
      const accountNames = listGithubModelsAccounts().map(
        account => account.accountName,
      )

      if (accountNames.length > 1) {
        const envWithoutDirectGithubToken: NodeJS.ProcessEnv = {
          ...process.env,
        }
        delete envWithoutDirectGithubToken.GITHUB_TOKEN
        delete envWithoutDirectGithubToken.GH_TOKEN

        const results = await Promise.all(
          accountNames.map(async accountName => {
            try {
              const accountModel = withGithubModelAccount(
                fallbackModel,
                accountName,
              )
              const usage = await fetchGithubUsage({
                baseUrl: baseUrl ?? GITHUB_COPILOT_BASE_URL,
                model: accountModel,
                processEnv: envWithoutDirectGithubToken,
              })
              return { accountName, usage }
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : 'Failed to load GitHub usage'
              return { accountName, error: message }
            }
          }),
        )

        setAccountResults(results)
        return
      }

      const usage = await fetchGithubUsage({
        baseUrl: baseUrl ?? GITHUB_COPILOT_BASE_URL,
        model: fallbackModel,
      })
      setAccountResults([
        {
          accountName: accountNames[0] ?? 'default',
          usage,
        },
      ])
    } catch (err) {
      logError(err as Error)
      setFatalError(
        err instanceof Error ? err.message : 'Failed to load GitHub usage',
      )
    }
  }, [baseUrl, model])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  useKeybinding(
    'settings:retry',
    () => {
      void loadUsage()
    },
    {
      context: 'Settings',
      isActive:
        !!fatalError ||
        !!accountResults?.some(result => result.error !== undefined),
    },
  )

  if (fatalError) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {fatalError}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="Esc"
              description="cancel"
            />
          </Byline>
        </Text>
      </Box>
    )
  }

  if (!accountResults) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Loading GitHub Copilot usage data...</Text>
        <Text dimColor>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="cancel"
          />
        </Text>
      </Box>
    )
  }

  const hasMultipleAccounts = accountResults.length > 1

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}

      {accountResults.map(result => {
        const usage = result.usage

        return (
          <Box
            key={result.accountName}
            flexDirection="column"
            gap={1}
            borderStyle={hasMultipleAccounts ? 'round' : undefined}
            borderColor={hasMultipleAccounts ? 'inactive' : undefined}
            paddingX={hasMultipleAccounts ? 1 : 0}
          >
            <Text bold>
              {hasMultipleAccounts
                ? `[${result.accountName}]`
                : 'GitHub Copilot'}
            </Text>

            {result.error ? <Text color="error">Error: {result.error}</Text> : null}

            {usage ? (
              <GithubUsageBars usage={usage} maxWidth={maxWidth} />
            ) : null}
          </Box>
        )
      })}

      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}
function UnsupportedUsagePanel({
  title,
  model,
  baseUrl,
}: {
  title: string
  model?: string
  baseUrl?: string
}): React.ReactNode {
  const contextWindow = model ? getOpenAIContextWindow(model) : undefined
  const maxOutput = model ? getOpenAIMaxOutputTokens(model) : undefined

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      {model ? <Text dimColor>Model: {model}</Text> : null}
      {baseUrl ? <Text dimColor>Endpoint: {baseUrl}</Text> : null}
      {contextWindow || maxOutput ? (
        <Text dimColor>
          Model limits:{' '}
          {contextWindow !== undefined
            ? `${contextWindow.toLocaleString()} context`
            : 'unknown context'}
          {maxOutput !== undefined
            ? ` - ${maxOutput.toLocaleString()} max output`
            : ''}
        </Text>
      ) : null}
      <Text dimColor>
        Remaining usage is not available for this provider in OpenClaude yet.
      </Text>
      <Text dimColor>
        Currently supported: Anthropic subscription usage, Codex usage, and
        GitHub Copilot rate limit headers.
      </Text>
      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}

function renderUsageTabContent(tab: ProviderUsageTabSpec): React.ReactNode {
  if (tab.kind === 'anthropic') {
    return (
      <AnthropicUsage
        subtitle={tab.id === 'current' ? undefined : `Profile: ${tab.title}`}
      />
    )
  }

  if (tab.kind === 'codex') {
    return (
      <CodexUsage
        baseUrl={tab.baseUrl}
        model={tab.model}
        subtitle={tab.id === 'current' ? undefined : `Profile: ${tab.title}`}
      />
    )
  }

  if (tab.kind === 'github') {
    return (
      <GithubUsage
        baseUrl={tab.baseUrl}
        model={tab.model}
        subtitle={tab.id === 'current' ? undefined : `Profile: ${tab.title}`}
      />
    )
  }

  return (
    <UnsupportedUsagePanel
      title={
        tab.id === 'current' ? 'Current provider usage' : `Profile: ${tab.title}`
      }
      model={tab.model}
      baseUrl={tab.baseUrl}
    />
  )
}

export function Usage(): React.ReactNode {
  const tabs = useMemo(() => buildProviderUsageTabs(), [])
  const [selectedTab, setSelectedTab] = useState(tabs[0]?.id ?? 'current')

  useEffect(() => {
    if (!tabs.some(tab => tab.id === selectedTab)) {
      setSelectedTab(tabs[0]?.id ?? 'current')
    }
  }, [selectedTab, tabs])

  if (tabs.length <= 1) {
    return renderUsageTabContent(
      tabs[0] ?? { id: 'current', title: 'Current', kind: 'unsupported' },
    )
  }

  return (
    <Tabs selectedTab={selectedTab} onTabChange={setSelectedTab} title="Providers">
      {tabs.map(tab => (
        <Tab key={tab.id} id={tab.id} title={tab.title}>
          {renderUsageTabContent(tab)}
        </Tab>
      ))}
    </Tabs>
  )
}















