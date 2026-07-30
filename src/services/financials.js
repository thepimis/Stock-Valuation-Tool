// Pure financial calculation helpers.
// These functions do not fetch data and do not depend on Cloudflare APIs.

function parseFinancialNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(String(value).replace(/,/g, ''));
}

export function calculateTtmRevenue(quarterlyRows = []) {
  const latestFour = Array.isArray(quarterlyRows) ? quarterlyRows.slice(0, 4) : [];
  return latestFour.reduce((sum, row) => {
    const revenue = parseFinancialNumber(row?.sales);
    return sum + (Number.isFinite(revenue) ? revenue : 0);
  }, 0);
}

export function buildRevenueSeries(quarterlyRows = [], annualRows = []) {
  const quarterlyByDate = new Map();
  for (const row of quarterlyRows) {
    const date = String(row.date || '').slice(0, 10);
    const sales = parseFinancialNumber(row.sales);
    if (!date || !Number.isFinite(sales) || sales <= 0) continue;
    quarterlyByDate.set(date, { date, sales });
  }
  const quarters = [...quarterlyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const ttmSeries = [];
  for (let i = 3; i < quarters.length; i += 1) {
    const window = quarters.slice(i - 3, i + 1);
    const revenue = window.reduce((sum, item) => sum + item.sales, 0);
    ttmSeries.push({ endDate: quarters[i].date, revenue, revenueBillions: revenue / 1e9, quarterDates: window.map(item => item.date) });
  }
  const annualByDate = new Map();
  for (const row of annualRows) {
    const date = String(row.date || '').slice(0, 10);
    const sales = parseFinancialNumber(row.sales);
    if (!date || !Number.isFinite(sales) || sales <= 0) continue;
    annualByDate.set(date, { date, fiscalYear: Number(date.slice(0, 4)), revenue: sales, revenueBillions: sales / 1e9 });
  }
  const reportedAnnualSeries = [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const fiscalYearEndMonthDay = String(reportedAnnualSeries.at(-1)?.date || '').slice(5) || null;
  let reconstructedAnnualYears = 0;
  if (fiscalYearEndMonthDay) {
    for (const point of ttmSeries) {
      const endDate = String(point?.endDate || '').slice(0, 10);
      if (!endDate || endDate.slice(5) !== fiscalYearEndMonthDay || annualByDate.has(endDate)) continue;
      annualByDate.set(endDate, { date: endDate, fiscalYear: Number(endDate.slice(0, 4)), revenue: point.revenue, revenueBillions: point.revenueBillions, source: 'reconstructed from four quarterly revenue rows', quarterDates: Array.isArray(point.quarterDates) ? point.quarterDates : [] });
      reconstructedAnnualYears += 1;
    }
  }
  return { quarters, ttmSeries, reportedAnnualSeries, annualSeries: [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date)), reconstructedAnnualYears };
}

export function ttmGrowthAgainstOneYearAgo(series, latest) {
  const latestEndDate = String(latest?.endDate || '').slice(0, 10);
  if (!latestEndDate) return null;
  const target = new Date(`${latestEndDate}T00:00:00Z`);
  target.setUTCFullYear(target.getUTCFullYear() - 1);
  let comparison = null;
  let smallestDistance = Infinity;
  for (const point of series) {
    const pointEndDate = String(point?.endDate || '').slice(0, 10);
    if (!pointEndDate || pointEndDate === latestEndDate) continue;
    const distance = Math.abs(new Date(`${pointEndDate}T00:00:00Z`).getTime() - target.getTime());
    if (distance < smallestDistance) { smallestDistance = distance; comparison = point; }
  }
  if (!comparison || comparison.revenue <= 0) return null;
  return { method: 'year-over-year TTM growth', percentage: (latest.revenue / comparison.revenue - 1) * 100, latestEndDate, comparisonEndDate: String(comparison?.endDate || '').slice(0, 10) || null, latestRevenueBillions: latest.revenueBillions, comparisonRevenueBillions: comparison.revenueBillions };
}

export function fiscalYearCagr(series, latest, years) {
  const targetFiscalYear = latest.fiscalYear - years;
  const comparison = series.find(point => point.fiscalYear === targetFiscalYear);
  if (!comparison || comparison.revenue <= 0) return { method: 'fiscal-year CAGR', percentage: null, years, latestFiscalYear: latest.fiscalYear, requestedComparisonFiscalYear: targetFiscalYear, error: `No fiscal-year revenue row found for ${targetFiscalYear}.` };
  return { method: 'fiscal-year CAGR', percentage: (Math.pow(latest.revenue / comparison.revenue, 1 / years) - 1) * 100, years, latestFiscalYear: latest.fiscalYear, comparisonFiscalYear: comparison.fiscalYear, latestDate: latest.date, comparisonDate: comparison.date, latestRevenueBillions: latest.revenueBillions, comparisonRevenueBillions: comparison.revenueBillions };
}

export function buildNetMarginSeries(quarterlyRows = [], annualRows = []) {
  const quarterlyByDate = new Map();
  for (const row of quarterlyRows) {
    const date = String(row.date || '').slice(0, 10);
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
    ttmSeries.push({ endDate: quarters[i].date, revenue, revenueBillions: revenue / 1e9, netIncome, netIncomeBillions: netIncome / 1e9, netMarginPercentage: revenue > 0 ? (netIncome / revenue) * 100 : null, quarterDates: window.map(row => row.date) });
  }
  const annualByDate = new Map();
  for (const row of annualRows) {
    const date = String(row.date || '').slice(0, 10);
    const revenue = parseFinancialNumber(row.sales);
    const netIncome = parseFinancialNumber(row.net_income);
    if (!date || !Number.isFinite(revenue) || revenue <= 0 || !Number.isFinite(netIncome)) continue;
    annualByDate.set(date, { date, fiscalYear: Number(date.slice(0, 4)), revenue, revenueBillions: revenue / 1e9, netIncome, netIncomeBillions: netIncome / 1e9, netMarginPercentage: (netIncome / revenue) * 100 });
  }
  return { quarters, ttmSeries, annualSeries: [...annualByDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function calculateWeightedNetMargin(series, years) {
  const selectedRows = series.slice(-years);
  if (selectedRows.length < years) return { method: 'weighted fiscal-year net margin', percentage: null, requestedYears: years, availableYears: selectedRows.length, error: `Only ${selectedRows.length} fiscal years are available.` };
  const totalRevenue = selectedRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalNetIncome = selectedRows.reduce((sum, row) => sum + row.netIncome, 0);
  return { method: 'weighted fiscal-year net margin', percentage: totalRevenue > 0 ? (totalNetIncome / totalRevenue) * 100 : null, years, firstFiscalYear: selectedRows[0].fiscalYear, latestFiscalYear: selectedRows.at(-1).fiscalYear, totalRevenue, totalRevenueBillions: totalRevenue / 1e9, totalNetIncome, totalNetIncomeBillions: totalNetIncome / 1e9, rowsUsed: selectedRows };
}

export function calculateWeightedFcfMargin(series, years) {
  const selectedRows = series.slice(-years);
  if (selectedRows.length < years) return { method: 'weighted fiscal-year FCF margin', percentage: null, requestedYears: years, availableYears: selectedRows.length, error: `Only ${selectedRows.length} fiscal years are available.` };
  const totalRevenue = selectedRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalFreeCashFlow = selectedRows.reduce((sum, row) => sum + row.freeCashFlow, 0);
  return { method: 'weighted fiscal-year FCF margin', percentage: totalRevenue > 0 ? (totalFreeCashFlow / totalRevenue) * 100 : null, years, firstFiscalYear: selectedRows[0].fiscalYear, latestFiscalYear: selectedRows.at(-1).fiscalYear, totalRevenue, totalRevenueBillions: totalRevenue / 1e9, totalFreeCashFlow, totalFreeCashFlowBillions: totalFreeCashFlow / 1e9, rowsUsed: selectedRows };
}
