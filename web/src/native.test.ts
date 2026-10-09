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
  it('redeems readlater://login codes once and goes home', async () => {
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    h.state.appUrlListener!({ url: 'readlater://login?code=ABCD-2345' });
    await flush();
    expect(h.redeemLoginCode).toHaveBeenCalledWith('ABCD-2345');
    expect(navigate).toHaveBeenCalledWith('/');
    h.state.appUrlListener!({ url: 'readlater://login?code=ABCD-2345' });
    h.state.appUrlListener!({ url: 'content://downloads/1' });
    await flush();
    expect(h.redeemLoginCode).toHaveBeenCalledTimes(1);
  });

  it('sends a failed sign-in back to the login page', async () => {
    h.redeemLoginCode.mockRejectedValueOnce(new Error('Invalid or expired code'));
    const native = await load();
    const navigate = vi.fn();
    native.initNative(navigate);
    await flush();
    h.state.appUrlListener!({ url: 'readlater://login?code=ZZZZ' });
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

  it('opens the Google sign-in hand-off in the system browser', async () => {
    const native = await load();
    await native.nativeGoogleSignIn();
    expect(h.browserOpen).toHaveBeenCalledWith({
      url: 'https://readlater.example/app-login?return=readlater%3A%2F%2Flogin',
    });
  });
});
