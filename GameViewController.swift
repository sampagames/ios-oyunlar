import UIKit
import WebKit

/// Oyunu (web/index.html) internetsiz olarak tam ekran gösterir.
/// Android'deki `window.AndroidAds` köprüsünün aynısını sağlar, böylece AdKit v2 değişmeden çalışır:
///   AndroidAds.show(kind, id)  -> kind: "rewarded" | "inter" (ödüllü geçiş) | "plain" (geçiş)
///   AndroidAds.isReady(kind)   -> native tarafın bildirdiği hazır durumu
///   sonuç: window.__adkitResult(id, "rewarded" | "dismissed" | "failed")
final class GameViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private lazy var ads = AdManager(presenter: self)

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(named: "LaunchBackground") ?? .black

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        let shim = """
        (function(){
          window.__iosReady = {rewarded:false, inter:false, plain:false};
          window.AndroidAds = {
            show: function(kind, id){ window.webkit.messageHandlers.ads.postMessage({kind: String(kind), id: String(id)}); },
            isReady: function(kind){ return !!window.__iosReady[kind]; }
          };
          window.AndroidApp = window.AndroidApp || { exit: function(){} };
        })();
        """
        config.userContentController.addUserScript(
            WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "ads")

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(iOS 16.4, *) { webView.isInspectable = false }
        view.addSubview(webView)

        if let dir = Bundle.main.url(forResource: "web", withExtension: nil) {
            webView.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        }

        ads.onReadyChange = { [weak self] kind, ready in
            self?.webView.evaluateJavaScript("window.__iosReady&&(window.__iosReady['\(kind)']=\(ready));", completionHandler: nil)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        ads.startIfNeeded()
    }

    // JS -> native
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "ads", let body = message.body as? [String: Any],
              let kind = body["kind"] as? String, let id = body["id"] as? String else { return }
        ads.show(kind: kind) { [weak self] result in
            let safeId = id.replacingOccurrences(of: "'", with: "")
            self?.webView.evaluateJavaScript("window.__adkitResult&&window.__adkitResult('\(safeId)','\(result)');", completionHandler: nil)
        }
    }

    // Dış bağlantılar (gizlilik politikası vb.) Safari'de açılır; oyun içinde gezinme olmaz.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        for (kind, ready) in ads.readyStates where ready {
            webView.evaluateJavaScript("window.__iosReady&&(window.__iosReady['\(kind)']=true);", completionHandler: nil)
        }
    }

    // Web içeriği bellek nedeniyle kapanırsa oyunu yeniden yükle (kayıt localStorage'da kalır).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}
