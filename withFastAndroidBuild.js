const {
  withGradleProperties,
  withDangerousMod,
  withMainApplication,
  withAndroidManifest,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const VIDEO_ENGINE_PACKAGE_KT = `package com.rembrant.galeriaapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class VideoEnginePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(VideoEngineModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

const VIDEO_ENGINE_MODULE_KT = `package com.rembrant.galeriaapp

import android.app.Activity
import android.app.Dialog
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.ExifInterface
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.net.Uri
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.Surface
import android.view.ViewGroup
import android.view.Window
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.view.inputmethod.EditorInfo
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedReader
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class VideoEngineModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String = "VideoEngineModule"

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        // No-op
    }

    override fun onNewIntent(intent: Intent) {
        try {
            reactContext.currentActivity?.intent = intent
            if (intent.action == Intent.ACTION_SEND && intent.type?.startsWith("text/") == true) {
                val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
                    ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
                if (!sharedText.isNullOrBlank()) {
                    val params = Arguments.createMap().apply {
                        putString("text", sharedText)
                    }
                    reactContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("SharedVideoLinkReceived", params)
                }
            }
        } catch (_: Exception) {}
    }

    @ReactMethod
    fun getSharedTextNative(clearAfterRead: Boolean, promise: Promise) {
        try {
            val act = reactContext.currentActivity
            val intent = act?.intent
            if (intent != null && intent.action == Intent.ACTION_SEND && intent.type?.startsWith("text/") == true) {
                val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
                    ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
                if (clearAfterRead) {
                    intent.removeExtra(Intent.EXTRA_TEXT)
                    intent.removeExtra(Intent.EXTRA_SUBJECT)
                    intent.action = Intent.ACTION_MAIN
                }
                promise.resolve(sharedText ?: "")
                return
            }
            promise.resolve("")
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    @ReactMethod
    fun getClipboardTextNative(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                val clip = cm?.primaryClip
                if (clip != null && clip.itemCount > 0) {
                    val txt = clip.getItemAt(0).coerceToText(reactContext)?.toString() ?: ""
                    promise.resolve(txt)
                } else {
                    promise.resolve("")
                }
            } catch (e: Exception) {
                promise.resolve("")
            }
        }
    }

    @ReactMethod
    fun getCookiesForUrlNative(targetUrl: String, promise: Promise) {
        try {
            val cookie = CookieManager.getInstance().getCookie(targetUrl) ?: ""
            promise.resolve(cookie)
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    private fun cleanFilePath(uriOrPath: String): String {
        var clean = uriOrPath.trim()
        if (clean.startsWith("file://")) {
            clean = clean.removePrefix("file://")
        }
        return try {
            java.net.URLDecoder.decode(clean, "UTF-8")
        } catch (e: Exception) {
            clean
        }
    }

    private fun emitProgress(percent: Double, stage: String) {
        try {
            val params = Arguments.createMap().apply {
                putDouble("percent", percent.coerceIn(0.0, 1.0))
                putString("stage", stage)
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("VideoEngineProgress", params)
        } catch (e: Exception) {
            // ignore event emission errors
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Requerido por React Native NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Requerido por React Native NativeEventEmitter
    }

    @ReactMethod
    fun fetchCleanHtmlNative(targetUrl: String, userAgent: String, promise: Promise) {
        executor.execute {
            try {
                var currentUrl = targetUrl.trim()
                var redirects = 0
                var finalHtml = ""
                var finalStatus = 0
                val cookieMgr = try { CookieManager.getInstance() } catch (_: Exception) { null }

                while (redirects < 8) {
                    val urlObj = URL(currentUrl)
                    val savedCookies = try {
                        cookieMgr?.getCookie(currentUrl)
                            ?: if (currentUrl.contains("facebook.com") || currentUrl.contains("fb.watch")) {
                                cookieMgr?.getCookie("https://www.facebook.com")
                            } else null
                    } catch (_: Exception) { null }

                    val conn = (urlObj.openConnection() as HttpURLConnection).apply {
                        instanceFollowRedirects = false
                        connectTimeout = 12000
                        readTimeout = 15000
                        requestMethod = "GET"
                        useCaches = false
                        setRequestProperty("User-Agent", userAgent)
                        setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
                        setRequestProperty("Accept-Language", "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7")
                        setRequestProperty("Sec-Fetch-Dest", "document")
                        setRequestProperty("Sec-Fetch-Mode", "navigate")
                        setRequestProperty("Sec-Fetch-Site", "none")
                        setRequestProperty("Sec-Fetch-User", "?1")
                        setRequestProperty("Upgrade-Insecure-Requests", "1")
                        if (!savedCookies.isNullOrBlank()) {
                            setRequestProperty("Cookie", savedCookies)
                        }
                    }

                    val code = conn.responseCode
                    finalStatus = code
                    if (code in 300..399) {
                        val loc = conn.getHeaderField("Location") ?: break
                        conn.disconnect()
                        var resolvedLoc = try {
                            URL(urlObj, loc).toString()
                        } catch (_: Exception) {
                            loc
                        }
                        if (resolvedLoc.contains("/login") && resolvedLoc.contains("next=")) {
                            val parsedUri = Uri.parse(resolvedLoc)
                            val nextParam = parsedUri.getQueryParameter("next")
                            if (!nextParam.isNullOrBlank() && nextParam.startsWith("http") && nextParam != currentUrl) {
                                resolvedLoc = nextParam
                            } else {
                                break
                            }
                        }
                        if (!userAgent.contains("Mobile") && !resolvedLoc.contains("mbasic.facebook.com")) {
                            resolvedLoc = resolvedLoc
                                .replace("://m.facebook.com/", "://www.facebook.com/")
                                .replace("://web.facebook.com/", "://www.facebook.com/")
                        }
                        currentUrl = resolvedLoc
                        redirects++
                        continue
                    }

                    val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
                    if (stream != null) {
                        BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
                            val sb = StringBuilder()
                            val buf = CharArray(16384)
                            var read: Int
                            while (reader.read(buf).also { read = it } != -1) {
                                sb.append(buf, 0, read)
                                if (sb.length > 4_500_000) break
                            }
                            finalHtml = sb.toString()
                        }
                    }
                    conn.disconnect()
                    break
                }

                val map = Arguments.createMap().apply {
                    putInt("status", finalStatus)
                    putString("finalUrl", currentUrl)
                    putString("html", finalHtml)
                }
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("FETCH_CLEAN_ERR", e.message ?: "Error al consultar página", e)
            }
        }
    }

    /**
     * Extractor con WebView nativo de Android (soporta modo silencioso en 2do plano e interactivo para Historias de Facebook/Instagram con sesión)
     */
    @ReactMethod
    fun sniffVideoWithWebViewNative(targetUrl: String, interactive: Boolean, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val resolved = AtomicBoolean(false)
            var dialog: Dialog? = null
            var webView: WebView? = null
            var detectedVideoUrl: String? = null
            var statusLabel: TextView? = null
            var actionButton: TextView? = null

            val desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            val mobileUA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            val chosenUA = if (interactive) mobileUA else desktopUA

            fun cleanExtractedUrl(raw: String): String {
                return raw
                    .replace("\\\\u0026", "&")
                    .replace("\\\\u002F", "/")
                    .replace("\\\\u002f", "/")
                    .replace("\\\\u003D", "=")
                    .replace("\\\\u003C", "<")
                    .replace("\\\\/", "/")
                    .replace("&amp;", "&")
                    .trim()
                    .trim('"', '\\'')
            }

            fun isValidVideoStream(u: String): Boolean {
                val low = u.lowercase()
                if (!low.startsWith("http")) return false
                if (low.startsWith("blob:")) return false
                if (low.contains(".jpg") || low.contains(".png") || low.contains(".webp") || low.contains(".gif") || low.contains(".svg") || low.contains(".css") || low.contains(".js")) return false
                if (low.contains("rsrc.php") || low.contains("static.xx.fbcdn.net")) return false
                return (low.contains(".mp4") ||
                    (low.contains("fbcdn.net") && (low.contains("/v/") || low.contains("bytestart") || low.contains("efg="))) ||
                    (low.contains("cdninstagram.com") && low.contains("/v/")) ||
                    low.contains("video.twimg.com") ||
                    low.contains("googlevideo.com/videoplayback"))
            }

            fun cleanupAndResolve(videoUrl: String?, errorMsg: String? = null) {
                if (!resolved.compareAndSet(false, true)) return
                UiThreadUtil.runOnUiThread {
                    try {
                        CookieManager.getInstance().flush()
                    } catch (_: Exception) {}
                    val cookies = try {
                        CookieManager.getInstance().getCookie(targetUrl) ?: ""
                    } catch (_: Exception) { "" }
                    try {
                        webView?.stopLoading()
                        webView?.loadUrl("about:blank")
                        webView?.destroy()
                    } catch (_: Exception) {}
                    webView = null
                    try {
                        dialog?.dismiss()
                    } catch (_: Exception) {}
                    dialog = null

                    if (!videoUrl.isNullOrBlank()) {
                        val map = Arguments.createMap().apply {
                            putString("downloadUrl", videoUrl)
                            putString("cookies", cookies)
                            putString("userAgent", chosenUA)
                        }
                        promise.resolve(map)
                    } else {
                        promise.reject("SNIFF_EMPTY", errorMsg ?: "No se detectó video en la página")
                    }
                }
            }

            fun onCandidateFound(rawCandidate: String) {
                val clean = cleanExtractedUrl(rawCandidate)
                if (!isValidVideoStream(clean)) return
                detectedVideoUrl = clean
                if (!interactive) {
                    cleanupAndResolve(clean, null)
                } else {
                    UiThreadUtil.runOnUiThread {
                        statusLabel?.text = "✅ ¡Video de la historia detectado! Toca el botón verde para descargarlo"
                        actionButton?.text = "⬇ Descargar Video Detectado Ahora"
                        actionButton?.setBackgroundColor(Color.parseColor("#10B981"))
                    }
                }
            }

            try {
                val context = reactContext.currentActivity ?: reactContext
                val wv = WebView(context)
                webView = wv

                val cm = CookieManager.getInstance()
                cm.setAcceptCookie(true)
                cm.setAcceptThirdPartyCookies(wv, true)

                wv.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    loadsImagesAutomatically = interactive
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                    userAgentString = chosenUA
                }

                wv.webChromeClient = WebChromeClient()
                wv.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                        val reqUrl = request?.url?.toString() ?: ""
                        if (isValidVideoStream(reqUrl)) {
                            onCandidateFound(reqUrl)
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }

                val jsProbe = """
                    (function() {
                      try {
                        var vids = document.querySelectorAll('video, video source');
                        for (var i = 0; i < vids.length; i++) {
                          var s = vids[i].currentSrc || vids[i].src || '';
                          if (s && s.indexOf('http') === 0 && s.indexOf('blob:') !== 0) return s;
                        }
                        var html = document.documentElement.innerHTML || '';
                        var regexes = [
                          /"progressive_url"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"browser_native_hd_url"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"playable_url_quality_hd"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"hd_src_no_ratelimit"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"hd_src"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"browser_native_sd_url"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"playable_url"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"sd_src"\\s*:\\s*"(https?:[^"]+)"/i,
                          /"video_url"\\s*:\\s*"(https?:[^"]+)"/i,
                          /(https?:\\\\/\\\\/video[^"'\\s<>\\\\]+\\.mp4[^"'\\s<>\\\\]*)/i,
                          /(https?:\\/\\/video[^"'\\s<>\\\\]+\\.mp4[^"'\\s<>\\\\]*)/i
                        ];
                        for (var j = 0; j < regexes.length; j++) {
                          var m = html.match(regexes[j]);
                          if (m && m[1]) return m[1];
                        }
                      } catch (e) {}
                      return '';
                    })();
                """.trimIndent()

                fun scheduleProbe(iteration: Int) {
                    if (resolved.get()) return
                    if (!interactive && iteration > 10) {
                        cleanupAndResolve(detectedVideoUrl, "Tiempo agotado buscando flujo de video")
                        return
                    }
                    mainHandler.postDelayed({
                        if (resolved.get()) return@postDelayed
                        try {
                            wv.evaluateJavascript(jsProbe) { res ->
                                val trimmedRes = res?.trim()?.trim('"') ?: ""
                                if (trimmedRes.isNotEmpty() && trimmedRes != "null") {
                                    onCandidateFound(trimmedRes)
                                }
                            }
                        } catch (_: Exception) {}
                        scheduleProbe(iteration + 1)
                    }, 850L)
                }

                if (interactive && reactContext.currentActivity != null) {
                    val act = reactContext.currentActivity!!
                    val dlg = Dialog(act, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
                    dialog = dlg
                    dlg.requestWindowFeature(Window.FEATURE_NO_TITLE)

                    val root = LinearLayout(act).apply {
                        orientation = LinearLayout.VERTICAL
                        setBackgroundColor(Color.parseColor("#0F172A"))
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    }

                    val header = LinearLayout(act).apply {
                        orientation = LinearLayout.VERTICAL
                        setBackgroundColor(Color.parseColor("#1E293B"))
                        setPadding(32, 36, 32, 24)
                    }

                    val topRow = LinearLayout(act).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                    }

                    val titleTv = TextView(act).apply {
                        text = "Extractor de Historias y Videos"
                        setTextColor(Color.WHITE)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                        typeface = Typeface.DEFAULT_BOLD
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    }

                    val closeBtn = TextView(act).apply {
                        text = "✕ Cerrar"
                        setTextColor(Color.parseColor("#F87171"))
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                        typeface = Typeface.DEFAULT_BOLD
                        setPadding(24, 12, 12, 12)
                        setOnClickListener {
                            cleanupAndResolve(null, "CANCELLED")
                        }
                    }

                    topRow.addView(titleTv)
                    topRow.addView(closeBtn)

                    val subTv = TextView(act).apply {
                        text = "Si es una historia de Facebook/Instagram, inicia sesión una vez y abre la historia. El video se detectará automáticamente."
                        setTextColor(Color.parseColor("#94A3B8"))
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                        setPadding(0, 8, 0, 14)
                    }
                    statusLabel = subTv

                    val captureBtn = TextView(act).apply {
                        text = "🔍 Buscando video en la página... (Toca al ver el video)"
                        setTextColor(Color.WHITE)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                        typeface = Typeface.DEFAULT_BOLD
                        gravity = Gravity.CENTER
                        setPadding(24, 24, 24, 24)
                        background = GradientDrawable().apply {
                            cornerRadius = 24f
                            setColor(Color.parseColor("#3B82F6"))
                        }
                        setOnClickListener {
                            if (!detectedVideoUrl.isNullOrBlank()) {
                                cleanupAndResolve(detectedVideoUrl, null)
                            } else {
                                wv.evaluateJavascript(jsProbe) { res ->
                                    val trimmedRes = res?.trim()?.trim('"') ?: ""
                                    if (trimmedRes.isNotEmpty() && trimmedRes != "null") {
                                        onCandidateFound(trimmedRes)
                                        if (!detectedVideoUrl.isNullOrBlank()) {
                                            cleanupAndResolve(detectedVideoUrl, null)
                                        }
                                    } else {
                                        statusLabel?.text = "⚠️ Reproduce el video en pantalla primero para que cargue el archivo MP4."
                                    }
                                }
                            }
                        }
                    }
                    actionButton = captureBtn

                    header.addView(topRow)
                    header.addView(subTv)
                    header.addView(captureBtn)

                    val webParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        0,
                        1f
                    )
                    root.addView(header)
                    root.addView(wv, webParams)

                    dlg.setContentView(root)
                    dlg.setOnCancelListener {
                        cleanupAndResolve(null, "CANCELLED")
                    }
                    dlg.show()
                }

                wv.loadUrl(targetUrl)
                scheduleProbe(0)
            } catch (e: Exception) {
                cleanupAndResolve(null, e.message ?: "Error en WebView extractor")
            }
        }
    }

    @ReactMethod
    fun openInAppBrowserNative(initialUrl: String, promise: Promise) {
        val startUrl = initialUrl.trim().ifEmpty { "https://www.google.com" }
        val resolvedFlag = AtomicBoolean(false)
        var dialogRef: Dialog? = null
        var webViewRef: WebView? = null
        var urlInputRef: EditText? = null
        var downloadBtnRef: TextView? = null
        var detectedMediaUrl: String? = null

        fun normalizeInputUrl(raw: String): String {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return "https://www.google.com"
            if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
            if (!trimmed.contains(" ") && trimmed.contains(".")) return "https://$trimmed"
            return "https://www.google.com/search?q=" + Uri.encode(trimmed)
        }

        fun closeBrowser(action: String, targetResultUrl: String?) {
            if (!resolvedFlag.compareAndSet(false, true)) return
            UiThreadUtil.runOnUiThread {
                try {
                    dialogRef?.dismiss()
                } catch (_: Exception) {}
                dialogRef = null
                try {
                    webViewRef?.stopLoading()
                    webViewRef?.loadUrl("about:blank")
                    webViewRef?.destroy()
                } catch (_: Exception) {}
                webViewRef = null
                val map = Arguments.createMap().apply {
                    putString("action", action)
                    putString("url", targetResultUrl ?: "")
                }
                promise.resolve(map)
            }
        }

        UiThreadUtil.runOnUiThread {
            try {
                val act = currentActivity
                if (act == null || act.isFinishing) {
                    closeBrowser("closed", "")
                    return@runOnUiThread
                }

                val wv = WebView(act)
                webViewRef = wv

                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)

                wv.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    loadsImagesAutomatically = true
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                    useWideViewPort = true
                    loadWithOverviewMode = true
                    builtInZoomControls = true
                    displayZoomControls = false
                    userAgentString = "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
                }

                wv.webChromeClient = WebChromeClient()
                wv.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        val u = request?.url?.toString() ?: return false
                        if (u.startsWith("http://") || u.startsWith("https://")) {
                            urlInputRef?.setText(u)
                            return false
                        }
                        return true
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        super.onPageFinished(view, url)
                        if (!url.isNullOrBlank() && url != "about:blank") {
                            urlInputRef?.setText(url)
                        }
                    }

                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                        val reqUrl = request?.url?.toString() ?: ""
                        val lower = reqUrl.lowercase()
                        if ((lower.contains(".mp4") || lower.contains(".m3u8") || lower.contains("videoplayback") || lower.contains("mime=video")) &&
                            !lower.contains(".jpg") && !lower.contains(".png") && !lower.contains(".js")
                        ) {
                            detectedMediaUrl = reqUrl
                            UiThreadUtil.runOnUiThread {
                                downloadBtnRef?.text = "⬇ Video Listo"
                                downloadBtnRef?.background = GradientDrawable().apply {
                                    cornerRadius = 18f
                                    setColor(Color.parseColor("#10B981"))
                                }
                            }
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }

                val dlg = Dialog(act, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
                dlg.requestWindowFeature(Window.FEATURE_NO_TITLE)
                dlg.setCancelable(true)
                dialogRef = dlg

                val root = LinearLayout(act).apply {
                    orientation = LinearLayout.VERTICAL
                    setBackgroundColor(Color.parseColor("#0B0B14"))
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                }

                val navBar = LinearLayout(act).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setBackgroundColor(Color.parseColor("#151525"))
                    setPadding(12, 14, 12, 14)
                }

                fun makeNavBtn(label: String, bgHex: String, onClick: () -> Unit): TextView {
                    return TextView(act).apply {
                        text = label
                        setTextColor(Color.WHITE)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                        typeface = Typeface.DEFAULT_BOLD
                        gravity = Gravity.CENTER
                        setPadding(18, 12, 18, 12)
                        background = GradientDrawable().apply {
                            cornerRadius = 18f
                            setColor(Color.parseColor(bgHex))
                        }
                        val lp = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        )
                        lp.setMargins(4, 0, 4, 0)
                        layoutParams = lp
                        setOnClickListener { onClick() }
                    }
                }

                val backBtn = makeNavBtn("◀", "#252538") {
                    if (wv.canGoBack()) wv.goBack()
                }
                val fwdBtn = makeNavBtn("▶", "#252538") {
                    if (wv.canGoForward()) wv.goForward()
                }
                val reloadBtn = makeNavBtn("↻", "#252538") {
                    wv.reload()
                }

                val urlInput = EditText(act).apply {
                    setText(normalizeInputUrl(startUrl))
                    hint = "Buscar en Google o escribir URL..."
                    setHintTextColor(Color.parseColor("#71717A"))
                    setTextColor(Color.WHITE)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    setSingleLine(true)
                    imeOptions = EditorInfo.IME_ACTION_GO
                    setPadding(22, 12, 22, 12)
                    background = GradientDrawable().apply {
                        cornerRadius = 18f
                        setColor(Color.parseColor("#090910"))
                        setStroke(2, Color.parseColor("#2E2E42"))
                    }
                    val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    lp.setMargins(6, 0, 6, 0)
                    layoutParams = lp
                    setOnEditorActionListener { v, actionId, _ ->
                        if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_SEARCH) {
                            val target = normalizeInputUrl(v.text?.toString() ?: "")
                            wv.loadUrl(target)
                            true
                        } else {
                            false
                        }
                    }
                }
                urlInputRef = urlInput

                val goBtn = makeNavBtn("Ir", "#3B82F6") {
                    val target = normalizeInputUrl(urlInput.text?.toString() ?: "")
                    wv.loadUrl(target)
                }

                val dlBtn = makeNavBtn("⬇ Video", "#6D28D9") {
                    val currentPageUrl = wv.url ?: normalizeInputUrl(urlInput.text?.toString() ?: "")
                    val bestUrl = if (!detectedMediaUrl.isNullOrBlank()) currentPageUrl else currentPageUrl
                    closeBrowser("download", bestUrl)
                }
                downloadBtnRef = dlBtn

                val closeBtn = makeNavBtn("✕", "#EF4444") {
                    closeBrowser("closed", wv.url ?: "")
                }

                navBar.addView(backBtn)
                navBar.addView(fwdBtn)
                navBar.addView(reloadBtn)
                navBar.addView(urlInput)
                navBar.addView(goBtn)
                navBar.addView(dlBtn)
                navBar.addView(closeBtn)

                val webParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
                )
                root.addView(navBar)
                root.addView(wv, webParams)

                dlg.setContentView(root)
                dlg.setOnCancelListener {
                    closeBrowser("closed", wv.url ?: "")
                }
                dlg.show()

                wv.loadUrl(normalizeInputUrl(startUrl))
            } catch (e: Exception) {
                closeBrowser("closed", "")
            }
        }
    }

    @ReactMethod
    fun copyToCacheNative(sourceUriOrPath: String, destPath: String, promise: Promise) {
        executor.execute {
            try {
                val cleanDest = cleanFilePath(destPath)
                val destFile = File(cleanDest)
                destFile.parentFile?.mkdirs()
                if (destFile.exists()) destFile.delete()

                val inputStream = if (sourceUriOrPath.startsWith("content://")) {
                    reactContext.contentResolver.openInputStream(Uri.parse(sourceUriOrPath))
                } else {
                    FileInputStream(File(cleanFilePath(sourceUriOrPath)))
                } ?: throw IllegalStateException("No se pudo abrir el archivo origen")

                inputStream.use { input ->
                    FileOutputStream(destFile, false).use { output ->
                        val buf = ByteArray(64 * 1024)
                        var len: Int
                        while (input.read(buf).also { len = it } > 0) {
                            output.write(buf, 0, len)
                        }
                        output.flush()
                    }
                }
                promise.resolve("file://" + destFile.absolutePath)
            } catch (e: Exception) {
                promise.reject("COPY_ERROR", e.message ?: "Error al copiar archivo a caché", e)
            }
        }
    }

    @ReactMethod
    fun overwriteFileNative(sourcePath: String, targetUriOrPath: String, promise: Promise) {
        executor.execute {
            try {
                val srcFile = File(cleanFilePath(sourcePath))
                if (!srcFile.exists() || srcFile.length() <= 0L) {
                    throw IllegalStateException("El archivo comprimido/recortado temporal no existe o está vacío.")
                }

                // 1. Si el destino es content://, intentar también extraer su ruta física real si pertenece a almacenamiento primario
                var writtenPhysicalPath: String? = null
                if (!targetUriOrPath.startsWith("content://")) {
                    val destFile = File(cleanFilePath(targetUriOrPath))
                    FileInputStream(srcFile).use { input ->
                        FileOutputStream(destFile, false).use { output ->
                            output.channel.truncate(0L)
                            val buf = ByteArray(64 * 1024)
                            var len: Int
                            while (input.read(buf).also { len = it } > 0) {
                                output.write(buf, 0, len)
                            }
                            output.flush()
                            output.fd.sync()
                        }
                    }
                    writtenPhysicalPath = destFile.absolutePath
                } else {
                    // Intentar vía ContentResolver en modo "wt" (write + truncate)
                    val uri = Uri.parse(targetUriOrPath)
                    val outStream = reactContext.contentResolver.openOutputStream(uri, "wt")
                        ?: reactContext.contentResolver.openOutputStream(uri, "w")
                        ?: throw IllegalStateException("ContentResolver no permitió abrir el destino en modo escritura")
                    FileInputStream(srcFile).use { input ->
                        outStream.use { output ->
                            val buf = ByteArray(64 * 1024)
                            var len: Int
                            while (input.read(buf).also { len = it } > 0) {
                                output.write(buf, 0, len)
                            }
                            output.flush()
                        }
                    }
                }

                if (writtenPhysicalPath != null) {
                    try {
                        MediaScannerConnection.scanFile(
                            reactContext,
                            arrayOf(writtenPhysicalPath),
                            null,
                            null
                        )
                    } catch (_: Exception) {}
                }

                val res = Arguments.createMap().apply {
                    putBoolean("success", true)
                    putDouble("sizeBytes", srcFile.length().toDouble())
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("OVERWRITE_ERROR", e.message ?: "No se pudo sobrescribir el archivo original", e)
            }
        }
    }

    @ReactMethod
    fun ensureSubfolderNative(baseDirPath: String, relativeSubdir: String, promise: Promise) {
        executor.execute {
            try {
                val baseDir = File(cleanFilePath(baseDirPath))
                val targetDir = File(baseDir, relativeSubdir)
                if (!targetDir.exists()) {
                    targetDir.mkdirs()
                }
                if (!targetDir.exists() || !targetDir.isDirectory) {
                    throw IllegalStateException("No se pudo crear la carpeta: " + targetDir.absolutePath)
                }
                promise.resolve("file://" + targetDir.absolutePath)
            } catch (e: Exception) {
                promise.reject("MKDIR_ERROR", e.message ?: "Error al crear carpeta", e)
            }
        }
    }

    @ReactMethod
    fun moveFileToSubfolderNative(sourceUriOrPath: String, baseDirPath: String, relativeSubdir: String, fileName: String, promise: Promise) {
        executor.execute {
            try {
                val baseDir = File(cleanFilePath(baseDirPath))
                val targetDir = File(baseDir, relativeSubdir)
                if (!targetDir.exists()) {
                    targetDir.mkdirs()
                }
                if (!targetDir.exists() || !targetDir.isDirectory) {
                    throw IllegalStateException("No se pudo crear la carpeta destino: " + targetDir.absolutePath)
                }

                val safeName = fileName.ifBlank { "media_" + System.currentTimeMillis() }
                var destFile = File(targetDir, safeName)
                val srcFile = if (!sourceUriOrPath.startsWith("content://")) File(cleanFilePath(sourceUriOrPath)) else null

                if (srcFile != null && srcFile.exists()) {
                    if (srcFile.absolutePath == destFile.absolutePath) {
                        promise.resolve("file://" + destFile.absolutePath)
                        return@execute
                    }
                    if (destFile.exists()) {
                        val dot = safeName.lastIndexOf('.')
                        val base = if (dot > 0) safeName.substring(0, dot) else safeName
                        val ext = if (dot > 0) safeName.substring(dot) else ""
                        destFile = File(targetDir, base + "_" + (System.currentTimeMillis() % 10000) + ext)
                    }
                    var moved = srcFile.renameTo(destFile)
                    if (!moved) {
                        FileInputStream(srcFile).use { input ->
                            FileOutputStream(destFile, false).use { output ->
                                val buf = ByteArray(64 * 1024)
                                var len: Int
                                while (input.read(buf).also { len = it } > 0) {
                                    output.write(buf, 0, len)
                                }
                                output.flush()
                                output.fd.sync()
                            }
                        }
                        if (destFile.exists() && destFile.length() > 0L) {
                            srcFile.delete()
                            moved = true
                        }
                    }
                    if (!moved) {
                        throw IllegalStateException("No se pudo mover el archivo a " + destFile.absolutePath)
                    }
                    try {
                        MediaScannerConnection.scanFile(
                            reactContext,
                            arrayOf(srcFile.absolutePath, destFile.absolutePath),
                            null,
                            null
                        )
                    } catch (_: Exception) {}
                    promise.resolve("file://" + destFile.absolutePath)
                } else {
                    val uri = Uri.parse(sourceUriOrPath)
                    val inputStream = reactContext.contentResolver.openInputStream(uri)
                        ?: throw IllegalStateException("No se pudo abrir el archivo origen")
                    inputStream.use { input ->
                        FileOutputStream(destFile, false).use { output ->
                            val buf = ByteArray(64 * 1024)
                            var len: Int
                            while (input.read(buf).also { len = it } > 0) {
                                output.write(buf, 0, len)
                            }
                            output.flush()
                            output.fd.sync()
                        }
                    }
                    try {
                        reactContext.contentResolver.delete(uri, null, null)
                    } catch (_: Exception) {}
                    try {
                        MediaScannerConnection.scanFile(
                            reactContext,
                            arrayOf(destFile.absolutePath),
                            null,
                            null
                        )
                    } catch (_: Exception) {}
                    promise.resolve("file://" + destFile.absolutePath)
                }
            } catch (e: Exception) {
                promise.reject("MOVE_ERROR", e.message ?: "Error al mover archivo", e)
            }
        }
    }

    @ReactMethod
    fun getVideoMetadata(sourcePath: String, promise: Promise) {
        executor.execute {
            val retriever = MediaMetadataRetriever()
            try {
                var sizeBytes = 0L
                if (sourcePath.startsWith("content://")) {
                    val uri = Uri.parse(sourcePath)
                    retriever.setDataSource(reactContext, uri)
                    try {
                        reactContext.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                            if (afd.length > 0L) sizeBytes = afd.length
                        }
                    } catch (_: Exception) {}
                } else {
                    val path = cleanFilePath(sourcePath)
                    val file = File(path)
                    retriever.setDataSource(path)
                    if (file.exists()) sizeBytes = file.length()
                }

                val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val bitrate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull() ?: 0L

                val map = Arguments.createMap().apply {
                    putInt("width", width)
                    putInt("height", height)
                    putInt("rotation", rotation)
                    putDouble("durationMs", durationMs.toDouble())
                    putDouble("bitrate", bitrate.toDouble())
                    putDouble("sizeBytes", sizeBytes.toDouble())
                }
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("METADATA_ERROR", e.message ?: "No se pudo leer metadatos del video", e)
            } finally {
                try {
                    retriever.release()
                } catch (_: Exception) {}
            }
        }
    }

    @ReactMethod
    fun extractFilmstripNative(sourcePath: String, count: Int, promise: Promise) {
        executor.execute {
            val retriever = MediaMetadataRetriever()
            try {
                if (sourcePath.startsWith("content://")) {
                    retriever.setDataSource(reactContext, Uri.parse(sourcePath))
                } else {
                    retriever.setDataSource(cleanFilePath(sourcePath))
                }
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val safeCount = count.coerceIn(4, 10)
                val outArray = Arguments.createArray()
                if (durationMs <= 100L) {
                    promise.resolve(outArray)
                    return@execute
                }
                val cacheDir = File(reactContext.cacheDir, "filmstrip_thumbs")
                if (!cacheDir.exists()) cacheDir.mkdirs()
                val batchPrefix = "fs_" + System.currentTimeMillis() + "_"

                for (i in 0 until safeCount) {
                    val timeUs = (((i + 0.5) / safeCount.toDouble()) * durationMs.toDouble() * 1000.0).toLong()
                    val bmp = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    if (bmp != null) {
                        val targetH = 110
                        val ratio = bmp.width.toFloat() / bmp.height.coerceAtLeast(1).toFloat()
                        val targetW = (targetH * ratio).toInt().coerceIn(60, 220)
                        val scaled = Bitmap.createScaledBitmap(bmp, targetW, targetH, true)
                        if (scaled != bmp) bmp.recycle()
                        val thumbFile = File(cacheDir, batchPrefix + i + ".jpg")
                        FileOutputStream(thumbFile, false).use { out ->
                            scaled.compress(Bitmap.CompressFormat.JPEG, 70, out)
                            out.flush()
                        }
                        scaled.recycle()
                        outArray.pushString("file://" + thumbFile.absolutePath)
                    }
                }
                promise.resolve(outArray)
            } catch (e: Exception) {
                promise.resolve(Arguments.createArray())
            } finally {
                try {
                    retriever.release()
                } catch (_: Exception) {}
            }
        }
    }

    @ReactMethod
    fun captureFrameNative(sourcePath: String, timeMs: Double, destPath: String, promise: Promise) {
        executor.execute {
            val retriever = MediaMetadataRetriever()
            try {
                if (sourcePath.startsWith("content://")) {
                    retriever.setDataSource(reactContext, Uri.parse(sourcePath))
                } else {
                    retriever.setDataSource(cleanFilePath(sourcePath))
                }
                val timeUs = (timeMs.coerceAtLeast(0.0) * 1000.0).toLong()
                val bmp = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
                    ?: retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    ?: throw IllegalStateException("No se pudo extraer el fotograma seleccionado")

                val destFile = File(cleanFilePath(destPath))
                destFile.parentFile?.mkdirs()
                FileOutputStream(destFile, false).use { out ->
                    bmp.compress(Bitmap.CompressFormat.JPEG, 96, out)
                    out.flush()
                }
                bmp.recycle()
                promise.resolve("file://" + destFile.absolutePath)
            } catch (e: Exception) {
                promise.reject("FRAME_ERROR", e.message ?: "Error al capturar cuadro", e)
            } finally {
                try {
                    retriever.release()
                } catch (_: Exception) {}
            }
        }
    }

    @ReactMethod
    fun applyCloneStampStrokes(sourcePath: String, outputPath: String, strokes: ReadableArray, promise: Promise) {
        executor.execute {
            try {
                val cleanOut = cleanFilePath(outputPath)
                val destFile = File(cleanOut)
                destFile.parentFile?.mkdirs()

                var rawBmp: Bitmap? = null
                var exifOrientation = ExifInterface.ORIENTATION_NORMAL

                if (sourcePath.startsWith("content://")) {
                    val uri = Uri.parse(sourcePath)
                    reactContext.contentResolver.openInputStream(uri)?.use { s ->
                        val exif = ExifInterface(s)
                        exifOrientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                    }
                    reactContext.contentResolver.openInputStream(uri)?.use { s ->
                        rawBmp = BitmapFactory.decodeStream(s)
                    }
                } else {
                    val inPath = cleanFilePath(sourcePath)
                    try {
                        val exif = ExifInterface(inPath)
                        exifOrientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                    } catch (_: Exception) {}
                    rawBmp = BitmapFactory.decodeFile(inPath)
                }

                val decoded = rawBmp ?: throw IllegalStateException("No se pudo decodificar la imagen para clonar.")
                val rotMatrix = android.graphics.Matrix()
                when (exifOrientation) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> rotMatrix.postRotate(90f)
                    ExifInterface.ORIENTATION_ROTATE_180 -> rotMatrix.postRotate(180f)
                    ExifInterface.ORIENTATION_ROTATE_270 -> rotMatrix.postRotate(270f)
                }

                val orientedBmp = if (!rotMatrix.isIdentity) {
                    val r = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, rotMatrix, true)
                    if (r != decoded) decoded.recycle()
                    r
                } else {
                    decoded
                }

                // Limitar lado máximo a 3200px si fuera gigantesca para evitar OOM manteniendo alta definición
                val maxSide = maxOf(orientedBmp.width, orientedBmp.height)
                val workingBmp = if (maxSide > 3200) {
                    val scale = 3200f / maxSide.toFloat()
                    val sw = (orientedBmp.width * scale).toInt().coerceAtLeast(1)
                    val sh = (orientedBmp.height * scale).toInt().coerceAtLeast(1)
                    val scaled = Bitmap.createScaledBitmap(orientedBmp, sw, sh, true)
                    if (scaled != orientedBmp) orientedBmp.recycle()
                    scaled.copy(Bitmap.Config.ARGB_8888, true)
                } else {
                    val copy = orientedBmp.copy(Bitmap.Config.ARGB_8888, true)
                    if (copy != orientedBmp) orientedBmp.recycle()
                    copy
                }

                val w = workingBmp.width
                val h = workingBmp.height
                val currentPixels = IntArray(w * h)
                workingBmp.getPixels(currentPixels, 0, w, 0, 0, w, h)

                for (sIdx in 0 until strokes.size()) {
                    val strokeMap = strokes.getMap(sIdx) ?: continue
                    val mode = if (strokeMap.hasKey("mode")) (strokeMap.getString("mode") ?: "clone") else "clone"
                    val sourceX = if (strokeMap.hasKey("sourceX")) strokeMap.getDouble("sourceX") else 0.5
                    val sourceY = if (strokeMap.hasKey("sourceY")) strokeMap.getDouble("sourceY") else 0.5
                    val startX = if (strokeMap.hasKey("startX")) strokeMap.getDouble("startX") else sourceX
                    val startY = if (strokeMap.hasKey("startY")) strokeMap.getDouble("startY") else sourceY
                    val radiusRatio = if (strokeMap.hasKey("radiusRatio")) strokeMap.getDouble("radiusRatio") else 0.045
                    val feather = if (strokeMap.hasKey("feather")) strokeMap.getDouble("feather") else 0.65
                    val pointsArr = if (strokeMap.hasKey("points")) strokeMap.getArray("points") else null
                    if (pointsArr == null || pointsArr.size() == 0) continue

                    val snapshotPixels = currentPixels.clone()
                    val rPx = (radiusRatio * w.toDouble()).toInt().coerceIn(4, maxOf(w, h) / 3)
                    val rSq = rPx * rPx
                    val innerRatio = (1.0 - feather.coerceIn(0.05, 0.95)).toFloat()
                    val dx = ((sourceX - startX) * w.toDouble()).toInt()
                    val dy = ((sourceY - startY) * h.toDouble()).toInt()

                    val dabCenters = mutableListOf<Pair<Int, Int>>()
                    var prevX = -1f
                    var prevY = -1f
                    val stepDist = (rPx.toFloat() * 0.25f).coerceAtLeast(2f)

                    for (pIdx in 0 until pointsArr.size()) {
                        val pt = pointsArr.getMap(pIdx) ?: continue
                        val px = ((if (pt.hasKey("x")) pt.getDouble("x") else 0.5) * w.toDouble()).toFloat()
                        val py = ((if (pt.hasKey("y")) pt.getDouble("y") else 0.5) * h.toDouble()).toFloat()
                        if (prevX < 0f) {
                            dabCenters.add(Pair(px.toInt().coerceIn(0, w - 1), py.toInt().coerceIn(0, h - 1)))
                            prevX = px
                            prevY = py
                        } else {
                            val dist = kotlin.math.hypot(px - prevX, py - prevY)
                            val steps = (dist / stepDist).toInt().coerceAtLeast(1)
                            for (st in 1..steps) {
                                val t = st.toFloat() / steps.toFloat()
                                val ix = (prevX + (px - prevX) * t).toInt().coerceIn(0, w - 1)
                                val iy = (prevY + (py - prevY) * t).toInt().coerceIn(0, h - 1)
                                dabCenters.add(Pair(ix, iy))
                            }
                            prevX = px
                            prevY = py
                        }
                    }

                    for ((cx, cy) in dabCenters) {
                        val minY = (cy - rPx).coerceAtLeast(0)
                        val maxY = (cy + rPx).coerceAtMost(h - 1)
                        val minX = (cx - rPx).coerceAtLeast(0)
                        val maxX = (cx + rPx).coerceAtMost(w - 1)
                        val ringR = (rPx * 1.32f).toInt().coerceAtLeast(rPx + 2)

                        for (y in minY..maxY) {
                            val dyCenter = y - cy
                            val rowOffset = y * w
                            for (x in minX..maxX) {
                                val dxCenter = x - cx
                                val dSq = dxCenter * dxCenter + dyCenter * dyCenter
                                if (dSq > rSq) continue

                                val distNorm = kotlin.math.sqrt(dSq.toFloat()) / rPx.toFloat()
                                val alpha = if (distNorm <= innerRatio) {
                                    1f
                                } else {
                                    val t = ((distNorm - innerRatio) / (1f - innerRatio).coerceAtLeast(0.01f)).coerceIn(0f, 1f)
                                    1f - t * t * (3f - 2f * t)
                                }

                                val srcColor: Int = if (mode == "heal") {
                                    // Muestreo inteligente del anillo exterior limpio con preservación de textura
                                    val lx = (cx - ringR).coerceIn(0, w - 1)
                                    val rx = (cx + ringR).coerceIn(0, w - 1)
                                    val ty = (cy - ringR).coerceIn(0, h - 1)
                                    val by = (cy + ringR).coerceIn(0, h - 1)
                                    val cL = snapshotPixels[y * w + lx]
                                    val cR = snapshotPixels[y * w + rx]
                                    val cT = snapshotPixels[ty * w + x]
                                    val cB = snapshotPixels[by * w + x]

                                    val wx = ((x - (cx - rPx)).toFloat() / (2f * rPx.toFloat())).coerceIn(0f, 1f)
                                    val wy = ((y - (cy - rPx)).toFloat() / (2f * rPx.toFloat())).coerceIn(0f, 1f)

                                    val rHoriz = ((cL shr 16 and 0xFF) * (1f - wx) + (cR shr 16 and 0xFF) * wx)
                                    val gHoriz = ((cL shr 8 and 0xFF) * (1f - wx) + (cR shr 8 and 0xFF) * wx)
                                    val bHoriz = ((cL and 0xFF) * (1f - wx) + (cR and 0xFF) * wx)

                                    val rVert = ((cT shr 16 and 0xFF) * (1f - wy) + (cB shr 16 and 0xFF) * wy)
                                    val gVert = ((cT shr 8 and 0xFF) * (1f - wy) + (cB shr 8 and 0xFF) * wy)
                                    val bVert = ((cT and 0xFF) * (1f - wy) + (cB and 0xFF) * wy)

                                    val sr = ((rHoriz + rVert) * 0.5f).toInt().coerceIn(0, 255)
                                    val sg = ((gHoriz + gVert) * 0.5f).toInt().coerceIn(0, 255)
                                    val sb = ((bHoriz + bVert) * 0.5f).toInt().coerceIn(0, 255)
                                    (0xFF shl 24) or (sr shl 16) or (sg shl 8) or sb
                                } else {
                                    val sx = (x + dx).coerceIn(0, w - 1)
                                    val sy = (y + dy).coerceIn(0, h - 1)
                                    snapshotPixels[sy * w + sx]
                                }

                                val dstColor = currentPixels[rowOffset + x]
                                val dr = dstColor shr 16 and 0xFF
                                val dg = dstColor shr 8 and 0xFF
                                val db = dstColor and 0xFF

                                val sr = srcColor shr 16 and 0xFF
                                val sg = srcColor shr 8 and 0xFF
                                val sb = srcColor and 0xFF

                                val outR = (dr + (sr - dr) * alpha).toInt().coerceIn(0, 255)
                                val outG = (dg + (sg - dg) * alpha).toInt().coerceIn(0, 255)
                                val outB = (db + (sb - db) * alpha).toInt().coerceIn(0, 255)

                                currentPixels[rowOffset + x] = (0xFF shl 24) or (outR shl 16) or (outG shl 8) or outB
                            }
                        }
                    }
                }

                workingBmp.setPixels(currentPixels, 0, w, 0, 0, w, h)
                val isPng = cleanOut.lowercase().endsWith(".png")
                FileOutputStream(destFile, false).use { out ->
                    workingBmp.compress(
                        if (isPng) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG,
                        95,
                        out
                    )
                    out.flush()
                }
                workingBmp.recycle()

                val res = Arguments.createMap().apply {
                    putString("outputPath", "file://" + destFile.absolutePath)
                    putInt("width", w)
                    putInt("height", h)
                    putDouble("sizeBytes", destFile.length().toDouble())
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("CLONE_STAMP_ERROR", e.message ?: "Error al aplicar tapón de clonar", e)
            }
        }
    }

    private data class SegmentUs(val startUs: Long, val endUs: Long, val offsetUs: Long)

    private fun parseSegmentsUs(segments: ReadableArray?, totalDurationUs: Long): List<SegmentUs> {
        val raw = mutableListOf<Pair<Long, Long>>()
        if (segments != null && segments.size() > 0) {
            for (i in 0 until segments.size()) {
                val map = segments.getMap(i) ?: continue
                val sMs = if (map.hasKey("startMs")) map.getDouble("startMs") else 0.0
                val eMs = if (map.hasKey("endMs")) map.getDouble("endMs") else (totalDurationUs / 1000.0)
                val sUs = (sMs * 1000.0).toLong().coerceAtLeast(0L)
                val eUs = (eMs * 1000.0).toLong().coerceAtMost(if (totalDurationUs > 0) totalDurationUs else Long.MAX_VALUE)
                if (eUs > sUs + 50_000L) {
                    raw.add(Pair(sUs, eUs))
                }
            }
        }
        if (raw.isEmpty()) {
            val end = if (totalDurationUs > 0) totalDurationUs else Long.MAX_VALUE
            raw.add(Pair(0L, end))
        }
        raw.sortBy { it.first }

        val result = mutableListOf<SegmentUs>()
        var accumulatedUs = 0L
        for (pair in raw) {
            result.add(SegmentUs(pair.first, pair.second, accumulatedUs))
            accumulatedUs += (pair.second - pair.first)
        }
        return result
    }

    /**
     * Une uno o múltiples tramos de un video de forma instantánea (Stream Copy sin pérdida de calidad ni resolución)
     */
    @ReactMethod
    fun trimSegments(sourcePath: String, outputPath: String, segments: ReadableArray, promise: Promise) {
        executor.execute {
            val inPath = cleanFilePath(sourcePath)
            val outPath = cleanFilePath(outputPath)
            var muxer: MediaMuxer? = null
            val videoExtractor = MediaExtractor()
            val audioExtractor = MediaExtractor()
            val retriever = MediaMetadataRetriever()

            try {
                File(outPath).parentFile?.mkdirs()
                if (File(outPath).exists()) File(outPath).delete()

                retriever.setDataSource(inPath)
                val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val totalDurationUs = durationMs * 1000L

                val segList = parseSegmentsUs(segments, totalDurationUs)
                val totalTargetUs = segList.sumOf { (it.endUs - it.startUs).coerceAtLeast(1L) }.coerceAtLeast(1L)

                videoExtractor.setDataSource(inPath)
                audioExtractor.setDataSource(inPath)

                var videoTrackIdx = -1
                var audioTrackIdx = -1
                var muxerVideoTrack = -1
                var muxerAudioTrack = -1
                var maxBufferSize = 2 * 1024 * 1024
                var candidateAudioFormat: MediaFormat? = null

                muxer = MediaMuxer(outPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                if (rotation != 0) {
                    muxer.setOrientationHint(rotation)
                }

                for (i in 0 until videoExtractor.trackCount) {
                    val format = videoExtractor.getTrackFormat(i)
                    val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
                    if (mime.startsWith("video/") && videoTrackIdx == -1) {
                        videoTrackIdx = i
                        muxerVideoTrack = muxer.addTrack(format)
                        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                            maxBufferSize = maxOf(maxBufferSize, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
                        }
                    } else if (mime.startsWith("audio/") && audioTrackIdx == -1) {
                        audioTrackIdx = i
                        candidateAudioFormat = format
                        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                            maxBufferSize = maxOf(maxBufferSize, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
                        }
                    }
                }

                if (videoTrackIdx == -1) {
                    throw IllegalStateException("No se encontró pista de video válida.")
                }

                // Verificar si existen muestras de audio dentro de los tramos antes de registrar la pista en MediaMuxer
                if (audioTrackIdx != -1 && candidateAudioFormat != null) {
                    audioExtractor.selectTrack(audioTrackIdx)
                    var hasValidAudio = false
                    for (seg in segList) {
                        audioExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                        while (true) {
                            val st = audioExtractor.sampleTime
                            if (st < 0 || st > seg.endUs) break
                            if (st >= seg.startUs) {
                                hasValidAudio = true
                                break
                            }
                            if (!audioExtractor.advance()) break
                        }
                        if (hasValidAudio) break
                    }
                    if (hasValidAudio) {
                        try {
                            muxerAudioTrack = muxer.addTrack(candidateAudioFormat)
                        } catch (_: Exception) {
                            muxerAudioTrack = -1
                        }
                    }
                }

                muxer.start()
                val buffer = ByteBuffer.allocateDirect(maxBufferSize)
                val bufferInfo = MediaCodec.BufferInfo()

                // 1. Copiar tramos de video
                videoExtractor.selectTrack(videoTrackIdx)
                var lastVideoPtsUs = -1L
                val actualSegmentStartOffsets = mutableListOf<SegmentUs>()
                var runningOffsetUs = 0L

                for ((segIdx, seg) in segList.withIndex()) {
                    videoExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                    val closestSyncTime = videoExtractor.sampleTime
                    if (closestSyncTime < 0 || closestSyncTime > seg.endUs) {
                        videoExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                    }

                    var firstSamplePts = -1L
                    var lastSampleInSegPts = seg.startUs
                    var writtenInSeg = 0

                    while (true) {
                        bufferInfo.offset = 0
                        bufferInfo.size = videoExtractor.readSampleData(buffer, 0)
                        if (bufferInfo.size < 0) break

                        val sampleTime = videoExtractor.sampleTime
                        if (sampleTime < 0) break
                        if (sampleTime > seg.endUs && writtenInSeg > 0) break

                        if (firstSamplePts == -1L) {
                            firstSamplePts = sampleTime
                        }

                        var newPts = runningOffsetUs + (sampleTime - firstSamplePts).coerceAtLeast(0L)
                        if (newPts <= lastVideoPtsUs) {
                            newPts = lastVideoPtsUs + 1000L
                        }
                        lastVideoPtsUs = newPts
                        lastSampleInSegPts = sampleTime

                        bufferInfo.presentationTimeUs = newPts
                        bufferInfo.flags = if ((videoExtractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
                            MediaCodec.BUFFER_FLAG_KEY_FRAME
                        } else {
                            0
                        }
                        muxer.writeSampleData(muxerVideoTrack, buffer, bufferInfo)
                        writtenInSeg++
                        if (sampleTime > seg.endUs) break
                        if (!videoExtractor.advance()) break
                    }

                    val actualStart = if (firstSamplePts >= 0L) firstSamplePts else seg.startUs
                    val actualEnd = maxOf(actualStart + 1000L, lastSampleInSegPts)
                    actualSegmentStartOffsets.add(SegmentUs(actualStart, actualEnd, runningOffsetUs))
                    runningOffsetUs = (lastVideoPtsUs + 33_333L).coerceAtLeast(runningOffsetUs)

                    emitProgress(((segIdx + 1).toDouble() / segList.size.toDouble()) * 0.85, "Recortando y uniendo tramos...")
                }

                // 2. Copiar tramos de audio sincronizados con el inicio real de cada tramo de video
                if (audioTrackIdx != -1 && muxerAudioTrack != -1) {
                    var lastAudioPtsUs = -1L
                    for (seg in actualSegmentStartOffsets) {
                        audioExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                        while (true) {
                            bufferInfo.offset = 0
                            bufferInfo.size = audioExtractor.readSampleData(buffer, 0)
                            if (bufferInfo.size < 0) break

                            val sampleTime = audioExtractor.sampleTime
                            if (sampleTime < 0 || sampleTime > seg.endUs) break

                            if (sampleTime >= seg.startUs) {
                                var newPts = seg.offsetUs + (sampleTime - seg.startUs)
                                if (newPts <= lastAudioPtsUs) {
                                    newPts = lastAudioPtsUs + 500L
                                }
                                lastAudioPtsUs = newPts
                                bufferInfo.presentationTimeUs = newPts
                                bufferInfo.flags = if ((audioExtractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
                                    MediaCodec.BUFFER_FLAG_KEY_FRAME
                                } else {
                                    0
                                }
                                muxer.writeSampleData(muxerAudioTrack, buffer, bufferInfo)
                            }
                            if (!audioExtractor.advance()) break
                        }
                    }
                }

                // Finalizar y volcar el contenedor MP4 a disco ANTES de leer su tamaño y resolver la promesa
                muxer.stop()
                muxer.release()
                muxer = null

                emitProgress(1.0, "¡Tramos listos!")
                val outFile = File(outPath)
                try {
                    MediaScannerConnection.scanFile(reactContext, arrayOf(outFile.absolutePath), null, null)
                } catch (_: Exception) {}
                val res = Arguments.createMap().apply {
                    putString("outputPath", "file://" + outFile.absolutePath)
                    putDouble("sizeBytes", outFile.length().toDouble())
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("TRIM_ERROR", e.message ?: "Error al recortar tramos del video", e)
            } finally {
                try { videoExtractor.release() } catch (_: Exception) {}
                try { audioExtractor.release() } catch (_: Exception) {}
                try { retriever.release() } catch (_: Exception) {}
                try { muxer?.stop() } catch (_: Exception) {}
                try { muxer?.release() } catch (_: Exception) {}
            }
        }
    }

    /**
     * Comprime el video por hardware (GPU/MediaCodec) manteniendo el 100% de la resolución original (width x height)
     */
    @ReactMethod
    fun compressVideo(
        sourcePath: String,
        outputPath: String,
        qualityFactor: Double,
        segments: ReadableArray?,
        promise: Promise
    ) {
        executor.execute {
            val inPath = cleanFilePath(sourcePath)
            val outPath = cleanFilePath(outputPath)

            val videoExtractor = MediaExtractor()
            val audioExtractor = MediaExtractor()
            val retriever = MediaMetadataRetriever()
            var decoder: MediaCodec? = null
            var encoder: MediaCodec? = null
            var muxer: MediaMuxer? = null
            var surfaceBridge: TranscodeSurfaceBridge? = null

            try {
                File(outPath).parentFile?.mkdirs()
                if (File(outPath).exists()) File(outPath).delete()

                val inFile = File(inPath)
                val origSizeBytes = if (inFile.exists()) inFile.length() else 0L

                retriever.setDataSource(inPath)
                val origWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 1280
                val origHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 720
                val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 1000L
                val metaBitrate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull() ?: 0L

                val totalDurationUs = (durationMs * 1000L).coerceAtLeast(100_000L)
                val segList = parseSegmentsUs(segments, totalDurationUs)
                val totalTargetUs = segList.sumOf { (it.endUs - it.startUs).coerceAtLeast(1L) }.coerceAtLeast(1L)
                val lastSegEndUs = segList.last().endUs

                videoExtractor.setDataSource(inPath)
                audioExtractor.setDataSource(inPath)

                var videoTrackIdx = -1
                var audioTrackIdx = -1
                var inputVideoFormat: MediaFormat? = null
                var inputAudioFormat: MediaFormat? = null

                for (i in 0 until videoExtractor.trackCount) {
                    val fmt = videoExtractor.getTrackFormat(i)
                    val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
                    if (mime.startsWith("video/") && videoTrackIdx == -1) {
                        videoTrackIdx = i
                        inputVideoFormat = fmt
                    } else if (mime.startsWith("audio/") && audioTrackIdx == -1) {
                        audioTrackIdx = i
                        inputAudioFormat = fmt
                    }
                }

                if (videoTrackIdx == -1 || inputVideoFormat == null) {
                    throw IllegalStateException("El archivo no contiene una pista de video compatible.")
                }

                // Alinear ancho y alto a múltiplos de 2 conservando 100% la resolución original
                val encWidth = (origWidth and 0xFFFE).coerceAtLeast(16)
                val encHeight = (origHeight and 0xFFFE).coerceAtLeast(16)

                var frameRate = 30
                if (inputVideoFormat.containsKey(MediaFormat.KEY_FRAME_RATE)) {
                    try {
                        frameRate = inputVideoFormat.getInteger(MediaFormat.KEY_FRAME_RATE).coerceIn(15, 60)
                    } catch (_: Exception) {
                        try {
                            frameRate = inputVideoFormat.getFloat(MediaFormat.KEY_FRAME_RATE).toInt().coerceIn(15, 60)
                        } catch (_: Exception) {}
                    }
                }

                // Calcular bitrate objetivo inteligente garantizando reducción real de peso a resolución 100% original
                val estimatedOrigBitrate = if (metaBitrate > 0L) {
                    metaBitrate
                } else {
                    ((origSizeBytes * 8L * 1000L) / durationMs.coerceAtLeast(1L)).coerceAtLeast(1_500_000L)
                }

                val factor = qualityFactor.coerceIn(0.20, 0.85)
                val bppBudget = (encWidth.toLong() * encHeight.toLong() * frameRate.toLong() * (0.13 * factor)).toLong()
                val directRatioBudget = (estimatedOrigBitrate.toDouble() * factor).toLong()
                val targetBitrate = minOf(directRatioBudget, bppBudget)
                    .coerceIn(500_000L, 22_000_000L)
                    .toInt()

                val outMime = MediaFormat.MIMETYPE_VIDEO_AVC
                val outputVideoFormat = MediaFormat.createVideoFormat(outMime, encWidth, encHeight).apply {
                    setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                    setInteger(MediaFormat.KEY_BIT_RATE, targetBitrate)
                    setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
                    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                }

                encoder = MediaCodec.createEncoderByType(outMime)
                encoder.configure(outputVideoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                val encoderInputSurface = encoder.createInputSurface()
                surfaceBridge = TranscodeSurfaceBridge(encoderInputSurface, encWidth, encHeight)
                encoder.start()

                val inMime = inputVideoFormat.getString(MediaFormat.KEY_MIME) ?: MediaFormat.MIMETYPE_VIDEO_AVC
                decoder = MediaCodec.createDecoderByType(inMime)
                decoder.configure(inputVideoFormat, surfaceBridge.decoderOutputSurface, null, 0)
                decoder.start()

                muxer = MediaMuxer(outPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                if (rotation != 0) {
                    muxer.setOrientationHint(rotation)
                }

                var muxerAudioTrack = -1
                if (audioTrackIdx != -1 && inputAudioFormat != null) {
                    audioExtractor.selectTrack(audioTrackIdx)
                    var hasAudioInSegs = false
                    for (seg in segList) {
                        audioExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                        while (true) {
                            val st = audioExtractor.sampleTime
                            if (st < 0 || st > seg.endUs) break
                            if (st >= seg.startUs) {
                                hasAudioInSegs = true
                                break
                            }
                            if (!audioExtractor.advance()) break
                        }
                        if (hasAudioInSegs) break
                    }
                    if (hasAudioInSegs) {
                        try {
                            muxerAudioTrack = muxer.addTrack(inputAudioFormat)
                        } catch (_: Exception) {
                            muxerAudioTrack = -1
                        }
                    }
                }

                videoExtractor.selectTrack(videoTrackIdx)
                if (segList.first().startUs > 0L) {
                    videoExtractor.seekTo(segList.first().startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                }

                val decBufferInfo = MediaCodec.BufferInfo()
                val encBufferInfo = MediaCodec.BufferInfo()
                var inputDone = false
                var decoderDone = false
                var encoderDone = false
                var muxerStarted = false
                var muxerVideoTrack = -1
                var lastEncodedPtsUs = -1L
                var lastProgressEmitMs = 0L

                fun mapPtsToSegments(ptsUs: Long): Long? {
                    for (seg in segList) {
                        if (ptsUs >= seg.startUs && ptsUs <= seg.endUs) {
                            return seg.offsetUs + (ptsUs - seg.startUs)
                        }
                    }
                    return null
                }

                while (!encoderDone) {
                    // 1. Alimentar el decoder
                    if (!inputDone) {
                        val inBufIdx = decoder.dequeueInputBuffer(5_000L)
                        if (inBufIdx >= 0) {
                            val inBuf = decoder.getInputBuffer(inBufIdx)
                            if (inBuf != null) {
                                val sampleSize = videoExtractor.readSampleData(inBuf, 0)
                                val sampleTime = videoExtractor.sampleTime
                                if (sampleSize < 0 || (sampleTime > lastSegEndUs && lastSegEndUs < Long.MAX_VALUE)) {
                                    decoder.queueInputBuffer(
                                        inBufIdx, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM
                                    )
                                    inputDone = true
                                } else {
                                    decoder.queueInputBuffer(
                                        inBufIdx, 0, sampleSize, sampleTime, videoExtractor.sampleFlags
                                    )
                                    videoExtractor.advance()
                                }
                            }
                        }
                    }

                    // 2. Drenar el decoder y renderizar hacia el encoder si el cuadro pertenece a un tramo activo
                    if (!decoderDone) {
                        val decStatus = decoder.dequeueOutputBuffer(decBufferInfo, 5_000L)
                        if (decStatus >= 0) {
                            val isEos = (decBufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            val ptsUs = decBufferInfo.presentationTimeUs
                            val mappedPtsUs = if (decBufferInfo.size > 0) mapPtsToSegments(ptsUs) else null
                            val doRender = mappedPtsUs != null

                            decoder.releaseOutputBuffer(decStatus, doRender)

                            if (doRender && mappedPtsUs != null) {
                                var safePtsUs = mappedPtsUs
                                if (safePtsUs <= lastEncodedPtsUs) {
                                    safePtsUs = lastEncodedPtsUs + 1000L
                                }
                                lastEncodedPtsUs = safePtsUs

                                if (surfaceBridge.awaitNewImage()) {
                                    surfaceBridge.drawImage(safePtsUs * 1000L)
                                    surfaceBridge.swapBuffers()
                                }

                                val now = System.currentTimeMillis()
                                if (now - lastProgressEmitMs > 140L) {
                                    lastProgressEmitMs = now
                                    val pct = (safePtsUs.toDouble() / totalTargetUs.toDouble()).coerceIn(0.0, 0.92)
                                    emitProgress(pct, "Comprimiendo video (100% resolución)...")
                                }
                            }

                            if (isEos) {
                                decoderDone = true
                                encoder.signalEndOfInputStream()
                            }
                        }
                    }

                    // 3. Drenar el encoder hacia el MediaMuxer
                    while (true) {
                        val encStatus = encoder.dequeueOutputBuffer(encBufferInfo, 5_000L)
                        if (encStatus == MediaCodec.INFO_TRY_AGAIN_LATER) {
                            break
                        } else if (encStatus == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            if (!muxerStarted) {
                                muxerVideoTrack = muxer.addTrack(encoder.outputFormat)
                                muxer.start()
                                muxerStarted = true
                            }
                        } else if (encStatus >= 0) {
                            val encodedData = encoder.getOutputBuffer(encStatus)
                            if ((encBufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                encBufferInfo.size = 0
                            }
                            if (encBufferInfo.size > 0 && muxerStarted && encodedData != null) {
                                encodedData.position(encBufferInfo.offset)
                                encodedData.limit(encBufferInfo.offset + encBufferInfo.size)
                                muxer.writeSampleData(muxerVideoTrack, encodedData, encBufferInfo)
                            }
                            encoder.releaseOutputBuffer(encStatus, false)
                            if ((encBufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                                encoderDone = true
                                break
                            }
                        }
                    }
                }

                // 4. Copiar el audio original sin pérdida para los tramos activos
                if (muxerStarted && muxerAudioTrack != -1 && audioTrackIdx != -1) {
                    emitProgress(0.95, "Sincronizando pista de audio...")
                    audioExtractor.selectTrack(audioTrackIdx)
                    val audioBuf = ByteBuffer.allocateDirect(512 * 1024)
                    val audioInfo = MediaCodec.BufferInfo()
                    var lastAudioPtsUs = -1L

                    for (seg in segList) {
                        audioExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                        while (true) {
                            audioInfo.offset = 0
                            audioInfo.size = audioExtractor.readSampleData(audioBuf, 0)
                            if (audioInfo.size < 0) break

                            val sampleTime = audioExtractor.sampleTime
                            if (sampleTime < 0 || sampleTime > seg.endUs) break

                            if (sampleTime >= seg.startUs) {
                                var newPts = seg.offsetUs + (sampleTime - seg.startUs)
                                if (newPts <= lastAudioPtsUs) {
                                    newPts = lastAudioPtsUs + 500L
                                }
                                lastAudioPtsUs = newPts
                                audioInfo.presentationTimeUs = newPts
                                audioInfo.flags = if ((audioExtractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
                                    MediaCodec.BUFFER_FLAG_KEY_FRAME
                                } else {
                                    0
                                }
                                muxer.writeSampleData(muxerAudioTrack, audioBuf, audioInfo)
                            }
                            audioExtractor.advance()
                        }
                    }
                }

                try { decoder?.stop() } catch (_: Exception) {}
                try { decoder?.release() } catch (_: Exception) {}
                decoder = null
                try { encoder?.stop() } catch (_: Exception) {}
                try { encoder?.release() } catch (_: Exception) {}
                encoder = null
                try { surfaceBridge?.release() } catch (_: Exception) {}
                surfaceBridge = null
                if (muxerStarted) {
                    muxer?.stop()
                }
                muxer?.release()
                muxer = null

                emitProgress(1.0, "¡Compresión completada!")
                val outFile = File(outPath)
                try {
                    MediaScannerConnection.scanFile(reactContext, arrayOf(outFile.absolutePath), null, null)
                } catch (_: Exception) {}
                val res = Arguments.createMap().apply {
                    putString("outputPath", "file://" + outFile.absolutePath)
                    putDouble("sizeBytes", outFile.length().toDouble())
                    putDouble("originalSizeBytes", origSizeBytes.toDouble())
                    putInt("width", encWidth)
                    putInt("height", encHeight)
                    putInt("targetBitrate", targetBitrate)
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("COMPRESS_ERROR", e.message ?: "Error al comprimir el video", e)
            } finally {
                try { videoExtractor.release() } catch (_: Exception) {}
                try { audioExtractor.release() } catch (_: Exception) {}
                try { retriever.release() } catch (_: Exception) {}
                try { decoder?.stop() } catch (_: Exception) {}
                try { decoder?.release() } catch (_: Exception) {}
                try { encoder?.stop() } catch (_: Exception) {}
                try { encoder?.release() } catch (_: Exception) {}
                try { surfaceBridge?.release() } catch (_: Exception) {}
                try { muxer?.stop() } catch (_: Exception) {}
                try { muxer?.release() } catch (_: Exception) {}
            }
        }
    }
}

/**
 * Puente OpenGL ES 2.0 / EGL14 entre la salida del Decoder y la superficie de entrada del Encoder
 * manteniendo el 100% de la resolución original en GPU sin copias en CPU.
 */
private class TranscodeSurfaceBridge(
    private val encoderSurface: Surface,
    private val width: Int,
    private val height: Int
) : SurfaceTexture.OnFrameAvailableListener {

    private var eglDisplay: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE

    private var surfaceTexture: SurfaceTexture? = null
    var decoderOutputSurface: Surface? = null
        private set

    private val frameSyncObject = Object()
    private var frameAvailable = false
    private val handlerThread = HandlerThread("VideoEngineFrameListener")

    private var program = 0
    private var textureId = -12345
    private var uMVPMatrixHandle = 0
    private var uSTMatrixHandle = 0
    private var aPositionHandle = 0
    private var aTextureHandle = 0

    private val mMVPMatrix = FloatArray(16)
    private val mSTMatrix = FloatArray(16)
    private val triangleVertices: FloatBuffer

    init {
        val verticesData = floatArrayOf(
            // X, Y, Z, U, V
            -1.0f, -1.0f, 0f, 0f, 0f,
             1.0f, -1.0f, 0f, 1f, 0f,
            -1.0f,  1.0f, 0f, 0f, 1f,
             1.0f,  1.0f, 0f, 1f, 1f
        )
        triangleVertices = ByteBuffer.allocateDirect(verticesData.size * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer()
        triangleVertices.put(verticesData).position(0)
        Matrix.setIdentityM(mSTMatrix, 0)

        initEGL()
        initGL()

        handlerThread.start()
        val st = SurfaceTexture(textureId)
        st.setOnFrameAvailableListener(this, Handler(handlerThread.looper))
        surfaceTexture = st
        decoderOutputSurface = Surface(st)
    }

    private fun initEGL() {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        EGL14.eglInitialize(eglDisplay, version, 0, version, 1)

        val attribList = intArrayOf(
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            0x3142, 1, // EGL_RECORDABLE_ANDROID
            EGL14.EGL_NONE
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val numConfigs = IntArray(1)
        EGL14.eglChooseConfig(eglDisplay, attribList, 0, configs, 0, configs.size, numConfigs, 0)

        val ctxAttribs = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
        eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, ctxAttribs, 0)

        val surfaceAttribs = intArrayOf(EGL14.EGL_NONE)
        eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, configs[0], encoderSurface, surfaceAttribs, 0)
        EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)
    }

    private fun loadShader(shaderType: Int, source: String): Int {
        val shader = GLES20.glCreateShader(shaderType)
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        return shader
    }

    private fun initGL() {
        val vertexShader = """
            uniform mat4 uMVPMatrix;
            uniform mat4 uSTMatrix;
            attribute vec4 aPosition;
            attribute vec4 aTextureCoord;
            varying vec2 vTextureCoord;
            void main() {
                gl_Position = uMVPMatrix * aPosition;
                vTextureCoord = (uSTMatrix * aTextureCoord).xy;
            }
        """.trimIndent()

        val fragmentShader = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 vTextureCoord;
            uniform samplerExternalOES sTexture;
            void main() {
                gl_FragColor = texture2D(sTexture, vTextureCoord);
            }
        """.trimIndent()

        val vs = loadShader(GLES20.GL_VERTEX_SHADER, vertexShader)
        val fs = loadShader(GLES20.GL_FRAGMENT_SHADER, fragmentShader)
        program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vs)
        GLES20.glAttachShader(program, fs)
        GLES20.glLinkProgram(program)

        aPositionHandle = GLES20.glGetAttribLocation(program, "aPosition")
        aTextureHandle = GLES20.glGetAttribLocation(program, "aTextureCoord")
        uMVPMatrixHandle = GLES20.glGetUniformLocation(program, "uMVPMatrix")
        uSTMatrixHandle = GLES20.glGetUniformLocation(program, "uSTMatrix")

        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        textureId = textures[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR.toFloat())
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR.toFloat())
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    override fun onFrameAvailable(st: SurfaceTexture?) {
        synchronized(frameSyncObject) {
            frameAvailable = true
            frameSyncObject.notifyAll()
        }
    }

    fun awaitNewImage(): Boolean {
        synchronized(frameSyncObject) {
            var waited = 0
            while (!frameAvailable && waited < 600) {
                try {
                    frameSyncObject.wait(100)
                    waited += 100
                } catch (_: InterruptedException) {
                    break
                }
            }
            if (!frameAvailable) return false
            frameAvailable = false
        }
        surfaceTexture?.updateTexImage()
        return true
    }

    fun drawImage(presentationTimeNs: Long) {
        val st = surfaceTexture ?: return
        st.getTransformMatrix(mSTMatrix)

        GLES20.glViewport(0, 0, width, height)
        GLES20.glClearColor(0.0f, 0.0f, 0.0f, 1.0f)
        GLES20.glClear(GLES20.GL_DEPTH_BUFFER_BIT or GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)

        triangleVertices.position(0)
        GLES20.glVertexAttribPointer(aPositionHandle, 3, GLES20.GL_FLOAT, false, 20, triangleVertices)
        GLES20.glEnableVertexAttribArray(aPositionHandle)

        triangleVertices.position(3)
        GLES20.glVertexAttribPointer(aTextureHandle, 2, GLES20.GL_FLOAT, false, 20, triangleVertices)
        GLES20.glEnableVertexAttribArray(aTextureHandle)

        Matrix.setIdentityM(mMVPMatrix, 0)
        GLES20.glUniformMatrix4fv(uMVPMatrixHandle, 1, false, mMVPMatrix, 0)
        GLES20.glUniformMatrix4fv(uSTMatrixHandle, 1, false, mSTMatrix, 0)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glFinish()

        EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, presentationTimeNs)
    }

    fun swapBuffers() {
        EGL14.eglSwapBuffers(eglDisplay, eglSurface)
    }

    fun release() {
        try { handlerThread.quitSafely() } catch (_: Exception) {}
        if (eglDisplay !== EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            EGL14.eglDestroySurface(eglDisplay, eglSurface)
            EGL14.eglDestroyContext(eglDisplay, eglContext)
            EGL14.eglReleaseThread()
            EGL14.eglTerminate(eglDisplay)
        }
        eglDisplay = EGL14.EGL_NO_DISPLAY
        eglContext = EGL14.EGL_NO_CONTEXT
        eglSurface = EGL14.EGL_NO_SURFACE
        try { decoderOutputSurface?.release() } catch (_: Exception) {}
        try { surfaceTexture?.release() } catch (_: Exception) {}
        try { encoderSurface.release() } catch (_: Exception) {}
        decoderOutputSurface = null
        surfaceTexture = null
    }
}
`;

module.exports = function withFastAndroidBuild(config) {
  // 1. Optimización de compilación Gradle y arquitecturas ARM
  config = withGradleProperties(config, (gradleConfig) => {
    const setProp = (key, value) => {
      const idx = gradleConfig.modResults.findIndex(
        (item) => item.type === 'property' && item.key === key
      );
      if (idx >= 0) {
        gradleConfig.modResults[idx].value = value;
      } else {
        gradleConfig.modResults.push({ type: 'property', key, value });
      }
    };

    setProp('reactNativeArchitectures', 'arm64-v8a,armeabi-v7a');
    setProp('org.gradle.parallel', 'true');
    setProp('org.gradle.caching', 'true');
    setProp('org.gradle.configureondemand', 'true');
    setProp('org.gradle.jvmargs', '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8');

    return gradleConfig;
  });

  // 2. Inyectar motor nativo de compresión y recorte multi-tramo de video (VideoEngineModule)
  config = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const pkgDir = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        'com',
        'rembrant',
        'galeriaapp'
      );
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'VideoEnginePackage.kt'), VIDEO_ENGINE_PACKAGE_KT, 'utf8');
      fs.writeFileSync(path.join(pkgDir, 'VideoEngineModule.kt'), VIDEO_ENGINE_MODULE_KT, 'utf8');
      return modConfig;
    },
  ]);

  // 3. Registrar VideoEnginePackage en MainApplication.kt
  config = withMainApplication(config, (appConfig) => {
    let contents = appConfig.modResults.contents;
    if (!contents.includes('VideoEnginePackage')) {
      if (contents.includes('PackageList(this).packages.apply {')) {
        contents = contents.replace(
          'PackageList(this).packages.apply {',
          'PackageList(this).packages.apply {\n              add(VideoEnginePackage())'
        );
      } else if (contents.includes('PackageList(this).packages')) {
        contents = contents.replace(
          'PackageList(this).packages',
          'PackageList(this).packages.apply { add(VideoEnginePackage()) }'
        );
      }
      appConfig.modResults.contents = contents;
    }
    return appConfig;
  });

  // 4. Registrar Intent Filter ACTION_SEND (text/plain) en MainActivity para recibir enlaces compartidos desde cualquier app
  config = withAndroidManifest(config, (manifestConfig) => {
    const app = manifestConfig.modResults.manifest.application?.[0];
    if (app && Array.isArray(app.activity)) {
      const mainAct = app.activity.find(
        (a) =>
          a.$?.['android:name'] === '.MainActivity' ||
          a.$?.['android:name']?.endsWith('.MainActivity')
      );
      if (mainAct) {
        mainAct.$['android:launchMode'] = 'singleTask';
        if (!Array.isArray(mainAct['intent-filter'])) {
          mainAct['intent-filter'] = [];
        }
        const alreadyHasSend = mainAct['intent-filter'].some((f) =>
          f.action?.some((act) => act.$?.['android:name'] === 'android.intent.action.SEND')
        );
        if (!alreadyHasSend) {
          mainAct['intent-filter'].push({
            action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
            category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
            data: [{ $: { 'android:mimeType': 'text/plain' } }],
          });
        }
      }
    }
    return manifestConfig;
  });

  return config;
};
