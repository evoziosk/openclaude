import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  fetchGithubUsage,
  parseGithubUsageHeaders,
  type FetchGithubUsageOptions,
} from './githubUsage.js'

function createHeaders(values: Record<string, string>): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(values)) {
    headers.set(key, value)
  }
  return headers
}

const originalBare = process.env.CLAUDE_CODE_SIMPLE

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
})

afterEach(() => {
  if (originalBare === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = originalBare
  }
})

describe('parseGithubUsageHeaders', () => {
  test('parses OpenAI-style requests/tokens usage headers', () => {
    const headers = createHeaders({
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '250',
      'x-ratelimit-reset-requests': '30s',
      'x-ratelimit-limit-tokens': '500000',
      'x-ratelimit-remaining-tokens': '125000',
      'x-ratelimit-reset-tokens': '1m0s',
    })

    const parsed = parseGithubUsageHeaders(headers, 1_700_000_000_000)

    expect(parsed.requests?.limit).toBe(1000)
    expect(parsed.requests?.remaining).toBe(250)
    expect(parsed.requests?.usedPercent).toBe(75)
    expect(parsed.requests?.resetsAt).toBe(new Date(1_700_000_030_000).toISOString())

    expect(parsed.tokens?.limit).toBe(500000)
    expect(parsed.tokens?.remaining).toBe(125000)
    expect(parsed.tokens?.usedPercent).toBe(75)
    expect(parsed.tokens?.resetsAt).toBe(new Date(1_700_000_060_000).toISOString())
  })

  test('falls back to generic GitHub rate limit headers', () => {
    const headers = createHeaders({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4900',
      'x-ratelimit-reset': '1700000100',
    })

    const parsed = parseGithubUsageHeaders(headers, 1_700_000_000_000)

    expect(parsed.requests?.limit).toBe(5000)
    expect(parsed.requests?.remaining).toBe(4900)
    expect(parsed.requests?.usedPercent).toBe(2)
    expect(parsed.requests?.resetsAt).toBe(new Date(1_700_000_100_000).toISOString())
    expect(parsed.tokens).toBeUndefined()
  })
})

describe('fetchGithubUsage', () => {
  test('returns normalized quota from /copilot_internal/user', async () => {
    const calls: string[] = []

    const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      calls.push(url)

      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      expect(auth).toBe('token ghu_test')

      if (url.endsWith('/copilot_internal/user')) {
        return new Response(
          JSON.stringify({
            access_type_sku: 'business_seat',
            copilot_plan: 'business',
            quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
            quota_snapshots: {
              chat: {
                entitlement: 100,
                remaining: 60,
                percent_remaining: 60,
                unlimited: false,
              },
              completions: {
                entitlement: 50,
                remaining: 5,
                percent_remaining: 10,
                unlimited: false,
              },
            },
          }),
          { status: 200 },
        )
      }

      if (url.endsWith('/user')) {
        return new Response(
          JSON.stringify({
            id: 12345,
            login: 'octocat',
          }),
          { status: 200 },
        )
      }

      return new Response('not found', { status: 404 })
    }

    const result = await fetchGithubUsage({
      model: 'github:copilot',
      processEnv: {
        GITHUB_TOKEN: 'ghu_test',
      },
      fetchImpl,
    })

    expect(calls).toContain('https://api.github.com/copilot_internal/user')
    expect(calls).toContain('https://api.github.com/user')
    expect(result.endpoint).toBe('https://api.github.com')
    expect(result.planType).toBe('business_seat - business')
    expect(result.accountId).toBe('12345')
    expect(result.accountUsername).toBe('octocat')
    expect(result.requests?.limit).toBe(50)
    expect(result.requests?.remaining).toBe(5)
    expect(result.requests?.usedPercent).toBe(90)
  })

  test('retries auth scheme on malformed authorization header', async () => {
    const authHeaders: string[] = []

    const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      if (auth) {
        authHeaders.push(auth)
      }

      if (auth === 'token ghu_test' && url.endsWith('/copilot_internal/user')) {
        return new Response('bad request: Authorization header is badly formatted', {
          status: 400,
        })
      }

      if (url.endsWith('/copilot_internal/user')) {
        return new Response(
          JSON.stringify({
            access_type_sku: 'individual',
            copilot_plan: 'pro',
            quota_snapshots: {
              chat: {
                entitlement: 100,
                remaining: 50,
                percent_remaining: 50,
                unlimited: false,
              },
            },
          }),
          { status: 200 },
        )
      }

      return new Response(JSON.stringify({ id: 99, login: 'retry-user' }), {
        status: 200,
      })
    }

    const result = await fetchGithubUsage({
      model: 'github:copilot',
      processEnv: {
        GITHUB_TOKEN: 'ghu_test',
      },
      fetchImpl,
    })

    expect(result.requests?.usedPercent).toBe(50)
    expect(authHeaders).toContain('token ghu_test')
    expect(authHeaders).toContain('Bearer ghu_test')
  })

  test('throws clear auth error when all auth attempts fail', async () => {
    const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async () =>
      new Response('bad request: Authorization header is badly formatted', {
        status: 400,
      })

    await expect(
      fetchGithubUsage({
        model: 'github:copilot',
        processEnv: {
          GITHUB_TOKEN: 'ghu_test',
        },
        fetchImpl,
      }),
    ).rejects.toThrow('GitHub usage error 400')
  })
})

test('fetchGithubUsage marks requests as unlimited when all quota snapshots are unlimited', async () => {
  const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ) => {
    const url = String(input)

    if (url.endsWith('/copilot_internal/user')) {
      return new Response(
        JSON.stringify({
          access_type_sku: 'free_educational_quota',
          copilot_plan: 'individual',
          quota_reset_date_utc: '2026-05-01T00:00:00.000Z',
          quota_snapshots: {
            chat: {
              entitlement: null,
              remaining: null,
              percent_remaining: null,
              unlimited: true,
            },
            completions: {
              entitlement: null,
              remaining: null,
              percent_remaining: null,
              unlimited: true,
            },
          },
        }),
        { status: 200 },
      )
    }

    return new Response(JSON.stringify({ id: 42, login: 'free-user' }), {
      status: 200,
    })
  }

  const result = await fetchGithubUsage({
    model: 'github:copilot',
    processEnv: { GITHUB_TOKEN: 'ghu_test' },
    fetchImpl,
  })

  expect(result.planType).toBe('free_educational_quota - individual')
  expect(result.requests?.unlimited).toBe(true)
  expect(result.requests?.usedPercent).toBeUndefined()
  // Should have a resetsAt from quota_reset_date_utc
  expect(result.requests?.resetsAt).toBe('2026-05-01T00:00:00.000Z')
})

test('fetchGithubUsage prefers finite quota snapshot over unlimited one', async () => {
  const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ) => {
    const url = String(input)

    if (url.endsWith('/copilot_internal/user')) {
      return new Response(
        JSON.stringify({
          access_type_sku: 'business_seat',
          copilot_plan: 'business',
          quota_snapshots: {
            chat: {
              entitlement: null,
              remaining: null,
              unlimited: true,
            },
            completions: {
              entitlement: 200,
              remaining: 80,
              percent_remaining: 40,
              unlimited: false,
            },
          },
        }),
        { status: 200 },
      )
    }

    return new Response(JSON.stringify({ id: 7, login: 'biz-user' }), {
      status: 200,
    })
  }

  const result = await fetchGithubUsage({
    model: 'github:copilot',
    processEnv: { GITHUB_TOKEN: 'ghu_test' },
    fetchImpl,
  })

  // Should pick the finite "completions" snapshot, not the unlimited "chat" one
  expect(result.requests?.unlimited).toBeUndefined()
  expect(result.requests?.limit).toBe(200)
  expect(result.requests?.remaining).toBe(80)
  expect(result.requests?.usedPercent).toBe(60)
})

test('fetchGithubUsage falls back to response headers when quota snapshots are missing', async () => {
  const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input)
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    expect(auth).toBe('token ghu_test')

    if (url.endsWith('/copilot_internal/user')) {
      return new Response(
        JSON.stringify({
          access_type_sku: 'free_educational_quota',
          copilot_plan: 'individual',
          quota_snapshots: {},
        }),
        {
          status: 200,
          headers: createHeaders({
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4200',
          }),
        },
      )
    }

    return new Response(JSON.stringify({ id: 7, login: 'headers-fallback' }), {
      status: 200,
    })
  }

  const result = await fetchGithubUsage({
    model: 'github:copilot',
    processEnv: {
      GITHUB_TOKEN: 'ghu_test',
    },
    fetchImpl,
  })

  expect(result.planType).toBe('free_educational_quota - individual')
  expect(result.requests?.limit).toBe(5000)
  expect(result.requests?.remaining).toBe(4200)
  expect(result.requests?.usedPercent).toBe(16)
})
