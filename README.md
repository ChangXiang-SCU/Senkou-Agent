# Senkou Agent

A locally hosted LaTeX IDE: CodeMirror editor, live PDF preview, multi-provider AI assistant (Claude / OpenAI / Gemini / OpenRouter), Overleaf-style comments, GitHub and Overleaf sync, and Canvas assignment import.

Full documentation: [SwiftLaTeX/README.md](SwiftLaTeX/README.md)

## Requirements

- **Node.js 20.19+** (22 LTS recommended). Node 18 is not enough: `express` 5 and `chokidar` 5 need a newer runtime.
- **A TeX distribution** with `xelatex` / `pdflatex` / `bibtex` on `PATH`: MiKTeX (Windows), MacTeX (macOS) or TeX Live (Linux).
- **Git**, for updates and for the GitHub / Overleaf sync features.

## Install

```bash
git clone https://github.com/ChangXiang-SCU/Senkou-Agent.git
cd Senkou-Agent
mkdir projects
cd SwiftLaTeX
npm install
```

The app lives in `SwiftLaTeX/`; run all `npm` / `node` commands there. Put your LaTeX projects in `Senkou-Agent/projects/`, one folder per project.

## Configure

Copy the template, then fill in only what you use:

```bash
cp config.example.json config.json
```

On Windows Command Prompt use `copy config.example.json config.json`.

| Field | Used for |
|-------|----------|
| `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, `openrouter_api_key` | AI assistant |
| `github_token` | GitHub clone / push / export |
| `overleaf_token` | Overleaf Git sync |
| `canvas_base_url` | Your school's Canvas address, e.g. `https://canvas.your-school.edu` |
| `canvas_ics_url` | Canvas calendar feed (Canvas → Calendar → Calendar Feed) for deadlines |

`config.json` is git-ignored. It holds secrets, so never commit or share it. The same applies to `scrapers/session.json` (your saved Canvas login).

## Run

```bash
npm start
```

Open <http://localhost:3000/compile.html>. Other pages: `/dashboard.html`, `/calendar.html`, `/library.html`.

`npm start` loads `lib/harden.js` before `server.js`: the server listens on `127.0.0.1` only, other websites cannot call the local API, and secret files are not served. The server has no login, so do not expose it to a network you don't trust. Details and the `SENKOU_*` environment variables are in [Security Notes](SwiftLaTeX/README.md#security-notes).

## Test

```bash
npm test
```

## License

Based on [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX) (AGPL-3.0); see `SwiftLaTeX/LICENSE`.
