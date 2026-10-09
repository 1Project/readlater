package app.readlater.reader;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.widget.Toast;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hands content shared with / opened in the app to the web layer (src/native.ts).
 *
 * JS API (registerPlugin('ShareIntent')):
 *   getPending(): Promise<{} | {type:'text', text, subject?} | {type:'file', name, mimeType, path, size}>
 *       Returns and clears the share that arrived while no 'shared' listener was attached (cold start).
 *       If a file is still being copied, resolves once the copy is done.
 *   addListener('shared', payload => …)   shares arriving while the app is running.
 *   setReaderActive({active: boolean})    while true, volume / page keys turn pages (see MainActivity).
 *
 * Files are copied from the content URI to cacheDir/shared/ (≤ 100 MB) off the main thread; JS turns
 * `path` into a fetchable URL with Capacitor.convertFileSrc(path). Only content:// URIs of other apps are
 * read (never file:// or our own FileProvider, see SharedFiles.isAllowedSource), and only files whose
 * bytes are a PDF or an EPUB are handed on.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

    static final String EVENT_SHARED = "shared";
    private static final String HANDLED_EXTRA = "app.readlater.reader.SHARE_HANDLED";

    private static volatile boolean readerActive = false;

    static boolean isReaderActive() {
        return readerActive;
    }

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Object lock = new Object();
    // Guarded by lock.
    private JSObject pending = null;
    private int copiesInFlight = 0;
    private final List<PluginCall> waiting = new ArrayList<>();

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        // Re-launch from Recents re-delivers the original share intent; don't save it twice.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        if (intent.getBooleanExtra(HANDLED_EXTRA, false)) return;

        String action = intent.getAction();
        String type = intent.getType();

        if (Intent.ACTION_SEND.equals(action)) {
            if (type != null && type.startsWith("text/")) {
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text == null || text.toString().trim().isEmpty()) return;
                intent.putExtra(HANDLED_EXTRA, true);
                JSObject data = new JSObject();
                data.put("type", "text");
                data.put("text", text.toString());
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                if (subject != null && !subject.trim().isEmpty()) data.put("subject", subject.trim());
                deliver(data);
                return;
            }
            Uri stream = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (stream != null) {
                intent.putExtra(HANDLED_EXTRA, true);
                copyAndDeliver(stream, type);
            }
            return;
        }

        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            if (data == null) return;
            String scheme = data.getScheme();
            // readlater:// deep links are handled by @capacitor/app (appUrlOpen); file:// is refused in copyToCache.
            if (ContentResolver.SCHEME_CONTENT.equals(scheme) || ContentResolver.SCHEME_FILE.equals(scheme)) {
                intent.putExtra(HANDLED_EXTRA, true);
                copyAndDeliver(data, type);
            }
        }
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        synchronized (lock) {
            if (pending != null) {
                JSObject p = pending;
                pending = null;
                call.resolve(p);
                return;
            }
            if (copiesInFlight > 0) {
                waiting.add(call);
                return;
            }
        }
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void setReaderActive(PluginCall call) {
        readerActive = Boolean.TRUE.equals(call.getBoolean("active", false));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        readerActive = false;
        io.shutdown();
    }

    /** Hand a share to JS: a waiting getPending() call, else a live listener, else keep it pending. */
    private void deliver(JSObject data) {
        PluginCall waiter = null;
        synchronized (lock) {
            if (!waiting.isEmpty()) {
                waiter = waiting.remove(0);
            } else if (!hasListeners(EVENT_SHARED)) {
                pending = data;
                return;
            }
        }
        if (waiter != null) {
            waiter.resolve(data);
            releaseWaiters();
        } else {
            notifyListeners(EVENT_SHARED, data);
        }
    }

    /** Resolve any further waiting getPending() calls with "nothing pending" once no copy is running. */
    private void releaseWaiters() {
        List<PluginCall> done = new ArrayList<>();
        synchronized (lock) {
            if (copiesInFlight > 0) return;
            done.addAll(waiting);
            waiting.clear();
        }
        for (PluginCall c : done) c.resolve(new JSObject());
    }

    private void copyAndDeliver(Uri uri, String declaredType) {
        synchronized (lock) {
            copiesInFlight++;
        }
        if (io.isShutdown()) {
            synchronized (lock) {
                copiesInFlight--;
            }
            return;
        }
        io.execute(() -> {
            JSObject result = null;
            String error = null;
            try {
                result = copyToCache(uri, declaredType);
            } catch (IOException | SecurityException | IllegalArgumentException e) {
                Logger.error("ShareIntent", "Could not read shared file", e);
                error = e.getMessage();
            }
            synchronized (lock) {
                copiesInFlight--;
            }
            if (result != null) {
                deliver(result);
            } else {
                String msg = error == null || error.isEmpty() ? "Could not open the shared file" : error;
                showToast(msg);
                releaseWaiters();
            }
        });
    }

    private JSObject copyToCache(Uri uri, String declaredType) throws IOException {
        if (!SharedFiles.isAllowedSource(uri.getScheme(), uri.getAuthority(), getContext().getPackageName())) {
            throw new IOException("This file cannot be opened from here. Share it from the app that has it.");
        }
        ContentResolver resolver = getContext().getContentResolver();
        String displayName = null;
        long declaredSize = -1;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int si = c.getColumnIndex(OpenableColumns.SIZE);
                    if (ni >= 0 && !c.isNull(ni)) displayName = c.getString(ni);
                    if (si >= 0 && !c.isNull(si)) declaredSize = c.getLong(si);
                }
            }
        }
        if (displayName == null) displayName = uri.getLastPathSegment();
        String type = declaredType;
        if (type == null || type.isEmpty() || "*/*".equals(type) || "application/octet-stream".equals(type)) {
            type = resolver.getType(uri);
        }
        String mime = SharedFiles.resolveMime(type, displayName);
        if (mime == null) throw new IOException("Only PDF and EPUB files can be saved");
        if (declaredSize > SharedFiles.MAX_BYTES) throw new IOException("File is larger than 100 MB");

        File dir = new File(getContext().getCacheDir(), "shared");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create the cache directory");
        SharedFiles.pruneOld(dir, System.currentTimeMillis());
        String name = SharedFiles.safeName(displayName, mime);
        File sub = new File(dir, Long.toString(System.currentTimeMillis()));
        if (!sub.mkdirs()) throw new IOException("Could not create the cache directory");
        File out = new File(sub, name);

        long total = 0;
        byte[] head = new byte[SharedFiles.SNIFF_BYTES];
        int headLen = 0;
        try (InputStream in = resolver.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new IOException("Could not open the shared file");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                if (headLen < head.length) {
                    int k = Math.min(n, head.length - headLen);
                    System.arraycopy(buf, 0, head, headLen, k);
                    headLen += k;
                }
                total += n;
                if (total > SharedFiles.MAX_BYTES) {
                    throw new IOException("File is larger than 100 MB");
                }
                os.write(buf, 0, n);
            }
            // The sender only declares a type: the bytes have to agree.
            if (total > 0 && !SharedFiles.looksLike(head, headLen, mime)) {
                throw new IOException("This is not a PDF or EPUB file");
            }
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw e;
        }
        if (total == 0) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw new IOException("The shared file is empty");
        }

        JSObject data = new JSObject();
        data.put("type", "file");
        data.put("name", name);
        data.put("mimeType", mime);
        data.put("path", out.getAbsolutePath());
        data.put("size", total);
        return data;
    }

    private void showToast(String message) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> Toast.makeText(getContext(), message, Toast.LENGTH_LONG).show());
    }
}
