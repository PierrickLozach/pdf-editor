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

`site/site.json`: `publisher.address` and `publisher.email` are shown on the legal notice page
(required in France). The build reminds you while they are empty.

## Languages

English is at `/`, French at `/fr/`. To add a language (right-to-left ones included):
1. `site/pages/<code>/` — a translated copy of `site/pages/en/`
2. `site/i18n/<code>.json` — the header and footer words (`"dir": "rtl"` for Arabic, Hebrew…)
3. `web/i18n/<code>.json` — the editor's texts (same keys as `fr.json`), and one line in `web/i18n.js`
4. add the code to `"languages"` in `site/site.json`

## Test locally

```sh
cd site
npm run dev             # http://127.0.0.1:8787
npm test                # browsers: Chromium, Firefox, WebKit
```
