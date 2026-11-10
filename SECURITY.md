# Security

## Reporting a vulnerability

Please report it privately through **[GitHub → Security → Report a vulnerability](https://github.com/PierrickLozach/pdf-editor/security/advisories/new)**
(also linked from `/.well-known/security.txt` on the site). Do not open a public issue.

## How the site is built (what can and cannot go wrong)

- The site is **static files only** on Cloudflare: no server code, no database, no cookies, no analytics.
- PDFs are opened, edited and saved **in the browser** (MuPDF compiled to WebAssembly, in a Web Worker). They are never uploaded.
- Accounts exist **only in the browser**: a passkey (WebAuthn, user verification required) and files encrypted with AES-256-GCM.
  - Passkeys with the PRF extension: the encryption key is wrapped (AES-KW, HKDF-SHA-256) with a secret only the passkey can produce.
  - Passkeys without PRF (some password-manager extensions): a non-extractable key kept by the browser, released only after a passkey
    sign-in whose signature, origin, challenge, user-verification flag and counter are verified against the public key saved at creation.

## OWASP Top 10:2025 review

| # | Risk | What protects this site | Tested by |
|---|---|---|---|
| A01 | Broken access control | Each file is bound to its account (checked on every read, write and delete, and in the encryption's associated data); one account cannot open another's files. No server, so no server-side access to bypass. | `account.pw.mjs` |
| A02 | Security misconfiguration | Every response (pages, files, 404s) has a strict Content-Security-Policy (no inline scripts or styles, no `eval`; the editor only adds WebAssembly), `frame-ancestors 'none'` + `X-Frame-Options: DENY`, HSTS (2 years), `nosniff`, COOP/CORP same-origin, Referrer-Policy, a restrictive Permissions-Policy. No directory listing. | `security.pw.mjs` (A02), `site.pw.mjs` (no CSP violation in Chromium, Firefox, WebKit) |
| A03 | Software supply chain | MuPDF vendored at a known version (no published advisories at the time of review); its files and the bundled fonts are pinned by SHA-256 in `tools/vendor.lock.json` and the build stops if one changes. Free fonts are fetched from exact, immutable npm versions only (2,072 families pinned), from one CDN folder allowed by the CSP, size- and format-checked. `npm audit`: 0 vulnerabilities. Dependabot watches the npm tooling. | `security.pw.mjs` (A03), `tools/vendor_lock.py` |
| A04 | Cryptographic failures | AES-256-GCM with a random 96-bit IV per write, associated data binding account/file/version; keys are **non-extractable** (scripts on the page cannot read them); the tab keeps only a random sign-in id. While signed in, no unencrypted copy of the open PDF is written (crash recovery is off). | `security.pw.mjs` (A04) |
| A05 | Injection | No `eval`, no inline scripts; PDF-derived text (font names), account names and file names are inserted as text or escaped; the CSP blocks any injected script anyway. Tested with a PDF whose font is named `<img src=x onerror=…>` and HTML in names. | `security.pw.mjs` (A05) |
| A06 | Insecure design | Least data by design (nothing on a server). Limits: 200 MB per PDF in My PDFs (shown to the user, with a built-in “Reduce file size”), 10 MB per downloaded font; the last 5 versions of a file are kept; deleting an account requires the passkey. Threat model below. | `security.pw.mjs` (A06) |
| A07 | Authentication failures | Passkeys only (phishing-resistant, no passwords to steal or reuse), user verification required, forged/tampered assertions refused, cloned-authenticator counter check. A sign-in ends when the tab closes, after 30 minutes without activity or 12 hours at most; the account menu shows the previous sign-in. | `security.pw.mjs` (A07), `account.pw.mjs` |
| A08 | Software or data integrity | Encrypted files are authenticated: one changed bit is detected and the file refused with a clear message. Third-party files checked by hash at build time. | `security.pw.mjs` (A08) |
| A09 | Logging and alerting | By design nothing about users is logged (no server). Security reports: `security.txt` + GitHub private reporting. Users see their previous sign-in date to notice access they did not make. | – |
| A10 | Mishandling of exceptional conditions | Fails closed: any error during passkey verification or decryption refuses access. Storage full, oversized files, damaged files and engine errors give plain-language messages; storage writes are transactional (all or nothing). | `security.pw.mjs` (A10), `account.pw.mjs` |

## Limits (known and accepted)

- Someone with full access to the person's unlocked computer and browser profile can use an open sign-in, and — for passkeys
  without PRF — can use the browser-held key. Browser storage is as safe as the device it is on.
- Clearing the site's data in the browser deletes the account and its PDFs (no copy exists elsewhere). Users are told to download what matters.
- The free-font CDN (jsDelivr) sees the IP address and the name of a font when one is downloaded (never the document); it can be switched off.
- Static hosting cannot rate-limit or alert on its own; Cloudflare's network-level protections apply.

Run every check locally: `sh tests/run-all.sh` (editor) and `cd site && npm test` (site, accounts, security).
