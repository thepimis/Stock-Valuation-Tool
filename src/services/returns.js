// Return-on-capital calculations.
// ROIC follows the reverse-engineered Finviz convention:
//   net income / (common equity + long-term debt + non-current operating leases)
// Finviz normalises statement classifications internally, so calculated values
// should be treated as estimates and may differ by approximately +/- 5%.

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(current, previous) {
  const a = finite(current);
  const b = finite(previous);
  if (a !== null && b !== null) return (a + b) / 2;
  return a;
}

function percentage(numerator, denominator) {
  const top = finite(numerator);
  const bottom = finite(denominator);
  return top !== null && bottom !== null && bottom !== 0 ? (top / bottom) * 100 : null;
}

function averagePercentage(rows, key, years) {
  const values = rows
    .slice(-years)
    .map(row => finite(row[key]))
    .filter(value => value !== null);

  return {
    percentage: values.length === years
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null,
    requestedYears: years,
    availableYears: values.length,
    firstFiscalYear: values.length === years ? rows.slice(-years)[0]?.fiscalYear ?? null : null,
    latestFiscalYear: values.length === years ? rows.at(-1)?.fiscalYear ?? null : null
  };
}

function deriveNonCurrentOperatingLeases(row = {}) {
  const supplied = finite(row.operatingLeaseLiabilitiesNonCurrent);
  if (supplied !== null) return Math.max(0, supplied);

  const totalLiabilities = finite(row.totalLiabilities);
  const currentLiabilities = finite(row.currentLiabilities);
  const longTermDebt = finite(row.longTermDebt);
  const otherNonCurrentLiabilities = finite(row.otherNonCurrentLiabilities);

  if ([totalLiabilities, currentLiabilities, longTermDebt, otherNonCurrentLiabilities]
    .some(value => value === null)) return 0;

  return Math.max(0,
    totalLiabilities
    - currentLiabilities
    - longTermDebt
    - otherNonCurrentLiabilities
  );
}

function finvizInvestedCapital(row = {}) {
  const equity = finite(row.equity);
  const longTermDebt = finite(row.longTermDebt);
  if (equity === null || longTermDebt === null) return null;
  return equity + longTermDebt + deriveNonCurrentOperatingLeases(row);
}

export function calculateFinvizRoicSnapshot(row = {}) {
  const netIncome = finite(row.netIncome);
  const operatingLeaseLiabilitiesNonCurrent = deriveNonCurrentOperatingLeases(row);
  const investedCapital = finvizInvestedCapital(row);

  return {
    netIncome,
    equity: finite(row.equity),
    longTermDebt: finite(row.longTermDebt),
    operatingLeaseLiabilitiesNonCurrent,
    finvizStyleLongTermDebt: finite(row.longTermDebt) === null
      ? null
      : finite(row.longTermDebt) + operatingLeaseLiabilitiesNonCurrent,
    investedCapital,
    roicPercentage: percentage(netIncome, investedCapital)
  };
}

export function calculateReturnSeries(annualRows = []) {
  const sorted = [...annualRows]
    .filter(row => Number.isFinite(Number(row?.fiscalYear)))
    .sort((a, b) => Number(a.fiscalYear) - Number(b.fiscalYear));

  return sorted.map((row, index) => {
    const previous = sorted[index - 1] || null;
    const finviz = calculateFinvizRoicSnapshot(row);
    const operatingIncome = finite(row.operatingIncome);

    const capitalEmployed = finite(row.totalAssets) !== null && finite(row.currentLiabilities) !== null
      ? finite(row.totalAssets) - finite(row.currentLiabilities)
      : (finite(row.equity) !== null && finite(row.totalDebt) !== null
        ? finite(row.equity) + finite(row.totalDebt)
        : null);

    const averageEquity = average(row.equity, previous?.equity);
    const averageAssets = average(row.totalAssets, previous?.totalAssets);
    const previousCapitalEmployed = previous
      ? (finite(previous.totalAssets) !== null && finite(previous.currentLiabilities) !== null
        ? finite(previous.totalAssets) - finite(previous.currentLiabilities)
        : null)
      : null;
    const averageCapitalEmployed = average(capitalEmployed, previousCapitalEmployed);

    return {
      fiscalYear: Number(row.fiscalYear),
      date: row.date || null,
      methodology: 'Finviz-style',
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
      netDebt: finite(row.totalDebt) !== null && finite(row.cash) !== null
        ? finite(row.totalDebt) - finite(row.cash)
        : null,
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

export function summariseReturns(series = [], currentSnapshot = null) {
  const usable = Array.isArray(series) ? series : [];
  const latestAnnual = usable.at(-1) || null;
  const current = currentSnapshot && Number.isFinite(Number(currentSnapshot.roicPercentage))
    ? currentSnapshot
    : latestAnnual;

  const averagesFor = key => ({
    threeYears: averagePercentage(usable, key, 3),
    fiveYears: averagePercentage(usable, key, 5),
    tenYears: averagePercentage(usable, key, 10)
  });

  return {
    latest: current ? {
      fiscalYear: current.fiscalYear ?? null,
      date: current.date ?? null,
      period: current.period ?? (current === latestAnnual ? 'FY' : 'TTM'),
      roicPercentage: current.roicPercentage,
      roePercentage: current.roePercentage ?? latestAnnual?.roePercentage ?? null,
      roaPercentage: current.roaPercentage ?? latestAnnual?.roaPercentage ?? null,
      rocePercentage: current.rocePercentage ?? latestAnnual?.rocePercentage ?? null,
      netIncome: current.netIncome ?? null,
      investedCapital: current.investedCapital ?? null,
      equity: current.equity ?? null,
      finvizStyleLongTermDebt: current.finvizStyleLongTermDebt ?? null,
      operatingLeaseLiabilitiesNonCurrent: current.operatingLeaseLiabilitiesNonCurrent ?? null,
      warning: 'Finviz-style ROIC is an estimate; an error of +/- 5% is possible.'
    } : null,
    latestAnnual,
    averages: {
      roic: averagesFor('roicPercentage'),
      roe: averagesFor('roePercentage'),
      roa: averagesFor('roaPercentage'),
      roce: averagesFor('rocePercentage')
    }
  };
}
