#if GOLAZO
import UIKit
import WebKit
import GameKit

/// Golazo'ya özel iOS özellikleri (yalnızca GOLAZO derlemesinde):
///  - Game Center: oturum, skor tabloları, başarımlar  (JS: window.AndroidGames köprüsü)
///  - Yerel paylaşım sayfası (UIActivityViewController)  (JS: window.AndroidShare)
///  - Dokunsal geri bildirim (navigator.vibrate -> UIFeedbackGenerator)
final class GolazoNative: NSObject, GKGameCenterControllerDelegate {
    private weak var host: UIViewController?
    private weak var web: WKWebView?
    private var authVC: UIViewController?
    private let impact = UIImpactFeedbackGenerator(style: .medium)
    private let notify = UINotificationFeedbackGenerator()

    static let handlerNames = ["games", "share", "haptic"]

    /// Sayfa yüklenmeden önce eklenen JS: oyun kodu Android'deki adlarla çağırır.
    static let jsShim = """
    (function(){
      window.__gc = {avail:true, signed:false, name:''};
      var post = function(name, body){ try{ window.webkit.messageHandlers[name].postMessage(body); }catch(e){} };
      window.AndroidGames = {
        isAvailable: function(){ return !!window.__gc.avail; },
        isSignedIn: function(){ return !!window.__gc.signed; },
        playerName: function(){ return window.__gc.name || ''; },
        signIn: function(){ post('games', {op:'signIn'}); },
        submit: function(k, v){ post('games', {op:'submit', key:String(k), value:Number(v)||0}); },
        unlock: function(id){ post('games', {op:'unlock', key:String(id)}); },
        showAllLeaderboards: function(){ post('games', {op:'leaderboards'}); },
        showLeaderboard: function(k){ post('games', {op:'leaderboard', key:String(k)}); },
        showAchievements: function(){ post('games', {op:'achievements'}); }
      };
      window.AndroidShare = {
        shareText: function(t){ post('share', {text:String(t)}); },
        shareFile: function(b64, mime, name, text){ post('share', {b64:String(b64), mime:String(mime), name:String(name), text:String(text||'')}); }
      };
      try {
        navigator.vibrate = function(p){
          var n = Array.isArray(p) ? p.length : 1;
          var d = Array.isArray(p) ? p.reduce(function(a,b){return a+(+b||0);},0) : (+p||0);
          post('haptic', {n:n, d:d}); return true;
        };
      } catch(e) {}
    })();
    """

    init(host: UIViewController, web: WKWebView) {
        self.host = host
        self.web = web
        super.init()
    }

    // MARK: Game Center
    func authenticate() {
        GKLocalPlayer.local.authenticateHandler = { [weak self] vc, _ in
            guard let self = self else { return }
            if let vc = vc { self.authVC = vc }
            self.pushState()
        }
    }

    private func pushState() {
        let p = GKLocalPlayer.local
        let ok = p.isAuthenticated
        let name = ok ? p.displayName.replacingOccurrences(of: "'", with: "’") : ""
        let js = "window.__gc&&(window.__gc.signed=\(ok),window.__gc.name='\(name)');" +
                 "window.__gamesSignedIn&&window.__gamesSignedIn(\(ok),'\(name)');"
        DispatchQueue.main.async { self.web?.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func lbID(_ key: String) -> String { "golazo_" + key }

    func handleGames(_ body: [String: Any]) {
        let op = body["op"] as? String ?? ""
        let key = body["key"] as? String ?? ""
        switch op {
        case "signIn":
            if GKLocalPlayer.local.isAuthenticated { pushState() }
            else if let vc = authVC { host?.present(vc, animated: true) }
            else if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case "submit":
            guard GKLocalPlayer.local.isAuthenticated else { return }
            let v = Int((body["value"] as? NSNumber)?.doubleValue ?? 0)
            GKLeaderboard.submitScore(v, context: 0, player: GKLocalPlayer.local,
                                      leaderboardIDs: [lbID(key)]) { _ in }
        case "unlock":
            guard GKLocalPlayer.local.isAuthenticated else { return }
            let a = GKAchievement(identifier: lbID(key))
            a.percentComplete = 100
            a.showsCompletionBanner = true
            GKAchievement.report([a]) { _ in }
        case "leaderboards":
            present(GKGameCenterViewController(state: .leaderboards))
        case "leaderboard":
            present(GKGameCenterViewController(leaderboardID: lbID(key), playerScope: .global, timeScope: .allTime))
        case "achievements":
            present(GKGameCenterViewController(state: .dashboard))
        default: break
        }
    }

    private func present(_ vc: GKGameCenterViewController) {
        guard GKLocalPlayer.local.isAuthenticated else { handleGames(["op": "signIn"]); return }
        vc.gameCenterDelegate = self
        host?.present(vc, animated: true)
    }

    func gameCenterViewControllerDidFinish(_ gameCenterViewController: GKGameCenterViewController) {
        gameCenterViewController.dismiss(animated: true)
    }

    // MARK: Paylaşım
    func handleShare(_ body: [String: Any]) {
        var items: [Any] = []
        if let b64 = body["b64"] as? String, let data = Data(base64Encoded: b64) {
            let name = (body["name"] as? String ?? "golazo.mp4").replacingOccurrences(of: "/", with: "_")
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            if (try? data.write(to: url)) != nil { items.append(url) }
        }
        if let text = body["text"] as? String, !text.isEmpty { items.append(text) }
        guard !items.isEmpty, let host = host else { return }
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let pop = vc.popoverPresentationController {
            pop.sourceView = host.view
            pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        host.present(vc, animated: true)
    }

    // MARK: Dokunsal
    func handleHaptic(_ body: [String: Any]) {
        let n = (body["n"] as? NSNumber)?.intValue ?? 1
        let d = (body["d"] as? NSNumber)?.doubleValue ?? 20
        if n > 2 { notify.notificationOccurred(.success) }
        else if d >= 60 { UIImpactFeedbackGenerator(style: .heavy).impactOccurred() }
        else { impact.impactOccurred() }
    }
}
#endif
