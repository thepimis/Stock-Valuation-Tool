import { searchYahooEquities, fetchYahooQuote, fetchYahooTtmCashFlow, fetchYahooBalanceSnapshot } from './providers/yahoo.js';
import { runDoltQuery, doltTickerPredicate } from './providers/dolt.js';
import {
  calculateTtmRevenue,
  buildRevenueSeries,
  ttmGrowthAgainstOneYearAgo,
  fiscalYearCagr,
  buildNetMarginSeries,
  calculateWeightedNetMargin,
  calculateWeightedFcfMargin
} from './services/financials.js';
import {
  buildDashboardMetricGroups,
  normaliseRevenueRows,
  normaliseNetIncomeRows,
  buildLatestTtmFcf,
  buildAnnualFcfSeries
} from './services/metrics.js';
import { calculateReturnSeries, calculateFinvizRoicSnapshot, summariseReturns } from './services/returns.js';
import { buildGrowthAnalysis } from './services/growth.js';
import { buildHistoricalCalculatorData } from './services/historical.js';
import { buildCompanyOverview } from './services/company.js';

const VERSION = 'stock-valuation-worker-v21-r2-all-pages-2026-07-30';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Expose-Headers': 'X-Worker-Version'
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/data/')) {
        return servePreparedData(request, env, ctx, url);
      }

      if (url.pathname === '/' && url.searchParams.size === 0) {
        return htmlResponse(LAB_HTML);
      }

      if (url.searchParams.has('health')) {
        const result = await runDoltQuery('SELECT 1 AS ok');
        return jsonResponse({
          ok: true,
          version: VERSION,
          doltCommitRef: result.commit_ref || null,
          doltReachable: Array.isArray(result.rows)
        });
      }

      if (url.searchParams.has('schema')) {
        const table = validateTable(url.searchParams.get('schema'));
        const result = await runDoltQuery(`DESCRIBE \`${table}\``);
        return jsonResponse({ ok: true, version: VERSION, table, ...result });
      }

      if (url.searchParams.has('tables')) {
        const result = await runDoltQuery('SHOW TABLES');
        return jsonResponse({ ok: true, version: VERSION, ...result });
      }

      if (url.searchParams.has('search')) {
        const query = String(url.searchParams.get('search') || '').trim();
        return jsonResponse(await searchYahooEquities(query, { version: VERSION, createError }));
      }

      if (url.searchParams.has('quote') || url.searchParams.has('priceTicker')) {
        const ticker = normaliseTicker(url.searchParams.get('quote') || url.searchParams.get('priceTicker'));
        return jsonResponse(await fetchYahooQuote(ticker, { version: VERSION, createError }));
      }

      if (url.searchParams.has('financials')) {
        const ticker = normaliseTicker(url.searchParams.get('financials'));
        const prepared = await preparedEndpoint(env, ticker, 'financials');
        return jsonResponse(prepared || await fetchCoreFinancials(ticker));
      }

      if (url.searchParams.has('company')) {
        const ticker = normaliseTicker(url.searchParams.get('company'));
        const prepared = await preparedEndpoint(env, ticker, 'company');
        return jsonResponse(prepared || await fetchCompanyOverview(ticker));
      }

      if (url.searchParams.has('returns')) {
        const ticker = normaliseTicker(url.searchParams.get('returns'));
        const prepared = await preparedEndpoint(env, ticker, 'returns');
        return jsonResponse(prepared || await calculateReturnsHistory(ticker));
      }

      if (url.searchParams.has('growth')) {
        const ticker = normaliseTicker(url.searchParams.get('growth'));
        const prepared = await preparedEndpoint(env, ticker, 'growth');
        return jsonResponse(prepared || await calculateGrowthHistory(ticker));
      }

      if (url.searchParams.has('history')) {
        const ticker = normaliseTicker(url.searchParams.get('history'));
        const prepared = await preparedEndpoint(env, ticker, 'history');
        return jsonResponse(prepared || await calculateHistoricalCalculatorHistory(ticker));
      }

      if (url.searchParams.has('q')) {
        const sql = validateReadOnlySql(url.searchParams.get('q'));
        const result = await runDoltQuery(sql);
        return jsonResponse({ ok: true, version: VERSION, ...result });
      }

      if (url.searchParams.has('dashboard')) {
        const ticker = normaliseTicker(url.searchParams.get('dashboard'));
        const prepared = await preparedEndpoint(env, ticker, 'dashboard');
        return jsonResponse(prepared || await buildDashboardMetrics(ticker));
      }

      if (url.searchParams.has('inspect')) {
        const ticker = normaliseTicker(url.searchParams.get('inspect'));
        const payload = await inspectTicker(ticker);
        return jsonResponse(payload);
      }

      if (url.searchParams.has('revenueHistory')) {
        const ticker = normaliseTicker(url.searchParams.get('revenueHistory'));
        const payload = await calculateRevenueHistory(ticker);
        return jsonResponse(payload);
      }


      if (url.searchParams.has('netMarginHistory')) {
        const ticker = normaliseTicker(url.searchParams.get('netMarginHistory'));
        const payload = await calculateNetMarginHistory(ticker);
        return jsonResponse(payload);
      }


      if (url.searchParams.has('cashFlowValidation')) {
        const ticker = normaliseTicker(url.searchParams.get('cashFlowValidation'));
        const payload = await buildCashFlowValidation(ticker);
        return jsonResponse(payload);
      }

      if (url.searchParams.has('fcfMarginHistory')) {
        const ticker = normaliseTicker(url.searchParams.get('fcfMarginHistory'));
        const payload = await calculateFcfMarginHistory(ticker);
        return jsonResponse(payload);
      }

      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Use ?search=apple, ?quote=AAPL, ?company=AAPL, ?financials=AAPL, ?dashboard=AAPL, ?returns=AAPL, ?growth=AAPL, ?history=AAPL, ?q=SELECT..., or the individual metric routes.'
      }, 400);
    } catch (error) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: error.message || 'Unknown error',
        details: error.details || null,
        debug: {
          name: error?.name || null,
          stack: String(error?.stack || '').split('\n').slice(0, 8)
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

async function servePreparedData(request, env, ctx, url) {
  if (!env?.COMPANY_DATA) {
    return jsonResponse({ ok: false, version: VERSION, error: 'R2 company data binding is unavailable.' }, 503);
  }

  const name = decodeURIComponent(url.pathname.slice('/data/'.length));
  if (!/^(?:[A-Z0-9._-]{1,40}\.json|manifest\.json|tickers\.json)$/i.test(name)) {
    return jsonResponse({ ok: false, version: VERSION, error: 'Invalid prepared-data object name.' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const object = await env.COMPANY_DATA.get(`companies/${name}`);
  if (!object) {
    return jsonResponse({ ok: false, version: VERSION, error: 'Prepared company data is unavailable.' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', name === 'manifest.json' ? 'public, max-age=60, s-maxage=300' : 'public, max-age=300, s-maxage=3600');
  headers.set('ETag', object.httpEtag);
  headers.set('X-Worker-Version', VERSION);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);

  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  const response = new Response(object.body, { status: 200, headers });
  if (request.method === 'GET') ctx?.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function validateReadOnlySql(value) {
  const sql = String(value || '').trim();
  if (!sql) throw createError(400, 'Missing q query parameter.');
  if (sql.length > 10000) throw createError(413, 'SQL query is too long.');
  const withoutTrailingSemicolon = sql.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw createError(400, 'Only one SQL statement is allowed.');
  }
  if (!/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i.test(sql)) {
    throw createError(400, 'Only read-only Dolt SQL is allowed.');
  }
  return sql;
}

async function fetchCoreFinancials(ticker) {
  const revenueSql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` DESC LIMIT 4`;
  const sharesSql = `SELECT shares_outstanding, \`date\`, period FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} AND shares_outstanding IS NOT NULL ORDER BY \`date\` DESC LIMIT 10`;
  const [revenueResult, sharesResult, returnsResult, growthResult] = await Promise.all([
    runDoltQuery(revenueSql),
    runDoltQuery(sharesSql),
    calculateReturnsHistory(ticker).catch(error => ({
      ok: false,
      supported: false,
      error: error.message || 'Return metrics are unavailable.'
    })),
    calculateGrowthHistory(ticker).catch(error => ({
      ok: false,
      supported: false,
      error: error.message || 'Growth metrics are unavailable.'
    }))
  ]);
  const revenueRows = Array.isArray(revenueResult.rows) ? revenueResult.rows : [];
  const revenue = calculateTtmRevenue(revenueRows);
  const shareRow = (Array.isArray(sharesResult.rows) ? sharesResult.rows : []).find(row => Number.isFinite(parseNumber(row.shares_outstanding)) && parseNumber(row.shares_outstanding) > 0);
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
      revenueQuarterDates: revenueRows.map(row => String(row.date || '').slice(0, 10)),
      sharesDate: shareRow ? String(shareRow.date || '').slice(0, 10) : null,
      commitRef: revenueResult.commit_ref || sharesResult.commit_ref || null
    }
  };
}


async function fetchCompanyOverview(ticker) {
  const fields = await resolveReturnFields();
  const sharesColumn = chooseColumn(fields.availableEquityColumns || [], [
    'shares_outstanding',
    'weighted_average_number_of_diluted_shares_outstanding',
    'weighted_average_number_of_shares_outstanding_basic'
  ]);

  // Cash belongs to balance_sheet_assets while shares belong to
  // balance_sheet_equity. Querying both from the equity table caused Dolt to
  // reject valid asset fields such as cash_and_equivalents.
  const equitySelect = [
    sharesColumn ? `${quoteIdentifier(sharesColumn)} AS shares_outstanding` : 'CAST(NULL AS DOUBLE) AS shares_outstanding',
    '`date`',
    'period'
  ].join(', ');
  const assetsSelect = [
    sumColumnsSql(fields.cashColumns, 'cash'),
    '`date`',
    'period'
  ].join(', ');

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
  const equityRow = equityRows.find(row => {
    const shares = parseNumberOrNull(row.shares_outstanding);
    return shares !== null && shares > 0;
  }) || null;
  const assetsRow = assetsRows.find(row => parseNumberOrNull(row.cash) !== null) || null;

  // Interest-bearing debt is Yahoo current debt plus long-term debt when both
  // components are available for the same reporting date. Values are base units.
  const totalDebt = parseNumberOrNull(yahooBalance?.totalDebt);
  const cash = parseNumberOrNull(yahooBalance?.cash)
    ?? (assetsRow ? parseNumberOrNull(assetsRow.cash) : null);
  const sharesOutstanding = parseNumberOrNull(yahooBalance?.sharesOutstanding)
    ?? (equityRow ? parseNumberOrNull(equityRow.shares_outstanding) : null);

  const overview = buildCompanyOverview({
    ticker,
    quote,
    revenueTtm: completeIncomeTtm ? revenueTtm : null,
    netIncomeTtm: completeIncomeTtm ? netIncomeTtm : null,
    freeCashFlowTtm: cashFlowResult?.freeCashFlow ?? null,
    cash,
    totalDebt,
    sharesOutstanding,
    balanceDate: yahooBalance?.debtAsOfDate || (equityRow ? String(equityRow.date || '').slice(0, 10) : (assetsRow ? String(assetsRow.date || '').slice(0, 10) : null)),
    incomeQuarterDates: incomeRows.map(row => String(row.date || '').slice(0, 10)),
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
      quote: 'Yahoo Finance chart API',
      totalDebt: yahooBalance ? 'Yahoo Finance fundamentals timeseries' : null,
      financialStatements: 'DoltHub earnings database',
      trailingCashFlow: cashFlowResult ? 'Yahoo Finance fundamentals timeseries' : null,
      commitRef: incomeResult.commit_ref || equityResult.commit_ref || assetsResult.commit_ref || null
    }
  };
}

async function buildDashboardMetrics(ticker) {
  const [revenueResult, marginResult, fcfResult, returnsResult, growthResult] = await Promise.allSettled([
    calculateRevenueHistory(ticker),
    calculateNetMarginHistory(ticker),
    calculateFcfMarginHistory(ticker),
    calculateReturnsHistory(ticker),
    calculateGrowthHistory(ticker)
  ]);
  const revenue = revenueResult.status === 'fulfilled' ? revenueResult.value : null;
  const margin = marginResult.status === 'fulfilled' ? marginResult.value : null;
  const fcf = fcfResult.status === 'fulfilled' ? fcfResult.value : null;
  const returns = returnsResult.status === 'fulfilled' ? returnsResult.value : null;
  const growth = growthResult.status === 'fulfilled' ? growthResult.value : null;
  return {
    ok: true,
    version: VERSION,
    ticker,
    ...buildDashboardMetricGroups(revenue, margin, fcf),
    returns: returns?.summary || null,
    growth: growth?.metrics || null,
    errors: [
      revenueResult.status === 'rejected' ? `Revenue growth: ${revenueResult.reason?.message || 'failed'}` : null,
      marginResult.status === 'rejected' ? `Net margin: ${marginResult.reason?.message || 'failed'}` : null,
      fcfResult.status === 'rejected' ? `FCF margin: ${fcfResult.reason?.message || 'failed'}` : null,
      returnsResult.status === 'rejected' ? `Returns: ${returnsResult.reason?.message || 'failed'}` : null,
      growthResult.status === 'rejected' ? `Growth: ${growthResult.reason?.message || 'failed'}` : null
    ].filter(Boolean)
  };
}

async function inspectTicker(ticker) {
  const queries = {
    incomeSchema: 'DESCRIBE `income_statement`',
    balanceSchema: 'DESCRIBE `balance_sheet_equity`',
    cashFlowSchema: 'DESCRIBE `cash_flow_statement`',
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
    if (result.status === 'fulfilled') {
      const [key, value] = result.value;
      data[key] = value;
    } else {
      errors.push(result.reason?.message || 'Unknown inspection error');
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

function detectCandidateColumns(data) {
  const allColumns = {
    income_statement: extractDescribeColumns(data.incomeSchema),
    balance_sheet_equity: extractDescribeColumns(data.balanceSchema),
    cash_flow_statement: extractDescribeColumns(data.cashFlowSchema)
  };

  const candidateGroups = {
    revenue: ['sales', 'revenue', 'revenues', 'total_revenue'],
    netIncome: ['net_income_loss', 'net_income', 'profit_loss', 'net_income_available_to_common_stockholders_basic'],
    operatingIncome: ['operating_income_loss', 'operating_income', 'income_after_depreciation_and_amortization', 'income_from_operations', 'operating_profit'],
    taxExpense: ['income_tax_expense_benefit', 'income_tax_expense'],
    operatingCashFlow: ['net_cash_provided_by_used_in_operating_activities', 'operating_cash_flow', 'cash_from_operations'],
    capitalExpenditure: ['payments_to_acquire_property_plant_and_equipment', 'capital_expenditures', 'capital_expenditure'],
    cash: ['cash_and_cash_equivalents_at_carrying_value', 'cash_and_cash_equivalents'],
    debt: ['long_term_debt_current', 'long_term_debt_noncurrent', 'long_term_debt'],
    equity: ['stockholders_equity', 'shareholders_equity'],
    shares: ['shares_outstanding', 'common_stock_shares_outstanding']
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

async function getDoltTableSchema(table) {
  try {
    return await runDoltQuery(`DESCRIBE \`${table}\``);
  } catch (describeError) {
    // DoltHub occasionally rejects DESCRIBE on the API default branch even
    // though normal SELECT queries work. A one-row SELECT still returns the
    // table schema, which is all the metric resolver needs.
    const result = await runDoltQuery(`SELECT * FROM \`${table}\` LIMIT 1`);
    const columns = (result?.schema || [])
      .map(column => column?.columnName || column?.name || column?.field)
      .filter(Boolean);

    if (columns.length === 0 && result?.rows?.[0]) {
      columns.push(...Object.keys(result.rows[0]));
    }

    if (columns.length === 0) throw describeError;

    return {
      ...result,
      rows: columns.map(Field => ({ Field }))
    };
  }
}

function extractDescribeColumns(result) {
  const rows = result?.rows || [];
  return rows
    .map(row => row.Field || row.field || row.COLUMN_NAME || row.column_name || Object.values(row)[0])
    .filter(Boolean)
    .map(String);
}


async function getQuarterlyRevenue(ticker) {
  const sql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` DESC LIMIT 20`;
  const result = await runDoltQuery(sql);
  const rows = normaliseRevenueRows(result.rows, 'quarterly');
  return {
    ok: rows.length > 0,
    version: VERSION,
    ticker,
    unit: 'raw database units; revenueBillions assumes the raw value is USD',
    source: { api: 'DoltHub v1alpha1 default branch', commitRef: result.commit_ref || null, query: sql },
    rows
  };
}

async function getAnnualRevenue(ticker) {
  const sql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period <> 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` DESC LIMIT 20`;
  const result = await runDoltQuery(sql);
  const rows = normaliseRevenueRows(result.rows, 'annual');
  return {
    ok: rows.length > 0,
    version: VERSION,
    ticker,
    note: 'These are all non-Quarter rows returned by Dolt. Review the period values before treating them as fiscal-year data.',
    source: { api: 'DoltHub v1alpha1 default branch', commitRef: result.commit_ref || null, query: sql },
    rows
  };
}

async function buildRevenueValidation(ticker) {
  const quarterly = await getQuarterlyRevenue(ticker);
  const annual = await getAnnualRevenue(ticker);
  const latestFour = (Array.isArray(quarterly?.rows) ? quarterly.rows : []).slice(0, 4);
  const ttmRevenue = latestFour.length === 4
    ? latestFour.reduce((sum, row) => sum + row.sales, 0)
    : null;

  return {
    ok: quarterly.ok,
    version: VERSION,
    ticker,
    instructions: [
      'Compare each quarterly row date and value with a trusted source.',
      'Confirm that four latest quarters sum to the displayed TTM value.',
      'Review annual period labels before using annual rows for CAGR.'
    ],
    quarterlyRows: quarterly.rows,
    annualRows: annual.rows,
    ttm: {
      complete: latestFour.length === 4,
      rowsUsed: latestFour,
      revenue: ttmRevenue,
      revenueBillions: Number.isFinite(ttmRevenue) ? ttmRevenue / 1e9 : null
    },
    source: {
      quarterlyCommitRef: quarterly.source.commitRef,
      annualCommitRef: annual.source.commitRef
    }
  };
}

async function getQuarterlyNetIncome(ticker) {
  const sql = `SELECT net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND net_income IS NOT NULL ORDER BY \`date\` DESC LIMIT 20`;
  const result = await runDoltQuery(sql);
  const rows = normaliseNetIncomeRows(result.rows, 'quarterly');
  return {
    ok: rows.length > 0,
    version: VERSION,
    ticker,
    field: 'net_income',
    unit: 'raw database units; netIncomeBillions assumes the raw value is USD',
    source: { api: 'DoltHub v1alpha1 default branch', commitRef: result.commit_ref || null, query: sql },
    rows
  };
}

async function getAnnualNetIncome(ticker) {
  const sql = `SELECT net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' AND net_income IS NOT NULL ORDER BY \`date\` DESC LIMIT 20`;
  const result = await runDoltQuery(sql);
  const rows = normaliseNetIncomeRows(result.rows, 'annual');
  return {
    ok: rows.length > 0,
    version: VERSION,
    ticker,
    field: 'net_income',
    note: 'Only rows explicitly labelled Year are returned for annual validation.',
    source: { api: 'DoltHub v1alpha1 default branch', commitRef: result.commit_ref || null, query: sql },
    rows
  };
}

async function buildNetIncomeValidation(ticker) {
  const [quarterly, annual] = await Promise.all([
    getQuarterlyNetIncome(ticker),
    getAnnualNetIncome(ticker)
  ]);
  const latestFour = (Array.isArray(quarterly?.rows) ? quarterly.rows : []).slice(0, 4);
  const ttmNetIncome = latestFour.length === 4
    ? latestFour.reduce((sum, row) => sum + row.netIncome, 0)
    : null;

  return {
    ok: quarterly.ok && annual.ok,
    version: VERSION,
    ticker,
    field: 'net_income',
    instructions: [
      'Compare each quarterly date and netIncome value with Macrotrends or the company filing.',
      'Confirm that the latest four quarterly values sum to ttm.netIncome.',
      'Compare annualRows only with fiscal-year net income values.'
    ],
    quarterlyRows: quarterly.rows,
    annualRows: annual.rows,
    ttm: {
      complete: latestFour.length === 4,
      rowsUsed: latestFour,
      netIncome: ttmNetIncome,
      netIncomeMillions: Number.isFinite(ttmNetIncome) ? ttmNetIncome / 1e6 : null,
      netIncomeBillions: Number.isFinite(ttmNetIncome) ? ttmNetIncome / 1e9 : null
    },
    source: {
      quarterlyCommitRef: quarterly.source.commitRef,
      annualCommitRef: annual.source.commitRef
    }
  };
}

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
      currentRevenue: 'Latest trailing twelve months: sum of the latest four reported quarters.',
      oneYearGrowth: 'Latest TTM revenue compared with TTM revenue ending one year earlier.',
      longTermGrowth: '3-, 5-, and 10-year CAGR calculated from reported fiscal-year revenue.'
    },
    source: {
      api: 'DoltHub v1alpha1 default branch',
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
    quarterlySeries: quarters.slice(-48).map(row => ({
      date: row.date,
      revenue: row.sales,
      revenueBillions: row.sales / 1e9
    })),
    ttmSeries: ttmSeries.slice(-44)
  };
}



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
      method: 'latest TTM net margin',
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
      oneYear: 'Latest TTM net income divided by latest TTM revenue.',
      longTerm: 'Total fiscal-year net income divided by total fiscal-year revenue over the latest 3, 5, or 10 completed fiscal years.'
    },
    historicalNetMargins: margins,
    latestTTM,
    annualSeries: annualSeries.slice(-15),
    quarterlySeries: quarters.slice(-48).map(row => ({
      date: row.date,
      revenue: row.revenue,
      revenueBillions: row.revenue / 1e9,
      netIncome: row.netIncome,
      netIncomeBillions: row.netIncome / 1e9,
      netMarginPercentage: row.revenue ? (row.netIncome / row.revenue) * 100 : null
    })),
    rowsReceived: { quarterly: quarterlyRows.length, annual: annualRows.length },
    source: {
      api: 'DoltHub v1alpha1 default branch',
      quarterlyCommitRef: quarterlyResult.commit_ref || null,
      annualCommitRef: annualResult.commit_ref || null,
      quarterlyQuery: quarterlySql,
      annualQuery: annualSql
    }
  };
}


async function buildCashFlowValidation(ticker) {
  const operatingCashFlowColumn = 'net_cash_from_operating_activities';
  const propertyAndEquipmentColumn = 'property_and_equipment';
  const sql = `SELECT \`date\`, period, \`${operatingCashFlowColumn}\` AS operating_cash_flow, \`${propertyAndEquipmentColumn}\` AS property_and_equipment FROM \`cash_flow_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND \`${operatingCashFlowColumn}\` IS NOT NULL AND \`${propertyAndEquipmentColumn}\` IS NOT NULL ORDER BY \`date\` DESC LIMIT 15`;
  const result = await runDoltQuery(sql);
  const rows = (Array.isArray(result.rows) ? result.rows : []).map(row => {
    const operatingCashFlow = parseNumber(row.operating_cash_flow);
    const propertyAndEquipmentRaw = parseNumber(row.property_and_equipment);
    const capitalExpenditures = Math.abs(propertyAndEquipmentRaw);
    const freeCashFlow = operatingCashFlow - capitalExpenditures;
    return {
      date: String(row.date || '').slice(0, 10),
      fiscalYear: Number(String(row.date || '').slice(0, 4)),
      period: String(row.period || ''),
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
    formula: 'FCF = net_cash_from_operating_activities - abs(property_and_equipment)',
    rows,
    source: {
      api: 'DoltHub v1alpha1 default branch',
      commitRef: result.commit_ref || null,
      query: sql
    }
  };
}

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
    fetchYahooTtmCashFlow(ticker, { createError, parseNumber }).then(value => ({ ok: true, value })).catch(error => ({
      ok: false,
      error: error.message || 'Yahoo Finance TTM cash-flow data is unavailable.'
    }))
  ]);

  const yahooTtm = yahooResult.ok ? yahooResult.value : null;
  const latestTTM = buildLatestTtmFcf(quarterlyRevenueResult.rows, yahooTtm);
  const annualSeries = buildAnnualFcfSeries(annualCashFlowResult.rows, annualRevenueResult.rows);

  const unavailableReason = yahooResult.ok
    ? null
    : yahooResult.error;

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
      revenue: 'sales'
    },
    methodology: {
      freeCashFlow: 'Yahoo TTM operating cash flow minus the absolute value of Yahoo TTM capital expenditure.',
      oneYear: 'Yahoo Finance TTM free cash flow divided by Dolt latest-four-quarter revenue.',
      longTerm: 'Dolt total fiscal-year free cash flow divided by total fiscal-year revenue over the latest 3, 5, or 10 completed fiscal years.'
    },
    historicalFcfMargins: {
      oneYear: latestTTM ? {
        method: 'Yahoo TTM FCF / Dolt TTM revenue',
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
        method: 'Yahoo TTM FCF / Dolt TTM revenue',
        percentage: null,
        available: false,
        reason: unavailableReason || 'Four usable quarterly revenue rows were not available.'
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
      ttmCashFlowApi: 'Yahoo Finance fundamentals-timeseries',
      yahooTypes: yahooTtm?.types || [],
      yahooHost: yahooTtm?.host || null,
      quarterlyRevenueApi: 'DoltHub v1alpha1 default branch',
      quarterlyRevenueQuery: quarterlyRevenueSql,
      annualCashFlowQuery: annualCashFlowSql,
      annualRevenueQuery: annualRevenueSql
    }
  };
}



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
    purpose: 'Historical annual detail for expandable DCF assumption rows. DCF calculations are unchanged.',
    methodology: {
      revenueGrowth: 'Each annual percentage compares the fiscal year with the immediately preceding fiscal year.',
      netMargin: 'Fiscal-year net income divided by fiscal-year revenue.',
      fcfMargin: 'Fiscal-year free cash flow divided by fiscal-year revenue. Free cash flow equals operating cash flow minus the absolute value of capital expenditures.',
      roic: 'Finviz-style ROIC: net income divided by common equity plus long-term debt and non-current operating leases. Error of +/- 5% possible.',
      summary: 'Growth metrics use CAGR where applicable; margin and ROIC summaries use period averages.'
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


async function calculateGrowthHistory(ticker) {
  const [incomeSchema, balanceSchema, cashFlowFields] = await Promise.all([
    getDoltTableSchema('income_statement'),
    getDoltTableSchema('balance_sheet_equity'),
    resolveCashFlowFields()
  ]);

  const incomeColumns = extractDescribeColumns(incomeSchema);
  const balanceColumns = extractDescribeColumns(balanceSchema);
  const sharesColumn = chooseColumn(balanceColumns, [
    'shares_outstanding',
    'common_stocks_including_additional_paid_in_capital_member',
    'weighted_average_number_of_diluted_shares_outstanding',
    'weighted_average_number_of_shares_outstanding_basic'
  ]);

  const sharesSelect = sharesColumn ? `${quoteIdentifier(sharesColumn)} AS shares_outstanding` : 'CAST(NULL AS DOUBLE) AS shares_outstanding';
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
    revenue: { label: 'Revenue', unit: 'currency', series: [] },
    netIncome: { label: 'Net income', unit: 'currency', series: [] },
    freeCashFlow: { label: 'Free cash flow', unit: 'currency', series: [] },
    sharesOutstanding: { label: 'Shares outstanding', unit: 'shares', series: [] }
  };

  for (const row of Array.isArray(incomeResult.rows) ? incomeResult.rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const fiscalYear = Number(date.slice(0, 4));
    if (!Number.isFinite(fiscalYear)) continue;
    const revenue = parseNumberOrNull(row.sales);
    const netIncome = parseNumberOrNull(row.net_income);
    if (revenue !== null) metricSeries.revenue.series.push({ fiscalYear, date, value: revenue, source: 'income_statement.sales' });
    if (netIncome !== null) metricSeries.netIncome.series.push({ fiscalYear, date, value: netIncome, source: 'income_statement.net_income' });
  }

  for (const row of Array.isArray(balanceResult.rows) ? balanceResult.rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const fiscalYear = Number(date.slice(0, 4));
    const shares = parseNumberOrNull(row.shares_outstanding);
    if (Number.isFinite(fiscalYear) && shares !== null && shares > 0) {
      metricSeries.sharesOutstanding.series.push({ fiscalYear, date, value: shares, source: sharesColumn });
    }
  }

  for (const row of Array.isArray(cashFlowResult.rows) ? cashFlowResult.rows : []) {
    const date = String(row.date || '').slice(0, 10);
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
    supported: Object.values(metrics).some(metric => metric.annualSeries.length >= 2),
    methodology: {
      oneYear: 'Latest completed fiscal year compared with the previous fiscal year.',
      longTerm: 'CAGR between exact fiscal-year endpoints 3, 5, or 10 years apart.',
      negativeValues: 'CAGR is not reported when either endpoint is zero or negative; total percentage change is retained where meaningful.',
      freeCashFlow: 'Operating cash flow minus the absolute value of capital expenditures.',
      shareCount: 'Positive growth means dilution; negative growth means net buybacks.'
    },
    fields: {
      revenue: 'sales',
      netIncome: 'net_income',
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
      note: 'Positive percentages indicate dilution; negative percentages indicate buybacks.'
    } : null,
    rowsReceived: {
      income: incomeResult.rows?.length || 0,
      balance: balanceResult.rows?.length || 0,
      cashFlow: cashFlowResult.rows?.length || 0
    },
    source: {
      api: 'DoltHub v1alpha1 default branch',
      commitRef: incomeResult.commit_ref || balanceResult.commit_ref || cashFlowResult.commit_ref || null,
      incomeQuery: incomeSql,
      balanceQuery: balanceSql,
      cashFlowQuery: cashFlowSql
    }
  };
}

async function calculateReturnsHistory(ticker) {
  const fields = await resolveReturnFields();
  const missingRequired = ['netIncome', 'totalAssets', 'equity', 'longTermDebt']
    .filter(key => !fields[key]);

  if (missingRequired.length > 0) {
    return {
      ok: true,
      version: VERSION,
      ticker,
      supported: false,
      error: `Required Finviz-style ROIC fields are unavailable: ${missingRequired.join(', ')}.`,
      fields
    };
  }

  const incomeSelect = [
    fields.operatingIncome ? `${quoteIdentifier(fields.operatingIncome)} AS operating_income` : 'CAST(NULL AS DOUBLE) AS operating_income',
    `${quoteIdentifier(fields.netIncome)} AS net_income`,
    '`date`',
    'period'
  ].join(', ');

  const assetParts = [
    `${quoteIdentifier(fields.totalAssets)} AS total_assets`,
    sumColumnsSql(fields.cashColumns, 'cash'),
    '`date`',
    'period'
  ];

  const liabilityParts = [
    fields.totalLiabilities ? `${quoteIdentifier(fields.totalLiabilities)} AS total_liabilities` : 'CAST(NULL AS DOUBLE) AS total_liabilities',
    fields.currentLiabilities ? `${quoteIdentifier(fields.currentLiabilities)} AS current_liabilities` : 'CAST(NULL AS DOUBLE) AS current_liabilities',
    `${quoteIdentifier(fields.longTermDebt)} AS long_term_debt`,
    fields.otherNonCurrentLiabilities ? `${quoteIdentifier(fields.otherNonCurrentLiabilities)} AS other_non_current_liabilities` : 'CAST(NULL AS DOUBLE) AS other_non_current_liabilities',
    fields.operatingLeaseLiabilitiesNonCurrent ? `${quoteIdentifier(fields.operatingLeaseLiabilitiesNonCurrent)} AS operating_lease_liabilities_noncurrent` : 'CAST(NULL AS DOUBLE) AS operating_lease_liabilities_noncurrent',
    sumColumnsSql(fields.debtColumns, 'total_debt'),
    '`date`',
    'period'
  ];

  const equityParts = [
    `${quoteIdentifier(fields.equity)} AS equity`,
    '`date`',
    'period'
  ];

  const annualIncomeSql = `SELECT ${incomeSelect} FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const annualAssetsSql = `SELECT ${assetParts.join(', ')} FROM \`balance_sheet_assets\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const annualLiabilitiesSql = `SELECT ${liabilityParts.join(', ')} FROM \`balance_sheet_liabilities\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const annualEquitySql = `SELECT ${equityParts.join(', ')} FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Year' ORDER BY \`date\` ASC LIMIT 40`;
  const quarterlyIncomeSql = `SELECT ${quoteIdentifier(fields.netIncome)} AS net_income, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' ORDER BY \`date\` DESC LIMIT 4`;
  const latestAssetsSql = `SELECT ${assetParts.join(', ')} FROM \`balance_sheet_assets\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;
  const latestLiabilitiesSql = `SELECT ${liabilityParts.join(', ')} FROM \`balance_sheet_liabilities\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;
  const latestEquitySql = `SELECT ${equityParts.join(', ')} FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} ORDER BY \`date\` DESC LIMIT 12`;

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

  const dateKey = row => String(row?.date || '').slice(0, 10);
  const yearKey = row => Number(dateKey(row).slice(0, 4));

  const incomeByYear = new Map();
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

  const assetsByYear = new Map();
  for (const row of Array.isArray(annualAssetsResult.rows) ? annualAssetsResult.rows : []) {
    const fiscalYear = yearKey(row);
    if (!Number.isFinite(fiscalYear)) continue;
    assetsByYear.set(fiscalYear, {
      date: dateKey(row),
      totalAssets: parseNumberOrNull(row.total_assets),
      cash: parseNumberOrNull(row.cash)
    });
  }

  const liabilitiesByYear = new Map();
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

  const equityByYear = new Map();
  for (const row of Array.isArray(annualEquityResult.rows) ? annualEquityResult.rows : []) {
    const fiscalYear = yearKey(row);
    if (!Number.isFinite(fiscalYear)) continue;
    equityByYear.set(fiscalYear, {
      date: dateKey(row),
      equity: parseNumberOrNull(row.equity)
    });
  }

  const years = [...incomeByYear.keys()]
    .filter(year => assetsByYear.has(year) && liabilitiesByYear.has(year) && equityByYear.has(year))
    .sort((a, b) => a - b);

  const mergedRows = years.map(year => ({
    ...incomeByYear.get(year),
    ...assetsByYear.get(year),
    ...liabilitiesByYear.get(year),
    ...equityByYear.get(year),
    fiscalYear: year,
    date: incomeByYear.get(year)?.date || equityByYear.get(year)?.date || assetsByYear.get(year)?.date || null
  }));
  const series = calculateReturnSeries(mergedRows);

  const quarterlyNetIncomeRows = Array.isArray(quarterlyIncomeResult.rows)
    ? quarterlyIncomeResult.rows.map(row => parseNumberOrNull(row.net_income)).filter(Number.isFinite)
    : [];
  const ttmNetIncome = quarterlyNetIncomeRows.length === 4
    ? quarterlyNetIncomeRows.reduce((sum, value) => sum + value, 0)
    : null;

  const indexLatest = rows => {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const date = dateKey(row);
      if (date && !map.has(date)) map.set(date, row);
    }
    return map;
  };

  const latestAssetsByDate = indexLatest(latestAssetsResult.rows);
  const latestLiabilitiesByDate = indexLatest(latestLiabilitiesResult.rows);
  const latestEquityByDate = indexLatest(latestEquityResult.rows);
  const sharedDates = [...latestEquityByDate.keys()]
    .filter(date => latestAssetsByDate.has(date) && latestLiabilitiesByDate.has(date))
    .sort((a, b) => b.localeCompare(a));

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

  const ttmSnapshot = ttmNetIncome !== null && latestBalanceRow
    ? {
        ...calculateFinvizRoicSnapshot({ ...latestBalanceRow, netIncome: ttmNetIncome }),
        date: latestBalanceRow.date,
        period: 'TTM',
        fiscalYear: Number(String(latestBalanceRow?.date || '').slice(0, 4)) || null
      }
    : null;

  return {
    ok: true,
    version: VERSION,
    ticker,
    supported: series.length > 0 || Boolean(ttmSnapshot),
    methodology: {
      roic: 'Finviz-style ROIC = net income / (common equity + long-term debt + non-current operating lease liabilities).',
      current: 'Current ROIC uses trailing-four-quarter net income and the latest common balance-sheet date across the asset, liability and equity tables.',
      historical: 'Historical ROIC uses fiscal-year net income and matching fiscal-year asset, liability and equity statements. Capital is not averaged.',
      leaseAdjustment: 'When a separate non-current operating-lease field is unavailable, it is estimated as total liabilities - current liabilities - long-term debt - other non-current liabilities, floored at zero.',
      warning: 'This is an approximation of Finviz statement normalisation; an error of +/- 5% is possible.',
      roe: 'Net income divided by average shareholders equity.',
      roa: 'Net income divided by average total assets.',
      roce: 'Operating income divided by average capital employed.'
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
      api: 'DoltHub v1alpha1 default branch',
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

async function resolveReturnFields() {
  const [incomeSchema, assetsSchema, liabilitiesSchema, equitySchema] = await Promise.all([
    getDoltTableSchema('income_statement'),
    getDoltTableSchema('balance_sheet_assets'),
    getDoltTableSchema('balance_sheet_liabilities'),
    getDoltTableSchema('balance_sheet_equity')
  ]);
  const incomeColumns = extractDescribeColumns(incomeSchema);
  const assetColumns = extractDescribeColumns(assetsSchema);
  const liabilityColumns = extractDescribeColumns(liabilitiesSchema);
  const equityColumns = extractDescribeColumns(equitySchema);

  return {
    operatingIncome: chooseColumn(incomeColumns, ['operating_income_loss', 'operating_income', 'income_after_depreciation_and_amortization', 'income_from_operations', 'operating_profit']),
    netIncome: chooseColumn(incomeColumns, ['income_from_continuing_operations', 'net_income', 'net_income_loss', 'profit_loss']),
    totalAssets: chooseColumn(assetColumns, ['total_assets', 'assets']),
    totalLiabilities: chooseColumn(liabilityColumns, ['total_liabilities', 'liabilities']),
    currentLiabilities: chooseColumn(liabilityColumns, ['total_current_liabilities', 'current_liabilities', 'liabilities_current']),
    equity: chooseColumn(equityColumns, ['total_equity', 'stockholders_equity', 'shareholders_equity', 'stockholders_equity_including_portion_attributable_to_noncontrolling_interest']),
    longTermDebt: chooseColumn(liabilityColumns, ['long_term_debt', 'long_term_debt_noncurrent', 'debt_noncurrent']),
    otherNonCurrentLiabilities: chooseColumn(liabilityColumns, ['other_non_current_liabilities', 'other_liabilities_noncurrent', 'other_long_term_liabilities']),
    operatingLeaseLiabilitiesNonCurrent: chooseColumn(liabilityColumns, [
      'operating_lease_liabilities_non_current',
      'operating_lease_liabilities_noncurrent',
      'operating_lease_liability_noncurrent',
      'non_current_operating_lease_liabilities',
      'long_term_operating_lease_liabilities',
      'operating_lease_obligation_noncurrent'
    ]),
    cashColumns: chooseColumns(assetColumns, [
      ['cash_and_equivalents', 'cash_and_cash_equivalents_at_carrying_value', 'cash_and_cash_equivalents', 'cash'],
      ['short_term_investments', 'marketable_securities_current']
    ]),
    debtColumns: chooseColumns(liabilityColumns, [
      ['short_term_borrowings', 'short_term_debt', 'debt_current', 'long_term_debt_current'],
      ['long_term_debt', 'long_term_debt_noncurrent', 'debt_noncurrent']
    ]),
    availableIncomeColumns: incomeColumns,
    availableAssetColumns: assetColumns,
    availableLiabilityColumns: liabilityColumns,
    availableEquityColumns: equityColumns
  };
}

function chooseColumn(columns, candidates) {
  for (const candidate of candidates) {
    const found = columns.find(column => column.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}

function chooseColumns(columns, candidateGroups) {
  const selected = [];
  for (const group of candidateGroups) {
    const found = chooseColumn(columns, group);
    if (found && !selected.includes(found)) selected.push(found);
  }
  return selected;
}

function sumColumnsSql(columns, alias) {
  if (!Array.isArray(columns) || columns.length === 0) return `CAST(NULL AS DOUBLE) AS ${quoteIdentifier(alias)}`;
  const expression = columns.map(column => `COALESCE(${quoteIdentifier(column)}, 0)`).join(' + ');
  return `(${expression}) AS ${quoteIdentifier(alias)}`;
}

function parseNumberOrNull(value) {
  const parsed = parseNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}


async function resolveCashFlowFields() {
  const schema = await getDoltTableSchema('cash_flow_statement');
  const columns = extractDescribeColumns(schema);

  const operatingCashFlow = chooseCashFlowColumn(columns, [
    'net_cash_flow_operating',
    'net_cash_provided_by_operating_activities',
    'net_cash_provided_by_used_in_operating_activities',
    'net_cash_from_operating_activities',
    'cash_flow_from_operating_activities',
    'cash_from_operating_activities',
    'operating_cash_flow'
  ], column => {
    const name = column.toLowerCase();
    let score = 0;
    if (name.includes('operat')) score += 8;
    if (name.includes('cash')) score += 5;
    if (name.includes('flow')) score += 2;
    if (name.includes('net')) score += 1;
    if (name.includes('continuing')) score -= 2;
    if (name.includes('invest')) score -= 10;
    if (name.includes('financ')) score -= 10;
    return score;
  });

  const capitalExpenditures = chooseCashFlowColumn(columns, [
    'payments_to_acquire_property_plant_and_equipment',
    'payments_to_acquire_productive_assets',
    'capital_expenditures',
    'capital_expenditure',
    'capex',
    'property_and_equipment'
  ], column => {
    const name = column.toLowerCase();
    let score = 0;
    if (name.includes('capital') && name.includes('expend')) score += 12;
    if (name.includes('payments_to_acquire')) score += 7;
    if (name.includes('property_plant')) score += 7;
    if (name.includes('productive_assets')) score += 5;
    if (name === 'property_and_equipment') score += 12;
    if (name.includes('property') && name.includes('equipment')) score += 8;
    if (name === 'capex') score += 12;
    if (name.includes('proceeds')) score -= 10;
    if (name.includes('business')) score -= 5;
    return score;
  });

  if (!operatingCashFlow || !capitalExpenditures) {
    throw createError(500, 'Could not identify the operating cash flow or capital expenditure columns in cash_flow_statement.', {
      availableColumns: columns,
      detected: { operatingCashFlow, capitalExpenditures }
    });
  }

  return { operatingCashFlow, capitalExpenditures, availableColumns: columns };
}

function chooseCashFlowColumn(columns, exactCandidates, scorer) {
  for (const candidate of exactCandidates) {
    const exact = columns.find(column => column.toLowerCase() === candidate);
    if (exact) return exact;
  }

  return columns
    .map(column => ({ column, score: scorer(column) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.column.localeCompare(b.column))[0]?.column || null;
}

function quoteIdentifier(value) {
  const identifier = String(value || '');
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) throw createError(500, 'Unsafe database column name detected.');
  return `\`${identifier}\``;
}


function validateTable(value) {
  const allowed = new Set(['income_statement', 'balance_sheet_equity', 'cash_flow_statement']);
  if (!allowed.has(value)) throw createError(400, 'Unsupported table.');
  return value;
}

function normaliseTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,20}$/.test(ticker)) throw createError(400, 'Invalid ticker.');
  return ticker;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(String(value).replace(/,/g, ''));
}

function createError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Worker-Version': VERSION
    }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      ...CORS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Worker-Version': VERSION
    }
  });
}

const LAB_HTML = `<!doctype html>
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
function renderCompany(data){const currency=data.currency||'USD';const items=[['Market cap',compactMoney(data.marketCap,currency)],['Enterprise value',compactMoney(data.enterpriseValue,currency)],['Revenue TTM',compactMoney(data.revenueTtm,currency)],['Net income TTM',compactMoney(data.netIncomeTtm,currency)],['Free cash flow TTM',compactMoney(data.freeCashFlowTtm,currency)],['Total debt',compactMoney(data.totalDebt,currency)],['Shares outstanding',compactShares(data.sharesOutstanding)],['ROIC',pct(data.roic)+'<small class="metric-warning">Error of +/- 5% possible</small>']];companyEl.innerHTML='<div class="company-head"><div><h2 class="company-title">'+escapeHtml(data.companyName||data.ticker)+'</h2><div class="company-meta">'+escapeHtml(data.ticker)+(data.exchange?' · '+escapeHtml(data.exchange):'')+'</div></div><div class="company-price">'+compactMoney(data.price,currency)+'</div></div><div class="overview-grid">'+items.map(item=>'<div class="overview-item"><small>'+item[0]+'</small><strong>'+item[1]+'</strong></div>').join('')+'</div>';companyEl.classList.add('visible')}
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
function mainChartSvg(config){const source=pointsForFrequency(config);const clean=source.map(point=>({label:String(point.label??point.year),sortKey:String(point.sortKey??point.year),value:Number(point.value)})).filter(point=>Number.isFinite(point.value)).sort((a,b)=>a.sortKey.localeCompare(b.sortKey));const count=visiblePointCount();const visible=count==='max'?clean:clean.slice(-count);if(visible.length<2)return '<div class="empty">Not enough '+selectedFrequency+' data for this chart.</div>';const width=920,height=350,left=76,right=24,top=42,bottom=55;const values=visible.map(point=>point.value);let min=Math.min(...values),max=Math.max(...values);if(selectedChartType==='bar'){min=Math.min(0,min);max=Math.max(0,max)}if(min===max){min-=1;max+=1}const pad=(max-min)*.1||1;const plotMin=min-pad,plotMax=max+pad;const plotW=width-left-right,plotH=height-top-bottom;const xLine=index=>left+(index*plotW)/(visible.length-1);const slot=plotW/visible.length;const xBar=index=>left+index*slot+slot*.14;const barW=Math.max(3,slot*.72);const y=value=>top+((plotMax-value)*plotH)/(plotMax-plotMin);const ticks=[plotMax,plotMin+(plotMax-plotMin)*.75,plotMin+(plotMax-plotMin)*.5,plotMin+(plotMax-plotMin)*.25,plotMin];const grids=ticks.map(value=>'<line class="main-chart-grid" x1="'+left+'" y1="'+y(value).toFixed(1)+'" x2="'+(width-right)+'" y2="'+y(value).toFixed(1)+'"></line><text class="main-chart-label" x="'+(left-10)+'" y="'+(y(value)+4).toFixed(1)+'" text-anchor="end">'+chartValue(value,config.isPercent)+'</text>').join('');const zero=plotMin<0&&plotMax>0?'<line class="main-chart-zero" x1="'+left+'" y1="'+y(0).toFixed(1)+'" x2="'+(width-right)+'" y2="'+y(0).toFixed(1)+'"></line>':'';const step=Math.max(1,Math.ceil(visible.length/10));const labels=visible.map((point,index)=>{if(index!==0&&index!==visible.length-1&&index%step!==0)return '';const x=selectedChartType==='bar'?xBar(index)+barW/2:xLine(index);return '<text class="main-chart-label" x="'+x.toFixed(1)+'" y="'+(height-22)+'" text-anchor="middle">'+escapeHtml(point.label)+'</text>'}).join('');let marks='';if(selectedChartType==='bar'){const zeroY=y(0);marks=visible.map((point,index)=>{const valueY=y(point.value);const topY=Math.min(valueY,zeroY);const h=Math.max(1,Math.abs(zeroY-valueY));return '<rect class="main-chart-bar" x="'+xBar(index).toFixed(1)+'" y="'+topY.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+h.toFixed(1)+'" rx="3"><title>'+escapeHtml(point.label)+': '+chartValue(point.value,config.isPercent)+'</title></rect>'}).join('')}else{const points=visible.map((point,index)=>xLine(index).toFixed(1)+','+y(point.value).toFixed(1)).join(' ');marks='<polyline class="main-chart-line" points="'+points+'"></polyline>'+visible.map((point,index)=>'<circle class="main-chart-point" cx="'+xLine(index).toFixed(1)+'" cy="'+y(point.value).toFixed(1)+'" r="4"><title>'+escapeHtml(point.label)+': '+chartValue(point.value,config.isPercent)+'</title></circle>').join('')}return '<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+escapeHtml(config.label)+' historical '+selectedChartType+' chart">'+grids+zero+'<text class="main-chart-title" x="'+left+'" y="22">'+escapeHtml(config.label)+' · '+(selectedFrequency==='quarterly'?'Quarterly':'Annual')+'</text>'+marks+labels+'</svg>'}
function renderMainHistoricalChart(){const config=mainChartConfig();if(!config){historicalMainChart.innerHTML='<div class="empty">This metric is unavailable.</div>';historicalChartSummary.innerHTML='';historicalChartTable.innerHTML='';return}const source=pointsForFrequency(config);const count=visiblePointCount();const clean=source.map(point=>({label:String(point.label??point.year),sortKey:String(point.sortKey??point.year),value:Number(point.value)})).filter(point=>Number.isFinite(point.value)).sort((a,b)=>a.sortKey.localeCompare(b.sortKey));const visible=count==='max'?clean:clean.slice(-count);const quarterlyUnavailable=selectedFrequency==='quarterly'&&clean.length<2;historicalAvailability.className='history-note'+(quarterlyUnavailable?' warning':'');historicalAvailability.textContent=quarterlyUnavailable?(config.quarterlyUnavailableReason||'Quarterly data is not available for this metric yet.'):(selectedFrequency==='quarterly'?'Quarterly values use each reported quarter, not trailing-twelve-month totals.':'Annual values use completed fiscal years.');historicalMainChart.innerHTML=mainChartSvg(config);const latest=visible.at(-1);const first=visible[0];let totalChange=null;if(first&&latest&&Number(first.value)!==0)totalChange=((Number(latest.value)/Number(first.value))-1)*100;let recentChange=null;let recentLabel=selectedFrequency==='quarterly'?'QoQ change':'1Y change';if(visible.length>1&&Number(visible.at(-2).value)!==0)recentChange=((Number(latest.value)/Number(visible.at(-2).value))-1)*100;let yoyChange=null;if(selectedFrequency==='quarterly'&&visible.length>4&&Number(visible.at(-5).value)!==0)yoyChange=((Number(latest.value)/Number(visible.at(-5).value))-1)*100;const changeValue=config.isPercent&&first&&latest?(Number(latest.value)-Number(first.value)).toFixed(2)+' pp':pct(totalChange);const recentValue=config.isPercent&&visible.length>1?(Number(latest.value)-Number(visible.at(-2).value)).toFixed(2)+' pp':pct(recentChange);historicalChartSummary.innerHTML='<div class="chart-summary-item"><small>Latest</small><strong>'+chartValue(Number(latest?.value),config.isPercent)+'</strong></div><div class="chart-summary-item"><small>Range</small><strong>'+(first&&latest?escapeHtml(first.label)+'–'+escapeHtml(latest.label):'-')+'</strong></div><div class="chart-summary-item"><small>'+recentLabel+'</small><strong>'+recentValue+'</strong></div><div class="chart-summary-item"><small>'+(selectedFrequency==='quarterly'?'YoY change':'Total change')+'</small><strong>'+(selectedFrequency==='quarterly'?(config.isPercent&&visible.length>4?(Number(latest.value)-Number(visible.at(-5).value)).toFixed(2)+' pp':pct(yoyChange)):changeValue)+'</strong></div>';historicalChartTable.innerHTML=tableFor(config.tableKey,rowsForFrequency(config),selectedFrequency);historyDescription.textContent=selectedFrequency==='quarterly'?'Reported quarter-end figures. Growth compares with the same quarter one year earlier.':'Completed fiscal-year figures and year-over-year changes.'}
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
</script></main></body></html>`;
