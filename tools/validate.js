'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

check(manifest.manifest_version === 3, 'manifest_version 必须为 3');
check(manifest.background && manifest.background.service_worker === 'src/background.js', '缺少 MV3 service worker');
check(Array.isArray(manifest.host_permissions) && manifest.host_permissions.length === 1 && manifest.host_permissions[0] === 'https://creis.fang.com/*', 'host_permissions 必须只包含 CREIS');
check(!JSON.stringify(manifest).includes('<all_urls>'), '禁止使用 <all_urls>');
check(manifest.permissions.includes('downloads'), '点击下载版需要 downloads 权限完成自动改名');
check(manifest.permissions.includes('alarms'), '点击下载版需要 alarms 权限恢复顺序任务和处理超时');
check(manifest.permissions.includes('webRequest'), '请求捕获模式需要 webRequest 权限');
check(Array.isArray(manifest.optional_host_permissions) && manifest.optional_host_permissions.includes('https://*.fang.com/*'), '请求捕获模式需要可选 Fang 子域名权限');
check(manifest.version === '0.6.5', '当前加密响应修复版版本号应为 0.6.5');
check(manifest.permissions.includes('debugger'), '浏览器级点击需要 debugger 权限');
const mainHook = manifest.content_scripts.find((entry) => entry.world === 'MAIN' && entry.js.includes('src/page-hook.js'));
check(mainHook && mainHook.run_at === 'document_start', '接口响应钩子必须在 MAIN world 的 document_start 加载');

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((entry) => entry.js)
];
for (const relativePath of referencedFiles) {
  check(fs.existsSync(path.join(root, relativePath)), `Manifest 引用文件不存在：${relativePath}`);
}

const jsFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.js')) jsFiles.push(fullPath);
  }
}
walk(path.join(root, 'src'));
for (const file of jsFiles) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
execFileSync(process.execPath, [path.join(root, 'tools/regression.js')], { stdio: 'pipe' });

const sandbox = { console, URL, URLSearchParams, setTimeout, clearTimeout, location: { href: 'https://creis.fang.com/land/4.0/statistics/release' } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const relativePath of ['src/modules/constants.js', 'src/modules/logger.js', 'src/modules/filename.js', 'src/modules/scanner.js', 'src/modules/api-client.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), sandbox, { filename: relativePath });
}

const sampleDetail = 'https://creis.fang.com/land/4.0/land-detail/bidding-detail?landId=LAND-123&cityId=CITY-9&keep=1';
const parsed = sandbox.CREIS.scanner.parseDetailUrl(sampleDetail);
check(parsed.landId === 'LAND-123' && parsed.cityId === 'CITY-9', 'URL 参数解析失败');
const analysisUrl = new URL(sandbox.CREIS.apiClient.buildAnalysisUrl({ detailUrl: sampleDetail, landId: parsed.landId, cityId: parsed.cityId }, 'house'));
check(analysisUrl.pathname.endsWith('/analysis-comparehouse'), '周边项目路径构造失败');
check(analysisUrl.searchParams.get('keep') === '1', '详情页未知参数未被保留');
check(sandbox.CREIS.apiClient.buildAnalysisUrl({ detailUrl: sampleDetail, landId: parsed.landId, cityId: parsed.cityId }, 'documents') === sampleDetail, '出让资料必须从真实详情页入口打开');
check(sandbox.CREIS.filename.sanitizeFilename(' A/B:C*D? ') === 'A_B_C_D_', 'Windows 文件名清洗失败');
check(sandbox.CREIS.apiClient.API_CONFIG.house === null && sandbox.CREIS.apiClient.API_CONFIG.land === null, '未知 API 配置必须为空');
check(sandbox.CREIS.CONFIG.retryCount === 1, '点击下载任务必须只刷新重试一次');
check(sandbox.CREIS.CONFIG.requestDelay >= 1000, '批量点击间隔应至少为 1 秒');
check(sandbox.CREIS.CONFIG.buttonTimeout <= 10000, '下载按钮查找超时应控制在 10 秒内');
check(sandbox.CREIS.CONFIG.downloadTimeout <= 30000, '点击后下载检测超时应控制在 30 秒内');
check(sandbox.CREIS.MESSAGE.startCapture === 'START_REQUEST_CAPTURE', '缺少开始请求捕获消息');
check(sandbox.CREIS.MESSAGE.stopCapture === 'STOP_REQUEST_CAPTURE', '缺少结束请求捕获消息');
check(sandbox.CREIS.MESSAGE.locateExport === 'LOCATE_EXPORT_BUTTON', '缺少下载按钮定位消息');
check(sandbox.CREIS.MESSAGE.trustedClick === 'TRUSTED_EXPORT_CLICK', '缺少浏览器级点击消息');
check(sandbox.CREIS.MESSAGE.directData === 'DIRECT_API_DATA', '缺少接口数据转发消息');
check(sandbox.CREIS.MESSAGE.locateDocumentBatch === 'LOCATE_DOCUMENT_BATCH_DOWNLOAD', '缺少出让资料批量下载定位消息');
check(sandbox.CREIS.MESSAGE.validateClickPoint === 'VALIDATE_CLICK_POINT', '缺少点击位置安全校验消息');
check(sandbox.CREIS.ANALYSIS_TYPE.documents === 'documents', '缺少出让资料任务类型');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes("task.phase === 'direct_downloading'"), '直出下载必须使用独立命名状态');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes('createXlsx(rows'), '周边数据必须生成真实 XLSX 容器');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes("sourceLandId !== task.land.landId"), '接口响应必须按 landId 绑定当前任务');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes('duplicateLandName'), '同名地块文件必须加入编号区分');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes('? `${rootFolder}/${base}${extension}`'), '出让资料 ZIP 必须直接保存在资料根目录');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes('looksLikeSingleDocument'), '出让资料下载识别必须排除单个 PDF/Office/图片文件');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes('recentlyClicked && isCreisDownload(item)'), '出让资料下载识别必须兼容 CREIS 通用二进制 ZIP');
check(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').includes('isEncryptedApiPayload(payload.data)'), '加密接口响应必须回退网页原生导出');

if (failures.length) {
  console.error(failures.map((item) => `FAIL: ${item}`).join('\n'));
  process.exit(1);
}
console.log(`PASS: Manifest、${jsFiles.length} 个脚本及核心 URL/文件名逻辑检查通过。`);
