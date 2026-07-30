# Prepared company data importer (R2)

The importer calculates each company snapshot ahead of time and uploads it to
Cloudflare R2. The browser continues to request `/data/AAPL.json`; the Worker
reads `companies/AAPL.json` from R2 and caches the response at Cloudflare's edge.
Only the live Yahoo quote is requested separately.

## 1. Create the R2 bucket

```bash
npx wrangler r2 bucket create stock-company-data
```

The Worker binding is already configured in `wrangler.jsonc` as `COMPANY_DATA`.
Change `bucket_name` there if you use a different bucket name.

## 2. Create R2 API credentials

Create an R2 API token with Object Read & Write access to the bucket, then set:

```bash
CLOUDFLARE_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=stock-company-data
```

These credentials are used only by the offline importer. They are not exposed to
the browser or stored in the Worker.

## 3. Test a few companies

```bash
npm ci
npm run import:sample
npm run dev
```

This uploads:

- `companies/AAPL.json`, `companies/MSFT.json`, etc.
- `companies/manifest.json`
- `companies/tickers.json`

## Full import

```bash
npm run import:data -- --concurrency 2
```

Useful options:

```bash
node scripts/import-companies.mjs --limit 100
node scripts/import-companies.mjs --resume
node scripts/import-companies.mjs --tickers AAPL,MSFT,META
node scripts/import-companies.mjs --concurrency 3 --pageSize 500
```

For a local dry run without R2:

```bash
npm run import:local -- --tickers AAPL,MSFT
```

Local snapshots are written to `.import-output/`.

## GitHub Actions secrets

Add these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

The weekly workflow uploads snapshots directly to R2 and does not redeploy the Worker.
Updating one company does not require bundling or redeploying thousands of JSON files.

## Snapshot contract

Every company object follows the versioned contract in `SNAPSHOT_SCHEMA.md`. The importer
validates each object before upload. The schema intentionally excludes raw provider payloads,
verbose repeated methodology text, and live price fields to keep R2 storage and transfer sizes
small.

## Verify prepared snapshot accuracy

After importing sample companies, compare every prepared route stored in R2 with a fresh calculation from the existing calculation engine:

```bash
npm run verify:snapshots
```

To verify specific tickers:

```bash
npm run verify:snapshots -- --tickers AAPL,MSFT,META
```

The command checks company overview, financials, dashboard, returns, growth, and historical/DCF data. It exits with a non-zero status when a mismatch is found, making it suitable for CI or the future overnight job.

## Supported US stock universe

The importer no longer scans every historical ticker found in Dolt. Build a clean active universe first:

```bash
npm run universe:update
```

This downloads the official Nasdaq Trader symbol directories, keeps active non-ETF securities on NASDAQ, NYSE and NYSE American, excludes obvious funds, notes, warrants, rights, units and preferred shares, and intersects the result with companies that have annual financial statements in Dolt.

The generated file is:

```text
data/supported-tickers.json
```

Import that universe with:

```bash
npm run import:universe
```

The benchmark command also uses this curated file:

```bash
npm run import:benchmark
```

## Universe-builder reliability

`npm run universe:update` now checks only eligible exchange-listed symbols in small Dolt batches instead of scanning and sorting the full `income_statement` table. A checkpoint is written to `data/supported-tickers.json.checkpoint.json`; if the command is interrupted, rerunning it resumes from the completed symbols. Timed-out batches are retried and automatically split into smaller requests.

Optional tuning:

```bash
UNIVERSE_DOLT_BATCH_SIZE=25 UNIVERSE_DOLT_CONCURRENCY=1 npm run universe:update
```

## Weekly GitHub Actions snapshot import

The workflow `.github/workflows/weekly-snapshot-import.yml` runs every Friday at `00:15 UTC`. It refreshes the prepared company snapshots in R2 for the already generated supported universe.

Generate `data/supported-tickers.json` locally once with:

```bash
npm run universe:update
```

Commit that file to the repository. The weekly workflow does not rebuild the universe automatically.

Required GitHub repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

The workflow uploads snapshots directly to R2 and does not redeploy the Worker. Yahoo live prices remain separate from the weekly snapshot refresh.
