import { afterEach, describe, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
})

describe('readGithubModelsToken', () => {
  test('returns undefined in bare mode', async () => {
    const { readGithubModelsToken } = await import(
      './githubModelsCredentials.js?read-bare-mode'
    )

    const prev = process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'
    expect(readGithubModelsToken()).toBeUndefined()
    if (prev === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = prev
    }
  })
})

describe('saveGithubModelsToken / clearGithubModelsToken', () => {
  test('save returns failure in bare mode', async () => {
    const { saveGithubModelsToken } = await import(
      './githubModelsCredentials.js?save-bare-mode'
    )

    const prev = process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'
    const r = saveGithubModelsToken('abc')
    expect(r.success).toBe(false)
    expect(r.warning).toContain('Bare mode')
    if (prev === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = prev
    }
  })

  test('clear succeeds in bare mode', async () => {
    const { clearGithubModelsToken } = await import(
      './githubModelsCredentials.js?clear-bare-mode'
    )

    const prev = process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'
    expect(clearGithubModelsToken().success).toBe(true)
    if (prev === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = prev
    }
  })
})

describe('github model account query helpers', () => {
  test('withGithubModelAccount appends account query parameter', async () => {
    const { withGithubModelAccount } = await import(
      './githubModelsCredentials.js?with-account'
    )

    expect(withGithubModelAccount('gpt-4o', 'work')).toBe('gpt-4o?account=work')
    expect(withGithubModelAccount('gpt-4o?reasoning=high', 'work')).toBe(
      'gpt-4o?reasoning=high&account=work',
    )
  })

  test('getGithubModelAccountName reads account query parameter', async () => {
    const { getGithubModelAccountName } = await import(
      './githubModelsCredentials.js?read-account'
    )

    expect(getGithubModelAccountName('gpt-4o?account=work')).toBe('work')
    expect(getGithubModelAccountName('gpt-4o?reasoning=high&account=personal')).toBe(
      'personal',
    )
    expect(getGithubModelAccountName('gpt-4o')).toBeUndefined()
  })

  test('stripGithubModelAccount removes account query parameter', async () => {
    const { stripGithubModelAccount } = await import(
      './githubModelsCredentials.js?strip-account'
    )

    expect(stripGithubModelAccount('gpt-4o?account=work')).toBe('gpt-4o')
    expect(stripGithubModelAccount('gpt-4o?reasoning=high&account=work')).toBe(
      'gpt-4o?reasoning=high',
    )
  })
})

describe('multi-account credential resolution', () => {
  test('resolveGithubTokenForModel uses account-specific stored token', async () => {
    let store: Record<string, unknown> = {
      githubModels: {
        accounts: [
          { accountName: 'work', accessToken: 'token-work' },
          { accountName: 'personal', accessToken: 'token-personal' },
        ],
        activeAccountName: 'personal',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => store,
        readAsync: async () => store,
        update: (next: Record<string, unknown>) => {
          store = next
          return { success: true }
        },
      }),
    }))

    const { resolveGithubTokenForModel } = await import(
      './githubModelsCredentials.js?resolve-per-account'
    )

    expect(
      resolveGithubTokenForModel('gpt-4o?account=work', {
        GITHUB_TOKEN: 'env-token',
      } as NodeJS.ProcessEnv),
    ).toBe('token-work')
  })

  test('resolveGithubTokenForModel falls back to env token for untagged models', async () => {
    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accounts: [{ accountName: 'default', accessToken: 'stored-default' }],
            activeAccountName: 'default',
          },
        }),
        readAsync: async () => ({
          githubModels: {
            accounts: [{ accountName: 'default', accessToken: 'stored-default' }],
            activeAccountName: 'default',
          },
        }),
        update: () => ({ success: true }),
      }),
    }))

    const { resolveGithubTokenForModel } = await import(
      './githubModelsCredentials.js?resolve-untagged'
    )

    expect(
      resolveGithubTokenForModel('gpt-4o', {
        GITHUB_TOKEN: 'env-token',
      } as NodeJS.ProcessEnv),
    ).toBe('env-token')
  })

  test('save and switch active account without overwriting others', async () => {
    let store: Record<string, unknown> = {
      githubModels: {
        accounts: [
          {
            accountName: 'default',
            accessToken: 'token-default',
            oauthAccessToken: 'oauth-default',
          },
        ],
        activeAccountName: 'default',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => store,
        readAsync: async () => store,
        update: (next: Record<string, unknown>) => {
          store = next
          return { success: true }
        },
      }),
    }))

    const {
      saveGithubModelsToken,
      readGithubModelsToken,
      setActiveGithubModelsAccount,
      listGithubModelsAccounts,
    } = await import('./githubModelsCredentials.js?save-multi-account')

    expect(saveGithubModelsToken('token-work', 'oauth-work', 'work').success).toBe(
      true,
    )

    const accounts = listGithubModelsAccounts()
    expect(accounts).toHaveLength(2)
    expect(accounts.map(account => account.accountName).sort()).toEqual([
      'default',
      'work',
    ])
    expect(readGithubModelsToken()).toBe('token-work')

    expect(setActiveGithubModelsAccount('default').success).toBe(true)
    expect(readGithubModelsToken()).toBe('token-default')
    expect(readGithubModelsToken('work')).toBe('token-work')
  })
})
