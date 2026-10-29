import { generateKeyPairSync } from 'node:crypto';
import { CacheKeys } from 'librechat-data-provider';
import type { BrowserSetupBackend, AppConfig } from '@librechat/data-schemas';
import type { SetupRegistry } from './service';
import { createConfigCacheInvalidation } from '~/app/invalidation';
import { createAppConfigService } from '~/app/service';
import { standardCache } from '~/cache/cacheFactory';
import { createCodeSetupRouter } from './router';

jest.mock('./service', () => ({
  ...jest.requireActual('./service'),
  createSetupService: () => ({ reconcile: async () => undefined }),
}));

const { privateKey } = generateKeyPairSync('ed25519');

/**
 * The browser setup sweep runs on a one-second timer on every server where Code API JWT auth is
 * on. It must read the cached base config: a forced refresh reloaded librechat.yaml on every
 * sweep, every 10 s plus the load, for the life of the process.
 */
describe('browser setup sweep', () => {
  const previous = {
    jwt: process.env.CODEAPI_JWT_ENABLED,
    key: process.env.CODEAPI_JWT_PRIVATE_KEY,
  };
  const lifetime = new AbortController();

  beforeAll(() => {
    process.env.CODEAPI_JWT_ENABLED = 'true';
    process.env.CODEAPI_JWT_PRIVATE_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
  });

  afterAll(() => {
    lifetime.abort();
    jest.useRealTimers();
    for (const [name, value] of Object.entries({
      CODEAPI_JWT_ENABLED: previous.jwt,
      CODEAPI_JWT_PRIVATE_KEY: previous.key,
    })) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('reloads librechat.yaml only after a config write, not on its timer', async () => {
    jest.useFakeTimers();
    const loadBaseConfig = jest.fn(async (): Promise<AppConfig> => ({ config: {} }) as AppConfig);
    const cache = standardCache(`${CacheKeys.APP_CONFIG}:sweep-spec`);
    const { getAppConfig, clearAppConfigCache } = createAppConfigService({
      loadBaseConfig,
      setCachedTools: async () => undefined,
      getCache: () => ({
        get: (key) => cache.get(key),
        set: (key, value, ttl) => cache.set(key, value, ttl),
        delete: (key) => cache.delete(key),
      }),
      cacheKeys: { APP_CONFIG: CacheKeys.APP_CONFIG },
      getApplicableConfigs: async () => [],
      getUserPrincipals: async () => [],
    });
    const invalidation = createConfigCacheInvalidation({
      clears: [{ label: 'clearAppConfigCache', clear: () => clearAppConfigCache() }],
    });
    await getAppConfig({ baseOnly: true });
    expect(loadBaseConfig).toHaveBeenCalledTimes(1);

    const backend = {
      isConnected: () => true,
      createStore: () => ({}),
    } as unknown as BrowserSetupBackend;
    createCodeSetupRouter({
      backend,
      signal: lifetime.signal,
      getAppConfig,
      registry: () => ({}) as SetupRegistry,
      requireJwtAuth: (_req, _res, next) => next(),
      requireSameOrigin: (_req, _res, next) => next(),
      checkBan: (_req, _res, next) => next(),
      banStore: { get: async () => undefined },
    });

    await jest.advanceTimersByTimeAsync(65_000);
    expect(loadBaseConfig).toHaveBeenCalledTimes(1);

    await invalidation.invalidate();
    await jest.advanceTimersByTimeAsync(65_000);
    expect(loadBaseConfig).toHaveBeenCalledTimes(2);
    expect(loadBaseConfig).toHaveBeenLastCalledWith('reload');
  });
});
