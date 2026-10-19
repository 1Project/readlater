/**
 * Server feature flags (docs/SPEC-2.md §8), fetched once per session from the `getConfig` callable.
 *
 * Exports:
 *   useConfig(): LoadedConfig          { ai, telegramBot, inboundEmailDomain, loaded } — all off until loaded
 *   loadConfig(): Promise<AppConfig>   the shared request (never rejects; a failure counts as "all off")
 *   DISABLED_CONFIG                    the all-off value
 *   normalizeConfig(raw): AppConfig    defensive parsing of the callable's response
 *   REPO_URL                           source repository (extension install links); VITE_REPO_URL overrides
 *   resetConfigCache()                 tests only
 *
 * A successful answer is also kept in sessionStorage so reloads within the tab don't call the server again.
 * A failure is not stored there, so the next session tries again.
 */
import { useSyncExternalStore } from 'react';
import { getAppConfig } from './data';
import type { AppConfig } from './types';

export interface LoadedConfig extends AppConfig {
  /** false until the server answered (or failed). */
  loaded: boolean;
}

export const DISABLED_CONFIG: AppConfig = Object.freeze({ ai: false, telegramBot: null, inboundEmailDomain: null });

export const REPO_URL = ((import.meta.env.VITE_REPO_URL as string | undefined) || 'https://github.com/1Project/readlater').replace(/\/$/, '');

const STORAGE_KEY = 'rl.config';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function normalizeConfig(raw: unknown): AppConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ai: r.ai === true,
    telegramBot: str(r.telegramBot)?.replace(/^@/, '') ?? null,
    inboundEmailDomain: str(r.inboundEmailDomain)?.replace(/^@/, '') ?? null,
  };
}

let snapshot: LoadedConfig = { ...DISABLED_CONFIG, loaded: false };
let request: Promise<AppConfig> | null = null;
const listeners = new Set<() => void>();

function publish(cfg: AppConfig) {
  snapshot = { ...cfg, loaded: true };
  listeners.forEach((l) => l());
}

function readStored(): AppConfig | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? normalizeConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function loadConfig(): Promise<AppConfig> {
  if (request) return request;
  const stored = readStored();
  if (stored) {
    publish(stored);
    request = Promise.resolve(stored);
    return request;
  }
  request = getAppConfig()
    .then((raw) => {
      const cfg = normalizeConfig(raw);
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      } catch {
        /* storage unavailable */
      }
      return cfg;
    })
    .catch((e: unknown) => {
      console.warn('getConfig failed; optional features are hidden', e);
      return DISABLED_CONFIG;
    })
    .then((cfg) => {
      publish(cfg);
      return cfg;
    });
  return request;
}

/** Feature flags; everything is off until the server answers. Triggers the (single) request on first use. */
export function useConfig(): LoadedConfig {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      void loadConfig();
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

export function resetConfigCache(): void {
  request = null;
  snapshot = { ...DISABLED_CONFIG, loaded: false };
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
