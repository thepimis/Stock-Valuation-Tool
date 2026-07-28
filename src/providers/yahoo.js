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
      if (!response.ok) throw new Error(body?.finance?.error?.description || response.statusText || 'Yahoo request failed');
      return { body, host };
    } catch (error) {
      lastError = error;
    }
  }
  throw createError(502, `Yahoo Finance request failed: ${lastError?.message || 'unknown error'}`);
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
