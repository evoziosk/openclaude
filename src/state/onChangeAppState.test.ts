import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { AppState } from './AppStateStore.js'
import * as realBootstrapStateModule from '../bootstrap/state.js'
import * as realSettingsModule from '../utils/settings/settings.js'
import * as realProviderProfilesModule from '../utils/providerProfiles.js'

function buildState(model: string | null, settings: AppState['settings']): AppState {
  return {
    toolPermissionContext: { mode: 'default' },
    isUltraplanMode: false,
    mainLoopModel: model,
    expandedView: 'none',
    verbose: false,
    settings,
  } as AppState
}

async function importFreshOnChangeAppStateModule(options?: {
  switchedProfileResult?: unknown
}) {
  const setMainLoopModelOverride = mock(() => {})
  const updateSettingsForSource = mock(() => {})
  const switchActiveProviderProfileForModel = mock(() => {
    return options?.switchedProfileResult ?? null
  })
  const persistActiveProviderProfileModel = mock(() => null)

  mock.module('../bootstrap/state.js', () => ({
    ...realBootstrapStateModule,
    setMainLoopModelOverride,
  }))
  mock.module('../utils/settings/settings.js', () => ({
    ...realSettingsModule,
    updateSettingsForSource,
  }))
  mock.module('../utils/providerProfiles.js', () => ({
    ...realProviderProfilesModule,
    switchActiveProviderProfileForModel,
    persistActiveProviderProfileModel,
  }))

  const module = await import(`./onChangeAppState.ts?ts=${Date.now()}-${Math.random()}`)

  return {
    onChangeAppState: module.onChangeAppState,
    setMainLoopModelOverride,
    updateSettingsForSource,
    switchActiveProviderProfileForModel,
    persistActiveProviderProfileModel,
  }
}

afterEach(() => {
  mock.restore()
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
})

describe('onChangeAppState mainLoopModel profile sync', () => {
  test('persists selected model when profile switch returns null', async () => {
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
    const {
      onChangeAppState,
      switchActiveProviderProfileForModel,
      persistActiveProviderProfileModel,
    } = await importFreshOnChangeAppStateModule({ switchedProfileResult: null })
    const settings = {} as AppState['settings']

    onChangeAppState({
      oldState: buildState('gpt-4o', settings),
      newState: buildState('gpt-4o-mini', settings),
    })

    expect(switchActiveProviderProfileForModel).toHaveBeenCalledWith('gpt-4o-mini')
    expect(persistActiveProviderProfileModel).toHaveBeenCalledWith('gpt-4o-mini')
  })
})
