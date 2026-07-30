var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/providers/yahoo.js
var YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
var ALLOWED_US_EXCHANGES = /* @__PURE__ */ new Set(["NYQ", "NMS", "NGM", "NCM", "ASE"]);
var EXCHANGE_LABELS = {
  NYQ: "NYSE",
  NMS: "NASDAQ",
  NGM: "NASDAQ",
  NCM: "NASDAQ",
  ASE: "NYSE American"
};
async function fetchYahooJson(path, params = {}, createError2) {
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    const url = new URL(`https://${host}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; StockValuationTool/1.0)",
          Referer: "https://finance.yahoo.com/"
        },
        cf: { cacheEverything: true, cacheTtl: 120 }
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(body?.finance?.error?.description || response.statusText || "Yahoo request failed");
      return { body, host };
    } catch (error) {
      lastError = error;
    }
  }
  throw createError2(502, `Yahoo Finance request failed: ${lastError?.message || "unknown error"}`);
}
__name(fetchYahooJson, "fetchYahooJson");
async function searchYahooEquities(query, { version, createError: createError2 }) {
  if (!query || query.length > 80) throw createError2(400, "Enter a company name or ticker.");
  const { body } = await fetchYahooJson("/v1/finance/search", {
    q: query,
    quotesCount: "20",
    newsCount: "0",
    enableFuzzyQuery: "true",
    quotesQueryId: "tss_match_phrase_query"
  }, createError2);
  const results = (Array.isArray(body.quotes) ? body.quotes : []).filter((row) => String(row.quoteType || "").toUpperCase() === "EQUITY").filter((row) => ALLOWED_US_EXCHANGES.has(String(row.exchange || row.exchDisp || "").toUpperCase())).map((row) => {
    const exchangeCode = String(row.exchange || "").toUpperCase();
    return {
      symbol: String(row.symbol || "").toUpperCase(),
      name: row.longname || row.shortname || row.symbol,
      exchangeCode,
      exchange: EXCHANGE_LABELS[exchangeCode] || row.exchDisp || exchangeCode,
      quoteType: "EQUITY"
    };
  }).filter((row) => row.symbol);
  return { ok: true, version, query, results };
}
__name(searchYahooEquities, "searchYahooEquities");
async function fetchYahooQuote(ticker, { version, createError: createError2 }) {
  const { body, host } = await fetchYahooJson(`/v8/finance/chart/${encodeURIComponent(ticker)}`, {
    interval: "1d",
    range: "5d"
  }, createError2);
  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta) throw createError2(404, `Yahoo returned no quote for ${ticker}.`);
  const quoteType = String(meta.instrumentType || meta.quoteType || "").toUpperCase();
  const exchangeCode = String(meta.exchangeName || "").toUpperCase();
  if (quoteType && quoteType !== "EQUITY") throw createError2(400, `${ticker} is not an equity.`);
  if (exchangeCode && !ALLOWED_US_EXCHANGES.has(exchangeCode)) throw createError2(400, `${ticker} is not a supported US-listed equity.`);
  return {
    ok: true,
    version,
    ticker,
    quoteType: quoteType || "EQUITY",
    exchangeCode,
    exchangeLabel: meta.fullExchangeName || exchangeCode,
    companyName: meta.longName || meta.shortName || ticker,
    longName: meta.longName || null,
    shortName: meta.shortName || null,
    currency: meta.currency || "USD",
    price: Number(meta.regularMarketPrice ?? meta.chartPreviousClose ?? meta.previousClose) || null,
    regularMarketPrice: Number(meta.regularMarketPrice) || null,
    sourceHost: host,
    chart: body.chart
  };
}
__name(fetchYahooQuote, "fetchYahooQuote");
async function fetchYahooTtmCashFlow(ticker, { createError: createError2, parseNumber: parseNumber2 }) {
  const types = [
    "trailingOperatingCashFlow",
    "trailingCapitalExpenditure",
    "trailingFreeCashFlow"
  ];
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const period1 = nowSeconds - 10 * 365 * 24 * 60 * 60;
  const period2 = nowSeconds + 2 * 24 * 60 * 60;
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    const target = new URL(`https://${host}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`);
    target.searchParams.set("symbol", ticker);
    target.searchParams.set("type", types.join(","));
    target.searchParams.set("period1", String(period1));
    target.searchParams.set("period2", String(period2));
    try {
      const response = await fetch(target.toString(), {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/cash-flow/`
        },
        cf: { cacheEverything: true, cacheTtl: 300 }
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw createError2(502, `Yahoo ${host} returned non-JSON: ${text.slice(0, 180)}`);
      }
      if (!response.ok) {
        throw createError2(response.status, payload?.finance?.error?.description || `Yahoo ${host} returned HTTP ${response.status}.`, payload);
      }
      const result = payload?.timeseries?.result;
      if (!Array.isArray(result)) {
        throw createError2(502, `Yahoo ${host} returned no timeseries result.`, payload);
      }
      const operatingFact = extractLatestYahooFact(result, "trailingOperatingCashFlow", parseNumber2);
      const capexFact = extractLatestYahooFact(result, "trailingCapitalExpenditure", parseNumber2);
      const directFcfFact = extractLatestYahooFact(result, "trailingFreeCashFlow", parseNumber2);
      if (!operatingFact || !capexFact) {
        throw createError2(502, `Yahoo returned incomplete TTM cash-flow data for ${ticker}.`, {
          foundOperatingCashFlow: Boolean(operatingFact),
          foundCapitalExpenditure: Boolean(capexFact),
          returnedTypes: result.map((item) => item?.meta?.type?.[0] || item?.type).filter(Boolean)
        });
      }
      const operatingCashFlow = operatingFact.raw;
      const capitalExpenditures = Math.abs(capexFact.raw);
      const calculatedFreeCashFlow = operatingCashFlow - capitalExpenditures;
      const directFreeCashFlow = directFcfFact?.raw;
      const freeCashFlow = calculatedFreeCashFlow;
      const asOfDate = [operatingFact.asOfDate, capexFact.asOfDate, directFcfFact?.asOfDate].filter(Boolean).sort().at(-1) || null;
      return {
        host,
        types,
        currency: operatingFact.currency || capexFact.currency || directFcfFact?.currency || "USD",
        asOfDate,
        operatingCashFlow,
        capitalExpenditures,
        capexRaw: capexFact.raw,
        freeCashFlow,
        yahooDirectFreeCashFlow: Number.isFinite(directFreeCashFlow) ? directFreeCashFlow : null,
        directFcfDifference: Number.isFinite(directFreeCashFlow) ? freeCashFlow - directFreeCashFlow : null
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || createError2(502, "Yahoo Finance TTM cash-flow data is unavailable.");
}
__name(fetchYahooTtmCashFlow, "fetchYahooTtmCashFlow");
function extractLatestYahooFact(result, type, parseNumber2) {
  const candidates = [];
  for (const item of result) {
    const itemType = item?.meta?.type?.[0] || item?.type || "";
    if (itemType !== type && !Object.prototype.hasOwnProperty.call(item || {}, type)) continue;
    const facts = Array.isArray(item?.[type]) ? item[type] : [];
    for (const fact of facts) {
      const raw = parseNumber2(fact?.reportedValue?.raw ?? fact?.raw);
      if (!Number.isFinite(raw)) continue;
      candidates.push({
        raw,
        asOfDate: String(fact?.asOfDate || "").slice(0, 10) || null,
        currency: fact?.currencyCode || item?.meta?.currencyCode || null
      });
    }
  }
  return candidates.sort((a, b) => String(a.asOfDate || "").localeCompare(String(b.asOfDate || ""))).at(-1) || null;
}
__name(extractLatestYahooFact, "extractLatestYahooFact");
async function fetchYahooBalanceSnapshot(ticker, { createError: createError2, parseNumber: parseNumber2 }) {
  const types = [
    "quarterlyCurrentDebt",
    "annualCurrentDebt",
    "quarterlyLongTermDebt",
    "annualLongTermDebt",
    "quarterlyTotalDebt",
    "annualTotalDebt",
    "quarterlyCashCashEquivalentsAndShortTermInvestments",
    "annualCashCashEquivalentsAndShortTermInvestments",
    "quarterlyCashAndCashEquivalents",
    "annualCashAndCashEquivalents",
    "quarterlyOrdinarySharesNumber",
    "annualOrdinarySharesNumber"
  ];
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const period1 = nowSeconds - 8 * 365 * 24 * 60 * 60;
  const period2 = nowSeconds + 2 * 24 * 60 * 60;
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    const target = new URL(`https://${host}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`);
    target.searchParams.set("symbol", ticker);
    target.searchParams.set("type", types.join(","));
    target.searchParams.set("period1", String(period1));
    target.searchParams.set("period2", String(period2));
    try {
      const response = await fetch(target.toString(), {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/balance-sheet/`
        },
        cf: { cacheEverything: true, cacheTtl: 300 }
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw createError2(502, `Yahoo ${host} returned non-JSON balance-sheet data.`);
      }
      if (!response.ok) {
        throw createError2(response.status, payload?.finance?.error?.description || `Yahoo ${host} returned HTTP ${response.status}.`);
      }
      const result = Array.isArray(payload?.timeseries?.result) ? payload.timeseries.result : [];
      const choose = /* @__PURE__ */ __name((preferredTypes) => {
        for (const type of preferredTypes) {
          const fact = extractLatestYahooFact(result, type, parseNumber2);
          if (fact && Number.isFinite(fact.raw)) return { ...fact, type };
        }
        return null;
      }, "choose");
      const quarterlyCurrentDebt = choose(["quarterlyCurrentDebt"]);
      const quarterlyLongTermDebt = choose(["quarterlyLongTermDebt"]);
      const annualCurrentDebt = choose(["annualCurrentDebt"]);
      const annualLongTermDebt = choose(["annualLongTermDebt"]);
      const sameDate = /* @__PURE__ */ __name((left, right) => left && right && left.asOfDate && left.asOfDate === right.asOfDate, "sameDate");
      let debt = null;
      if (sameDate(quarterlyCurrentDebt, quarterlyLongTermDebt)) {
        debt = {
          raw: quarterlyCurrentDebt.raw + quarterlyLongTermDebt.raw,
          type: "quarterlyCurrentDebt + quarterlyLongTermDebt",
          asOfDate: quarterlyCurrentDebt.asOfDate,
          currency: quarterlyCurrentDebt.currency || quarterlyLongTermDebt.currency || null,
          currentDebt: quarterlyCurrentDebt.raw,
          longTermDebt: quarterlyLongTermDebt.raw,
          fallbackUsed: false
        };
      } else if (sameDate(annualCurrentDebt, annualLongTermDebt)) {
        debt = {
          raw: annualCurrentDebt.raw + annualLongTermDebt.raw,
          type: "annualCurrentDebt + annualLongTermDebt",
          asOfDate: annualCurrentDebt.asOfDate,
          currency: annualCurrentDebt.currency || annualLongTermDebt.currency || null,
          currentDebt: annualCurrentDebt.raw,
          longTermDebt: annualLongTermDebt.raw,
          fallbackUsed: false
        };
      } else {
        const totalDebtFallback = choose(["quarterlyTotalDebt", "annualTotalDebt"]);
        if (totalDebtFallback) {
          debt = {
            ...totalDebtFallback,
            currentDebt: null,
            longTermDebt: null,
            fallbackUsed: true
          };
        }
      }
      const cash = choose([
        "quarterlyCashCashEquivalentsAndShortTermInvestments",
        "quarterlyCashAndCashEquivalents",
        "annualCashCashEquivalentsAndShortTermInvestments",
        "annualCashAndCashEquivalents"
      ]);
      const shares = choose(["quarterlyOrdinarySharesNumber", "annualOrdinarySharesNumber"]);
      if (!debt) {
        throw createError2(502, `Yahoo returned no usable debt facts for ${ticker}.`, {
          requestedTypes: types,
          returnedTypes: result.map((item) => item?.meta?.type?.[0] || item?.type).filter(Boolean)
        });
      }
      return {
        host,
        totalDebt: debt.raw,
        debtType: debt.type,
        debtAsOfDate: debt.asOfDate,
        currentDebt: debt.currentDebt ?? null,
        longTermDebt: debt.longTermDebt ?? null,
        debtFallbackUsed: Boolean(debt.fallbackUsed),
        cash: cash?.raw ?? null,
        cashType: cash?.type ?? null,
        cashAsOfDate: cash?.asOfDate ?? null,
        sharesOutstanding: shares?.raw ?? null,
        sharesType: shares?.type ?? null,
        sharesAsOfDate: shares?.asOfDate ?? null,
        currency: debt.currency || cash?.currency || shares?.currency || "USD"
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || createError2(502, "Yahoo balance-sheet snapshot is unavailable.");
}
__name(fetchYahooBalanceSnapshot, "fetchYahooBalanceSnapshot");

// src/providers/dolt.js
var DOLT_BASE = "https://www.dolthub.com/api/v1alpha1/post-no-preference/earnings";
var DOLT_TICKER_ALIASES = {
  META: ["META", "FB"]
};
async function runDoltQuery(sql) {
  const target = new URL(DOLT_BASE);
  target.searchParams.set("q", sql);
  const response = await fetch(target.toString(), {
    headers: { Accept: "application/json" },
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw createDoltError(502, `DoltHub returned non-JSON: ${text.slice(0, 180)}`);
  }
  if (!response.ok || body.query_execution_status === "Error") {
    const message = body.query_execution_message || body.error || response.statusText || "DoltHub query failed";
    throw createDoltError(response.status || 502, message, { sql, body });
  }
  return body;
}
__name(runDoltQuery, "runDoltQuery");
function doltTickerPredicate(ticker, column = "act_symbol") {
  const symbols = getDoltTickerSymbols(ticker);
  if (symbols.length === 1) {
    return `${column} = ${sqlString(symbols[0])}`;
  }
  return `${column} IN (${symbols.map(sqlString).join(", ")})`;
}
__name(doltTickerPredicate, "doltTickerPredicate");
function getDoltTickerSymbols(ticker) {
  const current = String(ticker || "").toUpperCase();
  const aliases = DOLT_TICKER_ALIASES[current] || [current];
  return [...new Set(aliases.map((symbol) => String(symbol).toUpperCase()))];
}
__name(getDoltTickerSymbols, "getDoltTickerSymbols");
function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
__name(sqlString, "sqlString");
function createDoltError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}
__name(createDoltError, "createDoltError");

// src/services/financials.js
function parseFinancialNumber(value) {
  if (value === null || value === void 0 || value === "") return NaN;
  return Number(String(value).replace(/,/g, ""));
}
__name(parseFinancialNumber, "parseFinancialNumber");
function calculateTtmRevenue(quarterlyRows = []) {
  const latestFour = Array.isArray(quarterlyRows) ? quarterlyRows.slice(0, 4) : [];
  return latestFour.reduce((sum, row) => {
    const revenue = parseFinancialNumber(row?.sales);
    return sum + (Number.isFinite(revenue) ? revenue : 0);
  }, 0);
}
__name(calculateTtmRevenue, "calculateTtmRevenue");
function buildRevenueSeries(quarterlyRows = [], annualRows = []) {
  const quarterlyByDate = /* @__PURE__ */ new Map();
  for (const row of quarterlyRows) {
    const date = String(row.date || "").slice(0, 10);
    const sales = parseFinancialNumber(row.sales);
    if (!date || !Number.isFinite(sales) || sales <= 0) continue;
    quarterlyByDate.set(date, { date, sales });
  }
  const quarters = [...quarterlyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const ttmSeries = [];
  for (let i = 3; i < quarters.length; i += 1) {
    const window = quarters.slice(i - 3, i + 1);
    const revenue = window.reduce((sum, item) => sum + item.sales, 0);
    ttmSeries.push({ endDate: quarters[i].date, revenue, revenueBillions: revenue / 1e9, quarterDates: window.map((item) => item.date) });
  }
  const annualByDate = /* @__PURE__ */ new Map();
  for (const row of annualRows) {
    const date = String(row.date || "").slice(0, 10);
    const sales = parseFinancialNumber(row.sales);
    if (!date || !Number.isFinite(sales) || sales <= 0) continue;
    annualByDate.set(date, { date, fiscalYear: Number(date.slice(0, 4)), revenue: sales, revenueBillions: sales / 1e9 });
  }
  const reportedAnnualSeries = [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const fiscalYearEndMonthDay = String(reportedAnnualSeries.at(-1)?.date || "").slice(5) || null;
  let reconstructedAnnualYears = 0;
  if (fiscalYearEndMonthDay) {
    for (const point of ttmSeries) {
      const endDate = String(point?.endDate || "").slice(0, 10);
      if (!endDate || endDate.slice(5) !== fiscalYearEndMonthDay || annualByDate.has(endDate)) continue;
      annualByDate.set(endDate, { date: endDate, fiscalYear: Number(endDate.slice(0, 4)), revenue: point.revenue, revenueBillions: point.revenueBillions, source: "reconstructed from four quarterly revenue rows", quarterDates: Array.isArray(point.quarterDates) ? point.quarterDates : [] });
      reconstructedAnnualYears += 1;
    }
  }
  return { quarters, ttmSeries, reportedAnnualSeries, annualSeries: [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date)), reconstructedAnnualYears };
}
__name(buildRevenueSeries, "buildRevenueSeries");
function ttmGrowthAgainstOneYearAgo(series, latest) {
  const latestEndDate = String(latest?.endDate || "").slice(0, 10);
  if (!latestEndDate) return null;
  const target = /* @__PURE__ */ new Date(`${latestEndDate}T00:00:00Z`);
  target.setUTCFullYear(target.getUTCFullYear() - 1);
  let comparison = null;
  let smallestDistance = Infinity;
  for (const point of series) {
    const pointEndDate = String(point?.endDate || "").slice(0, 10);
    if (!pointEndDate || pointEndDate === latestEndDate) continue;
    const distance = Math.abs((/* @__PURE__ */ new Date(`${pointEndDate}T00:00:00Z`)).getTime() - target.getTime());
    if (distance < smallestDistance) {
      smallestDistance = distance;
      comparison = point;
    }
  }
  if (!comparison || comparison.revenue <= 0) return null;
  return { method: "year-over-year TTM growth", percentage: (latest.revenue / comparison.revenue - 1) * 100, latestEndDate, comparisonEndDate: String(comparison?.endDate || "").slice(0, 10) || null, latestRevenueBillions: latest.revenueBillions, comparisonRevenueBillions: comparison.revenueBillions };
}
__name(ttmGrowthAgainstOneYearAgo, "ttmGrowthAgainstOneYearAgo");
function fiscalYearCagr(series, latest, years) {
  const targetFiscalYear = latest.fiscalYear - years;
  const comparison = series.find((point) => point.fiscalYear === targetFiscalYear);
  if (!comparison || comparison.revenue <= 0) return { method: "fiscal-year CAGR", percentage: null, years, latestFiscalYear: latest.fiscalYear, requestedComparisonFiscalYear: targetFiscalYear, error: `No fiscal-year revenue row found for ${targetFiscalYear}.` };
  return { method: "fiscal-year CAGR", percentage: (Math.pow(latest.revenue / comparison.revenue, 1 / years) - 1) * 100, years, latestFiscalYear: latest.fiscalYear, comparisonFiscalYear: comparison.fiscalYear, latestDate: latest.date, comparisonDate: comparison.date, latestRevenueBillions: latest.revenueBillions, comparisonRevenueBillions: comparison.revenueBillions };
}
__name(fiscalYearCagr, "fiscalYearCagr");
function buildNetMarginSeries(quarterlyRows = [], annualRows = []) {
  const quarterlyByDate = /* @__PURE__ */ new Map();
  for (const row of quarterlyRows) {
    const date = String(row.date || "").slice(0, 10);
    const revenue = parseFinancialNumber(row.sales);
    const netIncome = parseFinancialNumber(row.net_income);
    if (!date || !Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(netIncome)) continue;
    quarterlyByDate.set(date, { date, revenue, netIncome });
  }
  const quarters = [...quarterlyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const ttmSeries = [];
  for (let i = 3; i < quarters.length; i += 1) {
    const window = quarters.slice(i - 3, i + 1);
    const revenue = window.reduce((sum, row) => sum + row.revenue, 0);
    const netIncome = window.reduce((sum, row) => sum + row.netIncome, 0);
    ttmSeries.push({ endDate: quarters[i].date, revenue, revenueBillions: revenue / 1e9, netIncome, netIncomeBillions: netIncome / 1e9, netMarginPercentage: revenue > 0 ? netIncome / revenue * 100 : null, quarterDates: window.map((row) => row.date) });
  }
  const annualByDate = /* @__PURE__ */ new Map();
  for (const row of annualRows) {
    const date = String(row.date || "").slice(0, 10);
    const revenue = parseFinancialNumber(row.sales);
    const netIncome = parseFinancialNumber(row.net_income);
    if (!date || !Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(netIncome)) continue;
    annualByDate.set(date, { date, fiscalYear: Number(date.slice(0, 4)), revenue, revenueBillions: revenue / 1e9, netIncome, netIncomeBillions: netIncome / 1e9, netMarginPercentage: netIncome / revenue * 100 });
  }
  return { quarters, ttmSeries, annualSeries: [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
__name(buildNetMarginSeries, "buildNetMarginSeries");
function calculateWeightedNetMargin(series, years) {
  const selectedRows = series.slice(-years);
  if (selectedRows.length < years) return { method: "weighted fiscal-year net margin", percentage: null, requestedYears: years, availableYears: selectedRows.length, error: `Only ${selectedRows.length} fiscal years are available.` };
  const totalRevenue = selectedRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalNetIncome = selectedRows.reduce((sum, row) => sum + row.netIncome, 0);
  return { method: "weighted fiscal-year net margin", percentage: totalRevenue > 0 ? totalNetIncome / totalRevenue * 100 : null, years, firstFiscalYear: selectedRows[0].fiscalYear, latestFiscalYear: selectedRows.at(-1).fiscalYear, totalRevenue, totalRevenueBillions: totalRevenue / 1e9, totalNetIncome, totalNetIncomeBillions: totalNetIncome / 1e9, rowsUsed: selectedRows };
}
__name(calculateWeightedNetMargin, "calculateWeightedNetMargin");
function calculateWeightedFcfMargin(series, years) {
  const selectedRows = series.slice(-years);
  if (selectedRows.length < years) return { method: "weighted fiscal-year FCF margin", percentage: null, requestedYears: years, availableYears: selectedRows.length, error: `Only ${selectedRows.length} fiscal years are available.` };
  const totalRevenue = selectedRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalFreeCashFlow = selectedRows.reduce((sum, row) => sum + row.freeCashFlow, 0);
  return { method: "weighted fiscal-year FCF margin", percentage: totalRevenue > 0 ? totalFreeCashFlow / totalRevenue * 100 : null, years, firstFiscalYear: selectedRows[0].fiscalYear, latestFiscalYear: selectedRows.at(-1).fiscalYear, totalRevenue, totalRevenueBillions: totalRevenue / 1e9, totalFreeCashFlow, totalFreeCashFlowBillions: totalFreeCashFlow / 1e9, rowsUsed: selectedRows };
}
__name(calculateWeightedFcfMargin, "calculateWeightedFcfMargin");

// src/services/metrics.js
function parseFinancialNumber2(value) {
  if (value === null || value === void 0 || value === "") return NaN;
  return Number(String(value).replace(/,/g, ""));
}
__name(parseFinancialNumber2, "parseFinancialNumber");
function metricPercentage(value) {
  return Number.isFinite(Number(value?.percentage)) ? Number(value.percentage) : null;
}
__name(metricPercentage, "metricPercentage");
function buildDashboardMetricGroups(revenue, margin, fcf) {
  return {
    revenueGrowth: {
      oneYear: metricPercentage(revenue?.historicalRevenueGrowth?.oneYear),
      threeYears: metricPercentage(revenue?.historicalRevenueGrowth?.threeYears),
      fiveYears: metricPercentage(revenue?.historicalRevenueGrowth?.fiveYears),
      tenYears: metricPercentage(revenue?.historicalRevenueGrowth?.tenYears)
    },
    netMargins: {
      oneYear: metricPercentage(margin?.historicalNetMargins?.oneYear),
      threeYears: metricPercentage(margin?.historicalNetMargins?.threeYears),
      fiveYears: metricPercentage(margin?.historicalNetMargins?.fiveYears),
      tenYears: metricPercentage(margin?.historicalNetMargins?.tenYears)
    },
    fcfMargins: {
      oneYear: metricPercentage(fcf?.historicalFcfMargins?.oneYear),
      threeYears: metricPercentage(fcf?.historicalFcfMargins?.threeYears),
      fiveYears: metricPercentage(fcf?.historicalFcfMargins?.fiveYears),
      tenYears: metricPercentage(fcf?.historicalFcfMargins?.tenYears)
    }
  };
}
__name(buildDashboardMetricGroups, "buildDashboardMetricGroups");
function buildLatestTtmFcf(quarterlyRevenueRows, yahooTtm) {
  const latestRevenueRows = (Array.isArray(quarterlyRevenueRows) ? quarterlyRevenueRows : []).map((row) => ({
    date: String(row.date || "").slice(0, 10),
    revenue: parseFinancialNumber2(row.sales)
  })).filter((row) => row.date && Number.isFinite(row.revenue) && row.revenue > 0).sort((a, b) => a.date.localeCompare(b.date));
  const rowsUsed = latestRevenueRows.slice(-4);
  if (rowsUsed.length !== 4 || !yahooTtm) return null;
  const revenue = rowsUsed.reduce((sum, row) => sum + row.revenue, 0);
  if (!Number.isFinite(revenue) || revenue <= 0) return null;
  return {
    endDate: rowsUsed.at(-1).date,
    revenue,
    revenueBillions: revenue / 1e9,
    operatingCashFlow: yahooTtm.operatingCashFlow,
    operatingCashFlowBillions: yahooTtm.operatingCashFlow / 1e9,
    capitalExpenditures: yahooTtm.capitalExpenditures,
    capitalExpendituresBillions: yahooTtm.capitalExpenditures / 1e9,
    freeCashFlow: yahooTtm.freeCashFlow,
    freeCashFlowBillions: yahooTtm.freeCashFlow / 1e9,
    fcfMarginPercentage: yahooTtm.freeCashFlow / revenue * 100,
    quarterDates: rowsUsed.map((row) => row.date),
    cashFlowAsOfDate: yahooTtm.asOfDate,
    currency: yahooTtm.currency,
    source: "Yahoo Finance fundamentals-timeseries"
  };
}
__name(buildLatestTtmFcf, "buildLatestTtmFcf");
function buildAnnualFcfSeries(annualCashFlowRows, annualRevenueRows) {
  const revenueByDate = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(annualRevenueRows) ? annualRevenueRows : []) {
    const date = String(row.date || "").slice(0, 10);
    const revenue = parseFinancialNumber2(row.sales);
    if (date && Number.isFinite(revenue) && revenue > 0) revenueByDate.set(date, revenue);
  }
  const annualByDate = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(annualCashFlowRows) ? annualCashFlowRows : []) {
    const date = String(row.date || "").slice(0, 10);
    const revenue = revenueByDate.get(date);
    const operatingCashFlow = parseFinancialNumber2(row.operating_cash_flow);
    const capexRaw = parseFinancialNumber2(row.capital_expenditures);
    if (!date || !Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(operatingCashFlow) || !Number.isFinite(capexRaw)) continue;
    const capitalExpenditures = Math.abs(capexRaw);
    const freeCashFlow = operatingCashFlow - capitalExpenditures;
    annualByDate.set(date, {
      date,
      fiscalYear: Number(date.slice(0, 4)),
      revenue,
      revenueBillions: revenue / 1e9,
      operatingCashFlow,
      operatingCashFlowBillions: operatingCashFlow / 1e9,
      capitalExpenditures,
      capitalExpendituresBillions: capitalExpenditures / 1e9,
      freeCashFlow,
      freeCashFlowBillions: freeCashFlow / 1e9,
      fcfMarginPercentage: freeCashFlow / revenue * 100
    });
  }
  return [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
__name(buildAnnualFcfSeries, "buildAnnualFcfSeries");

// src/services/returns.js
function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
__name(finite, "finite");
function average(current, previous) {
  const a = finite(current);
  const b = finite(previous);
  if (a !== null && b !== null) return (a + b) / 2;
  return a;
}
__name(average, "average");
function percentage(numerator, denominator) {
  const top = finite(numerator);
  const bottom = finite(denominator);
  return top !== null && bottom !== null && bottom !== 0 ? top / bottom * 100 : null;
}
__name(percentage, "percentage");
function averagePercentage(rows, key, years) {
  const values = rows.slice(-years).map((row) => finite(row[key])).filter((value) => value !== null);
  return {
    percentage: values.length === years ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    requestedYears: years,
    availableYears: values.length,
    firstFiscalYear: values.length === years ? rows.slice(-years)[0]?.fiscalYear ?? null : null,
    latestFiscalYear: values.length === years ? rows.at(-1)?.fiscalYear ?? null : null
  };
}
__name(averagePercentage, "averagePercentage");
function deriveNonCurrentOperatingLeases(row = {}) {
  const supplied = finite(row.operatingLeaseLiabilitiesNonCurrent);
  if (supplied !== null) return Math.max(0, supplied);
  const totalLiabilities = finite(row.totalLiabilities);
  const currentLiabilities = finite(row.currentLiabilities);
  const longTermDebt = finite(row.longTermDebt);
  const otherNonCurrentLiabilities = finite(row.otherNonCurrentLiabilities);
  if ([totalLiabilities, currentLiabilities, longTermDebt, otherNonCurrentLiabilities].some((value) => value === null)) return 0;
  return Math.max(
    0,
    totalLiabilities - currentLiabilities - longTermDebt - otherNonCurrentLiabilities
  );
}
__name(deriveNonCurrentOperatingLeases, "deriveNonCurrentOperatingLeases");
function finvizInvestedCapital(row = {}) {
  const equity = finite(row.equity);
  const longTermDebt = finite(row.longTermDebt);
  if (equity === null || longTermDebt === null) return null;
  return equity + longTermDebt + deriveNonCurrentOperatingLeases(row);
}
__name(finvizInvestedCapital, "finvizInvestedCapital");
function calculateFinvizRoicSnapshot(row = {}) {
  const netIncome = finite(row.netIncome);
  const operatingLeaseLiabilitiesNonCurrent = deriveNonCurrentOperatingLeases(row);
  const investedCapital = finvizInvestedCapital(row);
  return {
    netIncome,
    equity: finite(row.equity),
    longTermDebt: finite(row.longTermDebt),
    operatingLeaseLiabilitiesNonCurrent,
    finvizStyleLongTermDebt: finite(row.longTermDebt) === null ? null : finite(row.longTermDebt) + operatingLeaseLiabilitiesNonCurrent,
    investedCapital,
    roicPercentage: percentage(netIncome, investedCapital)
  };
}
__name(calculateFinvizRoicSnapshot, "calculateFinvizRoicSnapshot");
function calculateReturnSeries(annualRows = []) {
  const sorted = [...annualRows].filter((row) => Number.isFinite(Number(row?.fiscalYear))).sort((a, b) => Number(a.fiscalYear) - Number(b.fiscalYear));
  return sorted.map((row, index) => {
    const previous = sorted[index - 1] || null;
    const finviz = calculateFinvizRoicSnapshot(row);
    const operatingIncome = finite(row.operatingIncome);
    const capitalEmployed = finite(row.totalAssets) !== null && finite(row.currentLiabilities) !== null ? finite(row.totalAssets) - finite(row.currentLiabilities) : finite(row.equity) !== null && finite(row.totalDebt) !== null ? finite(row.equity) + finite(row.totalDebt) : null;
    const averageEquity = average(row.equity, previous?.equity);
    const averageAssets = average(row.totalAssets, previous?.totalAssets);
    const previousCapitalEmployed = previous ? finite(previous.totalAssets) !== null && finite(previous.currentLiabilities) !== null ? finite(previous.totalAssets) - finite(previous.currentLiabilities) : null : null;
    const averageCapitalEmployed = average(capitalEmployed, previousCapitalEmployed);
    return {
      fiscalYear: Number(row.fiscalYear),
      date: row.date || null,
      methodology: "Finviz-style",
      netIncome: finviz.netIncome,
      equity: finviz.equity,
      longTermDebt: finviz.longTermDebt,
      operatingLeaseLiabilitiesNonCurrent: finviz.operatingLeaseLiabilitiesNonCurrent,
      finvizStyleLongTermDebt: finviz.finvizStyleLongTermDebt,
      investedCapital: finviz.investedCapital,
      averageInvestedCapital: null,
      roicPercentage: finviz.roicPercentage,
      operatingIncome,
      totalAssets: finite(row.totalAssets),
      currentLiabilities: finite(row.currentLiabilities),
      totalDebt: finite(row.totalDebt),
      cash: finite(row.cash),
      netDebt: finite(row.totalDebt) !== null && finite(row.cash) !== null ? finite(row.totalDebt) - finite(row.cash) : null,
      capitalEmployed,
      averageEquity,
      averageAssets,
      averageCapitalEmployed,
      roePercentage: percentage(row.netIncome, averageEquity),
      roaPercentage: percentage(row.netIncome, averageAssets),
      rocePercentage: percentage(operatingIncome, averageCapitalEmployed)
    };
  });
}
__name(calculateReturnSeries, "calculateReturnSeries");
function summariseReturns(series = [], currentSnapshot = null) {
  const usable = Array.isArray(series) ? series : [];
  const latestAnnual = usable.at(-1) || null;
  const current = currentSnapshot && Number.isFinite(Number(currentSnapshot.roicPercentage)) ? currentSnapshot : latestAnnual;
  const averagesFor = /* @__PURE__ */ __name((key) => ({
    threeYears: averagePercentage(usable, key, 3),
    fiveYears: averagePercentage(usable, key, 5),
    tenYears: averagePercentage(usable, key, 10)
  }), "averagesFor");
  return {
    latest: current ? {
      fiscalYear: current.fiscalYear ?? null,
      date: current.date ?? null,
      period: current.period ?? (current === latestAnnual ? "FY" : "TTM"),
      roicPercentage: current.roicPercentage,
      roePercentage: current.roePercentage ?? latestAnnual?.roePercentage ?? null,
      roaPercentage: current.roaPercentage ?? latestAnnual?.roaPercentage ?? null,
      rocePercentage: current.rocePercentage ?? latestAnnual?.rocePercentage ?? null,
      netIncome: current.netIncome ?? null,
      investedCapital: current.investedCapital ?? null,
      equity: current.equity ?? null,
      finvizStyleLongTermDebt: current.finvizStyleLongTermDebt ?? null,
      operatingLeaseLiabilitiesNonCurrent: current.operatingLeaseLiabilitiesNonCurrent ?? null,
      warning: "Finviz-style ROIC is an estimate; an error of +/- 5% is possible."
    } : null,
    latestAnnual,
    averages: {
      roic: averagesFor("roicPercentage"),
      roe: averagesFor("roePercentage"),
      roa: averagesFor("roaPercentage"),
      roce: averagesFor("rocePercentage")
    }
  };
}
__name(summariseReturns, "summariseReturns");

// src/utils/math.js
function toFiniteNumber(value) {
  if (value === null || value === void 0 || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}
__name(toFiniteNumber, "toFiniteNumber");
function percentageChange(startValue, endValue) {
  const start = toFiniteNumber(startValue);
  const end = toFiniteNumber(endValue);
  if (start === null || end === null || start === 0) return null;
  return (end - start) / Math.abs(start) * 100;
}
__name(percentageChange, "percentageChange");
function calculateCagr(startValue, endValue, years) {
  const start = toFiniteNumber(startValue);
  const end = toFiniteNumber(endValue);
  const periodYears = Number(years);
  if (start === null || end === null || !Number.isFinite(periodYears) || periodYears <= 0) {
    return { percentage: null, available: false, reason: "Missing value or invalid period." };
  }
  if (start <= 0 || end <= 0) {
    return {
      percentage: null,
      available: false,
      reason: "CAGR requires positive starting and ending values.",
      totalChangePercentage: percentageChange(start, end)
    };
  }
  return {
    percentage: (Math.pow(end / start, 1 / periodYears) - 1) * 100,
    available: true,
    reason: null,
    totalChangePercentage: percentageChange(start, end)
  };
}
__name(calculateCagr, "calculateCagr");

// src/services/growth.js
function normaliseSeries(series = []) {
  const byYear = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(series) ? series : []) {
    const fiscalYear = Number(row?.fiscalYear);
    const value = toFiniteNumber(row?.value);
    if (!Number.isFinite(fiscalYear) || value === null) continue;
    byYear.set(fiscalYear, {
      fiscalYear,
      date: row.date || null,
      value,
      source: row.source || null
    });
  }
  return [...byYear.values()].sort((a, b) => a.fiscalYear - b.fiscalYear);
}
__name(normaliseSeries, "normaliseSeries");
function nearestComparison(series, latest, years) {
  const requestedFiscalYear = latest.fiscalYear - years;
  const exact = series.find((row) => row.fiscalYear === requestedFiscalYear);
  return { requestedFiscalYear, comparison: exact || null };
}
__name(nearestComparison, "nearestComparison");
function calculateGrowthForPeriod(series = [], years = 1, options = {}) {
  const metric = options.metric || "metric";
  const method = years === 1 ? "fiscal-year growth" : "fiscal-year CAGR";
  const normalised = normaliseSeries(series);
  const latest = normalised.at(-1) || null;
  if (!latest) {
    return { metric, method, years, percentage: null, available: false, reason: "No usable annual values." };
  }
  const { requestedFiscalYear, comparison } = nearestComparison(normalised, latest, years);
  if (!comparison) {
    return {
      metric,
      method,
      years,
      percentage: null,
      available: false,
      latestFiscalYear: latest.fiscalYear,
      requestedComparisonFiscalYear: requestedFiscalYear,
      reason: `No value is available for fiscal year ${requestedFiscalYear}.`
    };
  }
  if (years === 1) {
    const percentage2 = percentageChange(comparison.value, latest.value);
    return {
      metric,
      method,
      years,
      percentage: percentage2,
      available: percentage2 !== null,
      latestFiscalYear: latest.fiscalYear,
      comparisonFiscalYear: comparison.fiscalYear,
      latestDate: latest.date,
      comparisonDate: comparison.date,
      latestValue: latest.value,
      comparisonValue: comparison.value,
      reason: percentage2 === null ? "Growth requires a non-zero comparison value." : null
    };
  }
  const result = calculateCagr(comparison.value, latest.value, years);
  return {
    metric,
    method,
    years,
    percentage: result.percentage,
    totalChangePercentage: result.totalChangePercentage ?? null,
    available: result.available,
    latestFiscalYear: latest.fiscalYear,
    comparisonFiscalYear: comparison.fiscalYear,
    latestDate: latest.date,
    comparisonDate: comparison.date,
    latestValue: latest.value,
    comparisonValue: comparison.value,
    reason: result.reason
  };
}
__name(calculateGrowthForPeriod, "calculateGrowthForPeriod");
function summariseGrowthSeries(series = [], options = {}) {
  return {
    oneYear: calculateGrowthForPeriod(series, 1, options),
    threeYears: calculateGrowthForPeriod(series, 3, options),
    fiveYears: calculateGrowthForPeriod(series, 5, options),
    tenYears: calculateGrowthForPeriod(series, 10, options)
  };
}
__name(summariseGrowthSeries, "summariseGrowthSeries");
function buildGrowthAnalysis(metricSeries = {}) {
  const output = {};
  for (const [key, config] of Object.entries(metricSeries)) {
    const series = normaliseSeries(config?.series || []);
    output[key] = {
      label: config?.label || key,
      unit: config?.unit || null,
      latest: series.at(-1) || null,
      growth: summariseGrowthSeries(series, { metric: key }),
      annualSeries: series.slice(-15)
    };
  }
  return output;
}
__name(buildGrowthAnalysis, "buildGrowthAnalysis");

// src/services/historical.js
function sortByFiscalYear(rows = []) {
  return [...Array.isArray(rows) ? rows : []].filter((row) => Number.isFinite(Number(row?.fiscalYear))).sort((a, b) => Number(a.fiscalYear) - Number(b.fiscalYear));
}
__name(sortByFiscalYear, "sortByFiscalYear");
function compactSummary(summary = {}) {
  const readPercentage = /* @__PURE__ */ __name((value) => {
    if (value === null || value === void 0) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const percentage2 = toFiniteNumber(value?.percentage);
    return percentage2;
  }, "readPercentage");
  return {
    oneYear: readPercentage(summary.oneYear),
    threeYears: readPercentage(summary.threeYears),
    fiveYears: readPercentage(summary.fiveYears),
    tenYears: readPercentage(summary.tenYears)
  };
}
__name(compactSummary, "compactSummary");
function buildAnnualRevenueHistory(annualSeries = []) {
  const rows = sortByFiscalYear(annualSeries);
  return rows.map((row, index) => {
    const revenue = toFiniteNumber(row?.revenue ?? row?.value);
    const previousRevenue = index > 0 ? toFiniteNumber(rows[index - 1]?.revenue ?? rows[index - 1]?.value) : null;
    return {
      fiscalYear: Number(row.fiscalYear),
      date: row.date || null,
      revenue,
      revenueBillions: revenue === null ? null : revenue / 1e9,
      growthPercentage: previousRevenue === null ? null : percentageChange(previousRevenue, revenue),
      source: row.source || null
    };
  });
}
__name(buildAnnualRevenueHistory, "buildAnnualRevenueHistory");
function buildAnnualNetMarginHistory(annualSeries = []) {
  return sortByFiscalYear(annualSeries).map((row) => {
    const revenue = toFiniteNumber(row?.revenue);
    const netIncome = toFiniteNumber(row?.netIncome);
    const suppliedMargin = toFiniteNumber(row?.netMarginPercentage);
    return {
      fiscalYear: Number(row.fiscalYear),
      date: row.date || null,
      revenue,
      revenueBillions: revenue === null ? null : revenue / 1e9,
      netIncome,
      netIncomeBillions: netIncome === null ? null : netIncome / 1e9,
      marginPercentage: suppliedMargin ?? (revenue !== null && revenue !== 0 && netIncome !== null ? netIncome / revenue * 100 : null)
    };
  });
}
__name(buildAnnualNetMarginHistory, "buildAnnualNetMarginHistory");
function buildAnnualFcfMarginHistory(annualSeries = []) {
  return sortByFiscalYear(annualSeries).map((row) => {
    const revenue = toFiniteNumber(row?.revenue);
    const operatingCashFlow = toFiniteNumber(row?.operatingCashFlow);
    const capitalExpenditures = toFiniteNumber(row?.capitalExpenditures);
    const freeCashFlow = toFiniteNumber(row?.freeCashFlow);
    const suppliedMargin = toFiniteNumber(row?.fcfMarginPercentage);
    return {
      fiscalYear: Number(row.fiscalYear),
      date: row.date || null,
      revenue,
      revenueBillions: revenue === null ? null : revenue / 1e9,
      operatingCashFlow,
      operatingCashFlowBillions: operatingCashFlow === null ? null : operatingCashFlow / 1e9,
      capitalExpenditures,
      capitalExpendituresBillions: capitalExpenditures === null ? null : capitalExpenditures / 1e9,
      freeCashFlow,
      freeCashFlowBillions: freeCashFlow === null ? null : freeCashFlow / 1e9,
      marginPercentage: suppliedMargin ?? (revenue !== null && revenue !== 0 && freeCashFlow !== null ? freeCashFlow / revenue * 100 : null)
    };
  });
}
__name(buildAnnualFcfMarginHistory, "buildAnnualFcfMarginHistory");
function growthSummaryFromAnnual(rows = [], valueKey) {
  const clean = sortByFiscalYear(rows).map((row) => ({ fiscalYear: Number(row.fiscalYear), value: toFiniteNumber(row?.[valueKey]) })).filter((row) => Number.isFinite(row.fiscalYear) && row.value !== null);
  if (clean.length < 2) {
    return { oneYear: null, threeYears: null, fiveYears: null, tenYears: null };
  }
  const latest = clean.at(-1);
  const byYear = new Map(clean.map((row) => [row.fiscalYear, row.value]));
  const calculate = /* @__PURE__ */ __name((years) => {
    const previous = byYear.get(latest.fiscalYear - years);
    if (previous === void 0 || previous === 0 || latest.value === 0) return null;
    if (years === 1) return percentageChange(previous, latest.value);
    if (previous < 0 || latest.value < 0) return null;
    return (Math.pow(latest.value / previous, 1 / years) - 1) * 100;
  }, "calculate");
  return {
    oneYear: calculate(1),
    threeYears: calculate(3),
    fiveYears: calculate(5),
    tenYears: calculate(10)
  };
}
__name(growthSummaryFromAnnual, "growthSummaryFromAnnual");
function buildQuarterlyGrowth(rows = [], valueKey) {
  const clean = [...Array.isArray(rows) ? rows : []].map((row) => ({ ...row, date: String(row?.date || "").slice(0, 10), value: toFiniteNumber(row?.[valueKey]) })).filter((row) => row.date && row.value !== null).sort((a, b) => a.date.localeCompare(b.date));
  return clean.map((row, index) => {
    const priorYear = index >= 4 ? clean[index - 4].value : null;
    return {
      ...row,
      growthPercentage: priorYear === null || priorYear === 0 ? null : percentageChange(priorYear, row.value)
    };
  });
}
__name(buildQuarterlyGrowth, "buildQuarterlyGrowth");
function buildHistoricalCalculatorData({
  revenueHistory,
  netMarginHistory,
  fcfMarginHistory,
  returnsHistory
} = {}) {
  const revenueAnnual = buildAnnualRevenueHistory(revenueHistory?.annualSeries).slice(-15);
  const revenueQuarterly = buildQuarterlyGrowth(revenueHistory?.quarterlySeries, "revenue").map((row) => ({ ...row, revenueBillions: row.value / 1e9 })).slice(-48);
  const netMarginAnnual = buildAnnualNetMarginHistory(netMarginHistory?.annualSeries).slice(-15);
  const netMarginQuarterly = buildQuarterlyGrowth(netMarginHistory?.quarterlySeries, "netIncome").map((row) => ({
    ...row,
    revenue: toFiniteNumber(row.revenue),
    revenueBillions: toFiniteNumber(row.revenueBillions),
    netIncome: toFiniteNumber(row.netIncome),
    netIncomeBillions: toFiniteNumber(row.netIncomeBillions),
    marginPercentage: toFiniteNumber(row.netMarginPercentage)
  })).slice(-48);
  const fcfMarginAnnual = buildAnnualFcfMarginHistory(fcfMarginHistory?.annualSeries).slice(-15);
  const roicAnnual = sortByFiscalYear(returnsHistory?.annualSeries).map((row) => ({
    fiscalYear: Number(row.fiscalYear),
    date: row.date || null,
    roicPercentage: toFiniteNumber(row.roicPercentage),
    netIncome: toFiniteNumber(row.netIncome),
    investedCapital: toFiniteNumber(row.investedCapital),
    equity: toFiniteNumber(row.equity),
    finvizStyleLongTermDebt: toFiniteNumber(row.finvizStyleLongTermDebt),
    operatingLeaseLiabilitiesNonCurrent: toFiniteNumber(row.operatingLeaseLiabilitiesNonCurrent)
  })).filter((row) => row.roicPercentage !== null).slice(-15);
  const returnAverages = returnsHistory?.summary?.averages?.roic || {};
  const roicSummary = {
    oneYear: toFiniteNumber(returnsHistory?.summary?.latest?.roicPercentage),
    threeYears: toFiniteNumber(returnAverages?.threeYears?.percentage),
    fiveYears: toFiniteNumber(returnAverages?.fiveYears?.percentage),
    tenYears: toFiniteNumber(returnAverages?.tenYears?.percentage)
  };
  return {
    revenueGrowth: {
      label: "Revenue Growth",
      summary: compactSummary(revenueHistory?.historicalRevenueGrowth),
      annual: revenueAnnual,
      quarterly: revenueQuarterly
    },
    netIncomeGrowth: {
      label: "Net Income Growth",
      summary: growthSummaryFromAnnual(netMarginAnnual, "netIncome"),
      annual: netMarginAnnual.map((row, index, rows) => ({
        ...row,
        growthPercentage: index === 0 ? null : percentageChange(rows[index - 1].netIncome, row.netIncome)
      })),
      quarterly: netMarginQuarterly
    },
    freeCashFlowGrowth: {
      label: "Free Cash Flow Growth",
      summary: growthSummaryFromAnnual(fcfMarginAnnual, "freeCashFlow"),
      annual: fcfMarginAnnual.map((row, index, rows) => ({
        ...row,
        growthPercentage: index === 0 ? null : percentageChange(rows[index - 1].freeCashFlow, row.freeCashFlow)
      }))
    },
    netMargin: {
      label: "Net Margin",
      summary: compactSummary(netMarginHistory?.historicalNetMargins),
      annual: netMarginAnnual,
      quarterly: netMarginQuarterly
    },
    fcfMargin: {
      label: "FCF Margin",
      summary: compactSummary(fcfMarginHistory?.historicalFcfMargins),
      annual: fcfMarginAnnual
    },
    roic: {
      label: "ROIC",
      summary: roicSummary,
      annual: roicAnnual
    }
  };
}
__name(buildHistoricalCalculatorData, "buildHistoricalCalculatorData");

// src/services/company.js
function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
__name(finiteOrNull, "finiteOrNull");
function buildCompanyOverview({
  ticker,
  quote,
  revenueTtm,
  netIncomeTtm,
  freeCashFlowTtm,
  cash,
  totalDebt,
  sharesOutstanding,
  balanceDate,
  incomeQuarterDates,
  cashFlowDate
}) {
  const price = finiteOrNull(quote?.price ?? quote?.regularMarketPrice);
  const shares = finiteOrNull(sharesOutstanding);
  const marketCap = price !== null && shares !== null && shares > 0 ? price * shares : null;
  const enterpriseValue = marketCap !== null ? marketCap + (finiteOrNull(totalDebt) ?? 0) - (finiteOrNull(cash) ?? 0) : null;
  return {
    ticker,
    companyName: quote?.companyName || quote?.longName || quote?.shortName || ticker,
    exchange: quote?.exchangeLabel || quote?.exchangeCode || null,
    currency: quote?.currency || "USD",
    price,
    marketCap,
    enterpriseValue,
    revenueTtm: finiteOrNull(revenueTtm),
    netIncomeTtm: finiteOrNull(netIncomeTtm),
    freeCashFlowTtm: finiteOrNull(freeCashFlowTtm),
    cash: finiteOrNull(cash),
    totalDebt: finiteOrNull(totalDebt),
    sharesOutstanding: shares,
    asOf: {
      balanceSheet: balanceDate || null,
      incomeQuarters: Array.isArray(incomeQuarterDates) ? incomeQuarterDates : [],
      cashFlow: cashFlowDate || null
    },
    methodology: {
      marketCap: "Current Yahoo price multiplied by the latest reported shares outstanding.",
      enterpriseValue: "Market capitalisation plus total debt minus cash and short-term investments.",
      revenueTtm: "Sum of the latest four reported quarterly revenue values.",
      netIncomeTtm: "Sum of the latest four reported quarterly net-income values.",
      freeCashFlowTtm: "Yahoo trailing operating cash flow minus the absolute value of trailing capital expenditures."
    }
  };
}
__name(buildCompanyOverview, "buildCompanyOverview");

// src/index.js
var VERSION = "stock-valuation-worker-v21-r2-all-pages-2026-07-30";
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Expose-Headers": "X-Worker-Version"
};
var src_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/data/")) {
        return servePreparedData(request, env, ctx, url);
      }
      if (url.pathname === "/" && url.searchParams.size === 0) {
        return htmlResponse(LAB_HTML);
      }
      if (url.searchParams.has("health")) {
        const result = await runDoltQuery("SELECT 1 AS ok");
        return jsonResponse({
          ok: true,
          version: VERSION,
          doltCommitRef: result.commit_ref || null,
          doltReachable: Array.isArray(result.rows)
        });
      }
      if (url.searchParams.has("schema")) {
        const table = validateTable(url.searchParams.get("schema"));
        const result = await runDoltQuery(`DESCRIBE \`${table}\``);
        return jsonResponse({ ok: true, version: VERSION, table, ...result });
      }
      if (url.searchParams.has("tables")) {
        const result = await runDoltQuery("SHOW TABLES");
        return jsonResponse({ ok: true, version: VERSION, ...result });
      }
      if (url.searchParams.has("search")) {
        const query = String(url.searchParams.get("search") || "").trim();
        return jsonResponse(await searchYahooEquities(query, { version: VERSION, createError }));
      }
      if (url.searchParams.has("quote") || url.searchParams.has("priceTicker")) {
        const ticker = normaliseTicker(url.searchParams.get("quote") || url.searchParams.get("priceTicker"));
        return jsonResponse(await fetchYahooQuote(ticker, { version: VERSION, createError }));
      }
      if (url.searchParams.has("financials")) {
        const ticker = normaliseTicker(url.searchParams.get("financials"));
        const prepared = await preparedEndpoint(env, ticker, "financials");
        return jsonResponse(prepared || await fetchCoreFinancials(ticker));
      }
      if (url.searchParams.has("company")) {
        const ticker = normaliseTicker(url.searchParams.get("company"));
        const prepared = await preparedEndpoint(env, ticker, "company");
        return jsonResponse(prepared || await fetchCompanyOverview(ticker));
      }
      if (url.searchParams.has("returns")) {
        const ticker = normaliseTicker(url.searchParams.get("returns"));
        const prepared = await preparedEndpoint(env, ticker, "returns");
        return jsonResponse(prepared || await calculateReturnsHistory(ticker));
      }
      if (url.searchParams.has("growth")) {
        const ticker = normaliseTicker(url.searchParams.get("growth"));
        const prepared = await preparedEndpoint(env, ticker, "growth");
        return jsonResponse(prepared || await calculateGrowthHistory(ticker));
      }
      if (url.searchParams.has("history")) {
        const ticker = normaliseTicker(url.searchParams.get("history"));
        const prepared = await preparedEndpoint(env, ticker, "history");
        return jsonResponse(prepared || await calculateHistoricalCalculatorHistory(ticker));
      }
      if (url.searchParams.has("q")) {
        const sql = validateReadOnlySql(url.searchParams.get("q"));
        const result = await runDoltQuery(sql);
        return jsonResponse({ ok: true, version: VERSION, ...result });
      }
      if (url.searchParams.has("dashboard")) {
        const ticker = normaliseTicker(url.searchParams.get("dashboard"));
        const prepared = await preparedEndpoint(env, ticker, "dashboard");
        return jsonResponse(prepared || await buildDashboardMetrics(ticker));
      }
      if (url.searchParams.has("inspect")) {
        const ticker = normaliseTicker(url.searchParams.get("inspect"));
        const payload = await inspectTicker(ticker);
        return jsonResponse(payload);
      }
      if (url.searchParams.has("revenueHistory")) {
        const ticker = normaliseTicker(url.searchParams.get("revenueHistory"));
        const payload = await calculateRevenueHistory(ticker);
        return jsonResponse(payload);
      }
      if (url.searchParams.has("netMarginHistory")) {
        const ticker = normaliseTicker(url.searchParams.get("netMarginHistory"));
        const payload = await calculateNetMarginHistory(ticker);
        return jsonResponse(payload);
      }
      if (url.searchParams.has("cashFlowValidation")) {
        const ticker = normaliseTicker(url.searchParams.get("cashFlowValidation"));
        const payload = await buildCashFlowValidation(ticker);
        return jsonResponse(payload);
      }
      if (url.searchParams.has("fcfMarginHistory")) {
        const ticker = normaliseTicker(url.searchParams.get("fcfMarginHistory"));
        const payload = await calculateFcfMarginHistory(ticker);
        return jsonResponse(payload);
      }
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: "Use ?search=apple, ?quote=AAPL, ?company=AAPL, ?financials=AAPL, ?dashboard=AAPL, ?returns=AAPL, ?growth=AAPL, ?history=AAPL, ?q=SELECT..., or the individual metric routes."
      }, 400);
    } catch (error) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: error.message || "Unknown error",
        details: error.details || null,
        debug: {
          name: error?.name || null,
          stack: String(error?.stack || "").split("\n").slice(0, 8)
        }
      }, error.status || 500);
    }
  }
};
async function preparedEndpoint(env, ticker, section) {
  if (!env?.COMPANY_DATA) return null;
  const object = await env.COMPANY_DATA.get(`companies/${ticker}.json`);
  if (!object) return null;
  try {
    const snapshot = await object.json();
    return snapshot?.prepared?.[section] || null;
  } catch {
    return null;
  }
}
__name(preparedEndpoint, "preparedEndpoint");
async function servePreparedData(request, env, ctx, url) {
  if (!env?.COMPANY_DATA) {
    return jsonResponse({ ok: false, version: VERSION, error: "R2 company data binding is unavailable." }, 503);
  }
  const name = decodeURIComponent(url.pathname.slice("/data/".length));
  if (!/^(?:[A-Z0-9._-]{1,40}\.json|manifest\.json|tickers\.json)$/i.test(name)) {
    return jsonResponse({ ok: false, version: VERSION, error: "Invalid prepared-data object name." }, 400);
  }
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const object = await env.COMPANY_DATA.get(`companies/${name}`);
  if (!object) {
    return jsonResponse({ ok: false, version: VERSION, error: "Prepared company data is unavailable." }, 404);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", name === "manifest.json" ? "public, max-age=60, s-maxage=300" : "public, max-age=300, s-maxage=3600");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Worker-Version", VERSION);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  if (request.headers.get("If-None-Match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  const response = new Response(object.body, { status: 200, headers });
  if (request.method === "GET") ctx?.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
__name(servePreparedData, "servePreparedData");
function validateReadOnlySql(value) {
  const sql = String(value || "").trim();
  if (!sql) throw createError(400, "Missing q query parameter.");
  if (sql.length > 1e4) throw createError(413, "SQL query is too long.");
  const withoutTrailingSemicolon = sql.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw createError(400, "Only one SQL statement is allowed.");
  }
  if (!/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i.test(sql)) {
    throw createError(400, "Only read-only Dolt SQL is allowed.");
  }
  return sql;
}
__name(validateReadOnlySql, "validateReadOnlySql");
async function fetchCoreFinancials(ticker) {
  const revenueSql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` DESC LIMIT 4`;
  const sharesSql = `SELECT shares_outstanding, \`date\`, period FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} AND shares_outstanding IS NOT NULL ORDER BY \`date\` DESC LIMIT 10`;
  const [revenueResult, sharesResult, returnsResult, growthResult] = await Promise.all([
    runDoltQuery(revenueSql),
    runDoltQuery(sharesSql),
    calculateReturnsHistory(ticker).catch((error) => ({
      ok: false,
      supported: false,
      error: error.message || "Return metrics are unavailable."
    })),
    calculateGrowthHistory(ticker).catch((error) => ({
      ok: false,
      supported: false,
      error: error.message || "Growth metrics are unavailable."
    }))
  ]);
  const revenueRows = Array.isArray(revenueResult.rows) ? revenueResult.rows : [];
  const revenue = calculateTtmRevenue(revenueRows);
  const shareRow = (Array.isArray(sharesResult.rows) ? sharesResult.rows : []).find((row) => Number.isFinite(parseNumber(row.shares_outstanding)) && parseNumber(row.shares_outstanding) > 0);
  const shares = shareRow ? parseNumber(shareRow.shares_outstanding) : null;
  return {
    ok: true,
    version: VERSION,
    ticker,
    revenueTtmBillion: revenue > 0 ? revenue / 1e9 : null,
    sharesOutstandingBillion: shares > 0 ? shares / 1e9 : null,
    hasRevenue: revenueRows.length === 4 && revenue > 0,
    hasShares: Number.isFinite(shares) && shares > 0,
    returns: returnsResult,
    growth: growthResult,
    diagnostics: {
      revenueQuarterDates: revenueRows.map((row) => String(row.date || "").slice(0, 10)),
      sharesDate: shareRow ? String(shareRow.date || "").slice(0, 10) : null,
      commitRef: revenueResult.commit_ref || sharesResult.commit_ref || null
    }
  };
}
__name(fetchCoreFinancials, "fetchCoreFinancials");
async function fetchCompanyOverview(ticker) {
  const fields = await resolveReturnFields();
  const sharesColumn = chooseColumn(fields.availableEquityColumns || [], [
    "shares_outstanding",
    "weighted_average_number_of_diluted_shares_outstanding",
    "weighted_average_number_of_shares_outstanding_basic"
  ]);
  const equitySelect = [
    sharesColumn ? `${quoteIdentifier(sharesColumn)} AS shares_outstanding` : "CAST(NULL AS DOUBLE) AS shares_outstanding",
    "`date`",
    "period"
  ].join(", ");
  const assetsSelect = [
    sumColumnsSql(fields.cashColumns, "cash"),
    "`date`",
    "period"
  ].join(", ");
  const incomeSql = `SELECT sales, net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` DESC LIMIT 4`;
  const equitySql = `SELECT ${equitySelect} FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;
  const assetsSql = `SELECT ${assetsSelect} FROM \`balance_sheet_assets\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;
  const [quote, incomeResult, equityResult, assetsResult, cashFlowResult, yahooBalance, returnsResult] = await Promise.all([
    fetchYahooQuote(ticker, { version: VERSION, createError }),
    runDoltQuery(incomeSql),
    runDoltQuery(equitySql),
    runDoltQuery(assetsSql),
    fetchYahooTtmCashFlow(ticker, { createError, parseNumber }).catch(() => null),
    fetchYahooBalanceSnapshot(ticker, { createError, parseNumber }).catch(() => null),
    calculateReturnsHistory(ticker).catch(() => null)
  ]);
  const incomeRows = Array.isArray(incomeResult.rows) ? incomeResult.rows : [];
  const revenueTtm = incomeRows.reduce((sum, row) => sum + (parseNumberOrNull(row.sales) ?? 0), 0);
  const netIncomeTtm = incomeRows.reduce((sum, row) => sum + (parseNumberOrNull(row.net_income) ?? 0), 0);
  const completeIncomeTtm = incomeRows.length === 4;
  const equityRows = Array.isArray(equityResult.rows) ? equityResult.rows : [];
  const assetsRows = Array.isArray(assetsResult.rows) ? assetsResult.rows : [];
  const equityRow = equityRows.find((row) => {
    const shares = parseNumberOrNull(row.shares_outstanding);
    return shares !== null && shares > 0;
  }) || null;
  const assetsRow = assetsRows.find((row) => parseNumberOrNull(row.cash) !== null) || null;
  const totalDebt = parseNumberOrNull(yahooBalance?.totalDebt);
  const cash = parseNumberOrNull(yahooBalance?.cash) ?? (assetsRow ? parseNumberOrNull(assetsRow.cash) : null);
  const sharesOutstanding = parseNumberOrNull(yahooBalance?.sharesOutstanding) ?? (equityRow ? parseNumberOrNull(equityRow.shares_outstanding) : null);
  const overview = buildCompanyOverview({
    ticker,
    quote,
    revenueTtm: completeIncomeTtm ? revenueTtm : null,
    netIncomeTtm: completeIncomeTtm ? netIncomeTtm : null,
    freeCashFlowTtm: cashFlowResult?.freeCashFlow ?? null,
    cash,
    totalDebt,
    sharesOutstanding,
    balanceDate: yahooBalance?.debtAsOfDate || (equityRow ? String(equityRow.date || "").slice(0, 10) : assetsRow ? String(assetsRow.date || "").slice(0, 10) : null),
    incomeQuarterDates: incomeRows.map((row) => String(row.date || "").slice(0, 10)),
    cashFlowDate: cashFlowResult?.asOfDate || null
  });
  return {
    ok: true,
    version: VERSION,
    ...overview,
    roic: returnsResult?.summary?.latest?.roicPercentage ?? null,
    roicFiscalYear: returnsResult?.summary?.latest?.fiscalYear ?? null,
    availability: {
      quote: Number.isFinite(overview.price),
      marketCap: Number.isFinite(overview.marketCap),
      enterpriseValue: Number.isFinite(overview.enterpriseValue),
      revenueTtm: Number.isFinite(overview.revenueTtm),
      netIncomeTtm: Number.isFinite(overview.netIncomeTtm),
      freeCashFlowTtm: Number.isFinite(overview.freeCashFlowTtm),
      totalDebt: Number.isFinite(overview.totalDebt),
      sharesOutstanding: Number.isFinite(overview.sharesOutstanding),
      roic: Number.isFinite(returnsResult?.summary?.latest?.roicPercentage)
    },
    fields: {
      sharesOutstanding: yahooBalance?.sharesType || sharesColumn,
      totalDebt: yahooBalance?.debtType || null,
      cashForEnterpriseValue: yahooBalance?.cashType || fields.cashColumns
    },
    diagnostics: {
      yahooTotalDebtRaw: yahooBalance?.totalDebt ?? null,
      yahooTotalDebtType: yahooBalance?.debtType ?? null,
      yahooTotalDebtAsOfDate: yahooBalance?.debtAsOfDate ?? null,
      yahooCurrentDebtRaw: yahooBalance?.currentDebt ?? null,
      yahooLongTermDebtRaw: yahooBalance?.longTermDebt ?? null,
      yahooDebtFallbackUsed: yahooBalance?.debtFallbackUsed ?? null
    },
    source: {
      quote: "Yahoo Finance chart API",
      totalDebt: yahooBalance ? "Yahoo Finance fundamentals timeseries" : null,
      financialStatements: "DoltHub earnings database",
      trailingCashFlow: cashFlowResult ? "Yahoo Finance fundamentals timeseries" : null,
      commitRef: incomeResult.commit_ref || equityResult.commit_ref || assetsResult.commit_ref || null
    }
  };
}
__name(fetchCompanyOverview, "fetchCompanyOverview");
async function buildDashboardMetrics(ticker) {
  const [revenueResult, marginResult, fcfResult, returnsResult, growthResult] = await Promise.allSettled([
    calculateRevenueHistory(ticker),
    calculateNetMarginHistory(ticker),
    calculateFcfMarginHistory(ticker),
    calculateReturnsHistory(ticker),
    calculateGrowthHistory(ticker)
  ]);
  const revenue = revenueResult.status === "fulfilled" ? revenueResult.value : null;
  const margin = marginResult.status === "fulfilled" ? marginResult.value : null;
  const fcf = fcfResult.status === "fulfilled" ? fcfResult.value : null;
  const returns = returnsResult.status === "fulfilled" ? returnsResult.value : null;
  const growth = growthResult.status === "fulfilled" ? growthResult.value : null;
  return {
    ok: true,
    version: VERSION,
    ticker,
    ...buildDashboardMetricGroups(revenue, margin, fcf),
    returns: returns?.summary || null,
    growth: growth?.metrics || null,
    errors: [
      revenueResult.status === "rejected" ? `Revenue growth: ${revenueResult.reason?.message || "failed"}` : null,
      marginResult.status === "rejected" ? `Net margin: ${marginResult.reason?.message || "failed"}` : null,
      fcfResult.status === "rejected" ? `FCF margin: ${fcfResult.reason?.message || "failed"}` : null,
      returnsResult.status === "rejected" ? `Returns: ${returnsResult.reason?.message || "failed"}` : null,
      growthResult.status === "rejected" ? `Growth: ${growthResult.reason?.message || "failed"}` : null
    ].filter(Boolean)
  };
}
__name(buildDashboardMetrics, "buildDashboardMetrics");
async function inspectTicker(ticker) {
  const queries = {
    incomeSchema: "DESCRIBE `income_statement`",
    balanceSchema: "DESCRIBE `balance_sheet_equity`",
    cashFlowSchema: "DESCRIBE `cash_flow_statement`",
    incomeRows: `SELECT * FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 6`,
    balanceRows: `SELECT * FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 3`,
    cashFlowRows: `SELECT * FROM \`cash_flow_statement\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 6`
  };
  const entries = await Promise.allSettled(
    Object.entries(queries).map(async ([key, sql]) => [key, await runDoltQuery(sql)])
  );
  const data = {};
  const errors = [];
  for (const result of entries) {
    if (result.status === "fulfilled") {
      const [key, value] = result.value;
      data[key] = value;
    } else {
      errors.push(result.reason?.message || "Unknown inspection error");
    }
  }
  return {
    ok: errors.length === 0,
    version: VERSION,
    ticker,
    data,
    candidateColumns: detectCandidateColumns(data),
    errors
  };
}
__name(inspectTicker, "inspectTicker");
function detectCandidateColumns(data) {
  const allColumns = {
    income_statement: extractDescribeColumns(data.incomeSchema),
    balance_sheet_equity: extractDescribeColumns(data.balanceSchema),
    cash_flow_statement: extractDescribeColumns(data.cashFlowSchema)
  };
  const candidateGroups = {
    revenue: ["sales", "revenue", "revenues", "total_revenue"],
    netIncome: ["net_income_loss", "net_income", "profit_loss", "net_income_available_to_common_stockholders_basic"],
    operatingIncome: ["operating_income_loss", "operating_income", "income_after_depreciation_and_amortization", "income_from_operations", "operating_profit"],
    taxExpense: ["income_tax_expense_benefit", "income_tax_expense"],
    operatingCashFlow: ["net_cash_provided_by_used_in_operating_activities", "operating_cash_flow", "cash_from_operations"],
    capitalExpenditure: ["payments_to_acquire_property_plant_and_equipment", "capital_expenditures", "capital_expenditure"],
    cash: ["cash_and_cash_equivalents_at_carrying_value", "cash_and_cash_equivalents"],
    debt: ["long_term_debt_current", "long_term_debt_noncurrent", "long_term_debt"],
    equity: ["stockholders_equity", "shareholders_equity"],
    shares: ["shares_outstanding", "common_stock_shares_outstanding"]
  };
  const found = {};
  for (const [metric, candidates] of Object.entries(candidateGroups)) {
    found[metric] = [];
    for (const [table, columns] of Object.entries(allColumns)) {
      for (const candidate of candidates) {
        if (columns.includes(candidate)) found[metric].push({ table, column: candidate });
      }
    }
  }
  return { allColumns, found };
}
__name(detectCandidateColumns, "detectCandidateColumns");
function extractDescribeColumns(result) {
  const rows = result?.rows || [];
  return rows.map((row) => row.Field || row.field || row.COLUMN_NAME || row.column_name || Object.values(row)[0]).filter(Boolean).map(String);
}
__name(extractDescribeColumns, "extractDescribeColumns");
async function calculateRevenueHistory(ticker) {
  const quarterlySql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` ASC LIMIT 160`;
  const annualSql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' AND sales IS NOT NULL ORDER BY \`date\` ASC LIMIT 40`;
  const [quarterlyResult, annualResult] = await Promise.all([
    runDoltQuery(quarterlySql),
    runDoltQuery(annualSql)
  ]);
  const quarterlyRows = Array.isArray(quarterlyResult.rows) ? quarterlyResult.rows : [];
  const annualRowsRaw = Array.isArray(annualResult.rows) ? annualResult.rows : [];
  const { quarters, ttmSeries, reportedAnnualSeries, annualSeries, reconstructedAnnualYears } = buildRevenueSeries(quarterlyRows, annualRowsRaw);
  const latestTTM = ttmSeries.at(-1) || null;
  const latestFiscalYear = annualSeries.at(-1) || null;
  const metrics = {
    oneYear: latestTTM ? ttmGrowthAgainstOneYearAgo(ttmSeries, latestTTM) : null,
    threeYears: latestFiscalYear ? fiscalYearCagr(annualSeries, latestFiscalYear, 3) : null,
    fiveYears: latestFiscalYear ? fiscalYearCagr(annualSeries, latestFiscalYear, 5) : null,
    tenYears: latestFiscalYear ? fiscalYearCagr(annualSeries, latestFiscalYear, 10) : null
  };
  return {
    ok: Boolean(latestTTM && latestFiscalYear),
    version: VERSION,
    ticker,
    methodology: {
      currentRevenue: "Latest trailing twelve months: sum of the latest four reported quarters.",
      oneYearGrowth: "Latest TTM revenue compared with TTM revenue ending one year earlier.",
      longTermGrowth: "3-, 5-, and 10-year CAGR calculated from reported fiscal-year revenue."
    },
    source: {
      api: "DoltHub v1alpha1 default branch",
      quarterlyCommitRef: quarterlyResult.commit_ref || null,
      annualCommitRef: annualResult.commit_ref || null,
      quarterlyQuery: quarterlySql,
      annualQuery: annualSql
    },
    rowsReceived: {
      quarterly: quarterlyRows.length,
      annual: annualRowsRaw.length
    },
    uniquePeriods: {
      quarters: quarters.length,
      fiscalYears: annualSeries.length,
      reportedFiscalYears: reportedAnnualSeries.length,
      reconstructedFiscalYears: reconstructedAnnualYears
    },
    latestTTM,
    latestFiscalYear,
    historicalRevenueGrowth: metrics,
    annualSeries: annualSeries.slice(-15),
    quarterlySeries: quarters.slice(-48).map((row) => ({
      date: row.date,
      revenue: row.sales,
      revenueBillions: row.sales / 1e9
    })),
    ttmSeries: ttmSeries.slice(-44)
  };
}
__name(calculateRevenueHistory, "calculateRevenueHistory");
async function calculateNetMarginHistory(ticker) {
  const quarterlySql = `SELECT sales, net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL AND net_income IS NOT NULL ORDER BY \`date\` ASC LIMIT 160`;
  const annualSql = `SELECT sales, net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' AND sales IS NOT NULL AND net_income IS NOT NULL ORDER BY \`date\` ASC LIMIT 40`;
  const [quarterlyResult, annualResult] = await Promise.all([
    runDoltQuery(quarterlySql),
    runDoltQuery(annualSql)
  ]);
  const quarterlyRows = Array.isArray(quarterlyResult.rows) ? quarterlyResult.rows : [];
  const annualRows = Array.isArray(annualResult.rows) ? annualResult.rows : [];
  const { quarters, ttmSeries, annualSeries } = buildNetMarginSeries(quarterlyRows, annualRows);
  const latestTTM = ttmSeries.at(-1) || null;
  const margins = {
    oneYear: latestTTM ? {
      method: "latest TTM net margin",
      percentage: latestTTM.netMarginPercentage,
      endDate: latestTTM.endDate,
      revenueBillions: latestTTM.revenueBillions,
      netIncomeBillions: latestTTM.netIncomeBillions,
      quarterDates: latestTTM.quarterDates
    } : null,
    threeYears: calculateWeightedNetMargin(annualSeries, 3),
    fiveYears: calculateWeightedNetMargin(annualSeries, 5),
    tenYears: calculateWeightedNetMargin(annualSeries, 10)
  };
  return {
    ok: Boolean(latestTTM && annualSeries.length > 0),
    version: VERSION,
    ticker,
    methodology: {
      oneYear: "Latest TTM net income divided by latest TTM revenue.",
      longTerm: "Total fiscal-year net income divided by total fiscal-year revenue over the latest 3, 5, or 10 completed fiscal years."
    },
    historicalNetMargins: margins,
    latestTTM,
    annualSeries: annualSeries.slice(-15),
    quarterlySeries: quarters.slice(-48).map((row) => ({
      date: row.date,
      revenue: row.revenue,
      revenueBillions: row.revenue / 1e9,
      netIncome: row.netIncome,
      netIncomeBillions: row.netIncome / 1e9,
      netMarginPercentage: row.revenue ? row.netIncome / row.revenue * 100 : null
    })),
    rowsReceived: { quarterly: quarterlyRows.length, annual: annualRows.length },
    source: {
      api: "DoltHub v1alpha1 default branch",
      quarterlyCommitRef: quarterlyResult.commit_ref || null,
      annualCommitRef: annualResult.commit_ref || null,
      quarterlyQuery: quarterlySql,
      annualQuery: annualSql
    }
  };
}
__name(calculateNetMarginHistory, "calculateNetMarginHistory");
async function buildCashFlowValidation(ticker) {
  const operatingCashFlowColumn = "net_cash_from_operating_activities";
  const propertyAndEquipmentColumn = "property_and_equipment";
  const sql = `SELECT \`date\`, period, \`${operatingCashFlowColumn}\` AS operating_cash_flow, \`${propertyAndEquipmentColumn}\` AS property_and_equipment FROM \`cash_flow_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND \`${operatingCashFlowColumn}\` IS NOT NULL AND \`${propertyAndEquipmentColumn}\` IS NOT NULL ORDER BY \`date\` DESC LIMIT 15`;
  const result = await runDoltQuery(sql);
  const rows = (Array.isArray(result.rows) ? result.rows : []).map((row) => {
    const operatingCashFlow = parseNumber(row.operating_cash_flow);
    const propertyAndEquipmentRaw = parseNumber(row.property_and_equipment);
    const capitalExpenditures = Math.abs(propertyAndEquipmentRaw);
    const freeCashFlow = operatingCashFlow - capitalExpenditures;
    return {
      date: String(row.date || "").slice(0, 10),
      fiscalYear: Number(String(row.date || "").slice(0, 4)),
      period: String(row.period || ""),
      operatingCashFlow,
      operatingCashFlowBillions: Number.isFinite(operatingCashFlow) ? operatingCashFlow / 1e9 : null,
      propertyAndEquipmentRaw,
      propertyAndEquipmentRawBillions: Number.isFinite(propertyAndEquipmentRaw) ? propertyAndEquipmentRaw / 1e9 : null,
      capitalExpenditures,
      capitalExpendituresBillions: Number.isFinite(capitalExpenditures) ? capitalExpenditures / 1e9 : null,
      freeCashFlow,
      freeCashFlowBillions: Number.isFinite(freeCashFlow) ? freeCashFlow / 1e9 : null
    };
  });
  return {
    ok: rows.length > 0,
    version: VERSION,
    ticker,
    fields: {
      operatingCashFlow: operatingCashFlowColumn,
      capitalExpenditureEquivalent: propertyAndEquipmentColumn
    },
    formula: "FCF = net_cash_from_operating_activities - abs(property_and_equipment)",
    rows,
    source: {
      api: "DoltHub v1alpha1 default branch",
      commitRef: result.commit_ref || null,
      query: sql
    }
  };
}
__name(buildCashFlowValidation, "buildCashFlowValidation");
async function calculateFcfMarginHistory(ticker) {
  const cashFlowFields = await resolveCashFlowFields();
  const ocfColumn = cashFlowFields.operatingCashFlow;
  const capexColumn = cashFlowFields.capitalExpenditures;
  const quotedOcf = quoteIdentifier(ocfColumn);
  const quotedCapex = quoteIdentifier(capexColumn);
  const quarterlyRevenueSql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` DESC LIMIT 4`;
  const annualCashFlowSql = `SELECT ${quotedOcf} AS operating_cash_flow, ${quotedCapex} AS capital_expenditures, \`date\`, period FROM \`cash_flow_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' AND ${quotedOcf} IS NOT NULL AND ${quotedCapex} IS NOT NULL ORDER BY \`date\` ASC LIMIT 40`;
  const annualRevenueSql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' AND sales IS NOT NULL ORDER BY \`date\` ASC LIMIT 40`;
  const [quarterlyRevenueResult, annualCashFlowResult, annualRevenueResult, yahooResult] = await Promise.all([
    runDoltQuery(quarterlyRevenueSql),
    runDoltQuery(annualCashFlowSql),
    runDoltQuery(annualRevenueSql),
    fetchYahooTtmCashFlow(ticker, { createError, parseNumber }).then((value) => ({ ok: true, value })).catch((error) => ({
      ok: false,
      error: error.message || "Yahoo Finance TTM cash-flow data is unavailable."
    }))
  ]);
  const yahooTtm = yahooResult.ok ? yahooResult.value : null;
  const latestTTM = buildLatestTtmFcf(quarterlyRevenueResult.rows, yahooTtm);
  const annualSeries = buildAnnualFcfSeries(annualCashFlowResult.rows, annualRevenueResult.rows);
  const unavailableReason = yahooResult.ok ? null : yahooResult.error;
  return {
    ok: true,
    version: VERSION,
    ticker,
    supported: {
      ttmFcf: Boolean(latestTTM),
      historicalFcf: annualSeries.length > 0
    },
    unavailableReason,
    fields: {
      operatingCashFlow: ocfColumn,
      capitalExpenditures: capexColumn,
      revenue: "sales"
    },
    methodology: {
      freeCashFlow: "Yahoo TTM operating cash flow minus the absolute value of Yahoo TTM capital expenditure.",
      oneYear: "Yahoo Finance TTM free cash flow divided by Dolt latest-four-quarter revenue.",
      longTerm: "Dolt total fiscal-year free cash flow divided by total fiscal-year revenue over the latest 3, 5, or 10 completed fiscal years."
    },
    historicalFcfMargins: {
      oneYear: latestTTM ? {
        method: "Yahoo TTM FCF / Dolt TTM revenue",
        percentage: latestTTM.fcfMarginPercentage,
        endDate: latestTTM.endDate,
        cashFlowAsOfDate: latestTTM.cashFlowAsOfDate,
        revenueBillions: latestTTM.revenueBillions,
        freeCashFlowBillions: latestTTM.freeCashFlowBillions,
        operatingCashFlowBillions: latestTTM.operatingCashFlowBillions,
        capitalExpendituresBillions: latestTTM.capitalExpendituresBillions,
        quarterDates: latestTTM.quarterDates,
        source: latestTTM.source
      } : {
        method: "Yahoo TTM FCF / Dolt TTM revenue",
        percentage: null,
        available: false,
        reason: unavailableReason || "Four usable quarterly revenue rows were not available."
      },
      threeYears: calculateWeightedFcfMargin(annualSeries, 3),
      fiveYears: calculateWeightedFcfMargin(annualSeries, 5),
      tenYears: calculateWeightedFcfMargin(annualSeries, 10)
    },
    latestTTM,
    annualSeries: annualSeries.slice(-15),
    rowsReceived: {
      quarterlyRevenue: quarterlyRevenueResult.rows?.length || 0,
      annualCashFlow: annualCashFlowResult.rows?.length || 0,
      annualRevenue: annualRevenueResult.rows?.length || 0
    },
    source: {
      ttmCashFlowApi: "Yahoo Finance fundamentals-timeseries",
      yahooTypes: yahooTtm?.types || [],
      yahooHost: yahooTtm?.host || null,
      quarterlyRevenueApi: "DoltHub v1alpha1 default branch",
      quarterlyRevenueQuery: quarterlyRevenueSql,
      annualCashFlowQuery: annualCashFlowSql,
      annualRevenueQuery: annualRevenueSql
    }
  };
}
__name(calculateFcfMarginHistory, "calculateFcfMarginHistory");
async function calculateHistoricalCalculatorHistory(ticker) {
  const [revenueResult, netMarginResult, fcfMarginResult, returnsResult] = await Promise.all([
    calculateRevenueHistory(ticker),
    calculateNetMarginHistory(ticker),
    calculateFcfMarginHistory(ticker),
    calculateReturnsHistory(ticker).catch(() => null)
  ]);
  const metrics = buildHistoricalCalculatorData({
    revenueHistory: revenueResult,
    netMarginHistory: netMarginResult,
    fcfMarginHistory: fcfMarginResult,
    returnsHistory: returnsResult
  });
  return {
    ok: true,
    version: VERSION,
    ticker,
    purpose: "Historical annual detail for expandable DCF assumption rows. DCF calculations are unchanged.",
    methodology: {
      revenueGrowth: "Each annual percentage compares the fiscal year with the immediately preceding fiscal year.",
      netMargin: "Fiscal-year net income divided by fiscal-year revenue.",
      fcfMargin: "Fiscal-year free cash flow divided by fiscal-year revenue. Free cash flow equals operating cash flow minus the absolute value of capital expenditures.",
      roic: "Finviz-style ROIC: net income divided by common equity plus long-term debt and non-current operating leases. Error of +/- 5% possible.",
      summary: "Growth metrics use CAGR where applicable; margin and ROIC summaries use period averages."
    },
    metrics,
    availability: {
      revenueGrowthYears: metrics.revenueGrowth.annual.length,
      netMarginYears: metrics.netMargin.annual.length,
      fcfMarginYears: metrics.fcfMargin.annual.length,
      roicYears: metrics.roic.annual.length
    }
  };
}
__name(calculateHistoricalCalculatorHistory, "calculateHistoricalCalculatorHistory");
async function calculateGrowthHistory(ticker) {
  const [incomeSchema, balanceSchema, cashFlowFields] = await Promise.all([
    runDoltQuery("DESCRIBE `income_statement`"),
    runDoltQuery("DESCRIBE `balance_sheet_equity`"),
    resolveCashFlowFields()
  ]);
  const incomeColumns = extractDescribeColumns(incomeSchema);
  const balanceColumns = extractDescribeColumns(balanceSchema);
  const sharesColumn = chooseColumn(balanceColumns, [
    "shares_outstanding",
    "common_stocks_including_additional_paid_in_capital_member",
    "weighted_average_number_of_diluted_shares_outstanding",
    "weighted_average_number_of_shares_outstanding_basic"
  ]);
  const sharesSelect = sharesColumn ? `${quoteIdentifier(sharesColumn)} AS shares_outstanding` : "CAST(NULL AS DOUBLE) AS shares_outstanding";
  const ocf = quoteIdentifier(cashFlowFields.operatingCashFlow);
  const capex = quoteIdentifier(cashFlowFields.capitalExpenditures);
  const incomeSql = `SELECT sales, net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const balanceSql = `SELECT ${sharesSelect}, \`date\`, period FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const cashFlowSql = `SELECT ${ocf} AS operating_cash_flow, ${capex} AS capital_expenditures, \`date\`, period FROM \`cash_flow_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const [incomeResult, balanceResult, cashFlowResult] = await Promise.all([
    runDoltQuery(incomeSql),
    runDoltQuery(balanceSql),
    runDoltQuery(cashFlowSql)
  ]);
  const metricSeries = {
    revenue: { label: "Revenue", unit: "currency", series: [] },
    netIncome: { label: "Net income", unit: "currency", series: [] },
    freeCashFlow: { label: "Free cash flow", unit: "currency", series: [] },
    sharesOutstanding: { label: "Shares outstanding", unit: "shares", series: [] }
  };
  for (const row of Array.isArray(incomeResult.rows) ? incomeResult.rows : []) {
    const date = String(row.date || "").slice(0, 10);
    const fiscalYear = Number(date.slice(0, 4));
    if (!Number.isFinite(fiscalYear)) continue;
    const revenue = parseNumberOrNull(row.sales);
    const netIncome = parseNumberOrNull(row.net_income);
    if (revenue !== null) metricSeries.revenue.series.push({ fiscalYear, date, value: revenue, source: "income_statement.sales" });
    if (netIncome !== null) metricSeries.netIncome.series.push({ fiscalYear, date, value: netIncome, source: "income_statement.net_income" });
  }
  for (const row of Array.isArray(balanceResult.rows) ? balanceResult.rows : []) {
    const date = String(row.date || "").slice(0, 10);
    const fiscalYear = Number(date.slice(0, 4));
    const shares = parseNumberOrNull(row.shares_outstanding);
    if (Number.isFinite(fiscalYear) && shares !== null && shares > 0) {
      metricSeries.sharesOutstanding.series.push({ fiscalYear, date, value: shares, source: sharesColumn });
    }
  }
  for (const row of Array.isArray(cashFlowResult.rows) ? cashFlowResult.rows : []) {
    const date = String(row.date || "").slice(0, 10);
    const fiscalYear = Number(date.slice(0, 4));
    const operatingCashFlow = parseNumberOrNull(row.operating_cash_flow);
    const capexValue = parseNumberOrNull(row.capital_expenditures);
    if (!Number.isFinite(fiscalYear) || operatingCashFlow === null || capexValue === null) continue;
    metricSeries.freeCashFlow.series.push({
      fiscalYear,
      date,
      value: operatingCashFlow - Math.abs(capexValue),
      source: `${cashFlowFields.operatingCashFlow} - abs(${cashFlowFields.capitalExpenditures})`
    });
  }
  const metrics = buildGrowthAnalysis(metricSeries);
  const sharesGrowth = metrics.sharesOutstanding?.growth || null;
  return {
    ok: true,
    version: VERSION,
    ticker,
    supported: Object.values(metrics).some((metric) => metric.annualSeries.length >= 2),
    methodology: {
      oneYear: "Latest completed fiscal year compared with the previous fiscal year.",
      longTerm: "CAGR between exact fiscal-year endpoints 3, 5, or 10 years apart.",
      negativeValues: "CAGR is not reported when either endpoint is zero or negative; total percentage change is retained where meaningful.",
      freeCashFlow: "Operating cash flow minus the absolute value of capital expenditures.",
      shareCount: "Positive growth means dilution; negative growth means net buybacks."
    },
    fields: {
      revenue: "sales",
      netIncome: "net_income",
      sharesOutstanding: sharesColumn,
      operatingCashFlow: cashFlowFields.operatingCashFlow,
      capitalExpenditures: cashFlowFields.capitalExpenditures
    },
    metrics,
    shareCountInterpretation: sharesGrowth ? {
      oneYear: sharesGrowth.oneYear?.percentage ?? null,
      threeYears: sharesGrowth.threeYears?.percentage ?? null,
      fiveYears: sharesGrowth.fiveYears?.percentage ?? null,
      tenYears: sharesGrowth.tenYears?.percentage ?? null,
      note: "Positive percentages indicate dilution; negative percentages indicate buybacks."
    } : null,
    rowsReceived: {
      income: incomeResult.rows?.length || 0,
      balance: balanceResult.rows?.length || 0,
      cashFlow: cashFlowResult.rows?.length || 0
    },
    source: {
      api: "DoltHub v1alpha1 default branch",
      commitRef: incomeResult.commit_ref || balanceResult.commit_ref || cashFlowResult.commit_ref || null,
      incomeQuery: incomeSql,
      balanceQuery: balanceSql,
      cashFlowQuery: cashFlowSql
    }
  };
}
__name(calculateGrowthHistory, "calculateGrowthHistory");
async function calculateReturnsHistory(ticker) {
  const fields = await resolveReturnFields();
  const missingRequired = ["netIncome", "totalAssets", "equity", "longTermDebt"].filter((key) => !fields[key]);
  if (missingRequired.length > 0) {
    return {
      ok: true,
      version: VERSION,
      ticker,
      supported: false,
      error: `Required Finviz-style ROIC fields are unavailable: ${missingRequired.join(", ")}.`,
      fields
    };
  }
  const incomeSelect = [
    fields.operatingIncome ? `${quoteIdentifier(fields.operatingIncome)} AS operating_income` : "CAST(NULL AS DOUBLE) AS operating_income",
    `${quoteIdentifier(fields.netIncome)} AS net_income`,
    "`date`",
    "period"
  ].join(", ");
  const assetParts = [
    `${quoteIdentifier(fields.totalAssets)} AS total_assets`,
    sumColumnsSql(fields.cashColumns, "cash"),
    "`date`",
    "period"
  ];
  const liabilityParts = [
    fields.totalLiabilities ? `${quoteIdentifier(fields.totalLiabilities)} AS total_liabilities` : "CAST(NULL AS DOUBLE) AS total_liabilities",
    fields.currentLiabilities ? `${quoteIdentifier(fields.currentLiabilities)} AS current_liabilities` : "CAST(NULL AS DOUBLE) AS current_liabilities",
    `${quoteIdentifier(fields.longTermDebt)} AS long_term_debt`,
    fields.otherNonCurrentLiabilities ? `${quoteIdentifier(fields.otherNonCurrentLiabilities)} AS other_non_current_liabilities` : "CAST(NULL AS DOUBLE) AS other_non_current_liabilities",
    fields.operatingLeaseLiabilitiesNonCurrent ? `${quoteIdentifier(fields.operatingLeaseLiabilitiesNonCurrent)} AS operating_lease_liabilities_noncurrent` : "CAST(NULL AS DOUBLE) AS operating_lease_liabilities_noncurrent",
    sumColumnsSql(fields.debtColumns, "total_debt"),
    "`date`",
    "period"
  ];
  const equityParts = [
    `${quoteIdentifier(fields.equity)} AS equity`,
    "`date`",
    "period"
  ];
  const annualIncomeSql = `SELECT ${incomeSelect} FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const annualAssetsSql = `SELECT ${assetParts.join(", ")} FROM \`balance_sheet_assets\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const annualLiabilitiesSql = `SELECT ${liabilityParts.join(", ")} FROM \`balance_sheet_liabilities\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const annualEquitySql = `SELECT ${equityParts.join(", ")} FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const quarterlyIncomeSql = `SELECT ${quoteIdentifier(fields.netIncome)} AS net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' ORDER BY \`date\` DESC LIMIT 4`;
  const latestAssetsSql = `SELECT ${assetParts.join(", ")} FROM \`balance_sheet_assets\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;
  const latestLiabilitiesSql = `SELECT ${liabilityParts.join(", ")} FROM \`balance_sheet_liabilities\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;
  const latestEquitySql = `SELECT ${equityParts.join(", ")} FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;
  const [
    incomeResult,
    annualAssetsResult,
    annualLiabilitiesResult,
    annualEquityResult,
    quarterlyIncomeResult,
    latestAssetsResult,
    latestLiabilitiesResult,
    latestEquityResult
  ] = await Promise.all([
    runDoltQuery(annualIncomeSql),
    runDoltQuery(annualAssetsSql),
    runDoltQuery(annualLiabilitiesSql),
    runDoltQuery(annualEquitySql),
    runDoltQuery(quarterlyIncomeSql),
    runDoltQuery(latestAssetsSql),
    runDoltQuery(latestLiabilitiesSql),
    runDoltQuery(latestEquitySql)
  ]);
  const dateKey = /* @__PURE__ */ __name((row) => String(row?.date || "").slice(0, 10), "dateKey");
  const yearKey = /* @__PURE__ */ __name((row) => Number(dateKey(row).slice(0, 4)), "yearKey");
  const incomeByYear = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(incomeResult.rows) ? incomeResult.rows : []) {
    const date = dateKey(row);
    const fiscalYear = yearKey(row);
    if (!Number.isFinite(fiscalYear)) continue;
    incomeByYear.set(fiscalYear, {
      fiscalYear,
      date,
      operatingIncome: parseNumberOrNull(row.operating_income),
      netIncome: parseNumberOrNull(row.net_income)
    });
  }
  const assetsByYear = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(annualAssetsResult.rows) ? annualAssetsResult.rows : []) {
    const fiscalYear = yearKey(row);
    if (!Number.isFinite(fiscalYear)) continue;
    assetsByYear.set(fiscalYear, {
      date: dateKey(row),
      totalAssets: parseNumberOrNull(row.total_assets),
      cash: parseNumberOrNull(row.cash)
    });
  }
  const liabilitiesByYear = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(annualLiabilitiesResult.rows) ? annualLiabilitiesResult.rows : []) {
    const fiscalYear = yearKey(row);
    if (!Number.isFinite(fiscalYear)) continue;
    liabilitiesByYear.set(fiscalYear, {
      date: dateKey(row),
      totalLiabilities: parseNumberOrNull(row.total_liabilities),
      currentLiabilities: parseNumberOrNull(row.current_liabilities),
      longTermDebt: parseNumberOrNull(row.long_term_debt),
      otherNonCurrentLiabilities: parseNumberOrNull(row.other_non_current_liabilities),
      operatingLeaseLiabilitiesNonCurrent: parseNumberOrNull(row.operating_lease_liabilities_noncurrent),
      totalDebt: parseNumberOrNull(row.total_debt)
    });
  }
  const equityByYear = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(annualEquityResult.rows) ? annualEquityResult.rows : []) {
    const fiscalYear = yearKey(row);
    if (!Number.isFinite(fiscalYear)) continue;
    equityByYear.set(fiscalYear, {
      date: dateKey(row),
      equity: parseNumberOrNull(row.equity)
    });
  }
  const years = [...incomeByYear.keys()].filter((year) => assetsByYear.has(year) && liabilitiesByYear.has(year) && equityByYear.has(year)).sort((a, b) => a - b);
  const mergedRows = years.map((year) => ({
    ...incomeByYear.get(year),
    ...assetsByYear.get(year),
    ...liabilitiesByYear.get(year),
    ...equityByYear.get(year),
    fiscalYear: year,
    date: incomeByYear.get(year)?.date || equityByYear.get(year)?.date || assetsByYear.get(year)?.date || null
  }));
  const series = calculateReturnSeries(mergedRows);
  const quarterlyNetIncomeRows = Array.isArray(quarterlyIncomeResult.rows) ? quarterlyIncomeResult.rows.map((row) => parseNumberOrNull(row.net_income)).filter(Number.isFinite) : [];
  const ttmNetIncome = quarterlyNetIncomeRows.length === 4 ? quarterlyNetIncomeRows.reduce((sum, value) => sum + value, 0) : null;
  const indexLatest = /* @__PURE__ */ __name((rows) => {
    const map = /* @__PURE__ */ new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const date = dateKey(row);
      if (date && !map.has(date)) map.set(date, row);
    }
    return map;
  }, "indexLatest");
  const latestAssetsByDate = indexLatest(latestAssetsResult.rows);
  const latestLiabilitiesByDate = indexLatest(latestLiabilitiesResult.rows);
  const latestEquityByDate = indexLatest(latestEquityResult.rows);
  const sharedDates = [...latestEquityByDate.keys()].filter((date) => latestAssetsByDate.has(date) && latestLiabilitiesByDate.has(date)).sort((a, b) => b.localeCompare(a));
  let latestBalanceRow = null;
  for (const date of sharedDates) {
    const assets = latestAssetsByDate.get(date);
    const liabilities = latestLiabilitiesByDate.get(date);
    const equity = latestEquityByDate.get(date);
    const candidate = {
      date,
      totalAssets: parseNumberOrNull(assets?.total_assets),
      cash: parseNumberOrNull(assets?.cash),
      totalLiabilities: parseNumberOrNull(liabilities?.total_liabilities),
      currentLiabilities: parseNumberOrNull(liabilities?.current_liabilities),
      longTermDebt: parseNumberOrNull(liabilities?.long_term_debt),
      otherNonCurrentLiabilities: parseNumberOrNull(liabilities?.other_non_current_liabilities),
      operatingLeaseLiabilitiesNonCurrent: parseNumberOrNull(liabilities?.operating_lease_liabilities_noncurrent),
      totalDebt: parseNumberOrNull(liabilities?.total_debt),
      equity: parseNumberOrNull(equity?.equity)
    };
    if (candidate.equity !== null && candidate.longTermDebt !== null) {
      latestBalanceRow = candidate;
      break;
    }
  }
  const ttmSnapshot = ttmNetIncome !== null && latestBalanceRow ? {
    ...calculateFinvizRoicSnapshot({ ...latestBalanceRow, netIncome: ttmNetIncome }),
    date: latestBalanceRow.date,
    period: "TTM",
    fiscalYear: Number(String(latestBalanceRow?.date || "").slice(0, 4)) || null
  } : null;
  return {
    ok: true,
    version: VERSION,
    ticker,
    supported: series.length > 0 || Boolean(ttmSnapshot),
    methodology: {
      roic: "Finviz-style ROIC = net income / (common equity + long-term debt + non-current operating lease liabilities).",
      current: "Current ROIC uses trailing-four-quarter net income and the latest common balance-sheet date across the asset, liability and equity tables.",
      historical: "Historical ROIC uses fiscal-year net income and matching fiscal-year asset, liability and equity statements. Capital is not averaged.",
      leaseAdjustment: "When a separate non-current operating-lease field is unavailable, it is estimated as total liabilities - current liabilities - long-term debt - other non-current liabilities, floored at zero.",
      warning: "This is an approximation of Finviz statement normalisation; an error of +/- 5% is possible.",
      roe: "Net income divided by average shareholders equity.",
      roa: "Net income divided by average total assets.",
      roce: "Operating income divided by average capital employed."
    },
    fields,
    summary: summariseReturns(series, ttmSnapshot),
    annualSeries: series.slice(-15),
    rowsReceived: {
      annualIncome: incomeResult.rows?.length || 0,
      annualAssets: annualAssetsResult.rows?.length || 0,
      annualLiabilities: annualLiabilitiesResult.rows?.length || 0,
      annualEquity: annualEquityResult.rows?.length || 0,
      quarterlyIncome: quarterlyIncomeResult.rows?.length || 0,
      latestAssets: latestAssetsResult.rows?.length || 0,
      latestLiabilities: latestLiabilitiesResult.rows?.length || 0,
      latestEquity: latestEquityResult.rows?.length || 0,
      matchedYears: mergedRows.length,
      sharedLatestDates: sharedDates.length
    },
    source: {
      api: "DoltHub v1alpha1 default branch",
      commitRef: incomeResult.commit_ref || annualAssetsResult.commit_ref || annualLiabilitiesResult.commit_ref || annualEquityResult.commit_ref || null,
      annualIncomeQuery: annualIncomeSql,
      annualAssetsQuery: annualAssetsSql,
      annualLiabilitiesQuery: annualLiabilitiesSql,
      annualEquityQuery: annualEquitySql,
      quarterlyIncomeQuery: quarterlyIncomeSql,
      latestAssetsQuery: latestAssetsSql,
      latestLiabilitiesQuery: latestLiabilitiesSql,
      latestEquityQuery: latestEquitySql
    }
  };
}
__name(calculateReturnsHistory, "calculateReturnsHistory");
async function resolveReturnFields() {
  const [incomeSchema, assetsSchema, liabilitiesSchema, equitySchema] = await Promise.all([
    runDoltQuery("DESCRIBE `income_statement`"),
    runDoltQuery("DESCRIBE `balance_sheet_assets`"),
    runDoltQuery("DESCRIBE `balance_sheet_liabilities`"),
    runDoltQuery("DESCRIBE `balance_sheet_equity`")
  ]);
  const incomeColumns = extractDescribeColumns(incomeSchema);
  const assetColumns = extractDescribeColumns(assetsSchema);
  const liabilityColumns = extractDescribeColumns(liabilitiesSchema);
  const equityColumns = extractDescribeColumns(equitySchema);
  return {
    operatingIncome: chooseColumn(incomeColumns, ["operating_income_loss", "operating_income", "income_after_depreciation_and_amortization", "income_from_operations", "operating_profit"]),
    netIncome: chooseColumn(incomeColumns, ["income_from_continuing_operations", "net_income", "net_income_loss", "profit_loss"]),
    totalAssets: chooseColumn(assetColumns, ["total_assets", "assets"]),
    totalLiabilities: chooseColumn(liabilityColumns, ["total_liabilities", "liabilities"]),
    currentLiabilities: chooseColumn(liabilityColumns, ["total_current_liabilities", "current_liabilities", "liabilities_current"]),
    equity: chooseColumn(equityColumns, ["total_equity", "stockholders_equity", "shareholders_equity", "stockholders_equity_including_portion_attributable_to_noncontrolling_interest"]),
    longTermDebt: chooseColumn(liabilityColumns, ["long_term_debt", "long_term_debt_noncurrent", "debt_noncurrent"]),
    otherNonCurrentLiabilities: chooseColumn(liabilityColumns, ["other_non_current_liabilities", "other_liabilities_noncurrent", "other_long_term_liabilities"]),
    operatingLeaseLiabilitiesNonCurrent: chooseColumn(liabilityColumns, [
      "operating_lease_liabilities_non_current",
      "operating_lease_liabilities_noncurrent",
      "operating_lease_liability_noncurrent",
      "non_current_operating_lease_liabilities",
      "long_term_operating_lease_liabilities",
      "operating_lease_obligation_noncurrent"
    ]),
    cashColumns: chooseColumns(assetColumns, [
      ["cash_and_equivalents", "cash_and_cash_equivalents_at_carrying_value", "cash_and_cash_equivalents", "cash"],
      ["short_term_investments", "marketable_securities_current"]
    ]),
    debtColumns: chooseColumns(liabilityColumns, [
      ["short_term_borrowings", "short_term_debt", "debt_current", "long_term_debt_current"],
      ["long_term_debt", "long_term_debt_noncurrent", "debt_noncurrent"]
    ]),
    availableIncomeColumns: incomeColumns,
    availableAssetColumns: assetColumns,
    availableLiabilityColumns: liabilityColumns,
    availableEquityColumns: equityColumns
  };
}
__name(resolveReturnFields, "resolveReturnFields");
function chooseColumn(columns, candidates) {
  for (const candidate of candidates) {
    const found = columns.find((column) => column.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}
__name(chooseColumn, "chooseColumn");
function chooseColumns(columns, candidateGroups) {
  const selected = [];
  for (const group of candidateGroups) {
    const found = chooseColumn(columns, group);
    if (found && !selected.includes(found)) selected.push(found);
  }
  return selected;
}
__name(chooseColumns, "chooseColumns");
function sumColumnsSql(columns, alias) {
  if (!Array.isArray(columns) || columns.length === 0) return `CAST(NULL AS DOUBLE) AS ${quoteIdentifier(alias)}`;
  const expression = columns.map((column) => `COALESCE(${quoteIdentifier(column)}, 0)`).join(" + ");
  return `(${expression}) AS ${quoteIdentifier(alias)}`;
}
__name(sumColumnsSql, "sumColumnsSql");
function parseNumberOrNull(value) {
  const parsed = parseNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}
__name(parseNumberOrNull, "parseNumberOrNull");
async function resolveCashFlowFields() {
  const schema = await runDoltQuery("DESCRIBE `cash_flow_statement`");
  const columns = extractDescribeColumns(schema);
  const operatingCashFlow = chooseCashFlowColumn(columns, [
    "net_cash_flow_operating",
    "net_cash_provided_by_operating_activities",
    "net_cash_provided_by_used_in_operating_activities",
    "net_cash_from_operating_activities",
    "cash_flow_from_operating_activities",
    "cash_from_operating_activities",
    "operating_cash_flow"
  ], (column) => {
    const name = column.toLowerCase();
    let score = 0;
    if (name.includes("operat")) score += 8;
    if (name.includes("cash")) score += 5;
    if (name.includes("flow")) score += 2;
    if (name.includes("net")) score += 1;
    if (name.includes("continuing")) score -= 2;
    if (name.includes("invest")) score -= 10;
    if (name.includes("financ")) score -= 10;
    return score;
  });
  const capitalExpenditures = chooseCashFlowColumn(columns, [
    "payments_to_acquire_property_plant_and_equipment",
    "payments_to_acquire_productive_assets",
    "capital_expenditures",
    "capital_expenditure",
    "capex",
    "property_and_equipment"
  ], (column) => {
    const name = column.toLowerCase();
    let score = 0;
    if (name.includes("capital") && name.includes("expend")) score += 12;
    if (name.includes("payments_to_acquire")) score += 7;
    if (name.includes("property_plant")) score += 7;
    if (name.includes("productive_assets")) score += 5;
    if (name === "property_and_equipment") score += 12;
    if (name.includes("property") && name.includes("equipment")) score += 8;
    if (name === "capex") score += 12;
    if (name.includes("proceeds")) score -= 10;
    if (name.includes("business")) score -= 5;
    return score;
  });
  if (!operatingCashFlow || !capitalExpenditures) {
    throw createError(500, "Could not identify the operating cash flow or capital expenditure columns in cash_flow_statement.", {
      availableColumns: columns,
      detected: { operatingCashFlow, capitalExpenditures }
    });
  }
  return { operatingCashFlow, capitalExpenditures, availableColumns: columns };
}
__name(resolveCashFlowFields, "resolveCashFlowFields");
function chooseCashFlowColumn(columns, exactCandidates, scorer) {
  for (const candidate of exactCandidates) {
    const exact = columns.find((column) => column.toLowerCase() === candidate);
    if (exact) return exact;
  }
  return columns.map((column) => ({ column, score: scorer(column) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.column.localeCompare(b.column))[0]?.column || null;
}
__name(chooseCashFlowColumn, "chooseCashFlowColumn");
function quoteIdentifier(value) {
  const identifier = String(value || "");
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) throw createError(500, "Unsafe database column name detected.");
  return `\`${identifier}\``;
}
__name(quoteIdentifier, "quoteIdentifier");
function validateTable(value) {
  const allowed = /* @__PURE__ */ new Set(["income_statement", "balance_sheet_equity", "cash_flow_statement"]);
  if (!allowed.has(value)) throw createError(400, "Unsupported table.");
  return value;
}
__name(validateTable, "validateTable");
function normaliseTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,20}$/.test(ticker)) throw createError(400, "Invalid ticker.");
  return ticker;
}
__name(normaliseTicker, "normaliseTicker");
function parseNumber(value) {
  if (value === null || value === void 0 || value === "") return NaN;
  return Number(String(value).replace(/,/g, ""));
}
__name(parseNumber, "parseNumber");
function createError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}
__name(createError, "createError");
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Worker-Version": VERSION
    }
  });
}
__name(jsonResponse, "jsonResponse");
function htmlResponse(html) {
  return new Response(html, {
    headers: {
      ...CORS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Worker-Version": VERSION
    }
  });
}
__name(htmlResponse, "htmlResponse");
var LAB_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fundamentals Lab</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--card:#15181e;--inner:#20252e;--border:#303744;--text:#fff;--muted:#9da6b4;--green:#73be43;--red:#ff6464}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:18px}main{width:min(1100px,100%);margin:auto}h1{margin:0 0 6px}.lead{color:var(--muted);line-height:1.5}.bar{display:grid;grid-template-columns:1fr auto;gap:9px;background:var(--card);border:1px solid var(--border);padding:12px;border-radius:12px;margin:16px 0}input,button{font:inherit;border-radius:7px}input{background:var(--inner);border:1px solid var(--border);color:var(--text);padding:10px 12px;text-transform:uppercase;font-weight:700}button{border:0;background:var(--green);color:#081006;padding:10px 15px;font-weight:800;cursor:pointer}.company-card{display:none;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px}.company-card.visible{display:block}.company-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}.company-title{margin:0;font-size:1.35rem}.company-meta{color:var(--muted);margin-top:4px}.company-price{text-align:right;font-size:1.35rem;font-weight:800}.overview-grid{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:9px}.overview-item{background:var(--inner);border:1px solid var(--border);border-radius:9px;padding:10px}.overview-item small{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}.overview-item strong{font-size:.98rem;font-variant-numeric:tabular-nums}.metric-warning{display:block;margin-top:4px;color:var(--muted);font-size:.64rem;font-weight:600;line-height:1.25}.status{padding:12px;background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;color:var(--muted)}.history-heading{display:block;margin:18px 0 10px}.history-heading h2{margin:0 0 4px;font-size:1.1rem}.history-heading p{margin:0;color:var(--muted);font-size:.9rem}.assumption-section{margin:16px 0 20px}.assumption-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:10px}.assumption-head h2{margin:0 0 4px;font-size:1.1rem}.assumption-head p{margin:0;color:var(--muted);font-size:.86rem}.assumption-actions{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;justify-content:flex-end}.target-control,.preset-control{display:flex;align-items:center;gap:5px}.target-label,.preset-label{color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;margin-right:4px}.target-btn,.preset-btn{background:var(--inner);color:var(--muted);border:1px solid var(--border);padding:7px 11px;font-size:.75rem}.target-btn.active{background:var(--green);border-color:var(--green);color:#081006}.preset-btn:hover{border-color:var(--green);color:var(--green)}.preset-btn:disabled{opacity:.45;cursor:not-allowed;border-color:var(--border);color:var(--muted)}.preset-btn.clear{color:var(--red)}.preset-btn.clear:hover{border-color:var(--red);color:var(--red)}.assumption-wrap{overflow:auto;border:1px solid var(--border);border-radius:12px;background:var(--card)}.assumption-table{min-width:820px;margin:0}.assumption-table th,.assumption-table td{padding:8px 7px}.assumption-table thead tr:first-child th{background:#20252e;color:var(--text);text-align:center}.assumption-table thead tr:first-child th:first-child{text-align:left}.assumption-table .assumption-group{background:#335f2b!important}.assumption-table thead tr:nth-child(2) th:nth-last-child(-n+3){background:#4b8539;color:#fff}.assumption-table tbody th{color:var(--text);font-size:.82rem;text-transform:none;letter-spacing:0}.historical-cell{text-align:center!important}.historical-btn{min-width:56px;background:transparent;color:var(--text);padding:7px 8px;border:1px solid transparent;font-size:.82rem;font-weight:800}.historical-btn:hover,.historical-btn:focus-visible{background:var(--inner);border-color:var(--green);color:var(--green)}.historical-btn.used{background:rgba(115,190,67,.12);border-color:var(--green);color:var(--green)}.historical-missing{color:var(--muted)}.assumption-input-wrap{display:flex;align-items:center;background:var(--inner);border:1px solid var(--border);border-radius:7px;padding:0 8px}.assumption-input-wrap:focus-within{border-color:var(--green)}.assumption-input{width:100%;min-width:66px;background:transparent;border:0;padding:8px 4px;text-align:center;text-transform:none;font-weight:700;outline:0;-moz-appearance:textfield}.assumption-input::-webkit-outer-spin-button,.assumption-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.input-suffix{color:var(--muted);font-size:.75rem}.assumption-note{margin:8px 2px 0;color:var(--muted);font-size:.75rem}.assumption-note strong{color:var(--text)}.historical-chart-section{margin:18px 0 22px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px}.historical-chart-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}.historical-chart-head h2{margin:0 0 4px;font-size:1.1rem}.historical-chart-head p{margin:0;color:var(--muted);font-size:.86rem}.historical-chart-controls{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}.chart-control{display:grid;gap:5px}.chart-control label{color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}.chart-select{background:var(--inner);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:7px 32px 7px 10px;font:inherit;font-size:.8rem;font-weight:700}.chart-type-control{display:inline-flex;gap:4px;padding:3px;background:var(--inner);border:1px solid var(--border);border-radius:9px}.chart-type-btn{background:transparent;color:var(--muted);padding:6px 10px;border-radius:6px;font-size:.75rem}.chart-type-btn:hover{color:var(--text)}.chart-type-btn.active{background:var(--green);color:#081006}.historical-main-chart{min-height:330px}.historical-main-chart svg{display:block;width:100%;height:auto;max-height:390px;overflow:visible}.main-chart-grid{stroke:var(--border);stroke-width:1}.main-chart-zero{stroke:var(--muted);stroke-width:1;stroke-dasharray:4 4}.main-chart-line{fill:none;stroke:var(--green);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.main-chart-point{fill:var(--card);stroke:var(--green);stroke-width:2}.main-chart-bar{fill:var(--green);opacity:.86}.main-chart-bar:hover{opacity:1}.main-chart-label{fill:var(--muted);font-size:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.main-chart-title{fill:var(--text);font-size:15px;font-weight:800;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.chart-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}.chart-summary-item{background:var(--inner);border:1px solid var(--border);border-radius:9px;padding:9px}.chart-summary-item small{display:block;color:var(--muted);font-size:.68rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}.chart-summary-item strong{font-size:.95rem}.chart-table-toggle{margin-top:12px;background:var(--inner);color:var(--text);border:1px solid var(--border);padding:7px 11px;font-size:.75rem}.chart-table-panel{display:none;margin-top:10px}.integrated-history-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)}.integrated-history-head h3{margin:0 0 4px;font-size:1rem}.integrated-history-head p{margin:0;color:var(--muted);font-size:.8rem}.history-note{min-height:18px;color:var(--muted);font-size:.78rem;margin:-4px 0 8px}.history-note.warning{color:#e6b85c}.chart-table-panel.open{display:block}.timeframe-label{display:block;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;margin:12px 0 5px}.timeframe-control{display:inline-flex;gap:4px;padding:3px;background:var(--card);border:1px solid var(--border);border-radius:9px}.timeframe-btn{background:transparent;color:var(--muted);padding:6px 9px;border-radius:6px;font-size:.75rem;font-weight:800}.timeframe-btn:hover{color:var(--text);background:var(--inner)}.timeframe-btn.active{background:var(--green);color:#081006}.spark-wrap{min-width:0}.spark-years{display:flex;justify-content:space-between;color:var(--muted);font-size:.65rem;margin-top:2px;font-variant-numeric:tabular-nums}.history{display:grid;gap:10px}.metric-row{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}.metric-toggle{width:100%;display:grid;grid-template-columns:minmax(130px,1fr) minmax(230px,1.4fr) minmax(90px,.55fr) 28px;gap:14px;align-items:center;background:transparent;color:var(--text);padding:14px;text-align:left}.metric-toggle:hover{background:rgba(255,255,255,.025)}.metric-title{min-width:0}.metric-name{display:block;font-weight:800}.metric-latest{display:block;color:var(--muted);font-size:.78rem;margin-top:4px;font-variant-numeric:tabular-nums}.sparkline{display:block;width:100%;height:82px;overflow:visible}.sparkline .grid{stroke:var(--border);stroke-width:1;opacity:.7}.sparkline .baseline{stroke:var(--border);stroke-width:1;stroke-dasharray:3 4}.sparkline .line{fill:none;stroke:var(--green);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.sparkline .point{fill:var(--card);stroke:var(--green);stroke-width:2;opacity:.05;transition:opacity .12s}.sparkline:hover .point{opacity:1}.sparkline .dot{fill:var(--green)}.sparkline .axis-label{fill:var(--muted);font-size:9px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.sparkline-empty{color:var(--muted);font-size:.85rem}.summary-mini{display:grid;grid-template-columns:repeat(2,minmax(42px,1fr));gap:6px 10px}.period{text-align:right}.period small{display:block;color:var(--muted);font-size:.65rem;font-weight:500}.period strong{font-size:.88rem}.chevron{font-size:1.1rem;color:var(--muted);transition:transform .18s}.metric-row.open .chevron{transform:rotate(180deg)}.details{display:none;border-top:1px solid var(--border);padding:0 14px 14px}.metric-row.open .details{display:block}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:620px}th,td{padding:10px 9px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}td{font-variant-numeric:tabular-nums}.empty{padding:16px 0;color:var(--muted)}.ok{color:var(--green)}.bad{color:var(--red)}@media(max-width:720px){.assumption-head{display:block}.assumption-actions{justify-content:flex-start;margin-top:10px}.target-control,.preset-control{flex-wrap:wrap}.company-head{display:block}.company-price{text-align:left;margin-top:8px}.overview-grid{grid-template-columns:1fr 1fr}.bar{grid-template-columns:1fr}.metric-toggle{grid-template-columns:1fr 28px;gap:10px}.metric-title{grid-column:1}.chevron{grid-column:2;grid-row:1;text-align:right}.sparkline{grid-column:1/3}.summary-mini{grid-column:1/3;grid-template-columns:repeat(4,1fr)}.period{text-align:left}.history-heading{align-items:flex-start}.timeframe-control{flex-shrink:0}.historical-chart-controls{width:100%}.chart-control{flex:1 1 150px}.chart-select{width:100%}.chart-summary{grid-template-columns:1fr}.historical-main-chart{min-height:260px}}
</style>
</head>
<body><main>
<h1>Fundamentals Lab</h1>
<p class="lead">Historical business data supporting the DCF assumptions. Select a company, then expand a row to inspect the annual figures behind each summary.</p>
<div class="bar"><input id="ticker" value="AAPL" maxlength="20" aria-label="Ticker"><button id="loadBtn">Load history</button></div>
<div id="status" class="status">Ready.</div>
<section id="company" class="company-card" aria-live="polite"></section>
<section class="assumption-section" aria-labelledby="assumptionTitle">
<div class="assumption-head"><div><h2 id="assumptionTitle">Smart assumption table</h2><p>Choose the target column and click a historical value. Click it again to remove the source highlight.</p></div><div class="assumption-actions"><div id="targetControl" class="target-control" role="group" aria-label="Active assumption target"><span class="target-label">Active target</span><button class="target-btn" type="button" data-target="low">Low</button><button class="target-btn active" type="button" data-target="mid">Mid</button><button class="target-btn" type="button" data-target="high">High</button></div><div id="presetControl" class="preset-control" role="group" aria-label="Scenario presets"><span class="preset-label">Step 14</span><button id="restoreAssumptions" class="preset-btn" type="button" disabled>Use last assumptions</button><button id="buildScenarios" class="preset-btn" type="button">Build scenarios</button><button id="clearScenarios" class="preset-btn clear" type="button">Clear</button></div></div></div>
<div class="assumption-wrap"><table class="assumption-table"><thead><tr><th rowspan="2">Metric</th><th colspan="4">Historical Data</th><th colspan="3" class="assumption-group">Assumptions</th></tr><tr><th>1Y</th><th>3Y</th><th>5Y</th><th>10Y</th><th>Low</th><th>Mid</th><th>High</th></tr></thead><tbody id="assumptionBody"></tbody></table></div>
<p class="assumption-note">Decimals of <strong>.75 or higher</strong> round up; lower decimals round down. Every cell remains manually editable.</p>
</section>
<section class="historical-chart-section" aria-labelledby="historicalChartTitle">
<div class="historical-chart-head"><div><h2 id="historicalChartTitle">Historical financials</h2><p>Switch between annual and quarterly results, then inspect the exact figures in the integrated table.</p></div><div class="historical-chart-controls"><div class="chart-control"><label for="historicalMetricSelect">Metric</label><select id="historicalMetricSelect" class="chart-select"><option value="revenue">Revenue</option><option value="netIncome">Net income</option><option value="freeCashFlow">Free cash flow</option><option value="netMargin">Net margin</option><option value="roic">ROIC</option></select></div><div class="chart-control"><label>Frequency</label><div id="frequencyControl" class="chart-type-control" role="group" aria-label="Historical data frequency"><button class="chart-type-btn active" type="button" data-frequency="annual">Annual</button><button class="chart-type-btn" type="button" data-frequency="quarterly">Quarterly</button></div></div><div class="chart-control"><label>Chart type</label><div id="chartTypeControl" class="chart-type-control" role="group" aria-label="Historical chart type"><button class="chart-type-btn active" type="button" data-chart-type="line">Line</button><button class="chart-type-btn" type="button" data-chart-type="bar">Bar</button></div></div><div class="chart-control"><label>Range</label><div id="timeframeControl" class="timeframe-control" role="group" aria-label="Chart timeframe"><button class="timeframe-btn" type="button" data-years="3">3Y</button><button class="timeframe-btn" type="button" data-years="5">5Y</button><button class="timeframe-btn active" type="button" data-years="10">10Y</button><button class="timeframe-btn" type="button" data-years="max">MAX</button></div></div></div></div>
<div id="historicalAvailability" class="history-note"></div>
<div id="historicalMainChart" class="historical-main-chart"><div class="empty">Load a company to view its historical chart.</div></div>
<div id="historicalChartSummary" class="chart-summary"></div>
<div class="integrated-history-head"><div><h3>Business history</h3><p id="historyDescription">Annual figures and year-over-year changes for the selected metric.</p></div><button id="historicalTableToggle" class="chart-table-toggle" type="button" aria-expanded="true">Hide data table</button></div>
<div id="historicalChartTable" class="chart-table-panel open"></div>
</section>
<div id="history" class="history" hidden></div>
<script>
const ticker=document.getElementById('ticker');const statusEl=document.getElementById('status');const companyEl=document.getElementById('company');const historyEl=document.getElementById('history');const timeframeControl=document.getElementById('timeframeControl');const frequencyControl=document.getElementById('frequencyControl');const historicalAvailability=document.getElementById('historicalAvailability');const historyDescription=document.getElementById('historyDescription');const historicalMetricSelect=document.getElementById('historicalMetricSelect');const chartTypeControl=document.getElementById('chartTypeControl');const historicalMainChart=document.getElementById('historicalMainChart');const historicalChartSummary=document.getElementById('historicalChartSummary');const historicalTableToggle=document.getElementById('historicalTableToggle');const historicalChartTable=document.getElementById('historicalChartTable');const assumptionBody=document.getElementById('assumptionBody');const targetControl=document.getElementById('targetControl');const restoreAssumptionsButton=document.getElementById('restoreAssumptions');const buildScenariosButton=document.getElementById('buildScenarios');const clearScenariosButton=document.getElementById('clearScenarios');const ASSUMPTION_STORAGE_KEY='fundamentals-lab:last-assumptions:v1';let selectedTimeframe=10;let selectedChartType='line';let selectedFrequency='annual';let currentMetrics={};let currentTicker='';let activeTarget='mid';let assumptionSources={};
function symbol(){const value=ticker.value.trim().toUpperCase();if(!/^[A-Z0-9.^-]{1,20}$/.test(value))throw new Error('Enter a valid ticker.');ticker.value=value;return value}
function pct(value){return Number.isFinite(value)?value.toFixed(2)+'%':'-'}
function moneyBillions(value){if(!Number.isFinite(value))return '-';const sign=value<0?'-':'';return sign+'$'+Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})+'B'}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
async function getJson(parameter,tickerValue){const url=new URL(location.href);url.search='';url.searchParams.set(parameter,tickerValue);const response=await fetch(url,{cache:'no-store'});const text=await response.text();let json;try{json=JSON.parse(text)}catch{throw new Error(text.slice(0,200))}if(!response.ok||json.ok===false)throw new Error(json.error||'Request failed');return json}
async function getHistory(tickerValue){return getJson('history',tickerValue)}

function compactMoney(value,currency='USD'){if(!Number.isFinite(value))return '-';const abs=Math.abs(value);let divisor=1;let suffix='';if(abs>=1e12){divisor=1e12;suffix='T'}else if(abs>=1e9){divisor=1e9;suffix='B'}else if(abs>=1e6){divisor=1e6;suffix='M'}const formatted=new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:suffix?2:2,maximumFractionDigits:suffix?2:2}).format(value/divisor);return formatted+suffix}
function compactShares(value){if(!Number.isFinite(value))return '-';if(Math.abs(value)>=1e9)return (value/1e9).toFixed(2)+'B';if(Math.abs(value)>=1e6)return (value/1e6).toFixed(1)+'M';return value.toLocaleString('en-US')}
function renderCompany(data){const currency=data.currency||'USD';const items=[['Market cap',compactMoney(data.marketCap,currency)],['Enterprise value',compactMoney(data.enterpriseValue,currency)],['Revenue TTM',compactMoney(data.revenueTtm,currency)],['Net income TTM',compactMoney(data.netIncomeTtm,currency)],['Free cash flow TTM',compactMoney(data.freeCashFlowTtm,currency)],['Total debt',compactMoney(data.totalDebt,currency)],['Shares outstanding',compactShares(data.sharesOutstanding)],['ROIC',pct(data.roic)+'<small class="metric-warning">Error of +/- 5% possible</small>']];companyEl.innerHTML='<div class="company-head"><div><h2 class="company-title">'+escapeHtml(data.companyName||data.ticker)+'</h2><div class="company-meta">'+escapeHtml(data.ticker)+(data.exchange?' \xB7 '+escapeHtml(data.exchange):'')+'</div></div><div class="company-price">'+compactMoney(data.price,currency)+'</div></div><div class="overview-grid">'+items.map(item=>'<div class="overview-item"><small>'+item[0]+'</small><strong>'+item[1]+'</strong></div>').join('')+'</div>';companyEl.classList.add('visible')}
function summaryCells(summary={},type='growth'){const labels=type==='margin'?['1Y Margin','3Y Avg','5Y Avg','10Y Avg']:['1Y Growth','3Y CAGR','5Y CAGR','10Y CAGR'];const values=[summary.oneYear,summary.threeYears,summary.fiveYears,summary.tenYears];return '<span class="summary-mini">'+labels.map((label,index)=>'<span class="period"><small>'+label+'</small><strong>'+pct(values[index])+'</strong></span>').join('')+'</span>'}
function cleanAssumption(value){if(!Number.isFinite(value))return null;const lower=Math.floor(value);return value-lower>=.75?lower+1:lower}
function assumptionInput(metric,target,suffix=true){return '<div class="assumption-input-wrap"><input class="assumption-input" type="number" step="1" value="" data-metric="'+metric+'" data-target="'+target+'" aria-label="'+metric+' '+target+' assumption">'+(suffix?'<span class="input-suffix">%</span>':'')+'</div>'}
function historicalButton(metric,period,value){if(!Number.isFinite(value))return '<span class="historical-missing">-</span>';return '<button class="historical-btn" type="button" data-metric="'+metric+'" data-period="'+period+'" data-value="'+value+'" title="Use '+pct(value)+' as the active '+activeTarget+' assumption">'+pct(value)+'</button>'}
function assumptionMetric(metricKey,label,summary){const values=summary||{};return '<tr><th scope="row">'+label+'</th>'+[['1Y',values.oneYear],['3Y',values.threeYears],['5Y',values.fiveYears],['10Y',values.tenYears]].map(([period,value])=>'<td class="historical-cell">'+historicalButton(metricKey,period,value)+'</td>').join('')+['low','mid','high'].map(target=>'<td>'+assumptionInput(metricKey,target,true)+'</td>').join('')+'</tr>'}
function blankAssumptionMetric(metricKey,label,suffix){return '<tr><th scope="row">'+label+'</th><td class="historical-cell"><span class="historical-missing">-</span></td><td class="historical-cell"><span class="historical-missing">-</span></td><td class="historical-cell"><span class="historical-missing">-</span></td><td class="historical-cell"><span class="historical-missing">-</span></td>'+['low','mid','high'].map(target=>'<td>'+assumptionInput(metricKey,target,suffix)+'</td>').join('')+'</tr>'}
function sourceFor(metric,target){return assumptionSources[metric]?.[target]||null}
function setSource(metric,target,source){if(!assumptionSources[metric])assumptionSources[metric]={};assumptionSources[metric][target]=source}
function refreshHistoricalHighlights(){assumptionBody.querySelectorAll('.historical-btn').forEach(button=>{const source=sourceFor(button.dataset.metric,activeTarget);button.classList.toggle('used',source?.period===button.dataset.period);const action=source?.period===button.dataset.period?'Remove':'Use';button.title=action+' '+pct(Number(button.dataset.value))+' for the active '+activeTarget+' assumption'})}
function emitAssumption(metric,target,value,sourcePeriod=null,sourceValue=null){window.dispatchEvent(new CustomEvent('dcf-assumption-change',{detail:{metric,target,value,sourcePeriod,sourceValue}}))}
function readAssumptionStore(){try{const parsed=JSON.parse(localStorage.getItem(ASSUMPTION_STORAGE_KEY)||'{}');return parsed&&typeof parsed==='object'?parsed:{}}catch{return {}}}
function collectAssumptions(){const values={};assumptionBody.querySelectorAll('.assumption-input').forEach(input=>{if(!values[input.dataset.metric])values[input.dataset.metric]={};values[input.dataset.metric][input.dataset.target]=input.value===''?null:Number(input.value)});return values}
function hasSavedAssumptions(symbol=currentTicker){const entry=readAssumptionStore()[symbol];if(!entry||!entry.values)return false;return Object.values(entry.values).some(targets=>targets&&Object.values(targets).some(Number.isFinite))}
function refreshRestoreButton(){const available=hasSavedAssumptions();restoreAssumptionsButton.disabled=!available;restoreAssumptionsButton.title=available?'Insert the last assumptions saved for '+currentTicker:'No saved assumptions for '+(currentTicker||'this company')}
function saveAssumptions(){if(!currentTicker)return;const store=readAssumptionStore();const values=collectAssumptions();const hasValues=Object.values(values).some(targets=>Object.values(targets).some(Number.isFinite));if(hasValues)store[currentTicker]={values,updatedAt:new Date().toISOString()};else delete store[currentTicker];try{localStorage.setItem(ASSUMPTION_STORAGE_KEY,JSON.stringify(store))}catch{}refreshRestoreButton()}
function restoreAssumptions(){if(!currentTicker)return;const entry=readAssumptionStore()[currentTicker];if(!entry?.values)return;for(const [metric,targets] of Object.entries(entry.values)){for(const [target,value] of Object.entries(targets||{})){if(Number.isFinite(value))writeAssumption(metric,target,value,{period:'saved',rawValue:value},false)}}refreshHistoricalHighlights();statusEl.innerHTML='<span class="ok">Last assumptions restored for '+escapeHtml(currentTicker)+'.</span>'}
function deleteSavedAssumptions(){if(!currentTicker)return;const store=readAssumptionStore();delete store[currentTicker];try{localStorage.setItem(ASSUMPTION_STORAGE_KEY,JSON.stringify(store))}catch{}refreshRestoreButton()}
function writeAssumption(metric,target,value,source=null,persist=true){const input=assumptionBody.querySelector('.assumption-input[data-metric="'+metric+'"][data-target="'+target+'"]');if(!input)return;input.value=value==null?'':String(value);setSource(metric,target,source);emitAssumption(metric,target,value,source?.period||null,source?.rawValue??null);if(persist)saveAssumptions()}
function renderAssumptionTable(metrics={}){assumptionSources={};assumptionBody.innerHTML=assumptionMetric('revenueGrowth','Revenue Growth',metrics.revenueGrowth?.summary)+assumptionMetric('netMargin','Net Margin',metrics.netMargin?.summary)+assumptionMetric('fcfMargin','FCF Margin',metrics.fcfMargin?.summary)+blankAssumptionMetric('pe','P/E',false)+blankAssumptionMetric('pfcf','P/FCF',false)+blankAssumptionMetric('desiredReturn','Desired Return',true);refreshHistoricalHighlights();refreshRestoreButton()}
function applyHistoricalValue(button){const metric=button.dataset.metric;const period=button.dataset.period;const value=Number(button.dataset.value);const rounded=cleanAssumption(value);if(!Number.isFinite(rounded))return;const current=sourceFor(metric,activeTarget);const alreadySelected=button.classList.contains('used')||current?.period===period;if(alreadySelected){const input=assumptionBody.querySelector('.assumption-input[data-metric="'+metric+'"][data-target="'+activeTarget+'"]');const retained=input&&input.value!==''?Number(input.value):rounded;setSource(metric,activeTarget,null);emitAssumption(metric,activeTarget,Number.isFinite(retained)?retained:null,null,null)}else{writeAssumption(metric,activeTarget,rounded,{period,rawValue:value})}refreshHistoricalHighlights()}
function median(values){const sorted=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!sorted.length)return NaN;const middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2}
function standardDeviation(values){const valid=values.filter(Number.isFinite);if(valid.length<2)return 0;const mean=valid.reduce((sum,value)=>sum+value,0)/valid.length;return Math.sqrt(valid.reduce((sum,value)=>sum+(value-mean)**2,0)/valid.length)}
function clamp(value,min,max){return Math.min(max,Math.max(min,value))}
function cleanSeries(rows,valueKey){return (Array.isArray(rows)?rows:[]).map(row=>({year:Number(row.fiscalYear),value:Number(row[valueKey])})).filter(point=>Number.isFinite(point.year)&&Number.isFinite(point.value)).sort((a,b)=>a.year-b.year)}
function trimOutliers(values){const valid=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(valid.length<5)return valid;const q=index=>{const position=(valid.length-1)*index;const lower=Math.floor(position),upper=Math.ceil(position);return valid[lower]+(valid[upper]-valid[lower])*(position-lower)};const q1=q(.25),q3=q(.75),iqr=q3-q1;const lower=q1-1.5*iqr,upper=q3+1.5*iqr;const trimmed=valid.filter(value=>value>=lower&&value<=upper);return trimmed.length>=3?trimmed:valid}
function recentSlope(values){const valid=values.filter(Number.isFinite).slice(-5);if(valid.length<3)return 0;const n=valid.length;const xMean=(n-1)/2;const yMean=valid.reduce((sum,value)=>sum+value,0)/n;let numerator=0,denominator=0;for(let index=0;index<n;index++){numerator+=(index-xMean)*(valid[index]-yMean);denominator+=(index-xMean)**2}return denominator?numerator/denominator:0}
function adaptiveScenario(rows,valueKey,type,profile='mid'){const series=cleanSeries(rows,valueKey);if(!series.length)return null;const raw=series.map(point=>point.value);const values=trimOutliers(raw);const recent3=trimOutliers(raw.slice(-3));const recent5=trimOutliers(raw.slice(-5));const allMedian=median(values);const recentMedian=median(recent3);const mediumMedian=median(recent5);let base;if(raw.length>=5)base=.5*recentMedian+.3*mediumMedian+.2*allMedian;else if(raw.length>=3)base=.65*recentMedian+.35*allMedian;else base=allMedian;const slope=recentSlope(raw);const trendLimit=type==='growth'?3:2;base+=clamp(slope*.45,-trendLimit,trendLimit);const volatility=standardDeviation(values);const historyPenalty=raw.length>=8?0:raw.length>=5?.75:raw.length>=3?1.5:2.5;const minimumSpread=type==='growth'?2:1.5;const maximumSpread=type==='growth'?8:6;const spread=clamp(volatility*.55+historyPenalty,minimumSpread,maximumSpread);const profileShift=profile==='low'?-spread*.35:profile==='high'?spread*.35:0;base+=profileShift;let low=base-spread,mid=base,high=base+spread;if(type==='growth'){const recentPeak=Math.max(...raw.slice(-Math.min(5,raw.length)));high=Math.min(high,recentPeak+Math.max(0,profileShift));low=Math.min(low,mid-1)}else{const observedMin=Math.min(...values),observedMax=Math.max(...values);low=Math.max(low,observedMin-spread*.25);high=Math.min(high,observedMax+spread*.25+Math.max(0,profileShift))}const result={low:cleanAssumption(low),mid:cleanAssumption(mid),high:cleanAssumption(high)};if(result.low>result.mid)result.low=result.mid;if(result.high<result.mid)result.high=result.mid;return result}
function buildScenarios(){const definitions=[['revenueGrowth',currentMetrics.revenueGrowth?.annual,'growthPercentage','growth'],['netMargin',currentMetrics.netMargin?.annual,'marginPercentage','margin'],['fcfMargin',currentMetrics.fcfMargin?.annual,'marginPercentage','margin']];for(const [metric,rows,valueKey,type] of definitions){const values=adaptiveScenario(rows,valueKey,type,activeTarget);if(!values)continue;for(const target of ['low','mid','high'])writeAssumption(metric,target,values[target],{period:'preset',rawValue:values[target]})}refreshHistoricalHighlights()}
function clearScenarios(){assumptionBody.querySelectorAll('.assumption-input').forEach(input=>{input.value='';setSource(input.dataset.metric,input.dataset.target,null);emitAssumption(input.dataset.metric,input.dataset.target,null,null,null)});deleteSavedAssumptions();refreshHistoricalHighlights()}

function chartValue(value,isPercent=false){if(!Number.isFinite(value))return '-';if(isPercent)return value.toFixed(2)+'%';const abs=Math.abs(value);if(abs>=1e12)return '$'+(value/1e12).toFixed(1)+'T';if(abs>=1e9)return '$'+(value/1e9).toFixed(1)+'B';if(abs>=1e6)return '$'+(value/1e6).toFixed(1)+'M';if(abs>=1000)return '$'+(value/1000).toFixed(1)+'K';return '$'+value.toFixed(1)}
function quarterLabel(date){const value=String(date||'');if(!value)return '-';const parsed=new Date(value+'T00:00:00Z');if(Number.isNaN(parsed.getTime()))return value;return parsed.toLocaleDateString('en-GB',{month:'short',year:'numeric',timeZone:'UTC'})}
function pointsForFrequency(config){return selectedFrequency==='quarterly'?(config.quarterlyPoints||[]):config.points||[]}
function rowsForFrequency(config){return selectedFrequency==='quarterly'?(config.quarterly||[]):config.annual||[]}
function visiblePointCount(){if(selectedTimeframe==='max')return 'max';return selectedFrequency==='quarterly'?selectedTimeframe*4:selectedTimeframe}
function mainChartConfig(){const config=metricConfig(historicalMetricSelect.value,currentMetrics);if(!config)return null;return {...config,isPercent:['netMargin','roic'].includes(historicalMetricSelect.value)}}
function mainChartSvg(config){const source=pointsForFrequency(config);const clean=source.map(point=>({label:String(point.label??point.year),sortKey:String(point.sortKey??point.year),value:Number(point.value)})).filter(point=>Number.isFinite(point.value)).sort((a,b)=>a.sortKey.localeCompare(b.sortKey));const count=visiblePointCount();const visible=count==='max'?clean:clean.slice(-count);if(visible.length<2)return '<div class="empty">Not enough '+selectedFrequency+' data for this chart.</div>';const width=920,height=350,left=76,right=24,top=42,bottom=55;const values=visible.map(point=>point.value);let min=Math.min(...values),max=Math.max(...values);if(selectedChartType==='bar'){min=Math.min(0,min);max=Math.max(0,max)}if(min===max){min-=1;max+=1}const pad=(max-min)*.1||1;const plotMin=min-pad,plotMax=max+pad;const plotW=width-left-right,plotH=height-top-bottom;const xLine=index=>left+(index*plotW)/(visible.length-1);const slot=plotW/visible.length;const xBar=index=>left+index*slot+slot*.14;const barW=Math.max(3,slot*.72);const y=value=>top+((plotMax-value)*plotH)/(plotMax-plotMin);const ticks=[plotMax,plotMin+(plotMax-plotMin)*.75,plotMin+(plotMax-plotMin)*.5,plotMin+(plotMax-plotMin)*.25,plotMin];const grids=ticks.map(value=>'<line class="main-chart-grid" x1="'+left+'" y1="'+y(value).toFixed(1)+'" x2="'+(width-right)+'" y2="'+y(value).toFixed(1)+'"></line><text class="main-chart-label" x="'+(left-10)+'" y="'+(y(value)+4).toFixed(1)+'" text-anchor="end">'+chartValue(value,config.isPercent)+'</text>').join('');const zero=plotMin<0&&plotMax>0?'<line class="main-chart-zero" x1="'+left+'" y1="'+y(0).toFixed(1)+'" x2="'+(width-right)+'" y2="'+y(0).toFixed(1)+'"></line>':'';const step=Math.max(1,Math.ceil(visible.length/10));const labels=visible.map((point,index)=>{if(index!==0&&index!==visible.length-1&&index%step!==0)return '';const x=selectedChartType==='bar'?xBar(index)+barW/2:xLine(index);return '<text class="main-chart-label" x="'+x.toFixed(1)+'" y="'+(height-22)+'" text-anchor="middle">'+escapeHtml(point.label)+'</text>'}).join('');let marks='';if(selectedChartType==='bar'){const zeroY=y(0);marks=visible.map((point,index)=>{const valueY=y(point.value);const topY=Math.min(valueY,zeroY);const h=Math.max(1,Math.abs(zeroY-valueY));return '<rect class="main-chart-bar" x="'+xBar(index).toFixed(1)+'" y="'+topY.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+h.toFixed(1)+'" rx="3"><title>'+escapeHtml(point.label)+': '+chartValue(point.value,config.isPercent)+'</title></rect>'}).join('')}else{const points=visible.map((point,index)=>xLine(index).toFixed(1)+','+y(point.value).toFixed(1)).join(' ');marks='<polyline class="main-chart-line" points="'+points+'"></polyline>'+visible.map((point,index)=>'<circle class="main-chart-point" cx="'+xLine(index).toFixed(1)+'" cy="'+y(point.value).toFixed(1)+'" r="4"><title>'+escapeHtml(point.label)+': '+chartValue(point.value,config.isPercent)+'</title></circle>').join('')}return '<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+escapeHtml(config.label)+' historical '+selectedChartType+' chart">'+grids+zero+'<text class="main-chart-title" x="'+left+'" y="22">'+escapeHtml(config.label)+' \xB7 '+(selectedFrequency==='quarterly'?'Quarterly':'Annual')+'</text>'+marks+labels+'</svg>'}
function renderMainHistoricalChart(){const config=mainChartConfig();if(!config){historicalMainChart.innerHTML='<div class="empty">This metric is unavailable.</div>';historicalChartSummary.innerHTML='';historicalChartTable.innerHTML='';return}const source=pointsForFrequency(config);const count=visiblePointCount();const clean=source.map(point=>({label:String(point.label??point.year),sortKey:String(point.sortKey??point.year),value:Number(point.value)})).filter(point=>Number.isFinite(point.value)).sort((a,b)=>a.sortKey.localeCompare(b.sortKey));const visible=count==='max'?clean:clean.slice(-count);const quarterlyUnavailable=selectedFrequency==='quarterly'&&clean.length<2;historicalAvailability.className='history-note'+(quarterlyUnavailable?' warning':'');historicalAvailability.textContent=quarterlyUnavailable?(config.quarterlyUnavailableReason||'Quarterly data is not available for this metric yet.'):(selectedFrequency==='quarterly'?'Quarterly values use each reported quarter, not trailing-twelve-month totals.':'Annual values use completed fiscal years.');historicalMainChart.innerHTML=mainChartSvg(config);const latest=visible.at(-1);const first=visible[0];let totalChange=null;if(first&&latest&&Number(first.value)!==0)totalChange=((Number(latest.value)/Number(first.value))-1)*100;let recentChange=null;let recentLabel=selectedFrequency==='quarterly'?'QoQ change':'1Y change';if(visible.length>1&&Number(visible.at(-2).value)!==0)recentChange=((Number(latest.value)/Number(visible.at(-2).value))-1)*100;let yoyChange=null;if(selectedFrequency==='quarterly'&&visible.length>4&&Number(visible.at(-5).value)!==0)yoyChange=((Number(latest.value)/Number(visible.at(-5).value))-1)*100;const changeValue=config.isPercent&&first&&latest?(Number(latest.value)-Number(first.value)).toFixed(2)+' pp':pct(totalChange);const recentValue=config.isPercent&&visible.length>1?(Number(latest.value)-Number(visible.at(-2).value)).toFixed(2)+' pp':pct(recentChange);historicalChartSummary.innerHTML='<div class="chart-summary-item"><small>Latest</small><strong>'+chartValue(Number(latest?.value),config.isPercent)+'</strong></div><div class="chart-summary-item"><small>Range</small><strong>'+(first&&latest?escapeHtml(first.label)+'\u2013'+escapeHtml(latest.label):'-')+'</strong></div><div class="chart-summary-item"><small>'+recentLabel+'</small><strong>'+recentValue+'</strong></div><div class="chart-summary-item"><small>'+(selectedFrequency==='quarterly'?'YoY change':'Total change')+'</small><strong>'+(selectedFrequency==='quarterly'?(config.isPercent&&visible.length>4?(Number(latest.value)-Number(visible.at(-5).value)).toFixed(2)+' pp':pct(yoyChange)):changeValue)+'</strong></div>';historicalChartTable.innerHTML=tableFor(config.tableKey,rowsForFrequency(config),selectedFrequency);historyDescription.textContent=selectedFrequency==='quarterly'?'Reported quarter-end figures. Growth compares with the same quarter one year earlier.':'Completed fiscal-year figures and year-over-year changes.'}
function sparkline(points=[]){const clean=points.map(point=>({year:Number(point.year),value:Number(point.value)})).filter(point=>Number.isFinite(point.year)&&Number.isFinite(point.value));const visible=selectedTimeframe==='max'?clean:clean.slice(-selectedTimeframe);if(visible.length<2)return '<span class="sparkline-empty">Not enough history for this timeframe</span>';const values=visible.map(point=>point.value);const width=340,height=82,left=4,right=48,top=8,bottom=10;let min=Math.min(...values),max=Math.max(...values);if(min===max){min-=1;max+=1}const range=max-min;const plotMin=min-range*.08,plotMax=max+range*.08;const x=index=>left+(index*(width-left-right))/(values.length-1);const y=value=>top+((plotMax-value)*(height-top-bottom))/(plotMax-plotMin);const linePoints=values.map((value,index)=>x(index).toFixed(1)+','+y(value).toFixed(1)).join(' ');const labelValue=value=>{const abs=Math.abs(value);if(abs>=1e12)return '$'+(value/1e12).toFixed(1)+'T';if(abs>=1e9)return '$'+(value/1e9).toFixed(1)+'B';if(abs>=1e6)return '$'+(value/1e6).toFixed(1)+'M';if(abs>=1000)return '$'+(value/1000).toFixed(1)+'K';if(abs<=1&&abs!==0)return (value*100).toFixed(1)+'%';return Number(value).toFixed(1)};const mid=(min+max)/2;const grids=[max,mid,min].map(v=>'<line class="grid" x1="'+left+'" y1="'+y(v).toFixed(1)+'" x2="'+(width-right)+'" y2="'+y(v).toFixed(1)+'"></line><text class="axis-label" x="'+(width-right+5)+'" y="'+(y(v)+3).toFixed(1)+'">'+labelValue(v)+'</text>').join('');const crossesZero=min<0&&max>0;const zeroLine=crossesZero?'<line class="baseline" x1="'+left+'" y1="'+y(0).toFixed(1)+'" x2="'+(width-right)+'" y2="'+y(0).toFixed(1)+'"></line>':'';const pointDots=visible.map((point,index)=>'<circle class="point" cx="'+x(index).toFixed(1)+'" cy="'+y(point.value).toFixed(1)+'" r="3.5"><title>'+point.year+': '+labelValue(point.value)+'</title></circle>').join('');const lastX=x(values.length-1).toFixed(1),lastY=y(values[values.length-1]).toFixed(1);const firstYear=visible[0].year,lastYear=visible[visible.length-1].year;return '<span class="spark-wrap"><svg class="sparkline" viewBox="0 0 '+width+' '+height+'" preserveAspectRatio="none" role="img" aria-label="Annual trend from '+firstYear+' to '+lastYear+'">'+grids+zeroLine+'<polyline class="line" points="'+linePoints+'"></polyline>'+pointDots+'<circle class="dot" cx="'+lastX+'" cy="'+lastY+'" r="3.5"></circle></svg><span class="spark-years"><span>'+firstYear+'</span><span>'+lastYear+'</span></span></span>'}
function tableFor(key,rows,frequency='annual'){if(!Array.isArray(rows)||rows.length===0)return '<div class="empty">No '+frequency+' history is available for this metric.</div>';const quarterly=frequency==='quarterly';const newest=[...rows].sort((a,b)=>String(b.date||b.fiscalYear).localeCompare(String(a.date||a.fiscalYear)));const periodHead=quarterly?'Quarter ended':'Fiscal year';const periodValue=row=>quarterly?quarterLabel(row.date):escapeHtml(row.fiscalYear);const growthHead=quarterly?'YoY growth':'YoY growth';if(key==='revenueGrowth'){return '<div class="table-wrap"><table><thead><tr><th>'+periodHead+'</th><th>Revenue</th><th>'+growthHead+'</th></tr></thead><tbody>'+newest.map(row=>'<tr><td>'+periodValue(row)+'</td><td>'+moneyBillions(row.revenueBillions)+'</td><td>'+pct(row.growthPercentage)+'</td></tr>').join('')+'</tbody></table></div>'}if(key==='netIncomeGrowth'){return '<div class="table-wrap"><table><thead><tr><th>'+periodHead+'</th><th>Net income</th><th>'+growthHead+'</th></tr></thead><tbody>'+newest.map(row=>'<tr><td>'+periodValue(row)+'</td><td>'+moneyBillions(row.netIncomeBillions)+'</td><td>'+pct(row.growthPercentage)+'</td></tr>').join('')+'</tbody></table></div>'}if(key==='freeCashFlowGrowth'){return '<div class="table-wrap"><table><thead><tr><th>'+periodHead+'</th><th>Free cash flow</th><th>'+growthHead+'</th></tr></thead><tbody>'+newest.map(row=>'<tr><td>'+periodValue(row)+'</td><td>'+moneyBillions(row.freeCashFlowBillions)+'</td><td>'+pct(row.growthPercentage)+'</td></tr>').join('')+'</tbody></table></div>'}if(key==='netMargin'){return '<div class="table-wrap"><table><thead><tr><th>'+periodHead+'</th><th>Revenue</th><th>Net income</th><th>Net margin</th></tr></thead><tbody>'+newest.map(row=>'<tr><td>'+periodValue(row)+'</td><td>'+moneyBillions(row.revenueBillions)+'</td><td>'+moneyBillions(row.netIncomeBillions)+'</td><td>'+pct(row.marginPercentage??row.netMarginPercentage)+'</td></tr>').join('')+'</tbody></table></div>'}if(key==='roic'){return '<div class="table-wrap"><table><thead><tr><th>Fiscal year</th><th>ROIC</th><th>Net income</th><th>Invested capital</th><th>Finviz-style long-term debt</th></tr></thead><tbody>'+newest.map(row=>'<tr><td>'+escapeHtml(row.fiscalYear)+'</td><td>'+pct(row.roicPercentage)+'</td><td>'+compactMoney(row.netIncome,'USD')+'</td><td>'+compactMoney(row.investedCapital,'USD')+'</td><td>'+compactMoney(row.finvizStyleLongTermDebt,'USD')+'</td></tr>').join('')+'</tbody></table></div>'}return '<div class="table-wrap"><table><thead><tr><th>Fiscal year</th><th>Revenue</th><th>Free cash flow</th><th>FCF margin</th></tr></thead><tbody>'+newest.map(row=>'<tr><td>'+escapeHtml(row.fiscalYear)+'</td><td>'+moneyBillions(row.revenueBillions)+'</td><td>'+moneyBillions(row.freeCashFlowBillions)+'</td><td>'+pct(row.marginPercentage)+'</td></tr>').join('')+'</tbody></table></div>'}
function metricConfig(key,metrics){if(key==='revenue'){const metric=metrics.revenueGrowth;return metric&&{label:'Revenue',annual:metric.annual,quarterly:metric.quarterly||[],summary:metric.summary,summaryType:'growth',points:metric.annual.map(row=>({year:row.fiscalYear,label:String(row.fiscalYear),sortKey:String(row.fiscalYear),value:row.revenueBillions})),quarterlyPoints:(metric.quarterly||[]).map(row=>({label:quarterLabel(row.date),sortKey:row.date,value:row.revenueBillions})),latest:moneyBillions(metric.annual.at(-1)?.revenueBillions),tableKey:'revenueGrowth'}}if(key==='netIncome'){const metric=metrics.netIncomeGrowth;return metric&&{label:'Net Income',annual:metric.annual,quarterly:metric.quarterly||[],summary:metric.summary,summaryType:'growth',points:metric.annual.map(row=>({year:row.fiscalYear,label:String(row.fiscalYear),sortKey:String(row.fiscalYear),value:row.netIncomeBillions})),quarterlyPoints:(metric.quarterly||[]).map(row=>({label:quarterLabel(row.date),sortKey:row.date,value:row.netIncomeBillions})),latest:moneyBillions(metric.annual.at(-1)?.netIncomeBillions),tableKey:'netIncomeGrowth'}}if(key==='freeCashFlow'){const metric=metrics.freeCashFlowGrowth;return metric&&{label:'Free Cash Flow',annual:metric.annual,quarterly:[],quarterlyUnavailableReason:'Quarterly free cash flow is not shown yet because cash-flow statements can be reported cumulatively and need additional normalisation.',summary:metric.summary,summaryType:'growth',points:metric.annual.map(row=>({year:row.fiscalYear,label:String(row.fiscalYear),sortKey:String(row.fiscalYear),value:row.freeCashFlowBillions})),quarterlyPoints:[],latest:moneyBillions(metric.annual.at(-1)?.freeCashFlowBillions),tableKey:'freeCashFlowGrowth'}}if(key==='netMargin'){const metric=metrics.netMargin;return metric&&{label:'Net Margin',annual:metric.annual,quarterly:metric.quarterly||[],summary:metric.summary,summaryType:'margin',points:metric.annual.map(row=>({year:row.fiscalYear,label:String(row.fiscalYear),sortKey:String(row.fiscalYear),value:row.marginPercentage})),quarterlyPoints:(metric.quarterly||[]).map(row=>({label:quarterLabel(row.date),sortKey:row.date,value:row.marginPercentage??row.netMarginPercentage})),latest:pct(metric.annual.at(-1)?.marginPercentage),tableKey:'netMargin'}}if(key==='roic'){const metric=metrics.roic;return metric&&{label:'ROIC (Finviz-style; error of +/- 5% possible)',annual:metric.annual,quarterly:[],quarterlyUnavailableReason:'Quarterly ROIC is not available yet because it requires reliable quarter-end equity, debt and operating-lease balances.',summary:metric.summary,summaryType:'margin',points:metric.annual.map(row=>({year:row.fiscalYear,label:String(row.fiscalYear),sortKey:String(row.fiscalYear),value:row.roicPercentage})),quarterlyPoints:[],latest:pct(metric.annual.at(-1)?.roicPercentage),tableKey:'roic'}}return null}
function updateTimeframeButtons(){const labels=selectedFrequency==='quarterly'?[['1','1Y'],['3','3Y'],['5','5Y'],['10','10Y'],['max','MAX']]:[['3','3Y'],['5','5Y'],['10','10Y'],['max','MAX']];timeframeControl.innerHTML=labels.map(([value,label])=>'<button class="timeframe-btn'+(String(selectedTimeframe)===value?' active':'')+'" type="button" data-years="'+value+'">'+label+'</button>').join('')}
function renderHistory(metrics={}){currentMetrics=metrics;renderAssumptionTable(metrics);updateTimeframeButtons();renderMainHistoricalChart()}
async function getPreparedSnapshot(tickerValue){const response=await fetch('/data/'+encodeURIComponent(tickerValue)+'.json',{cache:'force-cache'});const text=await response.text();let json;try{json=JSON.parse(text)}catch{throw new Error('Prepared company data is invalid.')}if(!response.ok||json?.meta?.schema!=='stock-platform.company-snapshot'||json?.meta?.version!==2)throw new Error(json?.error||'Prepared company data is unavailable or uses an unsupported schema.');return json}
function companyFromSnapshot(snapshot){return{ok:true,ticker:snapshot.identity.ticker,companyName:snapshot.identity.companyName,exchange:snapshot.identity.exchange,currency:snapshot.identity.currency,price:null,marketCap:null,enterpriseValue:null,revenueTtm:snapshot.financials?.ttm?.revenue??null,netIncomeTtm:snapshot.financials?.ttm?.netIncome??null,freeCashFlowTtm:snapshot.financials?.ttm?.freeCashFlow??null,cash:snapshot.financials?.balanceSheet?.cash??null,totalDebt:snapshot.financials?.balanceSheet?.totalDebt??null,sharesOutstanding:snapshot.financials?.balanceSheet?.sharesOutstanding??null,asOf:snapshot.financials?.asOf||{},roic:snapshot.metrics?.roic??null,roicFiscalYear:snapshot.metrics?.roicFiscalYear??null,availability:{quote:false,marketCap:false,enterpriseValue:false,...(snapshot.quality?.availability||{})},fields:snapshot.quality?.fields||{},diagnostics:{},methodology:{},source:{providers:snapshot.sources||[]},liveFields:snapshot.live?.fields||['price','marketCap','enterpriseValue']}}
function mergeLiveQuote(company,quote){const shares=Number(company.sharesOutstanding);const debt=Number(company.totalDebt);const cash=Number(company.cash);const price=Number(quote.price);const marketCap=Number.isFinite(price)&&Number.isFinite(shares)?price*shares:null;const enterpriseValue=Number.isFinite(marketCap)&&Number.isFinite(debt)&&Number.isFinite(cash)?marketCap+debt-cash:null;return {...company,companyName:quote.companyName||company.companyName,exchange:quote.exchangeLabel||company.exchange,currency:quote.currency||company.currency,price:Number.isFinite(price)?price:null,marketCap,enterpriseValue}}
async function load(){try{const value=symbol();currentTicker=value;statusEl.textContent='Loading '+value+' prepared data...';companyEl.classList.remove('visible');companyEl.innerHTML='';const [snapshot,quote]=await Promise.all([getPreparedSnapshot(value),getJson('quote',value)]);const company=mergeLiveQuote(companyFromSnapshot(snapshot),quote);renderCompany(company);renderHistory(snapshot.history.metrics);statusEl.innerHTML='<span class="ok">'+escapeHtml(value)+' loaded.</span> Use the chart controls to inspect annual or quarterly figures.'}catch(error){statusEl.innerHTML='<span class="bad">'+escapeHtml(error.message)+'</span>';companyEl.classList.remove('visible');companyEl.innerHTML='';historyEl.innerHTML=''}}
historicalMetricSelect.addEventListener('change',renderMainHistoricalChart);frequencyControl.addEventListener('click',event=>{const button=event.target.closest('[data-frequency]');if(!button)return;selectedFrequency=button.dataset.frequency;frequencyControl.querySelectorAll('[data-frequency]').forEach(item=>item.classList.toggle('active',item===button));selectedTimeframe=selectedFrequency==='quarterly'?3:10;updateTimeframeButtons();renderMainHistoricalChart()});chartTypeControl.addEventListener('click',event=>{const button=event.target.closest('.chart-type-btn');if(!button)return;selectedChartType=button.dataset.chartType;chartTypeControl.querySelectorAll('.chart-type-btn').forEach(item=>item.classList.toggle('active',item===button));renderMainHistoricalChart()});historicalTableToggle.addEventListener('click',()=>{const open=historicalChartTable.classList.toggle('open');historicalTableToggle.setAttribute('aria-expanded',String(open));historicalTableToggle.textContent=open?'Hide data table':'Show data table'});targetControl.addEventListener('click',event=>{const button=event.target.closest('.target-btn');if(!button)return;activeTarget=button.dataset.target;targetControl.querySelectorAll('.target-btn').forEach(item=>item.classList.toggle('active',item===button));refreshHistoricalHighlights()});restoreAssumptionsButton.addEventListener('click',restoreAssumptions);buildScenariosButton.addEventListener('click',buildScenarios);clearScenariosButton.addEventListener('click',clearScenarios);assumptionBody.addEventListener('click',event=>{const button=event.target.closest('.historical-btn');if(button)applyHistoricalValue(button)});assumptionBody.addEventListener('input',event=>{const input=event.target.closest('.assumption-input');if(!input)return;setSource(input.dataset.metric,input.dataset.target,null);refreshHistoricalHighlights();const value=input.value===''?null:Number(input.value);emitAssumption(input.dataset.metric,input.dataset.target,value,null,null);saveAssumptions()});timeframeControl.addEventListener('click',event=>{const button=event.target.closest('.timeframe-btn');if(!button)return;selectedTimeframe=button.dataset.years==='max'?'max':Number(button.dataset.years);timeframeControl.querySelectorAll('.timeframe-btn').forEach(item=>item.classList.toggle('active',item===button));renderMainHistoricalChart()});document.getElementById('loadBtn').addEventListener('click',load);ticker.addEventListener('keydown',event=>{if(event.key==='Enter')load()});load();
<\/script></main></body></html>`;

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// .wrangler/tmp/bundle-pzo8hW/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-pzo8hW/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
