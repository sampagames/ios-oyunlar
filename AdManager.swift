import UIKit
import AppTrackingTransparency
import GoogleMobileAds
import UserMessagingPlatform

/// Reklam kimlikleri Info.plist'ten okunur (OrboRewardedID vb. yerine genel anahtarlar):
///   SGRewardedID, SGRewardedInterstitialID, SGInterstitialID
/// Sıra: izleme izni (ATT) -> Google onay formu (UMP) -> SDK başlat -> reklamları önceden yükle.
final class AdManager: NSObject, FullScreenContentDelegate {
    private weak var presenter: UIViewController?
    private var started = false
    private var canRequest = false

    private var rewarded: RewardedAd?
    private var rewardedInter: RewardedInterstitialAd?
    private var interstitial: InterstitialAd?

    private var pending: ((String) -> Void)?
    private var earned = false
    private var showingKind = ""

    var onReadyChange: ((String, Bool) -> Void)?

    /// Sayfa yeniden yüklendiğinde mevcut durumu tekrar bildirmek için.
    var readyStates: [String: Bool] {
        ["rewarded": rewarded != nil, "inter": rewardedInter != nil, "plain": interstitial != nil]
    }

    private let ids: [String: String] = {
        let info = Bundle.main.infoDictionary ?? [:]
        return [
            "rewarded": info["SGRewardedID"] as? String ?? "",
            "inter": info["SGRewardedInterstitialID"] as? String ?? "",
            "plain": info["SGInterstitialID"] as? String ?? "",
        ]
    }()

    init(presenter: UIViewController) {
        self.presenter = presenter
        super.init()
    }

    func startIfNeeded() {
        guard !started else { return }
        started = true
        // İzleme izni penceresi, uygulama ön plandayken istenmeli.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            if #available(iOS 14, *) {
                ATTrackingManager.requestTrackingAuthorization { _ in
                    DispatchQueue.main.async { self.requestConsent() }
                }
            } else {
                self.requestConsent()
            }
        }
    }

    private func requestConsent() {
        let params = RequestParameters()
        ConsentInformation.shared.requestConsentInfoUpdate(with: params) { [weak self] _ in
            guard let self = self else { return }
            Task { @MainActor in
                if let vc = self.presenter {
                    try? await ConsentForm.loadAndPresentIfRequired(from: vc)
                }
                self.startSDKIfAllowed()
            }
        }
        // Onay bilgisi önceki oturumdan geliyorsa beklemeden başla.
        startSDKIfAllowed()
    }

    private func startSDKIfAllowed() {
        guard ConsentInformation.shared.canRequestAds, !canRequest else { return }
        canRequest = true
        MobileAds.shared.start { [weak self] _ in
            DispatchQueue.main.async {
                self?.loadRewarded()
                self?.loadRewardedInter()
                self?.loadInterstitial()
            }
        }
    }

    // MARK: - Yükleme

    private func loadRewarded() {
        guard canRequest, let id = ids["rewarded"], !id.isEmpty else { return }
        RewardedAd.load(with: id, request: Request()) { [weak self] ad, error in
            guard let self = self else { return }
            if let ad = ad {
                ad.fullScreenContentDelegate = self
                self.rewarded = ad
                self.onReadyChange?("rewarded", true)
            } else {
                self.retry { self.loadRewarded() }
            }
        }
    }

    private func loadRewardedInter() {
        guard canRequest, let id = ids["inter"], !id.isEmpty else { return }
        RewardedInterstitialAd.load(with: id, request: Request()) { [weak self] ad, error in
            guard let self = self else { return }
            if let ad = ad {
                ad.fullScreenContentDelegate = self
                self.rewardedInter = ad
                self.onReadyChange?("inter", true)
            } else {
                self.retry { self.loadRewardedInter() }
            }
        }
    }

    private func loadInterstitial() {
        guard canRequest, let id = ids["plain"], !id.isEmpty else { return }
        InterstitialAd.load(with: id, request: Request()) { [weak self] ad, error in
            guard let self = self else { return }
            if let ad = ad {
                ad.fullScreenContentDelegate = self
                self.interstitial = ad
                self.onReadyChange?("plain", true)
            } else {
                self.retry { self.loadInterstitial() }
            }
        }
    }

    private func retry(_ block: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: block)
    }

    // MARK: - Gösterme

    func show(kind: String, completion: @escaping (String) -> Void) {
        guard let vc = presenter, pending == nil else { completion("failed"); return }
        earned = false
        showingKind = kind
        switch kind {
        case "rewarded":
            guard let ad = rewarded else { completion("failed"); return }
            pending = completion
            rewarded = nil
            onReadyChange?("rewarded", false)
            ad.present(from: vc) { [weak self] in self?.earned = true }
        case "inter":
            guard let ad = rewardedInter else { completion("failed"); return }
            pending = completion
            rewardedInter = nil
            onReadyChange?("inter", false)
            ad.present(from: vc) { [weak self] in self?.earned = true }
        case "plain":
            guard let ad = interstitial else { completion("failed"); return }
            pending = completion
            interstitial = nil
            onReadyChange?("plain", false)
            ad.present(from: vc)
        default:
            completion("failed")
        }
    }

    private func finish(_ result: String) {
        let done = pending
        pending = nil
        let kind = showingKind
        DispatchQueue.main.async {
            done?(result)
            switch kind {
            case "rewarded": self.loadRewarded()
            case "inter": self.loadRewardedInter()
            case "plain": self.loadInterstitial()
            default: break
            }
        }
    }

    // MARK: - FullScreenContentDelegate

    func adDidDismissFullScreenContent(_ ad: FullScreenPresentingAd) {
        finish(earned ? "rewarded" : "dismissed")
    }

    func ad(_ ad: FullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        finish("failed")
    }
}
