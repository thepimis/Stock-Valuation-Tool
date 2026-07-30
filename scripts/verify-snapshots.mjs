import { createHash, createHmac } from 'node:crypto';
import worker from '../src/index.js';

const args = parseArgs(process.argv.slice(2));
const tickers = String(args.tickers || 'AAPL,MSFT,META')
  .split(',')
  .map(value => value.trim().toUpperCase())
  .filter(Boolean);
const prefix = String(args.prefix || process.env.R2_PREFIX || 'companies').replace(/^\/+|\/+$/g, '');
const absoluteTolerance = numberArg(args.absoluteTolerance, 1e-6);
const relativeTolerance = numberArg(args.relativeTolerance, 1e-9);
const r2 = createR2Store();

let failures = 0;
for (const ticker of tickers) {
  try {
    const snapshot = await readSnapshot(ticker);
    const checks = await Promise.all([
      compareRoute(ticker, 'company', snapshot?.prepared?.company),
      compareRoute(ticker, 'financials', snapshot?.prepared?.financials),
      compareRoute(ticker, 'dashboard', snapshot?.prepared?.dashboard),
      compareRoute(ticker, 'returns', snapshot?.prepared?.returns),
      compareRoute(ticker, 'growth', snapshot?.prepared?.growth),
      compareRoute(ticker, 'history', snapshot?.prepared?.history)
    ]);

    const differences = checks.flatMap(result => result.differences);
    if (differences.length) {
      failures += 1;
      console.error(`\n${ticker}: FAILED (${differences.length} difference(s))`);
      for (const difference of differences.slice(0, 30)) console.error(`  ${difference}`);
      if (differences.length > 30) console.error(`  ...and ${differences.length - 30} more`);
    } else {
      console.log(`${ticker}: OK - prepared snapshot matches live calculations`);
    }
  } catch (error) {
    failures += 1;
    console.error(`${ticker}: ERROR - ${error.message}`);
  }
}

if (failures) {
  console.error(`\nVerification failed for ${failures} ticker(s).`);
  process.exitCode = 1;
} else {
  console.log(`\nVerification passed for ${tickers.length} ticker(s).`);
}

async function compareRoute(ticker, parameter, prepared) {
  if (!prepared) return { differences: [`${parameter}: missing prepared response`] };
  const url = new URL('https://local.verify.invalid/');
  url.searchParams.set(parameter, ticker);
  const response = await worker.fetch(new Request(url), {});
  const live = await response.json();
  if (!response.ok || live?.ok === false) {
    return { differences: [`${parameter}: live calculation failed (${response.status}) ${live?.error || ''}`.trim()] };
  }
  return { differences: compareValues(prepared, live, parameter) };
}

function compareValues(expected, actual, path) {
  if (expected === actual) return [];
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (numbersEqual(expected, actual)) return [];
    return [`${path}: expected ${expected}, got ${actual}`];
  }
  if (expected == null || actual == null) {
    return [`${path}: expected ${formatValue(expected)}, got ${formatValue(actual)}`];
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [`${path}: array/type mismatch`];
    }
    const differences = [];
    if (expected.length !== actual.length) differences.push(`${path}.length: expected ${expected.length}, got ${actual.length}`);
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      differences.push(...compareValues(expected[index], actual[index], `${path}[${index}]`));
      if (differences.length >= 100) break;
    }
    return differences;
  }
  if (typeof expected === 'object' && typeof actual === 'object') {
    const differences = [];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      // Runtime/debug metadata can legitimately change between calls.
      if (['generatedAt', 'importedAt', 'requestId', 'durationMs'].includes(key)) continue;
      if (!(key in expected)) differences.push(`${path}.${key}: unexpected field in live response`);
      else if (!(key in actual)) differences.push(`${path}.${key}: missing from live response`);
      else differences.push(...compareValues(expected[key], actual[key], `${path}.${key}`));
      if (differences.length >= 100) break;
    }
    return differences;
  }
  return [`${path}: expected ${formatValue(expected)}, got ${formatValue(actual)}`];
}

function numbersEqual(left, right) {
  if (Object.is(left, right)) return true;
  const difference = Math.abs(left - right);
  if (difference <= absoluteTolerance) return true;
  return difference <= relativeTolerance * Math.max(1, Math.abs(left), Math.abs(right));
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

async function readSnapshot(ticker) {
  const key = prefix ? `${prefix}/${safeTicker(ticker)}.json` : `${safeTicker(ticker)}.json`;
  const response = await r2Request('GET', key);
  return response.json();
}

function createR2Store() {
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
  const accessKeyId = requiredEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnv('R2_SECRET_ACCESS_KEY');
  const bucket = requiredEnv('R2_BUCKET_NAME');
  const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
  return { bucket, endpoint, accessKeyId, secretAccessKey };
}

async function r2Request(method, key) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`/${encodeURIComponent(r2.bucket)}/${encodedKey}`, r2.endpoint);
  const payloadHash = sha256('');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map(name => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedNames.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${r2.secretAccessKey}`, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;

  const response = await fetch(url, { method, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`R2 ${method} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return response;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function safeTicker(value) {
  return value.replace(/[^A-Z0-9._-]/g, '_');
}
function numberArg(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith('--')) continue;
    const [rawKey, inlineValue] = item.slice(2).split('=', 2);
    if (inlineValue !== undefined) parsed[rawKey] = inlineValue;
    else if (values[index + 1] && !values[index + 1].startsWith('--')) parsed[rawKey] = values[++index];
    else parsed[rawKey] = true;
  }
  return parsed;
}
