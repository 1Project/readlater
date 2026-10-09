/**
 * Clipboard helper for the reader and the share dialog.
 *
 * export copyText(text: string): Promise<void>
 *   navigator.clipboard.writeText when available (secure contexts), else a hidden <textarea> +
 *   document.execCommand('copy') (older WebViews, plain-http hosts). Rejects when both fail.
 */

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.opacity = '0';
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* permission denied or not focused: try the fallback */
    }
  }
  if (!legacyCopy(text)) throw new Error('Copying is not available here');
}
