import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks -----------------------------------------------------------------

const h = vi.hoisted(() => {
  const state = {
    native: true,
    platform: 'android',
    appUrlListener: null as null | ((e: { url: string }) => void),
    sharedListener: null as null | ((p: unknown) => void),
    pending: {} as unknown,
  };
  const plugin = {
    getPending: vi.fn(async () => {
      const p = state.pending;
      state.pending = {};
      return p;
    }),
    setReaderActive: vi.fn(async () => {}),
    addListener: vi.fn(async (_e: string, fn: (p: unknown) => void) => {
      state.sharedListener = fn;
      return { remove: async () => {} };
    }),
  };
  return {
    state,
    plugin,
    browserOpen: vi.fn(async () => {}),
    browserClose: vi.fn(async () => {}),
    redeemLoginCode: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => 'item123'),
    toast: vi.fn(),
    setStyle: vi.fn(async () => {}),
    auth: { currentUser: { uid: 'u1' } as unknown, authStateReady: vi.fn(async () => {}) },
  };
});

vi.mock('@capacitor/core', () => {
  class WebPlugin {}
  return {
    WebPlugin,
    Capacitor: {
      isNativePlatform: () => h.state.native,
      getPlatform: () => h.state.platform,
      isPluginAvailable: () => true,
      convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p}`,
    },
    registerPlugin: () => h.plugin,
    SystemBars: { setStyle: h.setStyle },
    SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' },
  };
});
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_e: string, fn: (e: { url: string }) => void) => {
      h.state.appUrlListener = fn;
      return { remove: async () => {} };
    }),
  },
}));
vi.mock('@capacitor/browser', () => ({ Browser: { open: h.browserOpen, close: h.browserClose } }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: vi.fn(() => () => {}) }));
vi.mock('./components/Toast', () => ({ toast: h.toast, dismissToast: vi.fn() }));
vi.mock('./lib/firebase', () => ({
  getServices: () => ({ auth: h.auth }),
  publicUrl: () => 'https://readlater.example',
}));
vi.mock('./lib/data', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./lib/data');
  return { extractUrl: actual.extractUrl, redeemLoginCode: h.redeemLoginCode, uploadFile: h.uploadFile };
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function load() {
  vi.resetModules();
  delete (window as { __readerActive?: boolean }).__readerActive;
  return import('./native');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.native = true;
  h.state.platform = 'android';
  h.state.appUrlListener = null;
  h.state.sharedListener = null;
  h.state.pending = {};
});

// --- tests -----------------------------------------------------------------

describe('native.ts on the web', () => {
  it('does nothing in initNative and opens links in a new tab', async () => {
    h.state.native = false;
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    expect(native.isNative()).toBe(false);
    expect(h.plugin.addListener).not.toHaveBeenCalled();
    expect(h.state.appUrlListener).toBeNull();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await native.openExternal('https://example.com/');
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    expect(h.browserOpen).not.toHaveBeenCalled();
  });
});

describe('native.ts in the app', () => {
  it('redeems readlater://login codes once, with the verifier of the sign-in it started, and goes home', async () => {
    localStorage.clear();
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    await native.nativeGoogleSignIn();
    const opened = new URL((h.browserOpen.mock.calls[0] as unknown as [{ url: string }])[0].url);
    const challenge = opened.searchParams.get('challenge')!;
    h.state.appUrlListener!({ url: 'readlater://login?code=ABCD-2345' });
    await flush();
    await flush();
    expect(h.redeemLoginCode).toHaveBeenCalledWith('ABCD-2345', expect.any(String));
    const verifier = (h.redeemLoginCode.mock.calls[0] as unknown as [string, string])[1];
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await native.pkceChallenge(verifier)).toBe(challenge);
    expect(navigate).toHaveBeenCalledWith('/');
    h.state.appUrlListener!({ url: 'readlater://login?code=ABCD-2345' });
    h.state.appUrlListener!({ url: 'content://downloads/1' });
    await flush();
    expect(h.redeemLoginCode).toHaveBeenCalledTimes(1);
  });

  it('ignores login links when the app did not start a sign-in (no silent account switch)', async () => {
    localStorage.clear();
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    h.state.appUrlListener!({ url: 'readlater://login?code=EVIL-2345' });
    await flush();
    expect(h.redeemLoginCode).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // A sign-in started long ago has expired as well.
    localStorage.setItem('rl.nativeSignIn', JSON.stringify({ verifier: 'v'.repeat(43), at: Date.now() - 60 * 60_000 }));
    h.state.appUrlListener!({ url: 'readlater://login?code=LATE-2345' });
    await flush();
    expect(h.redeemLoginCode).not.toHaveBeenCalled();
  });

  it('stays on /login after signing in, so the page continues to its `next`', async () => {
    localStorage.clear();
    window.history.replaceState(null, '', '/login?next=%2Fadd%3Furl%3Dx');
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    await native.nativeGoogleSignIn();
    h.state.appUrlListener!({ url: 'readlater://login?code=NEXT-2345' });
    await flush();
    await flush();
    expect(h.redeemLoginCode).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    window.history.replaceState(null, '', '/');
  });

  it('sends a failed sign-in back to the login page', async () => {
    h.redeemLoginCode.mockRejectedValueOnce(new Error('Invalid or expired code'));
    localStorage.clear();
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    await native.nativeGoogleSignIn();
    h.state.appUrlListener!({ url: 'readlater://login?code=ZZZZ' });
    await flush();
    await flush();
    expect(navigate).toHaveBeenCalledWith('/login');
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('Invalid or expired code'), { error: true });
  });

  it('opens shared links in /add with the subject as title', async () => {
    h.state.pending = { type: 'text', text: 'Look at this https://example.com/post?a=1 !', subject: 'A post' };
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    expect(navigate).toHaveBeenCalledWith(`/add?url=${encodeURIComponent('https://example.com/post?a=1')}&title=A%20post`);
    // /add may save it without asking (that URL only).
    expect(native.takeTrustedShare('https://other.example/')).toBe(false);
    expect(native.takeTrustedShare('https://example.com/post?a=1')).toBe(true);

    h.state.sharedListener!({ type: 'text', text: 'just a thought' });
    await flush();
    expect(navigate).toHaveBeenLastCalledWith('/add?text=just%20a%20thought');
  });

  it('uploads shared files and opens the new item', async () => {
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }));
    vi.stubGlobal('fetch', fetchMock);
    h.state.pending = { type: 'file', name: 'paper.pdf', mimeType: 'application/pdf', path: '/data/cache/shared/1/paper.pdf', size: 8 };
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('https://localhost/_capacitor_file_/data/cache/shared/1/paper.pdf');
    expect(h.uploadFile).toHaveBeenCalledWith(blob, 'paper.pdf', expect.any(Object));
    expect(navigate).toHaveBeenCalledWith('/item/item123');
    vi.unstubAllGlobals();
  });

  it('refuses a shared file whose bytes do not match its declared type', async () => {
    const blob = new Blob(['SQLite format 3\u0000'], { type: 'application/pdf' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob })));
    h.state.pending = { type: 'file', name: 'cache.pdf', mimeType: 'application/pdf', path: '/data/cache/shared/2/cache.pdf', size: 16 };
    const native = await load();
    native.initNative(vi.fn());
    await flush();
    await flush();
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('not a PDF or EPUB'), { error: true });
    vi.unstubAllGlobals();
    const epub = new Blob([new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(26).fill(0)]), 'mimetypeapplication/epub+zip']);
    expect(await native.looksLike(epub, 'application/epub+zip')).toBe(true);
    expect(await native.looksLike(epub, 'application/pdf')).toBe(false);
  });

  it('mirrors window.__readerActive to the native plugin', async () => {
    const native = await load();
    native.initNative(vi.fn());
    await flush();
    expect(h.plugin.setReaderActive).toHaveBeenLastCalledWith({ active: false });
    window.__readerActive = true;
    expect(window.__readerActive).toBe(true);
    expect(h.plugin.setReaderActive).toHaveBeenLastCalledWith({ active: true });
    native.setReaderActive(false);
    expect(h.plugin.setReaderActive).toHaveBeenLastCalledWith({ active: false });
    expect(h.plugin.setReaderActive).toHaveBeenCalledTimes(3);
  });

  it('opens the Google sign-in hand-off in the system browser, with a PKCE challenge', async () => {
    const native = await load();
    await native.nativeGoogleSignIn();
    expect(h.browserOpen).toHaveBeenCalledWith({
      url: expect.stringMatching(/^https:\/\/readlater\.example\/app-login\?return=readlater%3A%2F%2Flogin&challenge=[A-Za-z0-9_-]{43}$/),
    });
  });
});
