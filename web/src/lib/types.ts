import type { Timestamp } from 'firebase/firestore';

export type ItemType = 'article' | 'tweet' | 'paper' | 'pdf' | 'epub' | 'video' | 'other';
export type ItemLocation = 'library' | 'feed';
export type ItemStatus = 'unread' | 'archived';
export type FetchStatus = 'uploading' | 'pending' | 'processing' | 'done' | 'error';
/** How an item was saved (SPEC-2 §2). Set by the client on create, or by the server. */
export type ItemSource = 'web' | 'app' | 'extension' | 'bookmarklet' | 'api' | 'telegram' | 'email' | 'feed' | 'import';
export const ITEM_SOURCES: ItemSource[] = ['web', 'app', 'extension', 'bookmarklet', 'api', 'telegram', 'email', 'feed', 'import'];

export interface StoredFile {
  path: string;
  name: string;
  contentType: string;
  size: number;
}

export interface PaperMeta {
  arxivId?: string;
  doi?: string;
  authors?: string[];
  venue?: string;
  year?: number;
  pdfUrl?: string;
  abstract?: string;
}

export interface Item {
  id: string;
  url: string | null;
  type: ItemType;
  location: ItemLocation;
  status: ItemStatus;
  favorite: boolean;
  title: string;
  titleLocked: boolean;
  author: string | null;
  siteName: string | null;
  excerpt: string | null;
  imageUrl: string | null;
  publishedAt: Timestamp | null;
  wordCount: number | null;
  readingMinutes: number | null;
  categoryId: string | null;
  tags: string[];
  note: string;
  progress: number;
  fetchStatus: FetchStatus;
  fetchError: string | null;
  contentChunks: number;
  file: StoredFile | null;
  feedId: string | null;
  paper: PaperMeta | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  lastOpenedAt: Timestamp | null;
  archivedAt: Timestamp | null;
  /** SPEC-2 (optional so older fixtures stay valid; itemFromDoc always fills them). */
  source?: ItemSource | null;
  /** Server-written by the `ai` callable (summarize). */
  aiSummary?: AiSummary | null;
  /** Server-written by createShare/revokeShare: token of the public link (`/s/{token}`). */
  shareToken?: string | null;
  /** Server-written: when the current processing run started (set while fetchStatus is 'processing'). */
  processingAt?: Timestamp | null;
  /** Server-written: a rate-limited item (fetchStatus 'error') is fetched again automatically at this time. */
  retryAt?: Timestamp | null;
}

export interface AiSummary {
  text: string;
  createdAt: Timestamp | null;
  model: string;
}

export interface Category {
  id: string;
  name: string;
  order: number;
  createdAt: Timestamp | null;
}

export interface Feed {
  id: string;
  url: string;
  title: string;
  siteUrl: string | null;
  categoryId: string | null;
  tags: string[];
  fullText: boolean;
  lastFetchedAt: Timestamp | null;
  lastError: string | null;
  createdAt: Timestamp | null;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';
export const HIGHLIGHT_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink'];

export interface Highlight {
  id: string;
  itemId: string;
  text: string;
  note: string;
  prefix: string;
  suffix: string;
  /** SPEC-2; useHighlights() always fills it ('yellow' when unset). */
  color?: HighlightColor;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

/** 'save': the key only saves (POST/GET /api/save), used by the bookmarklet; 'all': save and read. */
export type ApiKeyScope = 'all' | 'save';

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  createdAt: Timestamp | null;
  lastUsedAt: Timestamp | null;
}

/** Fields the client may change on an item via updateItem(). */
export type ItemPatch = Partial<
  Pick<
    Item,
    | 'title'
    | 'titleLocked'
    | 'status'
    | 'location'
    | 'favorite'
    | 'categoryId'
    | 'tags'
    | 'note'
    | 'progress'
    | 'fetchStatus'
    | 'type'
  >
>;

// ---------------------------------------------------------------------------
// SPEC-2

/** `users/{uid}/views/{id}` — a saved Library filter. `params` is the Library query string (no leading '?'). */
export interface SavedView {
  id: string;
  name: string;
  params: string;
  order: number;
  createdAt: Timestamp | null;
}

export type RuleField = 'domain' | 'url' | 'title' | 'feed' | 'type' | 'source';
export type RuleOp = 'is' | 'contains' | 'endsWith';

export interface RuleMatch {
  field: RuleField;
  op: RuleOp;
  value: string;
}

export interface RuleActions {
  addTags?: string[];
  categoryId?: string | null;
  location?: ItemLocation;
  favorite?: boolean;
  archive?: boolean;
}

/** `users/{uid}/rules/{id}` — applied server-side once, when an item is first processed. */
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  actions: RuleActions;
  createdAt: Timestamp | null;
}

/** Fields of a rule the client writes (createRule / updateRule). */
export type RuleInput = Pick<Rule, 'name' | 'enabled' | 'match' | 'actions'>;

/** Result of the `getConfig` callable: which optional server features are available. */
export interface AppConfig {
  ai: boolean;
  /** Bot username (without @), or null when the Telegram bot is not set up. */
  telegramBot: string | null;
  /** Domain of the per-user newsletter addresses, or null when email saving is not set up. */
  inboundEmailDomain: string | null;
}

/** `users/{uid}/integrations/telegram` (server-written mirror). */
export interface TelegramIntegration {
  chatId: number;
  /** How the chat is named, ready to show: '@handle' when it has one, else the chat title or person's name. */
  username: string | null;
  linkedAt: Timestamp | null;
}

/** `users/{uid}/integrations/email` (server-written mirror). */
export interface EmailIntegration {
  address: string;
  createdAt: Timestamp | null;
}

export type IntegrationName = 'telegram' | 'email';
export type IntegrationDoc<N extends IntegrationName> = N extends 'telegram' ? TelegramIntegration : EmailIntegration;

export type AiAction = 'summarize' | 'ask' | 'suggestTags';
export interface AiSummaryResult {
  summary: string;
  cached: boolean;
  model: string;
  /** ms since epoch, null when unknown */
  createdAt: number | null;
}
export interface AiAnswerResult {
  answer: string;
  model: string;
}
export interface AiTagsResult {
  tags: string[];
  model: string;
}
export type AiResult<A extends AiAction> = A extends 'summarize' ? AiSummaryResult : A extends 'ask' ? AiAnswerResult : AiTagsResult;
