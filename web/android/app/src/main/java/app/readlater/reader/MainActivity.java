package app.readlater.reader;

import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor host activity.
 *  - Registers the in-app ShareIntent plugin (share sheet / "Open with" for links, PDFs and EPUBs).
 *  - While the reader is open (window.__readerActive, mirrored natively via ShareIntent.setReaderActive),
 *    volume and page-up/down keys turn pages by dispatching a `hwpage` window event
 *    ({detail:{dir:1|-1}}) instead of changing the volume.
 *  - E-ink friendly WebView: no overscroll glow/stretch.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareIntentPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null) {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
            }
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int dir = SharedFiles.pageDirection(event.getKeyCode());
        if (dir != 0 && ShareIntentPlugin.isReaderActive() && getBridge() != null) {
            // Consume both down and up so the system volume never changes while reading;
            // turn one page per press (ignore auto-repeat while a key is held).
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                getBridge().eval("window.dispatchEvent(new CustomEvent('hwpage',{detail:{dir:" + dir + "}}))", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
