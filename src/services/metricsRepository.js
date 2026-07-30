const DEFAULT_HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;

function hasD1(env) {
  return Boolean(env?.METRICS_DB && typeof env.METRICS_DB.prepare === 'function');
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function readHistoricalPayload(env, ticker, { allowStale = false } = {}) {
  if (!hasD1(env)) return { hit: false, reason: 'D1_NOT_CONFIGURED' };

  const row = await env.METRICS_DB.prepare(`
    SELECT payload_json, updated_at, expires_at
    FROM company_history_cache
    WHERE ticker = ?1
    LIMIT 1
  `).bind(ticker).first();

  if (!row?.payload_json) return { hit: false, reason: 'NOT_FOUND' };

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(row.expires_at);
  const stale = !Number.isFinite(expiresAt) || expiresAt <= now;
  if (stale && !allowStale) return { hit: false, reason: 'STALE', stale: true };

  const payload = safeJsonParse(row.payload_json);
  if (!payload) return { hit: false, reason: 'INVALID_JSON' };

  return {
    hit: true,
    stale,
    updatedAt: row.updated_at || null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    payload
  };
}

function metricRowsFromHistory(ticker, history) {
  const metrics = history?.metrics || {};
  const rows = [];
  const pushRows = (metric, frequency, sourceRows, mapper) => {
    for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
      const mapped = mapper(row);
      if (!mapped?.periodEnd) continue;
      rows.push({
        ticker,
        periodEnd: mapped.periodEnd,
        frequency,
        metric,
        value: mapped.value ?? null,
        revenue: mapped.revenue ?? null,
        netIncome: mapped.netIncome ?? null,
        freeCashFlow: mapped.freeCashFlow ?? null,
        marginPercentage: mapped.marginPercentage ?? null,
        growthPercentage: mapped.growthPercentage ?? null,
        roicPercentage: mapped.roicPercentage ?? null
      });
    }
  };

  const annualDate = row => String(row?.date || (row?.fiscalYear ? `${row.fiscalYear}-12-31` : '')).slice(0, 10);
  const quarterDate = row => String(row?.date || '').slice(0, 10);

  pushRows('revenue', 'annual', metrics.revenueGrowth?.annual, row => ({
    periodEnd: annualDate(row), value: row.revenue, revenue: row.revenue, growthPercentage: row.growthPercentage
  }));
  pushRows('revenue', 'quarterly', metrics.revenueGrowth?.quarterly, row => ({
    periodEnd: quarterDate(row), value: row.revenue ?? row.value, revenue: row.revenue ?? row.value, growthPercentage: row.growthPercentage
  }));
  pushRows('net_income', 'annual', metrics.netIncomeGrowth?.annual, row => ({
    periodEnd: annualDate(row), value: row.netIncome, revenue: row.revenue, netIncome: row.netIncome, marginPercentage: row.marginPercentage, growthPercentage: row.growthPercentage
  }));
  pushRows('net_income', 'quarterly', metrics.netIncomeGrowth?.quarterly, row => ({
    periodEnd: quarterDate(row), value: row.netIncome ?? row.value, revenue: row.revenue, netIncome: row.netIncome ?? row.value, marginPercentage: row.marginPercentage, growthPercentage: row.growthPercentage
  }));
  pushRows('free_cash_flow', 'annual', metrics.freeCashFlowGrowth?.annual, row => ({
    periodEnd: annualDate(row), value: row.freeCashFlow, revenue: row.revenue, freeCashFlow: row.freeCashFlow, marginPercentage: row.marginPercentage, growthPercentage: row.growthPercentage
  }));
  pushRows('roic', 'annual', metrics.roic?.annual, row => ({
    periodEnd: annualDate(row), value: row.roicPercentage, netIncome: row.netIncome, roicPercentage: row.roicPercentage
  }));

  return rows;
}

export async function writeHistoricalPayload(env, ticker, history, { ttlSeconds = DEFAULT_HISTORY_TTL_SECONDS } = {}) {
  if (!hasD1(env)) return { saved: false, reason: 'D1_NOT_CONFIGURED' };

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const payloadJson = JSON.stringify(history);
  const metricRows = metricRowsFromHistory(ticker, history);

  const statements = [
    env.METRICS_DB.prepare(`
      INSERT INTO company_history_cache (ticker, payload_json, updated_at, expires_at)
      VALUES (?1, ?2, datetime('now'), ?3)
      ON CONFLICT(ticker) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).bind(ticker, payloadJson, expiresAt),
    env.METRICS_DB.prepare('DELETE FROM company_metrics WHERE ticker = ?1').bind(ticker)
  ];

  for (const row of metricRows) {
    statements.push(env.METRICS_DB.prepare(`
      INSERT INTO company_metrics (
        ticker, period_end, frequency, metric, value,
        revenue, net_income, free_cash_flow,
        margin_percentage, growth_percentage, roic_percentage, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
      ON CONFLICT(ticker, period_end, frequency, metric) DO UPDATE SET
        value = excluded.value,
        revenue = excluded.revenue,
        net_income = excluded.net_income,
        free_cash_flow = excluded.free_cash_flow,
        margin_percentage = excluded.margin_percentage,
        growth_percentage = excluded.growth_percentage,
        roic_percentage = excluded.roic_percentage,
        updated_at = excluded.updated_at
    `).bind(
      row.ticker, row.periodEnd, row.frequency, row.metric, row.value,
      row.revenue, row.netIncome, row.freeCashFlow,
      row.marginPercentage, row.growthPercentage, row.roicPercentage
    ));
  }

  await env.METRICS_DB.batch(statements);
  return { saved: true, rows: metricRows.length, expiresAt };
}
