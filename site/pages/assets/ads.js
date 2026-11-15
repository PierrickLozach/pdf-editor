/* Ads, only with consent (site pages only; the editor never loads this).
 * data-client: the AdSense publisher id (ca-pub-…); data-mode: "open-source" (the cookieconsent banner, vendored,
 * MIT) or "google" (Google's own certified consent message, set up in AdSense › Privacy & messaging).
 * Open-source mode: nothing from Google is requested before the visitor accepts "Advertising"; the banner is shown
 * on pages that carry an ad (the home page); "Cookie settings" in the footer reopens the choice on every page. */
(() => {
  const me = document.currentScript, client = me.dataset.client, mode = me.dataset.mode || "open-source";
  const lang = document.documentElement.lang || "en", hasAd = !!document.querySelector("ins.adsbygoogle");
  let loaded = false;
  function loadAds() {
    if (loaded || !hasAd) return;
    loaded = true;
    const s = document.createElement("script");
    s.async = true; s.crossOrigin = "anonymous";
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(client);
    document.head.appendChild(s);
    document.querySelectorAll("ins.adsbygoogle").forEach(() => (window.adsbygoogle = window.adsbygoogle || []).push({}));
    document.documentElement.classList.add("ads-on");
  }
  const settings = document.getElementById("ccSettings");

  if (mode === "google") {                                  // Google's certified message asks for consent itself
    loadAds();
    if (settings) settings.addEventListener("click", (e) => {
      e.preventDefault();
      window.googlefc = window.googlefc || {}; window.googlefc.callbackQueue = window.googlefc.callbackQueue || [];
      window.googlefc.callbackQueue.push(() => window.googlefc.showRevocationMessage());
    });
    return;
  }

  fetch(`/assets/consent/${lang}.json`).then((r) => r.json()).then((t) => {
    const CC = window.CookieConsent;
    if (!CC) return;
    CC.run({
      revision: 1,
      autoShow: hasAd,                                      // asked where an ad would show; elsewhere only via the footer link
      cookie: { name: "cc_cookie", expiresAfterDays: 182, sameSite: "Lax" },
      guiOptions: {
        consentModal: { layout: "box", position: "bottom right", equalWeightButtons: true, flipButtons: false },
        preferencesModal: { layout: "box", equalWeightButtons: true, flipButtons: false },
      },
      categories: {
        necessary: { enabled: true, readOnly: true },
        ads: { enabled: false, autoClear: { cookies: [{ name: /^__g/ }, { name: /^__eoi/ }] } },
      },
      onConsent: () => { if (CC.acceptedCategory("ads")) loadAds(); },
      onChange: () => { if (CC.acceptedCategory("ads")) loadAds(); else if (loaded) location.reload(); },   // withdrawn: reload without Google
      language: {
        default: lang, rtl: ["ar", "he"],
        translations: { [lang]: {
          consentModal: { title: t.b_title, description: t.b_desc, acceptAllBtn: t.b_accept, acceptNecessaryBtn: t.b_reject, showPreferencesBtn: t.b_prefs },
          preferencesModal: {
            title: t.p_title, acceptAllBtn: t.b_accept, acceptNecessaryBtn: t.b_reject, savePreferencesBtn: t.p_save, closeIconLabel: t.p_close,
            sections: [
              { description: t.p_intro },
              { title: t.nec_title, description: t.nec_desc, linkedCategory: "necessary" },
              { title: t.ads_title, description: t.ads_desc, linkedCategory: "ads" },
            ],
          },
        } },
      },
    });
    if (settings) settings.addEventListener("click", (e) => { e.preventDefault(); CC.showPreferences(); });
  }).catch(() => {});                                       // no banner: nothing from Google is loaded either
})();
