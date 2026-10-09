/**
 * Browser helpers for the settings / feeds / highlights pages.
 *
 * Exports:
 *   downloadText(fileName, text, mime): Promise<void>   saves a text file (share sheet in the native app when available)
 *   dateStamp(d?): string                               "2026-10-09"
 *   copyText(text): Promise<boolean>                    clipboard write with a textarea fallback
 */
import { isNative } from '../../native';

export function dateStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function downloadText(fileName: string, text: string, mime: string): Promise<void> {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  // Inside the native app the WebView cannot save downloads; hand the file to the share sheet instead.
  if (isNative() && typeof navigator.canShare === 'function') {
    const file = new File([blob], fileName, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: fileName });
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
