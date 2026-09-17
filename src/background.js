importScripts(
  'modules/constants.js',
  'modules/logger.js',
  'modules/filename.js',
  'modules/api-client.js',
  'modules/queue.js'
);

const { MESSAGE, logger, CONFIG, ANALYSIS_TYPE } = globalThis.CREIS;
const ADVANCE_ALARM = 'creis-batch-advance';
const DOWNLOAD_TIMEOUT_ALARM = 'creis-download-timeout';
const CAPTURE_TIMEOUT_ALARM = 'creis-capture-timeout';
const DEFAULT_STATE = Object.freeze({
  debugMode: false,
  debugLogs: [],
  lastScan: null,
  analysisTabId: null,
  batchState: null,
  clickTarget: null,
  captureState: null
});
let advancing = false;
let clicking = false;
let captureMutation = Promise.resolve();

const CAPTURE_SECRET_KEYS = /cookie|authorization|token|password|secret|session|csrf|ticket/i;
const CAPTURE_TYPES = new Set(['xmlhttprequest', 'fetch', 'other', 'main_frame', 'sub_frame']);
const CAPTURE_HEADER_ALLOWLIST = new Set([
  'accept', 'content-type', 'origin', 'referer', 'x-requested-with',
  'sec-fetch-dest', 'sec-fetch-mode', 'content-disposition', 'content-length', 'location'
]);

async function getState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  return { ...DEFAULT_STATE, ...stored };
}

function redactCaptureValue(value) {
  if (Array.isArray(value)) return value.map(redactCaptureValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    CAPTURE_SECRET_KEYS.test(key) ? '[已脱敏]' : redactCaptureValue(item)
  ]));
}

function safeCaptureUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    url.hash = '';
    const query = {};
    for (const [key, item] of url.searchParams.entries()) {
      const safeValue = CAPTURE_SECRET_KEYS.test(key) ? '[已脱敏]' : item;
      query[key] = safeValue;
      if (CAPTURE_SECRET_KEYS.test(key)) url.searchParams.set(key, safeValue);
    }
    return { url: url.href, query };
  } catch (_) { return { url: String(value || '').slice(0, 8000), query: {} }; }
}

function safeCaptureHeaders(headers) {
  const output = {};
  for (const header of headers || []) {
    const name = String(header.name || '').toLowerCase();
    if (!CAPTURE_HEADER_ALLOWLIST.has(name) && !CAPTURE_SECRET_KEYS.test(name)) continue;
    if (CAPTURE_SECRET_KEYS.test(name)) {
      output[name] = '[已脱敏]';
    } else if (name === 'origin' || name === 'referer' || name === 'location') {
      output[name] = safeCaptureUrl(header.value || '').url;
    } else {
      output[name] = String(header.value || '').slice(0, 4000);
    }
  }
  return output;
}

function sanitizeRawCaptureText(value) {
  const text = String(value || '').slice(0, 20000);
  try { return redactCaptureValue(JSON.parse(text)); } catch (_) { /* 继续按表单文本处理 */ }
  if (text.includes('=')) {
    try {
      const params = new URLSearchParams(text);
      const safe = {};
      for (const [key, item] of params.entries()) {
        const safeValue = CAPTURE_SECRET_KEYS.test(key) ? '[已脱敏]' : item;
        if (Object.prototype.hasOwnProperty.call(safe, key)) {
          safe[key] = Array.isArray(safe[key]) ? [...safe[key], safeValue] : [safe[key], safeValue];
        } else safe[key] = safeValue;
      }
      if ([...params.keys()].length) return safe;
    } catch (_) { /* 继续使用文本脱敏 */ }
  }
  return text.replace(/((?:token|authorization|cookie|password|secret|session|csrf|ticket)[^=&:\s]*[=:])([^&\s]+)/ig, '$1[已脱敏]');
}

function decodeRequestBody(requestBody) {
  if (!requestBody) return '';
  if (requestBody.formData) {
    const form = {};
    for (const [key, values] of Object.entries(requestBody.formData)) {
      form[key] = CAPTURE_SECRET_KEYS.test(key) ? '[已脱敏]' : values;
    }
    return form;
  }
  if (!requestBody.raw) return '';
  try {
    const chunks = requestBody.raw.map((item) => item.bytes ? new Uint8Array(item.bytes) : new Uint8Array());
    const total = Math.min(20000, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      const available = Math.min(chunk.byteLength, total - offset);
      combined.set(chunk.slice(0, available), offset);
      offset += available;
      if (offset >= total) break;
    }
    return sanitizeRawCaptureText(new TextDecoder().decode(combined));
  } catch (_) { return '[请求体无法解码]'; }
}

function captureScore(record) {
  const searchable = `${record.url || ''} ${JSON.stringify(record.requestBody || '')} ${record.responseContentType || ''} ${record.contentDisposition || ''}`;
  let score = 0;
  if (/xlsx|excel|spreadsheet/i.test(searchable)) score += 120;
  if (/export|download|导出|下载/i.test(searchable)) score += 70;
  if (/attachment/i.test(record.contentDisposition || '')) score += 100;
  if (/octet-stream/i.test(record.responseContentType || '')) score += 80;
  if (record.method === 'POST') score += 20;
  if (record.type === 'xmlhttprequest' || record.type === 'fetch') score += 15;
  if (record.statusCode >= 200 && record.statusCode < 300) score += 10;
  if (record.error) score -= 80;
  return score;
}

function bestCaptureRecord(captureState, targetType) {
  return (captureState.records || [])
    .filter((record) => record.targetType === targetType)
    .map((record) => ({ ...record, score: captureScore(record) }))
    .sort((a, b) => b.score - a.score)[0] || null;
}

function finalizeCaptureState(captureState, reason) {
  const targetType = captureState.targetType;
  const best = bestCaptureRecord(captureState, targetType);
  captureState.active = false;
  captureState.finishedAt = new Date().toISOString();
  captureState.lastMessage = best
    ? `已完成${analysisLabel(targetType)}捕获，最佳候选评分 ${best.score}`
    : `已结束${analysisLabel(targetType)}捕获，没有发现候选请求`;
  captureState.finishReason = reason;
  captureState.profiles = captureState.profiles || {};
  if (best) captureState.profiles[targetType] = best;
  return captureState;
}

function queueCaptureMutation(mutator) {
  captureMutation = captureMutation.then(async () => {
    const state = await getState();
    const captureState = state.captureState;
    if (!captureState || !captureState.active) return;
    await mutator(captureState);
    captureState.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ captureState });
  }).catch((error) => logger.warn('请求捕获记录失败', error));
  return captureMutation;
}

function shouldCaptureRequest(details) {
  if (!CAPTURE_TYPES.has(details.type)) return false;
  if (/\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?|ttf)(?:\?|$)/i.test(details.url)) return false;
  return details.method !== 'GET' || details.type !== 'other' || /export|download|excel|xlsx/i.test(details.url);
}

async function startRequestCapture(targetType, tabId, pageUrl) {
  if (!Object.values(ANALYSIS_TYPE).includes(targetType)) throw new Error('捕获类型无效');
  await captureMutation;
  const state = await getState();
  const previous = state.captureState || { records: [], profiles: {} };
  const profiles = { ...(previous.profiles || {}) };
  delete profiles[targetType];
  const captureState = {
    active: true,
    targetType,
    tabId: Number.isInteger(tabId) ? tabId : null,
    pageUrl: safeCaptureUrl(pageUrl || '').url,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    records: (previous.records || []).filter((record) => record.targetType !== targetType).slice(-150),
    profiles,
    lastMessage: `正在捕获${analysisLabel(targetType)}，请回到网页点击一次下载图标`
  };
  await chrome.storage.local.set({ captureState });
  chrome.alarms.create(CAPTURE_TIMEOUT_ALARM, { when: Date.now() + 120000 });
  return captureState;
}

async function stopRequestCapture(reason = 'manual') {
  await captureMutation;
  const state = await getState();
  if (!state.captureState) return null;
  const captureState = state.captureState.active
    ? finalizeCaptureState(state.captureState, reason)
    : state.captureState;
  await chrome.storage.local.set({ captureState });
  await chrome.alarms.clear(CAPTURE_TIMEOUT_ALARM);
  return captureState;
}

function captureRecordFor(captureState, details) {
  if (captureState.tabId != null && details.tabId >= 0 && details.tabId !== captureState.tabId) return null;
  const startedAt = new Date(captureState.startedAt).getTime();
  if (details.timeStamp && details.timeStamp < startedAt - 1000) return null;
  let record = (captureState.records || []).find((item) => item.requestId === details.requestId);
  if (!record) {
    const safe = safeCaptureUrl(details.url);
    record = {
      requestId: details.requestId,
      targetType: captureState.targetType,
      url: safe.url,
      query: safe.query,
      method: details.method || 'GET',
      type: details.type || '',
      initiator: safeCaptureUrl(details.initiator || details.originUrl || '').url,
      startedAt: new Date(details.timeStamp || Date.now()).toISOString(),
      requestHeaders: {},
      responseHeaders: {}
    };
    captureState.records = captureState.records || [];
    captureState.records.push(record);
    if (captureState.records.length > 250) captureState.records.splice(0, captureState.records.length - 250);
  }
  return record;
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!shouldCaptureRequest(details)) return;
  void queueCaptureMutation(async (captureState) => {
    const record = captureRecordFor(captureState, details);
    if (!record) return;
    record.requestBody = decodeRequestBody(details.requestBody);
  });
}, { urls: ['https://*.fang.com/*'] }, ['requestBody']);

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (!shouldCaptureRequest(details)) return;
  void queueCaptureMutation(async (captureState) => {
    const record = captureRecordFor(captureState, details);
    if (!record) return;
    record.requestHeaders = safeCaptureHeaders(details.requestHeaders);
    record.requestContentType = record.requestHeaders['content-type'] || '';
  });
}, { urls: ['https://*.fang.com/*'] }, ['requestHeaders']);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (!CAPTURE_TYPES.has(details.type)) return;
  void queueCaptureMutation(async (captureState) => {
    const record = captureRecordFor(captureState, details);
    if (!record) return;
    record.statusCode = details.statusCode;
    record.responseHeaders = safeCaptureHeaders(details.responseHeaders);
    record.responseContentType = record.responseHeaders['content-type'] || '';
    record.contentDisposition = record.responseHeaders['content-disposition'] || '';
  });
}, { urls: ['https://*.fang.com/*'] }, ['responseHeaders']);

chrome.webRequest.onCompleted.addListener((details) => {
  if (!CAPTURE_TYPES.has(details.type)) return;
  void queueCaptureMutation(async (captureState) => {
    const record = captureRecordFor(captureState, details);
    if (!record) return;
    record.statusCode = details.statusCode;
    record.completedAt = new Date(details.timeStamp || Date.now()).toISOString();
    record.score = captureScore(record);
    if (record.score >= 90) {
      finalizeCaptureState(captureState, 'strong-candidate');
      await chrome.alarms.clear(CAPTURE_TIMEOUT_ALARM);
    }
  });
}, { urls: ['https://*.fang.com/*'] });

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (!CAPTURE_TYPES.has(details.type)) return;
  void queueCaptureMutation(async (captureState) => {
    const record = captureRecordFor(captureState, details);
    if (!record) return;
    record.error = details.error || '网络请求失败';
    record.completedAt = new Date(details.timeStamp || Date.now()).toISOString();
    record.score = captureScore(record);
  });
}, { urls: ['https://*.fang.com/*'] });

async function saveBatch(batchState) {
  batchState.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ batchState });
}

async function notifyCreisTabs(enabled) {
  const tabs = await chrome.tabs.query({ url: 'https://creis.fang.com/*' });
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: MESSAGE.debugChanged, enabled })));
}

function analysisLabel(type) {
  return type === ANALYSIS_TYPE.house ? '周边项目'
    : type === ANALYSIS_TYPE.land ? '周边土地' : '出让资料';
}

function suffixFor(type) {
  return type === ANALYSIS_TYPE.house ? '周边项目成交均价'
    : type === ANALYSIS_TYPE.land ? '周边土地推出楼面价' : '出让资料';
}

function taskFilePath(task, originalFilename) {
  const isDocuments = task.analysisType === ANALYSIS_TYPE.documents;
  const extMatch = String(originalFilename || '').match(isDocuments ? /\.zip$/i : /\.(xlsx|xls|csv)$/i);
  const extension = extMatch ? extMatch[0].toLowerCase() : isDocuments ? '.zip' : '.xlsx';
  const folder = globalThis.CREIS.filename.buildFolderName(task.land);
  const discriminator = task.duplicateLandName
    ? `_${task.land.code || String(task.land.landId || '').slice(0, 8)}`
    : '';
  const base = globalThis.CREIS.filename.sanitizeFilename(`${task.land.name}${discriminator}_${suffixFor(task.analysisType)}`, 150);
  const rootFolder = isDocuments ? 'CREIS土地出让资料' : 'CREIS土地批量下载';
  return isDocuments
    ? `${rootFolder}/${base}${extension}`
    : `${rootFolder}/${folder}/${base}${extension}`;
}

function xmlCell(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function flattenApiRecord(value, prefix = '', output = {}, depth = 0) {
  if (depth > 4 || value == null || typeof value !== 'object') {
    if (prefix) output[prefix] = value == null ? '' : value;
    return output;
  }
  if (Array.isArray(value)) {
    output[prefix || 'value'] = value.every((item) => item == null || typeof item !== 'object')
      ? value.join('、')
      : JSON.stringify(value);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) flattenApiRecord(item, name, output, depth + 1);
    else if (Array.isArray(item)) output[name] = item.every((part) => part == null || typeof part !== 'object') ? item.join('、') : JSON.stringify(item);
    else output[name] = item == null ? '' : item;
  }
  return output;
}

function extractApiRows(payload) {
  const candidates = [];
  function visit(value, path = '', depth = 0) {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) {
      const objectCount = value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).length;
      const score = objectCount * 1000 + value.length * 10 + (/list|rows|data|result|items/i.test(path) ? 100 : 0);
      candidates.push({ value, path, score });
      for (const item of value.slice(0, 3)) visit(item, path, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, path ? `${path}.${key}` : key, depth + 1);
    }
  }
  visit(payload);
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0];
  if (selected) return selected.value.map((item) => item && typeof item === 'object' ? flattenApiRecord(item) : { value: item });
  if (payload && typeof payload === 'object') return [flattenApiRecord(payload)];
  return [{ value: payload }];
}

function isEncryptedApiPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload.data;
  if (typeof value !== 'string' || value.length < 200) return false;
  const compact = value.replace(/\s+/g, '');
  const base64Like = compact.length >= 200 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  const hasEnvelope = payload.meta && typeof payload.meta === 'object'
    && (Object.prototype.hasOwnProperty.call(payload.meta, 'code') || Object.prototype.hasOwnProperty.call(payload.meta, 'timestamp'));
  return base64Like && hasEnvelope;
}

function uint16(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function uint32(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const checksum = crc32(data);
    const localHeader = concatBytes([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name
    ]);
    localParts.push(localHeader, data);
    const centralHeader = concatBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const central = concatBytes(centralParts);
  const end = concatBytes([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(central.length), uint32(offset), uint16(0)
  ]);
  return concatBytes([...localParts, central, end]);
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) { value -= 1; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
  return name;
}

function xlsxCell(value, rowIndex, columnIndex) {
  const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = String(value == null ? '' : value).slice(0, 32767).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlCell(text)}</t></is></c>`;
}

function createXlsx(rows, sheetName) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const headers = [...new Set(safeRows.flatMap((row) => Object.keys(row || {})))].slice(0, 250);
  if (!headers.length) headers.push('结果');
  const table = [headers, ...safeRows.map((row) => headers.map((header) => row && row[header]))];
  const rowXml = table.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => xlsxCell(value, rowIndex, columnIndex)).join('')}</row>`).join('');
  const name = String(sheetName || '数据').replace(/[\\/?*\[\]:]/g, '_').slice(0, 31) || '数据';
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  return zipStore([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlCell(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml }
  ]);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function isCreisDownload(item) {
  const values = [item && item.url, item && item.finalUrl, item && item.referrer].filter(Boolean);
  return values.some((value) => {
    try {
      const url = new URL(value);
      return url.hostname === 'creis.fang.com' || url.hostname.endsWith('.fang.com') || (url.protocol === 'blob:' && value.includes('fang.com'));
    } catch (_) { return String(value).includes('fang.com'); }
  });
}

function isDirectGeneratedDownload(item) {
  return /^data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet(?:;|,)/i.test(String(item && (item.url || item.finalUrl) || ''));
}

function isExpectedDownload(item, batch) {
  const task = currentTask(batch);
  if (task && task.analysisType === ANALYSIS_TYPE.documents) {
    const values = [item && item.filename, item && item.url, item && item.finalUrl, item && item.mime].filter(Boolean).join(' ');
    const looksLikeZip = /\.zip(?:$|[?#\s])|application\/(?:zip|x-zip-compressed)/i.test(values);
    const looksLikeSingleDocument = /\.(?:pdf|docx?|xlsx?|jpe?g|png)(?:$|[?#\s])|application\/pdf/i.test(values);
    const recentlyClicked = batch && batch.clickIssuedAt
      && Date.now() - new Date(batch.clickIssuedAt).getTime() < 60000;
    return looksLikeZip || (recentlyClicked && isCreisDownload(item) && !looksLikeSingleDocument);
  }
  const windowMs = CONFIG.downloadTimeout;
  const recentlyClicked = batch && batch.clickIssuedAt && Date.now() - new Date(batch.clickIssuedAt).getTime() < windowMs;
  return isCreisDownload(item) || recentlyClicked;
}

function buildTasks(lands, types) {
  const nameCounts = new Map();
  for (const land of lands) {
    const name = String(land && land.name || '').trim();
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const tasks = [];
  for (const land of lands) {
    for (const analysisType of types) {
      tasks.push({
        id: `${land.landId}|${land.cityId || ''}|${analysisType}`,
        land,
        analysisType,
        duplicateLandName: (nameCounts.get(String(land.name || '').trim()) || 0) > 1,
        status: 'pending',
        phase: 'pending',
        attempts: 0,
        errors: [],
        downloadId: null,
        savedFilename: '',
        note: ''
      });
    }
  }
  return tasks;
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function taskResultText(task) {
  if (!task) return '';
  if (task.status === 'success') return '成功';
  if (task.status === 'failed') return '失败';
  if (task.status === 'cancelled') return '已取消';
  return '未完成';
}

async function downloadReport(batch) {
  const byLand = new Map();
  for (const task of batch.tasks) {
    const key = `${task.land.landId}|${task.land.cityId || ''}`;
    if (!byLand.has(key)) byLand.set(key, { land: task.land, house: null, landTask: null, documents: null });
    const row = byLand.get(key);
    if (task.analysisType === ANALYSIS_TYPE.house) row.house = task;
    if (task.analysisType === ANALYSIS_TYPE.land) row.landTask = task;
    if (task.analysisType === ANALYSIS_TYPE.documents) row.documents = task;
  }
  const rows = [['地块编号', '地块名称', '周边项目', '周边土地', '出让资料', '备注']];
  for (const row of byLand.values()) {
    const notes = [row.house && row.house.note, row.landTask && row.landTask.note, row.documents && row.documents.note].filter(Boolean).join('；');
    rows.push([
      row.land.code || '', row.land.name || '', taskResultText(row.house), taskResultText(row.landTask), taskResultText(row.documents), notes
    ]);
  }
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = `data:text/csv;charset=utf-8,%EF%BB%BF${encodeURIComponent(csv)}`;
  await chrome.downloads.download({
    url,
    filename: 'CREIS土地批量下载/download_report.csv',
    conflictAction: 'overwrite',
    saveAs: false
  });
}

function samePageUrl(first, second) {
  try {
    const a = new URL(first);
    const b = new URL(second);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch (_) { return first === second; }
}

async function ensureWorkerTab(url, forceRefresh) {
  const state = await getState();
  let tab = null;
  if (state.analysisTabId) {
    try { tab = await chrome.tabs.get(state.analysisTabId); } catch (_) { tab = null; }
  }
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (samePageUrl(tab.url, url)) {
      await chrome.tabs.reload(tab.id, { bypassCache: Boolean(forceRefresh) });
      return chrome.tabs.get(tab.id);
    }
    return chrome.tabs.update(tab.id, { url, active: true });
  }
  tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.local.set({ analysisTabId: tab.id });
  return tab;
}

async function openAnalysis(land, analysisType, active = true) {
  const url = globalThis.CREIS.apiClient.buildAnalysisUrl(land, analysisType);
  const state = await getState();
  let tab = null;
  if (state.analysisTabId) {
    try { tab = await chrome.tabs.get(state.analysisTabId); } catch (_) { tab = null; }
  }
  if (tab) tab = await chrome.tabs.update(tab.id, { url, active });
  else {
    tab = await chrome.tabs.create({ url, active });
    await chrome.storage.local.set({ analysisTabId: tab.id });
  }
  return { tabId: tab.id, url };
}

function currentTask(batch) {
  return batch && batch.tasks.find((task) => task.id === batch.currentTaskId) || null;
}

async function scheduleAdvance(delayMs = CONFIG.requestDelay) {
  await chrome.alarms.clear(ADVANCE_ALARM);
  const delay = Math.max(100, delayMs);
  setTimeout(() => void advanceBatch(), delay);
  chrome.alarms.create(ADVANCE_ALARM, { when: Date.now() + Math.max(30000, delay + 5000) });
}

async function beginDirectDataWait(tabId) {
  const state = await getState();
  const batch = state.batchState;
  const task = currentTask(batch);
  if (!batch || batch.status !== 'running' || batch.workerTabId !== tabId || !task) return;
  if (task.phase !== 'opening_analysis') return;
  task.phase = 'waiting_data';
  task.note = '等待 CREIS 数据接口返回';
  await saveBatch(batch);
  await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
  chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 15000 });
}

async function startTaskInteraction(tabId) {
  const state = await getState();
  const task = currentTask(state.batchState);
  if (!task || task.phase !== 'opening_analysis') return;
  if (task.analysisType === ANALYSIS_TYPE.documents) void clickCurrentDocuments(tabId);
  else void beginDirectDataWait(tabId);
}

async function downloadDirectApiData(tabId, payload) {
  const state = await getState();
  const batch = state.batchState;
  const task = currentTask(batch);
  if (!batch || batch.status !== 'running' || batch.workerTabId !== tabId || !task) return false;
  if (task.analysisType !== payload.analysisType || !['opening_analysis', 'waiting_data'].includes(task.phase)) return false;
  try {
    const sourceUrl = new URL(payload.pageUrl || '');
    const sourceLandId = sourceUrl.searchParams.get('landId') || '';
    if (!sourceLandId || sourceLandId !== task.land.landId) return false;
  } catch (_) { return false; }
  if (isEncryptedApiPayload(payload.data)) {
    task.phase = 'opening_analysis';
    task.note = '接口返回加密数据，改用网页原生导出';
    await saveBatch(batch);
    await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clickCurrentExport(tabId);
    return false;
  }
  const rows = extractApiRows(payload.data);
  const workbook = createXlsx(rows, analysisLabel(task.analysisType));
  const filename = taskFilePath(task, 'creis-api-data.xlsx');
  const url = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytesToBase64(workbook)}`;
  task.phase = 'direct_downloading';
  task.note = `已取得接口数据，共 ${rows.length} 条`;
  task.savedFilename = filename;
  await saveBatch(batch);
  await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
  const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  const latest = await getState();
  const latestTask = currentTask(latest.batchState);
  if (!latestTask || latestTask.id !== task.id) return true;
  latestTask.downloadId = downloadId;
  latestTask.phase = 'direct_downloading';
  await saveBatch(latest.batchState);
  chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 120000 });
  const items = await chrome.downloads.search({ id: downloadId });
  if (items[0] && items[0].state === 'complete') await completeCurrentTask(downloadId, filename);
  return true;
}

async function finishIfDone(batch) {
  const pending = batch.tasks.some((task) => task.status === 'pending' || task.status === 'running');
  if (pending) return false;
  batch.status = batch.tasks.some((task) => task.status === 'failed') ? 'completed_with_errors' : 'completed';
  batch.finishedAt = new Date().toISOString();
  batch.currentTaskId = null;
  await saveBatch(batch);
  await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
  await downloadReport(batch).catch((error) => logger.warn('下载报告生成失败', error));
  logger.info('批量点击下载完成', batch);
  return true;
}

async function advanceBatch() {
  if (advancing) return;
  advancing = true;
  try {
    const state = await getState();
    const batch = state.batchState;
    if (!batch || batch.status !== 'running') return;
    if (currentTask(batch) && currentTask(batch).status === 'running') return;
    const task = batch.tasks.find((item) => item.status === 'pending');
    if (!task) {
      await finishIfDone(batch);
      return;
    }
    task.status = 'running';
    task.phase = 'opening_analysis';
    task.attempts += 1;
    task.note = '';
    task.downloadId = null;
    batch.currentTaskId = task.id;
    await saveBatch(batch);
    chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + CONFIG.navigationTimeout });

    const url = globalThis.CREIS.apiClient.buildAnalysisUrl(task.land, task.analysisType);
    const tab = await ensureWorkerTab(url, task.attempts > 1);
    batch.workerTabId = tab.id;
    await saveBatch(batch);
    if (tab.status === 'complete') void startTaskInteraction(tab.id);
    logger.info(`开始处理 ${task.land.code || task.land.name} - ${analysisLabel(task.analysisType)}`, url);
  } catch (error) {
    logger.error('推进批量任务失败', error);
    await failCurrentTask(`打开页面失败：${error.message}`);
  } finally {
    advancing = false;
  }
}

async function sendTabMessageWithRetry(tabId, message, retry = 3) {
  let lastError;
  for (let attempt = 0; attempt < retry; attempt += 1) {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      if (attempt < retry - 1) await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!response || response.ok === false) throw new Error(response && response.error || '页面脚本没有响应');
    return response;
  }
  throw lastError;
}

async function trustedExportClick(tabId, taskId = null) {
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    const response = await sendTabMessageWithRetry(tabId, { type: MESSAGE.locateExport });
    const point = response.result;
    await assertTaskActive(taskId, tabId);
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'none', pointerType: 'mouse'
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse'
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse'
    });
    return { ...point, method: 'browser-input' };
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function assertTaskActive(taskId, tabId) {
  if (!taskId) return;
  const state = await getState();
  const batch = state.batchState;
  const task = currentTask(batch);
  if (!batch || batch.status !== 'running' || batch.workerTabId !== tabId || !task || task.id !== taskId) {
    throw new Error('任务已经停止或切换');
  }
}

async function dispatchAttachedClick(debuggee, point) {
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, button: 'none', pointerType: 'mouse'
  });
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse'
  });
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse'
  });
}

async function trustedDocumentDownload(tabId, taskId) {
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await assertTaskActive(taskId, tabId);
    const navigation = await sendTabMessageWithRetry(tabId, { type: MESSAGE.locateSideNav, analysisType: ANALYSIS_TYPE.documents });
    await dispatchAttachedClick(debuggee, navigation.result);
    await new Promise((resolve) => setTimeout(resolve, 800));
    let batchButton = null;
    let pointCheck = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      batchButton = await sendTabMessageWithRetry(tabId, { type: MESSAGE.locateDocumentBatch }, 20);
      pointCheck = await sendTabMessageWithRetry(tabId, {
        type: MESSAGE.validateClickPoint,
        point: batchButton.result,
        expectedText: '批量下载'
      });
      if (pointCheck.result && pointCheck.result.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!pointCheck || !pointCheck.result || !pointCheck.result.ok) {
      throw new Error(`点击位置安全检查未通过：${pointCheck && pointCheck.result && pointCheck.result.label || '未识别到批量下载按钮'}`);
    }
    await assertTaskActive(taskId, tabId);
    await dispatchAttachedClick(debuggee, batchButton.result);
    return { navigation: navigation.result, batchButton: batchButton.result, pointCheck: pointCheck.result, method: 'browser-input' };
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function clickCurrentDocuments(tabId) {
  if (clicking) return;
  clicking = true;
  let expectedTaskId = null;
  try {
    const state = await getState();
    const batch = state.batchState;
    if (!batch || batch.status !== 'running' || batch.workerTabId !== tabId) return;
    const task = currentTask(batch);
    if (!task || task.analysisType !== ANALYSIS_TYPE.documents || task.phase !== 'opening_analysis') return;
    expectedTaskId = task.id;
    task.phase = 'waiting_download';
    batch.expectedDownloadTaskId = task.id;
    batch.clickIssuedAt = new Date().toISOString();
    await saveBatch(batch);
    await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
    chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 60000 });
    const result = await trustedDocumentDownload(tabId, expectedTaskId);
    logger.info('已点击出让资料批量下载', result);
  } catch (error) {
    await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
    await failCurrentTask(`出让资料批量下载失败：${error.message}`, expectedTaskId);
  } finally {
    clicking = false;
  }
}

async function clickCurrentExport(tabId) {
  if (clicking) return;
  clicking = true;
  let expectedTaskId = null;
  try {
    const state = await getState();
    const batch = state.batchState;
    if (!batch || batch.status !== 'running' || batch.workerTabId !== tabId) return;
    const task = currentTask(batch);
    if (!task || task.status !== 'running' || task.phase !== 'opening_analysis') return;
    expectedTaskId = task.id;
    task.phase = 'waiting_download';
    batch.expectedDownloadTaskId = task.id;
    batch.clickIssuedAt = new Date().toISOString();
    await saveBatch(batch);
    await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
    chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + CONFIG.downloadTimeout });
    const result = await trustedExportClick(tabId, expectedTaskId);
    logger.info('已通过浏览器输入点击下载按钮', result);
  } catch (error) {
    await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
    await failCurrentTask(`下载按钮点击失败：${error.message}`, expectedTaskId);
  } finally {
    clicking = false;
  }
}

async function failCurrentTask(reason, expectedTaskId = null) {
  const state = await getState();
  const batch = state.batchState;
  if (!batch || batch.status !== 'running') return;
  const task = currentTask(batch);
  if (!task) return;
  if (expectedTaskId && task.id !== expectedTaskId) return;
  task.errors = Array.isArray(task.errors) ? task.errors : [];
  task.errors.push({ attempt: task.attempts, reason, time: new Date().toISOString() });
  task.note = task.attempts <= CONFIG.retryCount
    ? `第 ${task.attempts} 次失败，准备强制刷新：${reason}`
    : task.errors.map((item) => `第 ${item.attempt} 次：${item.reason}`).join('；');
  task.phase = 'failed';
  task.status = task.attempts <= CONFIG.retryCount ? 'pending' : 'failed';
  task.downloadId = null;
  batch.currentTaskId = null;
  batch.expectedDownloadTaskId = null;
  await saveBatch(batch);
  await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
  logger.warn(`${task.land.code || task.land.name} - ${analysisLabel(task.analysisType)}：${reason}`);
  await scheduleAdvance(task.status === 'pending' ? 1200 : CONFIG.requestDelay);
}

async function completeCurrentTask(downloadId, savedFilename) {
  const state = await getState();
  const batch = state.batchState;
  if (!batch || batch.status !== 'running') return;
  const task = currentTask(batch);
  if (!task || (task.downloadId && task.downloadId !== downloadId)) return;
  task.status = 'success';
  task.phase = 'complete';
  task.downloadId = downloadId;
  task.savedFilename = savedFilename || task.savedFilename;
  task.note = '';
  batch.currentTaskId = null;
  batch.expectedDownloadTaskId = null;
  await saveBatch(batch);
  await chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM);
  await scheduleAdvance(CONFIG.requestDelay);
}

async function startBatch(lands, types) {
  if (clicking) throw new Error('上一个点击操作正在结束，请稍后再启动');
  if (!Array.isArray(lands) || !lands.length) throw new Error('请至少选择一宗地');
  const validTypes = [...new Set(types || [])].filter((type) => Object.values(ANALYSIS_TYPE).includes(type));
  if (!validTypes.length) throw new Error('请至少选择一种下载内容');
  const batchState = {
    id: `batch-${Date.now()}`,
    status: 'running',
    tasks: buildTasks(lands, validTypes),
    currentTaskId: null,
    expectedDownloadTaskId: null,
    workerTabId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await Promise.all([chrome.alarms.clear(ADVANCE_ALARM), chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM)]);
  await saveBatch(batchState);
  void advanceBatch();
  return batchState;
}

async function cancelBatch() {
  const state = await getState();
  const batch = state.batchState;
  if (!batch || batch.status !== 'running') return batch;
  batch.status = 'cancelled';
  batch.finishedAt = new Date().toISOString();
  for (const task of batch.tasks) {
    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'cancelled';
      task.phase = 'cancelled';
      task.note = '用户已停止任务';
    }
  }
  batch.currentTaskId = null;
  await saveBatch(batch);
  await Promise.all([chrome.alarms.clear(ADVANCE_ALARM), chrome.alarms.clear(DOWNLOAD_TIMEOUT_ALARM)]);
  return batch;
}

async function retryFailedTasks() {
  const state = await getState();
  const batch = state.batchState;
  if (!batch) throw new Error('没有可重试的批量任务');
  let count = 0;
  for (const task of batch.tasks) {
    if (task.status === 'failed') {
      task.status = 'pending';
      task.phase = 'pending';
      task.attempts = 0;
      task.errors = [];
      task.note = '';
      task.downloadId = null;
      count += 1;
    }
  }
  if (!count) throw new Error('当前没有失败项目');
  batch.status = 'running';
  batch.currentTaskId = null;
  batch.finishedAt = null;
  await saveBatch(batch);
  void advanceBatch();
  return batch;
}

async function recoverBatch() {
  const state = await getState();
  const batch = state.batchState;
  if (!batch || batch.status !== 'running') return;
  const task = currentTask(batch);
  if (!task) {
    void advanceBatch();
    return;
  }
  if (task.phase === 'opening_analysis' && batch.workerTabId) {
    try {
      const tab = await chrome.tabs.get(batch.workerTabId);
      if (tab.status === 'complete') void startTaskInteraction(tab.id);
      else {
        const alarm = await chrome.alarms.get(DOWNLOAD_TIMEOUT_ALARM);
        if (!alarm) chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + CONFIG.navigationTimeout });
      }
    } catch (_) {
      await failCurrentTask('无法恢复处理标签页');
    }
    return;
  }
  if ((task.phase === 'downloading' || task.phase === 'direct_downloading') && task.downloadId) {
    const items = await chrome.downloads.search({ id: task.downloadId });
    if (items[0] && items[0].state === 'complete') {
      await completeCurrentTask(task.downloadId, task.savedFilename);
      return;
    }
  }
  if (task.phase === 'waiting_download' || task.phase === 'downloading' || task.phase === 'direct_downloading') {
    const alarm = await chrome.alarms.get(DOWNLOAD_TIMEOUT_ALARM);
    const waitingTimeout = task.analysisType === ANALYSIS_TYPE.documents ? 60000 : CONFIG.downloadTimeout;
    if (!alarm) chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + (task.phase === 'waiting_download' ? waitingTimeout : 120000) });
  }
  if (task.phase === 'waiting_data') {
    const alarm = await chrome.alarms.get(DOWNLOAD_TIMEOUT_ALARM);
    if (!alarm) chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 15000 });
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.analysisTabId === tabId) await chrome.storage.local.set({ analysisTabId: null });
  if (state.batchState && state.batchState.status === 'running' && state.batchState.workerTabId === tabId) {
    await failCurrentTask('处理标签页被关闭');
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') void startTaskInteraction(tabId);
});

chrome.downloads.onCreated.addListener((item) => {
  void (async () => {
    const state = await getState();
    const batch = state.batchState;
    const task = currentTask(batch);
    if (!batch || batch.status !== 'running' || !task) return;
    if (task.phase === 'direct_downloading' && isDirectGeneratedDownload(item)) {
      task.downloadId = item.id;
      await saveBatch(batch);
      chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 120000 });
      return;
    }
    if (task.phase !== 'waiting_download' || !isExpectedDownload(item, batch)) return;
    task.downloadId = item.id;
    task.phase = 'downloading';
    await saveBatch(batch);
    chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 120000 });
  })();
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  void (async () => {
    const state = await getState();
    const batch = state.batchState;
    const task = currentTask(batch);
    if (batch && batch.status === 'running' && task && task.phase === 'direct_downloading' && isDirectGeneratedDownload(item)) {
      const filename = task.savedFilename || taskFilePath(task, 'creis-api-data.xlsx');
      task.downloadId = item.id;
      task.savedFilename = filename;
      await saveBatch(batch);
      suggest({ filename, conflictAction: 'uniquify' });
      chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 120000 });
      return;
    }
    if (!batch || batch.status !== 'running' || !task || !['waiting_download', 'downloading'].includes(task.phase) || !isExpectedDownload(item, batch)) {
      suggest();
      return;
    }
    const filename = taskFilePath(task, item.filename);
    task.downloadId = item.id;
    task.phase = 'downloading';
    task.savedFilename = filename;
    await saveBatch(batch);
    suggest({ filename, conflictAction: 'uniquify' });
    chrome.alarms.create(DOWNLOAD_TIMEOUT_ALARM, { when: Date.now() + 120000 });
  })().catch((error) => {
    logger.error('自动改名失败', error);
    suggest();
  });
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state && !delta.error) return;
  void (async () => {
    const state = await getState();
    const batch = state.batchState;
    const task = currentTask(batch);
    if (!batch || batch.status !== 'running' || !task || task.downloadId !== delta.id) return;
    if (delta.state && delta.state.current === 'complete') {
      await completeCurrentTask(delta.id, task.savedFilename);
    } else if ((delta.state && delta.state.current === 'interrupted') || delta.error) {
      await failCurrentTask(`下载失败：${delta.error && delta.error.current || '下载被中断'}`);
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ADVANCE_ALARM) void advanceBatch();
  if (alarm.name === CAPTURE_TIMEOUT_ALARM) void stopRequestCapture('timeout');
  if (alarm.name === DOWNLOAD_TIMEOUT_ALARM) {
    void (async () => {
      const state = await getState();
      const task = currentTask(state.batchState);
      if (!task) return;
      if (task.phase === 'waiting_data') {
        task.phase = 'opening_analysis';
        task.note = '数据接口未捕获，改用真实点击回退';
        await saveBatch(state.batchState);
        await clickCurrentExport(state.batchState.workerTabId);
      } else if (task.phase === 'opening_analysis') await failCurrentTask('页面加载超时');
      else if (task.phase === 'waiting_download') await failCurrentTask('点击后未检测到下载文件');
      else await failCurrentTask('下载超时，文件未完成');
    })();
  }
});

chrome.runtime.onInstalled.addListener(() => logger.info('扩展已安装，点击下载模式可用'));
chrome.runtime.onStartup.addListener(() => void recoverBatch());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === MESSAGE.getState) {
      void recoverBatch();
      sendResponse(await getState());
      return;
    }
    if (message.type === MESSAGE.injectHook) {
      if (!sender.tab || !sender.tab.id) throw new Error('无法确定需要注入的 CREIS 标签页');
      await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, files: ['src/page-hook.js'], world: 'MAIN' });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MESSAGE.setDebug) {
      const enabled = Boolean(message.enabled);
      await chrome.storage.local.set({ debugMode: enabled });
      await notifyCreisTabs(enabled);
      sendResponse({ ok: true, enabled });
      return;
    }
    if (message.type === MESSAGE.debugRecord) {
      const state = await getState();
      const record = { ...message.record, pageUrl: sender.tab && sender.tab.url || '', capturedAt: new Date().toISOString() };
      await chrome.storage.local.set({ debugLogs: [...state.debugLogs, record].slice(-CONFIG.debugLogLimit) });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MESSAGE.directData) {
      if (!sender.tab || !sender.tab.id) throw new Error('无法确定接口数据来源标签页');
      sendResponse({ ok: true, accepted: await downloadDirectApiData(sender.tab.id, message.payload || {}) });
      return;
    }
    if (message.type === MESSAGE.clearDebug) {
      await chrome.storage.local.set({ debugLogs: [] });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MESSAGE.openAnalysis) {
      sendResponse({ ok: true, ...(await openAnalysis(message.land, message.analysisType)) });
      return;
    }
    if (message.type === MESSAGE.startBatch) {
      sendResponse({ ok: true, batchState: await startBatch(message.lands, message.types) });
      return;
    }
    if (message.type === MESSAGE.cancelBatch) {
      sendResponse({ ok: true, batchState: await cancelBatch() });
      return;
    }
    if (message.type === MESSAGE.retryFailed) {
      sendResponse({ ok: true, batchState: await retryFailedTasks() });
      return;
    }
    if (message.type === MESSAGE.startCapture) {
      sendResponse({ ok: true, captureState: await startRequestCapture(message.analysisType, message.tabId, message.pageUrl) });
      return;
    }
    if (message.type === MESSAGE.trustedClick) {
      if (!Number.isInteger(message.tabId)) throw new Error('无法确定测试点击标签页');
      sendResponse({ ok: true, result: await trustedExportClick(message.tabId) });
      return;
    }
    if (message.type === MESSAGE.stopCapture) {
      sendResponse({ ok: true, captureState: await stopRequestCapture('manual') });
      return;
    }
    if (message.type === MESSAGE.clearCapture) {
      await chrome.alarms.clear(CAPTURE_TIMEOUT_ALARM);
      await chrome.storage.local.set({ captureState: null });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: '未知消息类型' });
  })().catch((error) => {
    logger.error('后台任务失败', error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

void recoverBatch();
