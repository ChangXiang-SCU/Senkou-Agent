const express = require('express');
const ical = require('node-ical');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pdfParse = require('pdf-parse');
const chokidar = require('chokidar');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = 3000;

// SSE clients for real-time updates
let sseClients = [];

// Base directory for LaTeX projects
// Try ../projects first (nested dev layout), then ./projects (standard clone)
const PROJECTS_PARENT = path.resolve(__dirname, '..', 'projects');
const PROJECTS_LOCAL = path.resolve(__dirname, 'projects');
const PROJECTS_BASE = fs.existsSync(PROJECTS_PARENT) ? PROJECTS_PARENT : PROJECTS_LOCAL;

// LaTeX engine paths — auto-detect from PATH, fallback to explicit paths
function findExecutable(name, fallback) {
    try {
        const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
        return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    } catch {
        return fallback;
    }
}
const PDFLATEX = findExecutable('pdflatex', 'pdflatex');
const XELATEX = findExecutable('xelatex', 'xelatex');
const BIBTEX = findExecutable('bibtex', 'bibtex');

// Detect if a project needs XeLaTeX (Chinese fonts, fontspec, etc.)
function needsXeLatex(projectPath) {
    try {
        const files = fs.readdirSync(projectPath);
        const texAndCls = files.filter(f => f.endsWith('.tex') || f.endsWith('.cls') || f.endsWith('.sty'));
        for (const file of texAndCls) {
            const content = fs.readFileSync(path.join(projectPath, file), 'utf8');
            if (/\\usepackage\{xeCJK\}|\\RequirePackage\{xltxtra\}|\\RequireXeTeX|\\usepackage\{fontspec\}/.test(content)) {
                return true;
            }
        }
    } catch (e) { }
    return false;
}
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

// ============================================================
// Global Config (Tokens)
// ============================================================
const CONFIG_FILE = path.join(__dirname, 'config.json');

function getConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) { console.error('Error reading config:', e); }
    return { github_token: '', overleaf_token: '', openai_api_key: '' };
}

function saveConfig(newConfig) {
    try {
        const current = getConfig();
        const updated = { ...current, ...newConfig };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
        return updated;
    } catch (e) { console.error('Error writing config:', e); return {}; }
}

// API: Get global config
app.get('/api/config', (req, res) => {
    res.json(getConfig());
});

// API: Save global config
app.post('/api/config', (req, res) => {
    const updated = saveConfig(req.body);
    res.json({ success: true, config: updated });
});

// Common main file names for LaTeX projects
const MAIN_TEX_FILES = ['main.tex', 'resume.tex', 'cv.tex', 'paper.tex', 'thesis.tex', 'document.tex'];

// Find the main tex file in a directory
function findMainTexFile(dirPath) {
    try {
        const files = fs.readdirSync(dirPath);
        // Check for known main file names in order of priority
        for (const mainName of MAIN_TEX_FILES) {
            if (files.includes(mainName)) {
                return mainName;
            }
        }
        // If no known main file, check if there's exactly one .tex file
        const texFiles = files.filter(f => f.endsWith('.tex') && !f.startsWith('.'));
        if (texFiles.length === 1) {
            return texFiles[0];
        }
        return null;
    } catch {
        return null;
    }
}

// Get all .tex files in a project directory (recursively)
function getTexFiles(projectPath, mainFileName = 'main.tex') {
    const texFiles = [];

    function scanDir(dir, prefix = '') {
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.')) continue;
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    // Scan subdirectories like 'sections'
                    scanDir(fullPath, prefix ? `${prefix}/${item}` : item);
                } else if (item.endsWith('.tex')) {
                    const displayName = prefix ? `${prefix}/${item}` : item;
                    texFiles.push({
                        name: displayName,
                        path: fullPath,
                        isMain: item === mainFileName
                    });
                }
            }
        } catch (err) {
            console.error('Error scanning tex files:', dir, err);
        }
    }

    scanDir(projectPath);
    // Sort: main file first, then alphabetically
    texFiles.sort((a, b) => {
        if (a.isMain) return -1;
        if (b.isMain) return 1;
        return a.name.localeCompare(b.name);
    });
    return texFiles;
}

// Scan for LaTeX projects (directories containing main tex file) - supports nested structure
function getProjects() {
    const projects = [];

    function scanDir(dir, prefix = '') {
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.') || item === 'SwiftLaTeX' || item === 'Examples') continue;

                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) {
                    const mainFile = findMainTexFile(fullPath);
                    const hasInstructions = fs.existsSync(path.join(fullPath, 'instructions.html'));
                    const hasPackageJson = fs.existsSync(path.join(fullPath, 'package.json'));

                    if (mainFile || hasInstructions || hasPackageJson) {
                        const displayName = prefix ? `${prefix}/${item}` : item;

                        let lastModified = 0;
                        let hasPdf = false;
                        let texFiles = [];
                        let isCodeProject = hasPackageJson && !mainFile;
                        let isWorkspace = hasInstructions && !mainFile;

                        if (mainFile) {
                            const texFile = path.join(fullPath, mainFile);
                            const pdfFile = path.join(fullPath, mainFile.replace('.tex', '.pdf'));
                            hasPdf = fs.existsSync(pdfFile);
                            lastModified = fs.statSync(texFile).mtimeMs;
                            texFiles = getTexFiles(fullPath, mainFile);
                        } else {
                            // Non-LaTeX project
                            lastModified = fs.statSync(fullPath).mtimeMs;
                        }

                        projects.push({
                            id: Buffer.from(fullPath).toString('base64'),
                            name: displayName,
                            path: fullPath,
                            mainFile: mainFile || null,
                            hasPdf: hasPdf,
                            lastModified: lastModified,
                            texFiles: texFiles,
                            hasMultipleFiles: texFiles.length > 1,
                            type: mainFile ? 'latex' : (isCodeProject ? 'code' : 'workspace')
                        });
                    } else {
                        // Scan subdirectories
                        scanDir(fullPath, prefix ? `${prefix}/${item}` : item);
                    }
                }
            }
        } catch (err) {
            console.error('Error scanning:', dir, err);
        }
    }

    scanDir(PROJECTS_BASE);
    return projects;
}

// Get file tree for a directory (for code projects)
function getFileTree(dirPath, maxDepth = 3) {
    const tree = [];
    const ignoreDirs = ['node_modules', '.git', 'dist', '.next', '__pycache__', '.claude', 'venv', '.venv'];
    const ignoreFiles = ['.DS_Store', '.env', 'package-lock.json', 'yarn.lock'];

    function scan(dir, depth = 0) {
        if (depth > maxDepth) return [];
        const items = [];
        try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                if (entry.startsWith('.') && entry !== '.env.example') continue;
                if (ignoreDirs.includes(entry) || ignoreFiles.includes(entry)) continue;

                const fullPath = path.join(dir, entry);
                const stat = fs.statSync(fullPath);
                const item = {
                    name: entry,
                    path: fullPath,
                    isDirectory: stat.isDirectory()
                };
                if (stat.isDirectory()) {
                    item.children = scan(fullPath, depth + 1);
                }
                items.push(item);
            }
            // Sort: directories first, then files, alphabetically
            items.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });
        } catch (err) {
            console.error('Error scanning file tree:', dir, err);
        }
        return items;
    }

    return scan(dirPath);
}

// Scan for code projects (directories without main.tex but with package.json or src folder)
function getCodeProjects() {
    const codeProjects = [];
    const ignoreDirs = ['SwiftLaTeX', 'Examples', 'node_modules', '.git'];

    function scanDir(dir, prefix = '') {
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.') || ignoreDirs.includes(item)) continue;

                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) {
                    const hasMainTex = fs.existsSync(path.join(fullPath, 'main.tex'));
                    const hasPackageJson = fs.existsSync(path.join(fullPath, 'package.json'));
                    const hasSrcFolder = fs.existsSync(path.join(fullPath, 'src'));

                    if (!hasMainTex && (hasPackageJson || hasSrcFolder)) {
                        // This is a code project
                        const displayName = prefix ? `${prefix}/${item}` : item;
                        codeProjects.push({
                            id: Buffer.from(fullPath).toString('base64'),
                            name: displayName,
                            path: fullPath,
                            type: 'code',
                            fileTree: getFileTree(fullPath)
                        });
                    } else if (!hasMainTex) {
                        // Scan subdirectories
                        scanDir(fullPath, prefix ? `${prefix}/${item}` : item);
                    }
                }
            }
        } catch (err) {
            console.error('Error scanning code projects:', dir, err);
        }
    }

    scanDir(PROJECTS_BASE);
    return codeProjects;
}

// Scan for example PDFs in Examples folders
function getExamples() {
    const examples = [];

    function scanDir(dir, category = '') {
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.') || item === 'SwiftLaTeX') continue;

                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (item === 'Examples') {
                        // Found an Examples folder, scan for PDFs
                        const pdfFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.pdf'));
                        for (const pdf of pdfFiles) {
                            const pdfPath = path.join(fullPath, pdf);
                            const displayName = pdf.replace('.pdf', '');
                            examples.push({
                                id: Buffer.from(pdfPath).toString('base64'),
                                name: displayName,
                                category: category,
                                path: pdfPath
                            });
                        }
                    } else {
                        // Continue scanning subdirectories
                        scanDir(fullPath, item);
                    }
                }
            }
        } catch (err) {
            console.error('Error scanning examples:', dir, err);
        }
    }

    scanDir(PROJECTS_BASE);
    return examples;
}

// Scan for text projects (directories with .txt files but no main.tex)
function getTextProjects() {
    const textProjects = [];
    const ignoreDirs = ['SwiftLaTeX', 'Examples', 'node_modules', '.git'];

    function scanDir(dir, prefix = '') {
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.') || ignoreDirs.includes(item)) continue;

                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) {
                    const hasMainTex = fs.existsSync(path.join(fullPath, 'main.tex'));
                    const hasPackageJson = fs.existsSync(path.join(fullPath, 'package.json'));
                    const hasSrcFolder = fs.existsSync(path.join(fullPath, 'src'));

                    // Check for .txt files
                    const txtFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.txt'));

                    if (!hasMainTex && !hasPackageJson && !hasSrcFolder && txtFiles.length > 0) {
                        // This is a text project
                        const displayName = prefix ? `${prefix}/${item}` : item;
                        const mainTxt = txtFiles.find(f => f === 'referral.txt' || f === 'main.txt') || txtFiles[0];
                        const txtPath = path.join(fullPath, mainTxt);
                        const content = fs.readFileSync(txtPath, 'utf8');

                        textProjects.push({
                            id: Buffer.from(fullPath).toString('base64'),
                            name: displayName,
                            path: fullPath,
                            type: 'text',
                            txtFile: mainTxt,
                            content: content,
                            wordCount: content.trim().split(/\s+/).length
                        });
                    } else if (!hasMainTex && !hasPackageJson && !hasSrcFolder) {
                        // Scan subdirectories
                        scanDir(fullPath, prefix ? `${prefix}/${item}` : item);
                    }
                }
            }
        } catch (err) {
            console.error('Error scanning text projects:', dir, err);
        }
    }

    scanDir(PROJECTS_BASE);
    return textProjects;
}

// Decode project ID to path
function getProjectPath(projectId) {
    try {
        return Buffer.from(projectId, 'base64').toString('utf8');
    } catch {
        return null;
    }
}

// API: List all projects
app.get('/api/projects', (req, res) => {
    const projects = getProjects();
    res.json(projects);
});

// API: List all examples
app.get('/api/examples', (req, res) => {
    const examples = getExamples();
    res.json(examples);
});

// API: List all code projects
app.get('/api/codeprojects', (req, res) => {
    const codeProjects = getCodeProjects();
    res.json(codeProjects);
});

// API: List all text projects
app.get('/api/textprojects', (req, res) => {
    const textProjects = getTextProjects();
    res.json(textProjects);
});

// API: Get text project content
app.get('/api/textproject/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }

    try {
        const txtFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.txt'));
        const mainTxt = txtFiles.find(f => f === 'referral.txt' || f === 'main.txt') || txtFiles[0];
        if (!mainTxt) {
            return res.status(404).json({ error: 'No text file found' });
        }

        const txtPath = path.join(projectPath, mainTxt);
        const content = fs.readFileSync(txtPath, 'utf8');

        res.json({
            filename: mainTxt,
            content: content,
            wordCount: content.trim().split(/\s+/).length
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read text file', details: err.message });
    }
});

// API: Get file tree for a code project
app.get('/api/filetree/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }
    const fileTree = getFileTree(projectPath);
    res.json(fileTree);
});

// API: Serve any file in a project securely
app.get('/api/file/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    const filePath = req.query.path;
    if (!projectPath || !filePath) {
        return res.status(400).send('Invalid request');
    }

    try {
        // Prevent path traversal
        const resolvedPath = path.resolve(projectPath, filePath);
        if (!resolvedPath.startsWith(path.resolve(projectPath))) {
            return res.status(403).send('Forbidden directory traversal');
        }
        if (!fs.existsSync(resolvedPath)) {
            return res.status(404).send('File not found');
        }

        // Serve the file
        res.sendFile(resolvedPath);
    } catch (err) {
        res.status(500).send('Failed to serve file: ' + err.message);
    }
});

// API: Save file content
app.put('/api/file/:projectId', express.json({ limit: '10mb' }), (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    const filePath = req.body.path;
    const content = req.body.content;
    if (!projectPath || !filePath || content === undefined) {
        return res.status(400).json({ error: 'Invalid request: path and content required' });
    }

    try {
        // Prevent path traversal
        const resolvedPath = path.resolve(projectPath, filePath);
        if (!resolvedPath.startsWith(path.resolve(projectPath))) {
            return res.status(403).json({ error: 'Forbidden directory traversal' });
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(resolvedPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.writeFileSync(resolvedPath, content, 'utf8');
        res.json({ success: true, path: filePath });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save file: ' + err.message });
    }
});

// API: Get file metadata
app.get('/api/file-info/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    const filePath = req.query.path;
    if (!projectPath || !filePath) {
        return res.status(400).json({ error: 'Invalid request' });
    }

    try {
        const resolvedPath = path.resolve(projectPath, filePath);
        if (!resolvedPath.startsWith(path.resolve(projectPath))) {
            return res.status(403).json({ error: 'Forbidden directory traversal' });
        }
        if (!fs.existsSync(resolvedPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const stats = fs.statSync(resolvedPath);
        res.json({
            name: path.basename(resolvedPath),
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
            isDirectory: stats.isDirectory()
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get file info: ' + err.message });
    }
});

// ============================================================
// Comments API
// ============================================================
function getCommentsPath(projectPath) {
    return path.join(projectPath, '.comments.json');
}

function loadComments(projectPath) {
    const fp = getCommentsPath(projectPath);
    if (fs.existsSync(fp)) {
        try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
        catch (e) { return { comments: [] }; }
    }
    return { comments: [] };
}

function saveComments(projectPath, data) {
    fs.writeFileSync(getCommentsPath(projectPath), JSON.stringify(data, null, 2), 'utf8');
}

// GET all comments
app.get('/api/comments/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });
    res.json(loadComments(projectPath));
});

// POST create comment
app.post('/api/comments/:projectId', express.json(), (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });

    const { file, line, text } = req.body;
    if (!file || line == null || !text) {
        return res.status(400).json({ error: 'file, line, and text are required' });
    }

    const data = loadComments(projectPath);
    const comment = {
        id: 'c_' + Date.now(),
        file,
        line: parseInt(line),
        text,
        author: 'user',
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: []
    };
    data.comments.push(comment);
    saveComments(projectPath, data);
    res.json({ success: true, comment });
});

// PUT update comment (resolve, edit, add reply)
app.put('/api/comments/:projectId/:commentId', express.json(), (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });

    const data = loadComments(projectPath);
    const comment = data.comments.find(c => c.id === req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    if (req.body.resolved !== undefined) comment.resolved = req.body.resolved;
    if (req.body.text !== undefined) comment.text = req.body.text;
    if (req.body.reply) {
        comment.replies.push({
            id: 'r_' + Date.now(),
            text: req.body.reply,
            author: 'user',
            createdAt: new Date().toISOString()
        });
    }

    saveComments(projectPath, data);
    res.json({ success: true, comment });
});

// DELETE comment
app.delete('/api/comments/:projectId/:commentId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });

    const data = loadComments(projectPath);
    const idx = data.comments.findIndex(c => c.id === req.params.commentId);
    if (idx === -1) return res.status(404).json({ error: 'Comment not found' });

    data.comments.splice(idx, 1);
    saveComments(projectPath, data);
    res.json({ success: true });
});

// API: Get example PDF
app.get('/api/example/:exampleId', (req, res) => {
    const projectPath = getProjectPath(req.params.exampleId);
    if (!projectPath) {
        return res.status(400).send('Invalid example ID');
    }

    // Look for main.pdf or output.pdf inside the project directory
    const candidates = ['main.pdf', 'output.pdf'];
    let pdfPath = null;
    for (const name of candidates) {
        const candidate = path.join(projectPath, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            pdfPath = candidate;
            break;
        }
    }

    // Fallback: find any .pdf in project directory
    if (!pdfPath && fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()) {
        const files = fs.readdirSync(projectPath);
        const pdf = files.find(f => f.endsWith('.pdf'));
        if (pdf) pdfPath = path.join(projectPath, pdf);
    }

    if (pdfPath) {
        console.log('Serving example PDF from:', pdfPath);
        const pdfData = fs.readFileSync(pdfPath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(pdfPath)}"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(pdfData);
    } else {
        res.status(404).send('Example PDF not found');
    }
});

// API: Get abstract from a LaTeX project
app.get('/api/abstract/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }

    const texFile = path.join(projectPath, 'main.tex');
    if (!fs.existsSync(texFile)) {
        return res.json({ hasAbstract: false });
    }

    try {
        const content = fs.readFileSync(texFile, 'utf8');

        // Extract abstract between \begin{abstract} and \end{abstract}
        const abstractMatch = content.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);

        if (!abstractMatch) {
            return res.json({ hasAbstract: false });
        }

        let abstractText = abstractMatch[1].trim();

        // Clean up LaTeX commands for display
        abstractText = abstractText
            .replace(/\\textbf\{([^}]*)\}/g, '$1')  // Remove \textbf{}
            .replace(/\\emph\{([^}]*)\}/g, '$1')     // Remove \emph{}
            .replace(/\\textit\{([^}]*)\}/g, '$1')   // Remove \textit{}
            .replace(/~\\cite\{[^}]*\}/g, '')        // Remove citations
            .replace(/\\cite\{[^}]*\}/g, '')         // Remove citations
            .replace(/---/g, '—')                    // Em dash
            .replace(/--/g, '–')                     // En dash
            .replace(/``/g, '"')                     // Opening quotes
            .replace(/''/g, '"')                     // Closing quotes
            .replace(/\\%/g, '%')                    // Percent
            .replace(/\\\$/g, '$')                   // Dollar
            .replace(/\\&/g, '&')                    // Ampersand
            .replace(/\s+/g, ' ')                    // Collapse whitespace
            .trim();

        const wordCount = abstractText.split(/\s+/).filter(w => w.length > 0).length;

        res.json({
            hasAbstract: true,
            abstract: abstractText,
            wordCount: wordCount
        });
    } catch (err) {
        console.error('Error extracting abstract:', err);
        res.status(500).json({ error: 'Failed to extract abstract', details: err.message });
    }
});

// API: Get paper todo list for a project
app.get('/api/todos/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }

    const todoPath = path.join(projectPath, 'paper_todo.json');
    if (fs.existsSync(todoPath)) {
        try {
            const todoData = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
            res.json(todoData);
        } catch (err) {
            res.status(500).json({ error: 'Failed to parse todo file' });
        }
    } else {
        res.json(null); // No todo file
    }
});

// API: Save paper todo list for a project
app.put('/api/todos/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }

    const todoPath = path.join(projectPath, 'paper_todo.json');
    try {
        const todoData = req.body;
        todoData.lastUpdated = new Date().toISOString().split('T')[0];
        // Recalculate progress
        if (todoData.todos && todoData.todos.length > 0) {
            const completed = todoData.todos.filter(t => t.status === 'completed').length;
            todoData.overallProgress = Math.round((completed / todoData.todos.length) * 100);
        }
        fs.writeFileSync(todoPath, JSON.stringify(todoData, null, 2));
        res.json({ success: true, data: todoData });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save todo file' });
    }
});

// API: Analyze PDF structure (for reading example papers)
app.get('/api/analyze-pdf/:pdfId', async (req, res) => {
    const projectPath = getProjectPath(req.params.pdfId);
    if (!projectPath || !fs.existsSync(projectPath)) {
        return res.status(404).json({ error: 'PDF not found' });
    }

    // Find the actual PDF file - projectPath may be a directory
    let pdfPath = projectPath;
    try {
        const stat = fs.statSync(projectPath);
        if (stat.isDirectory()) {
            // Search for PDF files in the project directory
            const candidates = ['main.pdf', 'output.pdf'];
            pdfPath = null;
            for (const name of candidates) {
                const candidatePath = path.join(projectPath, name);
                if (fs.existsSync(candidatePath)) {
                    pdfPath = candidatePath;
                    break;
                }
            }
            // Fallback: find any .pdf file
            if (!pdfPath) {
                const files = fs.readdirSync(projectPath);
                const pdfFile = files.find(f => f.toLowerCase().endsWith('.pdf'));
                if (pdfFile) {
                    pdfPath = path.join(projectPath, pdfFile);
                }
            }
            if (!pdfPath) {
                return res.status(404).json({ error: 'No PDF file found in project' });
            }
        }
    } catch (statErr) {
        return res.status(500).json({ error: 'Failed to access path', details: statErr.message });
    }

    try {
        const dataBuffer = fs.readFileSync(pdfPath);
        const data = await pdfParse(dataBuffer);

        const text = data.text;
        const lines = text.split('\n').filter(l => l.trim());

        // Find section headers (numbered sections like "1 INTRODUCTION")
        const sections = [];
        let currentSection = null;
        let currentContent = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // Check for section headers (numbered or ALL CAPS)
            if (/^\d+\.?\s+[A-Z]/.test(trimmed) || /^[A-Z][A-Z\s]{5,}$/.test(trimmed)) {
                if (currentSection) {
                    sections.push({
                        title: currentSection,
                        contentPreview: currentContent.slice(0, 5).join(' ').substring(0, 300)
                    });
                }
                currentSection = trimmed;
                currentContent = [];
            } else if (currentSection) {
                currentContent.push(trimmed);
            }
        }
        if (currentSection) {
            sections.push({
                title: currentSection,
                contentPreview: currentContent.slice(0, 5).join(' ').substring(0, 300)
            });
        }

        res.json({
            filename: path.basename(pdfPath),
            pages: data.numpages,
            sections: sections,
            wordCount: text.split(/\s+/).length,
            fullText: text
        });
    } catch (err) {
        console.error('PDF analysis error:', err);
        res.status(500).json({ error: 'Failed to analyze PDF', details: err.message });
    }
});

// API: Get PDF for a project
app.get('/api/pdf/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).send('Invalid project ID');
    }

    // Find the main tex file and its corresponding PDF
    const mainFile = findMainTexFile(projectPath) || 'main.tex';
    const pdfName = mainFile.replace('.tex', '.pdf');
    const pdfPath = path.join(projectPath, pdfName);
    console.log('Serving PDF from:', pdfPath);

    if (fs.existsSync(pdfPath)) {
        const pdfData = fs.readFileSync(pdfPath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${pdfName}"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(pdfData);
    } else {
        res.status(404).send('PDF not found');
    }
});

// API: Compile a project (with BibTeX support)
app.post('/api/compile/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ success: false, error: 'Invalid project ID' });
    }

    console.log(`[${new Date().toISOString()}] Compilation requested for: ${projectPath}`);

    try {
        const mainFile = findMainTexFile(projectPath);
        if (!mainFile) {
            return res.json({ success: false, error: 'No .tex file found' });
        }

        const texFile = path.join(projectPath, mainFile);
        const baseName = mainFile.replace('.tex', '');

        const execOptions = {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024,
            cwd: projectPath
        };

        const useXeLatex = needsXeLatex(projectPath);
        const latexEngine = useXeLatex ? XELATEX : PDFLATEX;
        console.log(`Using ${useXeLatex ? 'XeLaTeX' : 'pdfLaTeX'} engine`);
        const pdflatexCmd = `"${latexEngine}" -interaction=nonstopmode -output-directory="${projectPath}" "${texFile}"`;
        const bibtexCmd = `"${BIBTEX}" ${baseName}`;

        let output = '';
        let bibtexOutput = '';

        // First pdflatex pass
        console.log('Running pdflatex (pass 1)...');
        try {
            output += execSync(pdflatexCmd, execOptions);
        } catch (execError) {
            output += execError.stdout || execError.stderr || execError.message;
        }

        // Check if there's a .bib file and run bibtex
        const bibFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.bib'));
        if (bibFiles.length > 0) {
            console.log('Running bibtex...');
            try {
                bibtexOutput = execSync(bibtexCmd, execOptions);
                output += '\n\n=== BIBTEX OUTPUT ===\n' + bibtexOutput;
            } catch (execError) {
                bibtexOutput = execError.stdout || execError.stderr || execError.message;
                output += '\n\n=== BIBTEX OUTPUT ===\n' + bibtexOutput;
            }

            // Second pdflatex pass
            console.log('Running pdflatex (pass 2)...');
            try {
                output += '\n\n=== PDFLATEX PASS 2 ===\n';
                output += execSync(pdflatexCmd, execOptions);
            } catch (execError) {
                output += execError.stdout || execError.stderr || execError.message;
            }

            // Third pdflatex pass (to resolve all references)
            console.log('Running pdflatex (pass 3)...');
            try {
                output += '\n\n=== PDFLATEX PASS 3 ===\n';
                output += execSync(pdflatexCmd, execOptions);
            } catch (execError) {
                output += execError.stdout || execError.stderr || execError.message;
            }
        }

        // Check if PDF was created
        const pdfPath = path.join(projectPath, `${baseName}.pdf`);
        const pdfExists = fs.existsSync(pdfPath);
        const pdfSize = pdfExists ? fs.statSync(pdfPath).size : 0;

        // Save log
        const logPath = path.join(OUTPUT_DIR, `compile_${Date.now()}.log`);
        fs.writeFileSync(logPath, output);

        // Read LaTeX log
        const texLogPath = path.join(projectPath, `${baseName}.log`);
        let texLog = '';
        if (fs.existsSync(texLogPath)) {
            texLog = fs.readFileSync(texLogPath, 'utf8');
        }

        console.log(`Compilation ${pdfExists ? 'successful' : 'failed'}, PDF: ${pdfSize} bytes`);

        res.json({
            success: pdfExists && pdfSize > 0,
            pdfSize: pdfSize,
            log: texLog || output
        });

    } catch (err) {
        console.error('Error:', err);
        res.json({ success: false, error: err.message, log: err.message });
    }
});

// Legacy endpoints for backwards compatibility
app.get('/pdf/main.pdf', (req, res) => {
    const defaultProject = path.join(PROJECTS_BASE, 'Research Statement', 'v1');
    const pdfPath = path.join(defaultProject, 'main.pdf');
    if (fs.existsSync(pdfPath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.send(fs.readFileSync(pdfPath));
    } else {
        res.status(404).send('PDF not found');
    }
});

app.post('/compile', (req, res) => {
    const defaultProject = path.join(PROJECTS_BASE, 'Research Statement', 'v1');
    const projectId = Buffer.from(defaultProject).toString('base64');
    req.params = { projectId };
    // Redirect to new API
    res.redirect(307, `/api/compile/${projectId}`);
});

// SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);
    console.log(`SSE client connected. Total: ${sseClients.length}`);

    req.on('close', () => {
        sseClients = sseClients.filter(client => client !== res);
        console.log(`SSE client disconnected. Total: ${sseClients.length}`);
    });
});

// Broadcast event to all SSE clients
function broadcastEvent(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => client.write(message));
}

// Auto-compile a project
async function autoCompile(projectPath) {
    const projectId = Buffer.from(projectPath).toString('base64');
    const projectName = path.relative(PROJECTS_BASE, projectPath);

    console.log(`[Auto-compile] Starting: ${projectName}`);
    broadcastEvent('compile-start', { projectId, projectName });

    try {
        const mainFile = findMainTexFile(projectPath);
        if (!mainFile) {
            console.log(`[Auto-compile] No .tex file found in ${projectName}`);
            return;
        }

        const texFile = path.join(projectPath, mainFile);
        const baseName = mainFile.replace('.tex', '');

        const execOptions = {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024,
            cwd: projectPath
        };

        const useXeLatex = needsXeLatex(projectPath);
        const latexEngine = useXeLatex ? XELATEX : PDFLATEX;
        console.log(`[Auto-compile] Using ${useXeLatex ? 'XeLaTeX' : 'pdfLaTeX'} engine`);
        const pdflatexCmd = `"${latexEngine}" -interaction=nonstopmode -output-directory="${projectPath}" "${texFile}"`;
        const bibtexCmd = `"${BIBTEX}" ${baseName}`;

        // First pdflatex pass
        try { execSync(pdflatexCmd, execOptions); } catch (e) { }

        // Check for .bib files and run bibtex
        const bibFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.bib'));
        if (bibFiles.length > 0) {
            try { execSync(bibtexCmd, execOptions); } catch (e) { }
            try { execSync(pdflatexCmd, execOptions); } catch (e) { }
            try { execSync(pdflatexCmd, execOptions); } catch (e) { }
        }

        const pdfPath = path.join(projectPath, `${baseName}.pdf`);
        const success = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0;

        console.log(`[Auto-compile] ${success ? 'Success' : 'Failed'}: ${projectName}`);
        broadcastEvent('compile-done', { projectId, projectName, success });

    } catch (err) {
        console.error(`[Auto-compile] Error: ${projectName}`, err.message);
        broadcastEvent('compile-done', { projectId, projectName, success: false, error: err.message });
    }
}

// Debounce map for file changes
const compileDebounce = new Map();

// Setup file watcher
function setupFileWatcher() {
    const watcher = chokidar.watch(PROJECTS_BASE, {
        ignored: [
            /(^|[\/\\])\../,           // dotfiles
            /node_modules/,
            /SwiftLaTeX/,
            /Examples/,
            /\.aux$/,
            /\.log$/,
            /\.out$/,
            /\.toc$/,
            /\.bbl$/,
            /\.blg$/,
            /\.fls$/,
            /\.fdb_latexmk$/,
            /\.synctex\.gz$/,
            /\.pdf$/
        ],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 1000,
            pollInterval: 100
        }
    });

    watcher.on('add', (filePath) => {
        if (filePath.endsWith('.tex')) {
            const dir = path.dirname(filePath);
            const fileName = path.basename(filePath);

            // Check if this is a main tex file (new project)
            if (MAIN_TEX_FILES.includes(fileName)) {
                console.log(`[Watcher] New project detected: ${path.relative(PROJECTS_BASE, dir)}`);
                broadcastEvent('projects-changed', {});

                // Auto-compile with debounce
                if (compileDebounce.has(dir)) clearTimeout(compileDebounce.get(dir));
                compileDebounce.set(dir, setTimeout(() => {
                    autoCompile(dir);
                    compileDebounce.delete(dir);
                }, 2000));
            }
        }
    });

    watcher.on('change', (filePath) => {
        if (filePath.endsWith('.tex') || filePath.endsWith('.bib')) {
            // Find project root (directory containing main.tex)
            let dir = path.dirname(filePath);
            while (dir !== PROJECTS_BASE && !fs.existsSync(path.join(dir, 'main.tex'))) {
                dir = path.dirname(dir);
            }

            if (fs.existsSync(path.join(dir, 'main.tex'))) {
                const projectName = path.relative(PROJECTS_BASE, dir);
                console.log(`[Watcher] File changed: ${path.relative(PROJECTS_BASE, filePath)}`);

                // Debounce compilation
                if (compileDebounce.has(dir)) clearTimeout(compileDebounce.get(dir));
                compileDebounce.set(dir, setTimeout(() => {
                    autoCompile(dir);
                    compileDebounce.delete(dir);
                }, 2000));
            }
        }
    });

    console.log(`[Watcher] Monitoring ${PROJECTS_BASE} for changes...`);
}

// ============================================================
// Git Sync API
// ============================================================

// Check if a project is a git repo
function isGitRepo(projectPath) {
    return fs.existsSync(path.join(projectPath, '.git'));
}

// API: Git status for a project
app.post('/api/git/status/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });
    if (!isGitRepo(projectPath)) return res.json({ isGitRepo: false });

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 15000 };
        const statusOutput = execSync('git status --porcelain', execOpts).toString();
        const branchOutput = execSync('git branch --show-current', execOpts).toString().trim();
        let remoteOutput = '';
        try { remoteOutput = execSync('git remote get-url origin', execOpts).toString().trim(); } catch (e) { }

        const files = statusOutput.split('\n').filter(Boolean).map(line => {
            const status = line.substring(0, 2).trim(); // Keep raw status like 'UU'
            const file = line.substring(3);
            return { status, file };
        });


        // Better parsing for conflicts:
        const conflicts = statusOutput.split('\n').filter(line => {
            const s = line.substring(0, 2);
            return s === 'UU' || s === 'AA' || s === 'UD' || s === 'DU'; // Common conflict states
        }).map(line => line.substring(3));

        // Count unpushed commits
        let unpushedCount = 0;
        try {
            const unpushed = execSync('git cherry -v', execOpts).toString();
            unpushedCount = unpushed.split('\n').filter(Boolean).length;
        } catch (e) { }

        res.json({
            isGitRepo: true,
            branch: branchOutput,
            remote: remoteOutput,
            files: files.map(f => ({ ...f, status: f.status.trim() || f.status })), // Trim for UI display
            rawFiles: files, // Send raw for logic if needed
            conflicts,
            unpushedCommits: unpushedCount,
            clean: files.length === 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Git status failed', details: err.message });
    }
});

// API: Git push (add, commit, push)
app.post('/api/git/push/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });
    if (!isGitRepo(projectPath)) return res.status(400).json({ error: 'Not a Git repository' });

    const { message, token } = req.body;
    const commitMsg = message || `Update from Claude LaTeX (${new Date().toLocaleString()})`;

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 60000 };

        // Stage all changes
        execSync('git add -A', execOpts);

        // Check if there's anything to commit
        const status = execSync('git status --porcelain', execOpts).trim();
        if (!status) {
            return res.json({ success: true, message: 'Nothing to commit, working tree clean' });
        }

        // Commit
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, execOpts);

        // Push (with token auth if provided)
        let pushOutput = '';
        try {
            if (token) {
                // Temporarily set credential for push
                const remote = execSync('git remote get-url origin', execOpts).trim();
                const authRemote = remote.replace('https://', `https://${token}@`);
                pushOutput = execSync(`git push ${authRemote}`, { ...execOpts, timeout: 60000 });
            } else {
                pushOutput = execSync('git push', { ...execOpts, timeout: 60000 });
            }
        } catch (pushErr) {
            return res.json({
                success: false,
                committed: true,
                error: 'Push failed (committed locally)',
                details: pushErr.message
            });
        }

        res.json({ success: true, message: 'Changes pushed successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Git push failed', details: err.message });
    }
});

// API: Git pull
app.post('/api/git/pull/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });
    if (!isGitRepo(projectPath)) return res.status(400).json({ error: 'Not a Git repository' });

    const { token } = req.body;

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 60000 };
        let output = '';

        if (token) {
            const remote = execSync('git remote get-url origin', execOpts).trim();
            const authRemote = remote.replace('https://', `https://${token}@`);
            output = execSync(`git pull ${authRemote}`, execOpts);
        } else {
            output = execSync('git pull', execOpts);
        }

        res.json({ success: true, output: output.toString() });
    } catch (err) {
        res.status(500).json({ error: 'Git pull failed', details: err.message });
    }
});

// API: Git log (version history)
app.get('/api/git/log/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });
    if (!isGitRepo(projectPath)) return res.json({ isGitRepo: false, commits: [] });

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 15000 };
        const log = execSync('git log --pretty=format:"%H|%h|%an|%ar|%s" -30', execOpts).trim();

        const commits = log ? log.split('\n').map(line => {
            const [hash, shortHash, author, date, ...msgParts] = line.split('|');
            return { hash, shortHash, author, date, message: msgParts.join('|') };
        }) : [];

        res.json({ isGitRepo: true, commits });
    } catch (err) {
        res.status(500).json({ error: 'Git log failed', details: err.message });
    }
});

// API: Git diff for a specific commit
app.get('/api/git/diff/:projectId/:commitHash', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 15000 };
        const diff = execSync(`git show ${req.params.commitHash} --stat --patch`, execOpts);
        res.json({ diff });
    } catch (err) {
        res.status(500).json({ error: 'Git diff failed', details: err.message });
    }
});

// API: Resolve conflicts
app.post('/api/git/resolve/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });

    const { file, strategy } = req.body; // strategy: 'ours' or 'theirs'
    if (!file || !strategy) return res.status(400).json({ error: 'Missing file or strategy' });

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 15000 };

        if (strategy === 'ours') {
            // Keep local version
            execSync(`git checkout --ours "${file}"`, execOpts);
        } else if (strategy === 'theirs') {
            // Keep remote version
            execSync(`git checkout --theirs "${file}"`, execOpts);
        } else {
            return res.status(400).json({ error: 'Invalid strategy' });
        }

        // Stage the resolved file
        execSync(`git add "${file}"`, execOpts);

        res.json({ success: true, message: `Resolved ${file} using ${strategy}` });
    } catch (err) {
        res.status(500).json({ error: 'Resolve failed', details: err.message });
    }
});

// ============================================================
// Overleaf Sync API (via Git Bridge)
// ============================================================

// API: Link project to Overleaf
app.post('/api/overleaf/link/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });
    if (!isGitRepo(projectPath)) return res.status(400).json({ error: 'Not a Git repository' });

    const { overleafUrl } = req.body;
    if (!overleafUrl) return res.status(400).json({ error: 'Missing Overleaf Git URL' });

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 15000 };

        // Check if overleaf remote already exists
        try {
            execSync('git remote get-url overleaf', execOpts);
            // Update existing
            execSync(`git remote set-url overleaf "${overleafUrl}"`, execOpts);
        } catch (e) {
            // Add new remote
            execSync(`git remote add overleaf "${overleafUrl}"`, execOpts);
        }

        res.json({ success: true, message: 'Overleaf remote linked' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to link Overleaf', details: err.message });
    }
});

// API: Sync with Overleaf (push or pull)
app.post('/api/overleaf/sync/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });

    const { direction, message } = req.body; // direction: 'push' or 'pull'

    try {
        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 60000 };

        if (direction === 'push') {
            execSync('git add -A', execOpts);
            try {
                const commitMsg = message || `Sync from Claude LaTeX (${new Date().toLocaleString()})`;
                execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, execOpts);
            } catch (e) { /* nothing to commit */ }
            const output = execSync('git push overleaf master --force', execOpts);
            res.json({ success: true, output: output.toString() });
        } else {
            const output = execSync('git pull overleaf master --allow-unrelated-histories', execOpts);
            res.json({ success: true, output: output.toString() });
        }
    } catch (err) {
        res.status(500).json({ error: `Overleaf ${direction} failed`, details: err.message });
    }
});

// API: Clone project from Overleaf
app.post('/api/overleaf/clone', (req, res) => {
    const { overleafUrl, token, projectName } = req.body;
    if (!overleafUrl || !token) {
        return res.status(400).json({ error: 'Missing Overleaf URL or token' });
    }

    // Extract project ID from URL for default name
    const projectId = overleafUrl.split('/').pop();
    const safeName = (projectName || `overleaf-${projectId}`).replace(/[^a-zA-Z0-9-_\u4e00-\u9fff]/g, '-');
    const targetPath = path.join(PROJECTS_BASE, safeName);

    if (fs.existsSync(targetPath)) {
        return res.status(409).json({ error: 'Project folder already exists' });
    }

    // Construct authenticated URL: https://git:TOKEN@git.overleaf.com/PROJECT_ID
    const authUrl = overleafUrl.replace('https://git@', `https://git:${token}@`).replace('https://git.overleaf.com', `https://git:${token}@git.overleaf.com`);

    console.log(`Cloning from Overleaf to ${targetPath}...`);

    try {
        execSync(`git clone "${authUrl}" "${targetPath}"`, {
            stdio: 'pipe',
            timeout: 120000,
            encoding: 'utf8'
        });

        res.json({ success: true, path: targetPath, name: safeName });
    } catch (err) {
        console.error('Overleaf clone failed:', err.message);
        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        res.status(500).json({ error: 'Overleaf clone failed', details: err.stderr || err.message });
    }
});

// API: List GitHub repositories
app.get('/api/github/repos', async (req, res) => {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).json({ error: 'Missing GitHub token' });
    }

    try {
        const response = await fetch('https://api.github.com/user/repos?sort=updated&per_page=100', {
            headers: {
                'Authorization': token,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Failed to fetch repositories' });
        }

        const repos = await response.json();
        res.json(repos.map(r => ({
            id: r.id,
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            html_url: r.html_url,
            clone_url: r.clone_url,
            description: r.description,
            updated_at: r.updated_at
        })));
    } catch (err) {
        console.error('GitHub API error:', err);
        res.status(500).json({ error: 'Failed to connect to GitHub' });
    }
});

// API: Clone GitHub repository
app.post('/api/github/clone', (req, res) => {
    const { token, repoUrl, repoName } = req.body;
    if (!token || !repoUrl || !repoName) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    // Sanitize repo name to avoid path traversal
    const safeName = repoName.replace(/[^a-zA-Z0-9-_]/g, '');
    const targetPath = path.join(PROJECTS_BASE, safeName);

    if (fs.existsSync(targetPath)) {
        return res.status(409).json({ error: 'Project folder already exists' });
    }

    // Construct authenticated clone URL
    const authRepoUrl = repoUrl.replace('https://', `https://${token}@`);

    console.log(`Cloning ${repoName} to ${targetPath}...`);

    try {
        execSync(`git clone "${authRepoUrl}" "${targetPath}"`, {
            stdio: 'inherit',
            timeout: 60000 // 60s timeout
        });

        res.json({ success: true, path: targetPath });
    } catch (err) {
        console.error('Clone failed:', err);
        // Clean up partial clone
        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        res.status(500).json({ error: 'Git clone failed', details: err.message });
    }
});

// API: Export local project to a NEW GitHub repository
app.post('/api/github/export/:projectId', async (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) return res.status(400).json({ error: 'Invalid project ID' });

    const { token, repoName, isPrivate, description } = req.body;
    if (!token || !repoName) {
        return res.status(400).json({ error: 'Missing token or repo name' });
    }

    try {
        // 1. Create repo on GitHub via API
        const createRes = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: repoName,
                description: description || `Created from Claude LaTeX`,
                private: isPrivate !== false,
                auto_init: false
            })
        });

        if (!createRes.ok) {
            const errData = await createRes.json();
            return res.status(createRes.status).json({
                error: 'Failed to create GitHub repo',
                details: errData.message || JSON.stringify(errData)
            });
        }

        const repoData = await createRes.json();
        const remoteUrl = repoData.clone_url;
        const authRemote = remoteUrl.replace('https://', `https://${token}@`);

        const execOpts = { encoding: 'utf8', cwd: projectPath, timeout: 60000 };

        // 2. Initialize git if not already a repo
        if (!isGitRepo(projectPath)) {
            execSync('git init', execOpts);
        }

        // Ensure we are on main branch
        try { execSync('git branch -M main', execOpts); } catch (e) { }

        // 3. Set git user info if not set
        try { execSync('git config user.email', execOpts); } catch (e) {
            execSync('git config user.email "claude-latex@local"', execOpts);
            execSync('git config user.name "Claude LaTeX"', execOpts);
        }

        // 4. Add remote, stage, commit, push
        try { execSync('git remote remove origin', execOpts); } catch (e) { }
        execSync(`git remote add origin ${authRemote}`, execOpts);
        execSync('git add -A', execOpts);
        try {
            execSync(`git commit -m "Initial commit from Claude LaTeX"`, execOpts);
        } catch (e) { /* already committed */ }
        execSync('git push -u origin main --force', execOpts);

        console.log(`Exported ${repoName} to GitHub: ${repoData.html_url}`);

        res.json({
            success: true,
            repoUrl: repoData.html_url,
            cloneUrl: repoData.clone_url,
            message: `Repository created: ${repoData.full_name}`
        });
    } catch (err) {
        console.error('Export to GitHub failed:', err);
        res.status(500).json({ error: 'Export failed', details: err.message });
    }
});

// API: Create new project
app.post('/api/project/create', (req, res) => {
    const { name, template } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required' });

    const safeName = name.replace(/[^a-zA-Z0-9-_\u4e00-\u9fff]/g, '-');
    const projectPath = path.join(PROJECTS_BASE, safeName);

    if (fs.existsSync(projectPath)) {
        return res.status(409).json({ error: 'Project already exists' });
    }

    try {
        fs.mkdirSync(projectPath);

        let content = '';
        if (template === 'blank') {
            content = '\\documentclass{article}\n\\begin{document}\n    Hello World!\n\\end{document}';
        } else {
            // Default template
            content = `\\documentclass{article}
\\usepackage{graphicx} % Required for inserting images

\\title{${safeName}}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}
Start writing your document here.

\\end{document}`;
        }

        fs.writeFileSync(path.join(projectPath, 'main.tex'), content);
        console.log(`Created new project: ${safeName}`);

        res.json({ success: true, name: safeName });
    } catch (err) {
        console.error('Create project failed:', err);
        res.status(500).json({ error: 'Failed to create project', details: err.message });
    }
});

// ============================================================
// Canvas Integration (Calendar & Scraper)
// ============================================================

// API: Trigger Full Canvas Scrape (Assignments & Attachments)
app.post('/api/canvas/scrape', (req, res) => {
    try {
        const scraperPath = path.resolve(__dirname, 'scrapers', 'canvas_scraper.js');
        if (!fs.existsSync(scraperPath)) {
            return res.status(404).json({ error: 'Scraper script not found.' });
        }

        // Read the user's saved Canvas Config to get the correct base URL
        const config = getConfig();
        const icsUrl = config.canvas_ics_url || 'https://canvas.instructure.com';

        // Spawn to run in background so we don't block the server UI
        const { spawn } = require('child_process');
        const scraper = spawn(process.execPath, [scraperPath, icsUrl], {
            detached: true,
            stdio: 'ignore'
        });

        scraper.unref(); // Allow server to exit independently of the scraper

        res.json({ success: true, message: 'Scraping process started in the background. A browser window will open shortly to log you in if needed.' });
    } catch (e) {
        console.error('Failed to start scraper:', e);
        res.status(500).json({ error: 'Failed to start scraper process.' });
    }
});

// API: Save Canvas Config (ICS URL)
app.post('/api/canvas/config', (req, res) => {
    const { icsUrl } = req.body;
    if (!icsUrl) return res.status(400).json({ error: 'Missing ICS URL' });

    // Validate URL format
    if (!icsUrl.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });

    const config = saveConfig({ canvas_ics_url: icsUrl });
    res.json({ success: true, config });
});

// API: Get Canvas Deadlines
app.get('/api/canvas/deadlines', async (req, res) => {
    const config = getConfig();
    const icsUrl = config.canvas_ics_url;

    // If no URL configured, return empty list (UI handles this)
    if (!icsUrl) return res.json({ deadlines: [], configured: false });

    console.log(`Fetching Canvas ICS from: ${icsUrl}`);

    try {
        // Use node-ical to fetch and parse
        // Note: node-ical handles the HTTP request internally via fromURL
        const events = await ical.async.fromURL(icsUrl);
        const deadlines = [];
        const now = new Date();

        for (const key in events) {
            const ev = events[key];
            if (ev.type === 'VEVENT') {
                // Parse date
                const due = new Date(ev.start);
                if (isNaN(due.getTime())) continue;

                // Only future assignments? Or recent past? Let's show recent past (7 days) + future
                const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                if (due < oneWeekAgo) continue;

                deadlines.push({
                    title: ev.summary,
                    description: ev.description || '',
                    due: due.toISOString(),
                    uid: ev.uid,
                    url: ev.url || '', // Assignment link
                    course: ev.summary?.match(/\[(.*?)\]/)?.[1] || 'Canvas' // Extract course from '[CS101] Assignment 1'
                });
            }
        }

        // Sort by date (soonest first)
        deadlines.sort((a, b) => new Date(a.due) - new Date(b.due));

        res.json({ deadlines, configured: true });
    } catch (err) {
        console.error('Canvas ICS error:', err);
        res.status(500).json({ error: 'Failed to fetch Canvas calendar', details: err.message });
    }
});

// ============================================================
// Canvas Integration (Scraper)
// ============================================================

app.post('/api/canvas/scrape', (req, res) => {
    const config = getConfig();
    const icsUrl = config.canvas_ics_url || '';
    const scriptPath = path.join(__dirname, 'scrapers', 'canvas_scraper.js');

    console.log('Spawning Canvas scraper process...');

    // Check if script exists
    if (!fs.existsSync(scriptPath)) {
        return res.status(500).json({ error: 'Scraper script not found' });
    }

    try {
        const scraper = require('child_process').spawn('node', [scriptPath, icsUrl], {
            cwd: __dirname,
            stdio: 'inherit' // Pipe output to server console
        });

        scraper.on('error', (err) => {
            console.error('Failed to start scraper:', err);
        });

        scraper.on('close', (code) => {
            console.log(`Scraper process exited with code ${code}`);
        });

        res.json({ success: true, message: 'Scraper started. Please check the popup browser window.' });
    } catch (e) {
        console.error('Spawn error:', e);
        res.status(500).json({ error: 'Failed to spawn scraper', details: e.message });
    }
});

// ============================================================
// AI Assistant Integration (Claude API with Tool Use)
// ============================================================

// Conversation history per project
const aiConversations = new Map();
const MAX_HISTORY_MESSAGES = 20;

// Tool definitions for Claude
const AI_TOOLS = [
    {
        name: 'read_file',
        description: 'Read the contents of a file in the current project workspace. Use this to examine source code, LaTeX files, configuration, etc.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Relative path to the file within the project (e.g., "main.tex", "src/script.py")' }
            },
            required: ['file_path']
        }
    },
    {
        name: 'edit_file',
        description: 'Propose an edit to a file. Returns a diff that the user must approve before it is applied. Use find_and_replace for targeted changes, or provide full new_content for complete rewrites.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Relative path to the file within the project' },
                find_text: { type: 'string', description: 'Text to find (for find-and-replace mode). If omitted, new_content replaces the entire file.' },
                replace_text: { type: 'string', description: 'Replacement text (used with find_text)' },
                new_content: { type: 'string', description: 'Complete new file content (used for full rewrites, ignored if find_text is provided)' },
                description: { type: 'string', description: 'Short description of what this edit does' }
            },
            required: ['file_path']
        }
    },
    {
        name: 'list_files',
        description: 'List all files and directories in the current project workspace.',
        input_schema: {
            type: 'object',
            properties: {
                directory: { type: 'string', description: 'Subdirectory to list (default: project root)', default: '' }
            }
        }
    }
];

// Execute a tool call
function executeAiTool(toolName, toolInput, projectPath) {
    try {
        if (toolName === 'read_file') {
            const filePath = path.resolve(projectPath, toolInput.file_path);
            if (!filePath.startsWith(path.resolve(projectPath))) {
                return { error: 'Access denied: path outside project' };
            }
            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${toolInput.file_path}` };
            }
            const stats = fs.statSync(filePath);
            if (stats.size > 500000) {
                return { error: `File too large (${(stats.size/1024).toFixed(0)}KB). Max 500KB.` };
            }
            const content = fs.readFileSync(filePath, 'utf8');
            return { content, size: stats.size };
        }

        if (toolName === 'edit_file') {
            const filePath = path.resolve(projectPath, toolInput.file_path);
            if (!filePath.startsWith(path.resolve(projectPath))) {
                return { error: 'Access denied: path outside project' };
            }

            // Return the proposed edit for user approval (not applied automatically)
            const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
            let newContent;

            if (toolInput.find_text) {
                if (!currentContent.includes(toolInput.find_text)) {
                    return { error: `Text to find not found in ${toolInput.file_path}` };
                }
                newContent = currentContent.replace(toolInput.find_text, toolInput.replace_text || '');
            } else if (toolInput.new_content !== undefined) {
                newContent = toolInput.new_content;
            } else {
                return { error: 'Either find_text or new_content must be provided' };
            }

            return {
                type: 'edit_proposal',
                file_path: toolInput.file_path,
                description: toolInput.description || 'Edit file',
                old_content: currentContent,
                new_content: newContent,
                is_new_file: !fs.existsSync(filePath)
            };
        }

        if (toolName === 'list_files') {
            const dir = toolInput.directory ? path.resolve(projectPath, toolInput.directory) : projectPath;
            if (!dir.startsWith(path.resolve(projectPath))) {
                return { error: 'Access denied: path outside project' };
            }
            if (!fs.existsSync(dir)) {
                return { error: `Directory not found: ${toolInput.directory || '/'}` };
            }

            function listRecursive(dirPath, prefix = '') {
                let result = [];
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        result.push({ path: relPath + '/', type: 'directory' });
                        result = result.concat(listRecursive(path.join(dirPath, entry.name), relPath));
                    } else {
                        const stats = fs.statSync(path.join(dirPath, entry.name));
                        result.push({ path: relPath, type: 'file', size: stats.size });
                    }
                }
                return result;
            }

            return { files: listRecursive(dir) };
        }

        return { error: `Unknown tool: ${toolName}` };
    } catch (err) {
        return { error: err.message };
    }
}

// ============================================================
// Multi-Provider Abstraction Layer
// ============================================================

const AI_PROVIDERS = {
    anthropic: {
        id: 'anthropic',
        name: 'Anthropic (Claude)',
        models: [
            { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', default: true },
            { id: 'claude-haiku-4-20250414', name: 'Claude Haiku 4' },
            { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' }
        ],
        authType: 'api_key',
        configKey: 'anthropic_api_key',
        isAvailable: () => {
            const config = getConfig();
            return !!(config.anthropic_api_key);
        },
        getApiKey: () => getConfig().anthropic_api_key
    },
    openai: {
        id: 'openai',
        name: 'OpenAI',
        models: [
            { id: 'gpt-4o', name: 'GPT-4o', default: true },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
            { id: 'o3-mini', name: 'o3-mini' }
        ],
        authType: 'api_key_or_oauth',
        configKey: 'openai_api_key',
        isAvailable: () => {
            const config = getConfig();
            return !!(config.openai_api_key || config.openai_oauth?.access_token);
        },
        getApiKey: () => {
            const config = getConfig();
            return config.openai_oauth?.access_token || config.openai_api_key;
        }
    },
    gemini: {
        id: 'gemini',
        name: 'Google (Gemini)',
        models: [
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', default: true },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
        ],
        authType: 'api_key_or_oauth',
        configKey: 'gemini_api_key',
        isAvailable: () => {
            const config = getConfig();
            return !!(config.gemini_api_key || config.google_oauth?.access_token);
        },
        getApiKey: () => {
            const config = getConfig();
            return config.google_oauth?.access_token || config.gemini_api_key;
        },
        getAuthType: () => {
            const config = getConfig();
            if (config.google_oauth?.access_token) return 'oauth';
            return 'api_key';
        }
    },
    openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        models: [
            { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (via OR)', default: true },
            { id: 'openai/gpt-4o', name: 'GPT-4o (via OR)' },
            { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (via OR)' },
            { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (via OR)' }
        ],
        authType: 'api_key',
        configKey: 'openrouter_api_key',
        isAvailable: () => {
            const config = getConfig();
            return !!(config.openrouter_api_key);
        },
        getApiKey: () => getConfig().openrouter_api_key
    }
};

// Convert Anthropic-format tools to provider-specific format
function convertToolsForProvider(provider, tools) {
    if (!tools || tools.length === 0) return [];

    if (provider === 'anthropic') {
        return tools; // Already in Anthropic format
    }

    if (provider === 'openai' || provider === 'openrouter') {
        return tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }
        }));
    }

    if (provider === 'gemini') {
        return [{
            functionDeclarations: tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }))
        }];
    }

    return tools;
}

// Build API request for each provider
function buildProviderRequest(provider, model, systemPrompt, messages, tools, stream) {
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo) throw new Error(`Unknown provider: ${provider}`);

    if (provider === 'anthropic') {
        return {
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': providerInfo.getApiKey(),
                'anthropic-version': '2023-06-01'
            },
            body: {
                model: model,
                max_tokens: 4096,
                system: systemPrompt,
                messages: messages,
                tools: convertToolsForProvider('anthropic', tools),
                stream: stream
            }
        };
    }

    if (provider === 'openai' || provider === 'openrouter') {
        // Convert Anthropic-style messages to OpenAI format
        const oaiMessages = convertMessagesToOpenAI(systemPrompt, messages);
        const convertedTools = convertToolsForProvider(provider, tools);

        const baseUrl = provider === 'openai'
            ? 'https://api.openai.com/v1/chat/completions'
            : 'https://openrouter.ai/api/v1/chat/completions';

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${providerInfo.getApiKey()}`
        };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = 'http://localhost:3000';
            headers['X-Title'] = 'SwiftLaTeX';
        }

        const body = {
            model: model,
            messages: oaiMessages,
            max_tokens: 4096,
            stream: stream
        };
        if (convertedTools.length > 0) {
            body.tools = convertedTools;
        }

        return { url: baseUrl, headers, body };
    }

    if (provider === 'gemini') {
        const authType = providerInfo.getAuthType ? providerInfo.getAuthType() : 'api_key';
        const apiKey = providerInfo.getApiKey();

        let url, headers;
        if (authType === 'oauth') {
            url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            };
        } else {
            url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}?key=${apiKey}`;
            headers = { 'Content-Type': 'application/json' };
        }

        const geminiContents = convertMessagesToGemini(messages);
        const convertedTools = convertToolsForProvider('gemini', tools);

        const body = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: geminiContents
        };
        if (convertedTools.length > 0) {
            body.tools = convertedTools;
        }

        return { url, headers, body };
    }

    throw new Error(`Unsupported provider: ${provider}`);
}

// Convert Anthropic-style messages to OpenAI format
function convertMessagesToOpenAI(systemPrompt, messages) {
    const result = [{ role: 'system', content: systemPrompt }];

    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            result.push({ role: msg.role, content: msg.content });
        } else if (Array.isArray(msg.content)) {
            // Handle tool_use / tool_result blocks
            if (msg.role === 'assistant') {
                let textParts = '';
                const toolCalls = [];
                for (const block of msg.content) {
                    if (block.type === 'text') {
                        textParts += block.text;
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: JSON.stringify(block.input)
                            }
                        });
                    }
                }
                const assistantMsg = { role: 'assistant', content: textParts || null };
                if (toolCalls.length > 0) {
                    assistantMsg.tool_calls = toolCalls;
                }
                result.push(assistantMsg);
            } else if (msg.role === 'user') {
                // Tool results
                for (const block of msg.content) {
                    if (block.type === 'tool_result') {
                        result.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                        });
                    }
                }
            }
        }
    }

    return result;
}

// Convert Anthropic-style messages to Gemini format
function convertMessagesToGemini(messages) {
    const result = [];

    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';

        if (typeof msg.content === 'string') {
            result.push({ role, parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
            const parts = [];
            for (const block of msg.content) {
                if (block.type === 'text') {
                    parts.push({ text: block.text });
                } else if (block.type === 'tool_use') {
                    parts.push({
                        functionCall: {
                            name: block.name,
                            args: block.input
                        }
                    });
                } else if (block.type === 'tool_result') {
                    // Gemini puts function responses in model turn
                    result.push({
                        role: 'function',
                        parts: [{
                            functionResponse: {
                                name: block.tool_use_id, // We'll fix this below
                                response: { result: typeof block.content === 'string' ? JSON.parse(block.content) : block.content }
                            }
                        }]
                    });
                    continue;
                }
            }
            if (parts.length > 0) {
                result.push({ role, parts });
            }
        }
    }

    return result;
}

// Parse SSE events from each provider into a normalized format
// Returns: { type: 'text'|'tool_start'|'tool_input'|'tool_stop'|'stop', ... }
function parseProviderSSEEvent(provider, eventData) {
    if (provider === 'anthropic') {
        return parseAnthropicSSE(eventData);
    }
    if (provider === 'openai' || provider === 'openrouter') {
        return parseOpenAISSE(eventData);
    }
    if (provider === 'gemini') {
        return parseGeminiSSE(eventData);
    }
    return null;
}

function parseAnthropicSSE(event) {
    if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
            return {
                type: 'tool_start',
                id: event.content_block.id,
                name: event.content_block.name
            };
        }
        return null;
    }

    if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
            return { type: 'text', content: event.delta.text };
        }
        if (event.delta.type === 'input_json_delta') {
            return { type: 'tool_input', content: event.delta.partial_json };
        }
        return null;
    }

    if (event.type === 'content_block_stop') {
        return { type: 'tool_stop' };
    }

    if (event.type === 'message_delta') {
        return { type: 'stop', stop_reason: event.delta.stop_reason };
    }

    return null;
}

function parseOpenAISSE(event) {
    if (!event.choices || event.choices.length === 0) return null;
    const choice = event.choices[0];
    const delta = choice.delta;

    if (!delta) {
        if (choice.finish_reason) {
            return {
                type: 'stop',
                stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason
            };
        }
        return null;
    }

    // Text content
    if (delta.content) {
        return { type: 'text', content: delta.content };
    }

    // Tool calls
    if (delta.tool_calls) {
        const tc = delta.tool_calls[0];
        if (tc.function?.name) {
            // First chunk of a tool call
            return {
                type: 'tool_start',
                id: tc.id,
                name: tc.function.name,
                initial_args: tc.function.arguments || ''
            };
        }
        if (tc.function?.arguments) {
            return { type: 'tool_input', content: tc.function.arguments };
        }
    }

    if (choice.finish_reason) {
        return {
            type: 'stop',
            stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason
        };
    }

    return null;
}

function parseGeminiSSE(event) {
    if (!event.candidates || event.candidates.length === 0) return null;

    const candidate = event.candidates[0];
    const parts = candidate.content?.parts || [];
    const results = [];

    for (const part of parts) {
        if (part.text) {
            results.push({ type: 'text', content: part.text });
        }
        if (part.functionCall) {
            results.push({
                type: 'tool_start',
                id: `gemini_tool_${Date.now()}`,
                name: part.functionCall.name,
                complete_args: part.functionCall.args
            });
            results.push({ type: 'tool_stop' });
        }
    }

    if (candidate.finishReason) {
        const isToolUse = candidate.finishReason === 'TOOL_USE' ||
            parts.some(p => p.functionCall);
        results.push({
            type: 'stop',
            stop_reason: isToolUse ? 'tool_use' : candidate.finishReason
        });
    }

    return results.length === 1 ? results[0] : (results.length > 1 ? results : null);
}

// Build tool result messages in provider-specific format
function buildToolResultMessages(provider, assistantContent, toolResults) {
    if (provider === 'anthropic') {
        return {
            assistantMsg: { role: 'assistant', content: assistantContent },
            toolResultMsg: {
                role: 'user',
                content: toolResults.map(tr => ({
                    type: 'tool_result',
                    tool_use_id: tr.id,
                    content: JSON.stringify(tr.result)
                }))
            }
        };
    }

    if (provider === 'openai' || provider === 'openrouter') {
        const toolCalls = [];
        let textContent = '';
        for (const block of assistantContent) {
            if (block.type === 'text') textContent += block.text;
            if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: { name: block.name, arguments: JSON.stringify(block.input) }
                });
            }
        }

        const msgs = [];
        msgs.push({
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        });
        for (const tr of toolResults) {
            msgs.push({
                role: 'tool',
                tool_call_id: tr.id,
                content: JSON.stringify(tr.result)
            });
        }
        return { messages: msgs };
    }

    if (provider === 'gemini') {
        const modelParts = [];
        for (const block of assistantContent) {
            if (block.type === 'text') modelParts.push({ text: block.text });
            if (block.type === 'tool_use') {
                modelParts.push({ functionCall: { name: block.name, args: block.input } });
            }
        }

        const responseParts = toolResults.map(tr => ({
            functionResponse: { name: tr.name, response: tr.result }
        }));

        return {
            messages: [
                { role: 'model', parts: modelParts },
                { role: 'function', parts: responseParts }
            ]
        };
    }
}

// Determine default provider and model
function getDefaultProviderAndModel() {
    const config = getConfig();
    const prefs = config.ai_preferences || {};

    // If user has a saved preference and that provider is available, use it
    if (prefs.last_provider && prefs.last_model) {
        const p = AI_PROVIDERS[prefs.last_provider];
        if (p && p.isAvailable()) {
            return { provider: prefs.last_provider, model: prefs.last_model };
        }
    }

    // Auto-detect first available provider
    for (const pid of ['anthropic', 'openai', 'gemini', 'openrouter']) {
        const p = AI_PROVIDERS[pid];
        if (p.isAvailable()) {
            const defaultModel = p.models.find(m => m.default) || p.models[0];
            return { provider: pid, model: defaultModel.id };
        }
    }

    return { provider: null, model: null };
}

// ============================================================
// AI API Endpoints
// ============================================================

// Get available providers and their status
app.get('/api/ai/providers', (req, res) => {
    const config = getConfig();
    const result = {};
    for (const [id, provider] of Object.entries(AI_PROVIDERS)) {
        result[id] = {
            id: provider.id,
            name: provider.name,
            models: provider.models,
            authType: provider.authType,
            available: provider.isAvailable(),
            hasApiKey: !!(config[provider.configKey]),
            hasOAuth: !!(
                (id === 'openai' && config.openai_oauth?.access_token) ||
                (id === 'gemini' && config.google_oauth?.access_token)
            )
        };
    }
    const defaults = getDefaultProviderAndModel();
    res.json({ providers: result, defaults });
});

// Save/update AI preferences
app.post('/api/ai/preferences', (req, res) => {
    const { provider, model } = req.body;
    const config = getConfig();
    config.ai_preferences = { last_provider: provider, last_model: model };
    saveConfig(config);
    res.json({ success: true });
});

// Save an API key for a provider
app.post('/api/ai/save-key', (req, res) => {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) {
        return res.status(400).json({ error: 'provider and apiKey are required' });
    }
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo) {
        return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }
    const config = getConfig();
    config[providerInfo.configKey] = apiKey;
    saveConfig(config);
    res.json({ success: true });
});

// Test an API key
app.post('/api/ai/test-key', async (req, res) => {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) {
        return res.status(400).json({ error: 'provider and apiKey are required' });
    }

    try {
        if (provider === 'anthropic') {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-20250414',
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'Hi' }]
                })
            });
            if (response.ok) return res.json({ valid: true });
            const err = await response.text();
            return res.json({ valid: false, error: err });
        }

        if (provider === 'openai') {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'Hi' }]
                })
            });
            if (response.ok) return res.json({ valid: true });
            const err = await response.text();
            return res.json({ valid: false, error: err });
        }

        if (provider === 'gemini') {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'Hi' }] }]
                })
            });
            if (response.ok) return res.json({ valid: true });
            const err = await response.text();
            return res.json({ valid: false, error: err });
        }

        if (provider === 'openrouter') {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-Title': 'SwiftLaTeX'
                },
                body: JSON.stringify({
                    model: 'openai/gpt-4o-mini',
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'Hi' }]
                })
            });
            if (response.ok) return res.json({ valid: true });
            const err = await response.text();
            return res.json({ valid: false, error: err });
        }

        return res.status(400).json({ error: 'Unknown provider' });
    } catch (err) {
        return res.json({ valid: false, error: err.message });
    }
});

// ============================================================
// Google OAuth 2.0 for Gemini API
// ============================================================

// Generate PKCE code verifier and challenge
function generateCodeVerifier() {
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Store PKCE state temporarily (in-memory)
const oauthState = {};

// Start Google OAuth flow
app.get('/api/oauth/google/start', (req, res) => {
    const config = getConfig();
    const clientId = config.google_oauth_client_id;

    if (!clientId) {
        return res.status(400).json({
            error: 'Google OAuth Client ID not configured.',
            help: 'Add google_oauth_client_id to config.json. Get one from https://console.cloud.google.com/apis/credentials'
        });
    }

    const state = generateCodeVerifier().substring(0, 16);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    oauthState[state] = { codeVerifier, provider: 'google', created: Date.now() };

    // Clean up old states (> 10 minutes)
    for (const [k, v] of Object.entries(oauthState)) {
        if (Date.now() - v.created > 600000) delete oauthState[k];
    }

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `http://localhost:${PORT}/api/oauth/google/callback`,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/generative-language',
        access_type: 'offline',
        prompt: 'consent',
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    });

    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// Google OAuth callback
app.get('/api/oauth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.send(`<html><body><h2>OAuth Error</h2><p>${error}</p><script>window.close();</script></body></html>`);
    }

    if (!code || !state || !oauthState[state]) {
        return res.send('<html><body><h2>Invalid OAuth State</h2><p>Please try again.</p><script>window.close();</script></body></html>');
    }

    const { codeVerifier } = oauthState[state];
    delete oauthState[state];

    const config = getConfig();
    const clientId = config.google_oauth_client_id;
    const clientSecret = config.google_oauth_client_secret || '';

    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: `http://localhost:${PORT}/api/oauth/google/callback`,
                grant_type: 'authorization_code',
                code_verifier: codeVerifier
            })
        });

        const tokenData = await tokenRes.json();

        if (tokenData.error) {
            return res.send(`<html><body><h2>Token Error</h2><p>${tokenData.error}: ${tokenData.error_description || ''}</p><script>window.close();</script></body></html>`);
        }

        // Save tokens
        config.google_oauth = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || config.google_oauth?.refresh_token,
            token_expiry: Date.now() + (tokenData.expires_in * 1000),
            scope: tokenData.scope
        };
        saveConfig(config);

        res.send(`<html><body><h2>✅ Google OAuth Connected!</h2><p>You can close this window.</p><script>
            if (window.opener) { window.opener.postMessage({type:'oauth_complete', provider:'google'}, '*'); }
            setTimeout(() => window.close(), 2000);
        </script></body></html>`);
    } catch (err) {
        res.send(`<html><body><h2>Error</h2><p>${err.message}</p><script>window.close();</script></body></html>`);
    }
});

// Refresh Google access token
app.post('/api/oauth/google/refresh', async (req, res) => {
    const config = getConfig();
    const refreshToken = config.google_oauth?.refresh_token;
    const clientId = config.google_oauth_client_id;
    const clientSecret = config.google_oauth_client_secret || '';

    if (!refreshToken) {
        return res.status(400).json({ error: 'No refresh token available' });
    }

    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            })
        });

        const tokenData = await tokenRes.json();

        if (tokenData.error) {
            return res.status(400).json({ error: tokenData.error });
        }

        config.google_oauth.access_token = tokenData.access_token;
        config.google_oauth.token_expiry = Date.now() + (tokenData.expires_in * 1000);
        saveConfig(config);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// OpenAI OAuth (PKCE)
// ============================================================

// Start OpenAI OAuth flow
app.get('/api/oauth/openai/start', (req, res) => {
    const config = getConfig();
    const clientId = config.openai_oauth_client_id;

    if (!clientId) {
        return res.status(400).json({
            error: 'OpenAI OAuth Client ID not configured.',
            help: 'Add openai_oauth_client_id to config.json. Register an app at https://platform.openai.com/settings/organization/applications'
        });
    }

    const state = generateCodeVerifier().substring(0, 16);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    oauthState[state] = { codeVerifier, provider: 'openai', created: Date.now() };

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `http://localhost:${PORT}/api/oauth/openai/callback`,
        response_type: 'code',
        scope: 'openai.public',
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    });

    res.json({ url: `https://auth.openai.com/oauth/authorize?${params}` });
});

// OpenAI OAuth callback
app.get('/api/oauth/openai/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.send(`<html><body><h2>OAuth Error</h2><p>${error}</p><script>window.close();</script></body></html>`);
    }

    if (!code || !state || !oauthState[state]) {
        return res.send('<html><body><h2>Invalid OAuth State</h2><p>Please try again.</p><script>window.close();</script></body></html>');
    }

    const { codeVerifier } = oauthState[state];
    delete oauthState[state];

    try {
        const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: getConfig().openai_oauth_client_id,
                redirect_uri: `http://localhost:${PORT}/api/oauth/openai/callback`,
                grant_type: 'authorization_code',
                code_verifier: codeVerifier
            })
        });

        const tokenData = await tokenRes.json();

        if (tokenData.error) {
            return res.send(`<html><body><h2>Token Error</h2><p>${tokenData.error}: ${tokenData.error_description || ''}</p><script>window.close();</script></body></html>`);
        }

        // Save tokens
        const config = getConfig();
        config.openai_oauth = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expiry: Date.now() + (tokenData.expires_in * 1000)
        };
        saveConfig(config);

        res.send(`<html><body><h2>✅ OpenAI OAuth Connected!</h2><p>You can close this window.</p><script>
            if (window.opener) { window.opener.postMessage({type:'oauth_complete', provider:'openai'}, '*'); }
            setTimeout(() => window.close(), 2000);
        </script></body></html>`);
    } catch (err) {
        res.send(`<html><body><h2>Error</h2><p>${err.message}</p><script>window.close();</script></body></html>`);
    }
});

// Refresh OpenAI access token
app.post('/api/oauth/openai/refresh', async (req, res) => {
    const config = getConfig();
    const refreshToken = config.openai_oauth?.refresh_token;

    if (!refreshToken) {
        return res.status(400).json({ error: 'No refresh token available' });
    }

    try {
        const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: getConfig().openai_oauth_client_id,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            })
        });

        const tokenData = await tokenRes.json();

        if (tokenData.error) {
            return res.status(400).json({ error: tokenData.error });
        }

        config.openai_oauth.access_token = tokenData.access_token;
        if (tokenData.refresh_token) {
            config.openai_oauth.refresh_token = tokenData.refresh_token;
        }
        config.openai_oauth.token_expiry = Date.now() + (tokenData.expires_in * 1000);
        saveConfig(config);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Disconnect OAuth for a provider
app.post('/api/oauth/disconnect', (req, res) => {
    const { provider } = req.body;
    const config = getConfig();

    if (provider === 'google') {
        delete config.google_oauth;
    } else if (provider === 'openai') {
        delete config.openai_oauth;
    } else {
        return res.status(400).json({ error: 'Unknown provider' });
    }

    saveConfig(config);
    res.json({ success: true });
});

// Auto-refresh token before AI requests (directly calls OAuth providers)
async function ensureValidToken(provider) {
    const config = getConfig();

    if (provider === 'gemini' && config.google_oauth?.access_token) {
        if (config.google_oauth.token_expiry && Date.now() > config.google_oauth.token_expiry - 60000) {
            const refreshToken = config.google_oauth.refresh_token;
            const clientId = config.google_oauth_client_id;
            const clientSecret = config.google_oauth_client_secret || '';
            if (!refreshToken) { console.error('No Google refresh token'); return; }
            try {
                const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: clientId, client_secret: clientSecret,
                        refresh_token: refreshToken, grant_type: 'refresh_token'
                    })
                });
                const tokenData = await tokenRes.json();
                if (tokenData.access_token) {
                    config.google_oauth.access_token = tokenData.access_token;
                    config.google_oauth.token_expiry = Date.now() + (tokenData.expires_in * 1000);
                    saveConfig(config);
                    console.log('Google OAuth token refreshed');
                } else {
                    console.error('Google token refresh failed:', tokenData.error);
                }
            } catch (e) {
                console.error('Google token refresh error:', e.message);
            }
        }
    }

    if (provider === 'openai' && config.openai_oauth?.access_token) {
        if (config.openai_oauth.token_expiry && Date.now() > config.openai_oauth.token_expiry - 60000) {
            const refreshToken = config.openai_oauth.refresh_token;
            if (!refreshToken) { console.error('No OpenAI refresh token'); return; }
            try {
                const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: getConfig().openai_oauth_client_id,
                        refresh_token: refreshToken, grant_type: 'refresh_token'
                    })
                });
                const tokenData = await tokenRes.json();
                if (tokenData.access_token) {
                    config.openai_oauth.access_token = tokenData.access_token;
                    if (tokenData.refresh_token) config.openai_oauth.refresh_token = tokenData.refresh_token;
                    config.openai_oauth.token_expiry = Date.now() + (tokenData.expires_in * 1000);
                    saveConfig(config);
                    console.log('OpenAI OAuth token refreshed');
                } else {
                    console.error('OpenAI token refresh failed:', tokenData.error);
                }
            } catch (e) {
                console.error('OpenAI token refresh error:', e.message);
            }
        }
    }
}

// Stream AI chat endpoint using SSE (multi-provider)
app.get('/api/ai/stream', async (req, res) => {
    const { message, projectId, useContext, currentFile, currentFileContent } = req.query;

    // Determine provider and model
    let provider = req.query.provider;
    let model = req.query.model;

    if (!provider || !model) {
        const defaults = getDefaultProviderAndModel();
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }

    if (!provider) {
        res.status(400).json({ error: 'No AI provider configured. Go to Settings to add an API key.' });
        return;
    }

    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo) {
        res.status(400).json({ error: `Unknown provider: ${provider}` });
        return;
    }

    if (!providerInfo.isAvailable()) {
        res.status(400).json({ error: `${providerInfo.name} is not configured. Add an API key in Settings.` });
        return;
    }

    // Auto-refresh OAuth tokens if needed
    await ensureValidToken(provider);

    if (!message) {
        res.status(400).json({ error: 'Message is required' });
        return;
    }

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    // Notify client which provider/model we're using
    sendEvent('provider_info', { provider, model, providerName: providerInfo.name });

    // Build system prompt
    let systemPrompt = `You are an expert AI assistant built into a LaTeX IDE called SwiftLaTeX (similar to Overleaf). You help users write LaTeX documents, fix compilation errors, improve writing, and manage their research projects.

Key capabilities:
- You can read files in the user's project using the read_file tool
- You can propose edits to files using the edit_file tool (edits require user approval)
- You can list project files using the list_files tool
- Format responses in Markdown. Use code blocks with language tags for code.
- Be concise but thorough. For LaTeX help, provide working code snippets.`;

    // Add workspace context
    if (useContext === 'true' && projectId) {
        const projectPath = getProjectPath(projectId);
        if (projectPath && fs.existsSync(projectPath)) {
            let ctx = `\n\n--- WORKSPACE CONTEXT ---\nProject: ${projectId}\n`;

            // Add current file content if provided
            if (currentFile) {
                ctx += `\nCurrently editing: ${currentFile}\n`;
                if (currentFileContent) {
                    const decoded = decodeURIComponent(currentFileContent);
                    ctx += `\n=== CURRENT FILE CONTENT (${currentFile}) ===\n${decoded.substring(0, 8000)}\n`;
                }
            }

            // File tree
            try {
                function getFilesRec(dir) {
                    let results = [];
                    const list = fs.readdirSync(dir);
                    list.forEach(file => {
                        const fullPath = path.join(dir, file);
                        const stat = fs.statSync(fullPath);
                        if (stat && stat.isDirectory()) {
                            if (!fullPath.includes('.git') && !fullPath.includes('node_modules')) {
                                results = results.concat(getFilesRec(fullPath));
                            }
                        } else {
                            results.push(fullPath);
                        }
                    });
                    return results;
                }
                const files = getFilesRec(projectPath);
                ctx += `\n=== FILES IN WORKSPACE ===\n${files.map(f => path.relative(projectPath, f)).join('\n')}\n`;
            } catch (e) { }

            systemPrompt += ctx;
        }
    }

    // Get or initialize conversation history
    const historyKey = projectId || 'default';
    if (!aiConversations.has(historyKey)) {
        aiConversations.set(historyKey, []);
    }
    const history = aiConversations.get(historyKey);

    // Add user message
    history.push({ role: 'user', content: message });

    // Trim to max history
    while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
    }

    const projectPath = projectId ? getProjectPath(projectId) : null;
    const tools = projectPath ? AI_TOOLS : [];

    try {
        // Build provider-specific messages
        // History is stored in Anthropic format internally; converted per-provider at request time
        let messages = [...history];
        let iterationCount = 0;
        const MAX_ITERATIONS = 5;

        while (iterationCount < MAX_ITERATIONS) {
            iterationCount++;

            // Build the request using the provider abstraction
            let reqConfig;
            if (provider === 'anthropic') {
                reqConfig = buildProviderRequest(provider, model, systemPrompt, messages, tools, true);
            } else if (provider === 'gemini') {
                // For Gemini, we need to convert messages each iteration
                reqConfig = buildProviderRequest(provider, model, systemPrompt, messages, tools, true);
            } else {
                // OpenAI / OpenRouter
                reqConfig = buildProviderRequest(provider, model, systemPrompt, messages, tools, true);
            }

            const response = await fetch(reqConfig.url, {
                method: 'POST',
                headers: reqConfig.headers,
                body: JSON.stringify(reqConfig.body)
            });

            if (!response.ok) {
                const errData = await response.text();
                sendEvent('error', { message: `${providerInfo.name} API Error (${response.status}): ${errData}` });
                break;
            }

            // Process SSE stream using normalized parser
            let currentText = '';
            let toolUseBlocks = [];
            let currentToolUse = null;
            let currentToolInput = '';
            let stopReason = null;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]' || data === '') continue;

                    try {
                        const rawEvent = JSON.parse(data);
                        const parsed = parseProviderSSEEvent(provider, rawEvent);
                        if (!parsed) continue;

                        // Handle array of events (Gemini can return multiple)
                        const events = Array.isArray(parsed) ? parsed : [parsed];

                        for (const evt of events) {
                            if (evt.type === 'text') {
                                currentText += evt.content;
                                sendEvent('text', { content: evt.content });
                            } else if (evt.type === 'tool_start') {
                                currentToolUse = {
                                    id: evt.id,
                                    name: evt.name,
                                    input: ''
                                };
                                currentToolInput = evt.initial_args || '';
                                // Gemini sends complete args at once
                                if (evt.complete_args) {
                                    currentToolUse.input = evt.complete_args;
                                    currentToolInput = '';
                                }
                                sendEvent('tool_start', { name: evt.name, id: evt.id });
                            } else if (evt.type === 'tool_input') {
                                currentToolInput += evt.content;
                            } else if (evt.type === 'tool_stop') {
                                if (currentToolUse) {
                                    if (typeof currentToolUse.input === 'string') {
                                        // Need to parse accumulated JSON
                                        try {
                                            currentToolUse.input = JSON.parse(currentToolInput || '{}');
                                        } catch (e) {
                                            currentToolUse.input = {};
                                        }
                                    }
                                    toolUseBlocks.push(currentToolUse);
                                    currentToolUse = null;
                                    currentToolInput = '';
                                }
                            } else if (evt.type === 'stop') {
                                stopReason = evt.stop_reason;
                            }
                        }
                    } catch (e) {
                        // Skip unparseable events
                    }
                }
            }

            // For OpenAI: finalize any pending tool use (OpenAI sends finish_reason separately)
            if ((provider === 'openai' || provider === 'openrouter') && currentToolUse) {
                try {
                    currentToolUse.input = JSON.parse(currentToolInput || '{}');
                } catch (e) {
                    currentToolUse.input = {};
                }
                toolUseBlocks.push(currentToolUse);
                currentToolUse = null;
                currentToolInput = '';
            }

            // If no tool use, we're done
            if (stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
                // Save assistant response to history (always in Anthropic format)
                history.push({ role: 'assistant', content: currentText });
                sendEvent('done', {});
                break;
            }

            // Process tool calls - build assistant content in Anthropic format (internal)
            const assistantContent = [];
            if (currentText) {
                assistantContent.push({ type: 'text', text: currentText });
            }
            for (const tool of toolUseBlocks) {
                assistantContent.push({
                    type: 'tool_use',
                    id: tool.id,
                    name: tool.name,
                    input: tool.input
                });
            }

            // Execute tools
            const toolResultsRaw = [];
            for (const tool of toolUseBlocks) {
                const result = executeAiTool(tool.name, tool.input, projectPath);
                sendEvent('tool_result', { name: tool.name, id: tool.id, result });
                toolResultsRaw.push({ id: tool.id, name: tool.name, result });
            }

            // Build tool result messages in provider-specific format and add to messages
            if (provider === 'anthropic') {
                const trm = buildToolResultMessages('anthropic', assistantContent, toolResultsRaw);
                messages.push(trm.assistantMsg);
                messages.push(trm.toolResultMsg);
            } else if (provider === 'openai' || provider === 'openrouter') {
                // For OpenAI, we store in Anthropic format internally; buildProviderRequest converts
                messages.push({ role: 'assistant', content: assistantContent });
                messages.push({
                    role: 'user',
                    content: toolResultsRaw.map(tr => ({
                        type: 'tool_result',
                        tool_use_id: tr.id,
                        content: JSON.stringify(tr.result)
                    }))
                });
            } else if (provider === 'gemini') {
                messages.push({ role: 'assistant', content: assistantContent });
                messages.push({
                    role: 'user',
                    content: toolResultsRaw.map(tr => ({
                        type: 'tool_result',
                        tool_use_id: tr.id,
                        content: JSON.stringify(tr.result)
                    }))
                });
            }
        }
    } catch (err) {
        console.error('AI Stream Error:', err);
        sendEvent('error', { message: 'Server error: ' + err.message });
    }

    res.end();
});

// Legacy non-streaming endpoint (kept for compatibility, uses auto-detected provider)
app.post('/api/ai/chat', async (req, res) => {
    const { message, projectId, useContext } = req.body;
    const defaults = getDefaultProviderAndModel();

    if (!defaults.provider) {
        return res.status(400).json({ error: 'No AI provider configured. Go to Settings to add an API key.' });
    }

    // Auto-refresh OAuth tokens if needed
    await ensureValidToken(defaults.provider);

    const systemPrompt = "You are an expert AI assistant in a LaTeX IDE. Help with LaTeX, writing, and code. Use Markdown in responses.";

    try {
        const reqConfig = buildProviderRequest(defaults.provider, defaults.model, systemPrompt,
            [{ role: 'user', content: message }], [], false);

        const response = await fetch(reqConfig.url, {
            method: 'POST',
            headers: reqConfig.headers,
            body: JSON.stringify(reqConfig.body)
        });

        const data = await response.json();
        if (!response.ok) {
            const errMsg = data.error?.message || data.error?.type || JSON.stringify(data);
            return res.status(response.status).json({ error: errMsg });
        }

        // Extract reply based on provider
        let reply = '';
        if (defaults.provider === 'anthropic') {
            reply = (data.content || []).map(c => c.text || '').join('');
        } else if (defaults.provider === 'openai' || defaults.provider === 'openrouter') {
            reply = data.choices?.[0]?.message?.content || '';
        } else if (defaults.provider === 'gemini') {
            reply = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        }

        res.json({ reply });
    } catch (err) {
        res.status(500).json({ error: 'Failed to communicate with AI server: ' + err.message });
    }
});

// Clear AI conversation history
app.delete('/api/ai/history/:projectId', (req, res) => {
    const key = req.params.projectId || 'default';
    aiConversations.delete(key);
    res.json({ success: true });
});

// API: Save AI generated code explicitly to a file
app.post('/api/ai/save', (req, res) => {
    try {
        const { projectId, filename, content } = req.body;
        if (!projectId || !filename) {
            return res.status(400).json({ error: 'Missing projectId or filename' });
        }

        const projectPath = getProjectPath(projectId);
        if (!projectPath || !fs.existsSync(projectPath)) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve and validate path
        const filePath = path.resolve(projectPath, filename);
        if (!filePath.startsWith(path.resolve(projectPath))) {
            return res.status(403).json({ error: 'Forbidden directory traversal' });
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf8');
        res.json({ success: true, message: `Saved ${filename} successfully.` });
    } catch (err) {
        console.error('Failed to save AI content:', err);
        res.status(500).json({ error: 'Failed to save file.' });
    }
});

app.get('/api/canvas/assignments', (req, res) => {
    const dataPath = path.join(__dirname, 'data', 'canvas', 'assignments.json');
    if (fs.existsSync(dataPath)) {
        try {
            const data = fs.readFileSync(dataPath, 'utf8');
            res.json(JSON.parse(data));
        } catch (e) {
            console.error('Error reading assignments:', e);
            res.json([]);
        }
    } else {
        res.json([]);
    }
});

app.listen(PORT, () => {
    const projects = getProjects();
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  LaTeX Compiler Server (Multi-Project)                     ║
║  URL: http://localhost:${PORT}/compile.html                  ║
║  Projects found: ${projects.length}                                        ║
║  Auto-compile: ENABLED                                     ║
╚════════════════════════════════════════════════════════════╝
`);
    projects.forEach(p => console.log(`  - ${p.name}`));

    // Start file watcher
    setupFileWatcher();
});
