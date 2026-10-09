#!/usr/bin/env node
// Reads `firebase apps:sdkconfig WEB <appId> --json` output on stdin and prints the web config as one-line
// JSON ({apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, ...}). Exits 1 on failure.
// Used by scripts/setup.sh and .github/workflows/deploy.yml.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const config = parse(input);
    if (!config || typeof config.apiKey !== 'string' || typeof config.projectId !== 'string') {
      throw new Error('no apiKey/projectId in the sdkconfig output');
    }
    process.stdout.write(JSON.stringify(config));
  } catch (e) {
    console.error(`sdkconfig: ${e.message}`);
    process.exit(1);
  }
});

export function parse(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON in input');
  const json = JSON.parse(text.slice(start));
  const result = json.result ?? json;
  if (result.sdkConfig && typeof result.sdkConfig === 'object') return clean(result.sdkConfig);
  if (typeof result.fileContents === 'string') return clean(fromFileContents(result.fileContents));
  if (result.apiKey) return clean(result);
  throw new Error(json.error || 'unexpected sdkconfig output');
}

function fromFileContents(contents) {
  const s = contents.indexOf('{');
  const e = contents.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('no config object in fileContents');
  const body = contents.slice(s, e + 1);
  try {
    return JSON.parse(body);
  } catch {
    // JS object literal (unquoted keys) as printed by older firebase-tools versions.
    return JSON.parse(body.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/,\s*}/g, '}'));
  }
}

function clean(cfg) {
  const out = {};
  for (const k of ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId', 'databaseURL']) {
    if (typeof cfg[k] === 'string' && cfg[k]) out[k] = cfg[k];
  }
  return out;
}
