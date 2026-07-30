const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

const ALLOWED_US_EXCHANGES = new Set(['NYQ', 'NMS', 'NGM', 'NCM', 'ASE']);
const EXCHANGE_LABELS = {
  NYQ: 'NYSE',
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  ASE: 'NYSE American'
};

async function fetchYahooJson(path, params = {}, createError) {
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    const url = new URL(`https://${host}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; StockValuationTool/1.0)',
          Referer: 'https://finance.yahoo.com/'
        },
        cf: { cacheEverything: true, cacheTtl: 120 }
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const error = new Error(body?.finance?.error?.description || response.statusText || 'Yahoo request failed');
        error.status = response.status;
        throw error;
      }
      return { body, host };
    } catch (error) {
      lastError = error;
    }
  }
  const status = Number(lastError?.status) || 502;
  throw createError(status, `Yahoo Finance request failed: ${lastError?.message || 'unknown error'}`);
}

export async function searchYahooEquities(query, { version, createError }) {
  if (!query || query.length > 80) throw createError(400, 'Enter a company name or ticker.');
  const { body } = await fetchYahooJson('/v1/finance/search', {
    q: query,
    quotesCount: '20',
    newsCount: '0',
    enableFuzzyQuery: 'true',
    quotesQueryId: 'tss_match_phrase_query'
  }, createError);
  const results = (Array.isArray(body.quotes) ? body.quotes : [])
    .filter(row => String(row.quoteType || '').toUpperCase() === 'EQUITY')
    .filter(row => ALLOWED_US_EXCHANGES.has(String(row.exchange || row.exchDisp || '').toUpperCase()))
    .map(row => {
      const exchangeCode = String(row.exchange || '').toUpperCase();
      return {
        symbol: String(row.symbol || '').toUpperCase(),
        name: row.longname || row.shortname || row.symbol,
        exchangeCode,
        exchange: EXCHANGE_LABELS[exchangeCode] || row.exchDisp || exchangeCode,
        quoteType: 'EQUITY'
      };
    })
    .filter(row => row.symbol);
  return { ok: true, version, query, results };
}

export async function fetchYahooQuote(ticker, { version, createError }) {
  const { body, host } = await fetchYahooJson(`/v8/finance/chart/${encodeURIComponent(ticker)}`, {
    interval: '1d',
    range: '5d'
  }, createError);
  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta) throw createError(404, `Yahoo returned no quote for ${ticker}.`);
  const quoteType = String(meta.instrumentType || meta.quoteType || '').toUpperCase();
  const exchangeCode = String(meta.exchangeName || '').toUpperCase();
  if (quoteType && quoteType !== 'EQUITY') throw createError(400, `${ticker} is not an equity.`);
  if (exchangeCode && !ALLOWED_US_EXCHANGES.has(exchangeCode)) throw createError(400, `${ticker} is not a supported US-listed equity.`);
  return {
    ok: true,
    version,
    ticker,
    quoteType: quoteType || 'EQUITY',
    exchangeCode,
    exchangeLabel: meta.fullExchangeName || exchangeCode,
    companyName: meta.longName || meta.shortName || ticker,
    longName: meta.longName || null,
    shortName: meta.shortName || null,
    currency: meta.currency || 'USD',
    price: Number(meta.regularMarketPrice ?? meta.chartPreviousClose ?? meta.previousClose) || null,
    regularMarketPrice: Number(meta.regularMarketPrice) || null,
    sourceHost: host,
    chart: body.chart
  };
}

export async function fetchYahooTtmCashFlow(ticker, { createError, parseNumber }) {
  const types = [
    'trailingOperatingCashFlow',
    'trailingCapitalExpenditure',
    'trailingFreeCashFlow'
  ];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const period1 = nowSeconds - (10 * 365 * 24 * 60 * 60);
  const period2 = nowSeconds + (2 * 24 * 60 * 60);
  let lastError = null;

  for (const host of YAHOO_HOSTS) {
    const target = new URL(`https://${host}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`);
    target.searchParams.set('symbol', ticker);
    target.searchParams.set('type', types.join(','));
    target.searchParams.set('period1', String(period1));
    target.searchParams.set('period2', String(period2));

    try {
      const response = await fetch(target.toString(), {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/cash-flow/`
        },
        cf: { cacheEverything: true, cacheTtl: 300 }
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw createError(502, `Yahoo ${host} returned non-JSON: ${text.slice(0, 180)}`);
      }

      if (!response.ok) {
        throw createError(response.status, payload?.finance?.error?.description || `Yahoo ${host} returned HTTP ${response.status}.`, payload);
      }

      const result = payload?.timeseries?.result;
      if (!Array.isArray(result)) {
        throw createError(502, `Yahoo ${host} returned no timeseries result.`, payload);
      }

      const operatingFact = extractLatestYahooFact(result, 'trailingOperatingCashFlow', parseNumber);
      const capexFact = extractLatestYahooFact(result, 'trailingCapitalExpenditure', parseNumber);
      const directFcfFact = extractLatestYahooFact(result, 'trailingFreeCashFlow', parseNumber);

      if (!operatingFact || !capexFact) {
        throw createError(502, `Yahoo returned incomplete TTM cash-flow data for ${ticker}.`, {
          foundOperatingCashFlow: Boolean(operatingFact),
          foundCapitalExpenditure: Boolean(capexFact),
          returnedTypes: result.map(item => item?.meta?.type?.[0] || item?.type).filter(Boolean)
        });
      }

      const operatingCashFlow = operatingFact.raw;
      const capitalExpenditures = Math.abs(capexFact.raw);
      const calculatedFreeCashFlow = operatingCashFlow - capitalExpenditures;
      const directFreeCashFlow = directFcfFact?.raw;

      const freeCashFlow = calculatedFreeCashFlow;
      const asOfDate = [operatingFact.asOfDate, capexFact.asOfDate, directFcfFact?.asOfDate]
        .filter(Boolean)
        .sort()
        .at(-1) || null;

      return {
        host,
        types,
        currency: operatingFact.currency || capexFact.currency || directFcfFact?.currency || 'USD',
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

  throw lastError || createError(502, 'Yahoo Finance TTM cash-flow data is unavailable.');
}

export async function fetchYahooAnnualDilutedEps(ticker, { createError, parseNumber }) {
  const type = 'annualDilutedEPS';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const period1 = nowSeconds - (25 * 365 * 24 * 60 * 60);
  const period2 = nowSeconds + (2 * 24 * 60 * 60);
  let lastError = null;

  for (const host of YAHOO_HOSTS) {
    const target = new URL(`https://${host}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`);
    target.searchParams.set('symbol', ticker);
    target.searchParams.set('type', type);
    target.searchParams.set('period1', String(period1));
    target.searchParams.set('period2', String(period2));

    try {
      const response = await fetch(target.toString(), {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/financials/`
        },
        cf: { cacheEverything: true, cacheTtl: 3600 }
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw createError(502, `Yahoo ${host} returned non-JSON EPS history.`);
      }

      if (!response.ok) {
        throw createError(response.status, payload?.finance?.error?.description || `Yahoo ${host} returned HTTP ${response.status}.`);
      }

      const result = Array.isArray(payload?.timeseries?.result) ? payload.timeseries.result : [];
      const series = [];
      for (const item of result) {
        const facts = Array.isArray(item?.[type]) ? item[type] : [];
        for (const fact of facts) {
          const value = parseNumber(fact?.reportedValue?.raw ?? fact?.raw);
          const date = String(fact?.asOfDate || '').slice(0, 10);
          const fiscalYear = Number(date.slice(0, 4));
          if (!Number.isFinite(value) || !Number.isFinite(fiscalYear)) continue;
          series.push({ fiscalYear, date, value, source: `Yahoo ${type}` });
        }
      }

      const byYear = new Map();
      for (const row of series.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        byYear.set(row.fiscalYear, row);
      }
      const annualSeries = [...byYear.values()].sort((a, b) => a.fiscalYear - b.fiscalYear);
      if (annualSeries.length < 2) throw createError(502, `Yahoo returned insufficient annual EPS history for ${ticker}.`);
      return { host, type, annualSeries };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || createError(502, 'Yahoo annual diluted EPS history is unavailable.');
}

function extractLatestYahooFact(result, type, parseNumber) {
  const candidates = [];

  for (const item of result) {
    const itemType = item?.meta?.type?.[0] || item?.type || '';
    if (itemType !== type && !Object.prototype.hasOwnProperty.call(item || {}, type)) continue;

    const facts = Array.isArray(item?.[type]) ? item[type] : [];
    for (const fact of facts) {
      const raw = parseNumber(fact?.reportedValue?.raw ?? fact?.raw);
      if (!Number.isFinite(raw)) continue;
      candidates.push({
        raw,
        asOfDate: String(fact?.asOfDate || '').slice(0, 10) || null,
        currency: fact?.currencyCode || item?.meta?.currencyCode || null
      });
    }
  }

  return candidates
    .sort((a, b) => String(a.asOfDate || '').localeCompare(String(b.asOfDate || '')))
    .at(-1) || null;
}

// Latest balance-sheet snapshot from Yahoo's fundamentals timeseries.
// Debt is defined as interest-bearing current debt plus long-term debt.
// Yahoo's generic TotalDebt field can include lease obligations for some companies,
// so it is used only as a last-resort fallback.
export async function fetchYahooBalanceSnapshot(ticker, { createError, parseNumber }) {
  const types = [
    'quarterlyCurrentDebt',
    'annualCurrentDebt',
    'quarterlyLongTermDebt',
    'annualLongTermDebt',
    'quarterlyTotalDebt',
    'annualTotalDebt',
    'quarterlyCashCashEquivalentsAndShortTermInvestments',
    'annualCashCashEquivalentsAndShortTermInvestments',
    'quarterlyCashAndCashEquivalents',
    'annualCashAndCashEquivalents',
    'quarterlyOrdinarySharesNumber',
    'annualOrdinarySharesNumber'
  ];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const period1 = nowSeconds - (8 * 365 * 24 * 60 * 60);
  const period2 = nowSeconds + (2 * 24 * 60 * 60);
  let lastError = null;

  for (const host of YAHOO_HOSTS) {
    const target = new URL(`https://${host}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`);
    target.searchParams.set('symbol', ticker);
    target.searchParams.set('type', types.join(','));
    target.searchParams.set('period1', String(period1));
    target.searchParams.set('period2', String(period2));

    try {
      const response = await fetch(target.toString(), {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/balance-sheet/`
        },
        cf: { cacheEverything: true, cacheTtl: 300 }
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw createError(502, `Yahoo ${host} returned non-JSON balance-sheet data.`);
      }
      if (!response.ok) {
        throw createError(response.status, payload?.finance?.error?.description || `Yahoo ${host} returned HTTP ${response.status}.`);
      }

      const result = Array.isArray(payload?.timeseries?.result) ? payload.timeseries.result : [];
      const choose = (preferredTypes) => {
        for (const type of preferredTypes) {
          const fact = extractLatestYahooFact(result, type, parseNumber);
          if (fact && Number.isFinite(fact.raw)) return { ...fact, type };
        }
        return null;
      };

      const quarterlyCurrentDebt = choose(['quarterlyCurrentDebt']);
      const quarterlyLongTermDebt = choose(['quarterlyLongTermDebt']);
      const annualCurrentDebt = choose(['annualCurrentDebt']);
      const annualLongTermDebt = choose(['annualLongTermDebt']);

      const sameDate = (left, right) => left && right && left.asOfDate && left.asOfDate === right.asOfDate;
      let debt = null;

      if (sameDate(quarterlyCurrentDebt, quarterlyLongTermDebt)) {
        debt = {
          raw: quarterlyCurrentDebt.raw + quarterlyLongTermDebt.raw,
          type: 'quarterlyCurrentDebt + quarterlyLongTermDebt',
          asOfDate: quarterlyCurrentDebt.asOfDate,
          currency: quarterlyCurrentDebt.currency || quarterlyLongTermDebt.currency || null,
          currentDebt: quarterlyCurrentDebt.raw,
          longTermDebt: quarterlyLongTermDebt.raw,
          fallbackUsed: false
        };
      } else if (sameDate(annualCurrentDebt, annualLongTermDebt)) {
        debt = {
          raw: annualCurrentDebt.raw + annualLongTermDebt.raw,
          type: 'annualCurrentDebt + annualLongTermDebt',
          asOfDate: annualCurrentDebt.asOfDate,
          currency: annualCurrentDebt.currency || annualLongTermDebt.currency || null,
          currentDebt: annualCurrentDebt.raw,
          longTermDebt: annualLongTermDebt.raw,
          fallbackUsed: false
        };
      } else {
        const totalDebtFallback = choose(['quarterlyTotalDebt', 'annualTotalDebt']);
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
        'quarterlyCashCashEquivalentsAndShortTermInvestments',
        'quarterlyCashAndCashEquivalents',
        'annualCashCashEquivalentsAndShortTermInvestments',
        'annualCashAndCashEquivalents'
      ]);
      const shares = choose(['quarterlyOrdinarySharesNumber', 'annualOrdinarySharesNumber']);

      if (!debt) {
        throw createError(502, `Yahoo returned no usable debt facts for ${ticker}.`, {
          requestedTypes: types,
          returnedTypes: result.map(item => item?.meta?.type?.[0] || item?.type).filter(Boolean)
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
        currency: debt.currency || cash?.currency || shares?.currency || 'USD'
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || createError(502, 'Yahoo balance-sheet snapshot is unavailable.');
}
