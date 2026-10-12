package app.tavern.desk

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Typeface
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.text.InputType
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors

/**
 * 打字桌安卓壳:单 Activity,两张"页"在同一个 FrameLayout 里换着显示——
 *   · 地址页:只有一个输入框,填书房地址(https,带端口也行),存 SharedPreferences;
 *   · 书房页:全屏 WebView。三指下拉回地址页改地址;地址打不开自动回地址页并说原因。
 * 壳里不写任何地址、不带口令;口令在书房页面里输,存在 WebView 的 localStorage。
 */
class MainActivity : ComponentActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView

    // 刘海/状态栏/导航栏的像素距离,最近一次 insets 回调记下来;页面每次加载完也要再推一遍
    private var safeTop = 0
    private var safeLeft = 0
    private var safeRight = 0
    private var safeBottom = 0

    // 把让位距离写进页面根元素的 CSS 变量(单位 css px = 像素 / 密度)。页面没加载时推了也无妨。
    private fun pushSafeInsets() {
        if (!this::webView.isInitialized) return
        val d = resources.displayMetrics.density
        fun px(v: Int) = Math.round(v / d)
        val js = "(function(){var s=document.documentElement.style;" +
            "s.setProperty('--safe-top','${px(safeTop)}px');s.setProperty('--safe-left','${px(safeLeft)}px');" +
            "s.setProperty('--safe-right','${px(safeRight)}px');s.setProperty('--safe-bottom','${px(safeBottom)}px');})();"
        webView.evaluateJavascript(js, null)
    }
    private lateinit var addressPage: LinearLayout
    private lateinit var addressInput: EditText
    private lateinit var addressError: TextView

    private val prefs by lazy { getSharedPreferences("desk", MODE_PRIVATE) }
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** 当前书房的 origin(scheme://host[:port]);只有它能用下载桥、能在壳里导航。 */
    private var deskOrigin: String? = null
    private var loadedUrl: String? = null
    private var showingWeb = false
    private var scriptHandler: ScriptHandler? = null
    private var messageListenerOrigin: String? = null

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var fileChooserMultiple = false
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val data = result.data
        val uris = mutableListOf<Uri>()
        if (result.resultCode == RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add)
            else data.data?.let(uris::add)
        }
        callback.onReceiveValue(
            when {
                uris.isEmpty() -> null
                fileChooserMultiple -> uris.toTypedArray()
                else -> arrayOf(uris[0])
            }
        )
    }

    // ── 生命周期 ────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 铺满:内容画到系统栏和刘海区底下,系统栏沉浸(从边缘划一下临时出来)。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }

        root = FrameLayout(this).apply { setBackgroundColor(color(R.color.desk_page)) }
        webView = buildWebView()
        addressPage = buildAddressPage()
        root.addView(webView, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(addressPage, FrameLayout.LayoutParams(MATCH, MATCH))
        setContentView(root)
        enterImmersive()

        // 键盘让位:IME 高度作为底部 padding,WebView 跟着变矮,输入框不被盖住。
        // 刘海让位:内容画进刘海区(上面 LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS),摄像头的洞会压在页面
        // 顶上。壳不自己留边(留出来的那一条是壳的底色,跟页面墙纸对不上),而是把刘海/状态栏的
        // 上左右距离告诉页面,页面顶栏自己让位、用当前墙纸的颜色画那一条(前端读 --safe-top 等变量)。
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            view.setPadding(0, 0, 0, ime)
            val cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.statusBars())
            val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            safeTop = cut.top; safeLeft = cut.left; safeRight = cut.right; safeBottom = nav.bottom
            pushSafeInsets()
            insets
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    !showingWeb && loadedUrl != null -> showWeb()
                    showingWeb && webView.canGoBack() -> webView.goBack()
                    else -> moveTaskToBack(true) // 到头了退到后台,不关进程
                }
            }
        })

        val saved = prefs.getString(KEY_URL, null)
        if (saved != null) openDesk(saved) else showAddressPage(null)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        io.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    private fun enterImmersive() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ── 三指下拉回地址页 ─────────────────────────────────────────

    private var threeFingerStartY = -1f
    private var threeFingerFired = false

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (showingWeb) {
            when (ev.actionMasked) {
                MotionEvent.ACTION_POINTER_DOWN -> if (ev.pointerCount == 3) {
                    threeFingerStartY = averageY(ev)
                    threeFingerFired = false
                }
                MotionEvent.ACTION_MOVE -> if (ev.pointerCount >= 3 && threeFingerStartY >= 0 && !threeFingerFired &&
                    averageY(ev) - threeFingerStartY > dp(120)
                ) {
                    threeFingerFired = true
                    threeFingerStartY = -1f
                    // 先让 WebView 收到一个 CANCEL,别留下半截手势
                    val cancel = MotionEvent.obtain(ev).apply { action = MotionEvent.ACTION_CANCEL }
                    super.dispatchTouchEvent(cancel)
                    cancel.recycle()
                    showAddressPage(null)
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> threeFingerStartY = -1f
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun averageY(ev: MotionEvent): Float {
        var sum = 0f
        for (i in 0 until ev.pointerCount) sum += ev.getY(i)
        return sum / ev.pointerCount
    }

    // ── 地址页 ─────────────────────────────────────────────────

    private fun buildAddressPage(): LinearLayout {
        val pad = dp(28).toInt()
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(color(R.color.desk_page))
            isClickable = true // 盖在 WebView 上时别让点击漏下去
        }
        val title = TextView(this).apply {
            text = "书房地址"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            setTextColor(color(R.color.desk_ink))
            typeface = Typeface.SERIF
            gravity = Gravity.CENTER
        }
        addressInput = EditText(this).apply {
            hint = "https://desk.example.com"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            isSingleLine = true
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setOnEditorActionListener { _, actionId, event ->
                val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
                if (actionId == EditorInfo.IME_ACTION_GO || enter) { submitAddress(); true } else false
            }
        }
        val go = Button(this).apply {
            text = "进书房"
            setOnClickListener { submitAddress() }
        }
        addressError = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(color(R.color.desk_ink2))
            gravity = Gravity.CENTER
        }
        val tip = TextView(this).apply {
            text = "进书房后三指下拉,回到这里改地址"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(color(R.color.desk_ink2))
            gravity = Gravity.CENTER
        }
        val gap = dp(14).toInt()
        fun LinearLayout.add(view: View) = addView(view, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = gap })
        page.add(title)
        page.add(addressInput)
        page.add(go)
        page.add(addressError)
        page.add(tip)
        return page
    }

    private fun showAddressPage(error: String?) {
        showingWeb = false
        addressInput.setText(prefs.getString(KEY_URL, null) ?: loadedUrl ?: "")
        addressInput.setSelection(addressInput.text.length)
        addressError.text = error ?: ""
        addressPage.visibility = View.VISIBLE
        addressPage.bringToFront()
    }

    private fun showWeb() {
        hideKeyboard()
        showingWeb = true
        addressPage.visibility = View.GONE
        webView.requestFocus()
    }

    private fun submitAddress() {
        val url = normalizeAddress(addressInput.text.toString())
        if (url == null) {
            addressError.text = "地址要是 https:// 开头的网址,比如 https://desk.example.com"
            return
        }
        if (url == loadedUrl && webView.url != null && webView.url != BLANK) { showWeb(); return }
        openDesk(url)
    }

    /** 补 https://、去掉 #片段;只收 https、要有主机名。 */
    private fun normalizeAddress(raw: String): String? {
        var text = raw.trim()
        if (text.isEmpty()) return null
        if (!text.contains("://")) text = "https://$text"
        val uri = Uri.parse(text)
        if (uri.scheme?.lowercase() != "https" || uri.host.isNullOrEmpty()) return null
        return uri.buildUpon().fragment(null).build().toString()
    }

    private fun originOf(url: String?): String? {
        if (url == null) return null
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        return if (uri.port == -1) "$scheme://$host" else "$scheme://$host:${uri.port}"
    }

    private fun openDesk(url: String) {
        prefs.edit().putString(KEY_URL, url).apply()
        val origin = originOf(url)
        if (origin != deskOrigin) installBridges(origin)
        deskOrigin = origin
        loadedUrl = url
        showWeb()
        webView.loadUrl(url)
    }

    private fun failLoad(reason: String) {
        if (!showingWeb && addressPage.visibility == View.VISIBLE) { addressError.text = reason; return }
        webView.stopLoading()
        webView.loadUrl(BLANK)
        showAddressPage(reason)
    }

    // ── WebView ────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        if (0 != (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(this)
        view.setBackgroundColor(color(R.color.desk_page))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // 口令存在 localStorage,随 App 数据持久
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            userAgentString = "$userAgentString TavernDesk/1.0"
        }
        CookieManager.getInstance().setAcceptCookie(true)

        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url == BLANK || originOf(url) == deskOrigin) return false
                // 书房外的链接交给系统浏览器,壳里只开书房自己
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: ActivityNotFoundException) {}
                return true
            }

            override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
                if (scriptHandler == null && originOf(url) == deskOrigin) v.evaluateJavascript(DOWNLOAD_HOOK_JS, null)
                pushSafeInsets()
            }

            override fun onPageFinished(v: WebView, url: String?) {
                if (scriptHandler == null && originOf(url) == deskOrigin) v.evaluateJavascript(DOWNLOAD_HOOK_JS, null)
                pushSafeInsets()
            }

            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failLoad("打不开:${error.description}(${error.errorCode})")
            }

            override fun onReceivedHttpError(v: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 400) {
                    failLoad("书房那边回了 ${response.statusCode}${if (response.reasonPhrase.isNullOrBlank()) "" else " " + response.reasonPhrase}")
                }
            }

            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(v: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel() // 证书不对一律不放行
                if (originOf(error.url) == deskOrigin) failLoad("证书有问题(${sslReason(error)}),没有打开")
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            // 选文件:书房导预设 / 世界书 / 正则 / 角色卡全靠它。多选、任意类型。
            override fun onShowFileChooser(v: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                fileChooserMultiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    pickFiles.launch(Intent.createChooser(intent, "选文件"))
                    true
                } catch (_: ActivityNotFoundException) {
                    filePathCallback = null
                    callback.onReceiveValue(null)
                    toast("没有能选文件的应用")
                    false
                }
            }
        }

        // 下载:http(s) 交给 DownloadManager 存到系统「下载」;blob:/data:(书房导出配方 JSON、导出正文都是
        // 前端拼好 Blob 再点 <a download>)由页面里的钩子先读成 data: URL 交过来,这里只兜个底。
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            when {
                url.startsWith("https://") || url.startsWith("http://") -> enqueueDownload(url, userAgent, contentDisposition, mimeType)
                url.startsWith("data:") -> saveDataUrl(url, URLUtil.guessFileName(url, contentDisposition, mimeType))
                url.startsWith("blob:") -> view.evaluateJavascript(
                    "(function(){var a=document.createElement('a');a.href=${JSONObject.quote(url)};" +
                        "a.download=${JSONObject.quote(URLUtil.guessFileName(url, contentDisposition, mimeType))};a.click();})()", null
                )
            }
        }
        return view
    }

    private fun sslReason(error: SslError): String = when (error.primaryError) {
        SslError.SSL_EXPIRED -> "已过期"
        SslError.SSL_NOTYETVALID -> "还没生效"
        SslError.SSL_IDMISMATCH -> "跟域名对不上"
        SslError.SSL_UNTRUSTED -> "不受信任"
        SslError.SSL_DATE_INVALID -> "日期不对"
        else -> "无效"
    }

    /**
     * 下载桥只对书房自己的 origin 开:新版 WebView 用 addDocumentStartJavaScript + addWebMessageListener
     * (按 origin 白名单注入);老 WebView 退回 addJavascriptInterface,方法里再核一次当前页面的 origin。
     */
    private fun installBridges(origin: String?) {
        scriptHandler?.remove()
        scriptHandler = null
        messageListenerOrigin?.let { WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME) }
        messageListenerOrigin = null
        webView.removeJavascriptInterface(BRIDGE_NAME)
        if (origin == null) return
        val rules = setOf(origin)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, rules) { _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || originOf(sourceOrigin.toString()) != deskOrigin) return@addWebMessageListener
                handleBridgeMessage(message.data ?: return@addWebMessageListener)
            }
            messageListenerOrigin = origin
        } else {
            webView.addJavascriptInterface(LegacyBridge(), BRIDGE_NAME)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            scriptHandler = WebViewCompat.addDocumentStartJavaScript(webView, DOWNLOAD_HOOK_JS, rules)
        }
    }

    private inner class LegacyBridge {
        @JavascriptInterface
        fun postMessage(data: String) {
            main.post { if (originOf(webView.url) == deskOrigin) handleBridgeMessage(data) }
        }
    }

    private fun handleBridgeMessage(data: String) {
        val msg = try { JSONObject(data) } catch (_: Exception) { return }
        when (msg.optString("type")) {
            "save" -> saveDataUrl(msg.optString("dataUrl"), msg.optString("name").ifBlank { "download" })
            "saveFailed" -> toast("下载失败:${msg.optString("error")}")
        }
    }

    private fun enqueueDownload(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        try {
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                if (!mimeType.isNullOrBlank()) setMimeType(mimeType)
                if (!userAgent.isNullOrBlank()) addRequestHeader("User-Agent", userAgent)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                setTitle(name)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            }
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            toast("开始下载:$name")
        } catch (e: Exception) {
            toast("下载失败:${e.message}")
        }
    }

    /** data: URL 解码后写进系统「下载」(MediaStore,API 29+ 不要存储权限)。 */
    private fun saveDataUrl(dataUrl: String, rawName: String) {
        val comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith("data:") || comma < 0) { toast("下载失败:数据不对"); return }
        val header = dataUrl.substring(5, comma)
        val isBase64 = header.endsWith(";base64")
        val name = rawName.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").ifBlank { "download" }
        // MIME 按扩展名定:跟扩展名对不上时 MediaStore 会自作主张改文件名(比如 .md 被补成 .md.txt)。
        val ext = name.substringAfterLast('.', "").lowercase()
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            ?: if (ext.isEmpty()) header.substringBefore(';').ifBlank { "application/octet-stream" } else "application/octet-stream"
        io.execute {
            val result = try {
                val payload = dataUrl.substring(comma + 1)
                val bytes = if (isBase64) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray()
                writeToDownloads(bytes, name, mime)
                "已存到「下载」:$name"
            } catch (e: Exception) {
                "下载失败:${e.message}"
            }
            main.post { toast(result) }
        }
    }

    private fun writeToDownloads(bytes: ByteArray, name: String, mime: String) {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException("建不了文件")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IOException("写不进去")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
    }

    // ── 小工具 ─────────────────────────────────────────────────

    private fun hideKeyboard() {
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(root.windowToken, 0)
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun dp(value: Int) = value * resources.displayMetrics.density

    companion object {
        private const val KEY_URL = "desk_url"
        private const val BLANK = "about:blank"
        private const val BRIDGE_NAME = "TavernDeskNative"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

        /**
         * 页面里的下载钩子:书房前端导出时是"拼 Blob → createObjectURL → 点 <a download> → 立刻 revoke",
         * DownloadManager 拿不到 blob: 地址,等回调到了 URL 也已经被 revoke。所以在点击那一刻接住:
         * 记下每个 createObjectURL 对应的 Blob,点击带 download 的 blob:/data: 链接时直接读成 data: URL
         * 交给壳存进「下载」。
         */
        private val DOWNLOAD_HOOK_JS = """
            (function () {
              if (window.__tavernDeskHook) return;
              window.__tavernDeskHook = true;
              var send = function (msg) {
                var bridge = window.$BRIDGE_NAME;
                if (bridge && bridge.postMessage) bridge.postMessage(JSON.stringify(msg));
              };
              var blobs = new Map();
              var create = URL.createObjectURL, revoke = URL.revokeObjectURL;
              URL.createObjectURL = function (obj) {
                var url = create.call(URL, obj);
                if (obj instanceof Blob) blobs.set(url, obj);
                return url;
              };
              URL.revokeObjectURL = function (url) {
                setTimeout(function () { blobs.delete(url); }, 60000);
                return revoke.call(URL, url);
              };
              var read = function (href) {
                var blob = blobs.get(href);
                var got = blob ? Promise.resolve(blob) : fetch(href).then(function (r) { return r.blob(); });
                return got.then(function (b) {
                  return new Promise(function (ok, fail) {
                    var fr = new FileReader();
                    fr.onload = function () { ok(String(fr.result)); };
                    fr.onerror = function () { fail(fr.error); };
                    fr.readAsDataURL(b);
                  });
                });
              };
              var click = HTMLAnchorElement.prototype.click;
              HTMLAnchorElement.prototype.click = function () {
                var href = this.href || '';
                if (this.hasAttribute('download') && (href.indexOf('blob:') === 0 || href.indexOf('data:') === 0) && window.$BRIDGE_NAME) {
                  var name = this.getAttribute('download') || 'download';
                  read(href).then(function (dataUrl) { send({ type: 'save', name: name, dataUrl: dataUrl }); })
                    .catch(function (e) { send({ type: 'saveFailed', error: String((e && e.message) || e) }); });
                  return;
                }
                return click.apply(this, arguments);
              };
            })();
        """.trimIndent()
    }
}
