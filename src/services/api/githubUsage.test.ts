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
      'x-ratelimit-limit-tokens': '500000',
      'x-ratelimit-remaining-tokens': '125000',
    })

    const parsed = parseGithubUsageHeaders(headers, 1_700_000_000_000)

    expect(parsed.requests?.limit).toBe(1000)
    expect(parsed.requests?.remaining).toBe(250)
    expect(parsed.requests?.usedPercent).toBe(75)

    expect(parsed.tokens?.limit).toBe(500000)
    expect(parsed.tokens?.remaining).toBe(125000)
    expect(parsed.tokens?.usedPercent).toBe(75)
  })

  test('falls back to generic GitHub rate limit headers', () => {
    const headers = createHeaders({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4900',
    })

    const parsed = parseGithubUsageHeaders(headers, 1_700_000_000_000)

    expect(parsed.requests?.limit).toBe(5000)
    expect(parsed.requests?.remaining).toBe(4900)
    expect(parsed.requests?.usedPercent).toBe(2)
    expect(parsed.tokens).toBeUndefined()
  })
})

describe('fetchGithubUsage', () => {
  test('returns normalized quota from /copilot_internal/user with Bearer scheme', async () => {
    const calls: string[] = []

    const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      calls.push(url)

      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      // Should ALWAYS use Bearer scheme now
      expect(auth).toBe('Bearer ghu_test')

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
    expect(result.planType).toContain('business_seat - business')
    expect(result.accountId).toBe('12345')
    expect(result.accountUsername).toBe('octocat')
    // Primary quota should be "completions" (lowest percent_remaining = 10)
    expect(result.requests?.limit).toBe(50)
    expect(result.requests?.remaining).toBe(5)
    expect(result.requests?.usedPercent).toBe(90)
    // Should include per-snapshot data
    expect(result.quotaSnapshots).toHaveLength(2)
    expect(result.quotaSnapshots?.[0]?.name).toBe('chat')
    expect(result.quotaSnapshots?.[1]?.name).toBe('completions')
    // Debug info should be present
    expect(result._debug?.tokenType).toBe('oauth')
    expect(result._debug?.rawPayload).toBeDefined()
  })

  test('throws clear auth error when no token is available', async () => {
    await expect(
      fetchGithubUsage({
        model: 'github:copilot',
        processEnv: {},
        fetchImpl: async () => new Response('', { status: 200 }),
      }),
    ).rejects.toThrow('OAuth token is required')
  })

  test('throws on HTTP error from copilot endpoint', async () => {
    const fetchImpl: FetchGithubUsageOptions['fetchImpl'] = async () =>
      new Response('forbidden', { status: 403 })

    await expect(
      fetchGithubUsage({
        model: 'github:copilot',
        processEnv: {
          GITHUB_TOKEN: 'ghu_test',
        },
        fetchImpl,
      }),
    ).rejects.toThrow('GitHub usage error 403')
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
              entitlement: 0,
              remaining: 0,
              percent_remaining: 100,
              unlimited: true,
            },
            completions: {
              entitlement: 0,
              remaining: 0,
              percent_remaining: 100,
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

  expect(result.planType).toContain('free_educational_quota - individual')
  expect(result.requests?.unlimited).toBe(true)
  expect(result.requests?.usedPercent).toBeUndefined()
  // Should have a resetsAt from quota_reset_date_utc
  expect(result.requests?.resetsAt).toBe('2026-05-01T00:00:00.000Z')
  // All snapshots should be marked unlimited
  expect(result.quotaSnapshots).toHaveLength(2)
  expect(result.quotaSnapshots?.[0]?.unlimited).toBe(true)
  expect(result.quotaSnapshots?.[1]?.unlimited).toBe(true)
})

test('fetchGithubUsage returns unlimited when quota_snapshots is missing entirely', async () => {
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
          // No quota_snapshots at all — this is the case when using wrong token type
        }),
        { status: 200 },
      )
    }

    return new Response(JSON.stringify({ id: 42, login: 'missing-snap' }), {
      status: 200,
    })
  }

  const result = await fetchGithubUsage({
    model: 'github:copilot',
    processEnv: { GITHUB_TOKEN: 'ghu_test' },
    fetchImpl,
  })

  expect(result.requests?.unlimited).toBe(true)
  expect(result.quotaSnapshots).toHaveLength(0)
})

test('fetchGithubUsage returns unlimited when quota_snapshots is empty object', async () => {
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
          quota_snapshots: {},
        }),
        { status: 200 },
      )
    }

    return new Response(JSON.stringify({ id: 7, login: 'empty-snap' }), {
      status: 200,
    })
  }

  const result = await fetchGithubUsage({
    model: 'github:copilot',
    processEnv: { GITHUB_TOKEN: 'ghu_test' },
    fetchImpl,
  })

  expect(result.requests?.unlimited).toBe(true)
  expect(result.quotaSnapshots).toHaveLength(0)
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
              entitlement: 0,
              remaining: 0,
              percent_remaining: 100,
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
  // Per-snapshot data should show both
  expect(result.quotaSnapshots).toHaveLength(2)
  expect(result.quotaSnapshots?.[0]?.name).toBe('chat')
  expect(result.quotaSnapshots?.[0]?.unlimited).toBe(true)
  expect(result.quotaSnapshots?.[1]?.name).toBe('completions')
  expect(result.quotaSnapshots?.[1]?.usedPercent).toBe(60)
})

test('fetchGithubUsage includes limitReached flag when quota is exhausted', async () => {
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
              entitlement: 100,
              remaining: 0,
              percent_remaining: 0,
              unlimited: false,
            },
          },
        }),
        { status: 200 },
      )
    }

    return new Response(JSON.stringify({ id: 9, login: 'limit-user' }), {
      status: 200,
    })
  }

  const result = await fetchGithubUsage({
    model: 'github:copilot',
    processEnv: { GITHUB_TOKEN: 'ghu_test' },
    fetchImpl,
  })

  expect(result.requests?.usedPercent).toBe(100)
  expect(result.requests?.limitReached).toBe(true)
})

test('fetchGithubUsage treats snapshot with unlimited:true but finite entitlement as finite', async () => {
  // This matches real API behavior: free_educational_quota returns unlimited:true
  // on ALL snapshots, even premium_interactions which has entitlement=300, remaining=262.
  // Truly unlimited categories have entitlement:0, remaining:0, percent_remaining:100.
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
              entitlement: 0,
              remaining: 0,
              percent_remaining: 100,
              unlimited: true,
            },
            completions: {
              entitlement: 0,
              remaining: 0,
              percent_remaining: 100,
              unlimited: true,
            },
            premium_interactions: {
              entitlement: 300,
              remaining: 262,
              percent_remaining: 87.3,
              unlimited: false,
            },
          },
        }),
        { status: 200 },
      )
    }

    return new Response(JSON.stringify({ id: 42, login: 'test-user' }), {
      status: 200,
    })
  }

  const result = await fetchGithubUsage({
    model: 'github:copilot',
    processEnv: { GITHUB_TOKEN: 'ghu_test' },
    fetchImpl,
  })

  // premium_interactions has finite entitlement, so should NOT be treated as unlimited
  expect(result.quotaSnapshots).toHaveLength(3)

  const chatSnap = result.quotaSnapshots?.find(s => s.name === 'chat')
  expect(chatSnap?.unlimited).toBe(true)

  const completionsSnap = result.quotaSnapshots?.find(s => s.name === 'completions')
  expect(completionsSnap?.unlimited).toBe(true)

  const premiumSnap = result.quotaSnapshots?.find(s => s.name === 'premium_interactions')
  expect(premiumSnap?.unlimited).toBe(false)
  expect(premiumSnap?.entitlement).toBe(300)
  expect(premiumSnap?.remaining).toBe(262)
  // usedPercent should be 100 - 87.3 = 12.7
  expect(premiumSnap?.usedPercent).toBeGreaterThan(12)
  expect(premiumSnap?.usedPercent).toBeLessThan(13)

  // Not all unlimited anymore, so requests should pick premium_interactions as primary
  expect(result.requests?.unlimited).toBeUndefined()
  expect(result.requests?.limit).toBe(300)
  expect(result.requests?.remaining).toBe(262)
})
