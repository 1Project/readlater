/**
 * AI side sheet of the reader (SPEC-2 §5), text only: "Summary" (the cached item.aiSummary, or a fresh
 * one from the `ai` callable) and "Ask" (questions answered from the document). The reader shows the
 * entries only when useConfig().ai is true.
 *
 * export default AiPanel
 * Props: { item: Item; tab: AiTab | null (null = closed); onTab(tab): void; onClose(): void }
 * export type AiTab = 'summary' | 'ask'
 * export summaryBlocks(text): { kind: 'p' | 'li' | 'tldr'; text: string }[]   plain-text rendering of the
 *   model's Markdown-ish bullets (strips **bold**, `#` headings and list markers)
 */
import { useEffect, useId, useRef, useState } from 'react';
import Dialog from '../components/Dialog';
import Spinner from '../components/Spinner';
import { aiCall } from '../lib/data';
import type { Item } from '../lib/types';

export type AiTab = 'summary' | 'ask';

export interface SummaryBlock {
  kind: 'p' | 'li' | 'tldr';
  text: string;
}

function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export function summaryBlocks(text: string): SummaryBlock[] {
  const out: SummaryBlock[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^#{1,6}\s+/, '');
    const bullet = /^(?:[-*•–]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    const body = plain(bullet ? bullet[1] : line);
    if (!body) continue;
    const tldr = /^tl;?dr\b[:\s—–-]*(.*)$/i.exec(body);
    if (tldr) out.push({ kind: 'tldr', text: tldr[1].trim() || body });
    else out.push({ kind: bullet ? 'li' : 'p', text: body });
  }
  return out;
}

/** Readable error text: no "Firebase:" prefix and no trailing status code such as " [503]" or " (functions/internal)". */
export function errorMessage(e: unknown): string {
  const msg = (e as { message?: unknown } | null)?.message;
  if (typeof msg !== 'string' || !msg.trim()) return 'Something went wrong';
  const clean = msg
    .replace(/^Firebase:\s*/, '')
    .replace(/\s*(\[\d{3}\]|\((functions|auth)\/[\w-]+\))\.?\s*$/, '')
    .trim();
  return clean || 'Something went wrong';
}

function SummaryText({ text }: { text: string }) {
  const blocks = summaryBlocks(text);
  const groups: (SummaryBlock | SummaryBlock[])[] = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (b.kind === 'li') {
      if (Array.isArray(last)) last.push(b);
      else groups.push([b]);
    } else groups.push(b);
  }
  return (
    <div className="ai-text">
      {groups.map((g, i) =>
        Array.isArray(g) ? (
          <ul key={i}>
            {g.map((b, k) => (
              <li key={k}>{b.text}</li>
            ))}
          </ul>
        ) : g.kind === 'tldr' ? (
          <p key={i} className="ai-tldr">
            <strong>TL;DR</strong> {g.text}
          </p>
        ) : (
          <p key={i}>{g.text}</p>
        ),
      )}
    </div>
  );
}

interface Exchange {
  q: string;
  a: string | null;
  error: string | null;
}

export default function AiPanel({ item, tab, onTab, onClose }: { item: Item; tab: AiTab | null; onTab: (t: AiTab) => void; onClose: () => void }) {
  const cached = item.aiSummary?.text?.trim() || null;
  const [summary, setSummary] = useState<string | null>(null);
  const [sumBusy, setSumBusy] = useState(false);
  const [sumError, setSumError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const [askBusy, setAskBusy] = useState(false);
  const fieldId = useId();
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const shown = summary ?? cached;

  const summarize = (force = false) => {
    if (sumBusy) return;
    setSumBusy(true);
    setSumError(null);
    aiCall(item.id, 'summarize', undefined, force)
      .then((r) => {
        if (!alive.current) return;
        const text = (r as { summary?: unknown }).summary;
        if (typeof text === 'string' && text.trim()) setSummary(text);
        else setSumError('The summary came back empty. Try again.');
      })
      .catch((e: unknown) => alive.current && setSumError(errorMessage(e)))
      .finally(() => alive.current && setSumBusy(false));
  };

  // Opening the Summary tab without a cached summary asks for one.
  const summarizeRef = useRef(summarize);
  summarizeRef.current = summarize;
  useEffect(() => {
    if (tab === 'summary' && !shown && !sumBusy && !sumError) summarizeRef.current();
  }, [tab, shown, sumBusy, sumError]);

  const ask = () => {
    const q = question.trim();
    if (!q || askBusy) return;
    setAskBusy(true);
    setQuestion('');
    setHistory((h) => [...h, { q, a: null, error: null }]);
    const settle = (patch: Partial<Exchange>) =>
      alive.current && setHistory((h) => h.map((x, i) => (i === h.length - 1 && x.q === q ? { ...x, ...patch } : x)));
    aiCall(item.id, 'ask', q)
      .then((r) => {
        const a = (r as { answer?: unknown }).answer;
        settle(typeof a === 'string' && a.trim() ? { a: a.trim() } : { error: 'No answer came back. Try again.' });
      })
      .catch((e: unknown) => settle({ error: errorMessage(e) }))
      .finally(() => alive.current && setAskBusy(false));
  };

  return (
    <Dialog open={tab !== null} onClose={onClose} title={tab === 'ask' ? 'Ask about this' : 'Summary'} className="reader-sheet ai-panel">
      <div className="segmented ai-tabs" role="group" aria-label="AI">
        <button type="button" className="btn" aria-pressed={tab === 'summary'} onClick={() => onTab('summary')}>
          Summary
        </button>
        <button type="button" className="btn" aria-pressed={tab === 'ask'} onClick={() => onTab('ask')}>
          Ask
        </button>
      </div>

      {tab === 'summary' ? (
        <section className="ai-section" aria-live="polite">
          {shown ? <SummaryText text={shown} /> : null}
          {sumBusy ? <Spinner label={shown ? 'Summarizing again…' : 'Summarizing…'} /> : null}
          {sumError ? (
            <p className="error-text">
              {sumError}{' '}
              <button type="button" className="btn btn-small" onClick={() => summarize()}>
                Retry
              </button>
            </p>
          ) : null}
          {shown && !sumBusy ? (
            <div className="row ai-actions">
              <button type="button" className="btn btn-ghost btn-small" onClick={() => summarize(true)}>
                Summarize again
              </button>
            </div>
          ) : null}
          <p className="small muted ai-disclaimer">Generated by AI from this document. It can be wrong.</p>
        </section>
      ) : tab === 'ask' ? (
        <section className="ai-section">
          {history.length ? (
            <ol className="ai-history" aria-live="polite">
              {history.map((x, i) => (
                <li key={i}>
                  <p className="ai-q">{x.q}</p>
                  {x.a ? (
                    <div className="ai-text ai-a">
                      {x.a.split(/\n{2,}/).map((para, k) => (
                        <p key={k}>{para}</p>
                      ))}
                    </div>
                  ) : x.error ? (
                    <p className="error-text">{x.error}</p>
                  ) : (
                    <Spinner label="Thinking…" />
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Ask a question about this document. Answers use only its text.</p>
          )}
          <form
            className="ai-ask"
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
          >
            <label className="field" htmlFor={fieldId}>
              <span className="field-label">Question</span>
              <textarea
                id={fieldId}
                className="textarea"
                rows={2}
                value={question}
                maxLength={1000}
                placeholder="What is the main argument?"
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    ask();
                  }
                }}
              />
            </label>
            <div className="row ai-actions">
              <span className="spacer" />
              <button type="submit" className="btn btn-primary" disabled={askBusy || !question.trim()}>
                {askBusy ? 'Asking…' : 'Ask'}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </Dialog>
  );
}
