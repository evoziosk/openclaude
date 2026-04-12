import * as React from 'react'
import { useCallback, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import {
  exchangeForCopilotToken,
  openVerificationUri,
  pollAccessToken,
  requestDeviceCode,
} from '../../services/github/deviceFlow.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  hydrateGithubModelsTokenFromSecureStorage,
  listGithubModelsAccounts,
  readGithubModelsToken,
  saveGithubModelsToken,
  withGithubModelAccount,
} from '../../utils/githubModelsCredentials.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

const DEFAULT_MODEL = 'github:copilot'
const FORCE_RELOGIN_ARGS = new Set([
  'force',
  '--force',
  'relogin',
  '--relogin',
  'reauth',
  '--reauth',
])

type Step = 'menu' | 'enter-account-name' | 'device-busy' | 'error'

const PROVIDER_SPECIFIC_KEYS = new Set([
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_AUTH_MODE',
])

export function shouldForceGithubRelogin(args?: string): boolean {
  const normalized = (args ?? '').trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return normalized.split(/\s+/).some(arg => FORCE_RELOGIN_ARGS.has(arg))
}

const GITHUB_PAT_PREFIXES = ['ghp_', 'gho_', 'ghs_', 'ghr_', 'github_pat_']

function isGithubPat(token: string): boolean {
  return GITHUB_PAT_PREFIXES.some(prefix => token.startsWith(prefix))
}

export function hasExistingGithubModelsLoginToken(
  env: NodeJS.ProcessEnv = process.env,
  storedToken?: string,
): boolean {
  const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (envToken) {
    if (isGithubPat(envToken)) {
      return false
    }
    return true
  }
  const persisted = (storedToken ?? readGithubModelsToken())?.trim()
  if (persisted && isGithubPat(persisted)) {
    return false
  }
  return Boolean(persisted)
}

export function buildGithubOnboardingSettingsEnv(
  model: string,
): Record<string, string | undefined> {
  return {
    CLAUDE_CODE_USE_GITHUB: '1',
    OPENAI_MODEL: model,
    OPENAI_API_KEY: undefined,
    OPENAI_ORG: undefined,
    OPENAI_PROJECT: undefined,
    OPENAI_ORGANIZATION: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_BASE: undefined,
    CLAUDE_CODE_USE_OPENAI: undefined,
    CLAUDE_CODE_USE_GEMINI: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  }
}

export function applyGithubOnboardingProcessEnv(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.CLAUDE_CODE_USE_GITHUB = '1'
  env.OPENAI_MODEL = model

  delete env.OPENAI_API_KEY
  delete env.OPENAI_ORG
  delete env.OPENAI_PROJECT
  delete env.OPENAI_ORGANIZATION
  delete env.OPENAI_BASE_URL
  delete env.OPENAI_API_BASE

  delete env.CLAUDE_CODE_USE_OPENAI
  delete env.CLAUDE_CODE_USE_GEMINI
  delete env.CLAUDE_CODE_USE_BEDROCK
  delete env.CLAUDE_CODE_USE_VERTEX
  delete env.CLAUDE_CODE_USE_FOUNDRY
  delete env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
}

function mergeUserSettingsEnv(model: string): { ok: boolean; detail?: string } {
  const currentSettings = getSettingsForSource('userSettings')
  const currentEnv = currentSettings?.env ?? {}

  const newEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(currentEnv)) {
    if (!PROVIDER_SPECIFIC_KEYS.has(key)) {
      newEnv[key] = value
    }
  }

  newEnv.CLAUDE_CODE_USE_GITHUB = '1'
  newEnv.OPENAI_MODEL = model

  const { error } = updateSettingsForSource('userSettings', {
    env: newEnv,
  })
  if (error) {
    return { ok: false, detail: error.message }
  }
  return { ok: true }
}

export function activateGithubOnboardingMode(
  model: string = DEFAULT_MODEL,
  options?: {
    mergeSettingsEnv?: (model: string) => { ok: boolean; detail?: string }
    applyProcessEnv?: (model: string) => void
    hydrateToken?: () => void
    onChangeAPIKey?: () => void
  },
): { ok: boolean; detail?: string } {
  const normalizedModel = model.trim() || DEFAULT_MODEL
  const mergeSettingsEnv = options?.mergeSettingsEnv ?? mergeUserSettingsEnv
  const applyProcessEnv = options?.applyProcessEnv ?? applyGithubOnboardingProcessEnv
  const hydrateToken =
    options?.hydrateToken ?? hydrateGithubModelsTokenFromSecureStorage

  const merged = mergeSettingsEnv(normalizedModel)
  if (!merged.ok) {
    return merged
  }

  applyProcessEnv(normalizedModel)
  hydrateToken()
  options?.onChangeAPIKey?.()
  return { ok: true }
}

function getCurrentGithubModelSetting(): string {
  if (process.env.CLAUDE_CODE_USE_GITHUB?.trim()) {
    return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL
  }
  return DEFAULT_MODEL
}

function OnboardGithub(props: {
  onDone: Parameters<LocalJSXCommandCall>[0]
  onChangeAPIKey: () => void
  hasExistingLogin: boolean
}): React.ReactNode {
  const { onDone, onChangeAPIKey, hasExistingLogin } = props
  const { columns } = useTerminalSize()
  const [step, setStep] = useState<Step>('menu')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [deviceHint, setDeviceHint] = useState<{
    user_code: string
    verification_uri: string
  } | null>(null)
  const [accountNameInput, setAccountNameInput] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [pendingAccountName, setPendingAccountName] = useState<string | undefined>()

  const finalize = useCallback(
    async (
      token: string,
      model: string = DEFAULT_MODEL,
      oauthToken?: string,
      accountName?: string,
    ) => {
      const normalizedAccountName = accountName?.trim() || undefined
      const modelForAccount = normalizedAccountName
        ? withGithubModelAccount(model, normalizedAccountName)
        : model

      const saved = saveGithubModelsToken(
        token,
        oauthToken,
        normalizedAccountName,
      )
      if (!saved.success) {
        setErrorMsg(saved.warning ?? 'Could not save token to secure storage.')
        setStep('error')
        return
      }

      const activated = activateGithubOnboardingMode(modelForAccount, {
        onChangeAPIKey,
      })
      if (!activated.ok) {
        setErrorMsg(
          `Token saved, but settings were not updated: ${activated.detail ?? 'unknown error'}. ` +
            `Add env CLAUDE_CODE_USE_GITHUB=1 and OPENAI_MODEL to ~/.claude/settings.json manually.`,
        )
        setStep('error')
        return
      }

      for (const key of PROVIDER_SPECIFIC_KEYS) {
        delete process.env[key]
      }
      process.env.CLAUDE_CODE_USE_GITHUB = '1'
      process.env.OPENAI_MODEL = modelForAccount.trim() || DEFAULT_MODEL
      hydrateGithubModelsTokenFromSecureStorage()
      onChangeAPIKey()

      const accountMessage = normalizedAccountName
        ? `Account '${normalizedAccountName}' connected.`
        : 'Account connected.'

      onDone(
        `GitHub Copilot onboard complete. ${accountMessage} Copilot token and OAuth token stored in secure storage (Windows/Linux: ~/.claude/.credentials.json, macOS: Keychain fallback to ~/.claude/.credentials.json); user settings updated. Restart if the model does not switch.`,
        { display: 'user' },
      )
    },
    [onChangeAPIKey, onDone],
  )

  const runDeviceFlow = useCallback(
    async (accountName?: string, requireAccountName = false) => {
      const existingAccounts = listGithubModelsAccounts()
      const normalizedAccountName = accountName?.trim() || undefined

      if (!normalizedAccountName && requireAccountName) {
        const suggested = `account-${existingAccounts.length + 1}`
        setAccountNameInput(suggested)
        setCursorOffset(suggested.length)
        setStep('enter-account-name')
        return
      }

      setPendingAccountName(normalizedAccountName)
      setStep('device-busy')
      setErrorMsg(null)
      setDeviceHint(null)

      try {
        const device = await requestDeviceCode()
        setDeviceHint({
          user_code: device.user_code,
          verification_uri: device.verification_uri,
        })
        await openVerificationUri(device.verification_uri)
        const oauthToken = await pollAccessToken(device.device_code, {
          initialInterval: device.interval,
          timeoutSeconds: device.expires_in,
        })
        const copilotToken = await exchangeForCopilotToken(oauthToken)
        await finalize(
          copilotToken.token,
          DEFAULT_MODEL,
          oauthToken,
          normalizedAccountName,
        )
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setStep('error')
      }
    },
    [finalize],
  )

  const activateExistingLogin = useCallback(() => {
    const activated = activateGithubOnboardingMode(getCurrentGithubModelSetting(), {
      onChangeAPIKey,
    })
    if (!activated.ok) {
      setErrorMsg(
        `GitHub token detected, but settings activation failed: ${activated.detail ?? 'unknown error'}. ` +
          'Set CLAUDE_CODE_USE_GITHUB=1 and OPENAI_MODEL=github:copilot in user settings manually.',
      )
      setStep('error')
      return
    }

    onDone(
      'GitHub Models already authorized. Activated GitHub Models mode using your existing token.',
      { display: 'user' },
    )
  }, [onChangeAPIKey, onDone])

  const submitAccountName = useCallback(
    (value: string) => {
      const normalizedAccountName = value.trim()
      if (!normalizedAccountName) {
        setErrorMsg('Please enter an account name for this GitHub sign-in.')
        setStep('error')
        return
      }

      const existingAccounts = listGithubModelsAccounts()
      const isDuplicate = existingAccounts.some(
        account =>
          account.accountName.toLowerCase() === normalizedAccountName.toLowerCase(),
      )

      if (isDuplicate) {
        setErrorMsg(
          `Account name '${normalizedAccountName}' already exists. Use a different name (for example: ${normalizedAccountName}-2).`,
        )
        setStep('error')
        return
      }

      void runDeviceFlow(normalizedAccountName)
    },
    [runDeviceFlow],
  )

  if (step === 'error' && errorMsg) {
    const options = [
      {
        label: 'Back to menu',
        value: 'back' as const,
      },
      {
        label: 'Exit',
        value: 'exit' as const,
      },
    ]
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">{errorMsg}</Text>
        <Select
          options={options}
          onChange={(v: string) => {
            if (v === 'back') {
              setStep('menu')
              setErrorMsg(null)
            } else {
              onDone('GitHub onboard cancelled', { display: 'system' })
            }
          }}
        />
      </Box>
    )
  }

  if (step === 'enter-account-name') {
    const existingAccounts = listGithubModelsAccounts()
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Connect another GitHub account</Text>
        <Text dimColor>
          You already have GitHub accounts connected in this provider.
        </Text>
        <Text dimColor>
          Enter a label to keep accounts separate in model selection (for example:
          work, personal).
        </Text>
        {existingAccounts.length > 0 ? (
          <Text dimColor>
            Existing accounts: {existingAccounts.map(a => a.accountName).join(', ')}
          </Text>
        ) : null}
        <Box flexDirection="row" gap={1}>
          <Text>-</Text>
          <TextInput
            value={accountNameInput}
            onChange={setAccountNameInput}
            onSubmit={submitAccountName}
            focus={true}
            showCursor={true}
            placeholder="Account name (e.g. work)"
            columns={Math.max(30, columns - 8)}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        <Select
          options={[
            {
              label: 'Continue',
              value: 'continue' as const,
            },
            {
              label: 'Back',
              value: 'back' as const,
            },
            {
              label: 'Cancel',
              value: 'cancel' as const,
            },
          ]}
          onChange={(v: string) => {
            if (v === 'continue') {
              submitAccountName(accountNameInput)
              return
            }
            if (v === 'back') {
              setStep('menu')
              setErrorMsg(null)
              return
            }
            onDone('GitHub onboard cancelled', { display: 'system' })
          }}
        />
      </Box>
    )
  }

  if (step === 'device-busy') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>GitHub Copilot sign-in</Text>
        {pendingAccountName ? (
          <Text dimColor>Saving as account: {pendingAccountName}</Text>
        ) : null}
        {deviceHint ? (
          <>
            <Text>
              Enter code <Text bold>{deviceHint.user_code}</Text> at{' '}
              {deviceHint.verification_uri}
            </Text>
            <Text dimColor>
              A browser window may have opened. Waiting for authorization...
            </Text>
          </>
        ) : (
          <Text dimColor>Requesting device code from GitHub...</Text>
        )}
        <Spinner />
      </Box>
    )
  }

  if (hasExistingLogin) {
    const menuOptions = [
      {
        label: 'Use existing login',
        value: 'use-existing' as const,
      },
      {
        label: 'Connect another account',
        value: 'connect-another' as const,
      },
      {
        label: 'Cancel',
        value: 'cancel' as const,
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>GitHub Copilot setup</Text>
        <Text dimColor>
          GitHub Models is already authorized. You can activate the existing login
          or connect an additional account.
        </Text>
        <Select
          options={menuOptions}
          onChange={(v: string) => {
            if (v === 'cancel') {
              onDone('GitHub onboard cancelled', { display: 'system' })
              return
            }
            if (v === 'use-existing') {
              activateExistingLogin()
              return
            }
            void runDeviceFlow(undefined, true)
          }}
        />
      </Box>
    )
  }

  const menuOptions = [
    {
      label: 'Sign in with browser',
      value: 'device' as const,
    },
    {
      label: 'Cancel',
      value: 'cancel' as const,
    },
  ]

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>GitHub Copilot setup</Text>
      <Text dimColor>
        Stores your token in the OS credential store (macOS Keychain when
        available) and enables CLAUDE_CODE_USE_GITHUB in your user settings - no
        export GITHUB_TOKEN needed for future runs.
      </Text>
      <Select
        options={menuOptions}
        onChange={(v: string) => {
          if (v === 'cancel') {
            onDone('GitHub onboard cancelled', { display: 'system' })
            return
          }
          void runDeviceFlow()
        }}
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const forceRelogin = shouldForceGithubRelogin(args)
  const hasExistingLogin = hasExistingGithubModelsLoginToken() && !forceRelogin

  return (
    <OnboardGithub
      onDone={onDone}
      onChangeAPIKey={context.onChangeAPIKey}
      hasExistingLogin={hasExistingLogin}
    />
  )
}
