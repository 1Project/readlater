import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Android / iOS apps. The web build (`dist/`) is bundled
 * into the apps; the app talks to Firebase directly (config baked in at build time
 * via VITE_FIREBASE_CONFIG / VITE_PUBLIC_URL). No splash-screen plugin is used, so
 * launch is a plain white screen (e-ink friendly, no animation).
 */
const config: CapacitorConfig = {
  appId: 'app.readlater.reader',
  appName: 'Readlater',
  webDir: 'dist',
  server: {
    // Serve the bundled app from https://localhost (secure context; Firebase Auth works).
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
