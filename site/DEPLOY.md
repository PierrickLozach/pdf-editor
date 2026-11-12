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
