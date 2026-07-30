// Generic numeric helpers shared by financial-analysis services.

export function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function percentageChange(startValue, endValue) {
  const start = toFiniteNumber(startValue);
  const end = toFiniteNumber(endValue);
  if (start === null || end === null || start === 0) return null;
  return ((end - start) / Math.abs(start)) * 100;
}

export function calculateCagr(startValue, endValue, years) {
  const start = toFiniteNumber(startValue);
  const end = toFiniteNumber(endValue);
  const periodYears = Number(years);

  if (start === null || end === null || !Number.isFinite(periodYears) || periodYears <= 0) {
    return { percentage: null, available: false, reason: 'Missing value or invalid period.' };
  }
  if (start <= 0 || end <= 0) {
    return {
      percentage: null,
      available: false,
      reason: 'CAGR requires positive starting and ending values.',
      totalChangePercentage: percentageChange(start, end)
    };
  }

  return {
    percentage: (Math.pow(end / start, 1 / periodYears) - 1) * 100,
    available: true,
    reason: null,
    totalChangePercentage: percentageChange(start, end)
  };
}
