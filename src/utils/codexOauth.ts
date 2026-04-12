import { execa } from 'execa'

import { resolveCodexApiCredentials } from '../services/api/providerConfig.js'
import { which } from './which.js'

export type CodexOauthResult = { ok: true } | { ok: false; message: string }

export type RunCodexOauthLoginOptions = {
  processEnv?: NodeJS.ProcessEnv
  forceLogin?: boolean
  runCommand?: (
    command: string,
    args: string[],
    commandOptions: {
      stdio: 'inherit'
      reject: false
      env: NodeJS.ProcessEnv
    },
  ) => Promise<{ exitCode: number; failed?: boolean }>
  findCommand?: (command: string) => Promise<string | null>
}

function validateCodexCredentials(
  processEnv: NodeJS.ProcessEnv,
): CodexOauthResult {
  const credentials = resolveCodexApiCredentials(processEnv)

  if (!credentials.apiKey) {
    const authHint = credentials.authPath
      ? `Expected auth file: ${credentials.authPath}.`
      : 'Set CODEX_API_KEY or re-login with the Codex CLI.'
    return {
      ok: false,
      message: `Codex setup needs existing credentials. Re-login with the Codex CLI or set CODEX_API_KEY. ${authHint}`,
    }
  }

  if (!credentials.accountId) {
    return {
      ok: false,
      message:
        'Codex auth is missing chatgpt_account_id. Re-login with the Codex CLI or set CHATGPT_ACCOUNT_ID/CODEX_ACCOUNT_ID first.',
    }
  }

  return { ok: true }
}

export function getCodexOauthLoginCommand(
  platform: NodeJS.Platform = process.platform,
): {
  command: string
  args: string[]
} {
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'codex', 'login'],
    }
  }

  return {
    command: 'codex',
    args: ['login'],
  }
}

function getCodexOauthLoginNpxCommand(
  platform: NodeJS.Platform = process.platform,
): {
  command: string
  args: string[]
} {
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '--yes', '@openai/codex', 'login'],
    }
  }

  return {
    command: 'npx',
    args: ['--yes', '@openai/codex', 'login'],
  }
}

async function resolveLoginCommand(
  findCommand: (command: string) => Promise<string | null>,
  platform: NodeJS.Platform,
): Promise<{ command: string; args: string[] } | null> {
  const codexExecutable = await findCommand('codex')
  if (codexExecutable) {
    return getCodexOauthLoginCommand(platform)
  }

  const npxExecutable = await findCommand('npx')
  if (npxExecutable) {
    return getCodexOauthLoginNpxCommand(platform)
  }

  return null
}

export async function runCodexOauthLogin(
  options?: RunCodexOauthLoginOptions,
): Promise<CodexOauthResult> {
  const processEnv = options?.processEnv ?? process.env
  const forceLogin = options?.forceLogin ?? false
  const runCommand =
    options?.runCommand ??
    ((command, args, commandOptions) => execa(command, args, commandOptions))
  const findCommand = options?.findCommand ?? which

  if (!forceLogin) {
    const existingCredentials = validateCodexCredentials(processEnv)
    if (existingCredentials.ok) {
      return { ok: true }
    }
  }

  const loginCommand = await resolveLoginCommand(findCommand, process.platform)
  if (!loginCommand) {
    return {
      ok: false,
      message:
        'Could not start Codex OAuth login because neither `codex` nor `npx` is available on PATH. Install Codex CLI (`npm i -g @openai/codex`) and run `codex login`, or set CODEX_API_KEY and CHATGPT_ACCOUNT_ID/CODEX_ACCOUNT_ID manually.',
    }
  }

  let loginResult: { exitCode: number; failed?: boolean }
  try {
    loginResult = await runCommand(loginCommand.command, loginCommand.args, {
      stdio: 'inherit',
      reject: false,
      env: processEnv,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `Failed to launch Codex login. ${message}`,
    }
  }

  if (loginResult.exitCode !== 0 || loginResult.failed) {
    return {
      ok: false,
      message:
        'Codex login did not complete successfully. Run `codex login` (or `npx --yes @openai/codex login`) in your shell and try again.',
    }
  }

  return validateCodexCredentials(processEnv)
}
