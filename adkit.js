/* AdKit v2 — oyunların ortak reklam katmanı (Sampa Games)
 * Android uygulamasında window.AndroidAds (Java köprüsü) üzerinden gerçek AdMob reklamı gösterir.
 * Tarayıcıda (köprü yoksa) birkaç saniyelik deneme reklamı açar, böylece akış test edilebilir.
 *
 * API
 *   AdKit.rewarded(placement)                 -> Promise<boolean>  Ödül kazanıldı mı
 *   AdKit.offer({title,text,button,placement}) -> Promise<boolean>  "Reklam izle, X kazan" penceresi + reklam
 *   AdKit.levelDone({reward, force})          -> Promise<boolean>  Bölüm sonu: ödüllü geçiş teklifi; o sıra değilse
 *                                                                  ve süre uygunsa normal geçiş reklamı (v2)
 *   AdKit.breakpoint()                         -> Promise<void>     Doğal mola noktası: uygunsa normal geçiş reklamı (v2)
 *   AdKit.left()                               -> bugün kalan ödüllü reklam hakkı
 *
 * Geçiş reklamı kuralları (v2, Google politikasına uygun):
 *   - Yalnızca bölüm geçişi gibi doğal molalarda, oyun ortasında asla.
 *   - Oturumun ilk interStartSec saniyesinde gösterilmez.
 *   - Herhangi bir tam ekran reklamdan (ödüllü dahil) en az interGapSec saniye sonra.
 *   - interEvery molada bir; günde en fazla interDailyCap.
 *   - Oyuncu ödüllü geçiş teklifinde "Atla" dediyse aynı molada ikinci reklam çıkmaz.
 *   - Reklamdan önce 1 saniyelik "Reklam arası" yazısı görünür (beklenmedik reklam olmasın).
 */
(function () {
  'use strict';
  if (window.AdKit) return;

  var CFG = Object.assign({
    everyLevels: 3,      // kaç bölümde bir ödüllü geçiş reklamı teklif edilir
    minGapSec: 90,       // iki ödüllü geçiş reklamı arasında en az süre
    dailyCap: 30,        // günlük ödüllü reklam üst sınırı
    introSec: 5,         // ödüllü geçiş reklamı öncesi geri sayım
    mockSec: 4,          // tarayıcıdaki deneme reklamı süresi
    interEvery: 2,       // kaç molada bir normal geçiş reklamı (0 = kapalı)
    interGapSec: 150,    // herhangi bir tam ekran reklamdan sonra en az süre
    interStartSec: 90,   // oturum başında geçiş reklamı gösterilmeyen süre
    interDailyCap: 15    // günlük geçiş reklamı üst sınırı
  }, window.ADKIT_CONFIG || {});

  var TX = Object.assign({
    tryAd: 'Deneme reklamı', mockText: 'Uygulamada burada AdMob reklamı oynar', closeNo: 'Kapat (ödül yok)',
    claim: 'Ödülü al', close: 'Kapat', cap: 'Bugünkü reklam hakkın doldu, yarın yenilenir',
    dismissed: 'Reklam bitmeden kapatıldı, ödül verilmedi', failed: 'Şu an gösterilecek reklam yok, biraz sonra tekrar dene',
    win: 'Ödül kazan', watch: 'Reklam izle', no: 'Hayır, teşekkürler', bonus: 'Bonus ödül!',
    startsIn: 'Kısa bir reklam', sec: 'saniye içinde başlıyor. İzlersen ödül senin.', now: 'Hemen izle', skip: 'Atla',
    adBreak: 'Reklam arası'
  }, window.ADKIT_TEXT || {});

  /* ---------- kayıt ---------- */
  var KEY = 'adkit-v1', st = {};
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { st = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  function today() {
    var d = new Date().toDateString();
    if (st.day !== d) { st.day = d; st.count = 0; st.icount = 0; save(); }
    if (st.icount == null) st.icount = 0;
    return st;
  }
  var nowSec = function () { return Date.now() / 1000; };
  var sessionStart = nowSec();
  var levels = 0, lastInter = -1e9, lastAnyAd = -1e9, breaks = 0;

  /* ---------- ses: reklam sırasında oyunun sesini kıs ---------- */
  var ctxs = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (n) {
    var Orig = window[n];
    if (!Orig) return;
    var Wrapped = function () {
      var c = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
      ctxs.push(c); return c;
    };
    Wrapped.prototype = Orig.prototype;
    try { window[n] = Wrapped; } catch (e) {}
  });
  var wasRunning = [];
  function muteAll() { wasRunning = ctxs.filter(function (c) { return c.state === 'running'; }); wasRunning.forEach(function (c) { try { c.suspend(); } catch (e) {} }); }
  function unmuteAll() { wasRunning.forEach(function (c) { try { c.resume(); } catch (e) {} }); wasRunning = []; }

  /* ---------- görünüm ---------- */
  var css = '' +
    '.adk-layer{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:center;padding:16px;padding-bottom:calc(env(safe-area-inset-bottom,0px) + 16px);background:rgba(6,8,18,.62);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1b1f2a;-webkit-tap-highlight-color:transparent}' +
    '.adk-card{width:100%;max-width:400px;background:#fffdf7;border-radius:22px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:12px;text-align:center;animation:adkUp .3s cubic-bezier(.2,1.2,.4,1)}' +
    '@keyframes adkUp{from{transform:translateY(40px);opacity:0}}' +
    '.adk-card h3{margin:0;font-size:20px;font-weight:800;color:#1b1f2a}' +
    '.adk-card p{margin:0;color:#5a6072}' +
    '.adk-reward{display:inline-flex;align-self:center;align-items:center;gap:8px;background:#fff1c9;color:#8a5a00;font-weight:800;padding:8px 14px;border-radius:999px}' +
    '.adk-btn{border:0;border-radius:14px;padding:14px;font:800 16px system-ui,-apple-system,sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}' +
    '.adk-go{background:#2f9e6e;color:#fff;box-shadow:0 4px 0 #1f6e4c}.adk-go:active{transform:translateY(2px);box-shadow:0 2px 0 #1f6e4c}' +
    '.adk-skip{background:transparent;color:#5a6072;font-weight:700;padding:8px}' +
    '.adk-tag{font-size:11px;font-weight:900;letter-spacing:.08em;background:rgba(255,255,255,.22);padding:3px 7px;border-radius:6px;text-transform:uppercase}' +
    '.adk-bar{height:6px;border-radius:6px;background:#ece6d6;overflow:hidden}.adk-bar i{display:block;height:100%;background:#2f9e6e;width:100%;transform-origin:left}' +
    '.adk-mock{position:fixed;inset:0;z-index:2147483001;background:#0b0e1a;color:#f4f1e8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;font:15px system-ui,-apple-system,sans-serif}' +
    '.adk-mock b{font-size:44px}.adk-mock .adk-btn{min-width:200px}' +
    '.adk-break{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(6,8,18,.78);color:#fff;font:800 18px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.02em}' +
    '.adk-toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 70px);transform:translateX(-50%);z-index:2147483002;background:#1b1f2a;color:#fff;padding:10px 16px;border-radius:12px;font:700 14px system-ui,sans-serif;max-width:calc(100% - 32px);text-align:center;pointer-events:none;transition:opacity .3s}';
  function injectCss() {
    if (document.getElementById('adk-css')) return;
    var s = document.createElement('style'); s.id = 'adk-css'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  function el(html) { injectCss(); var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var toastT;
  function toast(msg) {
    var t = document.querySelector('.adk-toast');
    if (!t) { t = el('<div class="adk-toast"></div>'); document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = 1; clearTimeout(toastT);
    toastT = setTimeout(function () { t.style.opacity = 0; }, 2400);
  }
  var PLAY = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';

  /* ---------- reklam gösterimi (yerel köprü veya deneme) ---------- */
  var pending = {}, seq = 0;
  window.__adkitResult = function (id, res) { var f = pending[id]; delete pending[id]; if (f) f(res); };
  function nativeShow(kind) {
    return new Promise(function (resolve) {
      var id = 'a' + (++seq);
      pending[id] = resolve;
      try { window.AndroidAds.show(kind, id); } catch (e) { delete pending[id]; resolve('failed'); return; }
      setTimeout(function () { if (pending[id]) { delete pending[id]; resolve('failed'); } }, 180000);
    });
  }
  function mockShow(kind) {
    return new Promise(function (resolve) {
      var plain = kind === 'plain';
      var left = plain ? 3 : CFG.mockSec, done = false;
      var m = el('<div class="adk-mock" role="dialog" aria-label="Reklam"><span class="adk-tag">' + esc(TX.tryAd) + '</span><b>' + left + '</b>' +
        '<p>' + esc(TX.mockText) + ' (' + (plain ? 'interstitial' : kind === 'inter' ? 'rewarded interstitial' : 'rewarded') + ')</p>' +
        '<button class="adk-btn adk-skip" style="color:#c9cbd6">' + esc(plain ? TX.close : TX.closeNo) + '</button></div>');
      document.body.appendChild(m);
      var b = m.querySelector('b'), close = m.querySelector('button');
      var finish = function (r) { if (done) return; done = true; clearInterval(iv); m.remove(); resolve(r); };
      var iv = setInterval(function () {
        left--; b.textContent = Math.max(0, left);
        if (left <= 0) { clearInterval(iv); b.textContent = '✓'; close.className = 'adk-btn adk-go'; close.textContent = plain ? TX.close : TX.claim; }
      }, 1000);
      close.onclick = function () { finish(plain ? 'dismissed' : (left <= 0 ? 'rewarded' : 'dismissed')); };
    });
  }
  function hasNative() { return !!(window.AndroidAds && window.AndroidAds.show); }
  function isReady(kind) {
    if (!hasNative()) return true;
    try { return !!window.AndroidAds.isReady(kind); } catch (e) { return false; }
  }
  var busy = false;
  // Ham gösterim: 'rewarded' | 'dismissed' | 'failed' | 'cap'
  function raw(kind) {
    if (busy) return Promise.resolve('failed');
    var s = today();
    if (kind !== 'plain' && s.count >= CFG.dailyCap) return Promise.resolve('cap');
    if (!isReady(kind)) return Promise.resolve('failed');
    busy = true; muteAll();
    try { window.dispatchEvent(new CustomEvent('adkit:start', { detail: kind })); } catch (e) {}
    var p = hasNative() ? nativeShow(kind) : mockShow(kind);
    return p.then(function (r) {
      busy = false; unmuteAll();
      if (r !== 'failed') lastAnyAd = nowSec();
      try { window.dispatchEvent(new CustomEvent('adkit:end', { detail: r })); } catch (e) {}
      if (r === 'rewarded') { s.count++; save(); }
      if (kind === 'plain' && r !== 'failed') { s.icount++; save(); }
      return r;
    });
  }
  function explain(r) {
    if (r === 'cap') toast(TX.cap);
    else if (r === 'dismissed') toast(TX.dismissed);
    else if (r === 'failed') toast(TX.failed);
  }

  /* ---------- normal geçiş reklamı (doğal molada) ---------- */
  function interDue() {
    if (!CFG.interEvery) return false;
    var now = nowSec();
    if (now - sessionStart < CFG.interStartSec) return false;
    if (now - lastAnyAd < CFG.interGapSec) return false;
    if (today().icount >= CFG.interDailyCap) return false;
    if (breaks < CFG.interEvery) return false;
    return isReady('plain');
  }
  function plainBreak() {
    breaks++;
    if (busy || !interDue()) return Promise.resolve();
    breaks = 0;
    return new Promise(function (resolve) {
      var b = el('<div class="adk-break" role="status">' + esc(TX.adBreak) + '…</div>');
      document.body.appendChild(b);
      setTimeout(function () {
        b.remove();
        raw('plain').then(function () { resolve(); }, function () { resolve(); });
      }, 900);
    });
  }

  /* ---------- herkese açık API ---------- */
  var AdKit = {
    config: CFG,
    toast: toast,
    left: function () { return Math.max(0, CFG.dailyCap - today().count); },
    available: function () { return AdKit.left() > 0 && isReady('rewarded'); },

    // Ödüllü reklam (oyuncunun isteğiyle)
    rewarded: function (placement) {
      return raw('rewarded').then(function (r) { if (r !== 'rewarded') explain(r); return r === 'rewarded'; });
    },

    // "Reklam izle, X kazan" penceresi; kabul edilirse ödüllü reklam
    offer: function (o) {
      o = o || {};
      return new Promise(function (resolve) {
        var layer = el('<div class="adk-layer" role="dialog"><div class="adk-card">' +
          '<h3>' + esc(o.title || TX.win) + '</h3>' +
          (o.text ? '<p>' + esc(o.text) + '</p>' : '') +
          (o.reward ? '<span class="adk-reward">' + esc(o.reward) + '</span>' : '') +
          (o.timeout ? '<div class="adk-bar"><i></i></div>' : '') +
          '<button class="adk-btn adk-go">' + PLAY + esc(o.button || TX.watch) + '</button>' +
          '<button class="adk-btn adk-skip">' + esc(o.decline || TX.no) + '</button>' +
          '</div></div>');
        document.body.appendChild(layer);
        var tm = null, closed = false;
        var close = function (v) { if (closed) return; closed = true; clearTimeout(tm); layer.remove(); resolve(v); };
        if (o.timeout) {
          var bar = layer.querySelector('.adk-bar i');
          bar.style.transition = 'transform ' + o.timeout + 's linear';
          requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.transform = 'scaleX(0)'; }); });
          tm = setTimeout(function () { close(false); }, o.timeout * 1000);
        }
        layer.querySelector('.adk-skip').onclick = function () { close(false); };
        layer.querySelector('.adk-go').onclick = function () {
          clearTimeout(tm); layer.style.display = 'none';
          AdKit.rewarded(o.placement).then(function (ok) { closed = true; layer.remove(); resolve(ok); });
        };
      });
    },

    // Bölüm sonu: sıklık uygunsa tanıtım ekranı + ödüllü geçiş reklamı.
    // Google kuralı: ödül ve "Atla" seçeneği reklamdan ÖNCE gösterilir.
    // v2: ödüllü geçiş sırası değilse doğal mola sayılır, uygunsa normal geçiş reklamı gösterilir.
    levelDone: function (o) {
      o = o || {};
      levels++;
      var now = nowSec();
      var due = o.force || (levels >= CFG.everyLevels && now - lastInter >= CFG.minGapSec);
      if (!due || AdKit.left() <= 0 || !isReady('inter')) {
        if (o.force) return Promise.resolve(false);           // "devam et" gibi oyun içi tekliflerde geçiş reklamı yok
        return plainBreak().then(function () { return false; });
      }
      return new Promise(function (resolve) {
        var n = CFG.introSec;
        var layer = el('<div class="adk-layer" role="dialog"><div class="adk-card">' +
          '<h3>' + esc(o.title || TX.bonus) + '</h3>' +
          '<span class="adk-reward">' + esc(o.reward || 'Bonus') + '</span>' +
          '<p>' + esc(TX.startsIn) + ' <b class="adk-n">' + n + '</b> ' + esc(TX.sec) + '</p>' +
          '<div class="adk-bar"><i></i></div>' +
          '<button class="adk-btn adk-go">' + PLAY + esc(TX.now) + '</button>' +
          '<button class="adk-btn adk-skip">' + esc(TX.skip) + '</button>' +
          '</div></div>');
        document.body.appendChild(layer);
        var bar = layer.querySelector('.adk-bar i'), num = layer.querySelector('.adk-n'), done = false;
        bar.style.transition = 'transform ' + n + 's linear';
        requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.transform = 'scaleX(0)'; }); });
        var iv = setInterval(function () { n--; num.textContent = Math.max(0, n); if (n <= 0) go(); }, 1000);
        function stop() { clearInterval(iv); layer.remove(); }
        function go() {
          if (done) return; done = true; stop();
          levels = 0; lastInter = nowSec();
          raw('inter').then(function (r) { if (r !== 'rewarded' && r !== 'dismissed') explain(r); resolve(r === 'rewarded'); });
        }
        layer.querySelector('.adk-go').onclick = go;
        layer.querySelector('.adk-skip').onclick = function () { if (done) return; done = true; levels = 0; breaks = 0; stop(); resolve(false); };
      });
    },

    // Doğal mola (ör. oyun bitti ekranından menüye dönüş): uygunsa normal geçiş reklamı
    breakpoint: function () { return plainBreak(); }
  };
  window.AdKit = AdKit;

  // Reklam katmanı hazır olan oyunlar (Düğüm Ustası, Vızz) için köprüler: ham sonucu döndürür
  var bridge = { show: function () { return raw('rewarded'); } };
  window.KnotAdsBridge = window.KnotAdsBridge || bridge;
  window.VizzAdsBridge = window.VizzAdsBridge || bridge;
})();
