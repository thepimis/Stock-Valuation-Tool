export const COMPANY_SNAPSHOT_SCHEMA = 'stock-platform.company-snapshot';
export const COMPANY_SNAPSHOT_VERSION = 2;

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildCompanySnapshot({ ticker, company, financials, dashboard, returns, growth, history, generatedAt = new Date().toISOString() }) {
  const symbol = String(ticker || company?.ticker || history?.ticker || '').trim().toUpperCase();
  if (!symbol) throw new Error('Snapshot ticker is required.');

  return {
    meta: {
      schema: COMPANY_SNAPSHOT_SCHEMA,
      version: COMPANY_SNAPSHOT_VERSION,
      ticker: symbol,
      generatedAt,
      sourceVersion: company?.version || history?.version || null,
      sourceCommitRef: company?.source?.commitRef || null
    },
    identity: {
      ticker: symbol,
      companyName: company?.companyName || symbol,
      exchange: company?.exchange || null,
      currency: company?.currency || 'USD'
    },
    financials: {
      ttm: {
        revenue: finiteOrNull(company?.revenueTtm),
        netIncome: finiteOrNull(company?.netIncomeTtm),
        freeCashFlow: finiteOrNull(company?.freeCashFlowTtm)
      },
      balanceSheet: {
        cash: finiteOrNull(company?.cash),
        totalDebt: finiteOrNull(company?.totalDebt),
        sharesOutstanding: finiteOrNull(company?.sharesOutstanding)
      },
      asOf: {
        balanceSheet: company?.asOf?.balanceSheet || null,
        incomeQuarters: Array.isArray(company?.asOf?.incomeQuarters) ? company.asOf.incomeQuarters : [],
        cashFlow: company?.asOf?.cashFlow || null
      }
    },
    metrics: {
      roic: finiteOrNull(company?.roic),
      roicFiscalYear: finiteOrNull(company?.roicFiscalYear)
    },
    prepared: {
      company: company || null,
      financials: financials || null,
      dashboard: dashboard || null,
      returns: returns || null,
      growth: growth || null,
      history: history || null
    },
    history: {
      metrics: history?.metrics || {},
      availability: history?.availability || {}
    },
    live: {
      fields: ['price', 'marketCap', 'enterpriseValue'],
      price: null,
      marketCap: null,
      enterpriseValue: null
    },
    methodology: {
      company: 'company-overview-v1',
      history: 'historical-metrics-v1',
      roic: 'finviz-style-roic-v1'
    },
    quality: {
      availability: {
        revenueTtm: Boolean(company?.availability?.revenueTtm),
        netIncomeTtm: Boolean(company?.availability?.netIncomeTtm),
        freeCashFlowTtm: Boolean(company?.availability?.freeCashFlowTtm),
        totalDebt: Boolean(company?.availability?.totalDebt),
        sharesOutstanding: Boolean(company?.availability?.sharesOutstanding),
        roic: Boolean(company?.availability?.roic)
      },
      fields: company?.fields || {}
    },
    sources: ['dolthub-earnings', 'yahoo-finance']
  };
}

export function validateCompanySnapshot(snapshot) {
  const errors = [];
  if (snapshot?.meta?.schema !== COMPANY_SNAPSHOT_SCHEMA) errors.push('Invalid snapshot schema.');
  if (snapshot?.meta?.version !== COMPANY_SNAPSHOT_VERSION) errors.push('Unsupported snapshot version.');
  if (!/^[A-Z0-9._-]{1,40}$/.test(snapshot?.identity?.ticker || '')) errors.push('Invalid ticker.');
  if (!snapshot?.identity?.companyName) errors.push('Company name is required.');
  if (!snapshot?.history?.metrics || typeof snapshot.history.metrics !== 'object') errors.push('History metrics are required.');
  if (!snapshot?.prepared?.company) errors.push('Prepared company response is required.');
  if (!snapshot?.prepared?.financials) errors.push('Prepared financials response is required.');
  if (!snapshot?.prepared?.history) errors.push('Prepared history response is required.');
  return { ok: errors.length === 0, errors };
}
