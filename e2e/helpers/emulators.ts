/** Direct access to the emulators (ports from firebase.json) for test setup and assertions. */
export const PROJECT_ID = 'demo-readlater';
export const HOSTING = 'http://127.0.0.1:5000';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`;
const FIRESTORE = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${url} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export interface TestUser {
  uid: string;
  idToken: string;
}

/** Create a fresh email/password user in the Auth emulator. */
export async function createUser(): Promise<TestUser> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const r = await postJson<{ localId: string; idToken: string }>(`${AUTH}/accounts:signUp?key=demo-key`, {
    email,
    password: 'e2e-password',
    returnSecureToken: true,
  });
  return { uid: r.localId, idToken: r.idToken };
}

/** Call an onCall function with the callable HTTP protocol. */
export async function callFunction<T>(name: string, data: unknown, user?: TestUser): Promise<T> {
  const r = await postJson<{ result: T }>(`${FUNCTIONS}/${name}`, { data }, user?.idToken);
  return r.result;
}

type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

function decode(v: FsValue): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  return undefined;
}

function decodeFields(fields: Record<string, FsValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decode(v)]));
}

/** Read a document with admin privileges (the emulator's `owner` token bypasses security rules). */
export async function getDoc(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${FIRESTORE}/${path}`, { headers: { authorization: 'Bearer owner' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { fields?: Record<string, FsValue> };
  return decodeFields(json.fields ?? {});
}

/** List a collection with admin privileges: [{ id, data }]. */
export async function listDocs(path: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const out: { id: string; data: Record<string, unknown> }[] = [];
  let pageToken = '';
  do {
    const res = await fetch(`${FIRESTORE}/${path}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: { authorization: 'Bearer owner' } });
    if (!res.ok) throw new Error(`LIST ${path} → ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { documents?: { name: string; fields?: Record<string, FsValue> }[]; nextPageToken?: string };
    for (const d of json.documents ?? []) out.push({ id: d.name.split('/').pop()!, data: decodeFields(d.fields ?? {}) });
    pageToken = json.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

/** Poll until `check` returns a truthy value (returned), or fail after `timeout` ms. */
export async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}
