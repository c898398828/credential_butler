# 凭据管家 · Git 提交规范与仓库管理手册 (Git & Repository Guide)

> **版本**：v2.1.0  
> **适用范围**：本仓库的 Git 版本控制、首发提交（Initial Commit）、日常提交规约、分支协同与发布流程。

---

## 目录
1. [仓库概况与项目介绍](#1-仓库概况与项目介绍)
2. [Git 提交信息规范 (Conventional Commits)](#2-git-提交信息规范-conventional-commits)
3. [仓库首发提交全流程操作指南 (Initial Commit)](#3-仓库首发提交全流程操作指南-initial-commit)
4. [推荐的首发 Commit Message 模版](#4-推荐的首发-commit-message-模版)
5. [分支管理策略与版本发布流程](#5-分支管理策略与版本发布流程)
6. [提交前安全审查清单 (Pre-commit Security Checklist)](#6-提交前安全审查清单-pre-commit-security-checklist)

---

## 1. 仓库概况与项目介绍

### 1.1 仓库定位
**凭据管家 (Credential Butler · Multi-Origin Autofill)** 是一款基于 Google Chrome Manifest V3 规范打造的现代化企业级凭据管理与表单自动填充浏览器扩展程序。

### 1.2 项目技术特性
- **纯原生技术栈**：采用原生 JavaScript (ES2022+)、HTML5 与现代 CSS3，零编译打包步骤，零外部 npm 依赖；
- **原生侧边栏常驻 (Side Panel)**：基于 Chrome 116+ 引入的原生 Side Panel API，支持停靠在网页右侧边栏，页面自适应不遮挡，标签页切换即时动态感知；
- **现代商业级设计系统**：遵循现代 SaaS 浅色设计规范（Slate #f8fafc 画布基底与 Royal Blue 品牌色阶），具备清晰的卡片凭据网格与全宽操作坞；
- **确定性安全架构**：
  - 本地离线隔离（`chrome.storage.local`），无云端上传与第三方依赖；
  - Web Locks API 串行化写操作，杜绝并发竞争；
  - PBKDF2 (100,000 轮) + AES-GCM (128-bit) 高强度口令加密离线备份；
  - 严格的 ID-only 运行时消息通信，跨上下文绝不传递明文密码；
  - 站点 Origin、Path 与 Hash 路由全维精确比对，防止钓鱼冒领；
- **金融级复杂表单适配**：专门适配工商银行财资云（Vue 2 + Element UI 自定义密码掩码组件）与普通 Web 表单、开放 Shadow DOM；
- **内置 149 个自动化测试**：基于 Node.js 原生 `node:test`，覆盖数据迁移、权限生命周期、表单竞态防御。

---

## 2. Git 提交信息规范 (Conventional Commits)

本项目遵循国际通用的 **Conventional Commits 1.0.0** 规范，提交信息格式如下：

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### 2.1 提交类型 (`type`)

| 类型 (`type`) | 中文说明 | 适用场景 |
| :--- | :--- | :--- |
| **`feat`** | 新功能 | 引入新特性（如新增侧边栏支持、新增密码生成器、新增选择器匹配） |
| **`fix`** | 缺陷修复 | 修复功能或逻辑 Bug（如修复竞态判断、修复选择器校验、修复输入框回填失效） |
| **`style`** | 代码格式 / 样式优化 | 不影响代码运行逻辑的样式变动（如 CSS 主题重构、UI 间距微调、图标替换） |
| **`refactor`** | 代码重构 | 既不是新增功能也不是修复 Bug 的代码结构优化（如模块抽离、命名统一） |
| **`test`** | 测试用例 | 增加、修改或完善测试用例（如新增 CDP 自动化测试、完善边界测试用例） |
| **`docs`** | 文档更新 | 仅更新文档内容（如开发指南、README、Git 规约、设计规格） |
| **`chore`** | 构建 / 杂务 | 构建脚本、工具库调整或配置项变动（如 `.gitignore`、图标生成脚本） |

### 2.2 影响范围 (`scope`，选填)
可填写的常见模块范围：
- `sidepanel`：Chrome 原生侧边栏及后台调度相关
- `vault`：本地存储、Web Locks 锁机制、加密备份导入
- `content`：页面端扫描、表单填充引擎、竞态防护
- `icbc`：工行财资云专用适配器
- `ui`：弹窗与侧边栏界面、卡片系统、分段控制器
- `sites`：动态权限申请与 Content Script 注册
- `tests`：自动化测试套件

### 2.3 描述信息 (`subject` & `body`)
- **动词开头**：使用祈使语气（如“支持”、“重构”、“修复”、“实现”）；
- **句末不加句号**：主题行简洁明了，字数一般不超过 50~72 字符；
- **详细正文 (Body)**：阐述“为什么做”以及“核心变更点”，换行保持可读性。

---

## 3. 仓库首发提交全流程操作指南 (Initial Commit)

如果这是您首次将该项目提交到 Git 仓库，请按照以下标准步骤在终端中执行：

### 步骤 1：检查工作区状态
```bash
git status
```
确保所有需要纳入版本控制的代码和文档均已准备好，临时日志与编辑器配置文件已通过 `.gitignore` 排除。

### 步骤 2：暂存所有代码与文档
```bash
git add .
```

### 步骤 3：执行首次规范化提交
```bash
git commit -F - << 'EOF'
feat: 凭据管家 2.1 首发版本 (支持 Chrome 原生侧边栏与现代商务浅色界面)

- 实现 Chrome Manifest V3 原生 Side Panel 常驻侧边栏与多标签页活动状态自动感知
- 采用现代商业级浅色设计体系 (Clean Slate & Royal Blue)，重构凭据卡片与底部操作坞
- 建立基于 Web Locks 的 Schema v2 本地存储层，支持 PBKDF2/AES-GCM 口令加密备份与去重导入
- 构建逐站点可选权限管理 (Optional Host Permissions) 与动态 Content Script 注册机制
- 页面端自动填充引擎支持普通 DOM 与 Shadow DOM，内置三重竞态安全防护 (打字、节点、路由)
- 专项适配工商银行财资云 Element UI 掩码密码组件，保障真实输入无冲突
- 包含 149 个全自动化单元与集成测试用例，提供完整的开发者指南与功能规格文档

Co-Authored-By: BaoCode <noreply@baocode.dev>
EOF
```

### 步骤 4：配置主分支名称（推荐 `main`）
```bash
git branch -M main
```

### 步骤 5：关联远程仓库并推送代码
将 `<your-remote-repository-url>` 替换为您的 GitHub/Gitee/GitLab 仓库地址：
```bash
# 关联远程仓库
git remote add origin <your-remote-repository-url>

# 首次推送到远程主分支
git push -u origin main
```

---

## 4. 推荐的首发 Commit Message 模版

若您需要一个中英文双语、可直接用于 GitHub/GitLab 首页首发提交的详细模板，请参考以下内容：

```markdown
feat: initial release of login assistant v2.1.0

- 架构规范: 遵循 Chrome Manifest V3，纯原生 JavaScript (ES2022+) 零打包依赖
- 交互模式: 支持 Chrome 116+ 原生 Side Panel 常驻侧边栏，右侧停靠不遮挡，多标签动态响应
- 视觉系统: 现代企业级 SaaS 浅色设计系统 (Slate + Royal Blue)，自适应全高弹性布局
- 数据安全: 
  * 本地持久化 (chrome.storage.local Schema v2)，通过 Web Locks 解决多窗口写入竞争
  * 离线口令加密备份 (PBKDF2-SHA256 100,000轮 + AES-GCM-128)，防碰撞去重合并导入
  * 运行时跨上下文通信严格遵循 ID-only 机制，绝不跨消息透传明文密码
- 权限机制: 基于 optional_host_permissions 逐站点按需授权，动态注册 Content Script
- 页面填充: 
  * 启发式表单识别，过滤 OTP/2FA/新密码/注册输入框，支持开放 Shadow DOM 深度遍历
  * 三重竞态条件主动防御 (用户键盘按键、DOM 节点替换、页面 Hash 路由变更)
  * 专项兼容工商银行财资云 Vue 2 / Element UI 自定义密码掩码组件
- 质量保障: 内置 149 个自动化测试用例 (node:test)，覆盖率全面，测试执行时间 <2s
- 完整文档: 包含开发者指南 (developer-guide.md)、UI原型规范 (ui-prototype-spec.md) 与 Git 手册

Co-Authored-By: BaoCode <noreply@baocode.dev>
```

---

## 5. 分支管理策略与版本发布流程

### 5.1 分支模型 (Trunk-Based / Git Flow)
- **`main`**：生产就绪主分支。任何时刻都应保证测试全绿，可直接打 Tag 发布安装包。
- **`feat/feature-name`**：新功能开发分支，测试通过后合并至 `main`。
- **`fix/bug-name`**：缺陷修复分支。

### 5.2 版本打标规范 (SemVer)
遵循 **语义化版本号 2.0.0** (`MAJOR.MINOR.PATCH`)：
- `MAJOR`：不兼容的架构或存储破坏性升级；
- `MINOR`：向后兼容的功能新增（如当前 v2.1.0 引入侧边栏）；
- `PATCH`：向后兼容的 Bug 修复。

打标与推送命令：
```bash
# 创建带有签名或注释的版本标签
git tag -a v2.1.0 -m "Release v2.1.0: Chrome Side Panel & Modern Light Theme"

# 推送标签至远程仓库
git push origin v2.1.0
```

### 5.3 发行包发布（Release Asset）
在向 GitHub/Gitee 发布 Release 时，请上传 `release/credential-butler-v2.0.0.zip` 作为附件，供用户直接下载解压安装。

---

## 6. 提交前安全审查清单 (Pre-commit Security Checklist)

在每次执行 `git commit` 与 `git push` 前，请确保完成以下自检：

- [x] **无硬编码机密**：确认源码及测试用例中绝对没有任何真实的个人账号、企业编号或真实密码（全部为虚构测试凭据）。
- [x] **测试通过率 100%**：本地运行 `node --test tests/*.test.cjs` 全部通过（当前 149/149 pass）。
- [x] **发布目录同步**：若修改了 `extension/` 下的核心文件，已同步更新至 `release/extension/` 并重新打成 zip 包。
- [x] **无多余临时文件**：工作区中无 `.log`、临时备份文件或未被 `.gitignore` 过滤的个人系统文件。
- [x] **免责声明**：README 与相关文档中已明确声明本项目与银行官方无隶属关系，仅供个人合规使用。
