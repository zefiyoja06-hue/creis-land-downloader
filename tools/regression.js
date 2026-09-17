'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8');

function section(start, end) {
  const from = background.indexOf(start);
  const to = background.indexOf(end, from);
  assert(from >= 0 && to > from, `无法提取测试源码：${start}`);
  return background.slice(from, to);
}

const sandbox = {
  console,
  URL,
  TextEncoder,
  Uint8Array,
  Date,
  btoa,
  CREIS: { CONFIG: { filenameMaxLength: 110 } }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'src/modules/filename.js'), 'utf8'), sandbox, { filename: 'filename.js' });

const source = `
const ANALYSIS_TYPE = { house: 'house', land: 'land', documents: 'documents' };
const CONFIG = { downloadTimeout: 25000 };
function currentTask(batch) { return batch && batch.tasks.find((task) => task.id === batch.currentTaskId) || null; }
${section('function analysisLabel', 'function xmlCell')}
${section('function isEncryptedApiPayload', 'function uint16')}
${section('function xmlCell', 'function bytesToBase64')}
${section('function isCreisDownload', 'function buildTasks')}
globalThis.__test = { taskFilePath, createXlsx, isExpectedDownload, isEncryptedApiPayload };
`;
vm.runInContext(source, sandbox, { filename: 'background-regression-extract.js' });

const { taskFilePath, createXlsx, isExpectedDownload, isEncryptedApiPayload } = sandbox.__test;
const land = { name: '测试/地块', code: 'NO:01', landId: '12345678-ABCD' };

assert.strictEqual(
  taskFilePath({ land, analysisType: 'house', duplicateLandName: false }, 'source.xlsx'),
  'CREIS土地批量下载/NO_01_测试_地块/测试_地块_周边项目成交均价.xlsx'
);
assert.strictEqual(
  taskFilePath({ land, analysisType: 'house', duplicateLandName: true }, 'source.xlsx'),
  'CREIS土地批量下载/NO_01_测试_地块/测试_地块_NO_01_周边项目成交均价.xlsx'
);
assert.strictEqual(
  taskFilePath({ land, analysisType: 'documents', duplicateLandName: true }, 'source.zip'),
  'CREIS土地出让资料/测试_地块_NO_01_出让资料.zip'
);

const documentBatch = {
  currentTaskId: 'doc',
  clickIssuedAt: new Date().toISOString(),
  tasks: [{ id: 'doc', analysisType: 'documents' }]
};
assert(isExpectedDownload({ filename: 'download.zip' }, documentBatch));
assert(isExpectedDownload({ url: 'https://creis.fang.com/download?id=1', mime: 'application/octet-stream' }, documentBatch));
assert(!isExpectedDownload({ url: 'https://creis.fang.com/file.pdf', mime: 'application/pdf' }, documentBatch));
assert(!isExpectedDownload({ url: 'https://example.com/download', mime: 'application/octet-stream' }, documentBatch));

assert(isEncryptedApiPayload({ meta: { code: 1, timestamp: 123 }, data: 'A'.repeat(200) }));
assert(!isEncryptedApiPayload({ meta: { code: 1 }, data: [{ name: '项目甲', price: 12345 }] }));
assert(!isEncryptedApiPayload({ data: '普通文本'.repeat(100) }));

const workbook = createXlsx([{ 名称: '项目甲', 均价: 12345 }, { 名称: '项目乙', 均价: 0 }], '周边项目');
assert.strictEqual(String.fromCharCode(workbook[0], workbook[1]), 'PK');
const archiveText = Buffer.from(workbook).toString('utf8');
for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
  assert(archiveText.includes(name), `XLSX 缺少 ${name}`);
}
assert(archiveText.includes('项目甲'));
assert(archiveText.includes('<v>12345</v>'));

if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), workbook);
console.log('PASS: 文件命名、同名区分、ZIP 识别和 XLSX 容器回归检查通过。');
