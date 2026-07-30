import { percentageChange, toFiniteNumber } from '../utils/math.js';

function sortByFiscalYear(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])]
    .filter(row => Number.isFinite(Number(row?.fiscalYear)))
    .sort((a, b) => Number(a.fiscalYear) - Number(b.fiscalYear));
}

function compactSummary(summary = {}) {
  const readPercentage = value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const percentage = toFiniteNumber(value?.percentage);
    return percentage;
  };

  return {
    oneYear: readPercentage(summary.oneYear),
    threeYears: readPercentage(summary.threeYears),
    fiveYears: readPercentage(summary.fiveYears),
    tenYears: readPercentage(summary.tenYears)
  };
}

export function buildAnnualRevenueHistory(annualSeries = []) {
  const rows = sortByFiscalYear(annualSeries);

  return rows.map((row, index) => {
    const revenue = toFiniteNumber(row?.revenue ?? row?.value);
    const previousRevenue = index > 0
      ? toFiniteNumber(rows[index - 1]?.revenue ?? rows[index - 1]?.value)
      : null;

    return {
      fiscalYear: Number(row.fiscalYear),
      date: row.date || null,
      revenue,
      revenueBillions: revenue === null ? null : revenue / 1e9,
      growthPercentage: previousRevenue === null
        ? null
        : percentageChange(previousRevenue, revenue),
      source: row.source || null
    };
  });
}

export function buildAnnualNetMarginHistory(annualSeries = []) {
  return sortByFiscalYear(annualSeries).map(row => {
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
      marginPercentage: suppliedMargin ?? (
        revenue !== null && revenue !== 0 && netIncome !== null
          ? (netIncome / revenue) * 100
          : null
      )
    };
  });
}

export function buildAnnualFcfMarginHistory(annualSeries = []) {
  return sortByFiscalYear(annualSeries).map(row => {
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
      marginPercentage: suppliedMargin ?? (
        revenue !== null && revenue !== 0 && freeCashFlow !== null
          ? (freeCashFlow / revenue) * 100
          : null
      )
    };
  });
}


function growthSummaryFromAnnual(rows = [], valueKey) {
  const clean = sortByFiscalYear(rows)
    .map(row => ({ fiscalYear: Number(row.fiscalYear), value: toFiniteNumber(row?.[valueKey]) }))
    .filter(row => Number.isFinite(row.fiscalYear) && row.value !== null);

  if (clean.length < 2) {
    return { oneYear: null, threeYears: null, fiveYears: null, tenYears: null };
  }

  const latest = clean.at(-1);
  const byYear = new Map(clean.map(row => [row.fiscalYear, row.value]));

  const calculate = years => {
    const previous = byYear.get(latest.fiscalYear - years);
    if (previous === undefined || previous === 0 || latest.value === 0) return null;
    if (years === 1) return percentageChange(previous, latest.value);
    if (previous < 0 || latest.value < 0) return null;
    return (Math.pow(latest.value / previous, 1 / years) - 1) * 100;
  };

  return {
    oneYear: calculate(1),
    threeYears: calculate(3),
    fiveYears: calculate(5),
    tenYears: calculate(10)
  };
}


function buildQuarterlyGrowth(rows = [], valueKey) {
  const clean = [...(Array.isArray(rows) ? rows : [])]
    .map(row => ({ ...row, date: String(row?.date || '').slice(0, 10), value: toFiniteNumber(row?.[valueKey]) }))
    .filter(row => row.date && row.value !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  return clean.map((row, index) => {
    const priorYear = index >= 4 ? clean[index - 4].value : null;
    return {
      ...row,
      growthPercentage: priorYear === null || priorYear === 0 ? null : percentageChange(priorYear, row.value)
    };
  });
}
export function buildHistoricalCalculatorData({
  revenueHistory,
  netMarginHistory,
  fcfMarginHistory,
  returnsHistory
} = {}) {
  const revenueAnnual = buildAnnualRevenueHistory(revenueHistory?.annualSeries).slice(-15);
  const revenueQuarterly = buildQuarterlyGrowth(revenueHistory?.quarterlySeries, 'revenue').map(row => ({ ...row, revenueBillions: row.value / 1e9 })).slice(-48);
  const netMarginAnnual = buildAnnualNetMarginHistory(netMarginHistory?.annualSeries).slice(-15);
  const netMarginQuarterly = buildQuarterlyGrowth(netMarginHistory?.quarterlySeries, 'netIncome').map(row => ({
    ...row,
    revenue: toFiniteNumber(row.revenue),
    revenueBillions: toFiniteNumber(row.revenueBillions),
    netIncome: toFiniteNumber(row.netIncome),
    netIncomeBillions: toFiniteNumber(row.netIncomeBillions),
    marginPercentage: toFiniteNumber(row.netMarginPercentage)
  })).slice(-48);
  const fcfMarginAnnual = buildAnnualFcfMarginHistory(fcfMarginHistory?.annualSeries).slice(-15);
  const roicAnnual = sortByFiscalYear(returnsHistory?.annualSeries)
    .map(row => ({
      fiscalYear: Number(row.fiscalYear),
      date: row.date || null,
      roicPercentage: toFiniteNumber(row.roicPercentage),
      netIncome: toFiniteNumber(row.netIncome),
      investedCapital: toFiniteNumber(row.investedCapital),
      equity: toFiniteNumber(row.equity),
      finvizStyleLongTermDebt: toFiniteNumber(row.finvizStyleLongTermDebt),
      operatingLeaseLiabilitiesNonCurrent: toFiniteNumber(row.operatingLeaseLiabilitiesNonCurrent)
    }))
    .filter(row => row.roicPercentage !== null)
    .slice(-15);
  const returnAverages = returnsHistory?.summary?.averages?.roic || {};
  const roicSummary = {
    oneYear: toFiniteNumber(returnsHistory?.summary?.latest?.roicPercentage),
    threeYears: toFiniteNumber(returnAverages?.threeYears?.percentage),
    fiveYears: toFiniteNumber(returnAverages?.fiveYears?.percentage),
    tenYears: toFiniteNumber(returnAverages?.tenYears?.percentage)
  };

  return {
    revenueGrowth: {
      label: 'Revenue Growth',
      summary: compactSummary(revenueHistory?.historicalRevenueGrowth),
      annual: revenueAnnual,
      quarterly: revenueQuarterly
    },
    netIncomeGrowth: {
      label: 'Net Income Growth',
      summary: growthSummaryFromAnnual(netMarginAnnual, 'netIncome'),
      annual: netMarginAnnual.map((row, index, rows) => ({
        ...row,
        growthPercentage: index === 0 ? null : percentageChange(rows[index - 1].netIncome, row.netIncome)
      })),
      quarterly: netMarginQuarterly
    },
    freeCashFlowGrowth: {
      label: 'Free Cash Flow Growth',
      summary: growthSummaryFromAnnual(fcfMarginAnnual, 'freeCashFlow'),
      annual: fcfMarginAnnual.map((row, index, rows) => ({
        ...row,
        growthPercentage: index === 0 ? null : percentageChange(rows[index - 1].freeCashFlow, row.freeCashFlow)
      }))
    },
    netMargin: {
      label: 'Net Margin',
      summary: compactSummary(netMarginHistory?.historicalNetMargins),
      annual: netMarginAnnual,
      quarterly: netMarginQuarterly
    },
    fcfMargin: {
      label: 'FCF Margin',
      summary: compactSummary(fcfMarginHistory?.historicalFcfMargins),
      annual: fcfMarginAnnual
    },
    roic: {
      label: 'ROIC',
      summary: roicSummary,
      annual: roicAnnual
    }
  };
}
