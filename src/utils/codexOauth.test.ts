import { expect, test } from 'bun:test'

import { getCodexOauthLoginCommand, runCodexOauthLogin } from './codexOauth.js'

test('getCodexOauthLoginCommand uses cmd wrapper on Windows', () => {
  expect(getCodexOauthLoginCommand('win32')).toEqual({
    command: 'cmd',
    args: ['/c', 'codex', 'login'],
  })
})

test('getCodexOauthLoginCommand uses direct command on non-Windows', () => {
  expect(getCodexOauthLoginCommand('darwin')).toEqual({
    command: 'codex',
    args: ['login'],
  })
})

test('runCodexOauthLogin returns early when credentials already exist', async () => {
  const runCommand = async () => {
    throw new Error('runCommand should not be called')
  }
  const result = await runCodexOauthLogin({
    processEnv: {
      CODEX_API_KEY: 'header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTEyMyJ9.sig',
    },
    findCommand: async () => null,
    runCommand,
  })

  expect(result).toEqual({ ok: true })
})

test('runCodexOauthLogin uses npx fallback when codex is missing', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await runCodexOauthLogin({
    processEnv: {
      CODEX_AUTH_JSON_PATH: '__missing_auth_json__',
    },
    findCommand: async command =>
      command === 'codex' ? null : command === 'npx' ? '/usr/bin/npx' : null,
    runCommand: async (command, args) => {
      calls.push({ command, args })
      return { exitCode: 0, failed: false }
    },
  })

  expect(result.ok).toBe(false)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({
    command: process.platform === 'win32' ? 'cmd' : 'npx',
    args:
      process.platform === 'win32'
        ? ['/c', 'npx', '--yes', '@openai/codex', 'login']
        : ['--yes', '@openai/codex', 'login'],
  })
})

test('runCodexOauthLogin reports missing executables when codex and npx are unavailable', async () => {
  const result = await runCodexOauthLogin({
    processEnv: {
      CODEX_AUTH_JSON_PATH: '__missing_auth_json__',
    },
    findCommand: async () => null,
    runCommand: async () => ({ exitCode: 0, failed: false }),
  })

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('neither `codex` nor `npx` is available')
  }
})

test('runCodexOauthLogin reports failure when command exits non-zero', async () => {
  const result = await runCodexOauthLogin({
    processEnv: {
      CODEX_AUTH_JSON_PATH: '__missing_auth_json__',
    },
    findCommand: async () => '/usr/local/bin/codex',
    runCommand: async () => ({ exitCode: 1, failed: false }),
  })

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('Codex login did not complete successfully')
  }
})

test('runCodexOauthLogin reports launch errors', async () => {
  const result = await runCodexOauthLogin({
    processEnv: {
      CODEX_AUTH_JSON_PATH: '__missing_auth_json__',
    },
    findCommand: async () => '/usr/local/bin/codex',
    runCommand: async () => {
      throw new Error('spawn ENOENT')
    },
  })

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('Failed to launch Codex login')
    expect(result.message).toContain('spawn ENOENT')
  }
})

test('runCodexOauthLogin reports missing account id after successful login', async () => {
  const result = await runCodexOauthLogin({
    processEnv: {
      CODEX_API_KEY: 'sk-no-account-id',
      CODEX_AUTH_JSON_PATH: '__missing_auth_json__',
    },
    findCommand: async () => '/usr/local/bin/codex',
    runCommand: async () => ({ exitCode: 0, failed: false }),
  })

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('missing chatgpt_account_id')
  }
})

test('runCodexOauthLogin forceLogin runs login even when credentials already exist', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await runCodexOauthLogin({
    processEnv: {
      CODEX_API_KEY: 'header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTEyMyJ9.sig',
      CODEX_AUTH_JSON_PATH: '__missing_auth_json__',
    },
    forceLogin: true,
    findCommand: async () => '/usr/local/bin/codex',
    runCommand: async (command, args) => {
      calls.push({ command, args })
      return { exitCode: 0, failed: false }
    },
  })

  expect(result).toEqual({ ok: true })
  expect(calls).toHaveLength(1)
})
