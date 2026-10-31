const {
  withGradleProperties,
  withDangerousMod,
  withMainApplication,
  withAndroidManifest,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const VIDEO_ENGINE_PACKAGE_KT = `package com.rembrant.galeriaapp

import android.graphics.Color
import android.widget.ImageView
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager

class BgCameraPreviewViewManager : SimpleViewManager<ImageView>() {
    override fun getName(): String = "BgCameraPreviewView"

    override fun createViewInstance(reactContext: ThemedReactContext): ImageView {
        val iv = ImageView(reactContext).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#050811"))
        }
        BackgroundVideoRecordService.registerPreviewView(iv)
        return iv
    }

    override fun onDropViewInstance(view: ImageView) {
        BackgroundVideoRecordService.unregisterPreviewView(view)
        super.onDropViewInstance(view)
    }
}

class VideoEnginePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(VideoEngineModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return listOf(BgCameraPreviewViewManager())
    }
}
`;

const VIDEO_ENGINE_MODULE_KT = `package com.rembrant.galeriaapp

import android.app.Activity
import android.app.Dialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
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
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
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
import androidx.core.app.NotificationCompat
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
import java.io.ByteArrayOutputStream
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
    private val compressionExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var compressionWakeLock: PowerManager.WakeLock? = null

    init {
        reactContext.addActivityEventListener(this)
        activeReactContext = reactContext
    }

    companion object {
        @Volatile
        private var activeReactContext: ReactApplicationContext? = null

        fun getActiveActivity(): Activity? {
            return try {
                activeReactContext?.currentActivity
            } catch (_: Exception) {
                null
            }
        }

        fun emitBgRecordEvent(eventName: String, params: com.facebook.react.bridge.WritableMap) {
            try {
                activeReactContext
                    ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    ?.emit(eventName, params)
            } catch (_: Exception) {}
        }
    }

    override fun getName(): String = "VideoEngineModule"

    @ReactMethod
    fun isBiometricAvailableNative(promise: Promise) {
        try {
            var available = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val bm = reactContext.getSystemService(android.hardware.biometrics.BiometricManager::class.java)
                if (bm != null) {
                    val canAuth = bm.canAuthenticate()
                    available = (canAuth == android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS)
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                available = true
            }
            val res = Arguments.createMap().apply {
                putBoolean("available", available)
            }
            promise.resolve(res)
        } catch (_: Exception) {
            val res = Arguments.createMap().apply {
                putBoolean("available", false)
            }
            promise.resolve(res)
        }
    }

    @ReactMethod
    fun authenticateBiometricNative(title: String, subtitle: String, promise: Promise) {
        val done = AtomicBoolean(false)
        fun finish(success: Boolean, reason: String) {
            if (!done.compareAndSet(false, true)) return
            val map = Arguments.createMap().apply {
                putBoolean("success", success)
                putString("reason", reason)
            }
            promise.resolve(map)
        }

        UiThreadUtil.runOnUiThread {
            try {
                val act = reactContext.currentActivity
                if (act == null || act.isFinishing) {
                    finish(false, "no_activity")
                    return@runOnUiThread
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    val cancelSignal = android.os.CancellationSignal()
                    val prompt = android.hardware.biometrics.BiometricPrompt.Builder(act)
                        .setTitle(title.ifBlank { "Desbloquear con Huella Digital" })
                        .setSubtitle(subtitle.ifBlank { "Coloca tu huella para acceder a Archivos y Bóveda Privada" })
                        .setNegativeButton("Usar contraseña", act.mainExecutor) { _, _ ->
                            finish(false, "use_pin")
                        }
                        .build()

                    prompt.authenticate(
                        cancelSignal,
                        act.mainExecutor,
                        object : android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                            override fun onAuthenticationSucceeded(result: android.hardware.biometrics.BiometricPrompt.AuthenticationResult?) {
                                finish(true, "ok")
                            }

                            override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                                finish(false, errString?.toString() ?: "cancelled")
                            }

                            override fun onAuthenticationFailed() {
                                // El sistema permite volver a intentar en el mismo diálogo
                            }
                        }
                    )
                } else {
                    finish(false, "unsupported_sdk")
                }
            } catch (e: Exception) {
                finish(false, e.message ?: "error")
            }
        }
    }

    @ReactMethod
    fun getFolderNoMediaStatusNative(dirPath: String, promise: Promise) {
        executor.execute {
            try {
                val dir = File(cleanFilePath(dirPath))
                val noMediaFile = File(dir, ".nomedia")
                val exists = noMediaFile.exists()
                val map = Arguments.createMap().apply {
                    putBoolean("hasNoMedia", exists)
                    putBoolean("hiddenFromOtherApps", exists)
                    putString("path", dir.absolutePath)
                }
                promise.resolve(map)
            } catch (_: Exception) {
                val map = Arguments.createMap().apply {
                    putBoolean("hasNoMedia", false)
                    putBoolean("hiddenFromOtherApps", false)
                }
                promise.resolve(map)
            }
        }
    }

    @ReactMethod
    fun setFolderNoMediaNative(dirPath: String, hideFromOtherApps: Boolean, promise: Promise) {
        executor.execute {
            try {
                val dir = File(cleanFilePath(dirPath))
                if (!dir.exists()) {
                    dir.mkdirs()
                }
                val targets = mutableListOf(dir)
                val fotosSub = File(dir, "Fotos")
                val videosSub = File(dir, "Videos")
                if (fotosSub.exists() && fotosSub.isDirectory) targets.add(fotosSub)
                if (videosSub.exists() && videosSub.isDirectory) targets.add(videosSub)

                for (t in targets) {
                    val nm = File(t, ".nomedia")
                    if (hideFromOtherApps) {
                        if (!nm.exists()) {
                            nm.createNewFile()
                        }
                    } else {
                        if (nm.exists()) {
                            nm.delete()
                        }
                    }
                }

                // Notificar a MediaScanner del cambio
                try {
                    val scanList = mutableListOf(dir.absolutePath)
                    val children = dir.listFiles() ?: emptyArray()
                    for (c in children.take(60)) {
                        if (c.isFile && !c.name.startsWith(".")) {
                            scanList.add(c.absolutePath)
                        }
                    }
                    MediaScannerConnection.scanFile(
                        reactContext,
                        scanList.toTypedArray(),
                        null,
                        null
                    )
                } catch (_: Exception) {}

                val existsNow = File(dir, ".nomedia").exists()
                val map = Arguments.createMap().apply {
                    putBoolean("hasNoMedia", existsNow)
                    putBoolean("hiddenFromOtherApps", existsNow)
                    putString("path", dir.absolutePath)
                }
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("NOMEDIA_ERROR", e.message ?: "No se pudo actualizar .nomedia", e)
            }
        }
    }

    @ReactMethod
    fun clearWebBrowserDataNative(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                try {
                    val cm = CookieManager.getInstance()
                    cm.removeAllCookies(null)
                    cm.flush()
                } catch (_: Exception) {}

                try {
                    android.webkit.WebStorage.getInstance().deleteAllData()
                } catch (_: Exception) {}

                try {
                    android.webkit.WebViewDatabase.getInstance(reactContext).clearFormData()
                    android.webkit.WebViewDatabase.getInstance(reactContext).clearHttpAuthUsernamePassword()
                } catch (_: Exception) {}

                val act = reactContext.currentActivity
                if (act != null && !act.isFinishing) {
                    try {
                        val tempWv = WebView(act)
                        tempWv.clearCache(true)
                        tempWv.clearHistory()
                        tempWv.clearFormData()
                        tempWv.destroy()
                    } catch (_: Exception) {}
                }

                val res = Arguments.createMap().apply {
                    putBoolean("success", true)
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("CLEAR_WEB_ERROR", e.message ?: "Error al limpiar navegador", e)
            }
        }
    }

    @ReactMethod
    fun canDrawOverlaysNative(promise: Promise) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                promise.resolve(android.provider.Settings.canDrawOverlays(reactContext))
            } else {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun requestOverlayPermissionNative(promise: Promise) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M &&
                !android.provider.Settings.canDrawOverlays(reactContext)
            ) {
                val intent = Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + reactContext.packageName)
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                promise.resolve(true)
                return
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getAvailableCamerasNative(promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager
            val arr = Arguments.createArray()
            var backCount = 0
            var frontCount = 0
            for (id in cm.cameraIdList) {
                val chars = cm.getCameraCharacteristics(id)
                val facingInt = chars.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING)
                val focalLengths = chars.get(android.hardware.camera2.CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                val focal = if (focalLengths != null && focalLengths.isNotEmpty()) focalLengths[0] else 0f
                val isFront = facingInt == android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
                val facingStr = if (isFront) "front" else "back"
                val label = if (isFront) {
                    frontCount += 1
                    if (frontCount == 1) "Frontal" else "Frontal " + frontCount
                } else {
                    backCount += 1
                    if (backCount == 1) {
                        "Trasera 1x"
                    } else if (focal > 0f && focal < 2.5f) {
                        "Gran Angular (" + id + ")"
                    } else if (focal >= 5.0f) {
                        "Telefoto (" + id + ")"
                    } else {
                        "Trasera " + backCount
                    }
                }
                val map = Arguments.createMap().apply {
                    putString("cameraId", id)
                    putString("facing", facingStr)
                    putString("label", label)
                    putDouble("focalLength", focal.toDouble())
                }
                arr.pushMap(map)
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.resolve(Arguments.createArray())
        }
    }

    @ReactMethod
    fun startBackgroundVideoRecordNative(
        facing: String,
        torchOn: Boolean,
        showFloatingPreview: Boolean,
        maxDurationSec: Int,
        promise: Promise
    ) {
        try {
            val cleanSpec = facing.trim()
            val useFront = cleanSpec.lowercase() == "front"
            BackgroundVideoRecordService.startServiceRecording(
                context = reactContext,
                useFrontCamera = useFront,
                cameraSpec = cleanSpec,
                enableTorch = torchOn,
                showFloatingPreview = showFloatingPreview,
                maxDurationSec = if (maxDurationSec > 0) maxDurationSec else 600
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BG_REC_START_ERR", e.message ?: "Error al iniciar servicio de grabación", e)
        }
    }

    @ReactMethod
    fun startCameraPreviewNative(
        facing: String,
        torchOn: Boolean,
        promise: Promise
    ) {
        try {
            val cleanSpec = facing.trim()
            val useFront = cleanSpec.lowercase() == "front"
            BackgroundVideoRecordService.startServicePreview(
                context = reactContext,
                useFrontCamera = useFront,
                cameraSpec = cleanSpec,
                enableTorch = torchOn
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun stopCameraPreviewNative(promise: Promise) {
        try {
            BackgroundVideoRecordService.stopPreviewIfIdle(reactContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun takeCameraPhotoNative(promise: Promise) {
        try {
            BackgroundVideoRecordService.takePhotoSnapshot(reactContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun switchBackgroundCameraNative(facingOrCameraId: String, promise: Promise) {
        try {
            BackgroundVideoRecordService.switchCamera(reactContext, facingOrCameraId.trim())
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun stopBackgroundVideoRecordNative(promise: Promise) {
        try {
            BackgroundVideoRecordService.stopServiceRecording(reactContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun pauseBackgroundVideoRecordNative(promise: Promise) {
        try {
            BackgroundVideoRecordService.sendControlAction(
                reactContext,
                BackgroundVideoRecordService.ACTION_PAUSE_RECORD
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun resumeBackgroundVideoRecordNative(promise: Promise) {
        try {
            BackgroundVideoRecordService.sendControlAction(
                reactContext,
                BackgroundVideoRecordService.ACTION_RESUME_RECORD
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun setBackgroundFloatingPreviewNative(visible: Boolean, promise: Promise) {
        try {
            BackgroundVideoRecordService.setFloatingPreview(reactContext, visible)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun setBackgroundTorchNative(enabled: Boolean, promise: Promise) {
        try {
            BackgroundVideoRecordService.setTorch(reactContext, enabled)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getBackgroundVideoRecordStatusNative(promise: Promise) {
        try {
            val map = Arguments.createMap().apply {
                putBoolean("isRecording", BackgroundVideoRecordService.isRunning)
                putBoolean("isPreviewOnly", BackgroundVideoRecordService.isServiceActive && !BackgroundVideoRecordService.isRunning)
                putBoolean("isPaused", BackgroundVideoRecordService.isPausedState)
                putInt("elapsedSeconds", BackgroundVideoRecordService.elapsedSecondsState)
                putString("facing", if (BackgroundVideoRecordService.useFrontState) "front" else "back")
                putString("cameraSpec", BackgroundVideoRecordService.cameraSpecState)
                putBoolean("torchOn", BackgroundVideoRecordService.torchOnState)
                putBoolean("showFloatingPreview", BackgroundVideoRecordService.floatingPreviewState)
                putString("outputPath", BackgroundVideoRecordService.currentOutputPath ?: "")
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.resolve(null)
        }
    }

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
        var uaBtnRef: TextView? = null
        var statusBannerRef: TextView? = null
        var detectedMediaUrl: String? = null
        var currentUaIndex = 0

        val userAgents = listOf(
            Pair("📱 S24", "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36"),
            Pair("🍎 iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
            Pair("💻 PC", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
            Pair("📱 Pixel", "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36")
        )

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
                    putString("detectedStreamUrl", detectedMediaUrl ?: "")
                }
                promise.resolve(map)
            }
        }

        UiThreadUtil.runOnUiThread {
            try {
                val act = reactContext.currentActivity
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
                    databaseEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    loadsImagesAutomatically = true
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                    useWideViewPort = true
                    loadWithOverviewMode = true
                    builtInZoomControls = true
                    displayZoomControls = false
                    userAgentString = userAgents[0].second
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
                                downloadBtnRef?.text = "⬇ ¡Video Detectado! (Bajar)"
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

                // Renglón 1: Barra de dirección con margen superior seguro (>= 48dp para no traslapar reloj/batería)
                val navBar = LinearLayout(act).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setBackgroundColor(Color.parseColor("#151525"))
                    setPadding(16, 108, 16, 12)
                }

                fun makeNavBtn(label: String, bgHex: String, onClick: () -> Unit): TextView {
                    return TextView(act).apply {
                        text = label
                        setTextColor(Color.WHITE)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
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
                            detectedMediaUrl = null
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
                    detectedMediaUrl = null
                    val target = normalizeInputUrl(urlInput.text?.toString() ?: "")
                    wv.loadUrl(target)
                }

                val closeBtn = makeNavBtn("✕", "#EF4444") {
                    closeBrowser("closed", wv.url ?: "")
                }

                navBar.addView(backBtn)
                navBar.addView(fwdBtn)
                navBar.addView(reloadBtn)
                navBar.addView(urlInput)
                navBar.addView(goBtn)
                navBar.addView(closeBtn)

                // Renglón 2: Herramientas "Modo 1ª Vez (Limpiar Datos)" + Cambiar Dispositivo + Descargar Video
                val toolsBar = LinearLayout(act).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setBackgroundColor(Color.parseColor("#0F172A"))
                    setPadding(16, 8, 16, 12)
                }

                val statusBanner = TextView(act).apply {
                    text = ""
                    visibility = android.view.View.GONE
                    setTextColor(Color.parseColor("#A7F3D0"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
                    typeface = Typeface.DEFAULT_BOLD
                    gravity = Gravity.CENTER
                    setBackgroundColor(Color.parseColor("#064E3B"))
                    setPadding(20, 10, 20, 10)
                }
                statusBannerRef = statusBanner

                fun showTempBanner(msg: String) {
                    statusBannerRef?.text = msg
                    statusBannerRef?.visibility = android.view.View.VISIBLE
                    mainHandler.postDelayed({
                        statusBannerRef?.visibility = android.view.View.GONE
                    }, 3500L)
                }

                val cleanFirstTimeBtn = makeNavBtn("🧹 Limpiar 1ª Vez", "#059669") {
                    try {
                        val cm = CookieManager.getInstance()
                        cm.removeAllCookies(null)
                        cm.flush()
                    } catch (_: Exception) {}
                    try {
                        android.webkit.WebStorage.getInstance().deleteAllData()
                    } catch (_: Exception) {}
                    try {
                        wv.evaluateJavascript("try{localStorage.clear();sessionStorage.clear();}catch(e){}", null)
                        wv.clearCache(true)
                        wv.clearHistory()
                        wv.clearFormData()
                    } catch (_: Exception) {}
                    // Rotar versión de navegador ligeramente para renovar huella de sesión
                    val randBuild = (110..199).random()
                    val basePair = userAgents[currentUaIndex]
                    wv.settings.userAgentString = basePair.second + " Rev/$randBuild"
                    showTempBanner("✨ Cookies, caché y sesión limpiadas (entrando como 1ª vez)")
                    wv.reload()
                }

                val uaSwitchBtn = makeNavBtn(userAgents[0].first, "#1E293B") {
                    currentUaIndex = (currentUaIndex + 1) % userAgents.size
                    val nextPair = userAgents[currentUaIndex]
                    uaBtnRef?.text = nextPair.first
                    wv.settings.userAgentString = nextPair.second
                    showTempBanner("🎭 Vista cambiada a " + nextPair.first)
                    wv.reload()
                }
                uaBtnRef = uaSwitchBtn

                val dlBtn = makeNavBtn("⬇ Bajar Video", "#6D28D9") {
                    val currentPageUrl = wv.url ?: normalizeInputUrl(urlInput.text?.toString() ?: "")
                    val bestUrl = if (!detectedMediaUrl.isNullOrBlank()) detectedMediaUrl!! else currentPageUrl
                    closeBrowser("download", bestUrl)
                }
                downloadBtnRef = dlBtn

                toolsBar.addView(cleanFirstTimeBtn)
                toolsBar.addView(uaSwitchBtn)
                toolsBar.addView(dlBtn)

                val webParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
                )

                // Espaciador inferior seguro (>= 48dp) para no traslapar la barra de navegación de Android
                val bottomSafeSpacer = LinearLayout(act).apply {
                    setBackgroundColor(Color.parseColor("#0B0B14"))
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        116
                    )
                }

                root.addView(navBar)
                root.addView(toolsBar)
                root.addView(statusBanner)
                root.addView(wv, webParams)
                root.addView(bottomSafeSpacer)

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

    /**
     * Analizador nativo de Recorte Inteligente:
     * Detecta tramos totalmente negros/oscuros y tramos congelados sin movimiento.
     */
    @ReactMethod
    fun analyzeSmartTrimNative(
        sourcePath: String,
        detectBlack: Boolean,
        detectStatic: Boolean,
        sensitivity: Double,
        promise: Promise
    ) {
        executor.execute {
            val retriever = MediaMetadataRetriever()
            try {
                if (sourcePath.startsWith("content://")) {
                    retriever.setDataSource(reactContext, Uri.parse(sourcePath))
                } else {
                    retriever.setDataSource(cleanFilePath(sourcePath))
                }
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                if (durationMs <= 800L) {
                    val keepArr = Arguments.createArray().apply {
                        pushMap(Arguments.createMap().apply {
                            putDouble("startMs", 0.0)
                            putDouble("endMs", durationMs.toDouble())
                        })
                    }
                    val res = Arguments.createMap().apply {
                        putDouble("durationMs", durationMs.toDouble())
                        putDouble("optimizedDurationMs", durationMs.toDouble())
                        putDouble("savedDurationMs", 0.0)
                        putDouble("blackRemovedMs", 0.0)
                        putDouble("staticRemovedMs", 0.0)
                        putArray("keepSegments", keepArr)
                        putArray("removedSegments", Arguments.createArray())
                    }
                    promise.resolve(res)
                    return@execute
                }

                // Muestra ~48 puntos a lo largo del video para máxima precisión y rapidez (~1.2s total)
                val targetSamples = (durationMs / 450L).toInt().coerceIn(20, 60)
                val stepMs = (durationMs.toDouble() / targetSamples.toDouble()).coerceAtLeast(250.0)
                val sens = sensitivity.coerceIn(0.5, 2.0)
                val blackLumaLimit = (19.0 * sens).coerceIn(10.0, 34.0)
                val motionDiffLimit = (3.0 * sens).coerceIn(1.4, 6.5)
                val movingRatioLimit = (0.020 * sens).coerceIn(0.008, 0.055)

                val sampleW = 48
                val sampleH = 27
                val totalPixels = sampleW * sampleH
                val pixels = IntArray(totalPixels)
                var prevLuma: IntArray? = null

                val labels = Array(targetSamples) { "keep" }

                for (i in 0 until targetSamples) {
                    val centerMs = ((i + 0.5) * stepMs).toLong().coerceIn(0L, durationMs)
                    val timeUs = centerMs * 1000L

                    val rawBmp: Bitmap? = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
                        retriever.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST, sampleW, sampleH)
                            ?: retriever.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, sampleW, sampleH)
                    } else {
                        retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
                            ?: retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    }

                    if (rawBmp != null) {
                        val scaledBmp = if (rawBmp.width == sampleW && rawBmp.height == sampleH) {
                            rawBmp
                        } else {
                            val s = Bitmap.createScaledBitmap(rawBmp, sampleW, sampleH, false)
                            if (s != rawBmp) rawBmp.recycle()
                            s
                        }

                        scaledBmp.getPixels(pixels, 0, sampleW, 0, 0, sampleW, sampleH)
                        scaledBmp.recycle()

                        val currLuma = IntArray(totalPixels)
                        var sumLuma = 0L
                        var brightCount = 0
                        for (p in 0 until totalPixels) {
                            val c = pixels[p]
                            val r = (c shr 16) and 0xFF
                            val g = (c shr 8) and 0xFF
                            val b = c and 0xFF
                            val y = (r * 77 + g * 150 + b * 29) shr 8
                            currLuma[p] = y
                            sumLuma += y
                            if (y > 34) brightCount++
                        }

                        val avgLuma = sumLuma.toDouble() / totalPixels.toDouble()
                        val brightRatio = brightCount.toDouble() / totalPixels.toDouble()
                        val isBlack = detectBlack && (avgLuma <= blackLumaLimit && brightRatio <= 0.035)

                        var isStatic = false
                        val prev = prevLuma
                        if (!isBlack && detectStatic && prev != null) {
                            var diffSum = 0L
                            var movingCount = 0
                            for (p in 0 until totalPixels) {
                                val d = kotlin.math.abs(currLuma[p] - prev[p])
                                diffSum += d
                                if (d > 13) movingCount++
                            }
                            val avgDiff = diffSum.toDouble() / totalPixels.toDouble()
                            val movingRatio = movingCount.toDouble() / totalPixels.toDouble()
                            if (avgDiff <= motionDiffLimit && movingRatio <= movingRatioLimit) {
                                isStatic = true
                            }
                        }

                        labels[i] = when {
                            isBlack -> "black"
                            isStatic -> "static"
                            else -> "keep"
                        }
                        prevLuma = currLuma
                    }

                    if (i % 4 == 0 || i == targetSamples - 1) {
                        val pct = ((i + 1).toDouble() / targetSamples.toDouble()).coerceIn(0.05, 0.95)
                        emitProgress(pct, "Analizando cuadros negros y sin movimiento...")
                    }
                }

                // Suavizar pausas aisladas: si un único cuadro es "static" rodeado de "keep" y dura menos de 700ms, mantenerlo
                if (stepMs < 700.0 && targetSamples >= 3) {
                    for (i in 1 until targetSamples - 1) {
                        if (labels[i] == "static" && labels[i - 1] == "keep" && labels[i + 1] == "keep") {
                            labels[i] = "keep"
                        }
                    }
                }

                data class RawBlock(var type: String, var startMs: Double, var endMs: Double)
                val blocks = mutableListOf<RawBlock>()
                for (i in 0 until targetSamples) {
                    val sMs = i * stepMs
                    val eMs = if (i == targetSamples - 1) durationMs.toDouble() else ((i + 1) * stepMs)
                    val t = labels[i]
                    if (blocks.isNotEmpty() && blocks.last().type == t) {
                        blocks.last().endMs = eMs
                    } else {
                        blocks.add(RawBlock(t, sMs, eMs))
                    }
                }

                // Convertir bloques muy cortos (< 350ms) de corte en "keep" para no hacer micro-cortes molestos
                for (b in blocks) {
                    if (b.type != "keep" && (b.endMs - b.startMs) < 350.0) {
                        b.type = "keep"
                    }
                }

                // Re-compactar bloques adyacentes del mismo tipo
                val mergedBlocks = mutableListOf<RawBlock>()
                for (b in blocks) {
                    if (mergedBlocks.isNotEmpty() && mergedBlocks.last().type == b.type) {
                        mergedBlocks.last().endMs = b.endMs
                    } else {
                        mergedBlocks.add(b.copy())
                    }
                }

                val keepArr = Arguments.createArray()
                val removedArr = Arguments.createArray()
                var optimizedDurationMs = 0.0
                var blackRemovedMs = 0.0
                var staticRemovedMs = 0.0

                for (b in mergedBlocks) {
                    val len = (b.endMs - b.startMs).coerceAtLeast(0.0)
                    if (b.type == "keep") {
                        optimizedDurationMs += len
                        keepArr.pushMap(Arguments.createMap().apply {
                            putDouble("startMs", b.startMs)
                            putDouble("endMs", b.endMs)
                        })
                    } else {
                        if (b.type == "black") {
                            blackRemovedMs += len
                        } else {
                            staticRemovedMs += len
                        }
                        removedArr.pushMap(Arguments.createMap().apply {
                            putDouble("startMs", b.startMs)
                            putDouble("endMs", b.endMs)
                            putString("reason", b.type)
                        })
                    }
                }

                // Si todo el video fue marcado como negro/estático, conservar al menos el video original completo pero reportar los tramos detectados
                val savedDurationMs = (durationMs.toDouble() - optimizedDurationMs).coerceAtLeast(0.0)
                emitProgress(1.0, "¡Análisis inteligente completado!")

                val res = Arguments.createMap().apply {
                    putDouble("durationMs", durationMs.toDouble())
                    putDouble("optimizedDurationMs", optimizedDurationMs)
                    putDouble("savedDurationMs", savedDurationMs)
                    putDouble("blackRemovedMs", blackRemovedMs)
                    putDouble("staticRemovedMs", staticRemovedMs)
                    putArray("keepSegments", keepArr)
                    putArray("removedSegments", removedArr)
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("SMART_TRIM_ERROR", e.message ?: "Error al analizar el video", e)
            } finally {
                try {
                    retriever.release()
                } catch (_: Exception) {}
            }
        }
    }

    /**
     * Escáner ultrarrápido tipo Galería Samsung: obtiene todos los álbumes con conteo y portada en 1 sola consulta SQL nativa (~10ms)
     */
    @ReactMethod
    fun getAlbumsFastNative(promise: Promise) {
        executor.execute {
            try {
                val queryUri = android.provider.MediaStore.Files.getContentUri("external")
                val projection = arrayOf(
                    android.provider.MediaStore.Files.FileColumns.BUCKET_ID,
                    android.provider.MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME,
                    android.provider.MediaStore.Files.FileColumns.DATA,
                    android.provider.MediaStore.Files.FileColumns.DATE_MODIFIED,
                    android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE
                )
                val selection = android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "=? OR " + android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "=?"
                val selectionArgs = arrayOf(
                    android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(),
                    android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString()
                )
                val sortOrder = android.provider.MediaStore.Files.FileColumns.DATE_MODIFIED + " DESC"

                data class BucketAcc(
                    val id: String,
                    val title: String,
                    val dirPath: String,
                    val coverPath: String,
                    var count: Int
                )

                val buckets = LinkedHashMap<String, BucketAcc>()
                val seenMediaFiles = HashSet<String>()
                reactContext.contentResolver.query(
                    queryUri,
                    projection,
                    selection,
                    selectionArgs,
                    sortOrder
                )?.use { cursor ->
                    val bucketIdCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.BUCKET_ID)
                    val bucketNameCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME)
                    val dataCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.DATA)

                    while (cursor.moveToNext()) {
                        val filePath = if (dataCol >= 0) cursor.getString(dataCol) else null
                        if (filePath.isNullOrBlank()) continue
                        if (!seenMediaFiles.add(filePath.lowercase())) continue
                        val fileObj = File(filePath)
                        if (!fileObj.exists()) continue
                        val parentDir = fileObj.parentFile ?: continue
                        val dirKey = parentDir.absolutePath.trimEnd('/').lowercase()
                        val bucketId = (if (bucketIdCol >= 0) cursor.getString(bucketIdCol) else null)
                            ?: dirKey.hashCode().toString()
                        val existing = buckets[dirKey]
                        if (existing != null) {
                            existing.count += 1
                        } else {
                            val rawTitle = if (bucketNameCol >= 0) cursor.getString(bucketNameCol) else null
                            val title = if (!rawTitle.isNullOrBlank()) rawTitle else parentDir.name
                            buckets[dirKey] = BucketAcc(
                                id = bucketId,
                                title = title,
                                dirPath = parentDir.absolutePath,
                                coverPath = fileObj.absolutePath,
                                count = 1
                            )
                        }
                    }
                }

                // Migrar automáticamente grabaciones previas de DCIM/Grabaciones hacia Movies/2do plano
                val segundoPlanoDir = File("/storage/emulated/0/Movies/2do plano")
                try {
                    if (!segundoPlanoDir.exists()) segundoPlanoDir.mkdirs()
                    val oldGrabDir = File("/storage/emulated/0/DCIM/Grabaciones")
                    if (oldGrabDir.exists() && oldGrabDir.isDirectory) {
                        val oldFiles = oldGrabDir.listFiles() ?: emptyArray()
                        for (of in oldFiles) {
                            if (of.isFile) {
                                val targetF = File(segundoPlanoDir, of.name)
                                if (!targetF.exists()) {
                                    of.renameTo(targetF)
                                }
                            }
                        }
                    }
                } catch (_: Exception) {}

                val imgExtsPin = hashSetOf("jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "bmp", "avif")
                val vidExtsPin = hashSetOf("mp4", "mov", "m4v", "mkv", "webm", "3gp", "avi")
                fun isMediaName(n: String): Boolean {
                    val dot = n.lastIndexOf('.')
                    if (dot <= 0 || dot == n.length - 1) return false
                    val ext = n.substring(dot + 1).lowercase()
                    return imgExtsPin.contains(ext) || vidExtsPin.contains(ext)
                }

                fun scanDirCountAndCover(dirsToScan: List<File>, maxDepth: Int = 2): Pair<Int, String> {
                    var total = 0
                    var newestMod = -1L
                    var newestPath = ""
                    fun walk(d: File, depth: Int) {
                        if (!d.exists() || !d.isDirectory) return
                        val list = d.listFiles() ?: return
                        for (f in list) {
                            if (f.name.startsWith(".")) continue
                            if (f.isFile && isMediaName(f.name)) {
                                total += 1
                                val lm = f.lastModified()
                                if (lm >= newestMod) {
                                    newestMod = lm
                                    newestPath = f.absolutePath
                                }
                            } else if (f.isDirectory && depth < maxDepth) {
                                walk(f, depth + 1)
                            }
                        }
                    }
                    for (root in dirsToScan) {
                        walk(root, 0)
                    }
                    return Pair(total, newestPath)
                }

                // Fusionar subcarpetas virtuales "Fotos" y "Videos" en su carpeta padre igual que folderService
                val mergedByDir = LinkedHashMap<String, BucketAcc>()
                for ((_, b) in buckets) {
                    val dirFile = File(b.dirPath)
                    val folderNameLower = dirFile.name.lowercase()
                    val isVirtualSub = (folderNameLower == "fotos" || folderNameLower == "videos") && dirFile.parentFile != null
                    val targetDirFile = if (isVirtualSub) dirFile.parentFile!! else dirFile
                    val normKey = targetDirFile.absolutePath.lowercase()
                    val current = mergedByDir[normKey]
                    if (current == null) {
                        mergedByDir[normKey] = BucketAcc(
                            id = if (isVirtualSub) targetDirFile.absolutePath.hashCode().toString() else b.id,
                            title = targetDirFile.name,
                            dirPath = targetDirFile.absolutePath,
                            coverPath = b.coverPath,
                            count = b.count
                        )
                    } else {
                        current.count += b.count
                    }
                }

                // Asegurar que las carpetas fijadas de Archivos ("Bóveda Privada", "2do plano", "Descargas", "Telegram" raíz) siempre existan y sumen sus subcarpetas
                val bovedaPrivadaDir = File("/storage/emulated/0/Movies/Boveda Privada")
                try {
                    if (!bovedaPrivadaDir.exists()) bovedaPrivadaDir.mkdirs()
                    val nmBoveda = File(bovedaPrivadaDir, ".nomedia")
                    if (!nmBoveda.exists()) nmBoveda.createNewFile()
                } catch (_: Exception) {}
                val telegramRootDir = File("/storage/emulated/0/Telegram")
                try {
                    if (!telegramRootDir.exists()) telegramRootDir.mkdirs()
                } catch (_: Exception) {}
                val telegramAltDir = File("/storage/emulated/0/Android/media/org.telegram.messenger/Telegram")
                val downloadRootDir = File("/storage/emulated/0/Download")

                // Remover subcarpetas sueltas o duplicadas de Telegram, 2do plano, Bóveda Privada y Download de mergedByDir para consolidarlas en su carpeta raíz única
                val keysToRemove = mutableListOf<String>()
                for ((k, item) in mergedByDir) {
                    val tLow = item.title.trim().lowercase()
                    if (k.startsWith("/storage/emulated/0/telegram") ||
                        k.startsWith("/storage/emulated/0/android/media/org.telegram.messenger/telegram") ||
                        k.startsWith("/storage/emulated/0/pictures/telegram") ||
                        k.startsWith("/storage/emulated/0/movies/telegram") ||
                        tLow == "telegram" || tLow == "telegram images" || tLow == "telegram video" ||
                        k.endsWith("/2do plano") || k.endsWith("/grabaciones") ||
                        tLow == "2do plano" || tLow == "segundo plano" ||
                        k.endsWith("/boveda privada") || tLow == "boveda privada" || tLow == "bóveda privada" ||
                        k == "/storage/emulated/0/download" || tLow == "download" || tLow == "descargas"
                    ) {
                        keysToRemove.add(k)
                    }
                }
                for (k in keysToRemove) {
                    mergedByDir.remove(k)
                }

                val (bpCount, bpCover) = scanDirCountAndCover(listOf(bovedaPrivadaDir), 2)
                val bpKey = bovedaPrivadaDir.absolutePath.lowercase()
                mergedByDir[bpKey] = BucketAcc(
                    id = "pinned_boveda_privada",
                    title = "Bóveda Privada",
                    dirPath = bovedaPrivadaDir.absolutePath,
                    coverPath = bpCover,
                    count = bpCount
                )

                val appExtSegundoPlanoDir = reactContext.getExternalFilesDir("2do plano")
                val spDirsList = mutableListOf(
                    segundoPlanoDir,
                    File("/storage/emulated/0/2do plano"),
                    File("/storage/emulated/0/Pictures/2do plano"),
                    File("/storage/emulated/0/DCIM/2do plano"),
                    File("/storage/emulated/0/DCIM/Grabaciones")
                )
                if (appExtSegundoPlanoDir != null) {
                    spDirsList.add(appExtSegundoPlanoDir)
                }
                val (spCount, spCover) = scanDirCountAndCover(
                    spDirsList,
                    1
                )
                val spKey = segundoPlanoDir.absolutePath.lowercase()
                mergedByDir[spKey] = BucketAcc(
                    id = "pinned_2do_plano",
                    title = "2do plano",
                    dirPath = segundoPlanoDir.absolutePath,
                    coverPath = spCover,
                    count = spCount
                )

                val (dlCount, dlCover) = scanDirCountAndCover(listOf(downloadRootDir), 2)
                val dlKey = downloadRootDir.absolutePath.lowercase()
                val existingDl = mergedByDir[dlKey]
                mergedByDir[dlKey] = BucketAcc(
                    id = existingDl?.id ?: "pinned_download",
                    title = "Descargas",
                    dirPath = downloadRootDir.absolutePath,
                    coverPath = if (dlCover.isNotEmpty()) dlCover else (existingDl?.coverPath ?: ""),
                    count = maxOf(dlCount, existingDl?.count ?: 0)
                )

                val (tgCount, tgCover) = scanDirCountAndCover(
                    listOf(
                        telegramRootDir,
                        telegramAltDir,
                        File("/storage/emulated/0/Pictures/Telegram"),
                        File("/storage/emulated/0/Movies/Telegram")
                    ),
                    2
                )
                val tgKey = telegramRootDir.absolutePath.lowercase()
                mergedByDir[tgKey] = BucketAcc(
                    id = "pinned_telegram_root",
                    title = "Telegram",
                    dirPath = telegramRootDir.absolutePath,
                    coverPath = tgCover,
                    count = tgCount
                )

                val out = Arguments.createArray()
                for ((k, item) in mergedByDir) {
                    val pinnedOrder = when (k) {
                        bpKey -> 1
                        spKey -> 2
                        dlKey -> 3
                        tgKey -> 4
                        else -> 0
                    }
                    val map = Arguments.createMap().apply {
                        putString("id", item.id)
                        putString("title", item.title)
                        putInt("assetCount", item.count)
                        if (item.coverPath.isNotEmpty()) {
                            putString("coverUri", "file://" + item.coverPath)
                        } else {
                            putNull("coverUri")
                        }
                        putString("uri", "file://" + item.dirPath)
                        if (pinnedOrder > 0) {
                            putBoolean("isPinnedFilesFolder", true)
                            putInt("pinnedOrder", pinnedOrder)
                        }
                    }
                    out.pushMap(map)
                }
                promise.resolve(out)
            } catch (e: Exception) {
                promise.reject("ALBUMS_FAST_ERROR", e.message ?: "Error al listar álbumes rápido", e)
            }
        }
    }

    /**
     * Lector nativo ultrarrápido de carpetas (reemplaza 150+ llamadas JS bridge por 1 sola llamada en Kotlin de ~3ms)
     */
    @ReactMethod
    fun listDirectoryFastNative(dirPath: String, promise: Promise) {
        executor.execute {
            try {
                val clean = cleanFilePath(dirPath)
                val rootDir = File(clean)
                val isTelegramRoot = rootDir.absolutePath.equals("/storage/emulated/0/Telegram", ignoreCase = true)
                val isSegundoPlanoRoot =
                    rootDir.absolutePath.endsWith("/2do plano", ignoreCase = true) ||
                    rootDir.absolutePath.endsWith("/Grabaciones", ignoreCase = true)

                val imgExts = hashSetOf("jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "bmp", "avif")
                val vidExts = hashSetOf("mp4", "mov", "m4v", "mkv", "webm", "3gp", "avi")

                fun getMediaType(name: String): String? {
                    val dot = name.lastIndexOf('.')
                    if (dot <= 0 || dot == name.length - 1) return null
                    val ext = name.substring(dot + 1).lowercase()
                    if (imgExts.contains(ext)) return "photo"
                    if (vidExts.contains(ext)) return "video"
                    return null
                }

                data class FastAsset(
                    val file: File,
                    val mediaType: String,
                    val lastMod: Long,
                    val length: Long,
                    var durationSec: Double = 0.0
                )

                val rootPath = rootDir.absolutePath.trimEnd('/')
                val assetList = ArrayList<FastAsset>(128)
                val assetByPath = HashMap<String, FastAsset>()
                val seenAssetPaths = HashSet<String>()
                val subDirsMap = LinkedHashMap<String, File>()

                data class SubMediaStat(
                    var mediaCount: Int = 0,
                    var newestMod: Long = -1L,
                    var coverPath: String = ""
                )
                val mediaStoreSubStats = HashMap<String, SubMediaStat>()

                val children = if (rootDir.exists() && rootDir.isDirectory) (rootDir.listFiles() ?: emptyArray()) else emptyArray()
                for (child in children) {
                    val name = child.name
                    if (name.startsWith(".")) continue
                    if (child.isDirectory) {
                        val low = name.lowercase()
                        if (low == "fotos" || low == "videos" || (isTelegramRoot && low.startsWith("telegram "))) {
                            val subFiles = child.listFiles() ?: emptyArray()
                            for (sf in subFiles) {
                                if (sf.isFile && !sf.name.startsWith(".")) {
                                    val mt = getMediaType(sf.name)
                                    val key = sf.absolutePath.lowercase()
                                    if (mt != null && seenAssetPaths.add(key)) {
                                        val fa = FastAsset(sf, mt, sf.lastModified(), sf.length())
                                        assetList.add(fa)
                                        assetByPath[key] = fa
                                    }
                                }
                            }
                            if (isTelegramRoot) {
                                subDirsMap[child.absolutePath.lowercase()] = child
                            }
                        } else {
                            subDirsMap[child.absolutePath.lowercase()] = child
                        }
                    } else if (child.isFile) {
                        val mt = getMediaType(name)
                        val key = child.absolutePath.lowercase()
                        if (mt != null && seenAssetPaths.add(key)) {
                            val fa = FastAsset(child, mt, child.lastModified(), child.length())
                            assetList.add(fa)
                            assetByPath[key] = fa
                        }
                    }
                }

                // Complementar SIEMPRE con MediaStore.Files para que funcione al 100% en Android 11/12/13/14 incluso sin MANAGE_EXTERNAL_STORAGE
                try {
                    val queryUri = android.provider.MediaStore.Files.getContentUri("external")
                    val proj = arrayOf(
                        android.provider.MediaStore.Files.FileColumns.DATA,
                        android.provider.MediaStore.Files.FileColumns.DATE_MODIFIED,
                        android.provider.MediaStore.Files.FileColumns.SIZE,
                        android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE,
                        android.provider.MediaStore.Files.FileColumns.DURATION
                    )
                    val sel = "(" +
                        android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "=? OR " +
                        android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "=?" +
                        ") AND " + android.provider.MediaStore.Files.FileColumns.DATA + " LIKE ?"
                    val selArgs = arrayOf(
                        android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(),
                        android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString(),
                        "$rootPath/%"
                    )
                    val prefix = "$rootPath/"
                    reactContext.contentResolver.query(queryUri, proj, sel, selArgs, null)?.use { cursor ->
                        val dataCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.DATA)
                        val modCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.DATE_MODIFIED)
                        val sizeCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.SIZE)
                        val typeCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE)
                        val durCol = cursor.getColumnIndex(android.provider.MediaStore.Files.FileColumns.DURATION)

                        while (cursor.moveToNext()) {
                            val fPath = if (dataCol >= 0) cursor.getString(dataCol) else null
                            if (fPath.isNullOrBlank()) continue
                            if (!fPath.startsWith(prefix, ignoreCase = true)) continue
                            val rel = fPath.substring(prefix.length)
                            if (rel.isEmpty()) continue
                            val fObj = File(fPath)
                            if (!fObj.exists()) continue
                            val mTypeInt = if (typeCol >= 0) cursor.getInt(typeCol) else 0
                            val mt = if (mTypeInt == android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) {
                                "video"
                            } else {
                                getMediaType(fObj.name) ?: "photo"
                            }
                            val modSec = if (modCol >= 0) cursor.getLong(modCol) else 0L
                            val modMs = if (modSec > 0L) modSec * 1000L else fObj.lastModified()
                            val fSize = if (sizeCol >= 0) cursor.getLong(sizeCol) else fObj.length()
                            val durMs = if (durCol >= 0) cursor.getLong(durCol) else 0L
                            val durSec = if (durMs > 0L) durMs.toDouble() / 1000.0 else 0.0
                            val key = fObj.absolutePath.lowercase()

                            val slashIdx = rel.indexOf('/')
                            if (slashIdx < 0) {
                                if (seenAssetPaths.add(key)) {
                                    val fa = FastAsset(fObj, mt, modMs, fSize, durSec)
                                    assetList.add(fa)
                                    assetByPath[key] = fa
                                } else if (durSec > 0.0) {
                                    assetByPath[key]?.durationSec = durSec
                                }
                            } else {
                                val firstSeg = rel.substring(0, slashIdx)
                                val rest = rel.substring(slashIdx + 1)
                                val lowSeg = firstSeg.lowercase()
                                if ((lowSeg == "fotos" || lowSeg == "videos" || (isTelegramRoot && lowSeg.startsWith("telegram "))) && !rest.contains('/')) {
                                    if (seenAssetPaths.add(key)) {
                                        val fa = FastAsset(fObj, mt, modMs, fSize, durSec)
                                        assetList.add(fa)
                                        assetByPath[key] = fa
                                    } else if (durSec > 0.0) {
                                        assetByPath[key]?.durationSec = durSec
                                    }
                                }
                                if (!lowSeg.startsWith(".") && lowSeg != "fotos" && lowSeg != "videos") {
                                    val subDirFile = File(rootDir, firstSeg)
                                    val subKey = subDirFile.absolutePath.lowercase()
                                    if (!subDirsMap.containsKey(subKey)) {
                                        subDirsMap[subKey] = subDirFile
                                    }
                                    val st = mediaStoreSubStats.getOrPut(subKey) { SubMediaStat() }
                                    st.mediaCount += 1
                                    if (modMs >= st.newestMod) {
                                        st.newestMod = modMs
                                        st.coverPath = fObj.absolutePath
                                    }
                                }
                            }
                        }
                    }
                } catch (_: Exception) {}

                val subDirs = ArrayList<File>(subDirsMap.values)

                if (isSegundoPlanoRoot) {
                    val extraSpDirs = mutableListOf(
                        File("/storage/emulated/0/Movies/2do plano"),
                        File("/storage/emulated/0/2do plano"),
                        File("/storage/emulated/0/Pictures/2do plano"),
                        File("/storage/emulated/0/DCIM/2do plano"),
                        File("/storage/emulated/0/DCIM/Grabaciones")
                    )
                    val appExtSp = reactContext.getExternalFilesDir("2do plano")
                    if (appExtSp != null) {
                        extraSpDirs.add(appExtSp)
                    }
                    val seenSpNames = HashSet<String>()
                    val seenSpPaths = HashSet<String>()
                    for (a in assetList) {
                        seenSpPaths.add(a.file.absolutePath)
                        seenSpNames.add(a.file.name)
                    }
                    for (ed in extraSpDirs) {
                        if (!ed.exists() || !ed.isDirectory) continue
                        val eChildren = ed.listFiles() ?: continue
                        for (ec in eChildren) {
                            if (ec.name.startsWith(".")) continue
                            if (ec.isFile) {
                                val mt = getMediaType(ec.name)
                                if (mt != null && seenSpPaths.add(ec.absolutePath) && seenSpNames.add(ec.name)) {
                                    assetList.add(FastAsset(ec, mt, ec.lastModified(), ec.length()))
                                }
                            }
                        }
                    }
                }

                // Si es la carpeta raíz /storage/emulated/0/Telegram, también incluir archivos de /storage/emulated/0/Android/media/org.telegram.messenger/Telegram, Pictures/Telegram y Movies/Telegram
                if (isTelegramRoot) {
                    val extraTgDirs = listOf(
                        File("/storage/emulated/0/Android/media/org.telegram.messenger/Telegram"),
                        File("/storage/emulated/0/Pictures/Telegram"),
                        File("/storage/emulated/0/Movies/Telegram")
                    )
                    val seenPaths = HashSet<String>()
                    for (a in assetList) seenPaths.add(a.file.absolutePath)
                    for (ed in extraTgDirs) {
                        if (!ed.exists() || !ed.isDirectory) continue
                        val eChildren = ed.listFiles() ?: continue
                        for (ec in eChildren) {
                            if (ec.name.startsWith(".")) continue
                            if (ec.isFile) {
                                val mt = getMediaType(ec.name)
                                if (mt != null && seenPaths.add(ec.absolutePath)) {
                                    assetList.add(FastAsset(ec, mt, ec.lastModified(), ec.length()))
                                }
                            } else if (ec.isDirectory) {
                                val innerFiles = ec.listFiles() ?: emptyArray()
                                for (inf in innerFiles) {
                                    if (inf.isFile && !inf.name.startsWith(".")) {
                                        val mt = getMediaType(inf.name)
                                        if (mt != null && seenPaths.add(inf.absolutePath)) {
                                            assetList.add(FastAsset(inf, mt, inf.lastModified(), inf.length()))
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                assetList.sortByDescending { it.lastMod }

                // Completar duración para videos que no tenían duración en MediaStore (hasta 40 videos por carpeta)
                var retrievedDurCount = 0
                for (a in assetList) {
                    if (a.mediaType == "video" && a.durationSec <= 0.0 && retrievedDurCount < 40) {
                        retrievedDurCount += 1
                        val retr = MediaMetadataRetriever()
                        try {
                            retr.setDataSource(a.file.absolutePath)
                            val dMs = retr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                            if (dMs > 0L) {
                                a.durationSec = dMs.toDouble() / 1000.0
                            }
                        } catch (_: Exception) {
                        } finally {
                            try { retr.release() } catch (_: Exception) {}
                        }
                    }
                }

                val assetsArr = Arguments.createArray()
                for (a in assetList) {
                    val uriStr = "file://" + a.file.absolutePath
                    val map = Arguments.createMap().apply {
                        putString("id", uriStr)
                        putString("uri", uriStr)
                        putString("filename", a.file.name)
                        putString("mediaType", a.mediaType)
                        putDouble("creationTime", a.lastMod.toDouble())
                        putDouble("modificationTime", a.lastMod.toDouble())
                        putDouble("fileSize", a.length.toDouble())
                        putDouble("duration", a.durationSec)
                    }
                    assetsArr.pushMap(map)
                }

                subDirs.sortBy { it.name.lowercase() }
                val subfoldersArr = Arguments.createArray()
                for (sd in subDirs) {
                    var mediaCount = 0
                    var subCount = 0
                    var newestMod = -1L
                    var coverFile: File? = null

                    val inner = sd.listFiles() ?: emptyArray()
                    for (entry in inner) {
                        val en = entry.name
                        if (en.startsWith(".")) continue
                        if (entry.isDirectory) {
                            val low = en.lowercase()
                            if (low == "fotos" || low == "videos") {
                                val vFiles = entry.listFiles() ?: emptyArray()
                                for (vf in vFiles) {
                                    if (vf.isFile && getMediaType(vf.name) != null) {
                                        mediaCount++
                                        val lm = vf.lastModified()
                                        if (lm >= newestMod) {
                                            newestMod = lm
                                            coverFile = vf
                                        }
                                    }
                                }
                            } else {
                                subCount++
                            }
                        } else if (entry.isFile && getMediaType(en) != null) {
                            mediaCount++
                            val lm = entry.lastModified()
                            if (lm >= newestMod) {
                                newestMod = lm
                                coverFile = entry
                            }
                        }
                    }

                    val msStat = mediaStoreSubStats[sd.absolutePath.lowercase()]
                    if (msStat != null) {
                        if (msStat.mediaCount > mediaCount) {
                            mediaCount = msStat.mediaCount
                        }
                        if (coverFile == null && msStat.coverPath.isNotEmpty()) {
                            coverFile = File(msStat.coverPath)
                        }
                    }

                    if (mediaCount > 0 || subCount > 0) {
                        val sdUri = "file://" + sd.absolutePath
                        val subMap = Arguments.createMap().apply {
                            putString("id", sdUri)
                            putString("name", sd.name)
                            putString("title", sd.name)
                            putString("uri", sdUri)
                            putInt("count", mediaCount)
                            putInt("assetCount", mediaCount)
                            putInt("subfolderCount", subCount)
                            if (coverFile != null) {
                                putString("coverUri", "file://" + coverFile!!.absolutePath)
                            } else {
                                putNull("coverUri")
                            }
                        }
                        subfoldersArr.pushMap(subMap)
                    }
                }

                val result = Arguments.createMap().apply {
                    putArray("assets", assetsArr)
                    putArray("subfolders", subfoldersArr)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("LIST_DIR_FAST_ERROR", e.message ?: "Error al listar carpeta rápido", e)
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

    /**
     * Mantiene despierta la CPU (PARTIAL_WAKE_LOCK) y muestra notificación en curso
     * para que la compresión continúe sin interrupción al minimizar la app o apagar la pantalla.
     */
    @ReactMethod
    fun setCompressionKeepAliveNative(
        active: Boolean,
        title: String,
        subtitle: String,
        percent: Int,
        promise: Promise
    ) {
        try {
            val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            val channelId = "galeria_compression_bg"
            val notifId = 4409

            if (active) {
                try {
                    if (compressionWakeLock == null) {
                        val pm = reactContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
                        compressionWakeLock = pm?.newWakeLock(
                            PowerManager.PARTIAL_WAKE_LOCK,
                            "GaleriaApp::CompressionKeepAlive"
                        )?.apply {
                            setReferenceCounted(false)
                        }
                    }
                    if (compressionWakeLock?.isHeld == false) {
                        compressionWakeLock?.acquire(60 * 60 * 1000L)
                    }
                } catch (_: Exception) {}

                try {
                    if (nm != null) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            val ch = NotificationChannel(
                                channelId,
                                "Compresión en segundo plano",
                                NotificationManager.IMPORTANCE_LOW
                            ).apply {
                                description = "Progreso de compresión de fotos y videos"
                                setShowBadge(false)
                            }
                            nm.createNotificationChannel(ch)
                        }
                        val launchIntent = reactContext.packageManager
                            .getLaunchIntentForPackage(reactContext.packageName)
                            ?.apply {
                                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                            }
                        val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        } else {
                            PendingIntent.FLAG_UPDATE_CURRENT
                        }
                        val contentPi = if (launchIntent != null) {
                            PendingIntent.getActivity(reactContext, 4409, launchIntent, piFlags)
                        } else null

                        val safePct = percent.coerceIn(0, 100)
                        val builder = NotificationCompat.Builder(reactContext, channelId)
                            .setSmallIcon(android.R.drawable.stat_sys_upload)
                            .setContentTitle(title.ifBlank { "Comprimiendo en 2do plano..." })
                            .setContentText(subtitle.ifBlank { "Optimizando al 100% de resolución..." })
                            .setOngoing(true)
                            .setOnlyAlertOnce(true)
                            .setPriority(NotificationCompat.PRIORITY_LOW)
                            .setProgress(100, safePct, safePct <= 0)
                        if (contentPi != null) {
                            builder.setContentIntent(contentPi)
                        }
                        nm.notify(notifId, builder.build())
                    }
                } catch (_: Exception) {}
            } else {
                try {
                    if (compressionWakeLock?.isHeld == true) {
                        compressionWakeLock?.release()
                    }
                } catch (_: Exception) {}
                try {
                    nm?.cancel(notifId)
                } catch (_: Exception) {}
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /**
     * Comprime una fotografía directamente en un hilo nativo de fondo (compressionExecutor)
     * manteniendo el 100% de su resolución original (width x height) y su orientación EXIF,
     * para que nunca se detenga aunque el usuario cambie de pantalla o minimice la aplicación.
     */
    @ReactMethod
    fun compressPhotoInPlaceNative(
        sourceUriOrPath: String,
        skipIfGreen: Boolean,
        promise: Promise
    ) {
        compressionExecutor.execute {
            try {
                val inPath = cleanFilePath(sourceUriOrPath)
                val inFile = File(inPath)
                if (!inFile.exists() || !inFile.isFile) {
                    promise.reject("FILE_NOT_FOUND", "Archivo físico no accesible directamente")
                    return@execute
                }

                val oldSize = inFile.length()
                val twoMbBytes = 2L * 1024L * 1024L
                val targetGreenBytes = (1.92 * 1024.0 * 1024.0).toLong()

                if (oldSize > 0L && (oldSize <= 150L * 1024L || (skipIfGreen && oldSize <= twoMbBytes))) {
                    val skippedMap = Arguments.createMap().apply {
                        putBoolean("success", true)
                        putBoolean("skippedGreen", true)
                        putBoolean("alreadyOptimized", true)
                        putDouble("oldSize", oldSize.toDouble())
                        putDouble("newSize", oldSize.toDouble())
                        putDouble("savedBytes", 0.0)
                    }
                    promise.resolve(skippedMap)
                    return@execute
                }

                val exifTagsToPreserve = arrayOf(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.TAG_DATETIME,
                    ExifInterface.TAG_DATETIME_ORIGINAL,
                    ExifInterface.TAG_DATETIME_DIGITIZED,
                    ExifInterface.TAG_MAKE,
                    ExifInterface.TAG_MODEL,
                    ExifInterface.TAG_GPS_LATITUDE,
                    ExifInterface.TAG_GPS_LATITUDE_REF,
                    ExifInterface.TAG_GPS_LONGITUDE,
                    ExifInterface.TAG_GPS_LONGITUDE_REF
                )
                val savedExif = mutableMapOf<String, String>()
                try {
                    val oldExif = ExifInterface(inFile.absolutePath)
                    for (tag in exifTagsToPreserve) {
                        val v = oldExif.getAttribute(tag)
                        if (!v.isNullOrEmpty()) {
                            savedExif[tag] = v
                        }
                    }
                } catch (_: Exception) {}

                val opts = BitmapFactory.Options().apply {
                    inScaled = false
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
                val bmp = BitmapFactory.decodeFile(inFile.absolutePath, opts)
                    ?: throw IllegalStateException("No se pudo decodificar la fotografía")

                val origW = bmp.width
                val origH = bmp.height

                val qualitySteps = when {
                    oldSize > 4L * 1024L * 1024L -> intArrayOf(70, 58, 48, 38, 30)
                    oldSize > twoMbBytes -> intArrayOf(74, 62, 50, 40, 30)
                    else -> intArrayOf(72, 58, 45, 34)
                }

                var bestBytes: ByteArray? = null
                var bestSize = Long.MAX_VALUE

                for (q in qualitySteps) {
                    val baos = ByteArrayOutputStream(512 * 1024)
                    bmp.compress(Bitmap.CompressFormat.JPEG, q, baos)
                    val candidateBytes = baos.toByteArray()
                    val candidateLen = candidateBytes.size.toLong()
                    if (candidateLen in 1 until bestSize) {
                        bestBytes = candidateBytes
                        bestSize = candidateLen
                    }
                    if (oldSize > 0L) {
                        val ratio = bestSize.toDouble() / oldSize.toDouble()
                        if (oldSize > twoMbBytes) {
                            if (bestSize <= targetGreenBytes && ratio <= 0.80) break
                        } else {
                            if (ratio <= 0.78) break
                        }
                    } else {
                        break
                    }
                }

                bmp.recycle()

                val chosenBytes = bestBytes
                if (chosenBytes == null || (oldSize > 0L && bestSize >= oldSize)) {
                    val alreadyMap = Arguments.createMap().apply {
                        putBoolean("success", true)
                        putBoolean("alreadyOptimized", true)
                        putDouble("oldSize", oldSize.toDouble())
                        putDouble("newSize", oldSize.toDouble())
                        putDouble("savedBytes", 0.0)
                        putInt("width", origW)
                        putInt("height", origH)
                    }
                    promise.resolve(alreadyMap)
                    return@execute
                }

                val tempFile = File(reactContext.cacheDir, "native_comp_" + System.nanoTime() + ".jpg")
                FileOutputStream(tempFile, false).use { fos ->
                    fos.write(chosenBytes)
                    fos.flush()
                }

                if (savedExif.isNotEmpty()) {
                    try {
                        val newExif = ExifInterface(tempFile.absolutePath)
                        for ((tag, value) in savedExif) {
                            newExif.setAttribute(tag, value)
                        }
                        newExif.saveAttributes()
                    } catch (_: Exception) {}
                }

                val finalTempLen = tempFile.length()
                if (oldSize > 0L && finalTempLen >= oldSize) {
                    tempFile.delete()
                    val alreadyMap = Arguments.createMap().apply {
                        putBoolean("success", true)
                        putBoolean("alreadyOptimized", true)
                        putDouble("oldSize", oldSize.toDouble())
                        putDouble("newSize", oldSize.toDouble())
                        putDouble("savedBytes", 0.0)
                        putInt("width", origW)
                        putInt("height", origH)
                    }
                    promise.resolve(alreadyMap)
                    return@execute
                }

                val prevLastMod = inFile.lastModified()
                FileInputStream(tempFile).use { fis ->
                    FileOutputStream(inFile, false).use { fos ->
                        fis.channel.transferTo(0, finalTempLen, fos.channel)
                        fos.channel.truncate(finalTempLen)
                        fos.fd.sync()
                    }
                }
                tempFile.delete()
                if (prevLastMod > 0L) {
                    try { inFile.setLastModified(prevLastMod) } catch (_: Exception) {}
                }

                val verifiedLen = inFile.length()
                val savedBytes = (oldSize - verifiedLen).coerceAtLeast(0L)
                try {
                    MediaScannerConnection.scanFile(reactContext, arrayOf(inFile.absolutePath), null, null)
                } catch (_: Exception) {}

                val resMap = Arguments.createMap().apply {
                    putBoolean("success", true)
                    putBoolean("overwritten", true)
                    putDouble("oldSize", oldSize.toDouble())
                    putDouble("newSize", verifiedLen.toDouble())
                    putDouble("savedBytes", savedBytes.toDouble())
                    putInt("width", origW)
                    putInt("height", origH)
                }
                promise.resolve(resMap)
            } catch (e: Exception) {
                promise.reject("NATIVE_PHOTO_COMP_ERR", e.message ?: "Error en compresión nativa", e)
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

const BACKGROUND_VIDEO_RECORD_SERVICE_KT = `package com.rembrant.galeriaapp

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaRecorder
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Base64
import android.util.Range
import android.util.Size
import android.view.Surface
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Motor nativo unificado de vista previa y grabación de video en 2do plano (Camera2 + ImageReader + MediaRecorder).
 *
 * Características:
 * - Captura fotogramas en vivo directamente desde el HAL de Camera2 mediante ImageReader (YUV_420_888)
 *   y los dibuja de forma directa en BgCameraPreviewView (ImageView nativo en GPU) además de emitirlos a JS,
 *   garantizando que la vista previa dentro del <Modal> nunca se vea negra ni parpadee.
 * - Soporta cambio en caliente entre Trasera, Frontal y lentes adicionales.
 * - Publica automáticamente cada video y foto en /storage/emulated/0/Movies/2do plano vía MediaStore
 *   y MediaScannerConnection para que aparezca de inmediato en la galería.
 */
class BackgroundVideoRecordService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val frameExecutor = Executors.newSingleThreadExecutor()

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var persistentRecorderSurface: Surface? = null
    private var previewImageReader: ImageReader? = null
    private var mediaRecorder: MediaRecorder? = null

    private var cameraId: String = "0"
    private var videoWidth: Int = 1920
    private var videoHeight: Int = 1080
    private var previewWidth: Int = 640
    private var previewHeight: Int = 360
    private var videoFps: Int = 30
    private var videoBitrate: Int = 10_000_000
    private var maxDurationSec: Int = 600
    private var useFrontCamera: Boolean = false
    private var enableTorch: Boolean = false
    private var showFloatingPreview: Boolean = true
    private var isPreviewOnly: Boolean = false
    private var outputFile: File? = null
    private var sessionStarted: Boolean = false
    private var lastFrameEmitTimeMs: Long = 0L
    private var lastJsBridgeEmitTimeMs: Long = 0L

    @Volatile
    private var isEncodingFrame: Boolean = false

    @Volatile
    private var lastCapturedJpegBytes: ByteArray? = null

    private val timerRunnable = object : Runnable {
        override fun run() {
            if (!isRunning) return
            if (!isPausedState) {
                elapsedSecondsState += 1
                if (maxDurationSec > 0 && elapsedSecondsState >= maxDurationSec) {
                    stopRecordingAndSelf()
                    return
                }
                if (elapsedSecondsState % 2 == 0) {
                    updateForegroundNotification()
                }
            }
            emitStatusToJs()
            mainHandler.postDelayed(this, 1000L)
        }
    }

    private val controlReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_PAUSE_RECORD -> pauseRecordingInternal()
                ACTION_RESUME_RECORD -> resumeRecordingInternal()
                ACTION_STOP -> stopRecordingAndSelf()
                ACTION_SET_PREVIEW -> {
                    val vis = intent.getBooleanExtra(EXTRA_SHOW_PREVIEW, false)
                    updateOverlayPreviewSize(vis)
                }
                ACTION_SET_TORCH -> {
                    val on = intent.getBooleanExtra(EXTRA_ENABLE_TORCH, false)
                    updateTorchMode(on)
                }
                ACTION_SWITCH_CAMERA -> {
                    val spec = intent.getStringExtra(EXTRA_CAMERA_SPEC) ?: "back"
                    switchCameraInternal(spec)
                }
                ACTION_TAKE_PHOTO -> {
                    takePhotoInternal()
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        activeServiceInstance = this
        val ht = HandlerThread("CameraThread").apply { start() }
        cameraThread = ht
        cameraHandler = Handler(ht.looper)

        val filter = IntentFilter().apply {
            addAction(ACTION_PAUSE_RECORD)
            addAction(ACTION_RESUME_RECORD)
            addAction(ACTION_STOP)
            addAction(ACTION_SET_PREVIEW)
            addAction(ACTION_SET_TORCH)
            addAction(ACTION_SWITCH_CAMERA)
            addAction(ACTION_TAKE_PHOTO)
        }
        try {
            ContextCompat.registerReceiver(
                this,
                controlReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
        } catch (_: Exception) {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(controlReceiver, filter)
        }
    }

    private val delayedIdleStopRunnable = Runnable {
        if (!isRunning && (!isServiceActive || !floatingPreviewState)) {
            stopRecordingAndSelf()
        }
    }

    private fun closePreviewCameraOnly() {
        if (isRunning) return
        floatingPreviewState = false
        showFloatingPreview = false
        sessionStarted = false
        mainHandler.removeCallbacks(delayedIdleStopRunnable)
        cameraHandler?.post {
            try { captureSession?.stopRepeating() } catch (_: Exception) {}
            try { captureSession?.close() } catch (_: Exception) {}
            captureSession = null
            try { cameraDevice?.close() } catch (_: Exception) {}
            cameraDevice = null
        }
        emitStatusToJs()
        mainHandler.postDelayed(delayedIdleStopRunnable, 1800L)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        mainHandler.removeCallbacks(delayedIdleStopRunnable)
        when (intent?.action) {
            ACTION_STOP -> {
                stopRecordingAndSelf()
                return START_NOT_STICKY
            }
            ACTION_STOP_PREVIEW -> {
                if (!isRunning) {
                    closePreviewCameraOnly()
                }
                return START_STICKY
            }
            ACTION_PAUSE_RECORD -> {
                pauseRecordingInternal()
                return START_STICKY
            }
            ACTION_RESUME_RECORD -> {
                resumeRecordingInternal()
                return START_STICKY
            }
            ACTION_SET_PREVIEW -> {
                val vis = intent.getBooleanExtra(EXTRA_SHOW_PREVIEW, false)
                updateOverlayPreviewSize(vis)
                return START_STICKY
            }
            ACTION_SET_TORCH -> {
                val on = intent.getBooleanExtra(EXTRA_ENABLE_TORCH, false)
                updateTorchMode(on)
                return START_STICKY
            }
            ACTION_SWITCH_CAMERA -> {
                val spec = intent.getStringExtra(EXTRA_CAMERA_SPEC) ?: "back"
                switchCameraInternal(spec)
                return START_STICKY
            }
            ACTION_TAKE_PHOTO -> {
                takePhotoInternal()
                return START_STICKY
            }
            ACTION_START_PREVIEW -> {
                if (isRunning && sessionStarted) {
                    updateOverlayPreviewSize(true)
                    return START_STICKY
                }
                val camSpec = intent.getStringExtra(EXTRA_CAMERA_SPEC) ?: "back"
                useFrontCamera = intent.getBooleanExtra(EXTRA_USE_FRONT_CAMERA, camSpec.lowercase() == "front")
                enableTorch = intent.getBooleanExtra(EXTRA_ENABLE_TORCH, false)
                showFloatingPreview = true

                val nextCamId = resolveCameraIdFromSpec(camSpec, useFrontCamera)
                if (isServiceActive && sessionStarted && isPreviewOnly && cameraDevice != null && captureSession != null) {
                    floatingPreviewState = true
                    showFloatingPreview = true
                    if (nextCamId != cameraId) {
                        switchCameraInternal(camSpec)
                    } else if (enableTorch != torchOnState) {
                        updateTorchMode(enableTorch)
                    } else {
                        emitStatusToJs()
                    }
                    return START_STICKY
                }

                cameraId = nextCamId
                useFrontCamera = isCameraIdFront(cameraId)
                useFrontState = useFrontCamera
                cameraSpecState = camSpec
                torchOnState = enableTorch
                floatingPreviewState = true
                elapsedSecondsState = 0
                isPausedState = false
                isPreviewOnly = true
                isRunning = false
                isServiceActive = true
                sessionStarted = false

                startForegroundWithNotification()
                chooseOptimalVideoSize(cameraId)
                chooseOptimalPreviewSize(cameraId)
                cameraHandler?.post {
                    try { captureSession?.stopRepeating() } catch (_: Exception) {}
                    try { captureSession?.close() } catch (_: Exception) {}
                    captureSession = null
                    try { cameraDevice?.close() } catch (_: Exception) {}
                    cameraDevice = null
                    ensurePreviewImageReader(forceRecreate = true)
                    startCameraAndRecorderSession(previewImageReader?.surface)
                }
                emitStatusToJs()
            }
            ACTION_START -> {
                if (isRunning && sessionStarted && !isPreviewOnly) {
                    return START_STICKY
                }
                val camSpec = intent.getStringExtra(EXTRA_CAMERA_SPEC) ?: "back"
                useFrontCamera = intent.getBooleanExtra(EXTRA_USE_FRONT_CAMERA, camSpec.lowercase() == "front")
                enableTorch = intent.getBooleanExtra(EXTRA_ENABLE_TORCH, false)
                showFloatingPreview = intent.getBooleanExtra(EXTRA_SHOW_PREVIEW, true)
                maxDurationSec = intent.getIntExtra(EXTRA_MAX_DURATION_SEC, 600)

                cameraId = resolveCameraIdFromSpec(camSpec, useFrontCamera)
                useFrontCamera = isCameraIdFront(cameraId)
                useFrontState = useFrontCamera
                cameraSpecState = camSpec
                torchOnState = enableTorch
                floatingPreviewState = showFloatingPreview
                elapsedSecondsState = 0
                isPausedState = false
                isPreviewOnly = false
                isRunning = true
                isServiceActive = true
                sessionStarted = false

                acquireWakeLock()
                startForegroundWithNotification()

                chooseOptimalVideoSize(cameraId)
                chooseOptimalPreviewSize(cameraId)
                outputFile = createTargetOutputFile("VID_2DO_", ".mp4")
                currentOutputPath = outputFile?.absolutePath

                cameraHandler?.post {
                    try { captureSession?.stopRepeating() } catch (_: Exception) {}
                    try { captureSession?.close() } catch (_: Exception) {}
                    captureSession = null
                    try { cameraDevice?.close() } catch (_: Exception) {}
                    cameraDevice = null
                    ensurePreviewImageReader(forceRecreate = true)
                    startCameraAndRecorderSession(previewImageReader?.surface)
                }
                emitStatusToJs()
            }
        }
        return START_STICKY
    }

    private fun ensurePreviewImageReader(forceRecreate: Boolean = false) {
        val current = previewImageReader
        if (!forceRecreate && current != null && current.width == previewWidth && current.height == previewHeight && current.surface.isValid) {
            return
        }
        try { current?.close() } catch (_: Exception) {}
        val reader = ImageReader.newInstance(previewWidth, previewHeight, ImageFormat.YUV_420_888, 3)
        reader.setOnImageAvailableListener({ r ->
            val image = try { r.acquireLatestImage() } catch (_: Exception) { null } ?: return@setOnImageAvailableListener
            val now = System.currentTimeMillis()
            if (!floatingPreviewState || !isServiceActive || isEncodingFrame || (now - lastFrameEmitTimeMs < 75L)) {
                try { image.close() } catch (_: Exception) {}
                return@setOnImageAvailableListener
            }
            val nv21: ByteArray
            val imgW = image.width
            val imgH = image.height
            try {
                nv21 = yuv420ToNv21(image)
            } catch (_: Exception) {
                try { image.close() } catch (_: Exception) {}
                return@setOnImageAvailableListener
            } finally {
                try { image.close() } catch (_: Exception) {}
            }

            lastFrameEmitTimeMs = now
            isEncodingFrame = true
            val rotDeg = computeOrientationHint()
            val mirrorFront = useFrontCamera

            frameExecutor.execute {
                try {
                    val yuvImg = YuvImage(nv21, ImageFormat.NV21, imgW, imgH, null)
                    val rawBaos = ByteArrayOutputStream(32768)
                    yuvImg.compressToJpeg(Rect(0, 0, imgW, imgH), 84, rawBaos)
                    val rawJpeg = rawBaos.toByteArray()

                    val decoded = BitmapFactory.decodeByteArray(rawJpeg, 0, rawJpeg.size)
                    if (decoded != null) {
                        val finalBmp = if (rotDeg != 0 || mirrorFront) {
                            val matrix = Matrix().apply {
                                if (rotDeg != 0) {
                                    postRotate(rotDeg.toFloat())
                                }
                                if (mirrorFront) {
                                    postScale(-1f, 1f)
                                }
                            }
                            val rotated = Bitmap.createBitmap(
                                decoded,
                                0,
                                0,
                                decoded.width,
                                decoded.height,
                                matrix,
                                true
                            )
                            if (rotated != decoded) {
                                decoded.recycle()
                            }
                            rotated
                        } else {
                            decoded
                        }

                        // Actualizar vista nativa BgCameraPreviewView en GPU sin reciclado prematuro ni parpadeo
                        dispatchPreviewBitmap(finalBmp)

                        val outJpeg = if (rotDeg != 0 || mirrorFront) {
                            val rotBaos = ByteArrayOutputStream(32768)
                            finalBmp.compress(Bitmap.CompressFormat.JPEG, 78, rotBaos)
                            rotBaos.toByteArray()
                        } else {
                            rawJpeg
                        }

                        if (outJpeg.isNotEmpty()) {
                            lastCapturedJpegBytes = outJpeg
                            val emitNow = System.currentTimeMillis()
                            if (emitNow - lastJsBridgeEmitTimeMs >= 160L) {
                                lastJsBridgeEmitTimeMs = emitNow
                                val b64 = Base64.encodeToString(outJpeg, Base64.NO_WRAP)
                                val map = Arguments.createMap().apply {
                                    putString("frame", "data:image/jpeg;base64," + b64)
                                }
                                VideoEngineModule.emitBgRecordEvent("BackgroundRecordingPreviewFrame", map)
                            }
                        }
                    }
                } catch (_: Exception) {
                } finally {
                    isEncodingFrame = false
                }
            }
        }, cameraHandler)
        previewImageReader = reader
    }

    private fun yuv420ToNv21(image: Image): ByteArray {
        val width = image.width
        val height = image.height
        val ySize = width * height
        val uvSize = width * height / 2
        val nv21 = ByteArray(ySize + uvSize)

        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]

        val yBuffer = yPlane.buffer
        val uBuffer = uPlane.buffer
        val vBuffer = vPlane.buffer
        yBuffer.rewind()
        uBuffer.rewind()
        vBuffer.rewind()

        val yRowStride = yPlane.rowStride
        val yPixelStride = yPlane.pixelStride
        val yLimit = yBuffer.limit()

        var pos = 0
        if (yRowStride == width && yPixelStride == 1 && yLimit >= ySize) {
            yBuffer.get(nv21, 0, ySize)
            pos = ySize
        } else {
            for (row in 0 until height) {
                val rowStart = row * yRowStride
                for (col in 0 until width) {
                    val yIdx = rowStart + col * yPixelStride
                    nv21[pos++] = if (yIdx < yLimit) yBuffer.get(yIdx) else 0
                }
            }
        }

        val uRowStride = uPlane.rowStride
        val vRowStride = vPlane.rowStride
        val uPixelStride = uPlane.pixelStride
        val vPixelStride = vPlane.pixelStride
        val uLimit = uBuffer.limit()
        val vLimit = vBuffer.limit()
        val uvHeight = height / 2
        val uvWidth = width / 2

        for (row in 0 until uvHeight) {
            val uRowStart = row * uRowStride
            val vRowStart = row * vRowStride
            for (col in 0 until uvWidth) {
                val uIdx = uRowStart + col * uPixelStride
                val vIdx = vRowStart + col * vPixelStride
                nv21[pos++] = if (vIdx < vLimit) vBuffer.get(vIdx) else 128.toByte()
                nv21[pos++] = if (uIdx < uLimit) uBuffer.get(uIdx) else 128.toByte()
            }
        }
        return nv21
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (wakeLock == null && pm != null) {
                wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "GaleriaRemb:BgVideoRecordWakeLock"
                ).apply {
                    setReferenceCounted(false)
                    acquire((maxDurationSec + 60) * 1000L)
                }
            }
        } catch (_: Exception) {}
    }

    private fun startForegroundWithNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Grabación de Video en 2do Plano",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                setSound(null, null)
                enableVibration(false)
            }
            nm.createNotificationChannel(channel)
        }

        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val fgsType = if (isPreviewOnly) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                } else {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                }
                startForeground(NOTIFICATION_ID, notification, fgsType)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Exception) {
            try {
                startForeground(NOTIFICATION_ID, notification)
            } catch (_: Exception) {}
        }
    }

    private fun updateForegroundNotification() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFICATION_ID, buildNotification())
        } catch (_: Exception) {}
    }

    private fun formatTime(sec: Int): String {
        val m = sec / 60
        val s = sec % 60
        val mm = if (m < 10) "0" + m else "" + m
        val ss = if (s < 10) "0" + s else "" + s
        return mm + ":" + ss
    }

    private fun buildNotification(): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        } ?: Intent()
        val openPending = PendingIntent.getActivity(
            this,
            100,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, BackgroundVideoRecordService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            101,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val togglePauseIntent = Intent(this, BackgroundVideoRecordService::class.java).apply {
            action = if (isPausedState) ACTION_RESUME_RECORD else ACTION_PAUSE_RECORD
        }
        val togglePausePending = PendingIntent.getService(
            this,
            102,
            togglePauseIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val statusTitle = if (isPreviewOnly) {
            "Vista previa de cámara activa"
        } else if (isPausedState) {
            "Grabación en pausa (" + formatTime(elapsedSecondsState) + ")"
        } else {
            "Grabando en 2do plano (" + formatTime(elapsedSecondsState) + ")"
        }

        val builder = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle(statusTitle)
            .setContentText(
                if (isPreviewOnly) {
                    "Mi Galería · Lista para grabar en 2do plano"
                } else {
                    "Mi Galería · Guardando en Archivos › 2do plano"
                }
            )
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openPending)

        if (!isPreviewOnly) {
            builder.addAction(
                if (isPausedState) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause,
                if (isPausedState) "Reanudar" else "Pausar",
                togglePausePending
            )
            builder.addAction(
                android.R.drawable.ic_delete,
                "Detener y Guardar",
                stopPending
            )
        }
        return builder.build()
    }

    private fun updateOverlayPreviewSize(visible: Boolean) {
        showFloatingPreview = visible
        floatingPreviewState = visible
        if (visible && isServiceActive && isPreviewOnly && cameraDevice == null) {
            sessionStarted = false
            cameraHandler?.post {
                ensurePreviewImageReader(forceRecreate = true)
                startCameraAndRecorderSession(previewImageReader?.surface)
            }
        }
        mainHandler.post {
            emitStatusToJs()
        }
    }

    private fun takePhotoInternal() {
        frameExecutor.execute {
            try {
                val jpegBytes = lastCapturedJpegBytes
                if (jpegBytes == null || jpegBytes.isEmpty()) {
                    emitErrorToJs("Activa primero la vista previa de la cámara para capturar foto.")
                    return@execute
                }
                val photoFile = createTargetOutputFile("IMG_2DO_", ".jpg")
                FileOutputStream(photoFile).use { fos ->
                    fos.write(jpegBytes)
                    fos.flush()
                }
                finalizeAndPublishSavedMedia(
                    rawFile = photoFile,
                    mimeType = "image/jpeg",
                    isVideo = false,
                    durationSec = 0
                )
            } catch (e: Exception) {
                emitErrorToJs(e.message ?: "Error al guardar foto")
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun switchCameraInternal(newSpec: String) {
        if (!isServiceActive) return
        cameraHandler?.post {
            try {
                val nextCamId = resolveCameraIdFromSpec(newSpec, newSpec.lowercase() == "front")
                if (nextCamId == cameraId && cameraDevice != null) {
                    mainHandler.post { emitStatusToJs() }
                    return@post
                }
                cameraId = nextCamId
                useFrontCamera = isCameraIdFront(nextCamId)
                useFrontState = useFrontCamera
                cameraSpecState = newSpec
                if (useFrontCamera) {
                    enableTorch = false
                    torchOnState = false
                }

                try { captureSession?.stopRepeating() } catch (_: Exception) {}
                try { captureSession?.close() } catch (_: Exception) {}
                captureSession = null

                try { cameraDevice?.close() } catch (_: Exception) {}
                cameraDevice = null

                ensurePreviewImageReader()
                val recSurf = if (isPreviewOnly) null else persistentRecorderSurface
                val prevSurf = previewImageReader?.surface
                val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
                cm.openCamera(
                    cameraId,
                    object : CameraDevice.StateCallback() {
                        override fun onOpened(device: CameraDevice) {
                            cameraDevice = device
                            try {
                                val outputs = mutableListOf<Surface>()
                                if (prevSurf != null && prevSurf.isValid) {
                                    outputs.add(prevSurf)
                                }
                                if (recSurf != null && recSurf.isValid) {
                                    outputs.add(recSurf)
                                }
                                if (outputs.isEmpty()) return
                                device.createCaptureSession(
                                    outputs,
                                    object : CameraCaptureSession.StateCallback() {
                                        override fun onConfigured(session: CameraCaptureSession) {
                                            captureSession = session
                                            try {
                                                val req = buildRecordCaptureRequest(device, prevSurf, recSurf)
                                                session.setRepeatingRequest(req, null, cameraHandler)
                                                mainHandler.post { emitStatusToJs() }
                                            } catch (_: Exception) {}
                                        }
                                        override fun onConfigureFailed(session: CameraCaptureSession) {}
                                    },
                                    cameraHandler
                                )
                            } catch (_: Exception) {}
                        }
                        override fun onDisconnected(device: CameraDevice) {
                            try { device.close() } catch (_: Exception) {}
                        }
                        override fun onError(device: CameraDevice, error: Int) {
                            try { device.close() } catch (_: Exception) {}
                        }
                    },
                    cameraHandler
                )
            } catch (_: Exception) {}
        }
    }

    private fun updateTorchMode(enabled: Boolean) {
        if (useFrontCamera) return
        enableTorch = enabled
        torchOnState = enabled
        cameraHandler?.post {
            try {
                val dev = cameraDevice ?: return@post
                val sess = captureSession ?: return@post
                val recSurf = if (isPreviewOnly) null else persistentRecorderSurface
                val req = buildRecordCaptureRequest(dev, previewImageReader?.surface, recSurf)
                sess.setRepeatingRequest(req, null, cameraHandler)
            } catch (_: Exception) {}
            mainHandler.post { emitStatusToJs() }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startCameraAndRecorderSession(previewSurface: Surface?, attempt: Int = 0) {
        if (sessionStarted && attempt == 0) return
        sessionStarted = true

        try {
            val persistentSurface = if (isPreviewOnly) {
                null
            } else {
                persistentRecorderSurface ?: createInitializedPersistentSurface().also {
                    persistentRecorderSurface = it
                }
            }

            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            cm.openCamera(
                cameraId,
                object : CameraDevice.StateCallback() {
                    override fun onOpened(device: CameraDevice) {
                        cameraDevice = device
                        createCaptureSessionAndStart(device, previewSurface ?: previewImageReader?.surface, persistentSurface)
                    }

                    override fun onDisconnected(device: CameraDevice) {
                        try { device.close() } catch (_: Exception) {}
                        cameraDevice = null
                        if (attempt < 6 && isServiceActive) {
                            cameraHandler?.postDelayed({
                                startCameraAndRecorderSession(previewSurface ?: previewImageReader?.surface, attempt + 1)
                            }, 280L)
                        } else {
                            mainHandler.post { stopRecordingAndSelf() }
                        }
                    }

                    override fun onError(device: CameraDevice, error: Int) {
                        try { device.close() } catch (_: Exception) {}
                        cameraDevice = null
                        if (attempt < 6 && isServiceActive) {
                            cameraHandler?.postDelayed({
                                startCameraAndRecorderSession(previewSurface ?: previewImageReader?.surface, attempt + 1)
                            }, 280L)
                        } else {
                            emitErrorToJs("No se pudo abrir la cámara (código " + error + ").")
                            mainHandler.post { stopRecordingAndSelf() }
                        }
                    }
                },
                cameraHandler
            )
        } catch (e: Exception) {
            if (attempt < 6 && isServiceActive) {
                cameraHandler?.postDelayed({
                    startCameraAndRecorderSession(previewSurface ?: previewImageReader?.surface, attempt + 1)
                }, 280L)
            } else {
                emitErrorToJs(e.message ?: "Error al iniciar la sesión de cámara")
                mainHandler.post { stopRecordingAndSelf() }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun createCaptureSessionAndStart(
        device: CameraDevice,
        previewSurface: Surface?,
        recordSurface: Surface?
    ) {
        try {
            val outputs = mutableListOf<Surface>()
            val activePreview = if (previewSurface != null && previewSurface.isValid) {
                previewSurface
            } else if (previewImageReader?.surface != null && previewImageReader!!.surface.isValid) {
                previewImageReader!!.surface
            } else {
                null
            }
            if (activePreview != null) {
                outputs.add(activePreview)
            }
            if (!isPreviewOnly && recordSurface != null && recordSurface.isValid) {
                outputs.add(recordSurface)
            }

            if (outputs.isEmpty()) {
                sessionStarted = false
                return
            }

            if (!isPreviewOnly && recordSurface != null) {
                try {
                    mediaRecorder?.apply {
                        setOnErrorListener(null)
                        setOnInfoListener(null)
                        reset()
                        release()
                    }
                } catch (_: Exception) {}
                val recorder = buildConfiguredMediaRecorder(recordSurface).apply {
                    setOrientationHint(computeOrientationHint())
                    prepare()
                }
                mediaRecorder = recorder
            }

            device.createCaptureSession(
                outputs,
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        captureSession = session
                        try {
                            val req = buildRecordCaptureRequest(
                                device,
                                activePreview,
                                if (isPreviewOnly) null else recordSurface
                            )
                            session.setRepeatingRequest(req, null, cameraHandler)
                            if (!isPreviewOnly) {
                                mediaRecorder?.start()
                                mainHandler.post {
                                    mainHandler.removeCallbacks(timerRunnable)
                                    mainHandler.postDelayed(timerRunnable, 1000L)
                                    emitStatusToJs()
                                }
                            } else {
                                mainHandler.post {
                                    emitStatusToJs()
                                }
                            }
                        } catch (startErr: Exception) {
                            emitErrorToJs(startErr.message ?: "Error al iniciar MediaRecorder")
                            mainHandler.post { stopRecordingAndSelf() }
                        }
                    }

                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        emitErrorToJs("Falló la configuración de CameraCaptureSession")
                        mainHandler.post { stopRecordingAndSelf() }
                    }
                },
                cameraHandler
            )
        } catch (e: Exception) {
            emitErrorToJs(e.message ?: "Error creando sesión de captura")
            mainHandler.post { stopRecordingAndSelf() }
        }
    }

    private fun createInitializedPersistentSurface(): Surface {
        val surface = MediaCodec.createPersistentInputSurface()
        val tempFile = File(cacheDir, "bvr_init_surface.mp4")
        val tempRecorder = buildConfiguredMediaRecorder(surface, tempFile)
        try {
            tempRecorder.prepare()
        } finally {
            try { tempRecorder.release() } catch (_: Exception) {}
            try { tempFile.delete() } catch (_: Exception) {}
        }
        return surface
    }

    private fun buildConfiguredMediaRecorder(
        inputSurface: Surface,
        overrideFile: File? = null
    ): MediaRecorder {
        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(this)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        val target = overrideFile ?: outputFile ?: createTargetOutputFile("VID_2DO_", ".mp4").also { outputFile = it }

        val hasMicPermission = ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.RECORD_AUDIO
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED

        if (hasMicPermission) {
            try {
                recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            } catch (_: Exception) {}
        }
        recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE)
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        recorder.setOutputFile(target.absolutePath)
        recorder.setVideoEncodingBitRate(videoBitrate)
        recorder.setVideoFrameRate(videoFps)
        recorder.setVideoSize(videoWidth, videoHeight)
        recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
        if (hasMicPermission) {
            try {
                recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                recorder.setAudioEncodingBitRate(128_000)
                recorder.setAudioSamplingRate(44_100)
            } catch (_: Exception) {}
        }
        recorder.setInputSurface(inputSurface)

        if (maxDurationSec > 0 && overrideFile == null) {
            recorder.setMaxDuration(maxDurationSec * 1000)
        }
        recorder.setOnInfoListener { _, what, _ ->
            if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED ||
                what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED
            ) {
                mainHandler.post { stopRecordingAndSelf() }
            }
        }
        return recorder
    }

    private fun chooseOptimalAeFpsRange(camId: String, isRecordingVideo: Boolean): Range<Int>? {
        return try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val chars = cm.getCameraCharacteristics(camId)
            val ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: return null
            if (ranges.isEmpty()) return null
            val rangesWith30 = ranges.filter { it.upper == 30 }
            if (rangesWith30.isNotEmpty()) {
                return rangesWith30.minByOrNull { it.lower }
            }
            val rangesAround30 = ranges.filter { it.upper in 24..30 }
            if (rangesAround30.isNotEmpty()) {
                return rangesAround30.maxByOrNull { it.upper - it.lower }
            }
            ranges.maxByOrNull { it.upper }
        } catch (_: Exception) {
            null
        }
    }

    private fun buildRecordCaptureRequest(
        device: CameraDevice,
        previewSurface: Surface?,
        recordSurface: Surface?
    ): CaptureRequest {
        val isRec = recordSurface != null && recordSurface.isValid
        val template = if (isRec) {
            CameraDevice.TEMPLATE_RECORD
        } else {
            CameraDevice.TEMPLATE_PREVIEW
        }
        return device.createCaptureRequest(template).apply {
            if (previewSurface != null && previewSurface.isValid) {
                addTarget(previewSurface)
            }
            if (isRec && recordSurface != null) {
                addTarget(recordSurface)
            }
            set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
            set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
            set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
            val bestFpsRange = chooseOptimalAeFpsRange(cameraId, isRec)
            if (bestFpsRange != null) {
                set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, bestFpsRange)
            }
            if (enableTorch && !useFrontCamera) {
                set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_TORCH)
            } else {
                set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF)
            }
        }.build()
    }

    private fun pauseRecordingInternal() {
        if (!isRunning || isPausedState) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                mediaRecorder?.pause()
                isPausedState = true
                updateForegroundNotification()
                emitStatusToJs()
            }
        } catch (_: Exception) {}
    }

    private fun resumeRecordingInternal() {
        if (!isRunning || !isPausedState) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                mediaRecorder?.resume()
                isPausedState = false
                updateForegroundNotification()
                emitStatusToJs()
            }
        } catch (_: Exception) {}
    }

    private fun stopRecordingAndSelf() {
        mainHandler.removeCallbacks(delayedIdleStopRunnable)
        mainHandler.removeCallbacks(timerRunnable)
        if (!isRunning) {
            isServiceActive = false
            isPreviewOnly = false
            sessionStarted = false
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Exception) {}
        stopSelf()
    }

    private fun finalizeAndPublishSavedMedia(
        rawFile: File,
        mimeType: String,
        isVideo: Boolean,
        durationSec: Int
    ) {
        var finalFile = rawFile
        val publicMoviesDir = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES),
            "2do plano"
        )
        try {
            if (!publicMoviesDir.exists()) {
                publicMoviesDir.mkdirs()
            }
        } catch (_: Exception) {}

        val expectedPublicFile = File(publicMoviesDir, rawFile.name)

        if (!rawFile.absolutePath.equals(expectedPublicFile.absolutePath, ignoreCase = true)) {
            var copiedToPublic = false
            try {
                if (publicMoviesDir.exists() && publicMoviesDir.canWrite()) {
                    FileInputStream(rawFile).use { fis ->
                        FileOutputStream(expectedPublicFile).use { fos ->
                            fis.copyTo(fos)
                            fos.flush()
                        }
                    }
                    if (expectedPublicFile.exists() && expectedPublicFile.length() > 512L) {
                        finalFile = expectedPublicFile
                        copiedToPublic = true
                    }
                }
            } catch (_: Exception) {}

            if (!copiedToPublic && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    val resolver = applicationContext.contentResolver
                    val collection = if (isVideo) {
                        MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    } else {
                        MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    }
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, rawFile.name)
                        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/2do plano")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val itemUri = resolver.insert(collection, values)
                    if (itemUri != null) {
                        resolver.openOutputStream(itemUri)?.use { outStream ->
                            FileInputStream(rawFile).use { inStream ->
                                inStream.copyTo(outStream)
                                outStream.flush()
                            }
                        }
                        val doneValues = ContentValues().apply {
                            put(MediaStore.MediaColumns.IS_PENDING, 0)
                        }
                        resolver.update(itemUri, doneValues, null, null)
                        if (expectedPublicFile.exists() && expectedPublicFile.length() > 512L) {
                            finalFile = expectedPublicFile
                        }
                    }
                } catch (_: Exception) {}
            }
        }

        val payload = Arguments.createMap().apply {
            putString("uri", "file://" + finalFile.absolutePath)
            putString("path", finalFile.absolutePath)
            putString("mediaType", if (isVideo) "video" else "photo")
            putInt("durationSec", durationSec)
            putDouble("sizeBytes", finalFile.length().toDouble())
        }
        VideoEngineModule.emitBgRecordEvent("BackgroundRecordingSaved", payload)

        try {
            val pathsToScan = if (finalFile.absolutePath != rawFile.absolutePath) {
                arrayOf(finalFile.absolutePath, rawFile.absolutePath)
            } else {
                arrayOf(finalFile.absolutePath)
            }
            MediaScannerConnection.scanFile(
                applicationContext,
                pathsToScan,
                Array(pathsToScan.size) { mimeType },
                null
            )
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        val wasRecordingVideo = isRunning && !isPreviewOnly
        val finalDuration = elapsedSecondsState
        val savedFile = outputFile

        if (activeServiceInstance === this) {
            activeServiceInstance = null
        }
        isRunning = false
        isServiceActive = false
        isPreviewOnly = false
        isPausedState = false
        sessionStarted = false
        mainHandler.removeCallbacks(delayedIdleStopRunnable)
        mainHandler.removeCallbacks(timerRunnable)

        try { unregisterReceiver(controlReceiver) } catch (_: Exception) {}

        try {
            captureSession?.stopRepeating()
        } catch (_: Exception) {}
        try {
            captureSession?.close()
        } catch (_: Exception) {}
        captureSession = null

        try {
            cameraDevice?.close()
        } catch (_: Exception) {}
        cameraDevice = null

        try {
            mediaRecorder?.apply {
                setOnErrorListener(null)
                setOnInfoListener(null)
                stop()
                reset()
                release()
            }
        } catch (_: Exception) {
            try { mediaRecorder?.release() } catch (_: Exception) {}
        }
        mediaRecorder = null

        try { persistentRecorderSurface?.release() } catch (_: Exception) {}
        persistentRecorderSurface = null

        try { previewImageReader?.close() } catch (_: Exception) {}
        previewImageReader = null

        try { cameraThread?.quitSafely() } catch (_: Exception) {}
        cameraThread = null
        cameraHandler = null

        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {}
        wakeLock = null

        emitStatusToJs()

        if (wasRecordingVideo && savedFile != null && savedFile.exists() && savedFile.length() > 512L) {
            frameExecutor.execute {
                finalizeAndPublishSavedMedia(
                    rawFile = savedFile,
                    mimeType = "video/mp4",
                    isVideo = true,
                    durationSec = finalDuration
                )
            }
        }

        super.onDestroy()
    }

    private fun isCameraIdFront(camId: String): Boolean {
        return try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val chars = cm.getCameraCharacteristics(camId)
            chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
        } catch (_: Exception) {
            camId == "1"
        }
    }

    private fun resolveCameraIdFromSpec(spec: String, fallbackFront: Boolean): String {
        return try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val clean = spec.trim()
            if (clean.startsWith("id:")) {
                val explicitId = clean.removePrefix("id:").trim()
                if (cm.cameraIdList.contains(explicitId)) {
                    return explicitId
                }
            }
            if (cm.cameraIdList.contains(clean)) {
                return clean
            }
            resolveCameraId(clean.lowercase() == "front" || fallbackFront)
        } catch (_: Exception) {
            resolveCameraId(fallbackFront)
        }
    }

    private fun resolveCameraId(useFront: Boolean): String {
        return try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val targetFacing = if (useFront) {
                CameraCharacteristics.LENS_FACING_FRONT
            } else {
                CameraCharacteristics.LENS_FACING_BACK
            }
            for (id in cm.cameraIdList) {
                val chars = cm.getCameraCharacteristics(id)
                if (chars.get(CameraCharacteristics.LENS_FACING) == targetFacing) {
                    return id
                }
            }
            cm.cameraIdList.firstOrNull() ?: "0"
        } catch (_: Exception) {
            if (useFront) "1" else "0"
        }
    }

    private fun chooseOptimalPreviewSize(camId: String) {
        try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val chars = cm.getCameraCharacteristics(camId)
            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return
            val sizes: Array<Size> = map.getOutputSizes(ImageFormat.YUV_420_888) ?: return
            val targetRatio = if (videoHeight > 0) videoWidth.toDouble() / videoHeight.toDouble() else (16.0 / 9.0)

            // Preferir relación 16:9 igual que el video (640x360, 800x450, 960x540, 1280x720) para compatibilidad total en Samsung Camera2
            val exact640x360 = sizes.firstOrNull { it.width == 640 && it.height == 360 }
            if (exact640x360 != null) {
                previewWidth = 640
                previewHeight = 360
                return
            }
            val matchingRatio = sizes
                .filter { it.width in 320..1280 && it.height in 180..720 && abs((it.width.toDouble() / it.height.toDouble()) - targetRatio) < 0.08 }
                .minByOrNull { abs(it.width - 640) }
            if (matchingRatio != null) {
                previewWidth = matchingRatio.width
                previewHeight = matchingRatio.height
                return
            }
            val exact640 = sizes.firstOrNull { it.width == 640 && it.height == 480 }
            if (exact640 != null) {
                previewWidth = 640
                previewHeight = 480
                return
            }
            val exact320 = sizes.firstOrNull { it.width == 320 && it.height == 240 }
            if (exact320 != null) {
                previewWidth = 320
                previewHeight = 240
                return
            }
            val candidate = sizes
                .filter { it.width in 240..960 && it.height in 180..720 }
                .minByOrNull { abs(it.width - 640) }
                ?: sizes.minByOrNull { it.width * it.height }
            if (candidate != null) {
                previewWidth = candidate.width
                previewHeight = candidate.height
            }
        } catch (_: Exception) {}
    }

    private fun chooseOptimalVideoSize(camId: String) {
        try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val chars = cm.getCameraCharacteristics(camId)
            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return
            val sizes: Array<Size> = map.getOutputSizes(MediaRecorder::class.java) ?: return
            val exact1080 = sizes.firstOrNull { it.width == 1920 && it.height == 1080 }
            if (exact1080 != null) {
                videoWidth = 1920
                videoHeight = 1080
                return
            }
            val exact720 = sizes.firstOrNull { it.width == 1280 && it.height == 720 }
            if (exact720 != null) {
                videoWidth = 1280
                videoHeight = 720
                return
            }
            val fallback = sizes
                .filter { it.width <= 1920 && it.height <= 1080 }
                .maxByOrNull { it.width * it.height }
                ?: sizes.firstOrNull()
            if (fallback != null) {
                videoWidth = fallback.width
                videoHeight = fallback.height
            }
        } catch (_: Exception) {}
    }

    private fun computeOrientationHint(): Int {
        return try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val chars = cm.getCameraCharacteristics(cameraId)
            val sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
            sensorOrientation
        } catch (_: Exception) {
            90
        }
    }

    private fun createTargetOutputFile(prefix: String, ext: String): File {
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val fileName = prefix + stamp + ext
        try {
            val moviesSegundoPlanoDir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES),
                "2do plano"
            )
            if (!moviesSegundoPlanoDir.exists()) {
                moviesSegundoPlanoDir.mkdirs()
            }
            if (moviesSegundoPlanoDir.exists() && moviesSegundoPlanoDir.canWrite()) {
                return File(moviesSegundoPlanoDir, fileName)
            }
        } catch (_: Exception) {}

        try {
            val rootSegundoPlanoDir = File("/storage/emulated/0/2do plano")
            if (!rootSegundoPlanoDir.exists()) {
                rootSegundoPlanoDir.mkdirs()
            }
            if (rootSegundoPlanoDir.exists() && rootSegundoPlanoDir.canWrite()) {
                return File(rootSegundoPlanoDir, fileName)
            }
        } catch (_: Exception) {}

        val fallbackDir = getExternalFilesDir("2do plano") ?: filesDir
        if (!fallbackDir.exists()) fallbackDir.mkdirs()
        return File(fallbackDir, fileName)
    }

    private fun emitStatusToJs() {
        val map = Arguments.createMap().apply {
            putBoolean("isRecording", isRunning)
            putBoolean("isPreviewOnly", isServiceActive && !isRunning)
            putBoolean("isPaused", isPausedState)
            putInt("elapsedSeconds", elapsedSecondsState)
            putString("facing", if (useFrontState) "front" else "back")
            putString("cameraSpec", cameraSpecState)
            putBoolean("torchOn", torchOnState)
            putBoolean("showFloatingPreview", floatingPreviewState)
            putString("outputPath", currentOutputPath ?: "")
        }
        VideoEngineModule.emitBgRecordEvent("BackgroundRecordingStatus", map)
    }

    private fun emitErrorToJs(message: String) {
        val map = Arguments.createMap().apply {
            putString("message", message)
        }
        VideoEngineModule.emitBgRecordEvent("BackgroundRecordingError", map)
    }

    companion object {
        private const val NOTIFICATION_CHANNEL_ID = "NOTIFICATION_RECORD"
        private const val NOTIFICATION_ID = 5000

        const val ACTION_START = "com.bravo.video.recorder.background.service.ACTION_START"
        const val ACTION_START_PREVIEW = "com.bravo.video.recorder.background.service.ACTION_START_PREVIEW"
        const val ACTION_STOP_PREVIEW = "com.bravo.video.recorder.background.service.ACTION_STOP_PREVIEW"
        const val ACTION_STOP = "com.bravo.video.recorder.background.service.ACTION_STOP"
        const val ACTION_PAUSE_RECORD = "com.bravo.video.recorder.background.service.ACTION_PAUSE_RECORD"
        const val ACTION_RESUME_RECORD = "com.bravo.video.recorder.background.service.ACTION_RESUME_RECORD"
        const val ACTION_SET_PREVIEW = "com.bravo.video.recorder.background.service.ACTION_SET_PREVIEW"
        const val ACTION_SET_TORCH = "com.bravo.video.recorder.background.service.ACTION_SET_TORCH"
        const val ACTION_SWITCH_CAMERA = "com.bravo.video.recorder.background.service.ACTION_SWITCH_CAMERA"
        const val ACTION_TAKE_PHOTO = "com.bravo.video.recorder.background.service.ACTION_TAKE_PHOTO"

        const val EXTRA_USE_FRONT_CAMERA = "EXTRA_USE_FRONT_CAMERA"
        const val EXTRA_CAMERA_SPEC = "EXTRA_CAMERA_SPEC"
        const val EXTRA_ENABLE_TORCH = "EXTRA_ENABLE_TORCH"
        const val EXTRA_SHOW_PREVIEW = "EXTRA_SHOW_PREVIEW"
        const val EXTRA_MAX_DURATION_SEC = "EXTRA_MAX_DURATION_SEC"

        @Volatile
        var activeServiceInstance: BackgroundVideoRecordService? = null

        private val previewViews = CopyOnWriteArraySet<android.widget.ImageView>()
        private val uiHandler = Handler(Looper.getMainLooper())

        @Volatile
        var latestPreviewBitmap: Bitmap? = null

        fun registerPreviewView(view: android.widget.ImageView) {
            previewViews.add(view)
            val bmp = latestPreviewBitmap
            if (bmp != null && !bmp.isRecycled) {
                uiHandler.post {
                    try {
                        view.setImageBitmap(bmp)
                    } catch (_: Exception) {}
                }
            }
        }

        fun unregisterPreviewView(view: android.widget.ImageView) {
            previewViews.remove(view)
        }

        fun dispatchPreviewBitmap(bmp: Bitmap) {
            latestPreviewBitmap = bmp
            if (previewViews.isEmpty()) return
            uiHandler.post {
                for (iv in previewViews) {
                    try {
                        if (!bmp.isRecycled) {
                            iv.setImageBitmap(bmp)
                        }
                    } catch (_: Exception) {}
                }
            }
        }

        @Volatile
        var isRunning: Boolean = false

        @Volatile
        var isServiceActive: Boolean = false

        @Volatile
        var isPausedState: Boolean = false

        @Volatile
        var elapsedSecondsState: Int = 0

        @Volatile
        var useFrontState: Boolean = false

        @Volatile
        var cameraSpecState: String = "back"

        @Volatile
        var torchOnState: Boolean = false

        @Volatile
        var floatingPreviewState: Boolean = true

        @Volatile
        var currentOutputPath: String? = null

        fun startServiceRecording(
            context: Context,
            useFrontCamera: Boolean,
            cameraSpec: String,
            enableTorch: Boolean,
            showFloatingPreview: Boolean,
            maxDurationSec: Int
        ) {
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_USE_FRONT_CAMERA, useFrontCamera)
                putExtra(EXTRA_CAMERA_SPEC, cameraSpec)
                putExtra(EXTRA_ENABLE_TORCH, enableTorch)
                putExtra(EXTRA_SHOW_PREVIEW, showFloatingPreview)
                putExtra(EXTRA_MAX_DURATION_SEC, maxDurationSec)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun startServicePreview(
            context: Context,
            useFrontCamera: Boolean,
            cameraSpec: String,
            enableTorch: Boolean
        ) {
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_START_PREVIEW
                putExtra(EXTRA_USE_FRONT_CAMERA, useFrontCamera)
                putExtra(EXTRA_CAMERA_SPEC, cameraSpec)
                putExtra(EXTRA_ENABLE_TORCH, enableTorch)
                putExtra(EXTRA_SHOW_PREVIEW, true)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun stopPreviewIfIdle(context: Context) {
            if (isRunning) return
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_STOP_PREVIEW
            }
            context.startService(intent)
        }

        fun takePhotoSnapshot(context: Context) {
            if (!isServiceActive) return
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_TAKE_PHOTO
            }
            context.startService(intent)
        }

        fun switchCamera(context: Context, cameraSpec: String) {
            cameraSpecState = cameraSpec
            if (!isServiceActive) return
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_SWITCH_CAMERA
                putExtra(EXTRA_CAMERA_SPEC, cameraSpec)
            }
            context.startService(intent)
        }

        fun stopServiceRecording(context: Context) {
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_STOP
            }
            context.stopService(intent)
        }

        fun sendControlAction(context: Context, actionName: String) {
            if (!isServiceActive) return
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = actionName
            }
            context.startService(intent)
        }

        fun setFloatingPreview(context: Context, visible: Boolean) {
            floatingPreviewState = visible
            if (!isServiceActive) return
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_SET_PREVIEW
                putExtra(EXTRA_SHOW_PREVIEW, visible)
            }
            context.startService(intent)
        }

        fun setTorch(context: Context, enabled: Boolean) {
            torchOnState = enabled
            if (!isServiceActive) return
            val intent = Intent(context, BackgroundVideoRecordService::class.java).apply {
                action = ACTION_SET_TORCH
                putExtra(EXTRA_ENABLE_TORCH, enabled)
            }
            context.startService(intent)
        }
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

  // 2. Inyectar motor nativo de compresión, recorte y grabación en 2do plano (VideoEngineModule + BackgroundVideoRecordService)
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
      fs.writeFileSync(
        path.join(pkgDir, 'BackgroundVideoRecordService.kt'),
        BACKGROUND_VIDEO_RECORD_SERVICE_KT,
        'utf8'
      );
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

  // 4. Registrar Intent Filter ACTION_SEND, permisos de 2do plano y BackgroundVideoRecordService en AndroidManifest.xml
  config = withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest;
    if (!Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = [];
    }
    const requiredPerms = [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_CAMERA',
      'android.permission.FOREGROUND_SERVICE_MICROPHONE',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.WAKE_LOCK',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
    ];
    for (const permName of requiredPerms) {
      const exists = manifest['uses-permission'].some(
        (p) => p.$?.['android:name'] === permName
      );
      if (!exists) {
        manifest['uses-permission'].push({
          $: { 'android:name': permName },
        });
      }
    }

    const app = manifest.application?.[0];
    if (app) {
      if (!Array.isArray(app.service)) {
        app.service = [];
      }
      const hasBgRecordService = app.service.some(
        (s) =>
          s.$?.['android:name'] === '.BackgroundVideoRecordService' ||
          s.$?.['android:name']?.endsWith('.BackgroundVideoRecordService')
      );
      if (!hasBgRecordService) {
        app.service.push({
          $: {
            'android:name': '.BackgroundVideoRecordService',
            'android:enabled': 'true',
            'android:exported': 'false',
            'android:foregroundServiceType': 'camera|microphone',
          },
        });
      }
    }

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
