# Readlater on Android, Boox and iOS

The mobile apps are the web app (`web/`) wrapped with [Capacitor 8](https://capacitorjs.com).
The bundled web build talks to your Firebase project directly, so build the apps **after**
`scripts/setup.sh` has written `web/.env.production` (or export `VITE_FIREBASE_CONFIG` and
`VITE_PUBLIC_URL` yourself).

| | |
|---|---|
| App id | `app.readlater.reader` |
| URL scheme | `readlater://` (`readlater://login?code=…` finishes sign-in) |
| Native projects | `web/android/`, `web/ios/` (committed; regenerate assets with `npx cap sync`) |
| JS bridge | `web/src/native.ts` |
| Android plugin | `web/android/app/src/main/java/app/readlater/reader/ShareIntentPlugin.java` |
| Icons | `scripts/generate-icons.sh` (sources in `web/public/icon.svg`, `web/resources/*.svg`) |

## Android

### Build the APK

Requirements: Node.js 22, JDK 21, the Android SDK (Android Studio, or only the
[command-line tools](https://developer.android.com/studio#command-line-tools-only) with
`ANDROID_HOME` pointing at the SDK).

```bash
scripts/build-android.sh
# → web/android/app/build/outputs/apk/debug/app-debug.apk
```

The script checks Java and the SDK (installing the missing platform / build tools with `sdkmanager`
when it can), builds the web app, runs `npx cap sync android` and `./gradlew assembleDebug`.
`--skip-web` reuses an existing `web/dist`.

Debug APKs are signed with the key committed at `web/android/app/debug.keystore`, so an APK built on
any machine or by CI installs over a previous one. The version code is the number of minutes since
2024‑01‑01, so newer builds always upgrade older ones (override with `READLATER_VERSION_CODE` /
`READLATER_VERSION_NAME`).

**Release signing (optional).** Create a keystore once and keep it safe — every later update must be
signed with the same key:

```bash
keytool -genkeypair -v -keystore readlater-release.jks -alias readlater \
  -keyalg RSA -keysize 2048 -validity 10000
export READLATER_KEYSTORE=$PWD/readlater-release.jks READLATER_KEYSTORE_PASSWORD=… READLATER_KEY_ALIAS=readlater
scripts/build-android.sh            # also builds app/build/outputs/apk/release/app-release.apk
```

Note that Android refuses to update an app signed with a different key: switching from the debug
build to a release-signed build (or back) needs one uninstall.

**From GitHub.** CI (`.github/workflows/ci.yml`) uploads `readlater-debug.apk` as a workflow artifact
for every push. `deploy.yml` attaches a release-signed APK built against your deployed project to a GitHub Release
(`build-<n>`) after each deploy of `main`, once the secrets `ANDROID_KEYSTORE_BASE64`
(`base64 -w0 readlater-release.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and optionally
`ANDROID_KEY_PASSWORD` are set. Without them nothing is published: debug APKs are debuggable and signed with
the key committed to this repository, so anyone could sign an "update" that replaces them — use those for
testing only.

### Install on a Boox (Go 6 or any Android 11+ e-reader)

1. Get the APK onto the device — either open the GitHub Release page in the Boox browser and download
   it, or connect the Boox by USB and copy it to `Download/`, or `adb install -r readlater.apk`
   (enable *Settings → About → tap Build number 7×*, then *Developer options → USB debugging*).
2. Open the APK with the Boox file manager (*Storage*). The first time, Android asks to allow
   installing from that app: *Settings → Apps → Special app access → Install unknown apps →*
   the file manager or browser *→ Allow*. Go back and tap *Install*.
3. Recommended per-app settings (long-press the Readlater icon → *Optimize* / *E-Ink Center*):
   - **Refresh mode:** *Regal* (or *HD*) for reading — sharp text, little ghosting. Use *Balanced* /
     *Fast* if you scroll lists a lot; the reader's paginated mode needs no fast refresh.
   - **DPI:** raise it (e.g. 360–420) if you want larger UI, or leave the default and change the reader
     font size with the reader's *Text settings* button.
   - **Contrast / text enhancement:** a light boost helps with thin serif fonts.
   - Turn off the app's *animations* if offered. Readlater itself has no animations in the *E‑ink*
     theme; you can also set *Developer options → Window/Transition/Animator animation scale → off*.
4. In Readlater: *Settings → Appearance → E-ink* (pure black on white, no transitions, larger tap
   targets, paginated reader by default).

**Turning pages.** In the reader, tap the right third of the page for next, left third for previous,
middle to show the toolbar. Volume keys and Bluetooth page-turn remotes work too: while an article
is open, *volume down / page down* turn forward and *volume up / page up* turn back (outside the reader
the keys keep their normal function). Remotes that send arrow keys work as well.

### Saving from other apps

Readlater appears in the Android share sheet as **Save to Readlater**:

- **Links / text** (browser, RSS reader, X, …) → the first link is saved; *Saved ✓* then offers *Read now*,
  *Add tags* and *Done* (back to the app you shared from). Text without a link opens the *Add* form pre-filled.
- **PDF / EPUB files** (share, or *Open with → Readlater* from a file manager or e-mail attachment)
  → checked to really be a PDF / EPUB, uploaded to your library (≤ 100 MB) and opened in the reader, which shows the text once it has
  been processed. If you are signed out, sign in first; the upload starts right after.

### Signing in inside the app

- **Continue with Google** opens your browser at `<your site>/app-login`. Sign in there and tap
  *Sign in to the app as …*; the page creates a one-time code and sends you back to the app via
  `readlater://login?code=…`, which signs the app in. The code only works together with a secret the app
  kept when it opened the page, and the app ignores sign-in links it did not ask for. (Some browsers ask "Open in Readlater?" — confirm.) Google does not allow its sign-in
  inside embedded web views, which is why the browser is used.
- **Enter code from another device**: on a signed-in device open *Settings → Link a device*, then type
  the 8-character code (or scan the QR code with the device's camera, which opens `/link?code=…`).
  Useful on e-readers without a good browser.

## iOS

Requirements: a Mac with Xcode 16 or newer, an Apple ID (a free one runs on your own device for 7 days
per install; a paid developer account for longer or TestFlight). Dependencies use Swift Package
Manager — no CocoaPods.

```bash
cd web
npm ci
npm run build          # uses web/.env.production
npx cap sync ios       # copies dist/ into ios/App/App/public and updates Package.swift
npx cap open ios       # opens web/ios/App/App.xcodeproj
```

In Xcode select the **App** target → *Signing & Capabilities* → choose your *Team*; if the bundle id
`app.readlater.reader` is taken for your team, change it to something unique (e.g.
`com.yourname.readlater`). Pick your iPhone/iPad (connected by cable, with *Developer Mode* enabled in
*Settings → Privacy & Security*) and press *Run*. The first launch needs *Settings → General → VPN &
Device Management → trust* your developer certificate.

The `readlater://` URL scheme is registered in `ios/App/App/Info.plist`, so Google sign-in works the
same way as on Android (the sign-in sheet closes itself after the hand-off).

**Saving from Safari and other apps** uses an iOS Shortcut instead of a share extension:

1. In Readlater open *Settings → Saving from anywhere → API keys* and create a key (shown once).
2. Create a Shortcut (*Settings → Saving from anywhere → iPhone & iPad (Shortcut)* shows the exact
   steps with your site's address): *Receive URLs and Safari
   web pages from Share Sheet* → *Get contents of* `https://<your site>/api/save`, method **POST**,
   header `Authorization: Bearer <key>`, JSON body `url` = *Shortcut Input* → *Show notification*
   "Saved". Turn on *Show in Share Sheet*.
3. Share any page → *Shortcuts* → your shortcut. PDFs and EPUBs can be added from the app's *+ Add*
   (Files picker).

CI builds the iOS project for the simulator without signing on every push (`ios` job), so breakage
shows up even if you never open Xcode.

## Maintenance

- After changing web code: `npm run build && npx cap sync` (or just `scripts/build-android.sh`).
  `cap sync` runs `scripts/cap-strip-sw.mjs`, which removes the PWA service worker and source maps from
  the copies in the native projects (the apps load their files from disk; a service worker would only
  serve stale caches after an update).
- After adding a Capacitor plugin: `npm install @capacitor/<plugin>` in `web/`, then `npx cap sync`.
- Icons: edit the SVGs and run `scripts/generate-icons.sh` (needs Chrome/Chromium and ImageMagick).
  The Android adaptive icon is the vector `res/drawable/ic_launcher_foreground.xml` on white.
- Upgrading Capacitor: `npm i @capacitor/{core,android,ios,cli}@latest` and follow the migration
  guide; the custom native code is limited to `MainActivity.java`, `ShareIntentPlugin.java`,
  `SharedFiles.java`, `AndroidManifest.xml`, the resource files and `Info.plist`.

## Troubleshooting

| Problem | Fix |
|---|---|
| App shows "Could not start: Missing Firebase config" | The web build had no `VITE_FIREBASE_CONFIG`. Run `scripts/setup.sh` (writes `web/.env.production`) and rebuild. |
| Google sign-in returns to the browser, not the app | Make sure the app is installed and is the latest build (the `readlater://` intent filter); some Boox browsers block custom-scheme redirects — use *Enter code from another device* instead. |
| "App not installed" when updating | The new APK is signed with a different key (debug vs. release). Uninstall once, then install. |
| Volume keys change the volume in the reader | Update the app; check that the reader is open (not the list). Some remotes send arrow keys instead, which also work. |
| Gradle cannot find the SDK | Set `ANDROID_HOME`, or write `sdk.dir=/path/to/sdk` into `web/android/local.properties`. |
