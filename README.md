# SwiftLaTeX — 基于浏览器的 LaTeX IDE

> 一个本地运行的 LaTeX IDE，集成 AI 助手、代码编辑器、评论系统和项目管理，对标 Overleaf。

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)

## 功能特性

- **完整的代码编辑器** — 基于 CodeMirror 6，支持 LaTeX 语法高亮、自动补全、括号匹配、代码折叠、搜索替换
- **实时编译预览** — 支持 XeLaTeX / PdfLaTeX 引擎，修改后自动编译，左右分栏实时预览 PDF
- **多 AI 助手** — 支持 Claude (Anthropic)、GPT-4o (OpenAI)、Gemini (Google)、OpenRouter 多个 AI 服务商，可读写项目文件、修复 LaTeX 错误、润色文章
- **评论系统** — 类似 Overleaf 的行内评论功能，评论锚定在编辑器的具体行
- **TODO 管理** — 项目级任务管理，支持分类、优先级、状态跟踪
- **项目对比** — Git diff 对比两个项目的差异，新增/删除内容颜色标注
- **文件类型智能处理** — 文本文件用编辑器打开，图片内联预览，PDF 用 iframe 显示，未知文件显示信息卡片
- **多项目管理** — 自动扫描 `projects/` 目录，支持多项目切换
- **Canvas 日历集成** — 导入 Cornell Canvas 课程日历事件

## 截图

打开 `http://localhost:3000/compile.html` 即可看到主界面。

---

## 环境要求

在安装之前，请确保你的电脑上已经安装了以下软件：

### 1. Node.js（必须）

Node.js 是运行服务器的基础环境。

**Windows：**
1. 打开 https://nodejs.org/
2. 下载 **LTS（长期支持版）**（推荐 v18 或更高）
3. 双击安装包，一路点"Next"即可
4. 安装完成后，打开命令提示符（按 `Win+R`，输入 `cmd`，回车），输入：
   ```
   node --version
   npm --version
   ```
   如果显示版本号（如 `v20.11.0`），说明安装成功。

**macOS：**
```bash
# 方法1：使用 Homebrew（推荐）
brew install node

# 方法2：从官网下载 .pkg 安装包
# https://nodejs.org/
```

**Linux (Ubuntu/Debian)：**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. LaTeX 发行版（必须）

编译 LaTeX 文件需要本地安装 TeX 发行版。

**Windows — MiKTeX（推荐）：**
1. 打开 https://miktex.org/download
2. 下载 MiKTeX 安装程序
3. 安装时选择 **"Install missing packages on the fly: Yes"**（自动安装缺失的宏包）
4. 安装完成后，打开命令提示符，输入：
   ```
   xelatex --version
   ```
   如果显示版本信息，说明安装成功。

**macOS — MacTeX：**
```bash
# 方法1：使用 Homebrew
brew install --cask mactex

# 方法2：从官网下载（约 4GB）
# https://www.tug.org/mactex/
```

**Linux — TeX Live：**
```bash
sudo apt-get install texlive-full
```

### 3. Git（推荐）

用于下载代码和获取后续更新。

**Windows：**
1. 打开 https://git-scm.com/download/win
2. 下载安装，一路默认设置即可
3. 安装完成后重新打开命令提示符，输入：
   ```
   git --version
   ```

**macOS：**
```bash
# 通常已预装，如果没有：
xcode-select --install
```

**Linux：**
```bash
sudo apt-get install git
```

---

## 安装步骤

### 第一步：下载代码

打开终端（Windows 用户打开 **命令提示符** 或 **PowerShell**），运行：

```bash
git clone https://github.com/ChangXiang-SCU/SwiftLaTeX.git
cd SwiftLaTeX
```

> **没有 Git？** 也可以在 GitHub 页面点击绿色的 "Code" 按钮 → "Download ZIP"，然后解压。

### 第二步：安装依赖

在 `SwiftLaTeX` 目录下运行：

```bash
npm install
```

这会自动下载所有需要的 Node.js 包（express、chokidar 等），大约需要 1-2 分钟。

### 第三步：创建配置文件

复制示例配置文件：

**Windows（命令提示符）：**
```cmd
copy config.example.json config.json
```

**macOS / Linux：**
```bash
cp config.example.json config.json
```

然后用任意文本编辑器打开 `config.json`，根据需要填入你的 API Key（详见下方"AI 助手配置"章节）。

### 第四步：创建项目目录

```bash
mkdir projects
```

把你的 LaTeX 项目文件夹放到 `projects/` 目录下。每个子文件夹就是一个项目，例如：

```
projects/
├── 我的论文/
│   ├── main.tex
│   ├── references.bib
│   └── figures/
├── 简历/
│   └── resume.tex
└── 课程作业/
    └── homework.tex
```

### 第五步：启动服务器

```bash
node server.js
```

你会看到类似这样的输出：

```
╔════════════════════════════════════════════════════════════╗
║  LaTeX Compiler Server (Multi-Project)                     ║
║  URL: http://localhost:3000/compile.html                  ║
║  Projects found: 3                                         ║
║  Auto-compile: ENABLED                                     ║
╚════════════════════════════════════════════════════════════╝
```

### 第六步：打开浏览器

在浏览器中打开：

```
http://localhost:3000/compile.html
```

大功告成！🎉

---

## AI 助手配置

AI 助手支持多个服务商，你只需要配置你想用的那一个即可。

### 方式一：使用 API Key（最简单）

编辑 `config.json`，填入对应的 API Key：

| 服务商 | 配置字段 | 获取地址 | 推荐模型 |
|--------|----------|----------|----------|
| OpenAI | `openai_api_key` | https://platform.openai.com/api-keys | gpt-4o |
| Anthropic (Claude) | `anthropic_api_key` | https://console.anthropic.com/ | claude-sonnet-4-20250514 |
| Google (Gemini) | `google_ai_api_key` | https://aistudio.google.com/apikey | gemini-2.0-flash |
| OpenRouter | `openrouter_api_key` | https://openrouter.ai/keys | 按需选择 |

例如，只使用 OpenAI：
```json
{
  "openai_api_key": "sk-proj-你的key...",
  "ai_preferences": {
    "last_provider": "openai",
    "last_model": "gpt-4o"
  }
}
```

### 方式二：使用 OAuth（高级）

对于 Google 和 OpenAI，还可以配置 OAuth 登录。需要在对应平台创建 OAuth 应用并填入 client_id 和 client_secret。这是可选的高级配置，普通用户直接用 API Key 即可。

### 不配置 AI 也能用

AI 助手是可选功能。即使不配置任何 API Key，编辑器、编译、预览、评论、TODO 等核心功能都能正常使用。

---

## 日常使用

### 启动

每次使用前，打开终端进入项目目录并启动服务器：

```bash
cd SwiftLaTeX
node server.js
```

然后在浏览器打开 `http://localhost:3000/compile.html`。

### 停止

在终端按 `Ctrl+C` 即可停止服务器。

### 添加新项目

把 LaTeX 项目文件夹直接放到 `projects/` 目录下，刷新浏览器页面即可看到新项目。

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` / `Cmd+S` | 保存当前文件 |
| `Ctrl+F` / `Cmd+F` | 搜索 |
| `Ctrl+H` / `Cmd+H` | 搜索替换 |
| `Ctrl+Z` / `Cmd+Z` | 撤销 |
| `Tab` | 缩进 |

---

## 获取更新

当有新版本发布时，你的朋友们可以通过以下命令获取最新代码：

```bash
cd SwiftLaTeX
git pull
npm install
```

> **注意：** `git pull` 不会覆盖你的 `config.json`（因为它在 `.gitignore` 中），你的 API Key 配置会被保留。`projects/` 目录也不会受影响。

如果在 `git pull` 时遇到冲突，可以用以下命令强制更新（会丢弃本地修改）：

```bash
git fetch origin
git reset --hard origin/main
npm install
```

---

## 项目结构

```
SwiftLaTeX/
├── compile.html        # 主页面（编辑器 + PDF 预览）
├── server.js           # 后端服务器
├── config.json         # 你的配置文件（不会被 git 跟踪）
├── config.example.json # 配置文件模板
├── package.json        # Node.js 依赖声明
├── dashboard.html      # 仪表盘页面
├── calendar.html       # 日历页面
├── index.html          # 首页
├── assets/             # 静态资源（字体、图片等）
├── css/                # 样式文件
├── engines/            # LaTeX WebAssembly 引擎
├── examples/           # 示例模板
├── projects/           # 你的 LaTeX 项目（不会被 git 跟踪）
└── scrapers/           # Canvas 爬虫脚本
```

---

## 常见问题

### Q: 编译报错 "xelatex not found"
**A:** 你的电脑没有安装 LaTeX 发行版。请安装 MiKTeX（Windows）、MacTeX（macOS）或 TeX Live（Linux），并确保 `xelatex` 命令在终端中可用。

### Q: 启动服务器报错 "Cannot find module 'express'"
**A:** 没有安装 Node.js 依赖。在 SwiftLaTeX 目录下运行 `npm install`。

### Q: 端口 3000 被占用
**A:** 其他程序正在使用 3000 端口。关闭占用端口的程序，或者修改 `server.js` 顶部的端口号。

### Q: AI 助手不工作
**A:** 检查 `config.json` 中是否正确填入了 API Key。可以在页面右上角的 AI 设置面板中查看当前配置状态。

### Q: 中文 LaTeX 编译失败
**A:** 确保使用 XeLaTeX 引擎（而非 PdfLaTeX）。XeLaTeX 原生支持 UTF-8 和中文字体。在 `.tex` 文件中使用 `\usepackage{ctex}` 宏包。

### Q: `git pull` 之后功能异常
**A:** 尝试重新安装依赖：`npm install`，然后重启服务器。

---

## 技术栈

- **前端：** 纯 HTML/CSS/JavaScript（无构建工具），CodeMirror 6（通过 CDN 加载）
- **后端：** Node.js + Express
- **LaTeX 引擎：** 本地 MiKTeX/TeX Live（服务端编译）+ SwiftLaTeX WASM（浏览器端编译）
- **AI 集成：** Anthropic Claude / OpenAI GPT / Google Gemini / OpenRouter

## 致谢

基于 [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX) 开源项目开发。

## 许可证

AGPL-3.0 License
