import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { buildCompanySnapshot, validateCompanySnapshot } from '../src/snapshot-schema.js';

const args = parseArgs(process.argv.slice(2));
const storage = String(args.storage || process.env.IMPORT_STORAGE || 'r2').toLowerCase();
const outputDir = resolve(args.output || '.import-output');
const concurrency = positiveInteger(args.concurrency, 2);
const pageSize = positiveInteger(args.pageSize, 500);
const limit = args.limit ? positiveInteger(args.limit, null) : null;
const resume = Boolean(args.resume);
const universePath = resolve(args.universe || process.env.IMPORT_UNIVERSE || 'data/supported-tickers.json');
const prefix = normalisePrefix(args.prefix || process.env.R2_PREFIX || 'companies');
const sectionConcurrency = positiveInteger(args.sectionConcurrency, 3);

if (!['r2', 'local'].includes(storage)) {
  throw new Error('--storage must be either "r2" or "local".');
}

const r2 = storage === 'r2' ? createR2Store() : null;
if (storage === 'local') await mkdir(outputDir, { recursive: true });

const requestedTickers = String(args.tickers || '')
  .split(',')
  .map(normaliseTicker)
  .filter(Boolean);
const tickers = requestedTickers.length
  ? requestedTickers
  : await loadSupportedUniverse(universePath);
const uniqueTickers = [...new Set(tickers)].slice(0, limit || undefined);

const existingManifest = await readStoredJson('manifest.json').catch(() => null);
const priorCompanies = new Map((existingManifest?.companies || []).map(row => [row.ticker, row]));

const importStartedAt = Date.now();
const timingRows = [];
console.log(`Importing ${uniqueTickers.length} ticker(s) to ${storage.toUpperCase()} with company concurrency ${concurrency} and section concurrency ${sectionConcurrency}.`);

const results = await mapConcurrent(uniqueTickers, concurrency, async (ticker, index) => {
  const objectName = `${safeFileTicker(ticker)}.json`;

  if (resume && priorCompanies.has(ticker) && await storedObjectExists(objectName)) {
    console.log(`[${index + 1}/${uniqueTickers.length}] ${ticker}: skipped`);
    return { ...priorCompanies.get(ticker), status: 'skipped' };
  }

  try {
    const companyStartedAt = Date.now();
    const snapshot = await withRetry(() => buildSnapshot(ticker), {
      attempts: 3,
      baseDelayMs: 1200
    });
    const uploadStartedAt = Date.now();
    await writeStoredJson(objectName, snapshot, {
      cacheControl: 'public, max-age=300, s-maxage=3600'
    });
    const finishedAt = Date.now();
    const timing = {
      ticker,
      calculationMs: uploadStartedAt - companyStartedAt,
      uploadMs: finishedAt - uploadStartedAt,
      totalMs: finishedAt - companyStartedAt
    };
    timingRows.push(timing);
    console.log(`[${index + 1}/${uniqueTickers.length}] ${ticker}: uploaded in ${formatDuration(timing.totalMs)} (build ${formatDuration(timing.calculationMs)}, upload ${formatDuration(timing.uploadMs)})`);
    return {
      ticker,
      companyName: snapshot.identity?.companyName || ticker,
      exchange: snapshot.identity?.exchange || null,
      currency: snapshot.identity?.currency || 'USD',
      importedAt: snapshot.meta.generatedAt,
      objectKey: storageKey(objectName),
      status: 'written'
    };
  } catch (error) {
    if (isUnsupportedTickerError(error)) {
      console.log(`[${index + 1}/${uniqueTickers.length}] ${ticker}: skipped (unsupported)`);
      return { ticker, status: 'unsupported', reason: cleanErrorMessage(error.message) };
    }
    console.error(`[${index + 1}/${uniqueTickers.length}] ${ticker}: ${error.message}`);
    return { ticker, status: 'failed', error: error.message };
  }
});

const companies = results
  .filter(row => row.status !== 'failed' && row.status !== 'unsupported')
  .map(({ status, ...row }) => row)
  .sort((a, b) => a.ticker.localeCompare(b.ticker));
const failures = results
  .filter(row => row.status === 'failed')
  .map(({ status, ...row }) => row);
const unsupported = results
  .filter(row => row.status === 'unsupported')
  .map(({ status, ...row }) => row);

const manifest = {
  ok: failures.length === 0,
  generatedAt: new Date().toISOString(),
  schemaVersion: 3,
  storage,
  companyCount: companies.length,
  failureCount: failures.length,
  unsupportedCount: unsupported.length,
  companies,
  unsupported,
  failures
};

await Promise.all([
  writeStoredJson('manifest.json', manifest, { cacheControl: 'public, max-age=60, s-maxage=300' }),
  writeStoredJson('tickers.json', companies.map(row => ({
    ticker: row.ticker,
    companyName: row.companyName,
    exchange: row.exchange
  })), { cacheControl: 'public, max-age=300, s-maxage=3600' })
]);

const totalElapsedMs = Date.now() - importStartedAt;
console.log(`Done. ${companies.length} snapshots available; ${unsupported.length} skipped as unsupported; ${failures.length} failed in ${formatDuration(totalElapsedMs)}.`);
printTimingSummary(timingRows, totalElapsedMs);
if (failures.length) process.exitCode = 1;

function isUnsupportedTickerError(error) {
  const message = String(error?.message || '');
  if (error?.status === 400 && /not an equity|not a supported US-listed equity/i.test(message)) return true;
  if (error?.status === 404 && /yahoo|not found|no quote/i.test(message)) return true;
  return false;
}

function cleanErrorMessage(message) {
  return String(message || '').split('\n')[0];
}

async function buildSnapshot(ticker) {
  const sections = ['company', 'financials', 'dashboard', 'returns', 'growth', 'history'];
  const sectionResults = await mapConcurrent(sections, sectionConcurrency, async section => {
    const startedAt = Date.now();
    try {
      const value = await callWorker(section, ticker);
      return { section, value, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      error.message = `${error.message} (after ${formatDuration(Date.now() - startedAt)})`;
      throw error;
    }
  });

  const prepared = Object.fromEntries(sectionResults.map(row => [row.section, row.value]));
  const sectionTiming = sectionResults
    .map(row => `${row.section}=${formatDuration(row.elapsedMs)}`)
    .join(', ');
  console.log(`  ${ticker} sections: ${sectionTiming}`);

  const snapshot = buildCompanySnapshot({
    ticker,
    company: prepared.company,
    financials: prepared.financials,
    dashboard: prepared.dashboard,
    returns: prepared.returns,
    growth: prepared.growth,
    history: prepared.history
  });
  const validation = validateCompanySnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`Invalid snapshot for ${ticker}: ${validation.errors.join(' ')}`);
  }
  return snapshot;
}

async function callWorker(parameter, ticker) {
  const url = new URL('https://local.importer.invalid/');
  url.searchParams.set(parameter, ticker);
  const response = await worker.fetch(new Request(url), {});
  const body = await response.json();
  if (!response.ok || body?.ok === false) {
    const workerStack = Array.isArray(body?.debug?.stack)
      ? body.debug.stack.join('\n')
      : '';
    const details = body?.details ? `\nDetails: ${JSON.stringify(body.details)}` : '';
    const stackDetails = workerStack ? `\nWorker stack:\n${workerStack}` : '';
    const error = new Error(
      `[${parameter.toUpperCase()} ${ticker}] ${body?.error || `${parameter} request failed with ${response.status}`}${details}${stackDetails}`
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function createR2Store() {
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
  const accessKeyId = requiredEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnv('R2_SECRET_ACCESS_KEY');
  const bucket = requiredEnv('R2_BUCKET_NAME');
  const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;

  return { bucket, endpoint, accessKeyId, secretAccessKey };
}

async function r2Request(method, key, { body = '', headers = {} } = {}) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`/${encodeURIComponent(r2.bucket)}/${encodedKey}`, r2.endpoint);
  const payloadHash = sha256(body);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const requestHeaders = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([keyName, value]) => [keyName.toLowerCase(), String(value)]))
  };
  const signedHeaderNames = Object.keys(requestHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map(name => `${name}:${requestHeaders[name].trim()}\n`).join('');
  const canonicalRequest = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash
  ].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest)
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${r2.secretAccessKey}`, dateStamp), 'auto'), 's3'),
    'aws4_request'
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  requestHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: method === 'PUT' ? body : undefined
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const error = new Error(`R2 ${method} failed (${response.status}): ${errorBody.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

async function writeStoredJson(name, value, { cacheControl }) {
  const body = `${JSON.stringify(value)}\n`;
  if (storage === 'local') {
    await atomicWriteJson(resolve(outputDir, name), body);
    return;
  }

  await r2Request('PUT', storageKey(name), {
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
      'x-amz-meta-schema': String(value?.meta?.version || value?.schemaVersion || 1),
      'x-amz-meta-generated': String(value?.meta?.generatedAt || value?.generatedAt || new Date().toISOString())
    }
  });
}

async function readStoredJson(name) {
  if (storage !== 'local') return null;
  return JSON.parse(await readFile(resolve(outputDir, name), 'utf8'));
}

async function storedObjectExists(name) {
  if (storage === 'local') {
    return readFile(resolve(outputDir, name)).then(() => true).catch(() => false);
  }
  try {
    await r2Request('HEAD', storageKey(name));
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

function storageKey(name) {
  return prefix ? `${prefix}/${name}` : name;
}

async function loadSupportedUniverse(path) {
  let body;
  try {
    body = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Supported ticker universe not found at ${path}. Run "npm run universe:update" first.`);
    }
    throw new Error(`Could not read supported ticker universe at ${path}: ${error.message}`);
  }

  const rows = Array.isArray(body) ? body : body?.companies;
  if (!Array.isArray(rows)) {
    throw new Error(`Invalid supported ticker universe at ${path}: expected an array or a companies array.`);
  }

  const tickers = rows
    .map(row => normaliseTicker(typeof row === 'string' ? row : row?.ticker))
    .filter(Boolean);

  if (!tickers.length) {
    throw new Error(`Supported ticker universe at ${path} is empty.`);
  }

  console.log(`Loaded ${tickers.length} supported ticker(s) from ${path}.`);
  return tickers;
}

async function mapConcurrent(items, maxConcurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function workerLoop() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, workerLoop));
  return results;
}

async function withRetry(operation, { attempts, baseDelayMs }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await delay(baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 300));
    }
  }
  throw lastError;
}

async function atomicWriteJson(path, body) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, 'utf8');
  await rename(temporary, path);
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normaliseTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9.^-]{1,20}$/.test(ticker) ? ticker : null;
}

function safeFileTicker(ticker) {
  return ticker.replaceAll('^', '_INDEX_').replaceAll('/', '-');
}

function normalisePrefix(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '');
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (values[index + 1] && !values[index + 1].startsWith('--')) {
      parsed[rawKey] = values[++index];
    } else {
      parsed[rawKey] = true;
    }
  }
  return parsed;
}


function printTimingSummary(rows, totalElapsedMs) {
  if (!rows.length) return;
  const totals = rows.map(row => row.totalMs).sort((a, b) => a - b);
  const builds = rows.map(row => row.calculationMs).sort((a, b) => a - b);
  const uploads = rows.map(row => row.uploadMs).sort((a, b) => a - b);
  const percentile = (values, ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))];
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const throughputPerMinute = totalElapsedMs > 0 ? rows.length / (totalElapsedMs / 60000) : 0;

  console.log('Performance summary:');
  console.log(`  Throughput: ${throughputPerMinute.toFixed(2)} companies/minute`);
  console.log(`  Average company: ${formatDuration(average(totals))}`);
  console.log(`  Median company: ${formatDuration(percentile(totals, 0.5))}`);
  console.log(`  P90 company: ${formatDuration(percentile(totals, 0.9))}`);
  console.log(`  Average build: ${formatDuration(average(builds))}`);
  console.log(`  Average upload: ${formatDuration(average(uploads))}`);
  console.log(`  Estimated 100 companies at this throughput: ${formatDuration((100 / throughputPerMinute) * 60000)}`);
  console.log(`  Estimated 5,000 companies at this throughput: ${formatDuration((5000 / throughputPerMinute) * 60000)}`);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'n/a';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}
