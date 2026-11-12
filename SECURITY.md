# Security

## Reporting a vulnerability

Please report it privately through **[GitHub → Security → Report a vulnerability](https://github.com/PierrickLozach/pdf-editor/security/advisories/new)**
(also linked from `/.well-known/security.txt` on the site). Do not open a public issue.

## How the site is built (what can and cannot go wrong)

- The site is **static files only** on Cloudflare: no server code, no database, no accounts, no cookies, no analytics.
- PDFs are opened, edited and saved **in the browser** (MuPDF compiled to WebAssembly, in a Web Worker). They are never uploaded.
- In Chrome and Edge, Save writes into the file the person opened (File System Access API, with the browser's own permission prompt);
  “Recent files” keeps references to those files in the browser, never copies. Elsewhere, Save downloads a copy.
- Accounts (passkeys) existed briefly and were removed. `web/legacy.js` lets anyone who saved PDFs then download them once;
  the old code is loaded only for them (`web/legacy/vault.js`), and their old storage is then deleted.

## OWASP Top 10:2025 review

| # | Risk | What protects this site | Tested by |
|---|---|---|---|
| A01 | Broken access control | No accounts and no server: nothing to access. The editor can only touch a file the person picked or dropped, through the browser's permission prompt. | `security.pw.mjs`, `files.pw.mjs` |
| A02 | Security misconfiguration | Every response (pages, files, 404s) has a strict Content-Security-Policy (no inline scripts or styles, no `eval`; the editor only adds WebAssembly), `frame-ancestors 'none'` + `X-Frame-Options: DENY`, HSTS (2 years), `nosniff`, COOP/CORP same-origin, Referrer-Policy, a restrictive Permissions-Policy. No directory listing. | `security.pw.mjs` (A02), `site.pw.mjs` (no CSP violation in Chromium, Firefox, WebKit) |
| A03 | Software supply chain | MuPDF and the text recogniser (tesseract.js 7.0.0 / core 6.1.2, Apache-2.0, with its language models) vendored at known versions and served by this site — the recogniser downloads nothing from elsewhere (no published advisories at the time of review); its files and the bundled fonts are pinned by SHA-256 in `tools/vendor.lock.json` and the build stops if one changes. Free fonts are fetched from exact, immutable npm versions only (2,072 families pinned), from one CDN folder allowed by the CSP, size- and format-checked. `npm audit`: 0 vulnerabilities. Dependabot watches the npm tooling. | `security.pw.mjs` (A03), `tools/vendor_lock.py` |
| A04 | Cryptographic failures | Nothing sensitive is stored: no accounts, no keys. The only document kept in the browser is the crash-recovery copy of the PDF being edited, removed by “Close”. All traffic is HTTPS (HSTS). | `security.pw.mjs` (A04) |
| A05 | Injection | No `eval`, no inline scripts; PDF-derived text (font names) and file names are inserted as text or escaped; the CSP blocks any injected script anyway. Tested with a PDF whose font is named `<img src=x onerror=…>`, HTML in file names, and an HTML file renamed `.pdf`. | `security.pw.mjs` (A05) |
| A06 | Insecure design | Least data by design (nothing on a server). Limits: 250 MB per PDF (largest size tested to open, edit and save in Chromium, Firefox and WebKit; explained before opening, with how to make a PDF smaller); 10 MB per downloaded font. | `security.pw.mjs` (A06), `files.pw.mjs` |
| A07 | Authentication failures | No authentication to attack (no accounts, no passwords). | `security.pw.mjs` |
| A08 | Software or data integrity | **Active content** in PDFs (JavaScript, launch actions, `javascript:`/`file:` links, form submission, attached files, XFA) is never run by the editor, is announced when a PDF has some, and is removed when saving unless the person chooses to keep it. Third-party files checked by hash at build time. | `security.pw.mjs` (A08) |
| A09 | Logging and alerting | By design nothing about users is logged (no server). Security reports: `security.txt` + GitHub private reporting. | – |
| A10 | Mishandling of exceptional conditions | Fails closed: a damaged PDF (broken page tree, deep nesting) or a decompression bomb (2.5 MB → 2.7 GB) is refused or handled without crashing, and the PDF already open keeps working. Oversized files, failed saves (written to a temporary file and swapped in only when complete) and engine errors give plain-language messages. | `security.pw.mjs` (A10), `files.pw.mjs` |

## Privacy of edited files

A PDF saved by the editor keeps the original's properties: title, author, subject, keywords, creator,
producer, creation and modification dates, XMP metadata, file ID and PDF version. The editor adds no
mention of itself and the engine's "Written by MuPDF" comment is blanked (`tests/untraced.test.mjs`).

## Tools that remove information

- **Redact** removes, for good, the text under each box, the pixels of pictures under it (the picture is rewritten) and the
  drawings it covers, then draws a black box. It is checked by extracting the text and the pictures of the saved file
  (`tests/tools.test.mjs`). **Whiteout** removes the text under it but only paints over pictures: use Redact for private data.
- **Protect** encrypts a copy with AES-256 (the owner password is random and never shown); the PDF open in the editor is not changed.
- **OCR** runs in the browser: the pages are never uploaded. The recognised text is invisible and only added on top.

## Developer library

`/lib/v1/` serves the library (code, WebAssembly engine, fonts) to other websites: it is the only part of the site
with `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`. These files are public and read-only;
they process documents in the calling page, which never sends them here.

## Visit statistics

The site counts visits itself (`site/worker/index.js`, Cloudflare D1), only on `/api/*`: daily totals of the page, the
referring domain, the country Cloudflare sees, the browser language, the device type, and editor events (PDF opened /
saved / created, its size range, tools used). No IP address, cookie, identifier, user agent, file name or time of day is
stored. Requests from other origins, bots, automated browsers, Do Not Track / Global Privacy Control and the privacy
page's opt-out are not counted; only known pages and events are accepted, with a cap on distinct values per day.
`/api/stats` answers 404 without the key (`wrangler secret put STATS_KEY`, compared in constant time).

## Limits (known and accepted)

- Anyone with access to the person's unlocked computer can open the files they can open; the browser's crash-recovery copy of the PDF
  being edited stays until “Close”.
- The free-font CDN (jsDelivr) sees the IP address and the name of a font when one is downloaded (never the document); it can be switched off.
- Static hosting cannot rate-limit or alert on its own; Cloudflare's network-level protections apply.

Run every check locally: `sh tests/run-all.sh` (editor, files, security) and `cd site && npm test` (site).
