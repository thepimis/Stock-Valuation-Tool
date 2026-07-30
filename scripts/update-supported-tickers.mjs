import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runDoltQuery } from '../src/providers/dolt.js';

const OUTPUT_PATH = resolve(process.argv[2] || 'data/supported-tickers.json');
const CHECKPOINT_PATH = `${OUTPUT_PATH}.checkpoint.json`;
const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';
const DOLT_BATCH_SIZE = positiveInteger(process.env.UNIVERSE_DOLT_BATCH_SIZE, 40);
const DOLT_CONCURRENCY = positiveInteger(process.env.UNIVERSE_DOLT_CONCURRENCY, 2);
const RETRY_ATTEMPTS = positiveInteger(process.env.UNIVERSE_DOLT_RETRIES, 3);

await mkdir(resolve(OUTPUT_PATH, '..'), { recursive: true });

console.log('Downloading official US exchange listings...');
const [nasdaqText, otherText] = await Promise.all([
  fetchText(NASDAQ_LISTED_URL),
  fetchText(OTHER_LISTED_URL)
]);

const listed = deduplicateListings([
  ...parseNasdaqListed(nasdaqText),
  ...parseOtherListed(otherText)
]);
const eligible = listed.filter(isSupportedSecurity);

console.log(`Exchange-listed rows: ${listed.length}`);
console.log(`Eligible common-stock candidates: ${eligible.length}`);
console.log(`Checking Dolt annual financial availability in batches of ${DOLT_BATCH_SIZE}...`);

const checkpoint = await loadCheckpoint(CHECKPOINT_PATH);
const checked = new Set(checkpoint.checked || []);
const available = new Set(checkpoint.available || []);
const remaining = eligible.map(row => row.ticker).filter(ticker => !checked.has(ticker));

if (checked.size) {
  console.log(`Resuming checkpoint: ${checked.size} checked; ${available.size} available.`);
}

let completedThisRun = 0;
let checkpointWriteChain = Promise.resolve();
const batches = chunk(remaining, DOLT_BATCH_SIZE);
await mapWithConcurrency(batches, DOLT_CONCURRENCY, async batch => {
  const found = await fetchAvailableDoltTickers(batch);
  for (const ticker of batch) checked.add(ticker);
  for (const ticker of found) available.add(ticker);
  completedThisRun += batch.length;

  checkpointWriteChain = checkpointWriteChain.then(() => atomicWrite(CHECKPOINT_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    checked: [...checked].sort(),
    available: [...available].sort()
  }, null, 2)}\n`));
  await checkpointWriteChain;

  const totalChecked = checked.size;
  const percent = eligible.length ? ((totalChecked / eligible.length) * 100).toFixed(1) : '100.0';
  console.log(`  Checked ${totalChecked}/${eligible.length} (${percent}%); Dolt matches: ${available.size}`);
});

const supported = eligible
  .filter(row => available.has(row.ticker))
  .sort((a, b) => a.ticker.localeCompare(b.ticker));

const excludedByListingRules = listed.length - eligible.length;
const missingFromDolt = eligible.length - supported.length;

const payload = {
  generatedAt: new Date().toISOString(),
  source: {
    listings: 'Nasdaq Trader Symbol Directory',
    financials: 'DoltHub post-no-preference/earnings'
  },
  rules: {
    exchanges: ['NASDAQ', 'NYSE', 'NYSE American'],
    activeOnly: true,
    etfs: false,
    testIssues: false,
    excludedSecurityTypes: [
      'preferred shares',
      'warrants',
      'rights',
      'units',
      'notes and debt securities',
      'funds and trusts'
    ],
    requiresDoltAnnualFinancials: true
  },
  counts: {
    exchangeListedRows: listed.length,
    excludedByListingRules,
    eligibleCommonStocks: eligible.length,
    missingFromDolt,
    supported: supported.length
  },
  companies: supported
};

await atomicWrite(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
await unlink(CHECKPOINT_PATH).catch(error => {
  if (error?.code !== 'ENOENT') throw error;
});

console.log(`Supported universe written to ${OUTPUT_PATH}`);
console.log(`  Excluded by security rules: ${excludedByListingRules}`);
console.log(`  Eligible but absent from Dolt: ${missingFromDolt}`);
console.log(`  Supported companies: ${supported.length}`);
console.log(`  Checked during this run: ${completedThisRun}`);

async function fetchAvailableDoltTickers(tickers) {
  if (!tickers.length) return [];

  try {
    return await retry(async () => {
      const sqlTickers = tickers.map(ticker => `'${escapeSql(ticker)}'`).join(', ');
      const sql = `SELECT DISTINCT act_symbol FROM income_statement WHERE period = 'Year' AND act_symbol IN (${sqlTickers})`;
      const result = await runDoltQuery(sql);
      return (Array.isArray(result.rows) ? result.rows : [])
        .map(row => normaliseTicker(row.act_symbol))
        .filter(Boolean);
    }, RETRY_ATTEMPTS);
  } catch (error) {
    // A smaller query is much less likely to hit Dolt's execution deadline.
    if (tickers.length > 1 && isRetryableDoltError(error)) {
      const middle = Math.ceil(tickers.length / 2);
      const left = await fetchAvailableDoltTickers(tickers.slice(0, middle));
      const right = await fetchAvailableDoltTickers(tickers.slice(middle));
      return [...new Set([...left, ...right])];
    }
    throw error;
  }
}

function isRetryableDoltError(error) {
  const text = `${error?.message || ''} ${JSON.stringify(error?.details || {})}`.toLowerCase();
  return text.includes('deadline') || text.includes('timeout') || text.includes('temporar') || text.includes('rate limit') || text.includes('429') || text.includes('502') || text.includes('503') || text.includes('504');
}

function deduplicateListings(rows) {
  const byTicker = new Map();
  for (const row of rows) {
    if (!row.ticker || byTicker.has(row.ticker)) continue;
    byTicker.set(row.ticker, row);
  }
  return [...byTicker.values()];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/plain,*/*',
      'User-Agent': 'stock-platform-universe-builder/1.1'
    }
  });
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  return response.text();
}

function parseNasdaqListed(text) {
  return parsePipeFile(text).map(row => ({
    ticker: normaliseTicker(row.Symbol),
    companyName: cleanName(row['Security Name']),
    exchange: 'NASDAQ',
    etf: row.ETF === 'Y',
    testIssue: row['Test Issue'] === 'Y'
  })).filter(row => row.ticker);
}

function parseOtherListed(text) {
  const exchangeNames = {
    N: 'NYSE',
    A: 'NYSE American',
    P: 'NYSE Arca',
    Z: 'Cboe BZX',
    V: 'IEX'
  };

  return parsePipeFile(text).map(row => ({
    ticker: normaliseTicker(row['ACT Symbol']),
    companyName: cleanName(row['Security Name']),
    exchange: exchangeNames[row.Exchange] || row.Exchange || 'Unknown',
    etf: row.ETF === 'Y',
    testIssue: row['Test Issue'] === 'Y'
  })).filter(row => row.ticker);
}

function parsePipeFile(text) {
  const lines = String(text).replaceAll('\r', '').split('\n').filter(Boolean);
  const headers = lines.shift()?.split('|') || [];

  return lines
    .filter(line => !line.startsWith('File Creation Time'))
    .map(line => {
      const values = line.split('|');
      return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    });
}

function isSupportedSecurity(row) {
  if (!['NASDAQ', 'NYSE', 'NYSE American'].includes(row.exchange)) return false;
  if (row.etf || row.testIssue) return false;

  const name = row.companyName.toUpperCase();
  const excludedName = /\b(ETF|ETN|FUND|TRUST|WARRANTS?|RIGHTS?|UNITS?|PREFERRED|PFD|DEPOSITARY SHARES?|NOTES?|BONDS?|DEBENTURES?|INDEX|PORTFOLIO)\b/;
  if (excludedName.test(name)) return false;
  if (/[.+-](WS?|W|R|U|P|PR|RT)$/i.test(row.ticker)) return false;

  return true;
}

function cleanName(value) {
  return String(value || '').replace(/\s+-\s+Common Stock$/i, '').trim();
}

function normaliseTicker(value) {
  const ticker = String(value || '').trim().toUpperCase().replace('/', '.');
  return /^[A-Z0-9.-]{1,20}$/.test(ticker) ? ticker : null;
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function mapWithConcurrency(items, concurrency, operation) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await operation(items[current], current);
    }
  });
  await Promise.all(workers);
}

async function retry(operation, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableDoltError(error) || attempt >= attempts) break;
      const delay = 1000 * 2 ** (attempt - 1);
      await new Promise(resolvePromise => setTimeout(resolvePromise, delay));
    }
  }
  throw lastError;
}

async function loadCheckpoint(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return {
      checked: Array.isArray(parsed.checked) ? parsed.checked.map(normaliseTicker).filter(Boolean) : [],
      available: Array.isArray(parsed.available) ? parsed.available.map(normaliseTicker).filter(Boolean) : []
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { checked: [], available: [] };
    console.warn(`Ignoring invalid checkpoint ${path}: ${error.message}`);
    return { checked: [], available: [] };
  }
}

async function atomicWrite(path, body) {
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, 'utf8');
  await rename(temporary, path);
}
