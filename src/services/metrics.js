// Pure presentation and metric-shaping helpers.
// These functions do not fetch data and do not depend on Cloudflare APIs.

function parseFinancialNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(String(value).replace(/,/g, ''));
}

export function metricPercentage(value) {
  return Number.isFinite(Number(value?.percentage)) ? Number(value.percentage) : null;
}

export function buildDashboardMetricGroups(revenue, margin, fcf) {
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

export function normaliseRevenueRows(rows, type) {
  const seen = new Set();
  const output = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const period = String(row.period || '');
    const sales = parseFinancialNumber(row.sales);
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

export function normaliseNetIncomeRows(rows, type) {
  const seen = new Set();
  const output = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row.date || '').slice(0, 10);
    const period = String(row.period || '');
    const netIncome = parseFinancialNumber(row.net_income);
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

export function buildLatestTtmFcf(quarterlyRevenueRows, yahooTtm) {
  const latestRevenueRows = (Array.isArray(quarterlyRevenueRows) ? quarterlyRevenueRows : [])
    .map(row => ({
      date: String(row.date || '').slice(0, 10),
      revenue: parseFinancialNumber(row.sales)
    }))
    .filter(row => row.date && Number.isFinite(row.revenue) && row.revenue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

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
    fcfMarginPercentage: (yahooTtm.freeCashFlow / revenue) * 100,
    quarterDates: rowsUsed.map(row => row.date),
    cashFlowAsOfDate: yahooTtm.asOfDate,
    currency: yahooTtm.currency,
    source: 'Yahoo Finance fundamentals-timeseries'
  };
}

export function buildAnnualFcfSeries(annualCashFlowRows, annualRevenueRows) {
  const revenueByDate = new Map();
  for (const row of Array.isArray(annualRevenueRows) ? annualRevenueRows : []) {
    const date = String(row.date || '').slice(0, 10);
    const revenue = parseFinancialNumber(row.sales);
    if (date && Number.isFinite(revenue) && revenue > 0) revenueByDate.set(date, revenue);
  }

  const annualByDate = new Map();
  for (const row of Array.isArray(annualCashFlowRows) ? annualCashFlowRows : []) {
    const date = String(row.date || '').slice(0, 10);
    const revenue = revenueByDate.get(date);
    const operatingCashFlow = parseFinancialNumber(row.operating_cash_flow);
    const capexRaw = parseFinancialNumber(row.capital_expenditures);
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

  return [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
