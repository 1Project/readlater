/**
 * Playwright global setup: builds the app and starts the Firebase emulators unless they are already running.
 *
 * - Builds functions (tsc → functions/lib) and the web app in emulator mode (VITE_USE_EMULATORS=1 → web/dist),
 *   which the Hosting emulator serves on :5000. Skip with E2E_SKIP_BUILD=1 (e.g. when re-running against a
 *   build you just made).
 * - If every emulator port answers, the running emulators are reused and left running afterwards
 *   (`npm run emulators` in another terminal makes repeated runs fast). Otherwise `firebase emulators:start`
 *   is spawned and stopped again in the returned teardown.
 * - functions/.env.local (read only by the emulator, gitignored) is created here and removed again in teardown.
 *   It switches on the optional integrations with test settings (helpers/integrations.ts: a Telegram bot, an
 *   inbound email domain and an Anthropic key, with the Telegram and Anthropic APIs pointed at local fakes).
 *   Behind an outbound HTTP proxy (HTTPS_PROXY set) it also hands the proxy to the functions: the firebase CLI
 *   must not see the proxy variables (it would send its own calls to the local emulators through the proxy),
 *   but the functions need them to fetch pages. An existing functions/.env.local is left alone (the
 *   integration tests then skip what it does not configure).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ID } from './helpers/emulators';
import { FUNCTIONS_TEST_ENV } from './helpers/integrations';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = { auth: 9099, firestore: 8080, functions: 5001, storage: 9199, hosting: 5000 };
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_HTTP_PROXY', 'npm_config_https_proxy', 'npm_config_proxy'];
const START_TIMEOUT_MS = 180_000;

function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    s.setTimeout(1000);
    s.once('connect', () => {
      s.destroy();
      done(true);
    });
    s.once('timeout', () => {
      s.destroy();
      done(false);
    });
    s.once('error', () => done(false));
  });
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  console.log(`[e2e] ${cmd} ${args.join(' ')}  (in ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${r.status}`);
}

function build(): void {
  if (process.env.E2E_SKIP_BUILD === '1') {
    console.log('[e2e] E2E_SKIP_BUILD=1: using the existing functions/lib and web/dist');
    return;
  }
  run('npm', ['run', 'build'], join(ROOT, 'functions'));
  run('npm', ['run', 'build:emu'], join(ROOT, 'web'));
}

/** Resolves when the functions emulator has loaded the code (the `api` function answers through Hosting). */
async function waitUntilReady(child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`firebase emulators:start exited early (code ${child.exitCode}):\n${log().slice(-4000)}`);
    if (/All emulators ready/.test(log())) {
      const open = await Promise.all(Object.values(PORTS).map(portOpen));
      if (open.every(Boolean)) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Emulators did not start within ${START_TIMEOUT_MS / 1000} s:\n${log().slice(-4000)}`);
}

function firebaseBin(): string {
  const local = join(ROOT, 'node_modules', '.bin', 'firebase');
  return existsSync(local) ? local : 'firebase';
}

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  const open = await Promise.all(Object.entries(PORTS).map(async ([name, port]) => [name, await portOpen(port)] as const));
  if (open.every(([, up]) => up)) {
    console.log('[e2e] Emulators already running; reusing them.');
    if (process.env.E2E_BUILD_WHEN_REUSING === '1') build();
    return;
  }
  const busy = open.filter(([, up]) => up).map(([name]) => `${name} (:${PORTS[name as keyof typeof PORTS]})`);
  if (busy.length) throw new Error(`Some emulator ports are in use but not all emulators are running: ${busy.join(', ')}. Stop that process and retry.`);

  build();

  const env: NodeJS.ProcessEnv = { ...process.env };
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  for (const k of PROXY_VARS) delete env[k];

  const envLocal = join(ROOT, 'functions', '.env.local');
  let createdEnvLocal = false;
  if (!existsSync(envLocal)) {
    const lines = ['# Written by e2e/global-setup.ts for the functions emulator; removed after the run.'];
    if (proxy) {
      // The local fakes (Telegram, Anthropic) and the emulators are reached directly.
      const noProxy = [process.env.NO_PROXY || process.env.no_proxy || '', 'localhost', '127.0.0.1'].filter(Boolean).join(',');
      lines.push(`HTTPS_PROXY=${proxy}`, `NO_PROXY=${noProxy}`);
    }
    for (const [k, v] of Object.entries(FUNCTIONS_TEST_ENV)) lines.push(`${k}=${v}`);
    writeFileSync(envLocal, `${lines.join('\n')}\n`);
    createdEnvLocal = true;
  } else if (proxy && !/^HTTPS_PROXY=/m.test(readFileSync(envLocal, 'utf8'))) {
    console.warn('[e2e] functions/.env.local exists without HTTPS_PROXY; functions may not reach the internet through the proxy.');
  }

  console.log('[e2e] Starting Firebase emulators…');
  let output = '';
  const child = spawn(firebaseBin(), ['emulators:start', '--project', PROJECT_ID], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (b: Buffer) => {
    output += b.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
    if (process.env.E2E_EMULATOR_LOGS === '1') process.stdout.write(b);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const stop = async () => {
    if (child.exitCode === null && child.pid) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {
        /* already gone */
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 20_000);
      await exited;
      clearTimeout(timer);
    }
    if (createdEnvLocal && existsSync(envLocal)) unlinkSync(envLocal);
  };

  try {
    await waitUntilReady(child, () => output);
  } catch (e) {
    await stop();
    throw e;
  }
  console.log('[e2e] Emulators ready.');
  return async () => {
    console.log('[e2e] Stopping emulators…');
    await stop();
  };
}
