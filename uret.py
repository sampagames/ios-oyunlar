#!/usr/bin/env python3
"""Sampa Games iOS projeleri. Depo düz yapıdadır (GitHub web yüklemesi klasör tutmaz):
  oyunlar.json, adkit.js, *.swift, <id>.index.html, <id>.ikon.png  ->  oyunlar/<id>/ (XcodeGen projesi)
Kullanım: python3 uret.py            (hepsi)
          python3 uret.py orbo piazza (seçilenler)
Mac'te (Codemagic) her oyun klasöründe `xcodegen generate` çalıştırılır."""
import json, os, shutil, sys
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
GAMES = json.load(open(os.path.join(ROOT, "oyunlar.json"), encoding="utf-8"))

# Google'ın önerdiği SKAdNetwork kimlikleri (AdMob + yaygın alıcılar)
SKAN = """cstr6suwn9 4fzdc2evr5 2fnua5tdw4 ydx93a7ass p78axxw29g v72qych5uu ludvb6z3bs cp8zw746q7
3sh42y64q3 c6k4g5qg8m s39g8k73mm 3qy4746246 hs6bdukanm mlmmfzh3r3 v4nxqhlyqp wzmmz9fp6w su67r6k2v3
yclnxrl5pm 7ug5zh24hu gta9lk7p23 vutu7akeur y5ghdn5j9k v9wttpbfk9 n38lu8286q 47vhws6wlr kbd757ywx3
9t245vhmpl a2p9lx4jpn 22mmun2rn5 44jx6755aq k674qkevps 4468km3ulz 2u9pt9hc89 8s468mfl3y ppxm28t8ap
uw77j35x4d pwa73g5rt2 578prtvx9j 4dzt52r2t5 tl55sbb4fm e5fvkxwrpn 8c4e2ghe7u 3rd42ekr43 3qcr597p9d""".split()

ATT = {
    "en": "Allow tracking to see ads that are more relevant to you. The game stays free thanks to ads.",
    "tr": "İzin verirsen sana daha uygun reklamlar gösterilir. Oyun reklamlar sayesinde ücretsiz kalır.",
    "es": "Permite el rastreo para ver anuncios más relevantes para ti. El juego es gratis gracias a los anuncios.",
    "pt-BR": "Permita o rastreamento para ver anúncios mais relevantes para você. O jogo é grátis graças aos anúncios.",
    "de": "Erlaube Tracking, um passendere Werbung zu sehen. Das Spiel bleibt dank Werbung kostenlos.",
    "fr": "Autorise le suivi pour voir des pubs plus pertinentes. Le jeu reste gratuit grâce aux pubs.",
    "it": "Consenti il tracciamento per vedere annunci più pertinenti. Il gioco resta gratuito grazie agli annunci.",
}


def hex_to_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def yaml_str(s):
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def build(gid):
    g = GAMES[gid]
    shared = os.path.join(ROOT, "Shared", "Sources")
    os.makedirs(shared, exist_ok=True)
    for f in os.listdir(ROOT):
        if f.endswith(".swift"):
            shutil.copy(os.path.join(ROOT, f), os.path.join(shared, f))
    out = os.path.join(ROOT, "oyunlar", gid)
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, "web"))

    # Oyun dosyaları (AdKit v2 ortak)
    shutil.copy(os.path.join(ROOT, gid + ".index.html"), os.path.join(out, "web", "index.html"))
    shutil.copy(os.path.join(ROOT, "adkit.js"), os.path.join(out, "web", "adkit.js"))
    html = open(os.path.join(out, "web", "index.html"), encoding="utf-8").read()
    assert 'src="adkit.js"' in html, gid + ": index.html adkit.js yüklemiyor"

    # Simge (1024, saydamlıksız) ve açılış rengi
    xc = os.path.join(out, "Assets.xcassets")
    icon_dir = os.path.join(xc, "AppIcon.appiconset")
    os.makedirs(icon_dir)
    im = Image.open(os.path.join(ROOT, gid + ".ikon.png")).convert("RGBA")
    bg = Image.new("RGBA", im.size, tuple(int(c * 255) for c in hex_to_rgb(g["background"])) + (255,))
    bg.alpha_composite(im)
    bg.convert("RGB").resize((1024, 1024), Image.LANCZOS).save(os.path.join(icon_dir, "icon-1024.png"))
    json.dump({"images": [{"filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
               "info": {"author": "xcode", "version": 1}}, open(os.path.join(icon_dir, "Contents.json"), "w"), indent=1)
    json.dump({"info": {"author": "xcode", "version": 1}}, open(os.path.join(xc, "Contents.json"), "w"))
    col = os.path.join(xc, "LaunchBackground.colorset")
    os.makedirs(col)
    r, gg, b = hex_to_rgb(g["background"])
    json.dump({"colors": [{"idiom": "universal", "color": {"color-space": "srgb", "components": {
        "red": f"{r:.3f}", "green": f"{gg:.3f}", "blue": f"{b:.3f}", "alpha": "1.000"}}}],
        "info": {"author": "xcode", "version": 1}}, open(os.path.join(col, "Contents.json"), "w"), indent=1)

    # İzin metni çevirileri
    for lang, text in ATT.items():
        d = os.path.join(out, "Dil", f"{lang}.lproj")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "InfoPlist.strings"), "w", encoding="utf-8") as f:
            f.write(f'"NSUserTrackingUsageDescription" = "{text}";\n"CFBundleDisplayName" = "{g["name"]}";\n')

    target = "SampaGame"
    skan = "\n".join(f"          - SKAdNetworkIdentifier: {k}.skadnetwork" for k in SKAN)
    langs = "\n".join(f"          - {l}" for l in ATT)
    yml = f"""name: {target}
options:
  deploymentTarget:
    iOS: "15.0"
  developmentLanguage: en
packages:
  GoogleMobileAds:
    url: https://github.com/googleads/swift-package-manager-google-mobile-ads.git
    from: 13.11.0
  GoogleUserMessagingPlatform:
    url: https://github.com/googleads/swift-package-manager-google-user-messaging-platform.git
    from: 3.1.0
targets:
  {target}:
    type: application
    platform: iOS
    sources:
      - path: ../../Shared/Sources
      - path: web
        type: folder
        buildPhase: resources
      - path: Assets.xcassets
      - path: Dil
    dependencies:
      - package: GoogleMobileAds
      - package: GoogleUserMessagingPlatform
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: {g["bundle"]}
        PRODUCT_NAME: {yaml_str(target)}
        MARKETING_VERSION: {yaml_str(g["version"])}
        CURRENT_PROJECT_VERSION: {yaml_str(g["build"])}
        TARGETED_DEVICE_FAMILY: "1"
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        SWIFT_VERSION: "5.0"
        CODE_SIGN_STYLE: Manual
        ENABLE_BITCODE: NO
        OTHER_LDFLAGS: $(inherited) -ObjC
    info:
      path: Info.plist
      properties:
        CFBundleDisplayName: {yaml_str(g["name"])}
        CFBundleShortVersionString: $(MARKETING_VERSION)
        CFBundleVersion: $(CURRENT_PROJECT_VERSION)
        CFBundleDevelopmentRegion: en
        CFBundleLocalizations:
{langs}
        LSRequiresIPhoneOS: true
        UIRequiresFullScreen: true
        UIStatusBarHidden: true
        UIViewControllerBasedStatusBarAppearance: true
        UISupportedInterfaceOrientations:
          - UIInterfaceOrientationPortrait
        UILaunchScreen:
          UIColorName: LaunchBackground
        ITSAppUsesNonExemptEncryption: false
        GADApplicationIdentifier: {g["admob_app"]}
        SGRewardedID: {g["rewarded"]}
        SGRewardedInterstitialID: {g["rewarded_interstitial"]}
        SGInterstitialID: {g["interstitial"]}
        NSUserTrackingUsageDescription: {yaml_str(ATT["en"])}
        SKAdNetworkItems:
{skan}
"""
    open(os.path.join(out, "project.yml"), "w", encoding="utf-8").write(yml)
    return out


if __name__ == "__main__":
    ids = sys.argv[1:] or list(GAMES)
    for gid in ids:
        print("hazır:", build(gid))
