package app.readlater.reader;

import android.view.KeyEvent;
import java.io.File;
import java.util.Locale;

/** Pure helpers for share intents and hardware page keys (unit-tested, no Android runtime needed). */
final class SharedFiles {

    /** Same limit as the web upload (lib/data.ts MAX_UPLOAD_BYTES). */
    static final long MAX_BYTES = 100L * 1024 * 1024;

    /** Shared files older than this are removed from the cache directory. */
    static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;

    static final String MIME_PDF = "application/pdf";
    static final String MIME_EPUB = "application/epub+zip";

    private SharedFiles() {}

    /**
     * Page direction for a hardware key: +1 = next page, -1 = previous page, 0 = not a page key.
     * Volume down / page down turn forward (matches most e-readers).
     */
    static int pageDirection(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_VOLUME_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
                return 1;
            case KeyEvent.KEYCODE_VOLUME_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
                return -1;
            default:
                return 0;
        }
    }

    /** Resolve the effective MIME type of a shared document from the declared type and the file name. */
    static String resolveMime(String declared, String name) {
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".pdf")) return MIME_PDF;
        if (lower.endsWith(".epub")) return MIME_EPUB;
        if (MIME_PDF.equals(declared) || MIME_EPUB.equals(declared)) return declared;
        return null;
    }

    /**
     * A file-system safe display name that keeps the right extension, so the web upload
     * (which checks the extension and the blob type) recognises it.
     */
    static String safeName(String name, String mime) {
        String base = name == null ? "" : name.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^\\w.\\- ()\\[\\]]+", "_").replaceAll("^[.\\s]+", "");
        String ext = MIME_EPUB.equals(mime) ? ".epub" : ".pdf";
        if (base.isEmpty() || base.equals(ext)) base = (MIME_EPUB.equals(mime) ? "book" : "document") + ext;
        if (!base.toLowerCase(Locale.ROOT).endsWith(ext)) base = base + ext;
        if (base.length() > 120) base = base.substring(base.length() - 120);
        return base;
    }

    /**
     * Whether a shared / opened URI may be read. Only content:// URIs of other apps: a file:// path or a URI
     * of our own providers (authority = our package name, or starts with it) could make the app read and
     * upload its own private files (the signed-in session, the offline library).
     */
    static boolean isAllowedSource(String scheme, String authority, String ownPackage) {
        if (!"content".equalsIgnoreCase(scheme)) return false;
        if (authority == null || authority.isEmpty()) return false;
        String a = authority.toLowerCase(Locale.ROOT);
        String own = ownPackage == null ? "" : ownPackage.toLowerCase(Locale.ROOT);
        return own.isEmpty() || !(a.equals(own) || a.startsWith(own + "."));
    }

    /** Bytes needed by {@link #looksLike}. */
    static final int SNIFF_BYTES = 1024;

    /**
     * The first bytes of a file match its type: "%PDF-" within the first 1024 bytes (PDF), or a ZIP whose
     * first entry is the stored "mimetype" file with "application/epub+zip" (EPUB, as the spec requires).
     */
    static boolean looksLike(byte[] head, int length, String mime) {
        int n = Math.min(length, head == null ? 0 : head.length);
        if (MIME_PDF.equals(mime)) {
            byte[] sig = { '%', 'P', 'D', 'F', '-' };
            for (int i = 0; i + sig.length <= n; i++) {
                boolean hit = true;
                for (int k = 0; k < sig.length && hit; k++) hit = head[i + k] == sig[k];
                if (hit) return true;
            }
            return false;
        }
        if (MIME_EPUB.equals(mime)) {
            String expected = "mimetypeapplication/epub+zip";
            if (n < 30 + expected.length()) return false;
            if (head[0] != 'P' || head[1] != 'K' || head[2] != 3 || head[3] != 4) return false;
            for (int k = 0; k < expected.length(); k++) {
                if (head[30 + k] != expected.charAt(k)) return false;
            }
            return true;
        }
        return false;
    }

    /** Delete stale files from a previous share (best effort). */
    static void pruneOld(File dir, long now) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (now - f.lastModified() > MAX_AGE_MS) {
                deleteRecursively(f);
            }
        }
    }

    private static void deleteRecursively(File f) {
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursively(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
