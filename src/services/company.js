// Company overview assembly helpers.
// This module is intentionally fetch-agnostic so providers can be changed later.

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildCompanyOverview({
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
  const enterpriseValue = marketCap !== null
    ? marketCap + (finiteOrNull(totalDebt) ?? 0) - (finiteOrNull(cash) ?? 0)
    : null;

  return {
    ticker,
    companyName: quote?.companyName || quote?.longName || quote?.shortName || ticker,
    exchange: quote?.exchangeLabel || quote?.exchangeCode || null,
    currency: quote?.currency || 'USD',
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
      marketCap: 'Current Yahoo price multiplied by the latest reported shares outstanding.',
      enterpriseValue: 'Market capitalisation plus total debt minus cash and short-term investments.',
      revenueTtm: 'Sum of the latest four reported quarterly revenue values.',
      netIncomeTtm: 'Sum of the latest four reported quarterly net-income values.',
      freeCashFlowTtm: 'Yahoo trailing operating cash flow minus the absolute value of trailing capital expenditures.'
    }
  };
}
