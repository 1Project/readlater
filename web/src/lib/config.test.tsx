import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./data', () => ({ getAppConfig: vi.fn() }));

import { getAppConfig } from './data';
import type { AppConfig } from './types';
import { DISABLED_CONFIG, loadConfig, normalizeConfig, resetConfigCache, useConfig, type LoadedConfig } from './config';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.mocked(getAppConfig);

beforeEach(() => {
  resetConfigCache();
  mocked.mockReset();
});
afterEach(() => resetConfigCache());

describe('normalizeConfig', () => {
  it('accepts the callable response and tolerates junk', () => {
    expect(normalizeConfig({ ai: true, telegramBot: '@my_bot', inboundEmailDomain: ' in.example.com ' })).toEqual({
      ai: true,
      telegramBot: 'my_bot',
      inboundEmailDomain: 'in.example.com',
    });
    expect(normalizeConfig(null)).toEqual(DISABLED_CONFIG);
    expect(normalizeConfig({ ai: 'yes', telegramBot: '', inboundEmailDomain: 5 })).toEqual(DISABLED_CONFIG);
  });
});

describe('loadConfig', () => {
  it('calls getConfig once per session and caches the answer', async () => {
    mocked.mockResolvedValue({ ai: true, telegramBot: 'bot', inboundEmailDomain: null });
    const [a, b] = await Promise.all([loadConfig(), loadConfig()]);
    expect(a).toEqual({ ai: true, telegramBot: 'bot', inboundEmailDomain: null });
    expect(b).toBe(a);
    await loadConfig();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem('rl.config')!)).toEqual(a);
  });

  it('reuses the answer stored in sessionStorage after a reload', async () => {
    sessionStorage.setItem('rl.config', JSON.stringify({ ai: false, telegramBot: 'stored_bot', inboundEmailDomain: 'mail.test' }));
    expect(await loadConfig()).toEqual({ ai: false, telegramBot: 'stored_bot', inboundEmailDomain: 'mail.test' });
    expect(mocked).not.toHaveBeenCalled();
  });

  it('treats a failure as "everything off" without retrying in the same page, and without storing it', async () => {
    mocked.mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadConfig()).toEqual(DISABLED_CONFIG);
    expect(await loadConfig()).toEqual(DISABLED_CONFIG);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('rl.config')).toBeNull();
    warn.mockRestore();
  });
});

describe('useConfig', () => {
  it('starts all off, then updates every user of the hook', async () => {
    let resolve!: (v: AppConfig) => void;
    mocked.mockReturnValue(new Promise<AppConfig>((r) => (resolve = r)));
    const seen: LoadedConfig[] = [];
    function Probe() {
      const cfg = useConfig();
      seen.push(cfg);
      return <span>{cfg.telegramBot ?? 'none'}</span>;
    }
    const el = document.createElement('div');
    const root = createRoot(el);
    act(() =>
      root.render(
        <>
          <Probe />
          <Probe />
        </>,
      ),
    );
    expect(el.textContent).toBe('nonenone');
    expect(seen[0]).toEqual({ ...DISABLED_CONFIG, loaded: false });
    await act(async () => {
      resolve({ ai: true, telegramBot: 'rl_bot', inboundEmailDomain: null });
      await Promise.resolve();
    });
    expect(el.textContent).toBe('rl_botrl_bot');
    expect(seen[seen.length - 1]).toEqual({ ai: true, telegramBot: 'rl_bot', inboundEmailDomain: null, loaded: true });
    expect(mocked).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
