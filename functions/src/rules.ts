/**
 * Auto rules (docs/SPEC-2.md §2): `users/{uid}/rules/{id}`
 *   { name, enabled, match: { field, op, value }, actions: { addTags?, categoryId?, location?, favorite?, archive? }, createdAt }
 * Applied once per item, server-side, when the item is first processed (processItem, feed poller, Telegram,
 * email, API). The item then carries `rulesApplied: true`.
 *
 * The matching and patch logic is pure (unit-tested); loadRules/applyRules touch Firestore.
 */
import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { db } from './admin';
import { hostOf, normalizeTags } from './util';

export type RuleField = 'domain' | 'url' | 'title' | 'feed' | 'type' | 'source';
export type RuleOp = 'is' | 'contains' | 'endsWith';

export interface RuleActions {
  addTags?: string[];
  categoryId?: string | null;
  location?: 'library' | 'feed';
  favorite?: boolean;
  archive?: boolean;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  match: { field: RuleField; op: RuleOp; value: string };
  actions: RuleActions;
}

/** Extra facts a rule may need that are not on the item itself. */
export interface RuleContext {
  /** Title of the item's feed (for `field: 'feed'`), when known. */
  feedTitle?: string | null;
}

export type ItemLike = Record<string, unknown>;

const FIELDS: RuleField[] = ['domain', 'url', 'title', 'feed', 'type', 'source'];
const OPS: RuleOp[] = ['is', 'contains', 'endsWith'];

/** Validate a stored rule document (clients write these). Returns null when unusable. */
export function ruleOf(id: string, raw: Record<string, unknown> | undefined): Rule | null {
  if (!raw) return null;
  const m = (raw.match ?? {}) as Record<string, unknown>;
  const a = (raw.actions ?? {}) as Record<string, unknown>;
  const field = m.field as RuleField;
  const op = m.op as RuleOp;
  const value = typeof m.value === 'string' ? m.value.trim() : '';
  if (!FIELDS.includes(field) || !OPS.includes(op) || !value) return null;
  const actions: RuleActions = {};
  const tags = normalizeTags(a.addTags);
  if (tags.length) actions.addTags = tags;
  if (a.categoryId === null || (typeof a.categoryId === 'string' && a.categoryId && !a.categoryId.includes('/'))) actions.categoryId = a.categoryId as string | null;
  if (a.location === 'library' || a.location === 'feed') actions.location = a.location;
  if (typeof a.favorite === 'boolean') actions.favorite = a.favorite;
  if (typeof a.archive === 'boolean') actions.archive = a.archive;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    enabled: raw.enabled !== false,
    match: { field, op, value },
    actions,
  };
}

function compare(op: RuleOp, actual: string, expected: string): boolean {
  if (!actual) return false;
  if (op === 'is') return actual === expected;
  if (op === 'contains') return actual.includes(expected);
  return actual.endsWith(expected);
}

const lc = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Does `rule` match `item`? Comparisons are case-insensitive; disabled rules never match. */
export function matchRule(rule: Rule, item: ItemLike, ctx: RuleContext = {}): boolean {
  if (!rule.enabled) return false;
  const { field, op } = rule.match;
  const value = rule.match.value.trim().toLowerCase();
  if (!value) return false;
  switch (field) {
    case 'domain': {
      const host = hostOf(typeof item.url === 'string' ? item.url : null).toLowerCase();
      const want = value.replace(/^www\./, '');
      // "is example.com" also covers its subdomains (news.example.com).
      if (op === 'is') return !!host && (host === want || host.endsWith(`.${want}`));
      return compare(op, host, want);
    }
    case 'url':
      return compare(op, lc(item.url), value);
    case 'title':
      return compare(op, lc(item.title), value);
    case 'type':
      return compare(op, lc(item.type), value);
    case 'source':
      return compare(op, lc(item.source), value);
    case 'feed': {
      const feedId = typeof item.feedId === 'string' ? item.feedId : '';
      if (!feedId) return false;
      if (op === 'is' && feedId.toLowerCase() === value) return true;
      return compare(op, lc(ctx.feedTitle), value);
    }
    default:
      return false;
  }
}

/** Do any of these rules need the feed title? (Lets callers skip loading the feed doc.) */
export function needsFeedTitle(rules: Rule[]): boolean {
  return rules.some((r) => r.enabled && r.match.field === 'feed');
}

/**
 * Field changes from every matching rule, in order (later rules win for single-valued actions; tags are
 * merged). Returns {} when nothing matches. Does not include `rulesApplied`.
 */
export function rulesPatch(rules: Rule[], item: ItemLike, ctx: RuleContext = {}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const current = Array.isArray(item.tags) ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  let tags = current;
  for (const rule of rules) {
    if (!matchRule(rule, item, ctx)) continue;
    const a = rule.actions;
    if (a.addTags?.length) tags = normalizeTags([...tags, ...a.addTags]);
    if (a.categoryId !== undefined) patch.categoryId = a.categoryId;
    if (a.location) patch.location = a.location;
    if (a.favorite !== undefined) patch.favorite = a.favorite;
    if (a.archive !== undefined) {
      patch.status = a.archive ? 'archived' : 'unread';
      patch.archivedAt = a.archive ? FieldValue.serverTimestamp() : null;
    }
  }
  if (tags !== current && JSON.stringify(tags) !== JSON.stringify(current)) patch.tags = tags;
  return patch;
}

/** New item data with matching rules applied and `rulesApplied: true` (for items created already processed). */
export function withRules(rules: Rule[], data: ItemLike, ctx: RuleContext = {}): ItemLike {
  return { ...data, ...rulesPatch(rules, data, ctx), rulesApplied: true };
}

/** Only items created recently get rules on their first processing (not old items being re-fetched). */
export const NEW_ITEM_WINDOW_MS = 24 * 3_600_000;

/** Should processItem apply rules to this item now? */
export function wantsRules(item: ItemLike, now = Date.now()): boolean {
  if (item.rulesApplied === true) return false;
  const created = item.createdAt;
  if (created instanceof Timestamp) return now - created.toMillis() < NEW_ITEM_WINDOW_MS;
  return true; // not yet resolved server timestamp, or missing: treat as new
}

// ---------------------------------------------------------------------------- Firestore

/** Per-invocation cache: uid → rules. Pass the same Map to load each user's rules once. */
export type RulesCache = Map<string, Promise<Rule[]>>;

const MAX_RULES = 200;

async function readRules(uid: string): Promise<Rule[]> {
  const snap = await db.collection('users').doc(uid).collection('rules').limit(MAX_RULES).get();
  const list = snap.docs
    .map((d) => ({ rule: ruleOf(d.id, d.data()), created: d.get('createdAt') }))
    .filter((x): x is { rule: Rule; created: unknown } => !!x.rule && x.rule.enabled);
  const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0);
  list.sort((a, b) => ms(a.created) - ms(b.created) || a.rule.id.localeCompare(b.rule.id));
  return list.map((x) => x.rule);
}

/** Enabled rules of a user, oldest first. With `cache`, each user's rules are read at most once. */
export function loadRules(uid: string, cache?: RulesCache): Promise<Rule[]> {
  if (!cache) return readRules(uid);
  let p = cache.get(uid);
  if (!p) {
    p = readRules(uid);
    cache.set(uid, p);
    p.catch(() => cache.delete(uid));
  }
  return p;
}

/** Title of a feed, for rules matching on `feed` (null when unknown). */
export async function feedTitleOf(uid: string, feedId: unknown): Promise<string | null> {
  if (typeof feedId !== 'string' || !feedId || feedId.includes('/')) return null;
  const snap = await db.collection('users').doc(uid).collection('feeds').doc(feedId).get();
  const t = snap.get('title');
  return typeof t === 'string' ? t : null;
}

/** Rule context for an item: loads the feed title only when a rule needs it. */
export async function ruleContext(uid: string, rules: Rule[], item: ItemLike): Promise<RuleContext> {
  if (!needsFeedTitle(rules) || !item.feedId) return {};
  return { feedTitle: await feedTitleOf(uid, item.feedId).catch(() => null) };
}

/**
 * Apply the user's rules to an existing item once (no-op when it already has `rulesApplied`).
 * Returns the patch that was written ({} when nothing was written). Errors are logged, not thrown.
 */
export async function applyRules(uid: string, itemRef: DocumentReference, item: ItemLike, cache?: RulesCache): Promise<Record<string, unknown>> {
  if (item.rulesApplied === true) return {};
  try {
    const rules = await loadRules(uid, cache);
    const ctx = await ruleContext(uid, rules, item);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists || snap.get('rulesApplied') === true) return {};
      const patch = { ...rulesPatch(rules, snap.data() ?? {}, ctx), rulesApplied: true };
      tx.update(itemRef, { ...patch, updatedAt: FieldValue.serverTimestamp() });
      return patch;
    });
  } catch (e) {
    logger.warn('applying rules failed', { uid, itemId: itemRef.id, error: (e as Error).message });
    return {};
  }
}
