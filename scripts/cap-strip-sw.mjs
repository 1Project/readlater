#!/usr/bin/env node
// Capacitor `capacitor:copy:after` hook (see web/package.json): removes the PWA service worker and the
// source maps from the web assets copied into the native projects. The apps load their bundled files from
// disk, so a service worker only adds stale caches after app updates; source maps only add size.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.CAPACITOR_ROOT_DIR || process.cwd());
const platform = process.env.CAPACITOR_PLATFORM_NAME || process.argv[2];
const dirs = {
  android: join(root, 'android', 'app', 'src', 'main', 'assets', 'public'),
  ios: join(root, 'ios', 'App', 'App', 'public'),
};
// Capacitor also runs the hook for the "web" platform; only native copies are touched.
const targets = platform ? (dirs[platform] ? [dirs[platform]] : []) : Object.values(dirs);

for (const dir of targets) {
  if (!existsSync(dir)) continue;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (/^(sw\.js|registerSW\.js|workbox-[\w-]+\.js)(\.map)?$/.test(f)) {
      rmSync(join(dir, f));
      removed++;
    }
  }
  let maps = 0;
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.map')) {
        rmSync(p);
        maps++;
      }
    }
  };
  walk(dir);
  const index = join(dir, 'index.html');
  if (existsSync(index)) {
    const html = readFileSync(index, 'utf8');
    const out = html.replace(/<script[^>]*registerSW\.js[^>]*><\/script>\s*/g, '');
    if (out !== html) writeFileSync(index, out);
  }
  console.log(`[cap-strip-sw] ${dir}: removed ${removed} service-worker file(s) and ${maps} source map(s)`);
}
