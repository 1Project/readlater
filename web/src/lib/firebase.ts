import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  type Firestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';

export const REGION = 'us-central1';
export const USE_EMULATORS = import.meta.env.VITE_USE_EMULATORS === '1' || import.meta.env.VITE_USE_EMULATORS === 'true';
const EMULATOR_HOST = (import.meta.env.VITE_EMULATOR_HOST as string | undefined) || '127.0.0.1';

export interface Services {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
  storage: FirebaseStorage;
}

let services: Services | null = null;

async function loadConfig(): Promise<FirebaseOptions> {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
  if (raw) return JSON.parse(raw) as FirebaseOptions;
  if (USE_EMULATORS) {
    return {
      apiKey: 'demo-key',
      authDomain: 'demo-readlater.firebaseapp.com',
      projectId: 'demo-readlater',
      storageBucket: 'demo-readlater.appspot.com',
      appId: '1:000000000000:web:0000000000000000',
    };
  }
  // Served automatically by Firebase Hosting.
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Missing Firebase config (set VITE_FIREBASE_CONFIG)');
  return (await res.json()) as FirebaseOptions;
}

/** Initialise Firebase once. Must be awaited before getServices(). */
export async function initFirebase(): Promise<Services> {
  if (services) return services;
  const config = await loadConfig();
  const app = initializeApp(config);

  let auth: Auth;
  try {
    // initializeAuth() without a popupRedirectResolver makes signInWithPopup/getRedirectResult fail (auth/argument-error).
    auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver });
  } catch {
    auth = getAuth(app);
  }

  let db: Firestore;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch {
    db = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  }

  const functions = getFunctions(app, REGION);
  const storage = getStorage(app);

  if (USE_EMULATORS) {
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
    connectFunctionsEmulator(functions, EMULATOR_HOST, 5001);
    connectStorageEmulator(storage, EMULATOR_HOST, 9199);
  }

  services = { app, auth, db, functions, storage };
  return services;
}

export function getServices(): Services {
  if (!services) throw new Error('initFirebase() has not completed');
  return services;
}

/** Public origin of the hosted web app (used for native hand-off, bookmarklet, shortcuts). */
export function publicUrl(): string {
  const env = import.meta.env.VITE_PUBLIC_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  const origin = window.location.origin;
  // Inside Capacitor the origin is http://localhost or capacitor://localhost — not useful.
  if (/^(capacitor|ionic):|^https?:\/\/localhost(:\d+)?$/.test(origin) && services?.app.options.projectId) {
    return `https://${services.app.options.projectId}.web.app`;
  }
  return origin;
}
