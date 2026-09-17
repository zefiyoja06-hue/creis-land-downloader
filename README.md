# 中指土地批量下载助手（加密响应修复版 0.6.5）

这是一个 Chrome / Microsoft Edge Manifest V3 扩展，用于扫描 CREIS 土地版“推出地块”列表，逐宗地打开周边分析页面，点击下载图标并自动改名。

0.6.5 修复 CREIS 加密响应被误写入 Excel：检测到 `meta + Base64 data` 响应时，立即改用网页原生“下载为表格”，再由扩展完成改名和归档。接口返回明文结构化数据时仍可直接生成 XLSX。上一版的 `landId` 绑定、出让资料 ZIP 识别和点击状态机修复继续保留。

## 当前能力

- 在 `https://creis.fang.com/land/4.0/statistics/release` 扫描当前 DOM 中带 `landId` 的详情链接。
- 提取地块名称、同行地块编号、详情页 URL、`landId` 和可选 `cityId`。
- 勾选地块后，以单并发方式依次打开“周边项目”和“周边土地”页面。
- 根据按钮文字、属性和“距离由近及远”附近位置识别下载图标并点击。
- 使用 `chrome.downloads` 将文件保存到 `下载/CREIS土地批量下载/地块编号_地块名称/`。
- 数据直出统一生成 `.xlsx`：周边项目命名为 `地块名称_周边项目成交均价.xlsx`，周边土地命名为 `地块名称_周边土地推出楼面价.xlsx`。
- 自动识别失败时，可在任一分析页标定一次下载图标的位置。
- 单个下载首次失败后强制刷新页面并绕过缓存；第二次仍失败时记录原因并继续下一项。
- 下载按钮最多查找 8 秒，点击后最多等待 25 秒确认下载；功能性失败不会在同一次尝试中重复等待。
- 标定结果会核对当前页面和按钮状态，避免跨页面坐标误点；禁用的下载按钮会直接进入刷新重试流程。
- 批量任务先定位下载按钮中心，再通过 Edge 调试接口发送鼠标按下和松开事件，使站点收到浏览器级点击。
- 下载完成后使用短延时直接进入下一项，并用后台闹钟保留恢复保险，避免 Edge 闹钟调度造成几十秒空等。
- 已接入 `getPeripheryHouseProjectInfo` 和 `getlandpointinof` 两个实测数据接口；扩展在页面启动时监听响应，不保存 CSRF Token。
- 从接口响应中自动选择记录数组、展开嵌套字段并生成标准 OOXML `.xlsx` 文件。
- 同一批任务中地块名称重复时，文件名自动加入地块编号；编号缺失时使用 `landId` 前八位区分。
- “出让资料压缩包”作为第三个可选任务，与两类周边数据并列执行。
- 出让资料 ZIP 直接保存到 `下载/CREIS土地出让资料/`，不创建地块子文件夹，也不与 Excel 文件混放。
- 出让资料命名为 `地块名称_出让资料.zip`；同名地块自动加入地块编号。
- 点击“批量下载”前重新定位并检查坐标下方的实际元素；检查结果必须包含“批量下载”且不含“收藏/对比”。
- 页面加载、点击后等待下载、文件完成分别设置超时，避免任务长期停在某一宗地。
- 调试模式监听页面主执行环境中的 `fetch` 与 `XMLHttpRequest`，筛选 `xlsx/excel/export/download/blob` 相关请求。
- 复制请求日志或 DOM 诊断，便于按真实页面结构调整选择器和接入真实导出接口。
- 扫描结果、调试开关和日志保存在 `chrome.storage.local`，关闭 Popup 后仍保留。
- 请求捕获模式使用 `chrome.webRequest` 记录当前 CREIS 分析标签页触发的 Fang 域名请求，覆盖 fetch、XHR、表单、跳转和浏览器下载。
- 捕获结果包含 URL、GET/POST、query、POST body、安全请求头、响应类型、Content-Disposition 和候选评分。
- Cookie、Authorization、Token、CSRF、密码、Session、Secret、Ticket 等字段会在保存前脱敏。

## 架构

- `manifest.json`：MV3 入口、最小权限和 CREIS 域名范围。
- `src/background.js`：service worker，保存任务状态、管理单个复用标签页、监听下载、自动改名、重试和超时。
- `src/content.js`：列表页扫描消息桥接，并把页面请求记录转交后台。
- `src/page-hook.js`：运行在网页主环境，hook `fetch` / XHR；不读取或保存 Cookie、Authorization 请求头。
- `src/popup/`：Popup 界面、勾选、打开分析页、复制日志和诊断。
- `src/modules/constants.js`：路径、限流参数和所有候选选择器。
- `src/modules/scanner.js`：`scanLandList()`、URL 参数解析、表头识别和诊断采集。
- `src/modules/automation.js`：`findElementByText()`、MutationObserver 驱动的 `waitForElement()` 与页面等待工具。
- `src/modules/click-automation.js`：识别并点击分析页下载图标，支持相对坐标标定兜底。
- `src/modules/api-client.js`：真实 API 的空配置和分析页 URL 构造；没有推测 endpoint。
- `src/modules/queue.js`：第二阶段可复用的单并发、延迟和重试队列。
- `src/modules/filename.js`：Windows 文件名清洗与长度限制。
- `src/modules/downloader.js`、`zip-manager.js`：第二阶段边界占位，调用时会明确提示接口尚未配置。

## 在 Edge 中加载

1. 打开 `edge://extensions/`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目根目录 `creis-land-downloader`，也就是包含 `manifest.json` 的目录。
5. 如已打开 CREIS 页面，加载扩展后刷新该页面一次。

Chrome 的对应入口是 `chrome://extensions/`，其余步骤相同。

项目自检命令：

```powershell
node .\tools\validate.js
```

## 点击下载测试

1. 登录 CREIS，并进入 `https://creis.fang.com/land/4.0/statistics/release`。
2. 保持要处理的推出地块可见，点击扩展图标。
3. 点击“扫描当前页面”，核对地块名称、编号、`landId` 和 `cityId`。
4. 初次测试只勾选一宗地。需要周边数据时勾选两类 Excel；需要资料包时勾选“出让资料压缩包（单独文件夹）”。三项可以同时选择。
5. 点击“开始一键下载”。插件会复用一个分析标签页，接收页面数据接口响应并生成表格。
6. 接口返回明文结构化数据时，插件直接生成 XLSX；接口未捕获或返回加密数据时，插件会调用网页原生“下载为表格”。
7. 在下载目录检查 `CREIS土地批量下载/地块编号_地块名称/` 下的 Excel，以及 `CREIS土地出让资料/` 根目录下的 ZIP。
8. 若提示“下载按钮没找到”，手动打开任一周边页面，点击插件的“标定下载图标”，回到网页单击右侧下载图标。标定只记录位置，不会执行当次下载。
9. 回到推出地块列表，再次启动任务。

测试和批量运行时请关闭该 CREIS 标签页的 F12 开发者工具，避免它占用同一个调试连接。

进度中的“成功”“失败”“等待”“取消”会分别计数。停止任务后，进度只计算已经实际处理完成的项目，取消项目单独显示。

## 请求捕获测试

1. 在 Edge 的 `edge://extensions/` 找到本插件，点击“重新加载”，然后刷新已打开的 CREIS 页面。
2. 打开任意一宗地的“周边项目”页，确认页面右侧能看到“下载为表格”图标。
3. 打开插件，点击“捕获周边项目”。首次使用时，Edge 会询问 Fang 域名访问权限，点击允许。
4. 回到网页，人工点击一次“下载为表格”，等文件开始下载。
5. 打开该宗地的“周边土地”页，再打开插件并点击“捕获周边土地”。
6. 回到网页，人工点击一次“下载为表格”，等文件开始下载。
7. 再次打开插件。看到周边项目和周边土地前均出现 `✓` 后，点击“复制捕获结果”，把复制的 JSON 发回来。

每次捕获持续 2 分钟。若下载完成后仍显示“正在捕获”，点击“结束并保存最佳候选”。捕获只记录当前分析标签页，并保留评分最高的候选请求。

请求捕获结果用于排查 CREIS 接口变化和下载失败；批量任务会优先使用可解析的接口数据，并在加密响应下自动切换到网页原生下载。

## DOM 不匹配时的诊断

先点击 Popup 中“复制 DOM 诊断”。输出包括表头、详情候选链接、`href`、同行文本样本和按钮文本，可直接发回用于局部修改 `constants.js` 与 `scanner.js`。

也可在 CREIS 页面 DevTools Console 中执行：

```js
(() => ({
  url: location.href,
  headers: [...document.querySelectorAll('thead th,[role="columnheader"]')].map(x => x.innerText.trim()),
  links: [...document.querySelectorAll('a[href]')].map(a => ({text: a.innerText.trim(), href: a.href})).filter(x => /land-detail|landId/i.test(x.href)),
  buttons: [...document.querySelectorAll('button,a,[role="button"]')].map(x => x.innerText.trim()).filter(Boolean)
}))()
```

## F12 备用接口调试

调试 hook 只能覆盖 `fetch` / XHR。浏览器导航、表单提交或站点内部的其他下载机制请用 Network 获取：

1. Chrome / Edge 按 `F12`。
2. 进入 `Network`，选择 `Fetch/XHR`，并清空已有记录。
3. 在“周边项目”页面点击“下载为表格”。
4. 找到新增请求，确认 Response/Preview 或响应类型与 Excel 导出相关。
5. 右键该请求，选择 `Copy` → `Copy as cURL`。
6. 在“周边土地”页面重复一次。
7. 分享 cURL 用于排查时，请删除 Cookie、Authorization、Token 和 CSRF 值；插件运行时复用当前浏览器的已登录会话。

## 使用边界

本项目用于个人研究和已获授权账号中的重复下载操作。使用者应遵守 CREIS 的服务条款、账号权限和数据使用规则。项目不包含登录绕过、验证码绕过、账号共享或服务器端批量抓取功能。

## 权限说明

- `scripting`：把调试 hook 注入 CREIS 页面的主执行环境，并限制在 CREIS host permission 内。
- `storage`：保存扫描结果、调试开关和候选请求日志。
- `tabs`：读取当前 CREIS 标签，并复用单个分析页标签。
- `host_permissions` 为 `https://creis.fang.com/*`，用于页面扫描与点击流程。
- `optional_host_permissions` 为 `https://*.fang.com/*`，只在你启动请求捕获时由 Edge 询问授权，用于识别真实文件导出子域名。
- `webRequest`：在捕获开启后的 2 分钟内读取 Fang 请求与响应元信息并筛选导出候选。
- `debugger`：用于向当前 CREIS 分析标签页发送浏览器级鼠标事件；每次点击后立即解除连接。Edge 会在加载或更新扩展时展示对应权限提示。
- `downloads`：监听点击产生的文件并按地块名称自动改名。
- `alarms`：在 Popup 关闭或 service worker 暂停后继续顺序任务，并处理下载超时。
