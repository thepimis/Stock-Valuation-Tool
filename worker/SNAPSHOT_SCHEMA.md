# Company snapshot schema

Prepared R2 objects use the versioned schema `stock-platform.company-snapshot`, version `1`.
The schema is the contract between the importer and the browser. Raw provider responses are
not stored, and the browser does not calculate historical financial metrics.

```json
{
  "meta": {
    "schema": "stock-platform.company-snapshot",
    "version": 1,
    "ticker": "AAPL",
    "generatedAt": "2026-07-29T20:00:00.000Z",
    "sourceVersion": "...",
    "sourceCommitRef": "..."
  },
  "identity": {
    "ticker": "AAPL",
    "companyName": "Apple Inc.",
    "exchange": "NASDAQ",
    "currency": "USD"
  },
  "financials": {
    "ttm": { "revenue": 0, "netIncome": 0, "freeCashFlow": 0 },
    "balanceSheet": { "cash": 0, "totalDebt": 0, "sharesOutstanding": 0 },
    "asOf": { "balanceSheet": null, "incomeQuarters": [], "cashFlow": null }
  },
  "metrics": { "roic": null, "roicFiscalYear": null },
  "history": { "metrics": {}, "availability": {} },
  "live": {
    "fields": ["price", "marketCap", "enterpriseValue"],
    "price": null,
    "marketCap": null,
    "enterpriseValue": null
  },
  "methodology": {
    "company": "company-overview-v1",
    "history": "historical-metrics-v1",
    "roic": "finviz-style-roic-v1"
  },
  "quality": { "availability": {}, "fields": {} },
  "sources": ["dolthub-earnings", "yahoo-finance"]
}
```

## Rules

- Monetary values are stored in base currency units, not preformatted strings.
- Percentages are stored as percentage points (`12.5` means 12.5%).
- Historical calculations are completed by the importer.
- Live price, market capitalisation, and enterprise value remain null in R2.
- Methodology uses short version identifiers instead of repeated explanatory text to reduce storage.
- A schema version change is required for breaking field changes.
