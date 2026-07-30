const DOLT_BASE = 'https://www.dolthub.com/api/v1alpha1/post-no-preference/earnings';

const DOLT_TICKER_ALIASES = {
  META: ['META', 'FB']
};

export async function runDoltQuery(sql) {
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
    throw createDoltError(502, `DoltHub returned non-JSON: ${text.slice(0, 180)}`);
  }

  if (!response.ok || body.query_execution_status === 'Error') {
    const message =
      body.query_execution_message ||
      body.error ||
      response.statusText ||
      'DoltHub query failed';

    throw createDoltError(response.status || 502, message, { sql, body });
  }

  return body;
}

export function doltTickerPredicate(ticker, column = 'act_symbol') {
  const symbols = getDoltTickerSymbols(ticker);

  if (symbols.length === 1) {
    return `${column} = ${sqlString(symbols[0])}`;
  }

  return `${column} IN (${symbols.map(sqlString).join(', ')})`;
}

function getDoltTickerSymbols(ticker) {
  const current = String(ticker || '').toUpperCase();
  const aliases = DOLT_TICKER_ALIASES[current] || [current];

  return [...new Set(aliases.map(symbol => String(symbol).toUpperCase()))];
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDoltError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}
