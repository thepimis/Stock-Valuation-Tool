import { calculateCagr, percentageChange, toFiniteNumber } from '../utils/math.js';

function normaliseSeries(series = []) {
  const byYear = new Map();
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

function nearestComparison(series, latest, years) {
  const requestedFiscalYear = latest.fiscalYear - years;
  const exact = series.find(row => row.fiscalYear === requestedFiscalYear);
  return { requestedFiscalYear, comparison: exact || null };
}

export function calculateGrowthForPeriod(series = [], years = 1, options = {}) {
  const metric = options.metric || 'metric';
  const method = years === 1 ? 'fiscal-year growth' : 'fiscal-year CAGR';
  const normalised = normaliseSeries(series);
  const latest = normalised.at(-1) || null;

  if (!latest) {
    return { metric, method, years, percentage: null, available: false, reason: 'No usable annual values.' };
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
    const percentage = percentageChange(comparison.value, latest.value);
    return {
      metric,
      method,
      years,
      percentage,
      available: percentage !== null,
      latestFiscalYear: latest.fiscalYear,
      comparisonFiscalYear: comparison.fiscalYear,
      latestDate: latest.date,
      comparisonDate: comparison.date,
      latestValue: latest.value,
      comparisonValue: comparison.value,
      reason: percentage === null ? 'Growth requires a non-zero comparison value.' : null
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

export function summariseGrowthSeries(series = [], options = {}) {
  return {
    oneYear: calculateGrowthForPeriod(series, 1, options),
    threeYears: calculateGrowthForPeriod(series, 3, options),
    fiveYears: calculateGrowthForPeriod(series, 5, options),
    tenYears: calculateGrowthForPeriod(series, 10, options)
  };
}

export function buildGrowthAnalysis(metricSeries = {}) {
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
