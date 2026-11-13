# PDF Editor

A PDF editor that runs entirely in the browser: change text in its original font, move it, find and replace,
white-out, add images and signatures, redact, OCR, split, merge, convert, compress, protect, rearrange pages.
PDFs never leave the device. Everyday editing is free; optional **Pro** features (batch processing, smart
redaction, unlimited OCR, comparing PDFs, forms) are sold through Lemon Squeezy.

Live: https://pdf-editor.pierrick35.workers.dev · Source: https://github.com/PierrickLozach/pdf-editor

- [What is where](#what-is-where)
- [Set up and deploy from scratch](#set-up-and-deploy-from-scratch)
- [Lemon Squeezy (selling Pro)](#lemon-squeezy-selling-pro)
- [Remaining steps before launch](#remaining-steps-before-launch)
- [Day-to-day](#day-to-day)
- [Licence](#licence) · [For developers](#for-developers)

---

## What is where

| Folder / file | What it is |
|---|---|
| `web/` | The editor: MuPDF compiled to WebAssembly and plain JavaScript, no build step. `app.js` is the interface, `engine.js` the PDF engine (runs in `worker.js`), `pro.js` / `protools.js` the Pro licence and features, `lib.js` the developer library. Translations: `web/i18n/<lang>.json`. |
| `site/` | The website around it, on Cloudflare Workers. `pages/<lang>/` landing and legal pages (12 languages), `i18n/<lang>.json` header and footer words, `site.json` name, publisher, business details, host. |
| `site/worker/` | The only server code, for `/api/*`: anonymous visit statistics (`index.js`), Pro licences (`pro.js`), the admin page (`admin.js`). Database tables: `schema.sql` (Cloudflare D1). |
| `site/wrangler.jsonc` | Cloudflare settings: static files, the Worker on `/api/*`, the D1 database. |
| `tools/` | `build_site.py` assembles `site/public`; `stamp.py` versions the editor's files; `check_i18n.py` checks translations; `vendor_lock.py` checks third-party files; `new_licence_key.mjs` makes a licence signing key. |
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

## Remaining steps before launch

In order. The site is online and works; the shop stays closed until step 4.

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
9. **Launch**: the Hacker News text is below. Post on one site per day and answer the comments.

**Hacker News** — title: `Show HN: A PDF editor that runs in the browser and edits text in its original font`
— first comment:

> I needed to fix dates and amounts in PDFs and didn't want to pay for Acrobat or upload documents to an
> online editor. This runs entirely in the browser (MuPDF compiled to WebAssembly): files are never uploaded.
>
> Editing text removes the original glyphs and writes the new text with the PDF's own embedded font when it
> has the letters, otherwise the closest match. It also does find & replace, redaction, OCR, split/merge,
> signatures and compression, plus a JavaScript library for developers.
>
> Limits: text is edited line by line (no paragraph reflow), and Word-to-PDF isn't supported. Everyday
> editing is free with no account; a Pro plan adds batch processing, automatic redaction, unlimited OCR, PDF
> comparison and forms. AGPL, in 12 languages. Feedback welcome, especially PDFs that break it.

---

## Day-to-day

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

**Every year:** renew the Lemon Squeezy API key (`LS_API_KEY`); `security.txt` is renewed by each build.

---

## Licence

Dual-licensed: **GNU AGPL v3** (free, see `LICENSE`) **or a commercial licence** negotiated with the author for
commercial use without the AGPL's obligations — see [`LICENSING.md`](LICENSING.md). The editor is built on
MuPDF © Artifex Software (AGPL; commercial licences from Artifex). A Pro licence is a licence to use the Pro
features on the official site, not a commercial licence of the code.

Third-party code shipped with the site: MuPDF.js (AGPL), tesseract.js and its language models (Apache-2.0),
fonts under open licences (Liberation, Carlito, Caladea, DejaVu, Dancing Script — see `web/vendor/` and `web/fonts/`).

## For developers

The engine is also a JavaScript library, for web pages and Node.js — documentation: https://pdf-editor.pierrick35.workers.dev/developers

```js
import { PDF } from "https://pdf-editor.pierrick35.workers.dev/lib/v1/pdf-editor.js";   // or: npm install github:PierrickLozach/pdf-editor
const pdf = await PDF.open(bytes);
await pdf.redact({ text: "Jane Doe" });
const out = await pdf.save();
```
