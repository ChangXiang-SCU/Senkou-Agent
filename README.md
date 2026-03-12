# Senkou Agent — AI-Powered LaTeX IDE

> A locally-hosted LaTeX IDE with multi-provider AI assistant, real-time compilation, GitHub/Overleaf sync, Canvas integration, and collaborative features. Built to rival Overleaf — but runs on your own machine.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

---

## Features at a Glance

| Feature | Description |
|---------|-------------|
| **Code Editor** | CodeMirror 6 with LaTeX syntax highlighting, autocomplete, bracket matching, code folding, search & replace |
| **Live Compilation** | XeLaTeX / PdfLaTeX auto-detection, file-watch auto-compile, split-pane PDF preview |
| **Multi AI Assistant** | Claude, GPT-4o, Gemini, OpenRouter — reads/edits project files, fixes errors, polishes writing |
| **GitHub Sync** | Clone repos, push projects, full git status/push/pull/log/diff/conflict resolution |
| **Overleaf Sync** | Link, push, pull, clone Overleaf projects via Git |
| **Canvas Integration** | Scrape Cornell Canvas assignments, import deadlines, calendar view |
| **Comments** | Overleaf-style inline comments anchored to specific lines |
| **TODO Management** | Per-project task tracking with categories, priorities, status |
| **Project Compare** | Git diff between projects with color-coded additions/deletions |
| **Dashboard** | Project overview with stats, word counts, paper analysis |
| **Smart File Handling** | Text files open in editor, images preview inline, PDFs in iframe, unknown files show info card |

---

## Table of Contents

- [Environment Requirements](#environment-requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Feature Details](#feature-details)
  - [Code Editor](#1-code-editor)
  - [Live Compilation](#2-live-compilation)
  - [AI Assistant](#3-ai-assistant)
  - [GitHub Sync](#4-github-sync)
  - [Overleaf Sync](#5-overleaf-sync)
  - [Canvas Integration](#6-canvas-integration)
  - [Git Version Control](#7-git-version-control)
  - [Comments System](#8-comments-system)
  - [TODO Management](#9-todo-management)
  - [Project Compare](#10-project-compare)
  - [Dashboard](#11-dashboard)
  - [PDF Analysis](#12-pdf-analysis)
- [AI Assistant Configuration](#ai-assistant-configuration)
- [Daily Usage](#daily-usage)
- [Getting Updates](#getting-updates)
- [Project Structure](#project-structure)
- [FAQ](#faq)
- [Tech Stack](#tech-stack)

---

## Environment Requirements

### 1. Node.js (Required)

Node.js is the runtime for the backend server.

**Windows:**
1. Go to https://nodejs.org/
2. Download **LTS** (v18 or higher recommended)
3. Run installer, click "Next" through all steps
4. Verify in Command Prompt (`Win+R` → `cmd`):
   ```
   node --version
   npm --version
   ```

**macOS:**
```bash
# Homebrew (recommended)
brew install node

# Or download from https://nodejs.org/
```

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. LaTeX Distribution (Required)

A local TeX distribution is needed for compilation.

**Windows — MiKTeX (recommended):**
1. Go to https://miktex.org/download
2. Download and install
3. During install, select **"Install missing packages on the fly: Yes"**
4. Verify: `xelatex --version`

**macOS — MacTeX:**
```bash
brew install --cask mactex
# Or download from https://www.tug.org/mactex/ (~4GB)
```

**Linux — TeX Live:**
```bash
sudo apt-get install texlive-full
```

### 3. Git (Recommended)

Required for cloning the repo, getting updates, and GitHub/Overleaf sync features.

**Windows:** Download from https://git-scm.com/download/win

**macOS:**
```bash
xcode-select --install
```

**Linux:**
```bash
sudo apt-get install git
```

---

## Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/ChangXiang-SCU/Senkou-Agent.git
cd Senkou-Agent
```

> **No Git?** Click the green "Code" button on GitHub → "Download ZIP", then extract.

### Step 2: Install Dependencies

```bash
npm install
```

This downloads all required Node.js packages (express, chokidar, pdf-parse, node-ical, etc.). Takes about 1-2 minutes.

### Step 3: Create Config File

**Windows (Command Prompt):**
```cmd
copy config.example.json config.json
```

**macOS / Linux:**
```bash
cp config.example.json config.json
```

Then edit `config.json` to add your API keys (see [AI Assistant Configuration](#ai-assistant-configuration)).

### Step 4: Start the Server

```bash
node server.js
```

You should see:
```
+------------------------------------------------------------+
|  LaTeX Compiler Server (Multi-Project)                      |
|  URL: http://localhost:3000/compile.html                    |
|  Projects found: 1                                          |
|  Auto-compile: ENABLED                                      |
+------------------------------------------------------------+
```

### Step 5: Open in Browser

```
http://localhost:3000/compile.html
```

The repo includes an example project (`projects/example-hello-world/`) with Chinese/English text, math formulas, code blocks, tables, and bibliography references — ready to compile immediately.

---

## Quick Start

After installation, you can:

1. **Compile the example project** — Select `example-hello-world` from the project dropdown, the PDF preview appears on the right
2. **Edit a file** — Click any `.tex` or `.bib` file in the file tree, edit in the CodeMirror editor, press `Ctrl+S` to save
3. **Try the AI assistant** — Open the AI panel (right side), ask it to explain a LaTeX command or fix an error
4. **Add your own project** — Drop a folder with `.tex` files into the `projects/` directory, refresh the page

---

## Feature Details

### 1. Code Editor

The editor is built on **CodeMirror 6** loaded via CDN (esm.sh):

- **LaTeX syntax highlighting** with the `codemirror-lang-latex` extension
- **Multi-language support** — also highlights JavaScript, Python, JSON, Markdown, CSS, HTML
- **Dark theme** using `@codemirror/theme-one-dark` matching the application's dark UI
- **Autocomplete** for LaTeX commands and environments
- **Search & Replace** (`Ctrl+F` / `Ctrl+H`)
- **Bracket matching** and **code folding**
- **Line numbers** in the gutter
- **Auto-save** — saves after 2 seconds of inactivity
- **Manual save** — `Ctrl+S` / `Cmd+S`
- **Status bar** shows file name, modification status, word count

**Smart file type handling:**
| File Type | Behavior |
|-----------|----------|
| `.tex`, `.bib`, `.sty`, `.cls`, `.html`, `.xml`, `.yml`, `.json`, `.js`, `.py`, `.md`, `.txt`, `.css` | Opens in CodeMirror editor |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp` | Inline image preview |
| `.pdf` | Displayed in iframe viewer |
| Other/binary files | Shows info card (name, size) with download button — no auto-download |

---

### 2. Live Compilation

**Dual engine support with auto-detection:**
- **XeLaTeX** — automatically selected when your `.tex` file uses `\usepackage{xeCJK}`, `\usepackage{fontspec}`, `\usepackage{ctex}`, or `\RequireXeTeX`
- **PdfLaTeX** — used as default for standard LaTeX documents

**Auto-compilation flow:**
1. Chokidar file watcher monitors `projects/` for changes to `.tex`, `.bib`, `.cls`, `.sty`, `.cfg` files
2. Changes trigger debounced compilation (prevents duplicate compiles)
3. Server-Sent Events (SSE) broadcast `compile-start` and `compile-done` events to all connected browsers
4. PDF preview refreshes automatically

**Main file detection priority:** `main.tex` → `resume.tex` → `cv.tex` → `paper.tex` → `thesis.tex` → `document.tex` → first `.tex` file found

**BibTeX support:** If `.bib` files exist in the project, the compiler automatically runs `bibtex` between two `pdflatex` passes for bibliography generation.

**Compilation output:**
- Success: PDF file size, page count
- Failure: Full LaTeX error log with line numbers and warnings

---

### 3. AI Assistant

The AI assistant supports **4 providers** with streaming responses and tool use (file read/edit capabilities).

**Supported Providers & Models:**

| Provider | Models | Auth Methods |
|----------|--------|-------------|
| **Anthropic (Claude)** | Claude Sonnet 4, Claude Haiku 4, Claude Opus 4 | API Key |
| **OpenAI** | GPT-4o, GPT-4o Mini, o3-mini | API Key, OAuth |
| **Google (Gemini)** | Gemini 2.5 Flash, Gemini 2.5 Pro, Gemini 2.0 Flash | API Key, OAuth |
| **OpenRouter** | All of the above + DeepSeek R1 | API Key |

**AI Tool Capabilities:**

The AI can interact with your project files through tool use:

- **`read_file`** — Read any file in your project (up to 500KB). The AI can read your `.tex`, `.bib`, compilation logs, etc.
- **`edit_file`** — Propose file edits with find-and-replace or full rewrite. Shows a diff preview before applying — you approve or reject.
- **`list_files`** — Browse the project file tree to understand project structure.

**Streaming:** All providers stream responses in real-time via SSE — you see the AI's response appear word by word.

**Context:** The AI receives your current file content, project file tree, and recent conversation history (per-project). Max 4096 tokens per response.

**Quick actions:**
- "Explain this LaTeX code" — sends current file
- "Fix compilation errors" — sends error log + main.tex
- "Polish my writing" — sends current file for language improvement

---

### 4. GitHub Sync

Push your LaTeX projects to GitHub or clone existing repos.

**Available operations:**

| Operation | Description |
|-----------|-------------|
| **List Repos** | Shows all your GitHub repositories (up to 100) |
| **Clone Repo** | Clone any GitHub repo into `projects/` as a new project |
| **Export/Push** | Stage all changes, commit, and push to GitHub |

**Setup:** Add your GitHub Personal Access Token to `config.json`:
```json
{
  "github_token": "ghp_xxxxxxxxxxxxxxxxxxxx"
}
```

> Create a token at https://github.com/settings/tokens with `repo` scope.

**Usage in the UI:**
1. Click the Git icon in the toolbar
2. Choose "GitHub" tab
3. Browse your repos or enter a repo URL to clone
4. Use "Push to GitHub" to export a local project

---

### 5. Overleaf Sync

Bidirectional sync with Overleaf projects via Git.

**Available operations:**

| Operation | Description |
|-----------|-------------|
| **Link** | Connect a local project to an Overleaf Git URL |
| **Push** | Push local changes to Overleaf (force push to master) |
| **Pull** | Pull remote changes from Overleaf (handles unrelated histories) |
| **Clone** | Clone an Overleaf project as a new local project |

**Setup:**
1. In Overleaf, go to your project → Menu → Git → copy the Git URL
2. Get your Overleaf Git token from Account Settings

**Usage:**
```json
{
  "overleaf_token": "your-overleaf-git-token"
}
```

> This allows you to work locally with Senkou Agent's AI assistant and full editor, then sync back to Overleaf for collaboration.

---

### 6. Canvas Integration

Import assignments and deadlines from Cornell Canvas LMS.

**Canvas Scraper:**
- Spawns a background Playwright-based scraper (`scrapers/canvas_scraper.js`)
- Scrapes Canvas assignments, downloads attached files
- Creates organized project folders for each assignment

**Canvas Calendar (ICS):**
- Import deadlines via Canvas ICS calendar URL
- Parses ICS format with `node-ical`
- Filters assignments from the past 7 days
- Sorts by due date (soonest first)

**Calendar View (`calendar.html`):**
- Monthly/weekly calendar display
- Color-coded assignment deadlines
- Sidebar with calendar controls
- Click assignments for details
- Light/dark theme support

**Setup:**
1. In Canvas, go to Calendar → Calendar Feed → copy the ICS URL
2. Add to `config.json`:
```json
{
  "canvas_ics_url": "https://canvas.cornell.edu/feeds/calendars/user_xxxxxxx.ics"
}
```

**Access:** Open `http://localhost:3000/calendar.html` for the calendar view.

---

### 7. Git Version Control

Full Git integration built into the editor interface.

| Feature | Description |
|---------|-------------|
| **Status** | Shows current branch, staged/unstaged files, conflict markers, unpushed commit count |
| **Push** | Stage all → commit with message → push to remote |
| **Pull** | Pull from remote with merge conflict detection |
| **Log** | View last 30 commits (hash, author, date, message) |
| **Diff** | View patch and stat for any commit |
| **Conflict Resolution** | Choose "ours" (keep local) or "theirs" (keep remote) for each conflicted file |

Git is auto-configured per project (`user.email: "claude-latex@local"`, `user.name: "Claude LaTeX"`). Projects are auto-initialized as git repos if needed.

---

### 8. Comments System

Overleaf-style inline comments anchored to specific lines in your files.

**How it works:**
- Click the comment icon or use the "Add Comment" button
- Select a file and line number
- Type your comment and save
- Comments appear as gutter icons in the editor
- Click an icon to see the comment thread

**Comment features:**
- **Reply threads** — nested replies within each comment
- **Resolve** — mark comments as resolved when addressed
- **Per-file grouping** — comments organized by file in the comments panel
- **Jump to line** — clicking a comment navigates to the exact file and line

**Storage:** Comments are saved as `.comments.json` in each project directory.

---

### 9. TODO Management

Per-project task tracking with categories, priorities, and status.

**Features:**
- Create new TODOs with task description
- Assign categories (`getting-started`, `feature-explore`, `next-steps`, etc.)
- Set priority (`high`, `medium`, `low`)
- Track status (`pending` → `completed`)
- Visual priority indicators

**Storage:** Saved as `paper_todo.json` in each project. Auto-created if missing.

**Access:** Click the TODO icon in the toolbar to open the panel.

---

### 10. Project Compare

Git diff comparison between two projects.

**How to use:**
1. Click "Compare" in the toolbar
2. Select the first project
3. Select the second project
4. View the diff with color-coded changes:
   - **Green** — new/added lines
   - **Red** — deleted lines

Useful for comparing different versions of a paper or seeing what changed between assignments.

---

### 11. Dashboard

Project overview page accessible at `http://localhost:3000/dashboard.html`.

**Shows:**
- Grid of project cards with visual previews
- Project metadata (name, dates)
- Statistics (word count, page count)
- Quick navigation to any project
- Paper analysis summaries

---

### 12. PDF Analysis

Built-in PDF analysis for research papers.

**Capabilities:**
- **Text extraction** — full-text search across PDF content
- **Section detection** — identifies numbered sections and ALL CAPS headers
- **Abstract extraction** — pulls abstract section from papers
- **Statistics** — page count, word count
- **Content preview** — first 5 lines / 300 chars per section

Useful for quickly understanding the structure of reference papers.

---

## AI Assistant Configuration

The AI assistant supports multiple providers. Configure only the ones you want to use.

### Method 1: API Key (Simplest)

Edit `config.json` and add your API key:

| Provider | Config Field | Get Key | Recommended Model |
|----------|-------------|---------|-------------------|
| OpenAI | `openai_api_key` | https://platform.openai.com/api-keys | gpt-4o |
| Anthropic (Claude) | `anthropic_api_key` | https://console.anthropic.com/ | claude-sonnet-4-20250514 |
| Google (Gemini) | `google_ai_api_key` | https://aistudio.google.com/apikey | gemini-2.5-flash |
| OpenRouter | `openrouter_api_key` | https://openrouter.ai/keys | Any model |

**Example — using Claude only:**
```json
{
  "anthropic_api_key": "sk-ant-your-key-here...",
  "ai_preferences": {
    "last_provider": "anthropic",
    "last_model": "claude-sonnet-4-20250514"
  }
}
```

**Example — using OpenAI only:**
```json
{
  "openai_api_key": "sk-proj-your-key-here...",
  "ai_preferences": {
    "last_provider": "openai",
    "last_model": "gpt-4o"
  }
}
```

### Method 2: OAuth (Advanced)

For Google (Gemini) and OpenAI, you can configure OAuth login instead of API keys. This requires creating an OAuth application on the respective platform and filling in `client_id` and `client_secret` in `config.json`. This is optional — API keys work fine for most users.

### No AI? No Problem

The AI assistant is entirely optional. Without any API key configured, all core features work normally: editor, compilation, preview, comments, TODO, Git sync, etc.

---

## Daily Usage

### Starting

```bash
cd Senkou-Agent
node server.js
```

Then open `http://localhost:3000/compile.html` in your browser.

### Other Pages

| URL | Page |
|-----|------|
| `http://localhost:3000/compile.html` | Main editor + PDF preview |
| `http://localhost:3000/dashboard.html` | Project dashboard |
| `http://localhost:3000/calendar.html` | Canvas calendar |

### Stopping

Press `Ctrl+C` in the terminal.

### Adding a New Project

Drop your LaTeX project folder into `projects/`, then refresh the browser. Each subfolder is a separate project:

```
projects/
+-- example-hello-world/   <-- included example
|   +-- main.tex
|   +-- references.bib
|   +-- paper_todo.json
+-- my-thesis/
|   +-- main.tex
|   +-- chapters/
|   +-- figures/
+-- resume/
|   +-- resume.tex
+-- homework-1/
    +-- homework.tex
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Save current file |
| `Ctrl+F` / `Cmd+F` | Search |
| `Ctrl+H` / `Cmd+H` | Search & Replace |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Tab` | Indent |

---

## Getting Updates

When new features are released, update with:

```bash
cd Senkou-Agent
git pull
npm install
```

> **Your data is safe:** `git pull` will NOT overwrite your `config.json` (it's in `.gitignore`), so your API keys are preserved. Your `projects/` directory is also excluded from git tracking.

If `git pull` shows conflicts, force update (discards local code changes only):

```bash
git fetch origin
git reset --hard origin/main
npm install
```

---

## Project Structure

```
Senkou-Agent/
+-- compile.html          # Main page (editor + PDF preview)
+-- server.js             # Backend server (Express)
+-- config.json           # Your config file (not tracked by git)
+-- config.example.json   # Config template
+-- package.json          # Node.js dependencies
+-- dashboard.html        # Project dashboard page
+-- calendar.html         # Canvas calendar page
+-- index.html            # Landing page
+-- assets/               # Static assets (fonts, images)
+-- css/                  # Stylesheets
+-- engines/              # LaTeX WebAssembly engines
+-- examples/             # Example paper PDFs
+-- projects/             # Your LaTeX projects (not tracked by git)
+-- scrapers/             # Canvas scraper scripts
```

---

## FAQ

### Q: Compilation error "xelatex not found"
**A:** Your system doesn't have a LaTeX distribution installed. Install MiKTeX (Windows), MacTeX (macOS), or TeX Live (Linux), and make sure `xelatex` is available in your terminal.

### Q: Server error "Cannot find module 'express'"
**A:** Node.js dependencies aren't installed. Run `npm install` in the Senkou-Agent directory.

### Q: Port 3000 is already in use
**A:** Another application is using port 3000. Close it, or change the port number at the top of `server.js`.

### Q: AI assistant not working
**A:** Check that your API key is correctly entered in `config.json`. You can also check the AI settings panel in the top-right corner of the editor page.

### Q: Chinese LaTeX compilation fails
**A:** Make sure you're using the XeLaTeX engine (not PdfLaTeX). XeLaTeX natively supports UTF-8 and Chinese fonts. Add `\usepackage{ctex}` to your `.tex` file. Senkou Agent auto-detects this and switches to XeLaTeX.

### Q: `git pull` broke something
**A:** Try reinstalling dependencies: `npm install`, then restart the server.

### Q: How do I connect to Overleaf?
**A:** Get your Overleaf Git URL from Project → Menu → Git. Get your token from Overleaf Account Settings. Add `overleaf_token` to `config.json`. Then use the Overleaf sync panel in the editor.

### Q: How do I import Canvas assignments?
**A:** In Canvas, go to Calendar → Calendar Feed → copy the ICS URL. Add it as `canvas_ics_url` in `config.json`. Open the calendar page or trigger a scrape from the editor.

### Q: Can multiple people use this at the same time?
**A:** Each person should install their own copy. The server runs locally on each machine. Use GitHub or Overleaf sync for collaboration.

---

## Tech Stack

- **Frontend:** Pure HTML/CSS/JavaScript (no build tools), CodeMirror 6 (via CDN)
- **Backend:** Node.js + Express
- **LaTeX Engines:** Local MiKTeX/TeX Live (server-side compilation) + SwiftLaTeX WASM (browser-side)
- **AI Integration:** Anthropic Claude / OpenAI GPT / Google Gemini / OpenRouter (streaming SSE)
- **File Watching:** Chokidar for auto-compilation
- **PDF Parsing:** pdf-parse for document analysis
- **Calendar:** node-ical for Canvas ICS parsing
- **Version Control:** Git CLI integration

## Credits

Built on top of the [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX) open-source project.

## License

AGPL-3.0 License
