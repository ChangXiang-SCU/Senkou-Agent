# Claude LaTeX

A local LaTeX compilation and PDF viewing system with a modern dark theme UI.

## Features

- **Real-time PDF Preview**: View compiled PDFs directly in the browser
- **Auto-compilation**: Automatically recompiles when files change
- **Project Management**: Organize multiple LaTeX projects with version folders
- **Recently Modified Indicator**: Green dot shows projects modified within 5 minutes
- **Session Persistence**: Remembers last viewed project across browser refreshes
- **Collapsible Console**: View compilation logs when needed

## Project Structure

```
Claude-Latex/
├── SwiftLaTeX/              # Core application
│   ├── server.js            # Node.js server for file serving & compilation
│   ├── compile.html         # Main UI (Claude LaTeX viewer)
│   ├── package.json         # Dependencies
│   └── ...
├── projects/                # LaTeX projects folder
│   └── CHI26_Poster/        # Example project
│       ├── main.tex
│       ├── sections/
│       ├── figures/
│       └── reference.bib
└── .gitignore
```

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- A LaTeX distribution (e.g., TeX Live, MacTeX) for local compilation

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/JsnDg/Claude-Latex.git
   cd Claude-Latex
   ```

2. Install dependencies:
   ```bash
   cd SwiftLaTeX
   npm install
   ```

3. Start the server:
   ```bash
   node server.js
   ```

4. Open in browser:
   ```
   http://localhost:3000/compile.html
   ```

## Adding Projects

Create a new project folder inside the `projects/` directory:

```
projects/
└── My Project/
    ├── main.tex
    ├── sections/        # Optional: split content into multiple files
    ├── figures/         # Optional: images and figures
    └── reference.bib    # Optional: bibliography
```

The system automatically detects projects containing `main.tex` (or `paper.tex`, `resume.tex`, `cv.tex`, etc.).

**Note:** Only `projects/CHI26_Poster/` is tracked by git as an example. Other projects in `projects/` are ignored and won't be pushed to the repository.

## Tech Stack

- **Frontend**: Vanilla JavaScript, CSS3 with custom properties
- **Backend**: Node.js with Express
- **LaTeX Engine**: SwiftLaTeX (WebAssembly-based) + local pdflatex
- **PDF Rendering**: PDF.js

## License

Based on [SwiftLaTeX](https://github.com/nickstenning/swiftlatex) - see LICENSE file for details.
