import { searchYahooEquities, fetchYahooQuote, fetchYahooTtmCashFlow } from './providers/yahoo.js';

const VERSION = 'stock-valuation-worker-v7.2-3year-no-roic-2026-07-25';
const DOLT_BASE = 'https://www.dolthub.com/api/v1alpha1/post-no-preference/earnings';

const DOLT_TICKER_ALIASES = {
  META: ['META', 'FB']
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Expose-Headers': 'X-Worker-Version'
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    try {
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
        return jsonResponse(await fetchCoreFinancials(ticker));
      }

      if (url.searchParams.has('q')) {
        const sql = validateReadOnlySql(url.searchParams.get('q'));
        const result = await runDoltQuery(sql);
        return jsonResponse({ ok: true, version: VERSION, ...result });
      }

      if (url.searchParams.has('dashboard')) {
        const ticker = normaliseTicker(url.searchParams.get('dashboard'));
        return jsonResponse(await buildDashboardMetrics(ticker));
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
        error: 'Use ?search=apple, ?quote=AAPL, ?financials=AAPL, ?dashboard=AAPL, ?q=SELECT..., or the individual metric routes.'
      }, 400);
    } catch (error) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: error.message || 'Unknown error',
        details: error.details || null
      }, error.status || 500);
    }
  }
};



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

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function getDoltTickerSymbols(ticker) {
  const current = String(ticker || '').toUpperCase();
  const aliases = DOLT_TICKER_ALIASES[current] || [current];
  return [...new Set(aliases.map(symbol => String(symbol).toUpperCase()))];
}

function doltTickerPredicate(ticker, column = 'act_symbol') {
  const symbols = getDoltTickerSymbols(ticker);
  if (symbols.length === 1) return `${column} = ${sqlString(symbols[0])}`;
  return `${column} IN (${symbols.map(sqlString).join(', ')})`;
}


async function fetchCoreFinancials(ticker) {
  const revenueSql = `SELECT sales, \`date\`, period FROM \`income_statement\` WHERE ${doltTickerPredicate(ticker)} AND period = 'Quarter' AND sales IS NOT NULL ORDER BY \`date\` DESC LIMIT 4`;
  const sharesSql = `SELECT shares_outstanding, \`date\`, period FROM \`balance_sheet_equity\` WHERE ${doltTickerPredicate(ticker)} AND shares_outstanding IS NOT NULL ORDER BY \`date\` DESC LIMIT 10`;
  const [revenueResult, sharesResult] = await Promise.all([runDoltQuery(revenueSql), runDoltQuery(sharesSql)]);
  const revenueRows = Array.isArray(revenueResult.rows) ? revenueResult.rows : [];
  const revenue = revenueRows.slice(0, 4).reduce((sum, row) => sum + (Number.isFinite(parseNumber(row.sales)) ? parseNumber(row.sales) : 0), 0);
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
    diagnostics: {
      revenueQuarterDates: revenueRows.map(row => String(row.date || '').slice(0, 10)),
      sharesDate: shareRow ? String(shareRow.date || '').slice(0, 10) : null,
      commitRef: revenueResult.commit_ref || sharesResult.commit_ref || null
    }
  };
}

function metricPercentage(value) {
  return Number.isFinite(Number(value?.percentage)) ? Number(value.percentage) : null;
}

async function buildDashboardMetrics(ticker) {
  const [revenueResult, marginResult, fcfResult] = await Promise.allSettled([
    calculateRevenueHistory(ticker),
    calculateNetMarginHistory(ticker),
    calculateFcfMarginHistory(ticker)
  ]);
  const revenue = revenueResult.status === 'fulfilled' ? revenueResult.value : null;
  const margin = marginResult.status === 'fulfilled' ? marginResult.value : null;
  const fcf = fcfResult.status === 'fulfilled' ? fcfResult.value : null;
  return {
    ok: true,
    version: VERSION,
    ticker,
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
    },
    errors: [
      revenueResult.status === 'rejected' ? `Revenue growth: ${revenueResult.reason?.message || 'failed'}` : null,
      marginResult.status === 'rejected' ? `Net margin: ${marginResult.reason?.message || 'failed'}` : null,
      fcfResult.status === 'rejected' ? `FCF margin: ${fcfResult.reason?.message || 'failed'}` : null
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
    operatingIncome: ['operating_income_loss', 'operating_income'],
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
  const latestFour = quarterly.rows.slice(0, 4);
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

function normaliseRevenueRows(rows, type) {
  const seen = new Set();
  const output = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const period = String(row.period || '');
    const sales = parseNumber(row.sales);
    const key = `${date}|${period}|${sales}`;
    if (!date || !Number.isFinite(sales) || seen.has(key)) continue;
    seen.add(key);
    output.push({
      type,
      date,
      fiscalYear: date.slice(0, 4),
      period,
      sales,
      salesMillions: sales / 1e6,
      salesBillions: sales / 1e9
    });
  }
  return output;
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
  const latestFour = quarterly.rows.slice(0, 4);
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

function normaliseNetIncomeRows(rows, type) {
  const seen = new Set();
  const output = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const period = String(row.period || '');
    const netIncome = parseNumber(row.net_income);
    const key = `${date}|${period}|${netIncome}`;
    if (!date || !Number.isFinite(netIncome) || seen.has(key)) continue;
    seen.add(key);
    output.push({
      type,
      date,
      fiscalYear: date.slice(0, 4),
      period,
      netIncome,
      netIncomeMillions: netIncome / 1e6,
      netIncomeBillions: netIncome / 1e9
    });
  }
  return output;
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

  const quarterlyByDate = new Map();
  for (const row of quarterlyRows) {
    const date = String(row.date || '').slice(0, 10);
    const sales = parseNumber(row.sales);
    if (!date || !Number.isFinite(sales) || sales <= 0) continue;
    quarterlyByDate.set(date, { date, sales });
  }

  const quarters = [...quarterlyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const ttmSeries = [];

  for (let i = 3; i < quarters.length; i += 1) {
    const window = quarters.slice(i - 3, i + 1);
    const revenue = window.reduce((sum, item) => sum + item.sales, 0);
    ttmSeries.push({
      endDate: quarters[i].date,
      revenue,
      revenueBillions: revenue / 1e9,
      quarterDates: window.map(item => item.date)
    });
  }

  const annualByDate = new Map();
  for (const row of annualRowsRaw) {
    const date = String(row.date || '').slice(0, 10);
    const sales = parseNumber(row.sales);
    if (!date || !Number.isFinite(sales) || sales <= 0) continue;
    annualByDate.set(date, {
      date,
      fiscalYear: Number(date.slice(0, 4)),
      revenue: sales,
      revenueBillions: sales / 1e9
    });
  }

  // Some Dolt annual rows are missing even though all four quarterly rows exist
  // (common for banks such as JPM and BAC). Fill only missing fiscal years by
  // using the four-quarter sum ending on the company's fiscal year-end date.
  const reportedAnnualSeries = [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const fiscalYearEndMonthDay = reportedAnnualSeries.at(-1)?.date.slice(5) || null;
  let reconstructedAnnualYears = 0;

  if (fiscalYearEndMonthDay) {
    for (const point of ttmSeries) {
      if (point.endDate.slice(5) !== fiscalYearEndMonthDay) continue;
      if (annualByDate.has(point.endDate)) continue;
      annualByDate.set(point.endDate, {
        date: point.endDate,
        fiscalYear: Number(point.endDate.slice(0, 4)),
        revenue: point.revenue,
        revenueBillions: point.revenueBillions,
        source: 'reconstructed from four quarterly revenue rows',
        quarterDates: point.quarterDates
      });
      reconstructedAnnualYears += 1;
    }
  }

  const annualSeries = [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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
    ttmSeries: ttmSeries.slice(-44)
  };
}

function ttmGrowthAgainstOneYearAgo(series, latest) {
  const latestDate = new Date(`${latest.endDate}T00:00:00Z`);
  const target = new Date(latestDate);
  target.setUTCFullYear(target.getUTCFullYear() - 1);

  let comparison = null;
  let smallestDistance = Infinity;

  for (const point of series) {
    if (point.endDate === latest.endDate) continue;
    const pointDate = new Date(`${point.endDate}T00:00:00Z`);
    const distance = Math.abs(pointDate.getTime() - target.getTime());
    if (distance < smallestDistance) {
      smallestDistance = distance;
      comparison = point;
    }
  }

  if (!comparison || comparison.revenue <= 0) return null;

  return {
    method: 'year-over-year TTM growth',
    percentage: (latest.revenue / comparison.revenue - 1) * 100,
    latestEndDate: latest.endDate,
    comparisonEndDate: comparison.endDate,
    latestRevenueBillions: latest.revenueBillions,
    comparisonRevenueBillions: comparison.revenueBillions
  };
}

function fiscalYearCagr(series, latest, years) {
  const targetFiscalYear = latest.fiscalYear - years;
  const comparison = series.find(point => point.fiscalYear === targetFiscalYear);

  if (!comparison || comparison.revenue <= 0) {
    return {
      method: 'fiscal-year CAGR',
      percentage: null,
      years,
      latestFiscalYear: latest.fiscalYear,
      requestedComparisonFiscalYear: targetFiscalYear,
      error: `No fiscal-year revenue row found for ${targetFiscalYear}.`
    };
  }

  return {
    method: 'fiscal-year CAGR',
    percentage: (Math.pow(latest.revenue / comparison.revenue, 1 / years) - 1) * 100,
    years,
    latestFiscalYear: latest.fiscalYear,
    comparisonFiscalYear: comparison.fiscalYear,
    latestDate: latest.date,
    comparisonDate: comparison.date,
    latestRevenueBillions: latest.revenueBillions,
    comparisonRevenueBillions: comparison.revenueBillions
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

  const quarterlyByDate = new Map();
  for (const row of quarterlyRows) {
    const date = String(row.date || '').slice(0, 10);
    const revenue = parseNumber(row.sales);
    const netIncome = parseNumber(row.net_income);
    if (!date || !Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(netIncome)) continue;
    quarterlyByDate.set(date, { date, revenue, netIncome });
  }

  const quarters = [...quarterlyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const ttmSeries = [];
  for (let i = 3; i < quarters.length; i += 1) {
    const window = quarters.slice(i - 3, i + 1);
    const revenue = window.reduce((sum, row) => sum + row.revenue, 0);
    const netIncome = window.reduce((sum, row) => sum + row.netIncome, 0);
    ttmSeries.push({
      endDate: quarters[i].date,
      revenue,
      revenueBillions: revenue / 1e9,
      netIncome,
      netIncomeBillions: netIncome / 1e9,
      netMarginPercentage: revenue > 0 ? (netIncome / revenue) * 100 : null,
      quarterDates: window.map(row => row.date)
    });
  }

  const annualByDate = new Map();
  for (const row of annualRows) {
    const date = String(row.date || '').slice(0, 10);
    const revenue = parseNumber(row.sales);
    const netIncome = parseNumber(row.net_income);
    if (!date || !Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(netIncome)) continue;
    annualByDate.set(date, {
      date,
      fiscalYear: Number(date.slice(0, 4)),
      revenue,
      revenueBillions: revenue / 1e9,
      netIncome,
      netIncomeBillions: netIncome / 1e9,
      netMarginPercentage: (netIncome / revenue) * 100
    });
  }

  const annualSeries = [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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

function calculateWeightedNetMargin(series, years) {
  const selectedRows = series.slice(-years);
  if (selectedRows.length < years) {
    return {
      method: 'weighted fiscal-year net margin',
      percentage: null,
      requestedYears: years,
      availableYears: selectedRows.length,
      error: `Only ${selectedRows.length} fiscal years are available.`
    };
  }

  const totalRevenue = selectedRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalNetIncome = selectedRows.reduce((sum, row) => sum + row.netIncome, 0);

  return {
    method: 'weighted fiscal-year net margin',
    percentage: totalRevenue > 0 ? (totalNetIncome / totalRevenue) * 100 : null,
    years,
    firstFiscalYear: selectedRows[0].fiscalYear,
    latestFiscalYear: selectedRows.at(-1).fiscalYear,
    totalRevenue,
    totalRevenueBillions: totalRevenue / 1e9,
    totalNetIncome,
    totalNetIncomeBillions: totalNetIncome / 1e9,
    rowsUsed: selectedRows
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

  const latestRevenueRows = (Array.isArray(quarterlyRevenueResult.rows) ? quarterlyRevenueResult.rows : [])
    .map(row => ({
      date: String(row.date || '').slice(0, 10),
      revenue: parseNumber(row.sales)
    }))
    .filter(row => row.date && Number.isFinite(row.revenue) && row.revenue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const ttmRevenueRows = latestRevenueRows.slice(-4);
  const ttmRevenue = ttmRevenueRows.length === 4
    ? ttmRevenueRows.reduce((sum, row) => sum + row.revenue, 0)
    : null;

  const yahooTtm = yahooResult.ok ? yahooResult.value : null;
  const latestTTM = Number.isFinite(ttmRevenue) && yahooTtm ? {
    endDate: ttmRevenueRows.at(-1).date,
    revenue: ttmRevenue,
    revenueBillions: ttmRevenue / 1e9,
    operatingCashFlow: yahooTtm.operatingCashFlow,
    operatingCashFlowBillions: yahooTtm.operatingCashFlow / 1e9,
    capitalExpenditures: yahooTtm.capitalExpenditures,
    capitalExpendituresBillions: yahooTtm.capitalExpenditures / 1e9,
    freeCashFlow: yahooTtm.freeCashFlow,
    freeCashFlowBillions: yahooTtm.freeCashFlow / 1e9,
    fcfMarginPercentage: (yahooTtm.freeCashFlow / ttmRevenue) * 100,
    quarterDates: ttmRevenueRows.map(row => row.date),
    cashFlowAsOfDate: yahooTtm.asOfDate,
    currency: yahooTtm.currency,
    source: 'Yahoo Finance fundamentals-timeseries'
  } : null;

  const annualRevenueByDate = new Map();
  for (const row of Array.isArray(annualRevenueResult.rows) ? annualRevenueResult.rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const revenue = parseNumber(row.sales);
    if (date && Number.isFinite(revenue) && revenue > 0) annualRevenueByDate.set(date, revenue);
  }

  const annualByDate = new Map();
  for (const row of Array.isArray(annualCashFlowResult.rows) ? annualCashFlowResult.rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const revenue = annualRevenueByDate.get(date);
    const operatingCashFlow = parseNumber(row.operating_cash_flow);
    const capexRaw = parseNumber(row.capital_expenditures);
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
      fcfMarginPercentage: (freeCashFlow / revenue) * 100
    });
  }

  const annualSeries = [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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


async function resolveCashFlowFields() {
  const schema = await runDoltQuery('DESCRIBE `cash_flow_statement`');
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

function calculateWeightedFcfMargin(series, years) {
  const selectedRows = series.slice(-years);
  if (selectedRows.length < years) return { method: 'weighted fiscal-year FCF margin', percentage: null, requestedYears: years, availableYears: selectedRows.length, error: `Only ${selectedRows.length} fiscal years are available.` };
  const totalRevenue = selectedRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalFreeCashFlow = selectedRows.reduce((sum, row) => sum + row.freeCashFlow, 0);
  return { method: 'weighted fiscal-year FCF margin', percentage: totalRevenue > 0 ? (totalFreeCashFlow / totalRevenue) * 100 : null, years, firstFiscalYear: selectedRows[0].fiscalYear, latestFiscalYear: selectedRows.at(-1).fiscalYear, totalRevenue, totalRevenueBillions: totalRevenue / 1e9, totalFreeCashFlow, totalFreeCashFlowBillions: totalFreeCashFlow / 1e9, rowsUsed: selectedRows };
}

async function runDoltQuery(sql) {
  const target = new URL(DOLT_BASE);
  target.searchParams.set('q', sql);

  const response = await fetch(target.toString(), {
    headers: { Accept: 'application/json' },
    cf: { cacheEverything: true, cacheTtl: 300 }
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw createError(502, `DoltHub returned non-JSON: ${text.slice(0, 180)}`);
  }

  if (!response.ok || body.query_execution_status === 'Error') {
    const message = body.query_execution_message || body.error || response.statusText || 'DoltHub query failed';
    throw createError(response.status || 502, message, { sql, body });
  }

  return body;
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
:root{color-scheme:dark;--bg:#0b0d10;--card:#15181e;--inner:#232832;--border:#303744;--text:#fff;--muted:#9da6b4;--green:#73be43;--red:#ff6464}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:18px}main{width:min(1100px,100%);margin:auto}h1{margin:0 0 6px}.lead{color:var(--muted);line-height:1.5}.bar{display:grid;grid-template-columns:1fr auto auto;gap:9px;background:var(--card);border:1px solid var(--border);padding:12px;border-radius:12px;margin:16px 0}input,button{font:inherit;border-radius:7px}input{background:var(--inner);border:1px solid var(--border);color:var(--text);padding:10px 12px;text-transform:uppercase;font-weight:700}button{border:0;background:var(--green);color:#081006;padding:10px 15px;font-weight:800;cursor:pointer}.secondary{background:var(--inner);color:var(--text);border:1px solid var(--border)}.status{padding:12px;background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;min-width:0}.card h2{font-size:1rem;margin:0 0 10px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.metric{background:var(--inner);border-radius:8px;padding:10px}.metric strong{display:block;font-size:1.25rem}.metric span{font-size:.75rem;color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:520px;overflow:auto;background:#090b0e;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:.75rem;line-height:1.45}.ok{color:var(--green)}.bad{color:var(--red)}@media(max-width:750px){.bar,.grid{grid-template-columns:1fr}.metrics{grid-template-columns:1fr}}
</style>
</head>
<body><main>
<h1>Fundamentals Lab</h1>
<p class="lead">Safe development page served by the Cloudflare Worker preview. It does not touch your GitHub site or production calculator.</p>
<div class="bar"><input id="ticker" value="AAPL" maxlength="20"><button id="revenueBtn">Revenue growth</button><button id="marginBtn" class="secondary">Net margin</button><button id="fcfMarginBtn" class="secondary">FCF margin</button><button id="inspectBtn" class="secondary">Inspect schemas</button></div>
<div id="status" class="status">Ready. Choose a metric to test.</div>
<div class="grid">
<section class="card"><h2>Historical revenue growth</h2><div class="metrics"><div class="metric"><strong id="one">-</strong><span>1 year TTM</span></div><div class="metric"><strong id="three">-</strong><span>3 year FY CAGR</span></div><div class="metric"><strong id="five">-</strong><span>5 year FY CAGR</span></div><div class="metric"><strong id="ten">-</strong><span>10 year FY CAGR</span></div></div><pre id="revenueRaw">No response yet.</pre></section>
<section class="card"><h2>Historical net margins</h2><div class="metrics"><div class="metric"><strong id="marginOne">-</strong><span>1 year TTM</span></div><div class="metric"><strong id="marginThree">-</strong><span>3 year weighted</span></div><div class="metric"><strong id="marginFive">-</strong><span>5 year weighted</span></div><div class="metric"><strong id="marginTen">-</strong><span>10 year weighted</span></div></div><pre id="marginRaw">No response yet.</pre></section>
<section class="card"><h2>Historical FCF margins</h2><div class="metrics"><div class="metric"><strong id="fcfMarginOne">-</strong><span>1 year TTM</span></div><div class="metric"><strong id="fcfMarginThree">-</strong><span>3 year weighted</span></div><div class="metric"><strong id="fcfMarginFive">-</strong><span>5 year weighted</span></div><div class="metric"><strong id="fcfMarginTen">-</strong><span>10 year weighted</span></div></div><pre id="fcfMarginRaw">No response yet.</pre></section>
<section class="card"><h2>Schema and field inspection</h2><pre id="inspectRaw">No response yet.</pre></section>
</div>
<script>
const ticker=document.getElementById('ticker');const statusEl=document.getElementById('status');
function symbol(){const v=ticker.value.trim().toUpperCase();if(!/^[A-Z0-9.^-]{1,20}$/.test(v))throw new Error('Enter a valid ticker.');ticker.value=v;return v}
function pct(v){return Number.isFinite(v)?v.toFixed(2)+'%':'-'}
async function getJson(params){const url=new URL(location.href);url.search='';Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));const r=await fetch(url,{cache:'no-store'});const text=await r.text();let j;try{j=JSON.parse(text)}catch{throw new Error(text.slice(0,200))}if(!r.ok||j.ok===false)throw new Error(j.error||'Request failed');return j}
document.getElementById('revenueBtn').onclick=async()=>{try{const s=symbol();statusEl.textContent='Calculating '+s+' revenue historyÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦';const j=await getJson({revenueHistory:s});document.getElementById('one').textContent=pct(j.historicalRevenueGrowth?.oneYear?.percentage);document.getElementById('three').textContent=pct(j.historicalRevenueGrowth?.threeYears?.percentage);document.getElementById('five').textContent=pct(j.historicalRevenueGrowth?.fiveYears?.percentage);document.getElementById('ten').textContent=pct(j.historicalRevenueGrowth?.tenYears?.percentage);document.getElementById('revenueRaw').textContent=JSON.stringify(j,null,2);statusEl.innerHTML='<span class="ok">Revenue test completed.</span> 1-year uses TTM; 3-, 5-, and 10-year growth use fiscal-year CAGR.'}catch(e){statusEl.innerHTML='<span class="bad">'+e.message+'</span>'}};
document.getElementById('marginBtn').onclick=async()=>{try{const s=symbol();statusEl.textContent='Calculating '+s+' historical net marginsÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦';const j=await getJson({netMarginHistory:s});document.getElementById('marginOne').textContent=pct(j.historicalNetMargins?.oneYear?.percentage);document.getElementById('marginThree').textContent=pct(j.historicalNetMargins?.threeYears?.percentage);document.getElementById('marginFive').textContent=pct(j.historicalNetMargins?.fiveYears?.percentage);document.getElementById('marginTen').textContent=pct(j.historicalNetMargins?.tenYears?.percentage);document.getElementById('marginRaw').textContent=JSON.stringify(j,null,2);statusEl.innerHTML='<span class="ok">Margin calculation completed.</span> 1-year uses latest TTM; 3-, 5-, and 10-year values use total net income divided by total revenue.'}catch(e){statusEl.innerHTML='<span class="bad">'+e.message+'</span>'}};
document.getElementById('fcfMarginBtn').onclick=async()=>{try{const s=symbol();statusEl.textContent='Calculating '+s+' historical FCF marginsÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦';const j=await getJson({fcfMarginHistory:s});document.getElementById('fcfMarginOne').textContent=pct(j.historicalFcfMargins?.oneYear?.percentage);document.getElementById('fcfMarginThree').textContent=pct(j.historicalFcfMargins?.threeYears?.percentage);document.getElementById('fcfMarginFive').textContent=pct(j.historicalFcfMargins?.fiveYears?.percentage);document.getElementById('fcfMarginTen').textContent=pct(j.historicalFcfMargins?.tenYears?.percentage);document.getElementById('fcfMarginRaw').textContent=JSON.stringify(j,null,2);statusEl.innerHTML='<span class="ok">FCF margin calculation completed.</span> 1-year uses latest TTM; 3-, 5-, and 10-year values use total FCF divided by total revenue.'}catch(e){statusEl.innerHTML='<span class="bad">'+e.message+'</span>'}};
document.getElementById('inspectBtn').onclick=async()=>{try{const s=symbol();statusEl.textContent='Inspecting '+s+' statement schemasÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦';const j=await getJson({inspect:s});document.getElementById('inspectRaw').textContent=JSON.stringify(j,null,2);statusEl.innerHTML='<span class="ok">Schema inspection completed.</span> The candidateColumns section shows which fields actually exist.'}catch(e){statusEl.innerHTML='<span class="bad">'+e.message+'</span>'}};
</script></main></body></html>`;
