import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import { saveGlobalConfig } from '../config.js'

async function importFreshModelOptionsModule() {
  mock.module('./providers.js', () => ({
    getAPIProvider: () => 'github',
  }))
  mock.module('../githubModelsCredentials.js', () => ({
    listGithubModelsAccounts: () => [],
    getActiveGithubModelsAccountName: () => undefined,
    withGithubModelAccount: (model: string) => model,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

async function importFreshModelOptionsModuleWithAccounts() {
  mock.module('./providers.js', () => ({
    getAPIProvider: () => 'github',
  }))
  mock.module('../githubModelsCredentials.js', () => ({
    listGithubModelsAccounts: () => [
      { accountName: 'work', accessToken: 'token-work' },
      { accountName: 'personal', accessToken: 'token-personal' },
    ],
    getActiveGithubModelsAccountName: () => 'work',
    withGithubModelAccount: (model: string, accountName: string) =>
      `${model}?account=${accountName}`,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

const originalEnv = {
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  ANTHROPIC_CUSTOM_MODEL_OPTION: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
}

beforeEach(() => {
  mock.restore()
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  process.env.CLAUDE_CODE_USE_GITHUB = originalEnv.CLAUDE_CODE_USE_GITHUB
  process.env.CLAUDE_CODE_USE_OPENAI = originalEnv.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_USE_GEMINI = originalEnv.CLAUDE_CODE_USE_GEMINI
  process.env.CLAUDE_CODE_USE_BEDROCK = originalEnv.CLAUDE_CODE_USE_BEDROCK
  process.env.CLAUDE_CODE_USE_VERTEX = originalEnv.CLAUDE_CODE_USE_VERTEX
  process.env.CLAUDE_CODE_USE_FOUNDRY = originalEnv.CLAUDE_CODE_USE_FOUNDRY
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION =
    originalEnv.ANTHROPIC_CUSTOM_MODEL_OPTION
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    providerProfiles: [],
    activeProviderProfileId: undefined,
  }))
  resetModelStringsForTestingOnly()
})

test('GitHub provider exposes default + all Copilot models in /model options', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY

  process.env.OPENAI_MODEL = 'gpt-4o'
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const nonDefault = options.filter(
    (option: { value: unknown }) => option.value !== null,
  )

  expect(nonDefault.length).toBeGreaterThan(1)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-4o')).toBe(true)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-5.3-codex')).toBe(true)
})

test('GitHub provider prefixes model options with account names when multiple accounts exist', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'

  const { getModelOptions } = await importFreshModelOptionsModuleWithAccounts()
  const options = getModelOptions(false)

  expect(
    options.some(
      (option: { label: string; value: unknown }) =>
        option.label === 'GPT-4o (work)' && option.value === 'gpt-4o?account=work',
    ),
  ).toBe(true)
  expect(
    options.some(
      (option: { label: string; value: unknown }) =>
        option.label === 'GPT-4o (personal)' &&
        option.value === 'gpt-4o?account=personal',
    ),
  ).toBe(true)
})

test('GitHub provider account-tagged models still satisfy availableModels allowlist', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'

  mock.module('../settings/settings.js', () => ({
    getSettings_DEPRECATED: () => ({ availableModels: ['gpt-4o'] }),
  }))

  const { getModelOptions } = await importFreshModelOptionsModuleWithAccounts()
  const options = getModelOptions(false)

  expect(
    options.some(
      (option: { label: string; value: unknown }) =>
        option.label === 'GPT-4o (work)' && option.value === 'gpt-4o?account=work',
    ),
  ).toBe(true)
})

test('active GitHub account models are listed first', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'

  const { getModelOptions } = await importFreshModelOptionsModuleWithAccounts()
  const options = getModelOptions(false)

  const firstNonDefault = options.find(
    (option: { value: unknown }) => option.value !== null,
  ) as { label: string } | undefined

  expect(firstNonDefault?.label).toContain('(work)')
})
