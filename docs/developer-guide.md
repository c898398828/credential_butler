# 凭据管家 · 核心技术架构与开发者指南 (Developer Guide)

> **版本**：v2.1.0 (Side Panel & Commercial Light Edition)  
> **运行标准**：Chrome Manifest V3 · 最低 Chrome 版本 116+  
> **技术栈**：原生 JavaScript (ES2022+) · HTML5 · CSS3（零外部依赖、零 npm 打包步骤）

---

## 目录
1. [项目概况与设计原则](#1-项目概况与设计原则)
2. [项目目录与模块划分](#2-项目目录与模块划分)
3. [核心子系统架构与运行机制](#3-核心子系统架构与运行机制)
   - [3.1 数据存储与安全模型 (VaultStore)](#31-数据存储与安全模型-vaultstore)
   - [3.2 站点权限与动态脚本生命周期 (SiteAccess)](#32-站点权限与动态脚本生命周期-siteaccess)
   - [3.3 页面端自动填充引擎与防竞态设计 (Content Engine)](#33-页面端自动填充引擎与防竞态设计-content-engine)
   - [3.4 工商银行财资云专项兼容适配器 (ICBC Adapter)](#34-工商银行财资云专项兼容适配器-icbc-adapter)
   - [3.5 原生常驻侧边栏与多标签响应机制 (Side Panel & Tabs)](#35-原生常驻侧边栏与多标签响应机制-side-panel--tabs)
   - [3.6 核心工具函数与校验体系 (ICBCAutofill)](#36-核心工具函数与校验体系-icbcautofill)
4. [核心安全边界与开发不变量](#4-核心安全边界与开发不变量)
5. [自动化测试体系与质量保障](#5-自动化测试体系与质量保障)
6. [本地开发与调试工作流](#6-本地开发与调试工作流)
7. [代码风格与贡献规约](#7-代码风格与贡献规约)

---

## 1. 项目概况与设计原则

“凭据管家 · 多站点自动填充”是一款遵循 Chrome 扩展最新规范（Manifest V3）的多站点凭据本地安全管理与表单自动填充工具。

### 1.1 核心价值
- **多站点统一管理，单站点多租户**：用户可为任意 Web 登录页录入多套账号，并为每个站点独立指定一个“默认账号”。
- **原生 Chrome 侧边栏常驻（Side Panel）**：支持在浏览器右侧停靠常驻，边浏览网页边操作，彻底解决传统弹窗失去焦点自动关闭的痛点。
- **专有复杂表单与金融云适配**：深度适配普通 Web 登录表单、开放 Shadow DOM，并内建针对工行财资云 Vue 2 / Element UI 特殊掩码输入组件的专用驱动。
- **离线安全与零远程网络请求**：完全杜绝云端上传或远程分析脚本，仅在本机安全隔离存储，支持 PBKDF2 + AES-GCM 高强度口令加密备份。

### 1.2 架构设计准则
1. **Zero-Dependency（零依赖原则）**：不引入 Webpack/Vite 等构建打包步骤，不依赖任何 npm 运行时依赖，保持源码清晰可读，天然免疫供应链依赖漏洞。
2. **Deterministic Security（确定性安全原则）**：跨上下文消息传递绝对禁止传递明文密码；所有表单匹配强制基于全维 Origin 与 Hash 路由精准比对。
3. **Graceful Degrade（优雅降级与竞态防御）**：在用户正在输入、页面路由切换、DOM 节点被框架重建等竞态场景下，始终优先保证用户真实输入不被覆写。

---

## 2. 项目目录与模块划分

```
credential-butler/
├── extension/                  # Chrome 扩展程序源码（开发与未打包目录）
│   ├── manifest.json           # 扩展配置文件：MV3、sidePanel、permissions、content_scripts
│   ├── background.js           # 后台 Service Worker：管理原生侧边栏行为与图标点击激活
│   ├── common.js               # 全局纯函数库：URL 规范化、精确路由匹配、账号字段校验
│   ├── vault.js                # 存储数据层：Web Locks 并发控制、Schema v2、AES-GCM 加密备份
│   ├── sites.js                # 权限与脚本调度层：逐站点可选权限管理、动态 Content Script 注册
│   ├── content.js              # 页面注入引擎：DOM 识别、Shadow DOM 扫描、竞态防护、工行适配器
│   ├── popup.html              # 扩展 UI 结构（侧边栏与弹窗通用视图）
│   ├── popup.css               # 现代商业级浅色设计系统样式表（支持全高弹性自适应）
│   ├── popup.js                # UI 状态控制器：账号管理、多标签页上下文动态响应、事件绑定
│   └── icons/                  # 扩展图标产物（16, 32, 48, 128px）
├── release/                    # 发行目录
│   ├── extension/              # 生产发布就绪的扩展源码镜像
│   └── credential-butler-v2.0.0.zip # Chrome 扩展发行压缩安装包
├── tests/                      # 自动化测试套件（基于 Node.js 原生 node:test）
│   ├── config.test.cjs         # 基础配置、URL 解析与校验逻辑测试
│   ├── vault.test.cjs          # 存储层 CRUD、并发锁、备份导入与迁移测试
│   ├── site-access.test.cjs    # 权限申请、动态脚本注册与消息通信测试
│   ├── content-race.test.cjs   # 表单识别、Shadow DOM、竞态防护与工行组件测试
│   ├── browser-v2.mjs          # CDP 真实浏览器端到端测试（可选）
│   └── live-icbc-v2.mjs        # CDP 真实工行环境兼容性测试（可选）
├── tools/                      # 构建与辅助工具
│   └── make-icons.py           # 高清矢量图标生成脚本（Python + Pillow）
├── docs/                       # 项目架构与设计文档
│   ├── design-v2.md            # 2.0 系统设计详细规格
│   ├── ui-prototype-spec.md    # UI 原型线框图与视觉设计规范
│   ├── developer-guide.md      # 核心技术架构与开发者指南（本文档）
│   └── git-commit-guide.md     # Git 提交规约与版本管理手册
├── CLAUDE.md                   # AI 协作开发指令与项目规则约束
└── README.md                   # 面向最终用户的安装配置与使用手册
```

---

## 3. 核心子系统架构与运行机制

### 3.1 数据存储与安全模型 (`vault.js`)

数据存储于 `chrome.storage.local`，对应键为 `accountVault`。

#### 1. 数据模型（Schema v2）
```typescript
interface AccountVault {
  version: 2;
  enabled: boolean;                      // 全局自动填充开关
  defaultProfiles: Record<string, string>; // 按 Origin (scheme://host:port) 映射 profileId
  profiles: AccountProfile[];            // 账号凭据集合（上限 500 条）
}

interface AccountProfile {
  id: string;                           // UUID-v4 稳定标识
  name: string;                         // 账号备注名称（≤40 字符）
  loginUrl: string;                     // 目标登录页地址（规范化 URL）
  enterpriseId?: string;                // 企业编号 / 组织代码（选填，工行必填 ≤8 字符）
  username: string;                     // 用户名 / 账号
  password: string;                     // 密码原文（保存原始字符，不自动修剪）
  selectors?: {                         // 可选的自定义 CSS 选择器
    enterprise?: string;
    username?: string;
    password?: string;
  };
  createdAt: number;                    // 毫秒时间戳
  updatedAt: number;                    // 毫秒时间戳
}
```

#### 2. 并发写保护（Web Locks API）
为了防止多个扩展窗口（如侧边栏、开发者工具窗口或后台脚本）同时修改凭据造成数据竞争与状态覆盖，`VaultStore` 在写入操作中使用标准 Web Locks 串行化：
```javascript
await navigator.locks.request("login-assistant-vault", async () => {
  const current = await readFromStorage();
  const next = mutator(current);
  await writeToStorage(next);
});
```

#### 3. 加密备份与合并导入体系
- **加密体系**：导出备份时，利用用户的自定义口令（至少 8 字符）通过 `PBKDF2-SHA256`（100,000 次哈希迭代、16 字节强随机盐）派生出密钥，使用 `AES-GCM`（12 字节随机 IV、128 位认证标签）对 JSON 明文进行高强度对称加密。
- **导入安全校验**：文件大小强制限制在 8 MB 以内；若口令错误、密文被篡改或数据包格式损坏，操作立即安全中止，绝不修改本地现有数据。
- **智能去重合并**：按 `Origin + 企业编号 + 账号` 作为三元唯一定位键。如果本地已存在同名账号，导入时保持本地已有密码不变，避免误覆盖。

---

### 3.2 站点权限与动态脚本生命周期 (`sites.js`)

#### 1. 逐站点按需权限申请（Optional Host Permissions）
在 `manifest.json` 中，仅对工行财资云申请了静态 `host_permissions`，其余所有 Web 站点均属于 `optional_host_permissions`：
```json
"optional_host_permissions": ["https://*/*", "http://*/*"]
```
当用户保存某网站账号或点击“允许此网站”时，通过 `chrome.permissions.request({ origins: [sitePattern] })` 在用户手势（User Gesture）上下文发起标准授权弹窗。

#### 2. 动态内容脚本同步（Dynamic Content Script Registration）
只有在**已保存该网站账号**且**用户已明确授予该站点权限**时，扩展才调用 `chrome.scripting.registerContentScripts` 注册持久化的动态内容脚本。
- **注册范围**：仅注册到对应的站点 Origin，且严格限制 `allFrames: false`（仅主框架注入，防止 iframe 钓鱼）。
- **生命周期维护**：当用户删除某个站点的所有账号时，系统会自动解绑该站点对应的动态 Content Script 注册。

#### 3. 免密码明文传输调度（ID-Only Message Protocol）
当用户在侧边栏点击“填写当前页面”时：
- 侧边栏仅向页面注入/发送包含 `{ type: "FILL_REQUEST", profileId: "..." }` 的运行时消息。
- 页面端 `content.js` 收到消息后，自行向本地安全存储 `chrome.storage.local` 查询凭据，**绝不通过跨上下文通信传递明文账号与密码**。

---

### 3.3 页面端自动填充引擎与防竞态设计 (`content.js`)

`content.js` 在匹配页面的 `document_start` 阶段注入，负责侦测与填充。

```
                    ┌─────────────────────────┐
                    │ 页面加载 / 收到填充消息 │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ URL/Origin/路由精确比对 │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ DOM / Shadow DOM 扫描   │
                    │ 寻找可见、可编辑候选输入框│
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┴──────────────────────┐
          │                                             │
┌─────────▼──────────────┐                   ┌──────────▼──────────────┐
│  通用标准表单识别      │                   │ 工行财资云专用适配器    │
│ 排除: OTP/新密码/确认框│                   │ Element UI 掩码星号监听 │
└─────────┬──────────────┘                   └──────────┬──────────────┘
          │                                             │
          └──────────────────────┬──────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ 三重竞态安全检查:        │
                    │ 1. 用户是否刚打字?      │
                    │ 2. DOM 节点是否被重构?  │
                    │ 3. URL Hash 路由是否变? │
                    └────────────┬────────────┘
                                 │ 无竞争
                    ┌────────────▼────────────┐
                    │  安全模拟输入并触发事件 │
                    └─────────────────────────┘
```

#### 1. 双重树扫描（Standard DOM + Open Shadow DOM）
现代前端框架或组件库常使用 Shadow DOM 封装表单，填充引擎递归遍历宿主页面普通 DOM 以及 `shadowRoot.mode === "open"` 的 Shadow DOM 树，确保无遗漏。

#### 2. 表单排除规则（Heuristic Filters）
为了防止将账号密码错误填入非登录场景，引擎严格排除以下元素：
- 隐藏、禁用或 `readOnly` 的输入框；
- `autocomplete` 声明为 `new-password`、`one-time-code` 的注册、修改密码或验证码字段；
- 具有短信、验证码特征名称（如 `sms`, `captcha`, `vcode`, `otp`）的字段。

#### 3. 异步并发与用户输入竞态防护（Race Condition Guards）
填充过程分步执行（先填企业编号、再填账号、最后填密码）：
- 在写入每个字段前后，都会检查当前字段是否被用户手动修改过；
- 若检测到用户正在键盘键入，或者页面路由在填充间隙发生跳转，或者旧 DOM 节点被前端框架（如 React/Vue）卸载销毁，填充流程立即中止，严防将密码误填入新页面。

---

### 3.4 工商银行财资云专项兼容适配器 (`content.js`)

工行财资云（`https://toc.icbc.com.cn/login.html`）采用 Vue 2 + Element UI 架构，其密码输入框为一个封装组件 `.ComPasswordInput`：
1. **真实密码隐藏与星号掩码**：组件在原生 `input` 内部监听 `input` 事件，在后台对象中保留实际密码字符，并在 DOM 表面将其替换为等长星号（`*`）。
2. **事件模拟策略**：
   - 对工行密码组件，必须先清空输入框并派发 `input` 事件，等待微任务循环；
   - 填入新密码后派发原生 `input` 事件，并将光标移动至末尾；
   - **严禁同步派发 `change` 事件**，否则会导致组件提前校验并清空掩码数据。
3. **普通站点策略**：对其他站点表单，正常派发 `input` 与 `change` 事件，确保双向数据绑定（Vue/React/Angular）能够捕获到最新值。

---

### 3.5 原生常驻侧边栏与多标签响应机制 (`popup.js` & `background.js`)

#### 1. Side Panel 行为配置
在 `background.js` 中：
```javascript
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
```
点击扩展图标时自动弹出侧边栏；若浏览器版本不支持该特性，会自动降级为调用 `chrome.sidePanel.open`。

#### 2. 多标签页活动响应（Reactive Tab Context）
侧边栏在用户切换浏览器标签页时保持开启状态。为了确保侧边栏显示的内容始终对应当前激活标签页，在 `popup.js` 中挂载了实时监听器：
```javascript
chrome.tabs.onActivated.addListener(refreshTabContext);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    refreshTabContext();
  }
});
```
- 当用户从“拼多多”切换至“工行”或新建标签时，侧边栏可在 **10 毫秒内** 完成响应，自动刷新当前站点域名指示灯、匹配账号列表和主按钮可用性。

---

### 3.6 核心工具函数与校验体系 (`common.js`)

`common.js` 仅包含无状态的纯逻辑运算，可跨扩展上下文与 Node.js 测试环境复用：
- `originOf(url)`：规范化提取 Origin（处理默认端口 80 与 443，抹除多余斜杠与查询参数）。
- `matchesLoginUrl(pageUrl, savedLoginUrl)`：全维严格匹配。协议、域名、端口、Pathname 必须严格相同；若保存了 Hash 路由，Hash 路径亦必须完全一致。
- `validateProfile(profile)`：入库字段全量强校验（名称 ≤40 字符、企业编号 ≤128 字符且工行强制 ≤8 字符、选择器 ≤256 字符且语法合法）。

---

## 4. 核心安全边界与开发不变量

在维护和扩展本项目代码时，**必须严格遵守以下 5 大核心不变量**：

| 序号 | 规则名称 | 核心约束 |
| :--- | :--- | :--- |
| **1** | **禁止明文穿透** | 跨上下文消息传递（Side Panel → Content Script）严禁携带明文密码，仅允许传递 `profileId`。 |
| **2** | **主框架绝对隔离** | 所有 Content Script 注册和注入必须显式设置 `all_frames: false`，且脚本内部强制校验 `window.top === window`。 |
| **3** | **同源与路由强匹配** | 匹配必须覆盖完整 Origin（协议+域名+端口）与 Pathname/Hash。绝不允许跨域、跨端口或模糊匹配。 |
| **4** | **禁止真实凭据入库** | 单元测试、集成测试、代码提交中严禁出现任何真实账号、密码或个人敏感信息，全部使用虚构测试数据。 |
| **5** | **零第三方网络请求** | 严禁引入任何远程 CDN、外部统计分析、远程字体或第三方 Web API，所有资源全部本地打包。 |

---

## 5. 自动化测试体系与质量保障

本项目包含完善的自动化测试套件，全面覆盖数据迁移、并发锁、备份加解密、动态权限同步及 DOM 竞态防护。

### 5.1 运行测试命令
测试套件使用 Node.js 18+ 原生内置测试运行器 `node:test`，无需安装 Mocha 或 Jest：

```bash
# 运行全部测试套件（当前包含 149 个自动化测试，耗时约 1.6 秒）
node --test tests/*.test.cjs

# 运行单项测试模块
node --test tests/config.test.cjs        # URL 匹配与配置校验测试
node --test tests/vault.test.cjs         # 存储层、并发锁与 AES-GCM 备份测试
node --test tests/site-access.test.cjs   # 动态权限申请与脚本注册测试
node --test tests/content-race.test.cjs  # 页面表单扫描与竞态对抗测试
```

### 5.2 端到端浏览器测试（CDP）
在具备 Chrome 远程调试端口的环境下，可执行真实浏览器集成测试：
```bash
# 启动 Chrome 并开启远程调试端口 9222
chrome.exe --remote-debugging-port=9222 --remote-allow-origins=*

# 执行端到端自动化测试
node tests/browser-v2.mjs 9222
node tests/live-icbc-v2.mjs 9222
```

---

## 6. 本地开发与调试工作流

### 6.1 在 Chrome 中加载扩展
1. 打开 Google Chrome，在地址栏访问 `chrome://extensions`；
2. 开启右上角 **“开发者模式” (Developer mode)** 开关；
3. 点击左上角 **“加载已解压的扩展程序” (Load unpacked)**；
4. 选择本项目源码目录中的 `extension/` 文件夹（即 `D:\projects\插件\credential-butler\extension`）。

### 6.2 调试技巧与建议
- **调试 Side Panel（侧边栏前端）**：
  - 打开侧边栏，在侧边栏任意区域**右键点击 -> 检查 (Inspect)**，即可打开侧边栏专属的 DevTools 面板，查看 Console、Network 及 Elements。
- **调试 Background Service Worker**：
  - 在 `chrome://extensions` 页面找到“凭据管家”，点击“服务工件 (Service Worker)”链接，打开专属后台控制台。
- **调试 In-Page Content Script**：
  - 在目标网页（如登录页）按 `F12` 打开控制台，在 Sources 面板左侧选择 `Content scripts` 分组，即可对 `content.js` 断点调试。
- **热更新逻辑**：
  - 修改 `popup.css`、`popup.html` 或 `popup.js`：只需在侧边栏右键检查并按 `Ctrl+R`（或关闭并重新打开侧边栏）；
  - 修改 `manifest.json`、`background.js` 或 `content.js`：必须前往 `chrome://extensions` 点击扩展卡片上的**刷新图标（⟳）**。

---

## 7. 代码风格与贡献规约

1. **语法特性**：采用现代标准原生 JavaScript（ES2022+），充分使用可选链操作符（`?.`）、空值合并操作符（`??`）、异步/等待（`async/await`）及解构赋值。
2. **零打包约束**：禁止在 `extension/` 中使用需要编译转译的 TypeScript 或 JSX，确保源码即运行时代码。
3. **样式组织**：全局 CSS 变量定义于 `:root`（主题色、字号阶梯、阴影层级、圆角规模），禁止在组件中书写硬编码颜色与内联样式。
4. **测试前置**：任何核心逻辑的修改（尤其是 `vault.js`、`common.js` 和 `sites.js`），在提交前必须确保 `node --test tests/*.test.cjs` 测试通过率为 100%。
