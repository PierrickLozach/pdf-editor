# Putting PDF Editor online (free) and attaching a domain

The site is **only static files**: no server code, no database, no accounts, no cookies.
It is hosted on Cloudflare's free plan (static files are free and unlimited there).

## Update the site

```sh
cd site
npm run deploy          # builds the site and uploads it
```

The first time on a computer: `npx wrangler login` (a browser window opens: click **Allow**).

## Attach a domain

1. Buy it, ideally at Cloudflare (Dashboard › **Domain Registration** › Register Domains): at cost, no markup.
   A domain bought elsewhere: in Cloudflare **Add a domain** (free plan), then at your registrar replace
   the two *nameservers* with the two Cloudflare gives you, and wait until it shows *Active*.
2. Dashboard › **Workers & Pages** › **pdf-editor** › **Settings** › **Domains & Routes** › **Add** ›
   **Custom domain**: type the domain (e.g. `example.com`), then the same with `www.`.
   Cloudflare creates the DNS records and the HTTPS certificate by itself.
3. Put the address in `site/site.json` (`"url"`), then `npm run deploy` again
   (links, sitemap and social previews use it).

## Before going live

`site/site.json`: `publisher.name` is shown on the legal notice and terms pages, `publisher.email` is the contact on the terms, privacy and developer pages. As a non-professional publisher, the legal notice gives only the host's details (French LCEN): make sure the host (your Cloudflare account) has your real name and postal address. If the site becomes a business, a full professional address is required. The build reminds you while the email is a placeholder.

## Visit statistics

Anonymous daily totals, kept in the D1 database `pdf-editor-stats` (free plan: 100,000 counts a day). The table is
created with `wrangler d1 execute pdf-editor-stats --remote --file worker/schema.sql`. The statistics page is
`/api/stats?key=…` (JSON: `/api/stats.json?days=30&key=…`); set or change its key with `wrangler secret put STATS_KEY`.
If the free daily limit is ever reached, only counting stops: the site keeps working.

## Pro (paid features)

Pro is sold through **Lemon Squeezy** (merchant of record: it takes payments, VAT, invoices, refunds). The shop
**stays closed** until the business details are filled in: the admin page refuses to open it otherwise.

**Secrets** (never in the code; set once on Cloudflare with `./node_modules/.bin/wrangler secret put NAME`):
- `LICENCE_KEY` – the private key that signs licences (JSON, made by `tools/new_licence_key.mjs`; its public half
  is in `web/pro.js`). Changing it invalidates every licence in use: keep it.
- `ADMIN_KEY` – opens the admin page `/api/admin?key=…` (at least 24 characters).
- `LS_API_KEY` – a Lemon Squeezy API key (Settings › API), used for discount codes.

**Lemon Squeezy setup**: create a store and one product "PDF Editor Pro" with 3 variants (monthly subscription,
yearly subscription, lifetime single payment). On each variant, turn on **License keys** with **activation limit 1**
(and "license length" = the subscription for monthly/yearly, unlimited for lifetime). In the checkout, enable the
customer's consent to immediate supply (loss of the right of withdrawal) and link the terms of sale page.

**Admin page** (`/api/admin?key=…`): prices shown, checkout link and variant ID of each plan, store ID, the lifetime
offer (on/off for new buyers), the OCR pages allowed without Pro, opening the shop, free licences (codes PDFE-…,
with duration and number of computers; cancel, release their computers), discount codes (created in your store).

**Opening the shop**: in `site/site.json` fill `business` (registered: true, name, SIRET, address, email, consumer
mediator), rebuild and deploy; the legal notice switches to the professional version by itself. Then tick "Shop
open" on the admin page.

## Languages

The site and the editor are in English, French, Spanish, Portuguese (Brazil), German, Dutch, Italian,
Polish, Arabic, Hebrew, Simplified Chinese and Japanese. Arabic and Hebrew are right to left.
Visitors get their browser's language; a language they pick in the menu is remembered, and
“Browser language” in that menu goes back to automatic. English is at `/`, the others at `/<code>/`.

To add a language (right-to-left ones included):
1. `web/i18n/languages.json` and the list at the top of `web/i18n.js`: code, native name, `ltr` or `rtl`
2. `web/i18n/<code>.json` — the editor's texts (same keys as `fr.json`)
3. `site/i18n/<code>.json` — the header and footer words (`"dir": "rtl"` for right-to-left)
4. `site/pages/<code>/` — a translated copy of `site/pages/en/`
5. add the code to `"languages"` in `site/site.json`
6. `python3 tools/check_i18n.py <code>` checks that nothing is missing or broken

## Test locally

```sh
cd site
npm run dev             # http://127.0.0.1:8787
npm test                # browsers: Chromium, Firefox, WebKit
```
