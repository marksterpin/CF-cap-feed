# CapNavigator — CDR business-loan harvester

A zero-dependency Node script + GitHub Actions workflow that keeps CapNavigator's
live business-loan data current. It runs **server-side**, so there are no browser
CORS problems, and it publishes a static JSON feed the app auto-loads.

## What it does

1. Discovers data holders from the public **CDR Register**
   (`api.cdr.gov.au/cdr-register/v1/all/data-holders/brands/summary`).
2. For each holder, requests their **`BUSINESS_LOANS`** and **`OVERDRAFTS`** Product
   Reference Data (`{base}/cds-au/v1/banking/products?product-category=…`) with version
   negotiation and polite rate-limiting, then fetches each product's detail for rates,
   fees and limits. Overdrafts / lines of credit feed CapNavigator's "Line of credit"
   finance type.
3. Maps every product into the CapNavigator feed schema and writes:
   - `docs/business_loans.json` — the array the app loads
   - `docs/business_loans.meta.json` — harvest timestamp, counts, any holder errors

No API key or registration is needed — Product Reference Data is public.

## One-time setup

1. Create a new GitHub repo (e.g. `cap-feed`) and add these files at its root:
   `harvest.js`, `.github/workflows/harvest.yml`, `README.md`.
2. In **Settings → Pages**, set **Source: Deploy from a branch**, **Branch: `main` / `/docs`**, save.
3. Run the harvester once: **Actions → Harvest CDR business loans → Run workflow**.
   It creates `docs/business_loans.json` and commits it; Pages then serves it.
4. Your feed URL is:
   ```
   https://<your-username>.github.io/<repo>/business_loans.json
   ```
   (The `raw.githubusercontent.com/<user>/<repo>/main/docs/business_loans.json` URL also
   works — both send open CORS headers, so the browser can fetch them directly.)
5. In CapNavigator, open **Compare → Connect live CDR data → Harvester feed**, paste the
   URL, click **Load feed**. The app caches it and **auto-refreshes on load** when the
   data is more than ~12 hours old.

After that it's automatic: the workflow runs nightly (`0 15 * * *` UTC ≈ 1am AEST),
commits any changes, and the app picks them up.

## Running locally

```bash
node harvest.js               # full harvest -> docs/business_loans.json
SELFTEST=1 node harvest.js    # offline unit test of the mapper (no network)
```

Config via environment variables (all optional):

| Var | Default | Purpose |
|-----|---------|---------|
| `OUT_DIR` | `docs` | output directory |
| `CONCURRENCY` | `6` | data holders fetched in parallel |
| `REQUEST_TIMEOUT_MS` | `12000` | per-request timeout |
| `MAX_HOLDERS` | `0` (all) | cap holders — set small for a quick test |
| `HOLDER_FILTER` | — | comma-separated brand substrings, e.g. `judo,prospa` |
| `CATEGORIES` | `BUSINESS_LOANS,OVERDRAFTS` | CDR product categories to harvest |

Requires Node 18+ (uses the built-in `fetch`).

## Feed schema

Each item matches what CapNavigator's engine expects:

```json
{
  "lender": "Judo Bank",
  "product": "Business Term Loan",
  "type": "secured_term",
  "rate": 8.95, "feeFlat": 600, "feePct": 0, "feeMo": 10,
  "min": 20000, "max": 5000000, "maxTerm": 300,
  "sec": ["residential", "commercial", "business_assets"],
  "trade": 0, "turn": 0, "fund": 7, "io": false,
  "feat": ["CDR-sourced product data"],
  "source": "CDR", "category": "BUSINESS_LOANS", "productId": "…", "lastUpdated": "…"
}
```

## Honest caveats

- **Product data only.** CDR carries rates, fees, charges and eligibility — **not credit
  policy or appetite**. CapNavigator reconciles each live product against its curated
  lender-policy set: matched lenders show live pricing *with* their appetite profile
  (replacing the overlapping sample row); unmatched lenders show an "n/a" approval band.
  The appetite layer stays a curated CapNavigator asset.
- **Pricing-on-application is skipped.** Many business loans don't publish a numeric rate;
  those products can't be compared and are left out (counted in the meta file).
- **Coverage grows over time.** Banks have published business-loan data for years; non-bank
  lenders came into scope from **13 July 2026** and are onboarding in tranches, so expect
  the holder and product count to rise.
- **Be a good citizen.** The script paces requests and negotiates API versions. If you widen
  categories or raise concurrency a lot, keep an eye on rate limits.
- **`type` / security are inferred** from the product name/description (a light "secured"
  heuristic). Treat `secured_term` vs `unsecured_term` on live products as indicative.
