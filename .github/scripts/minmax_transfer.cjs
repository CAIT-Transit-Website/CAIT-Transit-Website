'use strict';

// PiMS Min-Max transfer, protocol 1. Node.js 20+; no npm dependencies.
// Keep the Power Automate chunk size and these constants in agreement.
const fs = require('node:fs');
const crypto = require('node:crypto');

const CHUNK_SIZE = 55000;
const MAX_PARTS = 80;
const EVENT_TYPE = 'pims-minmax-chunk';
const BRANCH_PREFIX = 'pims-minmax-transfer/';
const STAGING = '.minmax-transfer';
const DATA_PATH = 'data/minmax.json';
const ARRAY_FIELDS = ['policyComparison', 'stockoutRisk', 'valueReduction', 'recommendations'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const partPath = n => `${STAGING}/parts/${String(n).padStart(6, '0')}.json`;
const jsonBytes = value => Buffer.from(JSON.stringify(value));

// Preserve Power Automate's seven fractional timestamp digits when ordering exports.
function timestamp(value) {
  check(typeof value === 'string', 'exportedAtUtc must be a UTC timestamp string.');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  check(m, 'exportedAtUtc must be an ISO UTC timestamp ending in Z.');
  const ms = Date.parse(`${m[1]}Z`);
  check(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === m[1],
    'exportedAtUtc contains an invalid date.');
  return BigInt(ms) * 1000000n + BigInt((m[2] || '').padEnd(9, '0'));
}

function validatePacket(p) {
  check(object(p), 'The Event Payload must be an object, not formula text.');
  const keys = ['transportVersion', 'transferId', 'exportedAtUtc', 'partNumber',
    'partCount', 'encodedLength', 'chunk'];
  check(Object.keys(p).length === keys.length && keys.every(k => Object.hasOwn(p, k)),
    'The message must contain exactly the seven documented transport properties.');
  check(p.transportVersion === 1, 'Unsupported transportVersion.');
  check(typeof p.transferId === 'string' && UUID.test(p.transferId), 'Invalid transferId.');
  timestamp(p.exportedAtUtc);
  check(Number.isInteger(p.partCount) && p.partCount >= 1 && p.partCount <= MAX_PARTS,
    `partCount must be between 1 and ${MAX_PARTS}.`);
  check(Number.isInteger(p.partNumber) && p.partNumber >= 1 && p.partNumber <= p.partCount,
    'partNumber is outside this update.');
  check(Number.isInteger(p.encodedLength) && p.encodedLength > 0 && p.encodedLength % 4 === 0,
    'encodedLength must be the length of the complete Base64 string.');
  check(Math.ceil(p.encodedLength / CHUNK_SIZE) === p.partCount,
    'partCount and encodedLength do not agree with the 55000-character chunk size.');
  const expected = p.partNumber < p.partCount ? CHUNK_SIZE :
    p.encodedLength - (p.partCount - 1) * CHUNK_SIZE;
  check(typeof p.chunk === 'string' && p.chunk.length === expected,
    'This part has the wrong length. Check MinMaxChunks and the loop index.');
  check(p.partNumber === p.partCount ? /^[A-Za-z0-9+/]*={0,2}$/.test(p.chunk) :
    /^[A-Za-z0-9+/]+$/.test(p.chunk), 'A part contains invalid Base64 characters.');
  check(Buffer.from(p.chunk, 'base64').toString('base64') === p.chunk,
    'A part is not canonical Base64.');
  check(Buffer.byteLength(JSON.stringify({event_type: EVENT_TYPE, client_payload: p})) < 64000,
    'The dispatch request is too large.');
  return p;
}

function metadata(p) {
  return {transportVersion: p.transportVersion, transferId: p.transferId,
    exportedAtUtc: p.exportedAtUtc, partCount: p.partCount, encodedLength: p.encodedLength};
}

function assertMetadata(a, b) {
  for (const k of ['transportVersion', 'transferId', 'exportedAtUtc', 'partCount', 'encodedLength']) {
    check(a[k] === b[k], `Parts disagree on ${k}; this update cannot be published.`);
  }
}

function checkJsonValues(value) {
  if (typeof value === 'number') check(Number.isFinite(value), 'Data contains a non-finite number.');
  else if (Array.isArray(value)) value.forEach(checkJsonValues);
  else if (object(value)) Object.values(value).forEach(checkJsonValues);
}

function validateData(data, exportedAtUtc) {
  check(object(data), 'WebsiteData must evaluate to a JSON object.');
  check(data.schemaVersion === 1, 'WebsiteData.schemaVersion must be the number 1.');
  timestamp(data.exportedAtUtc);
  check(data.exportedAtUtc === exportedAtUtc, 'Data timestamp differs from its transport metadata.');
  check(object(data.kpis) && Object.keys(data.kpis).length > 0,
    'WebsiteData.kpis must be a nonempty object. Check the KPI Compose output.');
  const normalized = Object.fromEntries(Object.entries(data.kpis).map(([key, value]) =>
    [key.replace(/[^a-z0-9]/gi, '').toLowerCase(), value]));
  const evaluated = normalized.partsevaluated;
  const validated = normalized.validatedrecommendations;
  const valueReduction = Object.hasOwn(normalized, 'nivr') ? normalized.nivr :
    normalized.netinventoryvaluereduction;
  const workload = normalized.replenishmentworkloadmultiple;
  check(Number.isInteger(evaluated) && evaluated > 0,
    'The Parts Evaluated KPI must be a positive integer. Check the KPI row field names.');
  check(Number.isInteger(validated) && validated >= 0 && validated <= evaluated,
    'The Validated Recommendations KPI must be an integer between zero and Parts Evaluated.');
  check(valueReduction === null || typeof valueReduction === 'number',
    'The NIVR / Net Inventory Value Reduction KPI must be a number or null.');
  check(workload === null || (typeof workload === 'number' && workload >= 0),
    'The Replenishment Workload Multiple KPI must be a nonnegative number or null.');
  for (const field of ARRAY_FIELDS) {
    check(Array.isArray(data[field]) && data[field].length > 0 && data[field].every(object),
      `WebsiteData.${field} must be a nonempty array of row objects, not an expression string.`);
  }
  checkJsonValues(data);
  return Object.fromEntries(ARRAY_FIELDS.map(k => [k, data[k].length]));
}

function assemble(manifest, records) {
  check(records.length === manifest.partCount, 'Some parts are missing.');
  const ordered = new Map();
  for (const record of records) {
    const p = validatePacket(record.packet);
    assertMetadata(manifest, p);
    check(record.chunkSha256 === digest(Buffer.from(p.chunk)), 'A stored part failed its checksum.');
    check(!ordered.has(p.partNumber), 'Duplicate part number in assembled data.');
    ordered.set(p.partNumber, p.chunk);
  }
  const chunks = [];
  for (let n = 1; n <= manifest.partCount; n++) {
    check(ordered.has(n), `Part ${n} is missing.`);
    chunks.push(ordered.get(n));
  }
  const encoded = chunks.join('');
  check(encoded.length === manifest.encodedLength, 'The reconstructed length is incorrect.');
  const bytes = Buffer.from(encoded, 'base64');
  check(bytes.toString('base64') === encoded, 'The full Base64 data is invalid.');
  const data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  const rows = validateData(data, manifest.exportedAtUtc);
  return {bytes, data, rows, sha256: digest(bytes)};
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

class ApiError extends Error {
  constructor(status, method, path) {
    super(`GitHub API ${method} ${path.split('?')[0]} returned ${status}.`);
    this.status = status;
  }
}

class GithubStore {
  constructor(repository, token) {
    check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid repository.');
    check(token, 'The workflow GITHUB_TOKEN is missing.');
    this.base = `https://api.github.com/repos/${repository}`;
    this.token = token;
  }

  async request(method, path, body, raw = false, objectMedia = false) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(this.base + path, {
        method,
        headers: {Authorization: `Bearer ${this.token}`,
          Accept: raw ? 'application/vnd.github.raw+json' :
            objectMedia ? 'application/vnd.github.object+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
          'User-Agent': 'pims-minmax-transfer'},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      if (response.ok) {
        if (response.status === 204) return null;
        return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
      }
      const retry = response.headers.get('retry-after');
      if (attempt < 3 && (response.status >= 500 || response.status === 429 ||
          (response.status === 403 && retry !== null))) {
        await response.arrayBuffer();
        await pause(retry === null ? 1000 * 2 ** attempt :
          Math.min(60000, Math.max(1000, Number(retry) * 1000 || 1000)));
        continue;
      }
      // Do not log response bodies, credentials, query rows, or event payloads.
      await response.arrayBuffer();
      throw new ApiError(response.status, method, path);
    }
  }

  contentPath(path, ref) {
    return `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  }

  async readFile(path, ref) {
    let result;
    try { result = await this.request('GET', this.contentPath(path, ref), undefined, false, true); }
    catch (e) { if (e.status === 404) return null; throw e; }
    check(result.type === 'file' && SHA.test(result.sha), `Expected a file at ${path}.`);
    const bytes = result.encoding === 'base64' ? Buffer.from(result.content, 'base64') :
      await this.request('GET', this.contentPath(path, ref), undefined, true);
    return {bytes, sha: result.sha};
  }

  async listFiles(path, ref) {
    try {
      const result = await this.request('GET', this.contentPath(path, ref));
      check(Array.isArray(result), 'Expected a staging directory.');
      return result.map(v => ({name: v.name, type: v.type}));
    } catch (e) { if (e.status === 404) return []; throw e; }
  }

  async head(branch) {
    try { return (await this.request('GET', `/git/ref/heads/${branch}`)).object.sha; }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  async ensureBranch(branch) {
    if (await this.head(branch)) return;
    const sha = await this.head('main');
    check(sha && SHA.test(sha), 'The main branch does not exist.');
    try { await this.request('POST', '/git/refs', {ref: `refs/heads/${branch}`, sha}); }
    catch (e) { if (e.status !== 422 || !await this.head(branch)) throw e; }
  }

  async putFile(path, bytes, branch, sha, message) {
    const body = {message, content: bytes.toString('base64'), branch};
    if (sha) body.sha = sha;
    return this.request('PUT', `/contents/${path.split('/').map(encodeURIComponent).join('/')}`, body);
  }

  async matchingBranches() {
    const refs = await this.request('GET', `/git/matching-refs/heads/${BRANCH_PREFIX}`);
    return refs.map(r => r.ref.replace(/^refs\/heads\//, ''));
  }

  async deleteBranch(branch) {
    check(branch.startsWith(BRANCH_PREFIX) && UUID.test(branch.slice(BRANCH_PREFIX.length)),
      'Refusing to remove a branch outside the managed staging namespace.');
    return this.request('DELETE', `/git/refs/heads/${branch}`);
  }
}

async function readJson(store, path, ref) {
  const file = await store.readFile(path, ref);
  return file && {...file, value: JSON.parse(file.bytes.toString('utf8'))};
}

async function currentData(store) {
  const current = await readJson(store, DATA_PATH, 'main');
  if (current) {
    check(object(current.value), 'Existing data/minmax.json is not an object.');
    timestamp(current.value.exportedAtUtc);
  }
  return current;
}

// Called under the per-transfer receive queue. Different transfers use different branches.
async function receive(store, packet, retry = false) {
  const p = validatePacket(packet);
  const current = await currentData(store);
  if (current && (timestamp(current.value.exportedAtUtc) > timestamp(p.exportedAtUtc) ||
      (timestamp(current.value.exportedAtUtc) === timestamp(p.exportedAtUtc) && !retry))) {
    return {ready: false, status: 'This export is already committed or is older than current data.'};
  }
  const branch = BRANCH_PREFIX + p.transferId;
  await store.ensureBranch(branch);
  const manifestPath = `${STAGING}/manifest.json`;
  let manifest = await readJson(store, manifestPath, branch);
  if (!manifest) {
    const value = {...metadata(p), producer: 'pims-minmax-chunks-v1', createdAtUtc: new Date().toISOString()};
    await store.putFile(manifestPath, jsonBytes(value), branch, undefined, 'Start Min-Max transfer');
    manifest = {value};
  }
  check(manifest.value.producer === 'pims-minmax-chunks-v1', 'Unrecognized staging manifest.');
  assertMetadata(manifest.value, p);
  const path = partPath(p.partNumber);
  const existing = await readJson(store, path, branch);
  const record = {packet: p, chunkSha256: digest(Buffer.from(p.chunk))};
  // Pin both the count and assembly to one immutable commit.
// A branch-name directory read can lag behind a successful save.
let sourceSha;
if (existing) {
  check(canonical(existing.value) === canonical(record),
    'The same part number was received with different contents.');
} else {
  const saved = await store.putFile(path, jsonBytes(record), branch, undefined,
    `Receive Min-Max part ${p.partNumber} of ${p.partCount}`);
  sourceSha = saved?.commit?.sha;
}

let files;
const receivedName = path.split('/').pop();

for (let attempt = 0; attempt < 5; attempt++) {
  if (existing) sourceSha = await store.head(branch);

  check(typeof sourceSha === 'string' && SHA.test(sourceSha),
    'GitHub did not return a valid staging commit. Retry this GitHub run.');

  files = await store.listFiles(`${STAGING}/parts`, sourceSha);

  if (files.some(f => f.type === 'file' && f.name === receivedName)) break;

  check(attempt < 4,
    `Saved part ${p.partNumber} is not readable at its commit. Retry this GitHub run.`);

  await pause(250 * 2 ** attempt);
}
  check(files.every(f => f.type === 'file' && expected.has(f.name)), 'Unexpected file in staging parts.');
  const ready = files.length === p.partCount && new Set(files.map(f => f.name)).size === p.partCount;
  return {ready, sourceSha: ready ? sourceSha : '',
    status: `Received ${files.length}/${p.partCount} parts for ${p.transferId}.`};
}

// Called under the shared pims-analytics-sync queue, coordinating main writes with Current Inventory.
async function finalize(store, packet, sourceSha, retry = false) {
  const p = validatePacket(packet);
  check(SHA.test(sourceSha), 'Invalid immutable staging commit.');
  const manifest = await readJson(store, `${STAGING}/manifest.json`, sourceSha);
  check(manifest && manifest.value.producer === 'pims-minmax-chunks-v1', 'Missing staging manifest.');
  assertMetadata(manifest.value, p);
  const records = [];
  for (let start = 1; start <= p.partCount; start += 5) {
    const batch = await Promise.all(Array.from({length: Math.min(5, p.partCount - start + 1)},
      (_, i) => readJson(store, partPath(start + i), sourceSha)));
    check(batch.every(Boolean), 'A part is missing from the immutable staging commit.');
    records.push(...batch.map(v => v.value));
  }
  const result = assemble(manifest.value, records);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await currentData(store);
    if (current) {
      const previous = timestamp(current.value.exportedAtUtc);
      const incoming = timestamp(result.data.exportedAtUtc);
      if (previous > incoming) return {applied: false, status: 'An export newer than this batch is already committed.'};
      if (previous === incoming) {
        check(canonical(current.value) === canonical(result.data),
          'Different data uses the same exportedAtUtc timestamp; refusing to overwrite.');
        return {applied: retry, rows: result.rows, sha256: result.sha256,
          status: retry ? 'This export is already committed; retrying website publication.' :
            'This complete export is already committed.'};
      }
    }
    try {
      const saved = await store.putFile(DATA_PATH, result.bytes, 'main', current?.sha,
        `Update Min-Max data ${p.exportedAtUtc}`);
      return {applied: true, commitSha: saved.commit.sha, sha256: result.sha256,
        rows: result.rows, status: 'The complete, validated Min-Max file was committed to main.'};
    } catch (e) {
      if (attempt === 4 || ![409, 422].includes(e.status)) throw e;
      await pause(100 * 2 ** attempt);
    }
  }
}

async function cleanup(store, now = Date.now()) {
  let removed = 0;
  for (const branch of await store.matchingBranches()) {
    const id = branch.slice(BRANCH_PREFIX.length);
    if (!branch.startsWith(BRANCH_PREFIX) || !UUID.test(id)) continue;
    const manifest = await readJson(store, `${STAGING}/manifest.json`, branch);
    if (!manifest || manifest.value.producer !== 'pims-minmax-chunks-v1' ||
        manifest.value.transferId !== id) continue;
    const created = Date.parse(manifest.value.createdAtUtc);
    if (Number.isFinite(created) && now - created > 7 * 86400000) {
      await store.deleteBranch(branch);
      removed++;
    }
  }
  return removed;
}

// Local / manual setup check. This checks software, not a live Power BI export.
function selfTest() {
  const data = {schemaVersion: 1, exportedAtUtc: '2026-09-13T12:00:00.1234567Z',
    kpis: {'[Parts_Evaluated]': 92, '[Validated_Recommendations]': 91,
      '[NIVR]': 5526779.7, '[Replenishment_Workload_Multiple]': 2.23},
    ...Object.fromEntries(ARRAY_FIELDS.map(k => [k, [{label: 'Sample ₹é🚆', value: 1, blank: null}]])),
    testPadding: 'sample'.repeat(180000)};
  const bytes = jsonBytes(data);
  const encoded = bytes.toString('base64');
  const packets = [];
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    packets.push(validatePacket({transportVersion: 1,
      transferId: '11111111-1111-4111-8111-111111111111', exportedAtUtc: data.exportedAtUtc,
      partNumber: packets.length + 1, partCount: Math.ceil(encoded.length / CHUNK_SIZE),
      encodedLength: encoded.length, chunk: encoded.slice(i, i + CHUNK_SIZE)}));
  }
  const records = packets.map(packet => ({packet, chunkSha256: digest(Buffer.from(packet.chunk))}));
  const restored = assemble(metadata(packets[0]), records.reverse());
  check(restored.bytes.equals(bytes), 'Self-test changed the reconstructed data.');
  return `Setup check passed: ${packets.length} out-of-order parts reconstructed byte-for-byte. No website data was changed.`;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n\n');
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'self-test') { summary(selfTest()); return; }
  const store = new GithubStore(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  if (mode === 'cleanup') {
    summary(`Removed ${await cleanup(store)} managed staging branches older than seven days.`);
    return;
  }
  check(['receive', 'finalize'].includes(mode), 'Unknown script mode.');
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  check(event.action === EVENT_TYPE, 'Unexpected repository dispatch event type.');
  if (mode === 'receive') {
    const result = await receive(store, event.client_payload, Number(process.env.GITHUB_RUN_ATTEMPT) > 1);
    output('ready', result.ready ? 'true' : 'false');
    output('source_sha', result.sourceSha || '');
    summary(result.status);
  } else {
    const result = await finalize(store, event.client_payload, process.env.MINMAX_SOURCE_SHA,
      Number(process.env.GITHUB_RUN_ATTEMPT) > 1);
    output('applied', result.applied ? 'true' : 'false');
    summary(result.status);
    if (result.applied) {
      summary(`Export: ${event.client_payload.exportedAtUtc}\n\nSHA-256: ${result.sha256}\n\nRows: ${JSON.stringify(result.rows)}`);
      summary('Next gate: the Publish website job must also succeed. This checks transport and JSON structure; verify the visuals against Power BI separately.');
    }
  }
}

module.exports = {CHUNK_SIZE, MAX_PARTS, EVENT_TYPE, BRANCH_PREFIX, STAGING, DATA_PATH,
  ARRAY_FIELDS, ApiError, GithubStore, timestamp, validatePacket, metadata, assemble,
  canonical, validateData, receive, finalize, cleanup, selfTest, partPath, digest};
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
