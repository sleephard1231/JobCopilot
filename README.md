<div align="center">

# 🤖 小北智能招聘 · JobCopilot

**基于 LLM 的 BOSS 直聘智能求职助手：AI 岗位匹配 + 千岗千面招呼语 + 规则预筛 + 自动投递**

让求职不再重复劳动 —— AI 帮你筛岗位、写招呼语，你只管审核，剩下的交给它。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Edge%20%7C%20Chrome-brightgreen.svg)
![Manifest](https://img.shields.io/badge/Manifest-V3-orange.svg)
![Version](https://img.shields.io/badge/version-v3.0-black.svg)
![AI](https://img.shields.io/badge/AI-OpenAI%20兼容-purple.svg)
![Tests](https://img.shields.io/badge/tests-131%20passed-success.svg)

[功能特性](#-功能特性) · [效果预览](#-效果预览) · [快速开始](#-快速开始) · [工作流程](#-工作流程) · [代码案例](#-代码案例) · [免责声明](#️-免责声明)

</div>

---

## 📖 简介

在 BOSS 直聘海投时，你是否厌倦了：一个个点岗位、复制粘贴千篇一律的招呼语、投到一堆根本不匹配的岗位？

**小北智能招聘（JobCopilot）** 把这套重复劳动自动化：

> 设定关键词 → 自动收集岗位 → **免费规则先剔除一批** → **AI 按你的简历智能筛选** → 你勾选确认 → 自动**逐个**建立联系、发送简历图片和**为每个岗位量身定制的招呼语**。

每条招呼语都基于该岗位的 JD 和你的简历现场生成，开头精准命中岗位核心技能（如「熟悉 Python、数据分析，做过……」），让 HR 一眼看到匹配点。全程有人工审核关，绝不盲投。

## ✨ 功能特性

### 🤖 AI 接口（OpenAI 兼容，多模型）
- **服务商预设**：内置 OpenCode（免填 Key）、DeepSeek V4 Flash / V4 Pro、智谱 GLM-5.3 / GLM-4.7 / GLM-4.7-Flash，选一个自动填好地址与模型；也可填**任意 OpenAI 兼容端点**（OneAPI / 中转站 / Ollama / LM Studio / 自部署代理）
- **一键恢复预设 / 自动迁移**：旧版 DeepSeek 配置升级时自动切到内置预设；换服务商自动清掉内置 Key，避免误用
- **自定义域名授权**：manifest 收紧 `host_permissions`，非白名单端点保存时动态申请授权
- **健壮调用**：429/503 自动退避重试、90s 超时保护、可强制 JSON 输出、关闭思考型模型的 `thinking` 防止正文截断、OpenCode 网关稳定 `x-opencode-session`

### 🧹 规则预筛（可选 · 免费先行）
AI 之前零成本剔除，省 API 额度、也减少无关岗位打扰 HR：
- **公司名单**：黑名单 / 白名单，支持「公司名 @kw」关键词匹配
- **薪资区间**：解析 `10-15K·13薪` / `1.5-2.5万` / `200-400元/天` 等格式做区间重叠判断
- **城市 / 地址排除**、**活跃度**（在线 / 本周 / 本月）、**邀请量上限**、**职位关键词包含/排除**
- **注册资金**：低于下限剔除，可跳过美元资本公司
- **高德通勤**：驾车 / 步行的距离与时间上限（需自备高德 Web 服务 Key，失败自动放行不误伤）

### ✍️ AI 筛选与招呼语
- **AI 智能筛选**：DeepSeek / GLM 等结合简历自动剔除不匹配、超纲岗位，只投够得着的
- **千岗千面招呼语**：结合该岗位完整 JD 现场生成「熟悉 XXX、做过 XXX」格式，精准对口
- **模板兜底**：自定义模板变量 `{{岗位}} {{公司}} {{薪资}} {{地区}} {{HR}} {{技能}} {{关键词}}`，AI 挂了也能发

### ✅ 审核与投递
- **审核确认机制**：投递前列出匹配岗位（含筛选理由），规则剔除项置灰展示，你勾选确认，绝不盲投
- **试算**：对上轮数据重跑规则，不发网络请求、不重置已投记录
- **自动发送简历**：先发简历图片（可选），再发招呼语，一个岗位完整闭环再投下一个
- **平台额度识别**：触发 BOSS 当日沟通名额弹窗时自动收工，不再无效重试

### 🔒 风控与节奏
- **验证值守**：命中安全验证页 / 验证码自动暂停等人工处理，通过后强制冷却
- **熔断**：连续失败达到阈值自动收尾（阈值可配），账号更稳
- **运行策略**：默认投递后休息 45-120 秒、单次上限 8、每日 25；支持工作时段限制、每 N 个长休息、已投去重不重复打扰

### 📊 记录与统计
- **成果统计**：今日 / 本周 / 本月成功数、月度目标进度、近 14 天投递量、各规则拦截 TOP 计数
- **投递记录**：按「公司 + HR」双键去重，避免重复打扰，支持导出 / 导入 JSON
- **实时日志面板**：进度、成功 / 失败一目了然，支持暂停 / 停止 / 重置

## 📸 效果预览

> 主面板：投递控制 + AI 接口 + 简历 + 搜索条件

![主面板](docs/ui-preview.png)

> 成果统计：今日 / 本周 / 本月、月度目标、近 14 天投递量、规则拦截

![成果统计](docs/ui-stats-preview.png)

```
配置岗位/城市/数量  →  免费规则预筛  →  AI 收集筛选  →  审核勾选  →  自动投递  →  ✓ 完成
```

## 🚀 快速开始

### 1. 下载
```bash
git clone https://github.com/sleephard1231/JobCopilot.git
```
或直接 `Code → Download ZIP` 解压。

### 2. 加载扩展（Edge / Chrome 通用）
1. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）
2. 打开右上角 **开发者模式**
3. 点 **加载解压缩的扩展**，选择 **`JobCopilot · AI/`** 文件夹
4. 点击扩展图标，打开侧边栏

### 3. 配置
| 配置项 | 说明 |
|--------|------|
| AI 服务商预设 | 选一个自动填好接口地址与模型；默认 OpenCode 内置免填 Key |
| AI 接口地址 / 模型 / 密钥 | 任意 OpenAI 兼容端点，[DeepSeek 官网申请](https://platform.deepseek.com/)、[智谱开放平台](https://open.bigmodel.cn/) 均可 |
| 简历图片 | 投递时发给 HR 的简历截图（可选） |
| 简历内容 | 用于 AI 筛选与生成招呼语（必填） |
| 招呼语模板 | 可选的兜底模板，AI 不可用时按此发送 |
| 关键词 / 城市 / 数量 | 岗位搜索条件 |

### 4. 使用
**开始收集并筛选** → 在 **审核确认** 区勾选要投的岗位 → **投递选中** → 看着日志自动跑完。

## 🔄 工作流程

```
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌────────────┐   ┌──────────────────────┐
│ 配置条件 │ → │ 收集岗位  │ → │ 规则预筛  │ → │  AI 筛选    │ → │ 人工审核勾选          │
└─────────┘   └──────────┘   └──────────┘   └────────────┘   └──────────────────────┘
                                                                         │
                                                                         ▼
                          对每个选中岗位逐个闭环（含风控值守与拟人节奏）：
                          立即沟通 → 进入聊天 → 发简历图片 → 发定制招呼语 → 下一个
```

## 🛠️ 技术栈

- **浏览器扩展**：Manifest V3，原生 JavaScript（ES2020，无框架、无打包器）
- **AI 模型**：任意 OpenAI 兼容协议（DeepSeek / 智谱 GLM / OpenCode / 自部署…）
- **地理服务**：高德 Web 服务 API（地理编码 + 驾车 / 步行距离）
- **架构**：Service Worker 编排 + Content Scripts 操作页面 + 侧边栏 UI（`chrome.storage.local` 持久化）

## 📁 项目结构

```
JobCopilot/
├── README.md                    # 本文件（仓库主页）
├── docs/                        # 主页截图
└── JobCopilot · AI/             # 扩展本体（加载这个文件夹）
    ├── manifest.json            # MV3 清单（权限 / 内容脚本 / 侧边栏）
    ├── src/
    │   ├── background.js        # 核心编排：收集→规则预筛→AI 筛选→审核→投递 + LLM 调用
    │   ├── filters.js           # 岗位过滤引擎（纯函数，可单测）
    │   ├── amap.js              # 高德通勤计算（地理编码 + 驾车/步行）
    │   ├── selectors.js         # DOM 选择器 + 城市编码
    │   ├── providers.js         # 服务商端点定义
    │   ├── content-search.js    # 搜索页：抓取岗位 + 建立联系
    │   ├── content-chat.js      # 聊天页：发送简历图片 + 招呼语
    │   └── sidepanel.*          # 侧边栏界面（配置 / 审核 / 统计 / 日志）
    ├── tests/                   # Node 层自动化测试 + Edge 冒烟测试
    └── docs/                    # 设计与开发文档、流程图
```

## 🧩 代码案例

### 1. AI 服务商预设（`src/sidepanel.js`）

选一个预设即自动填好接口地址与模型；OpenCode 预设内置 Key，其余需自备。

```js
// 服务商预设：选一个自动填接口地址 + 模型（key 需用户自备，OpenCode 内置）
const PRESETS = {
  opencode:        { label: 'OpenCode',          url: 'https://opencode.ai/zen/go/v1/chat/completions',  model: 'deepseek-v4-flash', builtinKey: true },
  'deepseek-flash':{ label: 'DeepSeek · V4 Flash', url: 'https://api.deepseek.com/chat/completions',     model: 'deepseek-v4-flash' },
  'deepseek-pro':  { label: 'DeepSeek · V4 Pro',  url: 'https://api.deepseek.com/chat/completions',      model: 'deepseek-v4-pro' },
  'glm-5.3':       { label: '智谱 GLM-5.3',       url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-5.3' },
  'glm-4.7':       { label: '智谱 GLM-4.7',       url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4.7' }
};
```

### 2. OpenAI 兼容调用：重试 / 超时 / 关闭思考（`src/background.js`）

```js
async function callLLM(messages, maxTokens, opts) {
  const cfg = await getCfg();
  const body = { model: cfg.apiModel, messages, max_tokens: maxTokens || 500, temperature: 0.5 };
  if (opts && opts.json) body.response_format = { type: 'json_object' };        // 强制 JSON
  if (opts && opts.noThink && /deepseek|glm/i.test(cfg.apiModel)) {
    body.thinking = { type: 'disabled' };                                        // 思考型模型关思考
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs || 90000);  // 超时保护

  for (let attempt = 0; ; attempt++) {
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey };
    if (/opencode\.ai/i.test(cfg.apiBaseUrl)) headers['x-opencode-session'] = await opencodeSessionId();
    const resp = await fetch(cfg.apiBaseUrl, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal
    });
    if ((resp.status === 429 || resp.status === 503) && attempt < 2) {           // 限流退避重试
      await sleep(1000 * (attempt + 1)); continue;
    }
    clearTimeout(timer);
    const data = await resp.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }
}
```

### 3. 规则过滤引擎：薪资解析 + 岗位判定（`src/filters.js`）

纯函数、无 DOM / Storage 依赖，可直接单测。

```js
// '10-15K·13薪' / '1.5-2.5万' / '8千-1.2万' / '200-400元/天' / '面议' → {min,max}（单位 K/月）
function parseSalary(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s || /面议|商议|私聊/.test(s)) return null;
  const m = s.match(/(\d+(?:\.\d+)?)(万|K|k|千)?[-–~](\d+(?:\.\d+)?)(万|K|k|千)?/);
  if (!m) return null;
  const f1 = unitFactor(m[2], s), f2 = unitFactor(m[4], s);
  const lo = parseFloat(m[1]) * f1, hi = parseFloat(m[3]) * f2;
  return { min: Math.round(lo * 10) / 10, max: Math.round(hi * 10) / 10 };
}

// 单岗位规则检查：返回剔除理由（空串=通过）。顺序即短路顺序。
function checkJob(j, cfg) {
  const c = normalize(cfg);
  if (c.listMode === 'black') { const hit = matchList(j.company, c.blacklist); if (hit) return '黑名单：' + hit.name; }
  if (c.listMode === 'white') { const hit = matchList(j.company, c.whitelist); if (!hit) return '白名单外'; }
  const sal = parseSalary(j.salary);
  if (sal && c.salary.min > 0 && sal.max < c.salary.min) return '薪资低于下限（' + j.salary + '）';
  // …城市 / 地址 / 活跃度 / 邀请量 / 关键词 / 注册资金 / 通勤…
  return '';
}
```

### 4. 招呼语模板兜底（`src/background.js`）

AI 优先、模板兜底，变量缺失也不会漏出 `{{...}}`。

```js
const TPL_VARS = [
  { k: ['岗位', 'job'],      v: j => j.name || '' },
  { k: ['公司', 'company'],  v: j => j.company || '' },
  { k: ['薪资', 'salary'],   v: j => j.salary || '' },
  { k: ['地区', 'area'],     v: j => j.area || '' },
  { k: ['HR', 'hr'],         v: j => j.hrName || '' },
  { k: ['技能', 'tags'],     v: j => (j.tags || []).slice(0, 3).join('、') },
  { k: ['关键词', 'keyword'], v: j => j.keyword || '' }
];

function renderTemplate(tpl, job, cfg) {
  let out = String(tpl || '');
  for (const t of TPL_VARS)
    for (const name of t.k)
      out = out.replace(new RegExp('\\{\\{\\s*' + name + '\\s*\\}\\}', 'gi'), () => t.v(job));
  return out.replace(/\{\{[^}]*\}\}/g, '').trim();   // 清掉未识别变量
}
```

### 5. 高德通勤计算（`src/amap.js`）

粗粒度地址（省/市/区县）视为解析失败直接放行，避免把模糊地址匹配到千里之外误杀岗位。

```js
// type: 1=驾车 3=步行；返回 {km, min}，失败 null
async function distanceOne(origin, dest, type, key) {
  const url = AMAP_DIST + '?key=' + encodeURIComponent(key)
    + '&origins=' + encodeURIComponent(origin)
    + '&destination=' + encodeURIComponent(dest) + '&type=' + type + '&output=json';
  const data = await fetchJson(url, 10000);
  if (!data || data.status !== '1' || !data.results?.length) return null;
  const r = data.results[0];
  return { km: Math.round(+r.distance / 100) / 10, min: Math.round(+r.duration / 60) };
}
```

### 6. 消息协议（Service Worker ↔ 内容脚本 ↔ 侧边栏）

| 消息 | 方向 | 载荷 | 响应 |
|------|------|------|------|
| `START_COLLECT` / `START_DELIVER` | panel → SW | — | `{ok}` |
| `SCRAPE` | SW → content-search | `{count}` | `{success, jobs}` |
| `OPEN_JD` | SW → content-search | `{job}` | `{success, jd, hrName, addr}` |
| `GO_CHAT` / `SEND` | SW → content-chat | `{…}` | `{success, quota?}` |
| `RUN_FILTER_DRY` | panel → SW | — | `{ok, kept, dropped}` |
| `SCREENED` / `PHASE` / `PROGRESS` / `LOG` | SW → panel | 进度与状态 | — |
| `GET_STATS` / `CLEAR_STATS` | panel → SW | — | `{ok, stats, goal}` |
| `GET_COMPANIES` / `CLEAR_COMPANIES` | panel → SW | — | `{ok, list}` |

### 7. 关键 storage 键（`chrome.storage.local`）

| 键 | 内容 |
|----|------|
| `apiBaseUrl` / `apiModel` / `apiKey` | AI 端点、模型、密钥 |
| `resumeText` / `resumeImage` | 简历文字 / 简历图片 |
| `keyword` / `city` / `count` | 搜索条件 |
| `filterConfig` | 规则过滤配置（名单 / 薪资 / 城市 / 活跃 / 通勤…） |
| `greetingTemplate` | 兜底招呼语模板 |
| `paceConfig` / `statGoal` | 运行节奏 / 月度目标 |
| `riskConfig` | 风控策略（验证检测 / 熔断阈值） |
| `sentContacts` | 已投递联系人（公司 + HR 双键去重） |
| `deliverStats` / `ruleStats` | 投递统计 / 规则拦截计数 |

## 🧪 测试

项目自带 Node 层自动化测试与 Edge 真机冒烟测试（当前 **131 个用例全部通过**）：

```bash
cd "JobCopilot · AI"
node tests/run-all.js          # 全部 Node 层测试（约 10s）
node tests/run-all.js 过滤引擎  # 只跑某个套件（子串匹配）
node tests/smoke-edge.js       # 真实 Edge 冒烟测试（headless，独立临时配置，不碰用户浏览器）
```

| 测试文件 | 覆盖内容 |
|----------|----------|
| `tests/test-filters.js` | 薪资解析 9 种格式、名单 `@kw`、黑白/关键词/城市/活跃/邀请量/资金、短路顺序 |
| `tests/test-background.js` | 收集 → 规则过滤 → AI 筛选 → 试算 → 投递闭环 → 去重 → 配额/统计 → 消息全链路 |
| `tests/test-content-search.js` | 迷你 DOM 驱动：SCRAPE 全字段、OPEN_JD、GO_CHAT、慢渲染条件等待 |
| `tests/test-content-chat.js` | contenteditable 输入、回车发送、会话匹配、发送未确认失败路径 |
| `tests/test-upgrade.js` | 配额弹窗识别、模板兜底、通勤拦截、配置迁移链 |
| `tests/test-review.js` | 安全验证暂停、连续失败熔断、域名授权、限流重试、超时放行等回归 |
| `tests/smoke-edge.js` | 真机：`--load-extension` 加载扩展 → CDP 校验 SW 与「UI 保存 → storage」全链路 |

## ⚠️ 免责声明

- 本项目仅供 **学习交流与个人效率提升** 使用，请勿用于商业用途或恶意刷量。
- 自动化操作可能违反 BOSS 直聘的用户协议，使用风险由使用者自行承担。
- 请合理设置投递数量与频率，尊重 HR、珍惜每一次沟通机会。
- 作者不对使用本工具产生的任何后果负责。

## 🤝 贡献

欢迎 Issue 和 PR！如果这个项目帮到了你，点个 ⭐ Star 是对我最大的鼓励。

## 📄 License

[MIT](./LICENSE) © 2026

---

> 参考与致谢：[huluobo2237-pixel/JobCopilot](https://github.com/huluobo2237-pixel/JobCopilot)、[Ocyss/boss-helper](https://github.com/ocyss/boss-helper) 等同类开源项目的思路启发。
