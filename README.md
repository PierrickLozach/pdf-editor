# PDF Editor

A PDF editor that runs entirely in the browser: change text in its original font, move it, find and replace,
white-out, add images and signatures, redact, OCR, split, merge, convert, compress, protect, rearrange pages.
PDFs never leave the device. It is free. **Pro** features (batch processing, smart redaction, unlimited OCR,
comparing PDFs, forms) are built and tested but **hidden** for the free launch: see [Showing Pro](#showing-pro-later).

Live: https://quicktou.ch · Source: https://github.com/PierrickLozach/pdf-editor

- [What is where](#what-is-where)
- [Set up and deploy from scratch](#set-up-and-deploy-from-scratch)
- [Lemon Squeezy (selling Pro)](#lemon-squeezy-selling-pro)
- [Launch (free)](#launch-free) · [Showing Pro later](#showing-pro-later)
- [Remaining steps before selling Pro](#remaining-steps-before-selling-pro)
- [Day-to-day](#day-to-day)
- [Licence](#licence) · [For developers](#for-developers)

---

## What is where

| Folder / file | What it is |
|---|---|
| `web/` | The editor: MuPDF compiled to WebAssembly and plain JavaScript, no build step. `app.js` is the interface, `engine.js` the PDF engine (runs in `worker.js`), `docs.js` Word and LibreOffice documents (the word processor [EdenText](https://github.com/stffnb/edentext), AGPL, by Steffen Becker, served unmodified from `/app/edentext/` and shown in place of the PDF pages, with the same Open, Save, Recent files and language menu; its AI assistant and dictation are off and the site's headers allow it no connection to another site), `pro.js` / `protools.js` the Pro licence and features, `lib.js` the developer library. Translations: `web/i18n/<lang>.json`. |
| `site/` | The website around it, on Cloudflare Workers. `pages/<lang>/` landing and legal pages (12 languages), `i18n/<lang>.json` header and footer words, `site.json` name, publisher, business details, host. |
| `site/worker/` | The only server code, for `/api/*`: anonymous visit statistics (`index.js`), Pro licences (`pro.js`), the admin page (`admin.js`). Database tables: `schema.sql` (Cloudflare D1). |
| `site/wrangler.jsonc` | Cloudflare settings: static files, the Worker on `/api/*`, the D1 database. |
| `tools/` | `build_site.py` assembles `site/public`; `stamp.py` versions the editor's files; `check_i18n.py` checks translations; `vendor_lock.py` checks third-party files; `vendor_edentext.py` downloads EdenText (pinned version, SHA-512 checked on every build, cached in `vendor/`, not in git); `new_licence_key.mjs` makes a licence signing key. |
| `tests/` | Engine tests (`*.test.mjs`, Node) and browser tests (`tests/pw/*.pw.mjs`, Playwright: Chromium, Firefox, WebKit). `tests/run-all.sh` runs everything. |
| `site/DEPLOY.md` | Shorter reference for deployment, languages and the admin page. |

**Private, never in git:** `site/.dev.vars` (keys for local tests). **On your Desktop:** `PDF Editor - admin link.txt`
(admin page link + backup of the licence signing key) and `PDF Editor - statistics link.txt`. Keep both private.

---

## Set up and deploy from scratch

What it took to put the site online, in order. Steps 1–4 are once per computer; 5–8 once per Cloudflare account.

**1. Tools on the computer**
- Node.js 20 or later (`node --version`; v24 used here) and Python 3.10 or later (`python3 --version`).
- On a work computer whose `npm` points to a company registry, add `--registry https://registry.npmjs.org`
  to `npm install`. If `NODE_ENV=production` is set globally, `npm install` skips dev packages: Wrangler is
  therefore a normal dependency of `site/`.

**2. Get the code**
```sh
git clone https://github.com/PierrickLozach/pdf-editor.git
cd pdf-editor
cd site && npm install && cd ..            # Wrangler, Cloudflare's tool
cd tests/pw && npm install && npx playwright install && cd ../..   # only to run the browser tests
```

**3. Try it locally** (no Cloudflare account needed)
```sh
python3 tools/serve.py 8766                # the editor alone: http://127.0.0.1:8766
cd site && npm run dev                     # the whole site with /api: http://localhost:8787
```

**4. Cloudflare account** — free plan is enough. Create it at https://dash.cloudflare.com, with your **real
name and postal address** in the profile: the legal notice relies on the host knowing who the publisher is.
Then, once per computer:
```sh
cd site && npx wrangler login              # a browser window opens: click Allow
```

**5. The database** (visit statistics, Pro settings, free licences)
```sh
cd site
npx wrangler d1 create pdf-editor-stats    # prints a database_id
```
Put that `database_id` in `site/wrangler.jsonc` (`d1_databases`), then create the tables:
```sh
npx wrangler d1 execute pdf-editor-stats --remote --file worker/schema.sql
```

**6. The secrets** (stored on Cloudflare, never in the code)
```sh
node ../tools/new_licence_key.mjs          # makes a licence signing key pair
```
- Paste the **public** key into `web/pro.js` (`PUBLIC_KEY`).
- Store the **private** key: `npx wrangler secret put LICENCE_KEY` (paste the JSON). Keep a copy somewhere
  safe: changing it later cancels every licence in use.
- `npx wrangler secret put ADMIN_KEY` — a random text of at least 24 characters (opens the admin page).
- `npx wrangler secret put STATS_KEY` — a random text of at least 16 characters (opens the statistics page).
- `npx wrangler secret put LS_API_KEY` — later, see [Lemon Squeezy](#lemon-squeezy-selling-pro).

For local tests, the same names go into `site/.dev.vars` (one `NAME=value` per line; it is git-ignored).

**7. Site settings** — `site/site.json`: site name, `url`, `publisher` (name, contact email), `host`
(Cloudflare's address, shown on the legal notice), `business` (leave `registered: false` until you register).

**8. Build and deploy**
```sh
cd site
npm run deploy                             # = python3 ../tools/build_site.py && wrangler deploy
```
The site is at `https://pdf-editor.<your-subdomain>.workers.dev`. The build checks the third-party files and
reminds you of missing details (for example a placeholder email).

**9. GitHub** (public, AGPL)
- The repository is `PierrickLozach/pdf-editor`, pushed with the personal account (not a work account).
- In the repository settings, turn on: Private vulnerability reporting, Dependabot alerts and security
  updates, Secret scanning with push protection.
- Before each push, check that no personal data or secret is in the commit (see [Day-to-day](#day-to-day)).

---

## Lemon Squeezy (selling Pro)

Lemon Squeezy is the **merchant of record**: it sells the licence to the customer, takes the payment,
collects and pays the VAT, issues invoices and handles refunds. The site only checks licence keys.
Their dashboard changes over time: menu names below may differ slightly.

**Before you start:** register your business first (see [Remaining steps](#remaining-steps-before-launch)):
Lemon Squeezy asks for your identity, tax details and a bank account to pay you, and reviews each store.

**1. Account and store**
1. Sign up at https://app.lemonsqueezy.com/register and create a store (name, currency **EUR**).
2. Fill in the store's business details and payout method (bank account), then submit the store for
   **activation** (they review the product and the website: the terms of sale and privacy pages must be
   reachable — they are, in the site footer). Until it is approved, you can work in **Test mode**.

**2. The product** — Products › **New product** › "PDF Editor Pro", a short description, then create
**3 variants**:

| Variant | Pricing | Licence key setting |
|---|---|---|
| Monthly | Subscription, every 1 month, e.g. 4 € | Generate license keys: **on**, activation limit **1**, length: follows the subscription |
| Yearly | Subscription, every 1 year, e.g. 29 € | Generate license keys: **on**, activation limit **1**, length: follows the subscription |
| Lifetime | Single payment, e.g. 59 € | Generate license keys: **on**, activation limit **1**, length: **unlimited** |

- "Activation limit 1" is what makes a licence work on one computer at a time; the site releases a computer
  when the customer clicks "Release this computer".
- Set the price **including VAT** ("tax inclusive"), so the price shown on the site is the price paid.
- The confirmation e-mail must show the licence key (it does by default when licence keys are on).

**3. Checkout settings**
- Link the terms of sale: `https://<your-site>/sales` (English) — the French version is binding:
  `https://<your-site>/fr/sales`.
- For EU customers, the checkout must collect the consent to immediate supply of digital content and the loss
  of the right of withdrawal (French Consumer Code L221-28, 13°). Check that it is enabled in the checkout /
  store settings; if Lemon Squeezy shows it as standard text, keep it.
- Optional: a "thank you" message telling buyers to open the editor, Tools › PDF Editor Pro, and paste their key.

**4. Collect the numbers**
- **Store ID**: Settings › Stores (the number of your store).
- For each variant: its **checkout link** (Share › "Checkout URL", like `https://<store>.lemonsqueezy.com/buy/…`)
  and its **variant ID** (in the variant's URL or the API).
- **API key**: Settings › API › create a key (valid one year: renew it), then on the computer:
  `cd site && npx wrangler secret put LS_API_KEY` (used only to create discount codes from the admin page).

**5. Enter them on the admin page** (link in `PDF Editor - admin link.txt` on the Desktop)
- Store ID, and for each plan: price shown, checkout link, variant ID. Currency EUR.
- Keep the prices identical to Lemon Squeezy's: the site shows them, Lemon Squeezy charges them.
- The **lifetime** checkbox shows or hides the lifetime plan for new buyers. When you turn it off, also
  unpublish (or archive) the Lifetime variant in Lemon Squeezy so old links stop selling it. Lifetime
  licences already sold keep working.

**6. Test before opening**
1. In Lemon Squeezy **Test mode**, buy each plan with a test card (they list test card numbers in their docs).
2. Paste the test key in the editor (Tools › PDF Editor Pro): Pro activates.
3. On a second browser, the same key is refused ("already used on another computer"); "Release this computer"
   on the first one frees it.
4. Cancel a test subscription in Lemon Squeezy: after its end date, the editor switches Pro off at its next
   check (within 10 days).
5. Make a 100% discount code from the admin page and use it at checkout.

**7. Open the shop** — only after the business details are on the site (the admin page refuses before):
tick **Shop open** on the admin page and save. The "Buy" buttons and prices appear on the site within a minute.

**Afterwards:** refunds, cancellations, invoices, customers and payouts are all in the Lemon Squeezy
dashboard. Free licences (codes `PDFE-…`) and discount codes for specific people are on the admin page.

---

## Ads (Google AdSense)

One ad, on the home page only, to cover the site's costs. The editor never shows ads and never loads anything
from Google. It is switched on in two steps, in `site/site.json`:

```json
"ads": { "client": "ca-pub-8712505359897234", "slot": "", "consent": "google" }
```

- **Publisher id only** (`client` set, `slot` empty) — the current state: the site serves `ads.txt` and a
  `<meta name="google-adsense-account">` tag so AdSense can verify the site. Nothing is loaded from Google, no
  cookie, no banner, and the pages keep their "no cookies, no tracking" wording.
- **Publisher id and ad slot**: the ad is served. The build switches every page in the 12 languages (privacy,
  cookies, home page) to the wording that describes the ad and the chosen consent banner, adds the "Cookie
  settings" footer link, and opens the site pages' security policy to Google's ad servers (the editor keeps its own).

**Consent banner** (`ads.consent`):
- `"google"` (chosen): Google's own free consent message, certified under the IAB TCF — required since January 2024
  for Google to serve ads in the EEA, the UK and Switzerland. Google's script loads on the home page (only there)
  to show it, before the visitor chooses; visitors who refuse may still see a limited ad without cookies. "Cookie
  settings" in the footer reopens Google's message (from other pages it leads to the home page, where it lives).
- `"open-source"`: the vendored [cookieconsent](https://github.com/orestbida/cookieconsent) banner (MIT). Nothing from
  Google is requested before the visitor clicks Accept, but Google serves few or no ads in Europe with it.

**Steps**

1. **AdSense account** with your personal Google account; add the site `quicktou.ch`. *(done)*
2. **Verify the site**: Sites › quicktou.ch › choose "ads.txt snippet" or "Meta tag" › Verify. Both are already
   live. Do not paste Google's `<script>` into the pages — the site loads it itself.
3. **Wait for Google's review**: a few days to a few weeks. It can be refused for "low-value content"; the landing
   page, FAQ and legal pages help.
4. **Publish Google's consent message — before the ad goes live**: Privacy & messaging › European regulations ›
   Create message › site quicktou.ch, languages (English plus the site's languages), buttons "Consent", "Manage
   options" and "Do not consent" › Publish. Optional: the US state regulations message.
5. **Create one ad unit**: Ads › By ad unit › Display ads, responsive. Send its `data-ad-slot` number (or put it in
   `ads.slot`) and deploy: `cd site && npm run deploy`.
6. **Check** in a private window: Google's message, the ad box labelled "Advertisement · it covers this site's
   costs", and "Cookie settings" in the footer.
7. **Payments**: Google pays once the balance reaches about €70. Advertising income is taxable; regular income
   means registering the activity (see "Remaining steps before selling Pro").

Test without a real account: `cd tests/pw && node ads.pw.mjs all` (both banners, and the verification-only step;
builds with a test id, stubs Google, then rebuilds the site as configured).

## Launch: announcements

Before posting anything:

1. **Domain active** and a real contact address in `publisher.email` (the pages still show contact@example.com).
2. **Your employer's agreement**, if your contract requires one for side projects.
3. **Read each site's rules the day you post**: they change, and several communities remove self-promotion.
4. **One site per day**, so you can answer every comment in the first hours. Have the statistics page open.
5. **Say who you are**: "I built this". Never ask for upvotes, never post from several accounts.

The ads line is the same everywhere: one ad on the home page, shown only if you accept cookies, to cover the
costs; the editor has no ads and files never leave the device. If ads are not switched on yet when you post,
remove that sentence.

### Day 0 — Hacker News (Show HN)

- Where: <https://news.ycombinator.com/submit>. An account with a little history helps; a brand-new account's
  Show HN is more likely to be flagged.
- When: Tuesday to Thursday, 14:00–16:00 Paris time (morning in the US).
- How: title + URL `https://quicktou.ch`, then post the text below **as the first comment** right away.
- Rules: <https://news.ycombinator.com/showhn.html> (it must be something people can try now, without sign-up).

Title: `Show HN: A PDF editor that runs in the browser and edits text in its original font`

> I needed to fix dates and amounts in PDFs and didn't want to pay for Acrobat or upload documents to an
> online editor. This runs entirely in the browser (MuPDF compiled to WebAssembly): files are never uploaded.
>
> Editing text removes the original glyphs and writes the new text with the PDF's own embedded font when it
> has the letters, otherwise the closest match. It also does find & replace, redaction, OCR, split/merge,
> signatures, compression, Markdown/EPUB export, plus a JavaScript library for developers.
>
> Limits: text is edited line by line (no paragraph reflow), and Word-to-PDF isn't supported. Free, no account,
> AGPL, in 12 languages. There is one ad on the home page, only if you accept cookies, just to cover the costs;
> the editor itself has no ads. Feedback welcome, especially PDFs that break it.

Expect: "how is this different from Sejda / Stirling-PDF?" (free, in the browser, nothing installed, no upload,
no usage limit, open source), "why ads on a privacy tool?" (only on the home page, only after consent, editor
untouched, it covers the domain), MuPDF licensing (AGPL, source published).

### Day 1 — Reddit r/SideProject

- Where: <https://www.reddit.com/r/SideProject/submit>. Text post with the link; add a GIF of a text edit.

Title: `I built a free PDF editor that changes existing text in its original font, without uploading your file`

> Most free PDF editors either upload your file or paste a white box over the old text. This one runs entirely
> in your browser (MuPDF in WebAssembly): it removes the original text and rewrites it with the PDF's own font.
> Also: find & replace, redaction, OCR, split/merge, sign, compress, Markdown/EPUB export. No account, 12
> languages, open source (AGPL). One ad on the home page, only if you accept cookies, covers the costs; the
> editor has none. https://quicktou.ch — I'd love PDFs that break it.

### Day 1 — Reddit r/opensource

- Where: <https://www.reddit.com/r/opensource/submit>. Lead with the code.

Title: `Open-source (AGPL) in-browser PDF editor built on MuPDF/WebAssembly`

> Source: https://github.com/PierrickLozach/pdf-editor — live: https://quicktou.ch
> Text edits keep the PDF's embedded font (it reads the PDF's own glyph tables), everything runs client-side,
> and there's a JS library (`npm install github:PierrickLozach/pdf-editor`). Feedback on the code welcome.
> (The home page has one consented ad to cover the costs; the editor has none.)

### Day 2 — Journal du Hacker (French)

- Where: <https://www.journalduhacker.net> — submit a link (account required, often by invitation).

Titre : `Un éditeur PDF libre qui tourne dans le navigateur et modifie le texte dans sa police d'origine`

> Ouvrez un PDF, cliquez sur un texte, tapez : l'ancien texte est retiré et le nouveau écrit avec la police du PDF.
> Tout se passe dans le navigateur (MuPDF en WebAssembly), aucun fichier n'est envoyé. Libre (AGPL), sans
> compte, en 12 langues. Une seule publicité, sur la page d'accueil et seulement si vous acceptez les cookies,
> sert à couvrir les frais ; l'éditeur n'en a aucune.

### Day 2 — LinuxFr.org (French, "journal")

- Where: <https://linuxfr.org> › Écrire un journal (account required). A journal is a personal post; keep the tone
  factual, mention the licence and the code first.

Titre : `Un éditeur PDF libre (AGPL) dans le navigateur`

> Bonjour,
>
> J'avais besoin de corriger des dates et des montants dans des PDF sans payer Acrobat ni envoyer mes documents
> à un service en ligne. J'ai donc écrit un éditeur qui tourne entièrement dans le navigateur, basé sur MuPDF
> compilé en WebAssembly : https://quicktou.ch (code : https://github.com/PierrickLozach/pdf-editor, AGPL).
>
> Ce qu'il fait : modifier le texte existant dans la police d'origine du PDF, rechercher-remplacer, caviarder,
> OCR (tesseract.js), découper, fusionner, signer, compresser, exporter en Markdown ou EPUB. Les fichiers ne
> quittent jamais la machine. Limites : le texte se modifie ligne par ligne, pas de conversion Word vers PDF.
>
> Transparence : la page d'accueil affiche une seule publicité, uniquement si vous acceptez les cookies, pour
> couvrir les frais ; l'éditeur n'en a aucune. Les retours sont bienvenus, surtout les PDF qui le mettent en échec.

### Day 3 — Product Hunt

- Where: <https://www.producthunt.com/posts/new>. Prepare beforehand: logo (240×240), 3 screenshots
  (start screen, a text edit, the Tools menu), a 30-second video, and launch at 00:01 Pacific time (09:01 Paris).
- Name: `quicktou.ch` · Tagline (60 characters max): `Edit PDF text in its original font, right in your browser`
- Description (260 characters max):

> Click any text in a PDF and change it: the editor rewrites it in the PDF's own font. Redact, OCR, sign, split,
> compress, export to Markdown or EPUB. Everything runs in your browser — your files are never uploaded. Free,
> open source, 12 languages.

- First comment (maker): the Hacker News text above, shortened, ending with "one consented ad on the home page
  covers the costs; the editor has none".

### Day 4 — Reddit r/privacy and r/webdev

- **r/privacy** (<https://www.reddit.com/r/privacy>): self-promotion is often removed; read the rules, and if
  allowed, post the privacy angle only: "a PDF editor that never uploads your file", how to check it (open the
  browser's network tab while editing), the ad disclosed in the first lines.
- **r/webdev** (<https://www.reddit.com/r/webdev>): self-promotion only on **Showoff Saturday**. Technical angle:
  MuPDF in a Web Worker, glyph-level font matching, strict Content Security Policy, tests in three browser engines.

### Week 2 — long-term listings and write-ups

- **AlternativeTo** (<https://alternativeto.net>): add the app as an alternative to Adobe Acrobat, Smallpdf,
  Sejda, iLovePDF. Licence: open source; platforms: online, any browser; tags: pdf-editor, privacy, ocr, redact.
  Description: the Product Hunt description above.
- **DEV.to / Indie Hackers**: one article, "How I edit PDF text in its original font in the browser" (reading the
  PDF's ToUnicode and widths tables, falling back font by font, testing on real PDFs). Link to the site at the end.
- **LinkedIn** (personal account): a short post with the GIF and the link.

### After each post

- Answer comments for the first 3–4 hours; fix reported bugs quickly and say so in the thread.
- Note in the statistics page which source brought visitors (`?utm_source=hn`, `?utm_source=reddit`… in links you
  share outside the main post).

## Showing Pro later

- **Try it yourself first**: in your browser's console on the editor, `localStorage.setItem("pdfe.proPreview", "1")`,
  then reload: Pro appears in that browser only (the shop stays closed; a free licence code from the admin page
  activates it). `localStorage.removeItem("pdfe.proPreview")` hides it again.
- **Show it to everyone**: `site/site.json` → `"pro": {"visible": true}`, then `cd site && npm run deploy`. The
  landing page, FAQ, privacy, terms and legal notice switch to their Pro versions (marked `<!-- pro:on -->` /
  `<!-- pro:off -->` in `site/pages/`), the terms of sale page and its footer link come back.
- **Selling** still needs the steps below; the admin page refuses to open the shop before the business details exist.

## Remaining steps before selling Pro

In order. The shop stays closed until step 4.

1. **Register a business** (for example a French micro-entreprise, free, online at
   https://formalites.entreprises.gouv.fr). You receive a SIRET number. Selling regularly without it is not
   allowed; an accountant can confirm the best status in an hour.
2. **Choose a consumer mediator** (mandatory for selling to consumers in France; a few tens of euros a year,
   for example CM2C or Medicys) and note its name, address and website.
3. **Put the business details on the site**: in `site/site.json`, `business`:
   `"registered": true`, `name`, `status` (e.g. "Entrepreneur individuel (EI)"), `siret`, `address`
   (a business domiciliation address keeps your home private), `email` (a dedicated address),
   `mediator`, `mediator_url`, `vat` (micro-entreprise: "TVA non applicable, art. 293 B du CGI").
   Also replace `publisher.email` (still `contact@example.com`). Then `cd site && npm run deploy`:
   the legal notice switches to the professional version and the terms of sale lose the "not on sale yet" note.
4. **Have a lawyer review the terms of sale** (`site/pages/fr/sales.html` is the binding version) and the
   privacy page, before the first sale.
5. **Set up Lemon Squeezy** — all of the section above — then open the shop.
6. **Domain** (optional but recommended before advertising): buy it (Cloudflare › Domain Registration),
   attach it (Workers & Pages › pdf-editor › Settings › Domains & Routes › Custom domain), put it in
   `site/site.json` (`url`) and in `README.md`, redeploy. Then a contact address on that domain
   (Cloudflare Email Routing, free) for `publisher.email` and `business.email`. Changing the address later
   loses visitors' saved settings and breaks developers' links to the library: do it before launch.
   Check the name is not a registered trademark (INPI, EUIPO).
7. **Trademark** (optional): registering the name at INPI (about 190 € for one class) stops copies of the
   AGPL code from using it — the main protection for the official site, since the code is public.
8. **Native-speaker check** of the translations, especially the terms of sale in Arabic, Hebrew, Chinese and
   Japanese, and the words flagged in the commit history ("merchant of record", "lifetime", "goodwill",
   "social security number", "Release this computer").
9. **Show Pro** (above), then open the shop.

---

## Day-to-day

**Demo GIF** (for the announcements; fictional invoice): with the local server running,
`cd tests/pw && node demo-gif.mjs && cd ../.. && python3 tools/make_gif.py /tmp/demo-frames ~/Desktop/quicktou-demo.gif 960 12`
(a 22-second GIF, about 0.4 MB, plus a still `.png` next to it).

**Change and deploy**
```sh
python3 tools/stamp.py                     # after changing files in web/ (new version numbers, no stale cache)
python3 tools/check_i18n.py                # after changing texts: every language must match
cd site && npm run deploy
```
If `wrangler deploy` seems stuck in a script, run it in a terminal window (it may be waiting for an answer).

**Test**
```sh
sh tests/run-all.sh                        # everything (about 10 minutes)
```
The Pro browser test needs the local site and a fake Lemon Squeezy running:
`cd site && npx wrangler dev --port 8787` and `cd tests/pw && node mock-ls.mjs`, with
`LS_API=http://127.0.0.1:8798` and `LS_API_KEY=test-key` in `site/.dev.vars`. Test runs are never counted in
the statistics. Most tests run against the live site too: `node tests/pw/<name>.pw.mjs all https://<site>/app/`.

**Before each GitHub push** — no personal data, no secret:
```sh
git add -A && git diff --cached --name-only | xargs grep -lIiE "your-name|your-street|your-email@|/Users/you" 
```
(adapt the words), and never commit `site/.dev.vars`, keys or the Desktop files.

**Admin page** (prices, lifetime offer, shop open/closed, free licences, discounts):
`https://<site>/api/admin?key=…` — the link is in `PDF Editor - admin link.txt`.
**Statistics:** `https://<site>/api/stats?key=…` — the link is in `PDF Editor - statistics link.txt`.
Both answer "not found" without the key. To change a key: `npx wrangler secret put ADMIN_KEY` (or `STATS_KEY`).

**Upgrade EdenText** (Word and LibreOffice documents): in `tools/vendor_edentext.py` set `VERSION` and `INTEGRITY` (`npm view @edentext/app@<version> dist.integrity`), build, then `cd tests/pw && node docs.pw.mjs` with the local site running. Read EdenText's changelog first: a new setting that sends data elsewhere must stay off. Arabic comes with the release after 0.15.0: then add `ar: "ar"` to `LOCALES` in `web/docs.js`.

**Every year:** renew the Lemon Squeezy API key (`LS_API_KEY`); `security.txt` is renewed by each build.

---

## Licence

Dual-licensed: **GNU AGPL v3** (free, see `LICENSE`) **or a commercial licence** negotiated with the author for
commercial use without the AGPL's obligations — see [`LICENSING.md`](LICENSING.md). The editor is built on
MuPDF © Artifex Software (AGPL; commercial licences from Artifex). A Pro licence is a licence to use the Pro
features on the official site, not a commercial licence of the code.

Word and LibreOffice documents are edited with EdenText © Steffen Becker (`/app/edentext/`), served unmodified under its own licence (GNU AGPL v3 with an attribution term: its “Powered by EdenText” notice and logo stay visible); it is not covered by this project's commercial licence. Source: https://github.com/stffnb/edentext (the version in `tools/vendor_edentext.py`).

Third-party code shipped with the site: MuPDF.js (AGPL), tesseract.js and its language models (Apache-2.0),
fonts under open licences (Liberation, Carlito, Caladea, DejaVu, Dancing Script — see `web/vendor/` and `web/fonts/`).

## For developers

The engine is also a JavaScript library, for web pages and Node.js — documentation: https://quicktou.ch/developers

```js
import { PDF } from "https://quicktou.ch/lib/v1/pdf-editor.js";   // or: npm install github:PierrickLozach/pdf-editor
const pdf = await PDF.open(bytes);
await pdf.redact({ text: "Jane Doe" });
const out = await pdf.save();
```
