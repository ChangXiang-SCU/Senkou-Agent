const express = require('express');
const ical = require('node-ical');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pdfParse = require('pdf-parse');
const chokidar = require('chokidar');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Library data directory
const LIBRARY_DIR = path.resolve(__dirname, 'data', 'library');
const LIBRARY_DB = path.join(LIBRARY_DIR, 'references.json');
const LIBRARY_PDFS = path.join(LIBRARY_DIR, 'pdfs');
const LIBRARY_NOTES = path.join(LIBRARY_DIR, 'notes');
const LIBRARY_COLLECTIONS = path.join(LIBRARY_DIR, 'collections.json');

// Ensure library directories exist
[LIBRARY_DIR, LIBRARY_PDFS, LIBRARY_NOTES].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Per-project library data directories
function getProjectLibraryDir(projectId) {
    const dir = path.resolve(__dirname, 'data', 'projects', projectId, 'library');
    const pdfsDir = path.join(dir, 'pdfs');
    const notesDir = path.join(dir, 'notes');
    [dir, pdfsDir, notesDir].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
    return dir;
}

function readProjectDB(projectId, filename) {
    const filePath = path.join(getProjectLibraryDir(projectId), filename);
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { console.error(`Error reading ${filename} for project ${projectId}:`, e); }
    if (filename === 'collections.json') return [{ id: 'all', name: 'All References', type: 'smart', icon: 'library' }];
    if (filename === 'folders.json') return [];
    return [];
}

function writeProjectDB(projectId, filename, data) {
    const dir = getProjectLibraryDir(projectId);
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

// Multer config for PDF uploads
const pdfUpload = multer({
    dest: LIBRARY_PDFS,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files allowed'), false);
        }
    }
});

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

// ============================================================
// ToolUniverse Integration (Scientific Tool Ecosystem)
// ============================================================
const TOOLUNIVERSE_BASE_URL = process.env.TOOLUNIVERSE_URL || 'http://127.0.0.1:8080';
let _toolUniverseAvailable = null; // null = unknown, true/false = cached
let _toolUniverseLastCheck = 0;
const TOOLUNIVERSE_CHECK_INTERVAL = 60000; // Re-check availability every 60s

/**
 * Check if ToolUniverse HTTP API is available
 * @param {boolean} forceCheck - bypass cache
 * @returns {Promise<boolean>}
 */
async function isToolUniverseAvailable(forceCheck = false) {
    const now = Date.now();
    if (!forceCheck && _toolUniverseAvailable !== null && (now - _toolUniverseLastCheck) < TOOLUNIVERSE_CHECK_INTERVAL) {
        return _toolUniverseAvailable;
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`${TOOLUNIVERSE_BASE_URL}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        _toolUniverseAvailable = resp.ok;
    } catch {
        _toolUniverseAvailable = false;
    }
    _toolUniverseLastCheck = now;
    return _toolUniverseAvailable;
}

/**
 * Call a ToolUniverse method via HTTP API
 * @param {string} method - ToolUniverse method name (e.g. 'run_one_function', 'load_tools')
 * @param {object} kwargs - keyword arguments for the method
 * @returns {Promise<any>} - result from ToolUniverse
 */
async function callToolUniverse(method, kwargs = {}) {
    const resp = await fetch(`${TOOLUNIVERSE_BASE_URL}/api/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, kwargs }),
        signal: AbortSignal.timeout(30000) // 30s timeout
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ToolUniverse API error ${resp.status}: ${text}`);
    }
    return resp.json();
}

/**
 * Execute a scientific tool via ToolUniverse
 * @param {string} toolName - Tool name (e.g. 'SemanticScholarTool_search', 'PubMedRESTTool_search')
 * @param {object} args - Tool arguments
 * @param {object} options - { useCache: false, validate: true }
 * @returns {Promise<any>}
 */
async function executeToolUniverse(toolName, args = {}, options = {}) {
    return callToolUniverse('run_one_function', {
        function_call_json: { name: toolName, arguments: args },
        use_cache: options.useCache || false,
        validate: options.validate !== false
    });
}

/**
 * Search for tools in ToolUniverse by keyword
 * @param {string} keyword
 * @returns {Promise<any>}
 */
async function searchToolUniverseTools(keyword) {
    return callToolUniverse('grep_tools', { keyword });
}

/**
 * Get info about a specific ToolUniverse tool
 * @param {string} toolName
 * @returns {Promise<any>}
 */
async function getToolUniverseInfo(toolName) {
    return callToolUniverse('get_tool_info', { tool_name: toolName });
}

// API: ToolUniverse status check
app.get('/api/tools/status', async (req, res) => {
    try {
        const available = await isToolUniverseAvailable(true);
        if (available) {
            const health = await fetch(`${TOOLUNIVERSE_BASE_URL}/health`).then(r => r.json());
            res.json({ available: true, url: TOOLUNIVERSE_BASE_URL, ...health });
        } else {
            res.json({ available: false, url: TOOLUNIVERSE_BASE_URL, message: 'ToolUniverse HTTP API is not running. Start with: tooluniverse-http-api --port 8080' });
        }
    } catch (e) {
        res.json({ available: false, url: TOOLUNIVERSE_BASE_URL, error: e.message });
    }
});

// API: Search ToolUniverse tools by keyword
app.get('/api/tools/search', async (req, res) => {
    const { keyword } = req.query;
    if (!keyword) return res.status(400).json({ error: 'keyword required' });
    try {
        if (!(await isToolUniverseAvailable())) {
            return res.status(503).json({ error: 'ToolUniverse not available', available: false });
        }
        const result = await searchToolUniverseTools(keyword);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Execute a ToolUniverse tool
app.post('/api/tools/execute', async (req, res) => {
    const { tool, arguments: args } = req.body;
    if (!tool) return res.status(400).json({ error: 'tool name required' });
    try {
        if (!(await isToolUniverseAvailable())) {
            return res.status(503).json({ error: 'ToolUniverse not available', available: false });
        }
        const result = await executeToolUniverse(tool, args || {});
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: List all available ToolUniverse methods
app.get('/api/tools/methods', async (req, res) => {
    try {
        if (!(await isToolUniverseAvailable())) {
            return res.status(503).json({ error: 'ToolUniverse not available', available: false });
        }
        const resp = await fetch(`${TOOLUNIVERSE_BASE_URL}/api/methods`);
        const data = await resp.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

// Read .project.json config for a directory (if exists)
function readProjectConfig(dirPath) {
    const configPath = path.join(dirPath, '.project.json');
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) { console.error('Error reading .project.json:', e); }
    return null;
}

// Write .project.json config for a directory
function writeProjectConfig(dirPath, config) {
    const configPath = path.join(dirPath, '.project.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Detect sub-projects: subdirectories that each contain a compilable main.tex
function detectSubProjects(dirPath) {
    const subs = [];
    try {
        const items = fs.readdirSync(dirPath);
        for (const item of items) {
            if (item.startsWith('.') || item === 'node_modules' || item === '.git') continue;
            const subPath = path.join(dirPath, item);
            if (fs.statSync(subPath).isDirectory()) {
                const mainFile = findMainTexFile(subPath);
                if (mainFile) {
                    const pdfFile = path.join(subPath, mainFile.replace('.tex', '.pdf'));
                    subs.push({
                        name: item,
                        path: item,
                        mainFile: mainFile,
                        hasPdf: fs.existsSync(pdfFile)
                    });
                }
            }
        }
    } catch (e) { console.error('Error detecting sub-projects:', e); }
    return subs;
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
                    // Check for .project.json first (explicit sub-project structure)
                    const projectConfig = readProjectConfig(fullPath);
                    if (projectConfig && projectConfig.subprojects && projectConfig.subprojects.length > 0) {
                        const displayName = prefix ? `${prefix}/${item}` : item;
                        const subprojects = [];
                        for (const sp of projectConfig.subprojects) {
                            const spPath = path.join(fullPath, sp.path);
                            if (fs.existsSync(spPath) && fs.statSync(spPath).isDirectory()) {
                                const spMainFile = findMainTexFile(spPath) || sp.mainFile || null;
                                subprojects.push({
                                    name: sp.name || sp.path,
                                    path: sp.path,
                                    mainFile: spMainFile,
                                    hasPdf: spMainFile ? fs.existsSync(path.join(spPath, spMainFile.replace('.tex', '.pdf'))) : false
                                });
                            }
                        }
                        // Also check if parent itself has a main.tex
                        const parentMainFile = findMainTexFile(fullPath);
                        const activeSubproject = projectConfig.activeSubproject || (subprojects.length > 0 ? subprojects[0].path : null);

                        projects.push({
                            id: Buffer.from(fullPath).toString('base64'),
                            name: projectConfig.name || displayName,
                            path: fullPath,
                            mainFile: parentMainFile || null,
                            hasPdf: parentMainFile ? fs.existsSync(path.join(fullPath, parentMainFile.replace('.tex', '.pdf'))) : false,
                            lastModified: fs.statSync(fullPath).mtimeMs,
                            texFiles: parentMainFile ? getTexFiles(fullPath, parentMainFile) : [],
                            hasMultipleFiles: false,
                            type: 'parent',
                            subprojects: subprojects,
                            activeSubproject: activeSubproject
                        });
                        continue; // Don't recurse into this directory
                    }

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

                        // Auto-detect sub-projects: if this latex project also has subdirs with main.tex
                        let subprojects = [];
                        if (mainFile) {
                            const texFile = path.join(fullPath, mainFile);
                            const pdfFile = path.join(fullPath, mainFile.replace('.tex', '.pdf'));
                            hasPdf = fs.existsSync(pdfFile);
                            lastModified = fs.statSync(texFile).mtimeMs;
                            texFiles = getTexFiles(fullPath, mainFile);
                            // Auto-detect sub-projects
                            subprojects = detectSubProjects(fullPath);
                            // Filter out false positives: sub-dirs that are just sections/chapters
                            subprojects = subprojects.filter(sp => sp.path !== 'sections' && sp.path !== 'chapters' && sp.path !== 'figures');
                        } else {
                            // Non-LaTeX project
                            lastModified = fs.statSync(fullPath).mtimeMs;
                        }

                        const projectData = {
                            id: Buffer.from(fullPath).toString('base64'),
                            name: displayName,
                            path: fullPath,
                            mainFile: mainFile || null,
                            hasPdf: hasPdf,
                            lastModified: lastModified,
                            texFiles: texFiles,
                            hasMultipleFiles: texFiles.length > 1,
                            type: mainFile ? 'latex' : (isCodeProject ? 'code' : 'workspace')
                        };
                        // Only add subprojects if there are any meaningful ones
                        if (subprojects.length > 0) {
                            projectData.subprojects = subprojects;
                            projectData.type = 'parent';
                        }
                        projects.push(projectData);
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
    // Support sub-project path: ?subPath=paper
    const subPath = req.query.subPath;
    const targetPath = subPath ? path.join(projectPath, subPath) : projectPath;
    // Security: ensure targetPath is within projectPath
    if (!path.resolve(targetPath).startsWith(path.resolve(projectPath))) {
        return res.status(403).json({ error: 'Forbidden path traversal' });
    }
    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'Path not found' });
    }
    const fileTree = getFileTree(targetPath);
    res.json(fileTree);
});

// API: Get sub-projects for a project
app.get('/api/subprojects/:projectId', (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }
    // Check .project.json first
    const config = readProjectConfig(projectPath);
    if (config && config.subprojects) {
        const subprojects = config.subprojects.map(sp => {
            const spPath = path.join(projectPath, sp.path);
            const spMainFile = findMainTexFile(spPath) || sp.mainFile || null;
            return {
                name: sp.name || sp.path,
                path: sp.path,
                mainFile: spMainFile,
                hasPdf: spMainFile ? fs.existsSync(path.join(spPath, spMainFile.replace('.tex', '.pdf'))) : false
            };
        });
        res.json({
            subprojects,
            activeSubproject: config.activeSubproject || (subprojects.length > 0 ? subprojects[0].path : null)
        });
    } else {
        // Auto-detect
        const subs = detectSubProjects(projectPath).filter(sp =>
            sp.path !== 'sections' && sp.path !== 'chapters' && sp.path !== 'figures'
        );
        res.json({ subprojects: subs, activeSubproject: subs.length > 0 ? subs[0].path : null });
    }
});

// API: Create a sub-project
app.post('/api/subprojects/:projectId', express.json(), (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }
    const { name, template } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Sub-project name is required' });
    }
    const safeName = name.replace(/[^a-zA-Z0-9-_\u4e00-\u9fff]/g, '-');
    const subPath = path.join(projectPath, safeName);
    if (fs.existsSync(subPath)) {
        return res.status(409).json({ error: 'Sub-project already exists' });
    }
    try {
        fs.mkdirSync(subPath, { recursive: true });
        const content = template === 'blank'
            ? '\\documentclass{article}\n\\begin{document}\n    \n\\end{document}'
            : `\\documentclass{article}\n\\title{${safeName}}\n\\author{}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\n\n\\end{document}`;
        fs.writeFileSync(path.join(subPath, 'main.tex'), content);

        // Update .project.json
        let config = readProjectConfig(projectPath) || { subprojects: [] };
        if (!config.subprojects) config.subprojects = [];
        config.subprojects.push({ name: name, path: safeName });
        writeProjectConfig(projectPath, config);

        console.log(`Created sub-project: ${safeName} in ${projectPath}`);
        res.json({ success: true, name: safeName, path: safeName });
    } catch (err) {
        console.error('Create sub-project failed:', err);
        res.status(500).json({ error: 'Failed to create sub-project', details: err.message });
    }
});

// API: Update project config (set active sub-project, etc.)
app.put('/api/project-config/:projectId', express.json(), (req, res) => {
    const projectPath = getProjectPath(req.params.projectId);
    if (!projectPath) {
        return res.status(400).json({ error: 'Invalid project ID' });
    }
    try {
        let config = readProjectConfig(projectPath) || {};
        // Merge in updates
        if (req.body.activeSubproject !== undefined) config.activeSubproject = req.body.activeSubproject;
        if (req.body.name !== undefined) config.name = req.body.name;
        if (req.body.subprojects !== undefined) config.subprojects = req.body.subprojects;
        writeProjectConfig(projectPath, config);
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update config', details: err.message });
    }
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

    // Support sub-project path via query param
    const subPath = req.query.subPath;
    const targetPath = subPath ? path.join(projectPath, subPath) : projectPath;

    // Security: ensure targetPath is within projectPath
    if (!path.resolve(targetPath).startsWith(path.resolve(projectPath))) {
        return res.status(403).send('Forbidden path traversal');
    }

    // Find the main tex file and its corresponding PDF
    const mainFile = findMainTexFile(targetPath) || 'main.tex';
    const pdfName = mainFile.replace('.tex', '.pdf');
    const pdfPath = path.join(targetPath, pdfName);
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

    // Support sub-project compilation via body.subProjectPath
    const subProjectPath = req.body && req.body.subProjectPath;
    const compilePath = subProjectPath ? path.join(projectPath, subProjectPath) : projectPath;

    // Security: ensure compilePath is within projectPath
    if (!path.resolve(compilePath).startsWith(path.resolve(projectPath))) {
        return res.status(403).json({ success: false, error: 'Forbidden path traversal' });
    }

    console.log(`[${new Date().toISOString()}] Compilation requested for: ${compilePath}${subProjectPath ? ' (sub-project: ' + subProjectPath + ')' : ''}`);

    try {
        const mainFile = findMainTexFile(compilePath);
        if (!mainFile) {
            return res.json({ success: false, error: 'No .tex file found' });
        }

        const texFile = path.join(compilePath, mainFile);
        const baseName = mainFile.replace('.tex', '');

        const execOptions = {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024,
            cwd: compilePath
        };

        const useXeLatex = needsXeLatex(compilePath);
        const latexEngine = useXeLatex ? XELATEX : PDFLATEX;
        console.log(`Using ${useXeLatex ? 'XeLaTeX' : 'pdfLaTeX'} engine`);
        const pdflatexCmd = `"${latexEngine}" -interaction=nonstopmode -output-directory="${compilePath}" "${texFile}"`;
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

        // Check if there's a .bib file and run bibtex (check both compilePath and parent)
        let bibFiles = fs.readdirSync(compilePath).filter(f => f.endsWith('.bib'));
        if (bibFiles.length === 0 && subProjectPath) {
            // Also check parent directory for shared .bib files
            bibFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.bib'));
        }
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
        const pdfPath = path.join(compilePath, `${baseName}.pdf`);
        const pdfExists = fs.existsSync(pdfPath);
        const pdfSize = pdfExists ? fs.statSync(pdfPath).size : 0;

        // Save log
        const logPath = path.join(OUTPUT_DIR, `compile_${Date.now()}.log`);
        fs.writeFileSync(logPath, output);

        // Read LaTeX log
        const texLogPath = path.join(compilePath, `${baseName}.log`);
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
            { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
            { id: 'claude-haiku-4-20250414', name: 'Claude Haiku 4' },
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }
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
            { id: 'gpt-4.1', name: 'GPT-4.1' },
            { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
            { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
            { id: 'o3-mini', name: 'o3-mini' },
            { id: 'o4-mini', name: 'o4-mini' },
            { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' }
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
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
            { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
            { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
            { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' }
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
            { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4 (via OR)' },
            { id: 'openai/gpt-4o', name: 'GPT-4o (via OR)' },
            { id: 'openai/gpt-4.1', name: 'GPT-4.1 (via OR)' },
            { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (via OR)' },
            { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (via OR)' },
            { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (via OR)' },
            { id: 'deepseek/deepseek-chat-v3', name: 'DeepSeek V3 (via OR)' },
            { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick (via OR)' }
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

// Get AI preferences
app.get('/api/ai/preferences', (req, res) => {
    const config = getConfig();
    res.json(config.ai_preferences || {});
});

// Save/update AI preferences
app.post('/api/ai/preferences', (req, res) => {
    const { provider, model, feature_models } = req.body;
    const config = getConfig();
    if (!config.ai_preferences) config.ai_preferences = {};
    if (provider) config.ai_preferences.last_provider = provider;
    if (model) config.ai_preferences.last_model = model;
    // Per-feature model override: { translation: {provider, model}, ideas: {provider, model}, ... }
    if (feature_models) {
        config.ai_preferences.feature_models = { ...(config.ai_preferences.feature_models || {}), ...feature_models };
    }
    saveConfig(config);
    res.json({ success: true });
});

// Get provider/model for a specific feature (with per-feature override)
function getProviderForFeature(featureName) {
    const config = getConfig();
    const prefs = config.ai_preferences || {};
    const featureModels = prefs.feature_models || {};
    if (featureModels[featureName]) {
        const fm = featureModels[featureName];
        const p = AI_PROVIDERS[fm.provider];
        if (p && p.isAvailable()) {
            return { provider: fm.provider, model: fm.model };
        }
    }
    return getDefaultProviderAndModel();
}

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

// ============================================================
// Library API — Reference Management (Zotero-like)
// ============================================================

function readLibraryDB() {
    try {
        if (fs.existsSync(LIBRARY_DB)) {
            return JSON.parse(fs.readFileSync(LIBRARY_DB, 'utf8'));
        }
    } catch (e) { console.error('Error reading library DB:', e); }
    return [];
}

function writeLibraryDB(refs) {
    fs.writeFileSync(LIBRARY_DB, JSON.stringify(refs, null, 2));
}

function readCollections() {
    try {
        if (fs.existsSync(LIBRARY_COLLECTIONS)) {
            return JSON.parse(fs.readFileSync(LIBRARY_COLLECTIONS, 'utf8'));
        }
    } catch (e) { console.error('Error reading collections:', e); }
    return [{ id: 'all', name: 'All References', type: 'smart', icon: 'library' }];
}

function writeCollections(cols) {
    fs.writeFileSync(LIBRARY_COLLECTIONS, JSON.stringify(cols, null, 2));
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Parse BibTeX string into reference objects
function parseBibTeX(bibtex) {
    const refs = [];
    const entryRegex = /@(\w+)\s*\{([^,]*),([^@]*)/g;
    let match;
    while ((match = entryRegex.exec(bibtex)) !== null) {
        const type = match[1].toLowerCase();
        const citeKey = match[2].trim();
        const fieldsStr = match[3];
        const fields = {};
        const fieldRegex = /(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
        let fm;
        while ((fm = fieldRegex.exec(fieldsStr)) !== null) {
            fields[fm[1].toLowerCase()] = fm[2].trim();
        }
        refs.push({
            id: generateId(),
            citeKey: citeKey,
            type: type,
            title: fields.title || '',
            author: fields.author || '',
            year: fields.year || '',
            journal: fields.journal || fields.booktitle || '',
            volume: fields.volume || '',
            number: fields.number || '',
            pages: fields.pages || '',
            doi: fields.doi || '',
            url: fields.url || '',
            abstract: fields.abstract || '',
            keywords: fields.keywords ? fields.keywords.split(',').map(k => k.trim()) : [],
            publisher: fields.publisher || '',
            collections: [],
            tags: [],
            pdfFile: null,
            notes: '',
            dateAdded: new Date().toISOString(),
            dateModified: new Date().toISOString(),
            rating: 0,
            readStatus: 'unread'
        });
    }
    return refs;
}

// Parse RIS format
function parseRIS(ris) {
    const refs = [];
    const entries = ris.split(/\nER\s*-/);
    for (const entry of entries) {
        if (!entry.trim()) continue;
        const fields = {};
        const lines = entry.split('\n');
        let currentTag = '';
        for (const line of lines) {
            const tagMatch = line.match(/^([A-Z][A-Z0-9])\s*-\s*(.*)/);
            if (tagMatch) {
                currentTag = tagMatch[1];
                if (!fields[currentTag]) fields[currentTag] = [];
                fields[currentTag].push(tagMatch[2].trim());
            }
        }
        if (!fields.TY) continue;
        const typeMap = { 'JOUR': 'article', 'CONF': 'inproceedings', 'BOOK': 'book', 'THES': 'phdthesis', 'RPRT': 'techreport', 'CHAP': 'incollection' };
        refs.push({
            id: generateId(),
            citeKey: (fields.ID || [generateId()])[0],
            type: typeMap[(fields.TY || ['JOUR'])[0]] || 'misc',
            title: (fields.TI || fields.T1 || [''])[0],
            author: (fields.AU || fields.A1 || []).join(' and '),
            year: (fields.PY || fields.Y1 || [''])[0].substring(0, 4),
            journal: (fields.JO || fields.JF || fields.T2 || [''])[0],
            volume: (fields.VL || [''])[0],
            number: (fields.IS || [''])[0],
            pages: (fields.SP || [''])[0] + (fields.EP ? '-' + fields.EP[0] : ''),
            doi: (fields.DO || [''])[0],
            url: (fields.UR || [''])[0],
            abstract: (fields.AB || [''])[0],
            keywords: fields.KW || [],
            publisher: (fields.PB || [''])[0],
            collections: [],
            tags: [],
            pdfFile: null,
            notes: '',
            dateAdded: new Date().toISOString(),
            dateModified: new Date().toISOString(),
            rating: 0,
            readStatus: 'unread'
        });
    }
    return refs;
}

// ============================================================
// Per-Project Library API Routes
// ============================================================

// --- References ---
app.get('/api/projects/:projectId/library/references', (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const { collection, tag, search, sort, folder } = req.query;
    let filtered = refs;
    if (folder) {
        filtered = filtered.filter(r => r.folderIds && r.folderIds.includes(folder));
    }
    if (collection && collection !== 'all') {
        filtered = filtered.filter(r => r.collections && r.collections.includes(collection));
    }
    if (tag) {
        filtered = filtered.filter(r => r.tags && r.tags.includes(tag));
    }
    if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(r =>
            (r.title && r.title.toLowerCase().includes(q)) ||
            (r.author && r.author.toLowerCase().includes(q)) ||
            (r.year && r.year.includes(q)) ||
            (r.citeKey && r.citeKey.toLowerCase().includes(q)) ||
            (r.journal && r.journal.toLowerCase().includes(q))
        );
    }
    if (sort === 'year') filtered.sort((a, b) => (b.year || '0') - (a.year || '0'));
    else if (sort === 'title') filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else if (sort === 'author') filtered.sort((a, b) => (a.author || '').localeCompare(b.author || ''));
    else filtered.sort((a, b) => new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0));
    res.json(filtered);
});

app.get('/api/projects/:projectId/library/references/:id', (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ error: 'Reference not found' });
    res.json(ref);
});

app.post('/api/projects/:projectId/library/references', (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const newRef = {
        id: generateId(),
        ...req.body,
        dateAdded: new Date().toISOString(),
        dateModified: new Date().toISOString()
    };
    refs.push(newRef);
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json(newRef);
});

app.put('/api/projects/:projectId/library/references/:id', (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const idx = refs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Reference not found' });
    refs[idx] = { ...refs[idx], ...req.body, dateModified: new Date().toISOString() };
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json(refs[idx]);
});

app.delete('/api/projects/:projectId/library/references/:id', (req, res) => {
    let refs = readProjectDB(req.params.projectId, 'references.json');
    const ref = refs.find(r => r.id === req.params.id);
    if (ref && ref.pdfFile) {
        const pdfPath = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs', ref.pdfFile);
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    }
    refs = refs.filter(r => r.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json({ success: true });
});

// PDF upload for project reference
const projectPdfUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs');
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            cb(null, req.params.id + '.pdf');
        }
    }),
    limits: { fileSize: 100 * 1024 * 1024 }
});

app.post('/api/projects/:projectId/library/references/:id/pdf', projectPdfUpload.single('pdf'), (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const idx = refs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Reference not found' });
    refs[idx].pdfFile = req.params.id + '.pdf';
    refs[idx].dateModified = new Date().toISOString();
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json({ success: true, pdfFile: refs[idx].pdfFile });
});

app.get('/api/projects/:projectId/library/pdf/:filename', (req, res) => {
    const filePath = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF not found' });
    res.sendFile(filePath);
});

// Notes
app.get('/api/projects/:projectId/library/references/:id/notes', (req, res) => {
    const notesFile = path.join(getProjectLibraryDir(req.params.projectId), 'notes', req.params.id + '.md');
    if (fs.existsSync(notesFile)) {
        res.json({ content: fs.readFileSync(notesFile, 'utf8') });
    } else {
        const refs = readProjectDB(req.params.projectId, 'references.json');
        const ref = refs.find(r => r.id === req.params.id);
        res.json({ content: ref?.notes || '' });
    }
});

app.put('/api/projects/:projectId/library/references/:id/notes', (req, res) => {
    const notesDir = path.join(getProjectLibraryDir(req.params.projectId), 'notes');
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, req.params.id + '.md'), req.body.content || '');
    res.json({ success: true });
});

// --- Folders (hierarchical) ---
app.get('/api/projects/:projectId/library/folders', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'folders.json'));
});

app.post('/api/projects/:projectId/library/folders', (req, res) => {
    const folders = readProjectDB(req.params.projectId, 'folders.json');
    const newFolder = {
        id: generateId(),
        name: req.body.name || 'New Folder',
        parentId: req.body.parentId || null,
        order: folders.filter(f => f.parentId === (req.body.parentId || null)).length,
        dateCreated: new Date().toISOString()
    };
    folders.push(newFolder);
    writeProjectDB(req.params.projectId, 'folders.json', folders);
    res.json(newFolder);
});

app.put('/api/projects/:projectId/library/folders/:id', (req, res) => {
    const folders = readProjectDB(req.params.projectId, 'folders.json');
    const idx = folders.findIndex(f => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Folder not found' });
    folders[idx] = { ...folders[idx], ...req.body };
    writeProjectDB(req.params.projectId, 'folders.json', folders);
    res.json(folders[idx]);
});

app.delete('/api/projects/:projectId/library/folders/:id', (req, res) => {
    let folders = readProjectDB(req.params.projectId, 'folders.json');
    // Recursively delete child folders
    function getChildIds(parentId) {
        const children = folders.filter(f => f.parentId === parentId);
        let ids = children.map(c => c.id);
        children.forEach(c => { ids = ids.concat(getChildIds(c.id)); });
        return ids;
    }
    const toDelete = [req.params.id, ...getChildIds(req.params.id)];
    folders = folders.filter(f => !toDelete.includes(f.id));
    writeProjectDB(req.params.projectId, 'folders.json', folders);
    // Remove folder references from refs
    const refs = readProjectDB(req.params.projectId, 'references.json');
    refs.forEach(r => {
        if (r.folderIds) r.folderIds = r.folderIds.filter(fid => !toDelete.includes(fid));
    });
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json({ success: true });
});

// --- Collections (per-project) ---
app.get('/api/projects/:projectId/library/collections', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'collections.json'));
});

app.post('/api/projects/:projectId/library/collections', (req, res) => {
    const cols = readProjectDB(req.params.projectId, 'collections.json');
    const newCol = { id: generateId(), name: req.body.name || 'New Collection', type: 'user', icon: req.body.icon || 'folder', parentId: req.body.parentId || null };
    cols.push(newCol);
    writeProjectDB(req.params.projectId, 'collections.json', cols);
    res.json(newCol);
});

app.delete('/api/projects/:projectId/library/collections/:id', (req, res) => {
    let cols = readProjectDB(req.params.projectId, 'collections.json');
    cols = cols.filter(c => c.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'collections.json', cols);
    res.json({ success: true });
});

// --- Reviews (per-project) ---
app.get('/api/projects/:projectId/library/reviews', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'reviews.json'));
});

app.get('/api/projects/:projectId/library/reviews/:id', (req, res) => {
    const reviews = readProjectDB(req.params.projectId, 'reviews.json');
    const review = reviews.find(r => r.id === req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
});

app.post('/api/projects/:projectId/library/reviews', (req, res) => {
    const reviews = readProjectDB(req.params.projectId, 'reviews.json');
    const newReview = {
        id: generateId(),
        title: req.body.title || 'Untitled Review',
        topic: req.body.topic || '',
        referenceIds: req.body.referenceIds || [],
        content: '',
        status: 'draft',
        dateCreated: new Date().toISOString(),
        dateModified: new Date().toISOString()
    };
    reviews.push(newReview);
    writeProjectDB(req.params.projectId, 'reviews.json', reviews);
    res.json(newReview);
});

app.put('/api/projects/:projectId/library/reviews/:id', (req, res) => {
    const reviews = readProjectDB(req.params.projectId, 'reviews.json');
    const idx = reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Review not found' });
    reviews[idx] = { ...reviews[idx], ...req.body, dateModified: new Date().toISOString() };
    writeProjectDB(req.params.projectId, 'reviews.json', reviews);
    res.json(reviews[idx]);
});

app.delete('/api/projects/:projectId/library/reviews/:id', (req, res) => {
    let reviews = readProjectDB(req.params.projectId, 'reviews.json');
    reviews = reviews.filter(r => r.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'reviews.json', reviews);
    res.json({ success: true });
});

// --- Ideas (per-project) ---
app.get('/api/projects/:projectId/library/ideas', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'ideas.json'));
});

app.get('/api/projects/:projectId/library/ideas/:id', (req, res) => {
    const ideas = readProjectDB(req.params.projectId, 'ideas.json');
    const idea = ideas.find(i => i.id === req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    res.json(idea);
});

app.post('/api/projects/:projectId/library/ideas', (req, res) => {
    const ideas = readProjectDB(req.params.projectId, 'ideas.json');
    const newIdea = {
        id: generateId(),
        title: req.body.title || 'New Research Idea',
        description: req.body.description || '',
        sourceReviewId: req.body.sourceReviewId || null,
        sourceReferenceIds: req.body.sourceReferenceIds || [],
        content: req.body.content || '',
        status: req.body.status || 'draft',
        feasibility: null, novelty: null, impact: null,
        notes: '', refinements: [],
        dateCreated: new Date().toISOString(),
        dateModified: new Date().toISOString()
    };
    ideas.push(newIdea);
    writeProjectDB(req.params.projectId, 'ideas.json', ideas);
    res.json(newIdea);
});

app.put('/api/projects/:projectId/library/ideas/:id', (req, res) => {
    const ideas = readProjectDB(req.params.projectId, 'ideas.json');
    const idx = ideas.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Idea not found' });
    ideas[idx] = { ...ideas[idx], ...req.body, dateModified: new Date().toISOString() };
    writeProjectDB(req.params.projectId, 'ideas.json', ideas);
    res.json(ideas[idx]);
});

app.delete('/api/projects/:projectId/library/ideas/:id', (req, res) => {
    let ideas = readProjectDB(req.params.projectId, 'ideas.json');
    ideas = ideas.filter(i => i.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'ideas.json', ideas);
    res.json({ success: true });
});

// --- Plans (per-project) ---
app.get('/api/projects/:projectId/library/plans', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'plans.json'));
});

app.get('/api/projects/:projectId/library/plans/:id', (req, res) => {
    const plans = readProjectDB(req.params.projectId, 'plans.json');
    const plan = plans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
});

app.post('/api/projects/:projectId/library/plans', (req, res) => {
    const plans = readProjectDB(req.params.projectId, 'plans.json');
    const newPlan = {
        id: generateId(),
        title: req.body.title || 'New Research Plan',
        ideaId: req.body.ideaId || null,
        content: req.body.content || '',
        todos: req.body.todos || [],
        status: req.body.status || 'draft',
        dateCreated: new Date().toISOString(),
        dateModified: new Date().toISOString()
    };
    plans.push(newPlan);
    writeProjectDB(req.params.projectId, 'plans.json', plans);
    res.json(newPlan);
});

app.put('/api/projects/:projectId/library/plans/:id', (req, res) => {
    const plans = readProjectDB(req.params.projectId, 'plans.json');
    const idx = plans.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Plan not found' });
    plans[idx] = { ...plans[idx], ...req.body, dateModified: new Date().toISOString() };
    writeProjectDB(req.params.projectId, 'plans.json', plans);
    res.json(plans[idx]);
});

app.delete('/api/projects/:projectId/library/plans/:id', (req, res) => {
    let plans = readProjectDB(req.params.projectId, 'plans.json');
    plans = plans.filter(p => p.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'plans.json', plans);
    res.json({ success: true });
});

// --- Semantic Scholar Search ---
app.get('/api/search/papers', async (req, res) => {
    const { query, limit } = req.query;
    if (!query) return res.status(400).json({ error: 'Query required' });
    try {
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit || 10}&fields=title,authors,year,abstract,citationCount,externalIds,openAccessPdf,venue,publicationDate`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`S2 API error: ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Semantic Scholar search error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Multi-Source Paper Search (Phase 1.1) ---
// Searches across Semantic Scholar, arXiv, Crossref, OpenAlex, and optionally ToolUniverse
app.get('/api/search/papers/multi', async (req, res) => {
    const { query, sources, limit: rawLimit } = req.query;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const maxResults = Math.min(parseInt(rawLimit) || 10, 30);
    const requestedSources = sources ? sources.split(',') : ['s2', 'arxiv', 'crossref', 'openalex'];
    const results = [];
    const errors = {};
    const seenDOIs = new Set();
    const seenTitles = new Set();

    // Helper: normalize title for dedup
    const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);

    // Helper: add result with dedup
    function addResult(paper) {
        const doi = paper.doi ? paper.doi.replace(/^https?:\/\/doi\.org\//, '') : null;
        if (doi && seenDOIs.has(doi)) return;
        const nt = normTitle(paper.title);
        if (nt && seenTitles.has(nt)) return;
        if (doi) seenDOIs.add(doi);
        if (nt) seenTitles.add(nt);
        results.push(paper);
    }

    const fetchPromises = [];

    // --- Semantic Scholar ---
    if (requestedSources.includes('s2')) {
        fetchPromises.push((async () => {
            try {
                const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=title,authors,year,abstract,citationCount,externalIds,openAccessPdf,venue,publicationDate`;
                const resp = await fetch(url, { headers: { 'User-Agent': 'SenkouAgent/1.0' }, signal: AbortSignal.timeout(10000) });
                if (!resp.ok) throw new Error(`S2: ${resp.status}`);
                const data = await resp.json();
                (data.data || []).forEach(p => addResult({
                    source: 's2',
                    id: p.paperId,
                    title: p.title,
                    authors: (p.authors || []).map(a => a.name),
                    year: p.year,
                    abstract: p.abstract,
                    citationCount: p.citationCount,
                    doi: p.externalIds?.DOI,
                    arxivId: p.externalIds?.ArXiv,
                    pdfUrl: p.openAccessPdf?.url,
                    venue: p.venue,
                    publicationDate: p.publicationDate
                }));
            } catch (e) { errors.s2 = e.message; }
        })());
    }

    // --- arXiv ---
    if (requestedSources.includes('arxiv')) {
        fetchPromises.push((async () => {
            try {
                const arxivQuery = encodeURIComponent(query);
                const resp = await fetch(`http://export.arxiv.org/api/query?search_query=all:${arxivQuery}&max_results=${maxResults}&sortBy=relevance`, { signal: AbortSignal.timeout(10000) });
                if (!resp.ok) throw new Error(`arXiv: ${resp.status}`);
                const text = await resp.text();
                // Parse arXiv Atom XML
                const entries = text.split('<entry>').slice(1);
                entries.forEach(entry => {
                    const get = (tag) => { const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
                    const arxivId = get('id').replace('http://arxiv.org/abs/', '');
                    const title = get('title').replace(/\s+/g, ' ');
                    const abstract = get('summary').replace(/\s+/g, ' ');
                    const published = get('published');
                    const authors = [];
                    const authorMatches = entry.matchAll(/<name>([^<]+)<\/name>/g);
                    for (const m of authorMatches) authors.push(m[1]);
                    // Extract DOI link if present
                    const doiMatch = entry.match(/href="https?:\/\/dx\.doi\.org\/([^"]+)"/);
                    addResult({
                        source: 'arxiv',
                        id: arxivId,
                        title,
                        authors,
                        year: published ? parseInt(published.substring(0, 4)) : null,
                        abstract,
                        doi: doiMatch ? doiMatch[1] : null,
                        arxivId,
                        pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
                        publicationDate: published ? published.substring(0, 10) : null
                    });
                });
            } catch (e) { errors.arxiv = e.message; }
        })());
    }

    // --- Crossref ---
    if (requestedSources.includes('crossref')) {
        fetchPromises.push((async () => {
            try {
                const resp = await fetch(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}&select=DOI,title,author,published-print,published-online,abstract,is-referenced-by-count,container-title`, {
                    headers: { 'User-Agent': 'SenkouAgent/1.0 (mailto:research@senkou.app)' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!resp.ok) throw new Error(`Crossref: ${resp.status}`);
                const data = await resp.json();
                (data.message?.items || []).forEach(item => {
                    const pubDate = item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
                    addResult({
                        source: 'crossref',
                        id: item.DOI,
                        title: Array.isArray(item.title) ? item.title[0] : item.title,
                        authors: (item.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')),
                        year: pubDate ? pubDate[0] : null,
                        abstract: item.abstract ? item.abstract.replace(/<[^>]*>/g, '') : null,
                        citationCount: item['is-referenced-by-count'],
                        doi: item.DOI,
                        venue: Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'],
                        publicationDate: pubDate ? pubDate.join('-') : null
                    });
                });
            } catch (e) { errors.crossref = e.message; }
        })());
    }

    // --- OpenAlex ---
    if (requestedSources.includes('openalex')) {
        fetchPromises.push((async () => {
            try {
                const resp = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${maxResults}&select=id,doi,title,authorships,publication_year,cited_by_count,primary_location,open_access,abstract_inverted_index`, {
                    headers: { 'User-Agent': 'SenkouAgent/1.0 (mailto:research@senkou.app)' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!resp.ok) throw new Error(`OpenAlex: ${resp.status}`);
                const data = await resp.json();
                (data.results || []).forEach(w => {
                    // Reconstruct abstract from inverted index
                    let abstract = null;
                    if (w.abstract_inverted_index) {
                        const words = [];
                        for (const [word, positions] of Object.entries(w.abstract_inverted_index)) {
                            for (const pos of positions) words[pos] = word;
                        }
                        abstract = words.join(' ');
                    }
                    addResult({
                        source: 'openalex',
                        id: w.id?.replace('https://openalex.org/', ''),
                        title: w.title,
                        authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
                        year: w.publication_year,
                        abstract,
                        citationCount: w.cited_by_count,
                        doi: w.doi?.replace('https://doi.org/', ''),
                        pdfUrl: w.open_access?.oa_url || w.primary_location?.pdf_url,
                        venue: w.primary_location?.source?.display_name
                    });
                });
            } catch (e) { errors.openalex = e.message; }
        })());
    }

    // --- ToolUniverse (PubMed, Europe PMC, BioRxiv, DBLP, DOAJ) ---
    if (requestedSources.includes('pubmed') || requestedSources.includes('tu')) {
        fetchPromises.push((async () => {
            try {
                if (!(await isToolUniverseAvailable())) {
                    errors.tooluniverse = 'ToolUniverse not available';
                    return;
                }
                // Use PubMed search via ToolUniverse
                const result = await executeToolUniverse('PubMedRESTTool_search', { query, max_results: maxResults });
                if (result && Array.isArray(result)) {
                    result.forEach(p => addResult({ source: 'pubmed_tu', ...p }));
                }
            } catch (e) { errors.tooluniverse = e.message; }
        })());
    }

    await Promise.all(fetchPromises);

    // Sort by citation count (descending), then by year (descending)
    results.sort((a, b) => {
        const ca = a.citationCount || 0, cb = b.citationCount || 0;
        if (cb !== ca) return cb - ca;
        return (b.year || 0) - (a.year || 0);
    });

    res.json({
        query,
        total: results.length,
        sources: requestedSources,
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        results: results.slice(0, maxResults * 2) // Allow up to 2x results from multiple sources
    });
});

// --- Citation Graph Traversal (Phase 1.2) ---
app.get('/api/search/citations/:paperId', async (req, res) => {
    const { paperId } = req.params;
    const { direction, depth: rawDepth, limit: rawLimit } = req.query;
    const dir = direction || 'both'; // references, citations, both
    const maxDepth = Math.min(parseInt(rawDepth) || 1, 2);
    const perPage = Math.min(parseInt(rawLimit) || 20, 50);

    try {
        const result = { paperId, references: [], citations: [] };
        const fields = 'title,authors,year,abstract,citationCount,externalIds,openAccessPdf,venue';

        // Get references (papers this paper cites)
        if (dir === 'references' || dir === 'both') {
            const url = `https://api.semanticscholar.org/graph/v1/paper/${paperId}/references?fields=${fields}&limit=${perPage}`;
            const resp = await fetch(url, { headers: { 'User-Agent': 'SenkouAgent/1.0' }, signal: AbortSignal.timeout(15000) });
            if (resp.ok) {
                const data = await resp.json();
                result.references = (data.data || []).filter(d => d.citedPaper).map(d => ({
                    id: d.citedPaper.paperId,
                    title: d.citedPaper.title,
                    authors: (d.citedPaper.authors || []).map(a => a.name),
                    year: d.citedPaper.year,
                    abstract: d.citedPaper.abstract,
                    citationCount: d.citedPaper.citationCount,
                    doi: d.citedPaper.externalIds?.DOI,
                    pdfUrl: d.citedPaper.openAccessPdf?.url,
                    venue: d.citedPaper.venue
                }));
            }
        }

        // Get citations (papers that cite this paper)
        if (dir === 'citations' || dir === 'both') {
            const url = `https://api.semanticscholar.org/graph/v1/paper/${paperId}/citations?fields=${fields}&limit=${perPage}`;
            const resp = await fetch(url, { headers: { 'User-Agent': 'SenkouAgent/1.0' }, signal: AbortSignal.timeout(15000) });
            if (resp.ok) {
                const data = await resp.json();
                result.citations = (data.data || []).filter(d => d.citingPaper).map(d => ({
                    id: d.citingPaper.paperId,
                    title: d.citingPaper.title,
                    authors: (d.citingPaper.authors || []).map(a => a.name),
                    year: d.citingPaper.year,
                    abstract: d.citingPaper.abstract,
                    citationCount: d.citingPaper.citationCount,
                    doi: d.citingPaper.externalIds?.DOI,
                    pdfUrl: d.citingPaper.openAccessPdf?.url,
                    venue: d.citingPaper.venue
                }));
            }
        }

        result.totalReferences = result.references.length;
        result.totalCitations = result.citations.length;
        res.json(result);
    } catch (e) {
        console.error('Citation traversal error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Download PDF from URL ---
app.post('/api/projects/:projectId/library/references/:id/download-pdf', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const pdfDir = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs');
        const filename = req.params.id + '.pdf';
        fs.writeFileSync(path.join(pdfDir, filename), buffer);
        // Update reference
        const refs = readProjectDB(req.params.projectId, 'references.json');
        const idx = refs.findIndex(r => r.id === req.params.id);
        if (idx !== -1) {
            refs[idx].pdfFile = filename;
            refs[idx].dateModified = new Date().toISOString();
            writeProjectDB(req.params.projectId, 'references.json', refs);
        }
        res.json({ success: true, pdfFile: filename });
    } catch (e) {
        console.error('PDF download error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Translation API ---
app.post('/api/translate', async (req, res) => {
    const { text, mode, sourceLang, targetLang } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    if (mode === 'free') {
        // Use MyMemory free translation API
        try {
            const langPair = `${sourceLang || 'en'}|${targetLang || 'zh'}`;
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.substring(0, 500))}&langpair=${langPair}`;
            const response = await fetch(url);
            const data = await response.json();
            res.json({ translation: data.responseData?.translatedText || '', source: 'MyMemory' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        // Use AI translation via configured provider
        let provider = req.body.provider;
        let model = req.body.model;
        if (!provider || !model) {
            const defaults = getDefaultProviderAndModel();
            provider = provider || defaults.provider;
            model = model || defaults.model;
        }
        if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
        const providerInfo = AI_PROVIDERS[provider];
        if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
        await ensureValidToken(provider);

        try {
            const systemPrompt = 'You are an academic translator. Translate the following text to Chinese. Include a brief explanation of any technical/academic terms. Format: first the translation, then on a new line starting with "Terms:" explain key terms.';
            const messages = [{ role: 'user', content: text }];
            const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], false);

            const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            const data = await response.json();

            // Extract content based on provider
            let content = '';
            if (provider === 'anthropic') {
                content = data.content?.[0]?.text || '';
            } else if (provider === 'gemini') {
                content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else {
                content = data.choices?.[0]?.message?.content || '';
            }
            res.json({ translation: content, source: 'AI' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
});

// --- AI Review Generation (per-project) ---
app.post('/api/projects/:projectId/library/reviews/:id/generate', async (req, res) => {
    const projectId = req.params.projectId;
    const reviews = readProjectDB(projectId, 'reviews.json');
    const reviewIdx = reviews.findIndex(r => r.id === req.params.id);
    if (reviewIdx === -1) return res.status(404).json({ error: 'Review not found' });

    const review = reviews[reviewIdx];
    const refs = readProjectDB(projectId, 'references.json');
    const reviewRefs = refs.filter(r => review.referenceIds.includes(r.id));

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getDefaultProviderAndModel();
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    const refSummaries = reviewRefs.map(r => `- ${r.title} (${r.author}, ${r.year}): ${r.abstract || 'No abstract'}`).join('\n');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    try {
        const systemPrompt = 'You are a research assistant writing a comprehensive literature review. Write in academic style with proper structure (Introduction, Themes, Gaps, Conclusion). Reference papers by author and year.';
        const messages = [{ role: 'user', content: `Write a literature review on "${review.topic || review.title}" based on these papers:\n${refSummaries}` }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });

        if (!response.ok) {
            sendEvent('error', { message: `API error: ${response.status}` });
            res.write(`data: [DONE]\n\n`);
            res.end();
            return;
        }

        let fullContent = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const parsed = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') {
                        if (parsed.type === 'content_block_delta' && parsed.delta?.text) text = parsed.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = parsed.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }
                    if (text) {
                        fullContent += text;
                        sendEvent('text', { content: text });
                    }
                } catch {}
            }
        }

        // Save to DB
        reviews[reviewIdx].content = fullContent;
        reviews[reviewIdx].status = 'completed';
        reviews[reviewIdx].dateModified = new Date().toISOString();
        writeProjectDB(projectId, 'reviews.json', reviews);

        sendEvent('done', {});
        res.end();
    } catch (e) {
        sendEvent('error', { message: e.message });
        res.write(`data: [DONE]\n\n`);
        res.end();
    }
});

// --- AI Ideas Generation (per-project) ---
app.post('/api/projects/:projectId/library/ideas/generate', async (req, res) => {
    const projectId = req.params.projectId;
    const refs = readProjectDB(projectId, 'references.json');
    const reviews = readProjectDB(projectId, 'reviews.json');

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('ideas');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    let context = '';
    if (req.body.reviewId) {
        const review = reviews.find(r => r.id === req.body.reviewId);
        if (review) context = `Based on literature review "${review.title}":\n${review.content}\n\n`;
    }
    const refContext = refs.slice(0, 20).map(r => `- ${r.title} (${r.author}, ${r.year})`).join('\n');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    try {
        const systemPrompt = 'Generate 5 novel research ideas based on the provided literature. For each idea provide: Title, Description (2-3 sentences), Feasibility (1-10), Novelty (1-10), Impact (1-10). Format as JSON array.';
        const messages = [{ role: 'user', content: `${context}References:\n${refContext}\n\nGenerate research ideas.` }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });

        if (!response.ok) {
            sendEvent('error', { message: `API error: ${response.status}` });
            res.write(`data: [DONE]\n\n`);
            res.end();
            return;
        }

        let fullContent = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const parsed = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') {
                        if (parsed.type === 'content_block_delta' && parsed.delta?.text) text = parsed.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = parsed.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }
                    if (text) {
                        fullContent += text;
                        sendEvent('text', { content: text });
                    }
                } catch {}
            }
        }

        // Auto-save ideas
        try {
            const jsonMatch = fullContent.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const ideasData = JSON.parse(jsonMatch[0]);
                const ideas = readProjectDB(projectId, 'ideas.json');
                for (const idea of ideasData) {
                    ideas.push({
                        id: generateId(),
                        title: idea.Title || idea.title || 'Untitled',
                        description: idea.Description || idea.description || '',
                        content: '',
                        status: 'draft',
                        feasibility: idea.Feasibility || idea.feasibility || null,
                        novelty: idea.Novelty || idea.novelty || null,
                        impact: idea.Impact || idea.impact || null,
                        notes: '', refinements: [],
                        sourceReviewId: req.body.reviewId || null,
                        sourceReferenceIds: [],
                        dateCreated: new Date().toISOString(),
                        dateModified: new Date().toISOString()
                    });
                }
                writeProjectDB(projectId, 'ideas.json', ideas);
            }
        } catch (parseErr) { console.error('Failed to auto-save ideas:', parseErr); }

        sendEvent('done', {});
        res.end();
    } catch (e) {
        sendEvent('error', { message: e.message });
        res.write(`data: [DONE]\n\n`);
        res.end();
    }
});

// --- AI Plans Generation (per-project) ---
app.post('/api/projects/:projectId/library/plans/generate', async (req, res) => {
    const projectId = req.params.projectId;
    const ideas = readProjectDB(projectId, 'ideas.json');

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('plans');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    let ideaContext = '';
    if (req.body.ideaId) {
        const idea = ideas.find(i => i.id === req.body.ideaId);
        if (idea) ideaContext = `Based on research idea "${idea.title}": ${idea.description}\n\n`;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    try {
        const systemPrompt = 'Create a detailed research plan with phases, milestones, and methodology. Format in Markdown with clear sections.';
        const messages = [{ role: 'user', content: `${ideaContext}Create a comprehensive research plan.` }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });

        if (!response.ok) {
            sendEvent('error', { message: `API error: ${response.status}` });
            res.write(`data: [DONE]\n\n`);
            res.end();
            return;
        }

        let fullContent = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const parsed = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') {
                        if (parsed.type === 'content_block_delta' && parsed.delta?.text) text = parsed.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = parsed.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }
                    if (text) {
                        fullContent += text;
                        sendEvent('text', { content: text });
                    }
                } catch {}
            }
        }

        // Auto-save plan
        const plans = readProjectDB(projectId, 'plans.json');
        plans.push({
            id: generateId(),
            title: req.body.title || 'Research Plan',
            ideaId: req.body.ideaId || null,
            content: fullContent,
            todos: [],
            status: 'draft',
            dateCreated: new Date().toISOString(),
            dateModified: new Date().toISOString()
        });
        writeProjectDB(projectId, 'plans.json', plans);

        sendEvent('done', {});
        res.end();
    } catch (e) {
        sendEvent('error', { message: e.message });
        res.write(`data: [DONE]\n\n`);
        res.end();
    }
});

// --- Batch operations (per-project) ---
app.post('/api/projects/:projectId/library/batch', (req, res) => {
    const { action, ids, data } = req.body;
    const refs = readProjectDB(req.params.projectId, 'references.json');

    if (action === 'delete') {
        const remaining = refs.filter(r => !ids.includes(r.id));
        writeProjectDB(req.params.projectId, 'references.json', remaining);
    } else if (action === 'addToFolder') {
        refs.forEach(r => {
            if (ids.includes(r.id)) {
                if (!r.folderIds) r.folderIds = [];
                if (!r.folderIds.includes(data.folderId)) r.folderIds.push(data.folderId);
            }
        });
        writeProjectDB(req.params.projectId, 'references.json', refs);
    } else if (action === 'addTag') {
        refs.forEach(r => {
            if (ids.includes(r.id)) {
                if (!r.tags) r.tags = [];
                if (!r.tags.includes(data.tag)) r.tags.push(data.tag);
            }
        });
        writeProjectDB(req.params.projectId, 'references.json', refs);
    }
    res.json({ success: true });
});

// --- BibTeX import (per-project) ---
app.post('/api/projects/:projectId/library/import/bibtex', (req, res) => {
    const { bibtex } = req.body;
    if (!bibtex) return res.status(400).json({ error: 'BibTeX content required' });
    const parsed = parseBibTeX(bibtex);
    const refs = readProjectDB(req.params.projectId, 'references.json');
    parsed.forEach(r => {
        r.dateAdded = new Date().toISOString();
        r.dateModified = new Date().toISOString();
    });
    refs.push(...parsed);
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json({ imported: parsed.length, references: parsed });
});

// --- DOI Lookup ---
app.get('/api/doi/lookup', async (req, res) => {
    const { doi } = req.query;
    if (!doi) return res.status(400).json({ error: 'DOI required' });
    try {
        const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`CrossRef error: ${response.status}`);
        const data = await response.json();
        const item = data.message;
        res.json({
            title: item.title?.[0] || '',
            author: (item.author || []).map(a => `${a.given || ''} ${a.family || ''}`).join(', '),
            year: item.published?.['date-parts']?.[0]?.[0]?.toString() || '',
            journal: item['container-title']?.[0] || '',
            doi: item.DOI || doi,
            abstract: item.abstract || '',
            url: item.URL || ''
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET global library folders (returns empty array since global library uses collections, not folders)
app.get('/api/library/folders', (req, res) => {
    res.json([]);
});

// GET all references
app.get('/api/library/references', (req, res) => {
    const refs = readLibraryDB();
    const { collection, tag, search, sort } = req.query;
    let filtered = refs;
    if (collection && collection !== 'all') {
        filtered = filtered.filter(r => r.collections && r.collections.includes(collection));
    }
    if (tag) {
        filtered = filtered.filter(r => r.tags && r.tags.includes(tag));
    }
    if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(r =>
            (r.title && r.title.toLowerCase().includes(q)) ||
            (r.author && r.author.toLowerCase().includes(q)) ||
            (r.year && r.year.includes(q)) ||
            (r.citeKey && r.citeKey.toLowerCase().includes(q)) ||
            (r.journal && r.journal.toLowerCase().includes(q))
        );
    }
    if (sort === 'year') filtered.sort((a, b) => (b.year || '0') - (a.year || '0'));
    else if (sort === 'title') filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else if (sort === 'author') filtered.sort((a, b) => (a.author || '').localeCompare(b.author || ''));
    else if (sort === 'dateAdded') filtered.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    else filtered.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    res.json(filtered);
});

// GET single reference
app.get('/api/library/references/:id', (req, res) => {
    const refs = readLibraryDB();
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ error: 'Reference not found' });
    res.json(ref);
});

// POST create reference
app.post('/api/library/references', (req, res) => {
    const refs = readLibraryDB();
    const newRef = {
        id: generateId(),
        citeKey: req.body.citeKey || '',
        type: req.body.type || 'article',
        title: req.body.title || '',
        author: req.body.author || '',
        year: req.body.year || '',
        journal: req.body.journal || '',
        volume: req.body.volume || '',
        number: req.body.number || '',
        pages: req.body.pages || '',
        doi: req.body.doi || '',
        url: req.body.url || '',
        abstract: req.body.abstract || '',
        keywords: req.body.keywords || [],
        publisher: req.body.publisher || '',
        collections: req.body.collections || [],
        tags: req.body.tags || [],
        pdfFile: null,
        notes: req.body.notes || '',
        dateAdded: new Date().toISOString(),
        dateModified: new Date().toISOString(),
        rating: 0,
        readStatus: 'unread'
    };
    refs.push(newRef);
    writeLibraryDB(refs);
    res.json(newRef);
});

// PUT update reference
app.put('/api/library/references/:id', (req, res) => {
    const refs = readLibraryDB();
    const idx = refs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Reference not found' });
    const updated = { ...refs[idx], ...req.body, dateModified: new Date().toISOString() };
    updated.id = refs[idx].id; // prevent id change
    refs[idx] = updated;
    writeLibraryDB(refs);
    res.json(updated);
});

// DELETE reference
app.delete('/api/library/references/:id', (req, res) => {
    let refs = readLibraryDB();
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ error: 'Reference not found' });
    // Delete associated PDF
    if (ref.pdfFile) {
        const pdfPath = path.join(LIBRARY_PDFS, ref.pdfFile);
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    }
    refs = refs.filter(r => r.id !== req.params.id);
    writeLibraryDB(refs);
    res.json({ success: true });
});

// POST import BibTeX/RIS
app.post('/api/library/import', (req, res) => {
    const { format, content, collectionId } = req.body;
    let parsed = [];
    try {
        if (format === 'bibtex') {
            parsed = parseBibTeX(content);
        } else if (format === 'ris') {
            parsed = parseRIS(content);
        } else {
            return res.status(400).json({ error: 'Unsupported format. Use bibtex or ris.' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Parse error: ' + e.message });
    }
    if (collectionId && collectionId !== 'all') {
        parsed.forEach(r => r.collections.push(collectionId));
    }
    const refs = readLibraryDB();
    // Deduplicate by DOI or title+year
    let added = 0, skipped = 0;
    for (const newRef of parsed) {
        const isDuplicate = refs.some(r =>
            (newRef.doi && r.doi && newRef.doi.toLowerCase() === r.doi.toLowerCase()) ||
            (newRef.title && r.title && newRef.title.toLowerCase() === r.title.toLowerCase() && newRef.year === r.year)
        );
        if (!isDuplicate) {
            refs.push(newRef);
            added++;
        } else {
            skipped++;
        }
    }
    writeLibraryDB(refs);
    res.json({ success: true, added, skipped, total: refs.length });
});

// POST export BibTeX
app.post('/api/library/export', (req, res) => {
    const { ids, format } = req.body;
    const refs = readLibraryDB();
    const toExport = ids ? refs.filter(r => ids.includes(r.id)) : refs;
    if (format === 'bibtex') {
        const bibtex = toExport.map(r => {
            let entry = `@${r.type}{${r.citeKey || r.id},\n`;
            if (r.title) entry += `  title = {${r.title}},\n`;
            if (r.author) entry += `  author = {${r.author}},\n`;
            if (r.year) entry += `  year = {${r.year}},\n`;
            if (r.journal) entry += `  journal = {${r.journal}},\n`;
            if (r.volume) entry += `  volume = {${r.volume}},\n`;
            if (r.number) entry += `  number = {${r.number}},\n`;
            if (r.pages) entry += `  pages = {${r.pages}},\n`;
            if (r.doi) entry += `  doi = {${r.doi}},\n`;
            if (r.url) entry += `  url = {${r.url}},\n`;
            if (r.publisher) entry += `  publisher = {${r.publisher}},\n`;
            if (r.abstract) entry += `  abstract = {${r.abstract}},\n`;
            entry += `}\n`;
            return entry;
        }).join('\n');
        res.setHeader('Content-Type', 'text/plain');
        res.send(bibtex);
    } else {
        res.status(400).json({ error: 'Unsupported export format' });
    }
});

// --- Auto-PDF helper: find DOI by title via Crossref, then find PDF via Unpaywall ---
async function findDOIByTitle(title) {
    if (!title) return null;
    try {
        const query = encodeURIComponent(title.substring(0, 200));
        const cRes = await fetch(`https://api.crossref.org/works?query.title=${query}&rows=3&select=DOI,title`, {
            headers: { 'User-Agent': 'SenkouAgent/1.0 (mailto:senkou@example.com)' }
        });
        if (!cRes.ok) return null;
        const cData = await cRes.json();
        const items = cData.message?.items || [];
        // Find best match: compare titles case-insensitively
        const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizedTitle = normalize(title);
        for (const item of items) {
            const itemTitle = (item.title && item.title[0]) || '';
            if (normalize(itemTitle) === normalizedTitle) {
                return item.DOI;
            }
        }
        // If no exact match, return first result if title is similar enough
        if (items.length > 0 && items[0].title && items[0].title[0]) {
            const first = normalize(items[0].title[0]);
            if (normalizedTitle.length > 10 && (first.includes(normalizedTitle.substring(0, 30)) || normalizedTitle.includes(first.substring(0, 30)))) {
                return items[0].DOI;
            }
        }
        return null;
    } catch (e) {
        console.log('Crossref lookup failed:', e.message);
        return null;
    }
}

async function findPdfUrl(ref) {
    let doi = ref.doi;
    let pdfUrl = null;
    let foundDoi = null;

    // Strategy 0: If no DOI, try to find one via Crossref using the title
    if (!doi && ref.title) {
        console.log(`[auto-pdf] No DOI for "${ref.title.substring(0, 50)}...", searching Crossref...`);
        foundDoi = await findDOIByTitle(ref.title);
        if (foundDoi) {
            console.log(`[auto-pdf] Found DOI via Crossref: ${foundDoi}`);
            doi = foundDoi;
        }
    }

    // Strategy 1: Try Unpaywall API for open-access PDF
    if (doi) {
        try {
            const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//, '');
            const uRes = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}?email=senkou@example.com`);
            if (uRes.ok) {
                const uData = await uRes.json();
                // Check best_oa_location first, then all oa_locations
                if (uData.best_oa_location?.url_for_pdf) {
                    pdfUrl = uData.best_oa_location.url_for_pdf;
                    console.log(`[auto-pdf] Unpaywall best_oa_location PDF: ${pdfUrl}`);
                } else if (uData.oa_locations) {
                    for (const loc of uData.oa_locations) {
                        if (loc.url_for_pdf) {
                            pdfUrl = loc.url_for_pdf;
                            console.log(`[auto-pdf] Unpaywall alt oa_location PDF: ${pdfUrl}`);
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            console.log('Unpaywall lookup failed:', e.message);
        }
    }

    // Strategy 2: Try Semantic Scholar API for open-access PDF
    if (!pdfUrl && (doi || ref.title)) {
        try {
            let s2Url;
            if (doi) {
                const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//, '');
                s2Url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(cleanDoi)}?fields=isOpenAccess,openAccessPdf`;
            } else {
                s2Url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(ref.title.substring(0, 200))}&limit=1&fields=isOpenAccess,openAccessPdf`;
            }
            const s2Res = await fetch(s2Url, {
                headers: { 'User-Agent': 'SenkouAgent/1.0' }
            });
            if (s2Res.ok) {
                const s2Data = await s2Res.json();
                const paper = s2Data.data ? s2Data.data[0] : s2Data;
                if (paper?.openAccessPdf?.url) {
                    pdfUrl = paper.openAccessPdf.url;
                    console.log(`[auto-pdf] Semantic Scholar PDF: ${pdfUrl}`);
                }
            }
        } catch (e) {
            console.log('Semantic Scholar lookup failed:', e.message);
        }
    }

    // Strategy 3: Try arXiv if DOI contains arxiv or title search on arXiv
    if (!pdfUrl && ref.title) {
        try {
            const arxivQuery = encodeURIComponent(ref.title.substring(0, 200));
            const arxivRes = await fetch(`http://export.arxiv.org/api/query?search_query=ti:"${arxivQuery}"&max_results=1`);
            if (arxivRes.ok) {
                const arxivText = await arxivRes.text();
                // Parse arXiv ID from the response
                const idMatch = arxivText.match(/<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
                if (idMatch && idMatch[1] && idMatch[1] !== 'http://arxiv.org/api/errors') {
                    // Verify title match from the result
                    const titleMatch = arxivText.match(/<title>([^<]+)<\/title>/g);
                    if (titleMatch && titleMatch.length > 1) {
                        const resultTitle = titleMatch[1].replace(/<\/?title>/g, '').trim();
                        const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (normalize(resultTitle).includes(normalize(ref.title).substring(0, 30))) {
                            pdfUrl = `https://arxiv.org/pdf/${idMatch[1]}.pdf`;
                            console.log(`[auto-pdf] arXiv PDF: ${pdfUrl}`);
                        }
                    }
                }
            }
        } catch (e) {
            console.log('arXiv lookup failed:', e.message);
        }
    }

    // Strategy 4: Try the reference URL directly (might be a direct PDF link)
    if (!pdfUrl && ref.url) {
        pdfUrl = ref.url;
        console.log(`[auto-pdf] Trying reference URL: ${pdfUrl}`);
    }

    // Strategy 5: Try DOI redirect URL with Accept: application/pdf header
    // (some publishers serve PDF directly when asked)
    if (!pdfUrl && doi) {
        const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//, '');
        pdfUrl = `https://doi.org/${cleanDoi}`;
        console.log(`[auto-pdf] Trying DOI redirect: ${pdfUrl}`);
    }

    return { pdfUrl, foundDoi };
}

async function downloadAndVerifyPdf(pdfUrl) {
    try {
        const response = await fetch(pdfUrl, {
            headers: {
                'Accept': 'application/pdf,*/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) {
            console.log(`[auto-pdf] Download failed: HTTP ${response.status} from ${pdfUrl}`);
            return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || '';
        console.log(`[auto-pdf] Downloaded ${buffer.length} bytes, content-type: ${contentType}`);
        // Verify it's actually a PDF (check magic bytes %PDF or content-type)
        const isPdfMagic = buffer.length > 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
        if (isPdfMagic || (contentType.includes('pdf') && buffer.length > 1000)) {
            return buffer;
        }
        console.log(`[auto-pdf] Content is not PDF (first bytes: ${buffer.slice(0, 20).toString()})`);
        return null;
    } catch (e) {
        console.log(`[auto-pdf] Download error from ${pdfUrl}: ${e.message}`);
        return null;
    }
}

// Auto-download PDF for global library reference
app.post('/api/library/references/:id/auto-pdf', express.json(), async (req, res) => {
    const refs = readLibraryDB();
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ success: false, message: 'Reference not found' });
    if (ref.pdfFile) return res.json({ success: true, pdfFile: ref.pdfFile, message: 'PDF already exists' });

    const { pdfUrl, foundDoi } = await findPdfUrl(ref);

    // Save discovered DOI even if PDF download fails
    if (foundDoi && !ref.doi) {
        const idx2 = refs.findIndex(r => r.id === req.params.id);
        if (idx2 !== -1) { refs[idx2].doi = foundDoi; writeLibraryDB(refs); }
    }

    if (!pdfUrl) {
        return res.json({ success: false, message: 'No open-access PDF found. The paper may be behind a paywall.' });
    }

    try {
        const buffer = await downloadAndVerifyPdf(pdfUrl);
        if (!buffer) {
            return res.json({ success: false, message: 'No open-access PDF available. The paper may require institutional access.' });
        }
        const filename = req.params.id + '.pdf';
        fs.writeFileSync(path.join(LIBRARY_PDFS, filename), buffer);
        const idx = refs.findIndex(r => r.id === req.params.id);
        if (idx !== -1) {
            refs[idx].pdfFile = filename;
            if (foundDoi && !refs[idx].doi) refs[idx].doi = foundDoi;
            refs[idx].dateModified = new Date().toISOString();
            writeLibraryDB(refs);
        }
        res.json({ success: true, pdfFile: filename });
    } catch (e) {
        console.error('Auto-PDF download error:', e.message);
        res.json({ success: false, message: 'PDF download failed: ' + e.message });
    }
});

// Auto-download PDF for project library reference
app.post('/api/projects/:projectId/library/references/:id/auto-pdf', express.json(), async (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ success: false, message: 'Reference not found' });
    if (ref.pdfFile) return res.json({ success: true, pdfFile: ref.pdfFile });

    const { pdfUrl, foundDoi } = await findPdfUrl(ref);

    // Save discovered DOI even if PDF download fails
    if (foundDoi && !ref.doi) {
        const idx2 = refs.findIndex(r => r.id === req.params.id);
        if (idx2 !== -1) { refs[idx2].doi = foundDoi; writeProjectDB(req.params.projectId, 'references.json', refs); }
    }

    if (!pdfUrl) {
        return res.json({ success: false, message: 'No open-access PDF found. The paper may be behind a paywall.' });
    }

    try {
        const buffer = await downloadAndVerifyPdf(pdfUrl);
        if (!buffer) {
            return res.json({ success: false, message: 'No open-access PDF available. The paper may require institutional access.' });
        }
        const pdfDir = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs');
        if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
        const filename = req.params.id + '.pdf';
        fs.writeFileSync(path.join(pdfDir, filename), buffer);
        const idx = refs.findIndex(r => r.id === req.params.id);
        if (idx !== -1) {
            refs[idx].pdfFile = filename;
            if (foundDoi && !refs[idx].doi) refs[idx].doi = foundDoi;
            refs[idx].dateModified = new Date().toISOString();
            writeProjectDB(req.params.projectId, 'references.json', refs);
        }
        res.json({ success: true, pdfFile: filename });
    } catch (e) {
        res.json({ success: false, message: 'PDF download failed: ' + e.message });
    }
});

// PDF upload for a reference
app.post('/api/library/references/:id/pdf', pdfUpload.single('pdf'), (req, res) => {
    const refs = readLibraryDB();
    const idx = refs.findIndex(r => r.id === req.params.id);
    if (idx === -1) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'Reference not found' });
    }
    // Delete old PDF if exists
    if (refs[idx].pdfFile) {
        const oldPath = path.join(LIBRARY_PDFS, refs[idx].pdfFile);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const ext = '.pdf';
    const newFilename = req.params.id + ext;
    const newPath = path.join(LIBRARY_PDFS, newFilename);
    fs.renameSync(req.file.path, newPath);
    refs[idx].pdfFile = newFilename;
    refs[idx].dateModified = new Date().toISOString();
    writeLibraryDB(refs);
    res.json({ success: true, pdfFile: newFilename });
});

// Serve library PDF
app.get('/api/library/pdf/:filename', (req, res) => {
    const filePath = path.join(LIBRARY_PDFS, req.params.filename);
    if (!path.resolve(filePath).startsWith(path.resolve(LIBRARY_PDFS))) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
});

// Collections CRUD
app.get('/api/library/collections', (req, res) => {
    res.json(readCollections());
});

app.post('/api/library/collections', (req, res) => {
    const cols = readCollections();
    const newCol = {
        id: generateId(),
        name: req.body.name || 'New Collection',
        type: 'user',
        icon: req.body.icon || 'folder',
        parentId: req.body.parentId || null,
        dateCreated: new Date().toISOString()
    };
    cols.push(newCol);
    writeCollections(cols);
    res.json(newCol);
});

app.put('/api/library/collections/:id', (req, res) => {
    const cols = readCollections();
    const idx = cols.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Collection not found' });
    cols[idx] = { ...cols[idx], ...req.body };
    cols[idx].id = req.params.id;
    writeCollections(cols);
    res.json(cols[idx]);
});

app.delete('/api/library/collections/:id', (req, res) => {
    if (req.params.id === 'all') return res.status(400).json({ error: 'Cannot delete default collection' });
    let cols = readCollections();
    cols = cols.filter(c => c.id !== req.params.id);
    writeCollections(cols);
    // Remove collection from references
    const refs = readLibraryDB();
    refs.forEach(r => {
        if (r.collections) r.collections = r.collections.filter(c => c !== req.params.id);
    });
    writeLibraryDB(refs);
    res.json({ success: true });
});

// Notes for reference
app.get('/api/library/references/:id/notes', (req, res) => {
    const notePath = path.join(LIBRARY_NOTES, req.params.id + '.md');
    if (fs.existsSync(notePath)) {
        res.json({ notes: fs.readFileSync(notePath, 'utf8') });
    } else {
        const refs = readLibraryDB();
        const ref = refs.find(r => r.id === req.params.id);
        res.json({ notes: ref ? ref.notes || '' : '' });
    }
});

app.put('/api/library/references/:id/notes', (req, res) => {
    const notePath = path.join(LIBRARY_NOTES, req.params.id + '.md');
    fs.writeFileSync(notePath, req.body.notes || '');
    // Also update in DB
    const refs = readLibraryDB();
    const idx = refs.findIndex(r => r.id === req.params.id);
    if (idx !== -1) {
        refs[idx].notes = req.body.notes || '';
        refs[idx].dateModified = new Date().toISOString();
        writeLibraryDB(refs);
    }
    res.json({ success: true });
});

// Batch operations
app.post('/api/library/batch', (req, res) => {
    const { action, ids, data } = req.body;
    let refs = readLibraryDB();
    if (action === 'delete') {
        refs.forEach(r => {
            if (ids.includes(r.id) && r.pdfFile) {
                const pdfPath = path.join(LIBRARY_PDFS, r.pdfFile);
                if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
            }
        });
        refs = refs.filter(r => !ids.includes(r.id));
    } else if (action === 'addToCollection') {
        refs.forEach(r => {
            if (ids.includes(r.id) && data.collectionId) {
                if (!r.collections) r.collections = [];
                if (!r.collections.includes(data.collectionId)) r.collections.push(data.collectionId);
            }
        });
    } else if (action === 'removeFromCollection') {
        refs.forEach(r => {
            if (ids.includes(r.id) && data.collectionId) {
                if (r.collections) r.collections = r.collections.filter(c => c !== data.collectionId);
            }
        });
    } else if (action === 'addTag') {
        refs.forEach(r => {
            if (ids.includes(r.id) && data.tag) {
                if (!r.tags) r.tags = [];
                if (!r.tags.includes(data.tag)) r.tags.push(data.tag);
            }
        });
    } else if (action === 'setReadStatus') {
        refs.forEach(r => {
            if (ids.includes(r.id)) r.readStatus = data.status;
        });
    }
    writeLibraryDB(refs);
    res.json({ success: true, affected: ids.length });
});

// Library stats
app.get('/api/library/stats', (req, res) => {
    const refs = readLibraryDB();
    const cols = readCollections();
    const tags = new Set();
    refs.forEach(r => (r.tags || []).forEach(t => tags.add(t)));
    res.json({
        totalReferences: refs.length,
        totalCollections: cols.length,
        totalTags: tags.size,
        withPdf: refs.filter(r => r.pdfFile).length,
        byType: refs.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {}),
        byYear: refs.reduce((acc, r) => { if (r.year) { acc[r.year] = (acc[r.year] || 0) + 1; } return acc; }, {}),
        recentlyAdded: refs.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded)).slice(0, 5).map(r => ({ id: r.id, title: r.title, dateAdded: r.dateAdded }))
    });
});

// ============================================================
// Phase 3: AI Paper Analysis API
// ============================================================

// Analyze a paper using AI — structured analysis, summary, translation
app.post('/api/library/analyze', async (req, res) => {
    const { referenceId, analysisType, language } = req.body;
    // analysisType: 'full_analysis' | 'summary' | 'translate' | 'key_findings' | 'methodology' | 'custom'
    // language: 'en' | 'zh' for translation target

    if (!referenceId) {
        return res.status(400).json({ error: 'referenceId is required' });
    }

    const refs = readLibraryDB();
    const ref = refs.find(r => r.id === referenceId);
    if (!ref) {
        return res.status(404).json({ error: 'Reference not found' });
    }

    // Determine provider (with per-feature override for analysis)
    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('analysis');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }

    if (!provider) {
        return res.status(400).json({ error: 'No AI provider configured. Go to Settings to add an API key.' });
    }

    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) {
        return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    }

    await ensureValidToken(provider);

    // Extract text from PDF if available
    let paperText = '';
    if (ref.pdfFile) {
        const pdfPath = path.join(LIBRARY_PDFS, ref.pdfFile);
        if (fs.existsSync(pdfPath)) {
            try {
                const dataBuffer = fs.readFileSync(pdfPath);
                const data = await pdfParse(dataBuffer);
                paperText = data.text;
            } catch (e) {
                console.error('PDF parse error:', e.message);
            }
        }
    }

    // If no PDF text, use metadata
    if (!paperText && ref.abstract) {
        paperText = `Title: ${ref.title || 'Unknown'}\nAuthors: ${ref.author || 'Unknown'}\nYear: ${ref.year || 'Unknown'}\nJournal: ${ref.journal || 'Unknown'}\n\nAbstract:\n${ref.abstract}`;
    }

    if (!paperText) {
        return res.status(400).json({ error: 'No PDF or abstract available for analysis. Upload a PDF first.' });
    }

    // Truncate to avoid token limits (roughly 80k chars ~ 20k tokens)
    const maxChars = 80000;
    if (paperText.length > maxChars) {
        paperText = paperText.substring(0, maxChars) + '\n\n[... text truncated due to length ...]';
    }

    // Build analysis prompt based on type
    const type = analysisType || 'full_analysis';
    let analysisPrompt = '';

    const paperContext = `Paper: "${ref.title || 'Unknown'}" by ${ref.author || 'Unknown'} (${ref.year || 'Unknown'})${ref.journal ? ', published in ' + ref.journal : ''}`;

    if (type === 'full_analysis') {
        analysisPrompt = `You are an expert academic paper analyst. Analyze the following research paper and provide a comprehensive structured analysis.

${paperContext}

Please provide your analysis in the following structure (use Markdown formatting):

## 📋 Paper Overview
- **Title**:
- **Authors**:
- **Year**:
- **Venue/Journal**:
- **Paper Type**: (empirical study / theoretical / survey / system paper / etc.)

## 🎯 Research Problem & Motivation
- What problem does this paper address?
- Why is this problem important?
- What gap in existing research does it fill?

## 💡 Key Contributions
- List the main contributions (numbered)

## 🔬 Methodology
- What approach/method is used?
- Key techniques, algorithms, or frameworks
- Datasets used (if applicable)

## 📊 Key Results & Findings
- Main experimental results
- Notable metrics or benchmarks
- Comparison with baselines

## 💪 Strengths
- What does this paper do well?

## ⚠️ Limitations & Weaknesses
- Identified limitations
- Potential weaknesses in methodology

## 🔗 Related Work & Context
- Key related papers and how this work relates
- Research area and subfield

## 🚀 Future Directions
- Suggested future work mentioned by authors
- Potential extensions

## 📝 Key Takeaways
- 3-5 bullet points summarizing the most important things to remember

Here is the paper text:

${paperText}`;
    } else if (type === 'summary') {
        analysisPrompt = `You are an expert academic paper analyst. Provide a concise summary of the following paper.

${paperContext}

Write a clear, well-structured summary (about 300-500 words) covering:
1. The main problem and motivation
2. The proposed approach
3. Key results
4. Main conclusions

Use Markdown formatting.

Paper text:

${paperText}`;
    } else if (type === 'translate') {
        const targetLang = language === 'zh' ? 'Chinese (简体中文)' : 'English';
        const sourceLang = language === 'zh' ? 'English' : 'Chinese';
        analysisPrompt = `You are an expert academic translator. Translate the key content of this paper to ${targetLang}.

${paperContext}

Provide:
## 翻译摘要 / Translated Summary

Translate the abstract and key sections to ${targetLang}. Maintain academic tone and technical accuracy.

## 关键术语对照 / Key Term Glossary

Provide a bilingual glossary of key technical terms used in this paper (${sourceLang} → ${targetLang}).

Paper text:

${paperText}`;
    } else if (type === 'key_findings') {
        analysisPrompt = `You are an expert academic paper analyst. Extract and analyze the key findings from this paper.

${paperContext}

Provide:
## 🔑 Key Findings

List each key finding with:
- **Finding**: Description
- **Evidence**: What data/experiment supports it
- **Significance**: Why it matters
- **Confidence**: How strong is the evidence (strong/moderate/preliminary)

## 📊 Quantitative Results

Extract all numerical results, metrics, and benchmarks mentioned.

## 🎯 Main Conclusion

Summarize the paper's main conclusion in 2-3 sentences.

Paper text:

${paperText}`;
    } else if (type === 'methodology') {
        analysisPrompt = `You are an expert research methodologist. Analyze the research methodology of this paper in detail.

${paperContext}

Provide:
## 🔬 Research Design
- Type of study (experimental, observational, theoretical, etc.)
- Research questions or hypotheses

## 📐 Methods & Techniques
- Detailed description of methods used
- Algorithms or models employed
- Implementation details

## 📊 Data & Evaluation
- Datasets used (with details: size, source, preprocessing)
- Evaluation metrics
- Experimental setup

## ✅ Methodological Strengths
- What aspects of the methodology are well-designed?

## ⚠️ Methodological Concerns
- Potential issues with the methodology
- Threats to validity
- Missing controls or comparisons

## 🔄 Reproducibility Assessment
- How reproducible is this work?
- Is code/data available?
- Are there sufficient details to replicate?

Paper text:

${paperText}`;
    } else {
        // Custom: use the prompt from req.body.customPrompt
        analysisPrompt = req.body.customPrompt || `Analyze this paper: ${paperText}`;
    }

    // SSE stream response
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    sendEvent('start', { analysisType: type, provider, model });

    try {
        const messages = [{ role: 'user', content: analysisPrompt }];
        const systemPrompt = 'You are an expert academic paper analyst. Provide detailed, accurate, and well-structured analysis. Use Markdown formatting.';

        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, {
            method: 'POST',
            headers: apiReq.headers,
            body: JSON.stringify(apiReq.body)
        });

        if (!response.ok) {
            const errText = await response.text();
            sendEvent('error', { message: `API error: ${response.status} - ${errText.substring(0, 200)}` });
            sendEvent('done', {});
            res.end();
            return;
        }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;

                    // Extract text based on provider format
                    if (provider === 'anthropic') {
                        if (data.type === 'content_block_delta' && data.delta?.text) {
                            text = data.delta.text;
                        }
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = data.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }

                    if (text) {
                        fullText += text;
                        sendEvent('text', { content: text });
                    }
                } catch (e) { }
            }
        }

        // Save analysis result
        saveAnalysisResult(referenceId, type, fullText, provider, model);
        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// Helper: save analysis result to reference
function saveAnalysisResult(referenceId, analysisType, content, provider, model) {
    try {
        const refs = readLibraryDB();
        const idx = refs.findIndex(r => r.id === referenceId);
        if (idx === -1) return;

        if (!refs[idx].analyses) refs[idx].analyses = {};
        refs[idx].analyses[analysisType] = {
            content,
            provider,
            model,
            timestamp: new Date().toISOString()
        };
        refs[idx].dateModified = new Date().toISOString();
        writeLibraryDB(refs);
    } catch (e) {
        console.error('Error saving analysis result:', e.message);
    }
}

// Get saved analysis for a reference
app.get('/api/library/references/:id/analysis', (req, res) => {
    const refs = readLibraryDB();
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ error: 'Reference not found' });
    res.json({ analyses: ref.analyses || {} });
});

// Delete a specific analysis
app.delete('/api/library/references/:id/analysis/:type', (req, res) => {
    const refs = readLibraryDB();
    const idx = refs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Reference not found' });

    if (refs[idx].analyses && refs[idx].analyses[req.params.type]) {
        delete refs[idx].analyses[req.params.type];
        refs[idx].dateModified = new Date().toISOString();
        writeLibraryDB(refs);
    }
    res.json({ success: true });
});

// ============================================================
// Phase 4: Literature Review Workflow
// ============================================================

const REVIEWS_DB = path.join(LIBRARY_DIR, 'reviews.json');

function readReviewsDB() {
    if (!fs.existsSync(REVIEWS_DB)) return [];
    try { return JSON.parse(fs.readFileSync(REVIEWS_DB, 'utf8')); }
    catch { return []; }
}

function writeReviewsDB(reviews) {
    fs.writeFileSync(REVIEWS_DB, JSON.stringify(reviews, null, 2), 'utf8');
}

// CRUD for literature reviews
app.get('/api/library/reviews', (req, res) => {
    res.json(readReviewsDB());
});

app.get('/api/library/reviews/:id', (req, res) => {
    const reviews = readReviewsDB();
    const review = reviews.find(r => r.id === req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
});

app.post('/api/library/reviews', (req, res) => {
    const { title, topic, referenceIds, description } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const review = {
        id: generateId(),
        title,
        topic: topic || '',
        description: description || '',
        referenceIds: referenceIds || [],
        content: null,
        status: 'draft', // draft | generating | completed
        dateCreated: new Date().toISOString(),
        dateModified: new Date().toISOString(),
        generationHistory: []
    };

    const reviews = readReviewsDB();
    reviews.push(review);
    writeReviewsDB(reviews);
    res.json(review);
});

app.put('/api/library/reviews/:id', (req, res) => {
    const reviews = readReviewsDB();
    const idx = reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Review not found' });

    const allowed = ['title', 'topic', 'description', 'referenceIds', 'content', 'status'];
    for (const key of allowed) {
        if (req.body[key] !== undefined) reviews[idx][key] = req.body[key];
    }
    reviews[idx].dateModified = new Date().toISOString();
    writeReviewsDB(reviews);
    res.json(reviews[idx]);
});

app.delete('/api/library/reviews/:id', (req, res) => {
    let reviews = readReviewsDB();
    reviews = reviews.filter(r => r.id !== req.params.id);
    writeReviewsDB(reviews);
    res.json({ success: true });
});

// Generate literature review using AI
app.post('/api/library/reviews/:id/generate', async (req, res) => {
    const reviews = readReviewsDB();
    const reviewIdx = reviews.findIndex(r => r.id === req.params.id);
    if (reviewIdx === -1) return res.status(404).json({ error: 'Review not found' });

    const review = reviews[reviewIdx];
    const refs = readLibraryDB();

    // Get references for this review
    const reviewRefs = refs.filter(r => review.referenceIds.includes(r.id));
    if (reviewRefs.length === 0) {
        return res.status(400).json({ error: 'No references in this review. Add references first.' });
    }

    // Determine provider
    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getDefaultProviderAndModel();
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }

    if (!provider) {
        return res.status(400).json({ error: 'No AI provider configured.' });
    }

    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) {
        return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    }

    await ensureValidToken(provider);

    // Build synthesis context from all references
    let papersContext = '';
    for (const ref of reviewRefs) {
        let paperText = '';

        // Try to get PDF text
        if (ref.pdfFile) {
            const pdfPath = path.join(LIBRARY_PDFS, ref.pdfFile);
            if (fs.existsSync(pdfPath)) {
                try {
                    const dataBuffer = fs.readFileSync(pdfPath);
                    const data = await pdfParse(dataBuffer);
                    paperText = data.text.substring(0, 15000); // Limit per paper
                } catch (e) { }
            }
        }

        // Fallback to abstract
        if (!paperText && ref.abstract) {
            paperText = ref.abstract;
        }

        // Use saved analysis if available
        let analysisText = '';
        if (ref.analyses?.full_analysis?.content) {
            analysisText = ref.analyses.full_analysis.content.substring(0, 5000);
        } else if (ref.analyses?.summary?.content) {
            analysisText = ref.analyses.summary.content;
        }

        papersContext += `\n\n--- PAPER ${reviewRefs.indexOf(ref) + 1} ---\n`;
        papersContext += `Title: ${ref.title || 'Unknown'}\n`;
        papersContext += `Authors: ${ref.author || 'Unknown'}\n`;
        papersContext += `Year: ${ref.year || 'Unknown'}\n`;
        papersContext += `Journal/Venue: ${ref.journal || 'Unknown'}\n`;
        if (ref.doi) papersContext += `DOI: ${ref.doi}\n`;
        if (analysisText) {
            papersContext += `\n[AI Analysis Summary]:\n${analysisText}\n`;
        }
        if (paperText) {
            papersContext += `\n[Paper Content]:\n${paperText}\n`;
        } else if (!analysisText) {
            papersContext += `\n[No content available - only metadata]\n`;
        }
    }

    // Truncate total context
    if (papersContext.length > 100000) {
        papersContext = papersContext.substring(0, 100000) + '\n\n[... truncated due to length ...]';
    }

    const reviewStyle = req.body.style || 'comprehensive'; // comprehensive | thematic | chronological | critical

    const synthesisPrompt = `You are an expert academic researcher writing a literature review.

Topic: ${review.topic || review.title}
${review.description ? `Description: ${review.description}` : ''}
Number of papers: ${reviewRefs.length}
Review style: ${reviewStyle}

Please write a comprehensive literature review that synthesizes all the papers below. Structure your review as follows:

## 📋 Overview
- Brief introduction to the research area
- Scope of this review (${reviewRefs.length} papers)
- Key time period covered

## 🔍 Thematic Analysis
- Identify and discuss major themes across the papers
- Group related papers together
- Show how different papers relate to each other

## 📈 Chronological Development
- How has the field evolved over time?
- Key milestones and breakthroughs

## 💡 Key Contributions
- Most impactful findings across all papers
- Novel methods or approaches introduced

## 🔬 Methodological Landscape
- Common methodologies used
- Emerging methods
- Methodological trends

## ⚠️ Research Gaps
- What areas are underexplored?
- What questions remain unanswered?
- Where do the papers disagree or have conflicting findings?

## 🚀 Future Directions
- Promising research directions based on identified gaps
- Emerging trends
- Potential interdisciplinary opportunities

## 📊 Summary Table
Create a comparison table of all papers with: Title | Year | Method | Key Finding | Limitation

## 📝 Conclusion
- Overall state of the field
- Most pressing open problems
- Recommendations for future researchers

Use Markdown formatting. Cite papers by [Author, Year] format. Be thorough, analytical, and identify connections between papers.

Here are the papers:
${papersContext}`;

    // Update review status
    reviews[reviewIdx].status = 'generating';
    writeReviewsDB(reviews);

    // SSE stream
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    sendEvent('start', { provider, model, paperCount: reviewRefs.length });

    try {
        const messages = [{ role: 'user', content: synthesisPrompt }];
        const systemPrompt = 'You are an expert academic researcher specializing in writing comprehensive literature reviews. Provide thorough, well-structured analysis with proper citations. Use Markdown formatting.';

        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, {
            method: 'POST',
            headers: apiReq.headers,
            body: JSON.stringify(apiReq.body)
        });

        if (!response.ok) {
            const errText = await response.text();
            sendEvent('error', { message: `API error: ${response.status}` });
            reviews[reviewIdx].status = 'draft';
            writeReviewsDB(reviews);
            sendEvent('done', {});
            res.end();
            return;
        }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;

                    if (provider === 'anthropic') {
                        if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = data.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }

                    if (text) {
                        fullText += text;
                        sendEvent('text', { content: text });
                    }
                } catch (e) { }
            }
        }

        // Save review content
        const updatedReviews = readReviewsDB();
        const uIdx = updatedReviews.findIndex(r => r.id === req.params.id);
        if (uIdx !== -1) {
            updatedReviews[uIdx].content = fullText;
            updatedReviews[uIdx].status = 'completed';
            updatedReviews[uIdx].dateModified = new Date().toISOString();
            updatedReviews[uIdx].generationHistory.push({
                timestamp: new Date().toISOString(),
                provider,
                model,
                length: fullText.length,
                paperCount: reviewRefs.length
            });
            writeReviewsDB(updatedReviews);
        }

        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        const updatedReviews = readReviewsDB();
        const uIdx = updatedReviews.findIndex(r => r.id === req.params.id);
        if (uIdx !== -1) {
            updatedReviews[uIdx].status = 'draft';
            writeReviewsDB(updatedReviews);
        }
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 1.4: Deep Literature Review (Iterative Gap Analysis)
// ============================================================
// Multi-round review: generate draft → identify gaps → auto-search → regenerate

app.post('/api/library/reviews/:id/generate-deep', express.json(), async (req, res) => {
    const reviews = readReviewsDB();
    const reviewIdx = reviews.findIndex(r => r.id === req.params.id);
    if (reviewIdx === -1) return res.status(404).json({ error: 'Review not found' });

    const review = reviews[reviewIdx];
    const refs = readLibraryDB();
    const reviewRefs = refs.filter(r => review.referenceIds.includes(r.id));
    if (reviewRefs.length === 0) {
        return res.status(400).json({ error: 'No references in this review. Add references first.' });
    }

    // Determine provider
    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getDefaultProviderAndModel();
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    const reviewStyle = req.body.style || 'comprehensive';
    const template = req.body.template || 'comprehensive'; // systematic|narrative|critical|scoping
    const maxIterations = Math.min(parseInt(req.body.iterations) || 2, 3);

    // SSE setup
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    reviews[reviewIdx].status = 'generating';
    writeReviewsDB(reviews);
    sendEvent('start', { provider, model, paperCount: reviewRefs.length, mode: 'deep', maxIterations });

    // Helper: build papers context from a list of references
    function buildPapersContext(refList) {
        let ctx = '';
        for (const ref of refList) {
            ctx += `\n\n--- PAPER ---\nTitle: ${ref.title || 'Unknown'}\nAuthors: ${ref.author || (ref.authors || []).join(', ') || 'Unknown'}\nYear: ${ref.year || 'Unknown'}\nJournal/Venue: ${ref.journal || ref.venue || 'Unknown'}\n`;
            if (ref.doi) ctx += `DOI: ${ref.doi}\n`;
            if (ref.abstract) ctx += `Abstract: ${ref.abstract}\n`;
            if (ref.analyses?.summary?.content) ctx += `Analysis: ${ref.analyses.summary.content.substring(0, 2000)}\n`;
        }
        return ctx;
    }

    // Helper: call LLM and collect full response (non-streaming for internal steps)
    async function llmCall(systemPrompt, userPrompt) {
        const messages = [{ role: 'user', content: userPrompt }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], false);
        const resp = await fetch(apiReq.url, {
            method: 'POST',
            headers: apiReq.headers,
            body: JSON.stringify(apiReq.body)
        });
        if (!resp.ok) throw new Error(`LLM API error: ${resp.status}`);
        const data = await resp.json();
        // Extract text from different provider response formats
        if (provider === 'anthropic') {
            return (data.content || []).map(c => c.text || '').join('');
        } else if (provider === 'openai' || provider === 'openrouter') {
            return data.choices?.[0]?.message?.content || '';
        } else if (provider === 'gemini') {
            return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
        return JSON.stringify(data);
    }

    // Helper: stream LLM and collect text
    async function llmStream(systemPrompt, userPrompt) {
        const messages = [{ role: 'user', content: userPrompt }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);
        const resp = await fetch(apiReq.url, {
            method: 'POST',
            headers: apiReq.headers,
            body: JSON.stringify(apiReq.body)
        });
        if (!resp.ok) throw new Error(`LLM stream error: ${resp.status}`);

        let fullText = '';
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const d = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') {
                        if (d.type === 'content_block_delta' && d.delta?.text) text = d.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = d.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = d.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }
                    if (text) {
                        fullText += text;
                        sendEvent('text', { content: text });
                    }
                } catch (e) { }
            }
        }
        return fullText;
    }

    // Helper: quick multi-source search (internal, returns normalized results)
    async function quickSearch(query, limit = 5) {
        const searchResults = [];
        const fetchPromises = [];
        // Semantic Scholar
        fetchPromises.push((async () => {
            try {
                const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,abstract,citationCount,externalIds,venue`;
                const resp = await fetch(url, { headers: { 'User-Agent': 'SenkouAgent/1.0' }, signal: AbortSignal.timeout(8000) });
                if (!resp.ok) return;
                const data = await resp.json();
                (data.data || []).forEach(p => searchResults.push({
                    title: p.title,
                    authors: (p.authors || []).map(a => a.name).join(', '),
                    year: p.year,
                    abstract: p.abstract,
                    citationCount: p.citationCount,
                    doi: p.externalIds?.DOI,
                    venue: p.venue,
                    source: 's2',
                    id: p.paperId
                }));
            } catch (e) { }
        })());
        // OpenAlex (wider coverage)
        fetchPromises.push((async () => {
            try {
                const resp = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&select=id,title,authorships,publication_year,doi,cited_by_count,primary_location`, {
                    headers: { 'User-Agent': 'SenkouAgent/1.0' },
                    signal: AbortSignal.timeout(8000)
                });
                if (!resp.ok) return;
                const data = await resp.json();
                (data.results || []).forEach(w => {
                    const existingDoi = w.doi ? w.doi.replace('https://doi.org/', '') : null;
                    if (existingDoi && searchResults.some(r => r.doi === existingDoi)) return;
                    searchResults.push({
                        title: w.title,
                        authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean).join(', '),
                        year: w.publication_year,
                        abstract: null,
                        citationCount: w.cited_by_count,
                        doi: existingDoi,
                        venue: w.primary_location?.source?.display_name,
                        source: 'openalex',
                        id: w.id
                    });
                });
            } catch (e) { }
        })());
        await Promise.all(fetchPromises);
        return searchResults;
    }

    try {
        let currentRefs = [...reviewRefs];
        let supplementaryPapers = []; // Papers found during gap analysis
        let lastReviewContent = '';

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            const isLastIteration = (iteration === maxIterations - 1);
            const isFirstIteration = (iteration === 0);

            // ── Phase A: Generate/Regenerate review ──
            sendEvent('phase', { phase: isFirstIteration ? 'initial_review' : 'enhanced_review', iteration: iteration + 1, total: maxIterations });

            const papersContext = buildPapersContext(currentRefs);
            const truncatedContext = papersContext.length > 100000 ? papersContext.substring(0, 100000) + '\n[...truncated...]' : papersContext;

            // Build template-specific instructions
            let templateInstructions = '';
            switch (template) {
                case 'systematic':
                    templateInstructions = `Write a SYSTEMATIC REVIEW following PRISMA guidelines structure:
1. Introduction (research question, scope)
2. Methods (search strategy, inclusion/exclusion criteria, data extraction)
3. Results (study characteristics, synthesis of findings, quality assessment)
4. Discussion (summary of evidence, limitations, implications)
5. Conclusion`;
                    break;
                case 'narrative':
                    templateInstructions = `Write a NARRATIVE REVIEW that tells the story of this research area:
1. Introduction (why this topic matters)
2. Historical development and key milestones
3. Current state of knowledge (organized thematically)
4. Debates and controversies
5. Future outlook and conclusion`;
                    break;
                case 'critical':
                    templateInstructions = `Write a CRITICAL REVIEW that evaluates and critiques the literature:
1. Introduction (research question)
2. Analysis of methodological approaches (strengths/weaknesses)
3. Critical evaluation of findings (consistency, contradictions, biases)
4. Assessment of evidence quality
5. Gaps and recommendations for improvement`;
                    break;
                case 'scoping':
                    templateInstructions = `Write a SCOPING REVIEW that maps the existing evidence:
1. Introduction (research question, objectives)
2. Overview of evidence landscape (volume, types, characteristics)
3. Key concepts and definitions in the field
4. Thematic mapping of findings
5. Gaps in existing research and future directions`;
                    break;
                default:
                    templateInstructions = `Write a comprehensive literature review with the following sections:
## Overview, ## Thematic Analysis, ## Chronological Development, ## Key Contributions, ## Methodological Landscape, ## Research Gaps, ## Future Directions, ## Summary Table, ## Conclusion`;
            }

            const supplementaryNote = supplementaryPapers.length > 0
                ? `\n\nNOTE: This is iteration ${iteration + 1}. In the previous round, ${supplementaryPapers.length} additional papers were found to fill identified knowledge gaps. These are included below. Please integrate them thoroughly with the original papers.`
                : '';

            const reviewPrompt = `You are an expert academic researcher writing a literature review.

Topic: ${review.topic || review.title}
${review.description ? `Description: ${review.description}` : ''}
Number of papers: ${currentRefs.length}
Review style: ${reviewStyle}
${supplementaryNote}

${templateInstructions}

Use Markdown formatting. Cite papers by [Author, Year] format. Be thorough, analytical, and identify connections between papers.

Here are the papers:
${truncatedContext}`;

            const sysPrompt = 'You are an expert academic researcher specializing in writing comprehensive literature reviews. Provide thorough, well-structured analysis with proper citations. Use Markdown formatting.';

            lastReviewContent = await llmStream(sysPrompt, reviewPrompt);

            // If this is the last iteration, we're done
            if (isLastIteration) break;

            // ── Phase B: Gap Analysis ──
            sendEvent('phase', { phase: 'gap_analysis', iteration: iteration + 1, total: maxIterations });

            const gapPrompt = `You just wrote a literature review on: "${review.topic || review.title}"

Based on the review you produced below, identify 3-5 specific knowledge gaps or underexplored areas that could be strengthened with additional papers.

For EACH gap, provide:
1. A brief description of what's missing (1-2 sentences)
2. A specific search query that would find relevant papers to fill this gap (be precise and academic)

Return ONLY a JSON array with this exact format:
[
  {"gap": "Description of the gap", "searchQuery": "specific academic search query"},
  ...
]

The review:
${lastReviewContent.substring(0, 30000)}`;

            const gapResponse = await llmCall(
                'You are a research gap analyst. Identify specific gaps in literature reviews and suggest search queries to find papers that fill those gaps. Return ONLY valid JSON.',
                gapPrompt
            );

            // Parse gaps
            let gaps = [];
            try {
                // Extract JSON from response (handle markdown code blocks)
                const jsonMatch = gapResponse.match(/\[[\s\S]*\]/);
                if (jsonMatch) gaps = JSON.parse(jsonMatch[0]);
            } catch (e) {
                sendEvent('info', { message: 'Could not parse gap analysis, skipping supplementary search' });
                break;
            }

            if (gaps.length === 0) {
                sendEvent('info', { message: 'No gaps identified — review is comprehensive' });
                break;
            }

            sendEvent('gaps', { gaps: gaps.map(g => ({ gap: g.gap, query: g.searchQuery })) });

            // ── Phase C: Search for supplementary papers ──
            sendEvent('phase', { phase: 'supplementary_search', iteration: iteration + 1, total: maxIterations, gapCount: gaps.length });

            const newPapers = [];
            // Existing titles for dedup against current refs
            const existingTitles = new Set(currentRefs.map(r => (r.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80)));

            for (const gap of gaps.slice(0, 5)) {
                try {
                    const searchRes = await quickSearch(gap.searchQuery, 3);
                    for (const paper of searchRes) {
                        const normT = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
                        if (normT && !existingTitles.has(normT)) {
                            existingTitles.add(normT);
                            newPapers.push({ ...paper, gapFilled: gap.gap });
                        }
                    }
                    // Small delay between searches to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (e) { }
            }

            if (newPapers.length === 0) {
                sendEvent('info', { message: 'No new papers found for identified gaps' });
                break;
            }

            sendEvent('supplementary', { count: newPapers.length, papers: newPapers.map(p => ({ title: p.title, year: p.year, source: p.source, gapFilled: p.gapFilled })) });

            // Add new papers to current refs for next iteration
            supplementaryPapers.push(...newPapers);
            currentRefs = [...reviewRefs, ...supplementaryPapers];
        }

        // Save review content
        const updatedReviews = readReviewsDB();
        const uIdx = updatedReviews.findIndex(r => r.id === req.params.id);
        if (uIdx !== -1) {
            updatedReviews[uIdx].content = lastReviewContent;
            updatedReviews[uIdx].status = 'completed';
            updatedReviews[uIdx].dateModified = new Date().toISOString();
            updatedReviews[uIdx].generationHistory.push({
                timestamp: new Date().toISOString(),
                provider,
                model,
                length: lastReviewContent.length,
                paperCount: currentRefs.length,
                mode: 'deep',
                template,
                iterations: Math.min(maxIterations, supplementaryPapers.length > 0 ? maxIterations : 1),
                supplementaryPapersFound: supplementaryPapers.length,
                gaps: supplementaryPapers.length > 0
            });
            // Store supplementary papers info
            if (supplementaryPapers.length > 0) {
                updatedReviews[uIdx].supplementaryPapers = supplementaryPapers.map(p => ({
                    title: p.title, authors: p.authors, year: p.year,
                    doi: p.doi, source: p.source, gapFilled: p.gapFilled
                }));
            }
            writeReviewsDB(updatedReviews);
        }

        sendEvent('done', { totalLength: lastReviewContent.length, supplementaryCount: supplementaryPapers.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        const updatedReviews = readReviewsDB();
        const uIdx = updatedReviews.findIndex(r => r.id === req.params.id);
        if (uIdx !== -1) {
            updatedReviews[uIdx].status = 'draft';
            writeReviewsDB(updatedReviews);
        }
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 1.3: AI Relevance Scoring
// ============================================================

app.post('/api/library/score-relevance', express.json(), async (req, res) => {
    const { topic, referenceIds, provider: reqProvider, model: reqModel } = req.body;
    if (!topic) return res.status(400).json({ error: 'Research topic required' });
    if (!referenceIds || referenceIds.length === 0) return res.status(400).json({ error: 'At least one reference ID required' });

    let provider = reqProvider, model = reqModel;
    if (!provider || !model) { const d = getDefaultProviderAndModel(); provider = provider || d.provider; model = model || d.model; }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    const refs = readLibraryDB();
    const targetRefs = refs.filter(r => referenceIds.includes(r.id));

    // Build papers summary
    const papersList = targetRefs.map((r, i) =>
        `[${i + 1}] Title: ${r.title || 'Unknown'}\n   Authors: ${r.author || 'Unknown'}\n   Year: ${r.year || '?'}\n   Abstract: ${(r.abstract || 'No abstract').substring(0, 500)}`
    ).join('\n\n');

    const prompt = `You are a research relevance assessor. Given a research topic and a list of papers, score each paper's relevance to the topic.

Research Topic: "${topic}"

Papers:
${papersList}

For EACH paper, provide a relevance score (0-10) and a brief reason (1 sentence).
Return ONLY a JSON array:
[{"index": 1, "score": 8, "reason": "Directly addresses the core methodology"}, ...]`;

    try {
        const messages = [{ role: 'user', content: prompt }];
        const apiReq = buildProviderRequest(provider, model, 'Score paper relevance to a research topic. Return ONLY valid JSON.', messages, [], false);
        const resp = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!resp.ok) throw new Error(`API error: ${resp.status}`);
        const data = await resp.json();
        let responseText = '';
        if (provider === 'anthropic') responseText = (data.content || []).map(c => c.text || '').join('');
        else if (provider === 'openai' || provider === 'openrouter') responseText = data.choices?.[0]?.message?.content || '';
        else if (provider === 'gemini') responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        let scores = [];
        if (jsonMatch) {
            scores = JSON.parse(jsonMatch[0]);
        }

        // Map scores back to reference IDs
        const results = scores.map(s => {
            const ref = targetRefs[s.index - 1];
            return ref ? { id: ref.id, title: ref.title, score: s.score, reason: s.reason } : null;
        }).filter(Boolean);

        res.json({ topic, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Phase 1.7: Review Quality Self-Assessment
// ============================================================

app.post('/api/library/reviews/:id/assess', express.json(), async (req, res) => {
    const reviews = readReviewsDB();
    const review = reviews.find(r => r.id === req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (!review.content) return res.status(400).json({ error: 'Review has no content to assess' });

    let provider = req.body.provider, model = req.body.model;
    if (!provider || !model) { const d = getDefaultProviderAndModel(); provider = provider || d.provider; model = model || d.model; }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    // SSE setup
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const sendEvent = (type, data) => { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
    sendEvent('start', { reviewTitle: review.title });

    try {
        const assessPrompt = `You are an expert peer reviewer evaluating the quality of a literature review.

Review Title: ${review.title || review.topic}
Review Content (truncated):
${review.content.substring(0, 40000)}

Please evaluate this literature review on the following dimensions. For EACH dimension, provide a score (1-10) and specific feedback:

## 1. Coverage Completeness (1-10)
- Does the review cover all major aspects of the topic?
- Are there obvious gaps in the literature covered?

## 2. Citation Quality (1-10)
- Are claims properly supported by references?
- Is the citation style consistent?

## 3. Logical Flow (1-10)
- Is the review well-organized and logically structured?
- Do sections connect smoothly?

## 4. Critical Analysis (1-10)
- Does the review critically evaluate rather than just summarize?
- Are contradictions and debates identified?

## 5. Writing Quality (1-10)
- Is the language clear and academic?
- Is the writing concise and precise?

## 6. Gap Identification (1-10)
- Does the review identify future research directions?
- Are gaps clearly articulated?

## Overall Score (1-10)
- Provide an overall quality assessment

## Specific Improvements
- List 3-5 specific, actionable suggestions for improvement

Format your response in Markdown.`;

        const messages = [{ role: 'user', content: assessPrompt }];
        const apiReq = buildProviderRequest(provider, model,
            'You are an expert peer reviewer providing constructive, specific feedback on academic literature reviews. Be honest but helpful.',
            messages, [], true);
        const resp = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!resp.ok) throw new Error(`API error: ${resp.status}`);

        let fullText = '';
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const d = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') { if (d.type === 'content_block_delta' && d.delta?.text) text = d.delta.text; }
                    else if (provider === 'openai' || provider === 'openrouter') { text = d.choices?.[0]?.delta?.content || null; }
                    else if (provider === 'gemini') { text = d.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch (e) { }
            }
        }

        // Extract overall score
        let overallScore = null;
        const scoreMatch = fullText.match(/overall\s*score[^0-9]*(\d+)/i);
        if (scoreMatch) overallScore = parseInt(scoreMatch[1]);

        // Save assessment
        const updatedReviews = readReviewsDB();
        const uIdx = updatedReviews.findIndex(r => r.id === req.params.id);
        if (uIdx !== -1) {
            updatedReviews[uIdx].qualityAssessment = {
                timestamp: new Date().toISOString(),
                overallScore,
                assessment: fullText,
                provider, model
            };
            writeReviewsDB(updatedReviews);
        }

        sendEvent('done', { overallScore });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 3.1: AI Peer Review for Papers
// ============================================================

app.post('/api/projects/:projectId/review', express.json(), async (req, res) => {
    const projectDir = getProjectPath(req.params.projectId);
    if (!projectDir || !fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

    let provider = req.body.provider, model = req.body.model;
    if (!provider || !model) { const d = getDefaultProviderAndModel(); provider = provider || d.provider; model = model || d.model; }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    // Find main tex file
    let mainTexContent = '';
    const mainTexFiles = MAIN_TEX_FILES;
    for (const f of mainTexFiles) {
        const fp = path.join(projectDir, f);
        if (fs.existsSync(fp)) {
            mainTexContent = fs.readFileSync(fp, 'utf8');
            break;
        }
    }
    if (!mainTexContent) {
        // Try to find any .tex file
        const texFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.tex'));
        if (texFiles.length > 0) {
            mainTexContent = fs.readFileSync(path.join(projectDir, texFiles[0]), 'utf8');
        }
    }
    if (!mainTexContent) return res.status(400).json({ error: 'No .tex file found in project' });

    // SSE setup
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const sendEvent = (type, data) => { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
    sendEvent('start', { projectId: req.params.projectId });

    try {
        const reviewPrompt = `You are an expert peer reviewer for a top-tier academic venue. Review the following LaTeX manuscript and provide a structured review.

MANUSCRIPT:
${mainTexContent.substring(0, 60000)}

Please provide your review in the following format:

## Summary
Brief summary of the paper (2-3 sentences).

## Strengths
- List key strengths (3-5 points)

## Weaknesses
- List key weaknesses (3-5 points)

## Detailed Review

### Soundness (Score: X/4)
Evaluate theoretical correctness, experimental validity, and methodological rigor.

### Presentation (Score: X/4)
Evaluate clarity, organization, writing quality, and figure quality.

### Contribution (Score: X/4)
Evaluate significance, novelty, and impact of the work.

## Section-by-Section Feedback
Go through each major section and provide specific feedback.

## Minor Issues
List typos, formatting issues, or minor suggestions.

## Questions for Authors
List 3-5 questions that reviewers might ask.

## Overall Assessment (Score: X/10)
Provide an overall recommendation:
- 1-3: Strong Reject
- 4-5: Weak Reject
- 6-7: Weak Accept
- 8-10: Strong Accept

## Actionable Suggestions
List 5 specific, actionable improvements ranked by priority.`;

        const messages = [{ role: 'user', content: reviewPrompt }];
        const apiReq = buildProviderRequest(provider, model,
            'You are an expert peer reviewer providing thorough, constructive reviews of academic papers. Be specific, cite relevant sections, and provide actionable feedback.',
            messages, [], true);
        const resp = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!resp.ok) throw new Error(`API error: ${resp.status}`);

        let fullText = '';
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const d = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') { if (d.type === 'content_block_delta' && d.delta?.text) text = d.delta.text; }
                    else if (provider === 'openai' || provider === 'openrouter') { text = d.choices?.[0]?.delta?.content || null; }
                    else if (provider === 'gemini') { text = d.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch (e) { }
            }
        }

        // Extract overall score
        let overallScore = null;
        const scoreMatch = fullText.match(/overall.*(?:score|assessment)[^0-9]*(\d+)\s*\/\s*10/i);
        if (scoreMatch) overallScore = parseInt(scoreMatch[1]);

        sendEvent('done', { overallScore, length: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 1.5: Evidence Gathering from PDFs
// ============================================================

app.post('/api/library/gather-evidence', express.json(), async (req, res) => {
    const { question, referenceIds, provider: reqProvider, model: reqModel } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });
    if (!referenceIds || referenceIds.length === 0) return res.status(400).json({ error: 'At least one reference ID required' });

    let provider = reqProvider;
    let model = reqModel;
    if (!provider || !model) {
        const defaults = getDefaultProviderAndModel();
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    const refs = readLibraryDB();
    const targetRefs = refs.filter(r => referenceIds.includes(r.id));

    // SSE setup
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    sendEvent('start', { question, paperCount: targetRefs.length });

    try {
        const allEvidence = [];

        for (const ref of targetRefs) {
            sendEvent('progress', { paper: ref.title, phase: 'extracting' });

            // Extract text from PDF or use abstract
            let paperText = '';
            if (ref.pdfFile) {
                const pdfPath = path.join(LIBRARY_PDFS, ref.pdfFile);
                if (fs.existsSync(pdfPath)) {
                    try {
                        const dataBuffer = fs.readFileSync(pdfPath);
                        const data = await pdfParse(dataBuffer);
                        paperText = data.text;
                    } catch (e) { }
                }
            }
            if (!paperText && ref.abstract) {
                paperText = ref.abstract;
            }
            if (!paperText) {
                sendEvent('progress', { paper: ref.title, phase: 'skipped', reason: 'no content' });
                continue;
            }

            // Split into chunks (~500 words each)
            const words = paperText.split(/\s+/);
            const chunkSize = 500;
            const chunks = [];
            for (let i = 0; i < words.length; i += chunkSize) {
                const chunkWords = words.slice(i, i + chunkSize);
                chunks.push({
                    text: chunkWords.join(' '),
                    wordOffset: i,
                    estimatedPage: Math.floor(i / 500) + 1 // rough page estimate
                });
            }

            // Score each chunk for relevance
            sendEvent('progress', { paper: ref.title, phase: 'scoring', chunks: chunks.length });

            // Batch chunks for efficiency (up to 10 chunks per LLM call)
            const batchSize = 10;
            for (let b = 0; b < chunks.length; b += batchSize) {
                const batch = chunks.slice(b, b + batchSize);
                const batchText = batch.map((c, i) => `[CHUNK ${b + i + 1}] (est. page ${c.estimatedPage}):\n${c.text.substring(0, 800)}`).join('\n\n---\n\n');

                const scoringPrompt = `Given the research question: "${question}"

Evaluate each text chunk below for relevance. For each chunk that contains relevant evidence, extract the key quote and assign a relevance score (0-10).

Return ONLY a JSON array:
[{"chunkIndex": <number>, "relevanceScore": <0-10>, "quote": "<exact relevant quote, max 200 chars>", "reasoning": "<why this is relevant>"}]

Only include chunks with relevanceScore >= 5. Return [] if no chunks are relevant.

Chunks from "${ref.title}":
${batchText}`;

                try {
                    const messages = [{ role: 'user', content: scoringPrompt }];
                    const apiReq = buildProviderRequest(provider, model,
                        'You are a research evidence extraction assistant. Find and score relevant evidence from academic papers. Return ONLY valid JSON.',
                        messages, [], false);
                    const resp = await fetch(apiReq.url, {
                        method: 'POST',
                        headers: apiReq.headers,
                        body: JSON.stringify(apiReq.body)
                    });
                    if (!resp.ok) continue;
                    const data = await resp.json();
                    let responseText = '';
                    if (provider === 'anthropic') responseText = (data.content || []).map(c => c.text || '').join('');
                    else if (provider === 'openai' || provider === 'openrouter') responseText = data.choices?.[0]?.message?.content || '';
                    else if (provider === 'gemini') responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

                    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const scored = JSON.parse(jsonMatch[0]);
                        for (const item of scored) {
                            if (item.relevanceScore >= 5) {
                                const chunk = batch[item.chunkIndex - b - 1] || batch[0];
                                allEvidence.push({
                                    paperTitle: ref.title,
                                    paperAuthor: ref.author,
                                    paperYear: ref.year,
                                    paperId: ref.id,
                                    quote: item.quote,
                                    relevanceScore: item.relevanceScore,
                                    reasoning: item.reasoning,
                                    pageEstimate: chunk?.estimatedPage || 1
                                });
                            }
                        }
                    }
                } catch (e) { }
            }
        }

        // Sort by relevance
        allEvidence.sort((a, b) => b.relevanceScore - a.relevanceScore);

        sendEvent('evidence', { results: allEvidence.slice(0, 20) }); // Top 20 evidence items
        sendEvent('done', { totalEvidence: allEvidence.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 2.1: Novelty Detection for Research Ideas
// ============================================================

app.post('/api/library/ideas/:id/check-novelty', express.json(), async (req, res) => {
    const ideas = readIdeasDB();
    const idea = ideas.find(i => i.id === req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getDefaultProviderAndModel();
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    // SSE setup
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    sendEvent('start', { ideaTitle: idea.title });

    try {
        // Step 1: Extract search keywords from the idea
        sendEvent('phase', { phase: 'extracting_keywords' });

        const kwPrompt = `Given this research idea, extract 3-5 specific search queries that would find the most similar existing work. Focus on the core method, application domain, and key innovation.

Research Idea:
Title: ${idea.title}
Description: ${idea.description || ''}
${idea.methodology ? `Methodology: ${idea.methodology}` : ''}

Return ONLY a JSON array of search query strings:
["query1", "query2", "query3"]`;

        const messages = [{ role: 'user', content: kwPrompt }];
        const kwReq = buildProviderRequest(provider, model, 'Extract search queries for novelty checking. Return ONLY valid JSON array.', messages, [], false);
        const kwResp = await fetch(kwReq.url, { method: 'POST', headers: kwReq.headers, body: JSON.stringify(kwReq.body) });
        if (!kwResp.ok) throw new Error(`Keyword extraction failed: ${kwResp.status}`);
        const kwData = await kwResp.json();
        let kwText = '';
        if (provider === 'anthropic') kwText = (kwData.content || []).map(c => c.text || '').join('');
        else if (provider === 'openai' || provider === 'openrouter') kwText = kwData.choices?.[0]?.message?.content || '';
        else if (provider === 'gemini') kwText = kwData.candidates?.[0]?.content?.parts?.[0]?.text || '';

        let queries = [];
        try {
            const m = kwText.match(/\[[\s\S]*\]/);
            if (m) queries = JSON.parse(m[0]);
        } catch (e) {
            queries = [idea.title]; // fallback
        }
        sendEvent('keywords', { queries });

        // Step 2: Search for similar papers
        sendEvent('phase', { phase: 'searching' });
        const allPapers = [];
        const seenTitles = new Set();

        for (const q of queries.slice(0, 5)) {
            try {
                const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=5&fields=title,authors,year,abstract,citationCount,externalIds,venue`;
                const resp = await fetch(url, { headers: { 'User-Agent': 'SenkouAgent/1.0' }, signal: AbortSignal.timeout(8000) });
                if (!resp.ok) continue;
                const data = await resp.json();
                for (const p of (data.data || [])) {
                    const nt = (p.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (nt && !seenTitles.has(nt)) {
                        seenTitles.add(nt);
                        allPapers.push({
                            title: p.title,
                            authors: (p.authors || []).map(a => a.name).join(', '),
                            year: p.year,
                            abstract: p.abstract,
                            citationCount: p.citationCount,
                            venue: p.venue,
                            doi: p.externalIds?.DOI,
                            query: q
                        });
                    }
                }
                await new Promise(r => setTimeout(r, 400)); // Rate limit
            } catch (e) { }
        }

        sendEvent('papers_found', { count: allPapers.length });

        // Step 3: LLM-based novelty assessment
        sendEvent('phase', { phase: 'assessing_novelty' });

        const topPapers = allPapers.slice(0, 15);
        const papersDesc = topPapers.map((p, i) =>
            `[${i + 1}] "${p.title}" (${p.authors}, ${p.year})\n   Venue: ${p.venue || 'N/A'}\n   Citations: ${p.citationCount || 0}\n   Abstract: ${(p.abstract || 'N/A').substring(0, 300)}`
        ).join('\n\n');

        const noveltyPrompt = `You are a research novelty assessor. Evaluate the novelty of the following research idea against existing work found in the literature.

RESEARCH IDEA:
Title: ${idea.title}
Description: ${idea.description || ''}
${idea.methodology ? `Methodology: ${idea.methodology}` : ''}

EXISTING RELATED PAPERS (${topPapers.length} found):
${papersDesc}

Please provide:
1. **Novelty Score** (1-10): 1 = nearly identical to existing work, 10 = highly novel
2. **Closest Papers**: List the 3 most similar existing papers and explain HOW they are similar
3. **Differentiators**: What makes this idea different from existing work?
4. **Overlap Areas**: What aspects overlap with existing research?
5. **Suggestions**: How could the idea be made more novel?

Format your response in Markdown.`;

        // Stream the novelty assessment
        const noveltyResult = await (async () => {
            const msgs = [{ role: 'user', content: noveltyPrompt }];
            const apiReq = buildProviderRequest(provider, model,
                'You are a research novelty assessor. Provide thorough, honest assessment of research idea novelty against existing literature.',
                msgs, [], true);
            const resp = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
            if (!resp.ok) throw new Error(`Novelty assessment failed: ${resp.status}`);

            let fullText = '';
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                    try {
                        const d = JSON.parse(line.slice(6));
                        let text = null;
                        if (provider === 'anthropic') { if (d.type === 'content_block_delta' && d.delta?.text) text = d.delta.text; }
                        else if (provider === 'openai' || provider === 'openrouter') { text = d.choices?.[0]?.delta?.content || null; }
                        else if (provider === 'gemini') { text = d.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                        if (text) { fullText += text; sendEvent('text', { content: text }); }
                    } catch (e) { }
                }
            }
            return fullText;
        })();

        // Extract score from result
        let noveltyScore = null;
        const scoreMatch = noveltyResult.match(/novelty\s*score[^0-9]*(\d+)/i);
        if (scoreMatch) noveltyScore = parseInt(scoreMatch[1]);

        // Save novelty check result to idea
        const updatedIdeas = readIdeasDB();
        const ideaIdx = updatedIdeas.findIndex(i => i.id === req.params.id);
        if (ideaIdx !== -1) {
            updatedIdeas[ideaIdx].noveltyCheck = {
                timestamp: new Date().toISOString(),
                score: noveltyScore,
                assessment: noveltyResult,
                relatedPapers: topPapers.slice(0, 5).map(p => ({ title: p.title, year: p.year, doi: p.doi, venue: p.venue })),
                provider,
                model
            };
            writeIdeasDB(updatedIdeas);
        }

        sendEvent('done', { noveltyScore, relatedPapersCount: topPapers.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 5: AI Research Idea Generation
// ============================================================

const IDEAS_DB = path.join(LIBRARY_DIR, 'ideas.json');

function readIdeasDB() {
    if (!fs.existsSync(IDEAS_DB)) return [];
    try { return JSON.parse(fs.readFileSync(IDEAS_DB, 'utf8')); }
    catch { return []; }
}

function writeIdeasDB(ideas) {
    fs.writeFileSync(IDEAS_DB, JSON.stringify(ideas, null, 2), 'utf8');
}

// CRUD for research ideas
app.get('/api/library/ideas', (req, res) => {
    res.json(readIdeasDB());
});

app.get('/api/library/ideas/:id', (req, res) => {
    const ideas = readIdeasDB();
    const idea = ideas.find(i => i.id === req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    res.json(idea);
});

app.post('/api/library/ideas', (req, res) => {
    const idea = {
        id: generateId(),
        title: req.body.title || 'Untitled Idea',
        description: req.body.description || '',
        sourceReviewId: req.body.sourceReviewId || null,
        sourceReferenceIds: req.body.sourceReferenceIds || [],
        content: req.body.content || '',
        status: req.body.status || 'draft', // draft | exploring | selected | archived
        feasibility: req.body.feasibility || null,
        novelty: req.body.novelty || null,
        impact: req.body.impact || null,
        notes: '',
        refinements: [],
        dateCreated: new Date().toISOString(),
        dateModified: new Date().toISOString()
    };

    const ideas = readIdeasDB();
    ideas.push(idea);
    writeIdeasDB(ideas);
    res.json(idea);
});

app.put('/api/library/ideas/:id', (req, res) => {
    const ideas = readIdeasDB();
    const idx = ideas.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Idea not found' });

    const allowed = ['title', 'description', 'content', 'status', 'feasibility', 'novelty', 'impact', 'notes'];
    for (const key of allowed) {
        if (req.body[key] !== undefined) ideas[idx][key] = req.body[key];
    }
    ideas[idx].dateModified = new Date().toISOString();
    writeIdeasDB(ideas);
    res.json(ideas[idx]);
});

app.delete('/api/library/ideas/:id', (req, res) => {
    let ideas = readIdeasDB();
    ideas = ideas.filter(i => i.id !== req.params.id);
    writeIdeasDB(ideas);
    res.json({ success: true });
});

// Generate research ideas using AI
app.post('/api/library/ideas/generate', async (req, res) => {
    const { reviewId, referenceIds, topic, constraints } = req.body;

    // Determine provider (with per-feature override)
    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('ideas');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }

    if (!provider) {
        return res.status(400).json({ error: 'No AI provider configured.' });
    }

    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) {
        return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    }

    await ensureValidToken(provider);

    // Gather context
    let context = '';

    // From literature review
    if (reviewId) {
        const reviews = readReviewsDB();
        const review = reviews.find(r => r.id === reviewId);
        if (review?.content) {
            context += `\n\n=== LITERATURE REVIEW ===\nTopic: ${review.topic || review.title}\n${review.content.substring(0, 30000)}\n`;
        }
    }

    // From specific references
    if (referenceIds?.length > 0) {
        const refs = readLibraryDB();
        for (const rid of referenceIds) {
            const ref = refs.find(r => r.id === rid);
            if (!ref) continue;
            context += `\n\n--- Paper: ${ref.title} (${ref.author}, ${ref.year}) ---\n`;
            if (ref.analyses?.full_analysis?.content) {
                context += ref.analyses.full_analysis.content.substring(0, 5000);
            } else if (ref.abstract) {
                context += ref.abstract;
            }
        }
    }

    if (!context.trim()) {
        return res.status(400).json({ error: 'No context available. Create a literature review or select references first.' });
    }

    const ideaPrompt = `You are a creative research advisor with deep expertise. Based on the following research context, generate 5 novel and feasible research ideas.

${topic ? `Research area/topic: ${topic}` : ''}
${constraints ? `Constraints/preferences: ${constraints}` : ''}

For EACH idea, provide:

## 💡 Idea [N]: [Title]

**One-line summary**: [Concise description]

**Problem**: What specific problem does this address?

**Approach**: What method/approach would you use?

**Expected contribution**: What would this contribute to the field?

**Feasibility assessment**:
- Technical complexity: [Low/Medium/High]
- Resource requirements: [Low/Medium/High]
- Estimated timeline: [3-6 months / 6-12 months / 1-2 years]

**Novelty assessment**: Why hasn't this been done before?

**Potential impact**: [Low/Medium/High] - Why?

**Key risks**: What could go wrong?

**First steps**: What would you do first?

---

Ensure ideas are:
1. Novel - not just incremental improvements
2. Feasible - could actually be implemented
3. Impactful - would advance the field
4. Diverse - cover different angles and approaches
5. Well-grounded - based on gaps identified in the literature

Research context:
${context}`;

    // SSE stream
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    sendEvent('start', { provider, model });

    try {
        const messages = [{ role: 'user', content: ideaPrompt }];
        const systemPrompt = 'You are a creative and rigorous research advisor. Generate novel, feasible, and impactful research ideas based on literature analysis. Use Markdown formatting.';

        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, {
            method: 'POST',
            headers: apiReq.headers,
            body: JSON.stringify(apiReq.body)
        });

        if (!response.ok) {
            sendEvent('error', { message: `API error: ${response.status}` });
            sendEvent('done', {});
            res.end();
            return;
        }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;

                    if (provider === 'anthropic') {
                        if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = data.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }

                    if (text) {
                        fullText += text;
                        sendEvent('text', { content: text });
                    }
                } catch (e) { }
            }
        }

        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// Refine/iterate on a specific idea
app.post('/api/library/ideas/:id/refine', async (req, res) => {
    const ideas = readIdeasDB();
    const ideaIdx = ideas.findIndex(i => i.id === req.params.id);
    if (ideaIdx === -1) return res.status(404).json({ error: 'Idea not found' });

    const idea = ideas[ideaIdx];
    const { feedback, direction } = req.body;

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getDefaultProviderAndModel();
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }

    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });

    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) {
        return res.status(400).json({ error: `Provider not available.` });
    }

    await ensureValidToken(provider);

    const refinePrompt = `You are a research advisor helping refine a research idea.

## Current Idea
Title: ${idea.title}
Description: ${idea.description}
${idea.content ? `\nDetailed plan:\n${idea.content.substring(0, 10000)}` : ''}

## User Feedback
${feedback || 'Please refine and improve this idea.'}

${direction ? `## Specific direction requested: ${direction}` : ''}

Please provide a refined version of this idea that addresses the feedback. Include:
1. Updated research questions
2. Refined methodology
3. Clearer expected outcomes
4. Updated feasibility assessment
5. Actionable next steps

Use Markdown formatting.`;

    // SSE stream
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    sendEvent('start', { provider, model });

    try {
        const messages = [{ role: 'user', content: refinePrompt }];
        const systemPrompt = 'You are a research advisor helping refine research ideas. Be constructive, specific, and actionable.';
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, {
            method: 'POST',
            headers: apiReq.headers,
            body: JSON.stringify(apiReq.body)
        });

        if (!response.ok) {
            sendEvent('error', { message: `API error: ${response.status}` });
            sendEvent('done', {});
            res.end();
            return;
        }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') {
                        if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = data.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }
                    if (text) {
                        fullText += text;
                        sendEvent('text', { content: text });
                    }
                } catch (e) { }
            }
        }

        // Save refinement
        const updatedIdeas = readIdeasDB();
        const uIdx = updatedIdeas.findIndex(i => i.id === req.params.id);
        if (uIdx !== -1) {
            updatedIdeas[uIdx].refinements.push({
                timestamp: new Date().toISOString(),
                feedback,
                direction,
                result: fullText,
                provider,
                model
            });
            updatedIdeas[uIdx].dateModified = new Date().toISOString();
            writeIdeasDB(updatedIdeas);
        }

        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 2.2: Idea Tree Search
// ============================================================

app.post('/api/library/ideas/tree-search', async (req, res) => {
    const { reviewId, referenceIds, topic, constraints, seedCount = 3, variantsPerSeed = 2, depth = 2 } = req.body;

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('ideas');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `Provider not available.` });
    await ensureValidToken(provider);

    // Gather context
    let context = '';
    if (reviewId) {
        const reviews = readReviewsDB();
        const review = reviews.find(r => r.id === reviewId);
        if (review?.content) context += `\n=== LITERATURE REVIEW ===\nTopic: ${review.topic || review.title}\n${review.content.substring(0, 20000)}\n`;
    }
    if (referenceIds?.length > 0) {
        const refs = readLibraryDB();
        for (const rid of referenceIds) {
            const ref = refs.find(r => r.id === rid);
            if (!ref) continue;
            context += `\n--- Paper: ${ref.title} (${ref.author}, ${ref.year}) ---\n`;
            if (ref.analyses?.full_analysis?.content) context += ref.analyses.full_analysis.content.substring(0, 3000);
            else if (ref.abstract) context += ref.abstract;
        }
    }
    if (!context.trim()) return res.status(400).json({ error: 'No context available. Create a literature review or select references first.' });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const sendEvent = (type, data) => { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
    sendEvent('start', { provider, model });

    // Helper: non-streaming LLM call
    async function llmCall(prompt, systemMsg) {
        const messages = [{ role: 'user', content: prompt }];
        const apiReq = buildProviderRequest(provider, model, systemMsg, messages, [], false);
        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const json = await response.json();
        if (provider === 'anthropic') return json.content?.[0]?.text || '';
        if (provider === 'openai' || provider === 'openrouter') return json.choices?.[0]?.message?.content || '';
        if (provider === 'gemini') return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return '';
    }

    try {
        // Phase 1: Generate seed ideas
        sendEvent('phase', { phase: 'generating_seeds', message: `Generating ${seedCount} seed ideas...` });

        const seedPrompt = `Based on the following research context, generate exactly ${seedCount} concise seed research ideas. For each idea provide:
- A short title (under 15 words)
- A 2-3 sentence description
- A feasibility score (1-10)
- An impact score (1-10)
- A novelty score (1-10)

Format as JSON array: [{"title":"...","description":"...","feasibility":N,"impact":N,"novelty":N}]

${topic ? `Research area: ${topic}` : ''}
${constraints ? `Constraints: ${constraints}` : ''}

Research context:
${context.substring(0, 15000)}

IMPORTANT: Return ONLY the JSON array, no other text.`;

        const seedResult = await llmCall(seedPrompt, 'You are a creative research advisor. Return only valid JSON.');
        let seeds;
        try {
            const jsonMatch = seedResult.match(/\[[\s\S]*\]/);
            seeds = JSON.parse(jsonMatch ? jsonMatch[0] : seedResult);
        } catch (e) {
            sendEvent('error', { message: 'Failed to parse seed ideas. Retrying...' });
            seeds = [{ title: 'Seed Idea', description: seedResult.substring(0, 200), feasibility: 5, impact: 5, novelty: 5 }];
        }

        const tree = { seeds: [], bestIdea: null };

        for (let si = 0; si < seeds.length; si++) {
            const seed = seeds[si];
            const seedNode = {
                id: `seed-${si}`,
                title: seed.title,
                description: seed.description,
                scores: { feasibility: seed.feasibility || 5, impact: seed.impact || 5, novelty: seed.novelty || 5 },
                avgScore: ((seed.feasibility || 5) + (seed.impact || 5) + (seed.novelty || 5)) / 3,
                variants: [],
                depth: 0
            };
            tree.seeds.push(seedNode);
            sendEvent('seed', { index: si, seed: seedNode });
        }

        // Phase 2: Generate variants for each seed
        sendEvent('phase', { phase: 'generating_variants', message: 'Generating variants for each seed...' });

        for (let si = 0; si < tree.seeds.length; si++) {
            const seed = tree.seeds[si];

            const variantPrompt = `Given this research idea:
Title: ${seed.title}
Description: ${seed.description}

Generate ${variantsPerSeed} distinct VARIANTS of this idea. Each variant should explore a different angle, methodology, or application. For each variant provide:
- A short title
- A 2-3 sentence description explaining how it differs from the original
- A feasibility score (1-10)
- An impact score (1-10)
- A novelty score (1-10)

Format as JSON array: [{"title":"...","description":"...","feasibility":N,"impact":N,"novelty":N}]
Return ONLY valid JSON.`;

            try {
                const varResult = await llmCall(variantPrompt, 'You are a creative research advisor. Return only valid JSON.');
                const jsonMatch = varResult.match(/\[[\s\S]*\]/);
                const variants = JSON.parse(jsonMatch ? jsonMatch[0] : varResult);

                for (let vi = 0; vi < variants.length; vi++) {
                    const v = variants[vi];
                    const varNode = {
                        id: `seed-${si}-var-${vi}`,
                        parentId: seed.id,
                        title: v.title,
                        description: v.description,
                        scores: { feasibility: v.feasibility || 5, impact: v.impact || 5, novelty: v.novelty || 5 },
                        avgScore: ((v.feasibility || 5) + (v.impact || 5) + (v.novelty || 5)) / 3,
                        depth: 1
                    };
                    seed.variants.push(varNode);
                    sendEvent('variant', { seedIndex: si, variantIndex: vi, variant: varNode });
                }
            } catch (e) {
                sendEvent('error', { message: `Failed to generate variants for seed ${si + 1}: ${e.message}` });
            }
        }

        // Phase 3: Select best and deepen
        sendEvent('phase', { phase: 'selecting_best', message: 'Evaluating and selecting the best idea...' });

        // Flatten all nodes and find the best
        const allNodes = [];
        for (const seed of tree.seeds) {
            allNodes.push(seed);
            for (const v of seed.variants) allNodes.push(v);
        }
        allNodes.sort((a, b) => b.avgScore - a.avgScore);
        const bestNode = allNodes[0];

        sendEvent('best_selected', { best: bestNode, ranking: allNodes.slice(0, 5).map(n => ({ id: n.id, title: n.title, avgScore: Math.round(n.avgScore * 10) / 10 })) });

        // Phase 4: Deepen the best idea
        sendEvent('phase', { phase: 'deepening', message: `Deepening the top idea: "${bestNode.title}"...` });

        const deepenPrompt = `You are a research advisor. The following research idea was selected as the most promising from a tree search:

Title: ${bestNode.title}
Description: ${bestNode.description}
Scores: Feasibility ${bestNode.scores.feasibility}/10, Impact ${bestNode.scores.impact}/10, Novelty ${bestNode.scores.novelty}/10

Now develop this idea into a detailed research proposal. Include:

## 💡 ${bestNode.title}

### Research Questions
- Primary research question
- 2-3 sub-questions

### Methodology
- Detailed approach
- Data sources and collection methods
- Analysis techniques

### Expected Contributions
- Theoretical contributions
- Practical implications

### Implementation Plan
- Phase 1: Foundation (specifics)
- Phase 2: Core work (specifics)
- Phase 3: Evaluation (specifics)

### Feasibility Analysis
- Technical requirements
- Resource needs
- Timeline estimate

### Potential Challenges & Mitigations
- Challenge 1 → Mitigation
- Challenge 2 → Mitigation

### First Steps (Immediate Actions)
1. ...
2. ...
3. ...

Use Markdown formatting.`;

        // Stream the deepened idea
        const messages = [{ role: 'user', content: deepenPrompt }];
        const systemPrompt = 'You are a research advisor developing a detailed research proposal. Use rich Markdown formatting.';
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) throw new Error(`API error: ${response.status}`);

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let streamBuf = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamBuf += decoder.decode(value, { stream: true });
            const lines = streamBuf.split('\n');
            streamBuf = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') { if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text; }
                    else if (provider === 'openai' || provider === 'openrouter') { text = data.choices?.[0]?.delta?.content || null; }
                    else if (provider === 'gemini') { text = data.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch (e) { }
            }
        }

        tree.bestIdea = { ...bestNode, detailedProposal: fullText };

        // Save tree search result to idea (create new idea from best)
        const ideas = readIdeasDB();
        const newIdea = {
            id: generateId(),
            title: bestNode.title + ' (Tree Search Result)',
            description: bestNode.description,
            content: fullText,
            status: 'exploring',
            feasibility: bestNode.scores.feasibility,
            novelty: bestNode.scores.novelty,
            impact: bestNode.scores.impact,
            notes: `Generated via tree search. Seeds: ${tree.seeds.length}, Total variants explored: ${allNodes.length}`,
            treeSearch: {
                timestamp: new Date().toISOString(),
                seedCount: tree.seeds.length,
                totalNodes: allNodes.length,
                ranking: allNodes.slice(0, 5).map(n => ({ title: n.title, avgScore: Math.round(n.avgScore * 10) / 10 })),
                provider, model
            },
            refinements: [],
            dateCreated: new Date().toISOString(),
            dateModified: new Date().toISOString()
        };
        ideas.push(newIdea);
        writeIdeasDB(ideas);

        sendEvent('done', { ideaId: newIdea.id, tree: { seedCount: tree.seeds.length, totalNodes: allNodes.length, bestTitle: bestNode.title, bestScore: Math.round(bestNode.avgScore * 10) / 10 } });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 2.3: Cross-domain Connection Discovery
// ============================================================

app.post('/api/library/ideas/cross-domain', async (req, res) => {
    const { referenceIds, collections, topic } = req.body;

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('ideas');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `Provider not available.` });
    await ensureValidToken(provider);

    const refs = readLibraryDB();
    let selectedRefs = refs;
    if (referenceIds?.length > 0) selectedRefs = refs.filter(r => referenceIds.includes(r.id));

    if (selectedRefs.length < 2) return res.status(400).json({ error: 'Need at least 2 references from different domains to find cross-domain connections.' });

    let refContext = selectedRefs.slice(0, 20).map((r, i) =>
        `[${i + 1}] "${r.title}" (${r.author}, ${r.year})\nField: ${r.collections?.join(', ') || 'unknown'}\nAbstract: ${(r.abstract || r.analyses?.full_analysis?.content?.substring(0, 500) || 'N/A')}`
    ).join('\n\n');

    const crossPrompt = `You are an interdisciplinary research advisor. Analyze the following papers from potentially different research domains and identify cross-domain connections, methodological bridges, and novel research opportunities that emerge from combining insights across fields.

${topic ? `Research area of interest: ${topic}` : ''}

Papers:
${refContext}

Please provide:

## 🔗 Cross-Domain Connections

For each identified connection:

### Connection [N]: [Title]
- **Domains bridged**: [Field A] ↔ [Field B]
- **Papers involved**: [Paper numbers]
- **Type**: [Methodological transfer / Conceptual bridge / Data synergy / Problem analogy]
- **Description**: How these domains connect and what emerges
- **Research opportunity**: Specific idea that leverages this connection
- **Novelty**: Why this cross-domain approach hasn't been explored
- **Feasibility**: How practical is this cross-domain work

## 💡 Top 3 Cross-Domain Research Ideas
For each, provide title, description, which papers/domains it bridges, and expected impact.

Use Markdown formatting.`;

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const sendEvent = (type, data) => { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
    sendEvent('start', { provider, model, refCount: selectedRefs.length });

    try {
        const messages = [{ role: 'user', content: crossPrompt }];
        const systemPrompt = 'You are an interdisciplinary research advisor skilled at finding connections across different scientific domains.';
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) { sendEvent('error', { message: `API error: ${response.status}` }); sendEvent('done', {}); res.end(); return; }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') { if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text; }
                    else if (provider === 'openai' || provider === 'openrouter') { text = data.choices?.[0]?.delta?.content || null; }
                    else if (provider === 'gemini') { text = data.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch (e) { }
            }
        }

        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 2.4: AI Debate-style Idea Optimization
// ============================================================

app.post('/api/library/ideas/:id/debate', async (req, res) => {
    const ideas = readIdeasDB();
    const ideaIdx = ideas.findIndex(i => i.id === req.params.id);
    if (ideaIdx === -1) return res.status(404).json({ error: 'Idea not found' });

    const idea = ideas[ideaIdx];

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('ideas');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }
    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `Provider not available.` });
    await ensureValidToken(provider);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const sendEvent = (type, data) => { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
    sendEvent('start', { provider, model });

    // Helper: non-streaming LLM call
    async function llmCall(prompt, systemMsg) {
        const messages = [{ role: 'user', content: prompt }];
        const apiReq = buildProviderRequest(provider, model, systemMsg, messages, [], false);
        const resp = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!resp.ok) throw new Error(`API error: ${resp.status}`);
        const json = await resp.json();
        if (provider === 'anthropic') return json.content?.[0]?.text || '';
        if (provider === 'openai' || provider === 'openrouter') return json.choices?.[0]?.message?.content || '';
        if (provider === 'gemini') return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return '';
    }

    try {
        const ideaText = `Title: ${idea.title}\nDescription: ${idea.description}\n${idea.content ? `Details:\n${idea.content.substring(0, 8000)}` : ''}`;

        // Stage 1: Advocate
        sendEvent('phase', { phase: 'advocate', message: '🟢 Advocate is building the case for this idea...' });

        const advocateResult = await llmCall(
            `You are an enthusiastic ADVOCATE for the following research idea. Build the strongest possible case for why this idea is excellent, innovative, and worth pursuing. Highlight its strengths, potential impact, and unique contributions.\n\n${ideaText}\n\nProvide your argument in a structured format with clear points. Be specific and compelling. Use Markdown.`,
            'You are an optimistic research advocate. Always find and emphasize the strengths and potential of research ideas.'
        );
        sendEvent('debate_stage', { stage: 'advocate', content: advocateResult });

        // Stage 2: Critic
        sendEvent('phase', { phase: 'critic', message: '🔴 Critic is analyzing weaknesses...' });

        const criticResult = await llmCall(
            `You are a rigorous CRITIC reviewing the following research idea. Identify all weaknesses, gaps, potential failures, methodological issues, and challenges. Be thorough but constructive.\n\nResearch Idea:\n${ideaText}\n\nAdvocate's arguments:\n${advocateResult.substring(0, 5000)}\n\nProvide specific criticisms and concerns. For each weakness, rate severity (Low/Medium/High). Use Markdown.`,
            'You are a rigorous but fair research critic. Identify real weaknesses while being constructive.'
        );
        sendEvent('debate_stage', { stage: 'critic', content: criticResult });

        // Stage 3: Synthesizer (streamed)
        sendEvent('phase', { phase: 'synthesizer', message: '🟡 Synthesizer is integrating both perspectives...' });

        const synthPrompt = `You are a SYNTHESIZER mediating between an advocate and a critic of a research idea. Your job is to integrate both perspectives into an improved, stronger version of the idea.

Original Idea:
${ideaText}

Advocate's Case:
${advocateResult.substring(0, 4000)}

Critic's Concerns:
${criticResult.substring(0, 4000)}

Please produce:

## 🔄 Synthesized & Improved Research Idea

### Key Strengths Retained
- (from advocate's case)

### Weaknesses Addressed
- (from critic's concerns, with solutions)

### Improved Research Proposal
- Updated title
- Refined research questions
- Improved methodology (addressing critic's concerns)
- Realistic scope and timeline
- Clear contribution statement

### Debate Summary
| Aspect | Advocate | Critic | Resolution |
|--------|----------|--------|------------|
| ... | ... | ... | ... |

### Final Verdict
- Overall viability score: X/10
- Recommended next steps

Use rich Markdown formatting.`;

        const messages = [{ role: 'user', content: synthPrompt }];
        const systemPrompt = 'You are an impartial research synthesis advisor. Integrate diverse perspectives into improved research proposals.';
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) throw new Error(`API error: ${response.status}`);

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let streamBuf = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamBuf += decoder.decode(value, { stream: true });
            const lines = streamBuf.split('\n');
            streamBuf = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') { if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text; }
                    else if (provider === 'openai' || provider === 'openrouter') { text = data.choices?.[0]?.delta?.content || null; }
                    else if (provider === 'gemini') { text = data.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch (e) { }
            }
        }

        // Save debate result as refinement
        const updatedIdeas = readIdeasDB();
        const uIdx = updatedIdeas.findIndex(i => i.id === req.params.id);
        if (uIdx !== -1) {
            updatedIdeas[uIdx].refinements.push({
                timestamp: new Date().toISOString(),
                feedback: 'AI Debate (Advocate vs Critic → Synthesizer)',
                direction: 'debate',
                result: fullText,
                debate: { advocate: advocateResult, critic: criticResult },
                provider, model
            });
            updatedIdeas[uIdx].dateModified = new Date().toISOString();
            writeIdeasDB(updatedIdeas);
        }

        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Phase 3.2: Writing Assistance Enhancement
// ============================================================

// Section-specific writing commands
app.post('/api/ai/write-section', async (req, res) => {
    const { projectId, section, currentContent, references, customInstructions } = req.body;

    if (!projectId || !section) {
        return res.status(400).json({ error: 'projectId and section are required' });
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

    // Section-specific prompts
    const sectionPrompts = {
        'introduction': {
            system: 'You are an expert academic writer specializing in research paper introductions.',
            prompt: `Write a compelling Introduction section for this research paper.

Structure requirements:
1. Start with a broad context/motivation (why this field matters)
2. Narrow down to the specific problem/gap in current research
3. State the research question or hypothesis
4. Briefly outline the approach/methodology
5. Summarize key contributions
6. Optionally preview the paper structure

Write in LaTeX format with proper \\section{Introduction} header.`
        },
        'methodology': {
            system: 'You are an expert academic writer specializing in research methodology sections.',
            prompt: `Write a detailed Methodology/Methods section for this research paper.

Structure requirements:
1. Overview of the research design
2. Data collection methods and materials
3. Experimental setup / computational framework
4. Analysis procedures and statistical methods
5. Evaluation metrics and validation approach
6. Reproducibility details (parameters, configurations)

Write in LaTeX format with proper \\section{Methodology} header. Include subsections as needed.`
        },
        'results': {
            system: 'You are an expert academic writer specializing in presenting research results.',
            prompt: `Write a Results section for this research paper.

Structure requirements:
1. Present findings in logical order
2. Reference tables and figures (use \\ref{} placeholders)
3. Report quantitative results with proper formatting
4. Compare with baselines where applicable
5. Highlight statistically significant findings
6. Keep interpretation minimal (save for Discussion)

Write in LaTeX format with proper \\section{Results} header. Include placeholders for tables/figures.`
        },
        'discussion': {
            system: 'You are an expert academic writer specializing in research discussion sections.',
            prompt: `Write a Discussion section for this research paper.

Structure requirements:
1. Summarize key findings and their significance
2. Interpret results in context of existing literature
3. Compare with related work
4. Discuss limitations honestly
5. Suggest future research directions
6. Broader implications and applications

Write in LaTeX format with proper \\section{Discussion} header.`
        },
        'abstract': {
            system: 'You are an expert at writing concise, informative research abstracts.',
            prompt: `Write an Abstract for this research paper.

Requirements:
1. 150-300 words
2. Background/context (1-2 sentences)
3. Problem statement (1 sentence)
4. Methods/approach (1-2 sentences)
5. Key results (2-3 sentences)
6. Conclusions and significance (1-2 sentences)

Write in LaTeX format within \\begin{abstract}...\\end{abstract}.`
        },
        'conclusion': {
            system: 'You are an expert academic writer specializing in research conclusions.',
            prompt: `Write a Conclusion section for this research paper.

Requirements:
1. Restate the research problem and objectives
2. Summarize main findings
3. Highlight key contributions
4. Discuss practical implications
5. Acknowledge limitations briefly
6. Suggest future work directions

Write in LaTeX format with proper \\section{Conclusion} header.`
        },
        'related_work': {
            system: 'You are an expert academic writer specializing in related work sections.',
            prompt: `Write a Related Work section for this research paper.

Requirements:
1. Organize by themes/categories, not chronologically
2. Critically analyze existing work (not just summarize)
3. Identify gaps that this paper addresses
4. Use \\cite{} for references where applicable
5. Show how this work differs from/builds upon prior work

Write in LaTeX format with proper \\section{Related Work} header.`
        }
    };

    const sectionConfig = sectionPrompts[section];
    if (!sectionConfig) {
        sendEvent('error', { message: `Unknown section: ${section}. Valid: ${Object.keys(sectionPrompts).join(', ')}` });
        res.end();
        return;
    }

    // Build context from current document content
    let contextStr = '';
    if (currentContent) {
        contextStr = `\n\nCurrent paper content (for context):\n\`\`\`latex\n${currentContent.substring(0, 8000)}\n\`\`\``;
    }

    // Add reference context if provided
    let refContext = '';
    if (references?.length > 0) {
        refContext = '\n\nAvailable references to cite:\n';
        references.forEach(ref => {
            refContext += `- ${ref.citeKey || ref.id}: ${ref.title} (${ref.authors?.join(', ') || 'Unknown'})\n`;
        });
    }

    let customNote = '';
    if (customInstructions) {
        customNote = `\n\nAdditional instructions from the researcher:\n${customInstructions}`;
    }

    const fullPrompt = sectionConfig.prompt + contextStr + refContext + customNote;

    sendEvent('phase', { phase: 'generating', section });

    try {
        const { provider: provName, model: provModel } = getProviderForFeature('write_section');
        const providerReq = buildProviderRequest(provName, provModel, sectionConfig.system, [
            { role: 'user', content: fullPrompt }
        ], null, true);

        const response = await fetch(providerReq.url, {
            method: 'POST',
            headers: providerReq.headers,
            body: JSON.stringify(providerReq.body)
        });

        if (!response.ok) {
            sendEvent('error', { message: `AI provider error: ${response.status}` });
            res.end();
            return;
        }

        // Stream response using Web Streams API (same pattern as /api/ai/stream)
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    let token = '';
                    if (parsed.delta?.text) token = parsed.delta.text;
                    else if (parsed.choices?.[0]?.delta?.content) token = parsed.choices[0].delta.content;
                    else if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) token = parsed.candidates[0].content.parts[0].text;
                    if (token) {
                        fullText += token;
                        sendEvent('text', { content: token });
                    }
                } catch (e) { /* skip non-JSON lines */ }
            }
        }

        sendEvent('done', { section, totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        res.end();
    }
});

// Citation search from library
app.get('/api/library/citations/search', (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    if (!query) return res.json([]);

    const refs = readLibraryDB();
    const results = refs.filter(ref => {
        const searchable = [
            ref.title,
            ref.citeKey,
            ...(ref.authors || []),
            ref.year?.toString(),
            ref.venue
        ].filter(Boolean).join(' ').toLowerCase();
        return searchable.includes(query);
    }).slice(0, 20).map(ref => ({
        id: ref.id,
        citeKey: ref.citeKey || ref.id,
        title: ref.title,
        authors: ref.authors,
        year: ref.year,
        bibtex: ref.bibtex
    }));

    res.json(results);
});

// ============================================================
// Phase 3.3: Experiment Tracking
// ============================================================

const EXPERIMENTS_DB = path.join(LIBRARY_DIR, 'experiments.json');

function readExperimentsDB() {
    if (!fs.existsSync(EXPERIMENTS_DB)) return [];
    try { return JSON.parse(fs.readFileSync(EXPERIMENTS_DB, 'utf8')); }
    catch { return []; }
}

function writeExperimentsDB(experiments) {
    fs.writeFileSync(EXPERIMENTS_DB, JSON.stringify(experiments, null, 2), 'utf8');
}

// CRUD for experiments
app.get('/api/library/experiments', (req, res) => {
    res.json(readExperimentsDB());
});

app.get('/api/library/experiments/:id', (req, res) => {
    const experiments = readExperimentsDB();
    const exp = experiments.find(e => e.id === req.params.id);
    if (!exp) return res.status(404).json({ error: 'Experiment not found' });
    res.json(exp);
});

app.post('/api/library/experiments', (req, res) => {
    const experiment = {
        id: generateId(),
        name: req.body.name || 'Untitled Experiment',
        description: req.body.description || '',
        planId: req.body.planId || null,
        ideaId: req.body.ideaId || null,
        status: req.body.status || 'planned', // planned | running | completed | failed
        parameters: req.body.parameters || {},
        codeSnippet: req.body.codeSnippet || '',
        metrics: req.body.metrics || {},
        notes: req.body.notes || '',
        tags: req.body.tags || [],
        dateCreated: new Date().toISOString(),
        dateModified: new Date().toISOString(),
        runs: [] // array of { id, timestamp, parameters, metrics, notes }
    };

    const experiments = readExperimentsDB();
    experiments.push(experiment);
    writeExperimentsDB(experiments);
    res.json(experiment);
});

app.put('/api/library/experiments/:id', (req, res) => {
    const experiments = readExperimentsDB();
    const idx = experiments.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Experiment not found' });

    experiments[idx] = {
        ...experiments[idx],
        ...req.body,
        id: experiments[idx].id,
        dateCreated: experiments[idx].dateCreated,
        dateModified: new Date().toISOString()
    };

    writeExperimentsDB(experiments);
    res.json(experiments[idx]);
});

app.delete('/api/library/experiments/:id', (req, res) => {
    let experiments = readExperimentsDB();
    const idx = experiments.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Experiment not found' });
    experiments.splice(idx, 1);
    writeExperimentsDB(experiments);
    res.json({ success: true });
});

// Add a run to an experiment
app.post('/api/library/experiments/:id/runs', (req, res) => {
    const experiments = readExperimentsDB();
    const idx = experiments.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Experiment not found' });

    const run = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        parameters: req.body.parameters || experiments[idx].parameters,
        metrics: req.body.metrics || {},
        notes: req.body.notes || '',
        status: req.body.status || 'completed'
    };

    experiments[idx].runs.push(run);
    experiments[idx].dateModified = new Date().toISOString();
    writeExperimentsDB(experiments);
    res.json(run);
});

// Compare experiments
app.post('/api/library/experiments/compare', (req, res) => {
    const { experimentIds } = req.body;
    if (!experimentIds?.length) return res.status(400).json({ error: 'experimentIds required' });

    const experiments = readExperimentsDB();
    const selected = experimentIds.map(id => experiments.find(e => e.id === id)).filter(Boolean);

    // Collect all unique metric keys
    const allMetricKeys = new Set();
    const allParamKeys = new Set();
    selected.forEach(exp => {
        Object.keys(exp.metrics || {}).forEach(k => allMetricKeys.add(k));
        Object.keys(exp.parameters || {}).forEach(k => allParamKeys.add(k));
        (exp.runs || []).forEach(run => {
            Object.keys(run.metrics || {}).forEach(k => allMetricKeys.add(k));
        });
    });

    const comparison = {
        experiments: selected.map(exp => ({
            id: exp.id,
            name: exp.name,
            status: exp.status,
            parameters: exp.parameters,
            metrics: exp.metrics,
            runCount: (exp.runs || []).length,
            bestRun: (exp.runs || []).length > 0 ?
                exp.runs.reduce((best, run) => {
                    const score = Object.values(run.metrics || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
                    const bestScore = Object.values(best.metrics || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
                    return score > bestScore ? run : best;
                }, exp.runs[0]) : null
        })),
        metricKeys: [...allMetricKeys],
        parameterKeys: [...allParamKeys]
    };

    res.json(comparison);
});

// ============================================================
// Phase 3.4: Research Export
// ============================================================

app.post('/api/library/export-research', async (req, res) => {
    const { reviewIds, ideaIds, planIds, format = 'markdown' } = req.body;

    let output = '# Research Export\n\n';
    output += `_Generated: ${new Date().toISOString()}_\n\n---\n\n`;

    // Collect BibTeX entries
    const bibtexEntries = [];
    const citedRefs = new Set();

    // Export reviews
    if (reviewIds?.length > 0) {
        const reviews = readReviewsDB();
        output += '# Literature Reviews\n\n';
        for (const rid of reviewIds) {
            const review = reviews.find(r => r.id === rid);
            if (!review) continue;
            output += `## ${review.title || review.topic || 'Untitled Review'}\n\n`;
            if (review.topic) output += `**Topic:** ${review.topic}\n\n`;
            if (review.content) output += review.content + '\n\n';
            // Track referenced papers
            if (review.referenceIds) review.referenceIds.forEach(id => citedRefs.add(id));
            output += '---\n\n';
        }
    }

    // Export ideas
    if (ideaIds?.length > 0) {
        const ideas = readIdeasDB();
        output += '# Research Ideas\n\n';
        for (const iid of ideaIds) {
            const idea = ideas.find(i => i.id === iid);
            if (!idea) continue;
            output += `## ${idea.title}\n\n`;
            if (idea.description) output += `${idea.description}\n\n`;
            if (idea.feasibility || idea.novelty || idea.impact) {
                output += `| Metric | Score |\n|--------|-------|\n`;
                if (idea.feasibility) output += `| Feasibility | ${idea.feasibility}/10 |\n`;
                if (idea.novelty) output += `| Novelty | ${idea.novelty}/10 |\n`;
                if (idea.impact) output += `| Impact | ${idea.impact}/10 |\n`;
                output += '\n';
            }
            if (idea.content) output += idea.content + '\n\n';
            output += '---\n\n';
        }
    }

    // Export plans
    if (planIds?.length > 0) {
        const plans = readPlansDB();
        output += '# Research Plans\n\n';
        for (const pid of planIds) {
            const plan = plans.find(p => p.id === pid);
            if (!plan) continue;
            output += `## ${plan.title}\n\n`;
            if (plan.content) output += plan.content + '\n\n';
            if (plan.todos?.length > 0) {
                output += '### Task List\n\n';
                for (const todo of plan.todos) {
                    output += `- [${todo.done ? 'x' : ' '}] ${todo.text || todo.title}\n`;
                }
                output += '\n';
            }
            output += '---\n\n';
        }
    }

    // Generate BibTeX
    if (citedRefs.size > 0) {
        const refs = readLibraryDB();
        output += '# References (BibTeX)\n\n```bibtex\n';
        for (const rid of citedRefs) {
            const ref = refs.find(r => r.id === rid);
            if (!ref) continue;
            const key = (ref.author?.split(',')[0]?.split(' ').pop() || 'unknown') + (ref.year || '');
            output += `@article{${key},\n`;
            output += `  title = {${ref.title || ''}},\n`;
            output += `  author = {${ref.author || ''}},\n`;
            output += `  year = {${ref.year || ''}},\n`;
            if (ref.journal) output += `  journal = {${ref.journal}},\n`;
            if (ref.doi) output += `  doi = {${ref.doi}},\n`;
            if (ref.url) output += `  url = {${ref.url}},\n`;
            output += `}\n\n`;
        }
        output += '```\n';
    }

    res.json({ content: output, format, citedReferences: citedRefs.size });
});

// ============================================================
// Phase 6: Research Planning & TODO
// ============================================================

const PLANS_DB = path.join(LIBRARY_DIR, 'plans.json');

function readPlansDB() {
    if (!fs.existsSync(PLANS_DB)) return [];
    try { return JSON.parse(fs.readFileSync(PLANS_DB, 'utf8')); }
    catch { return []; }
}

function writePlansDB(plans) {
    fs.writeFileSync(PLANS_DB, JSON.stringify(plans, null, 2), 'utf8');
}

// CRUD for research plans
app.get('/api/library/plans', (req, res) => {
    res.json(readPlansDB());
});

app.get('/api/library/plans/:id', (req, res) => {
    const plans = readPlansDB();
    const plan = plans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
});

app.post('/api/library/plans', (req, res) => {
    const plan = {
        id: generateId(),
        title: req.body.title || 'Untitled Plan',
        ideaId: req.body.ideaId || null,
        content: req.body.content || '',
        todos: req.body.todos || [],
        status: 'draft', // draft | active | completed
        dateCreated: new Date().toISOString(),
        dateModified: new Date().toISOString()
    };

    const plans = readPlansDB();
    plans.push(plan);
    writePlansDB(plans);
    res.json(plan);
});

app.put('/api/library/plans/:id', (req, res) => {
    const plans = readPlansDB();
    const idx = plans.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Plan not found' });

    const allowed = ['title', 'content', 'todos', 'status'];
    for (const key of allowed) {
        if (req.body[key] !== undefined) plans[idx][key] = req.body[key];
    }
    plans[idx].dateModified = new Date().toISOString();
    writePlansDB(plans);
    res.json(plans[idx]);
});

app.delete('/api/library/plans/:id', (req, res) => {
    let plans = readPlansDB();
    plans = plans.filter(p => p.id !== req.params.id);
    writePlansDB(plans);
    res.json({ success: true });
});

// Generate research plan from idea
app.post('/api/library/plans/generate', async (req, res) => {
    const { ideaId, title, description, timeline, methodology, riskAssessmentOnly, resourceEstimateOnly } = req.body;

    let provider = req.body.provider;
    let model = req.body.model;
    if (!provider || !model) {
        const defaults = getProviderForFeature('plans');
        provider = provider || defaults.provider;
        model = model || defaults.model;
    }

    if (!provider) return res.status(400).json({ error: 'No AI provider configured.' });

    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) {
        return res.status(400).json({ error: `Provider not available.` });
    }

    await ensureValidToken(provider);

    // Gather idea context
    let ideaContext = '';
    if (ideaId) {
        const ideas = readIdeasDB();
        const idea = ideas.find(i => i.id === ideaId);
        if (idea) {
            ideaContext = `Research Idea: ${idea.title}\n${idea.description}\n`;
            if (idea.content) ideaContext += `\nDetails:\n${idea.content.substring(0, 10000)}\n`;
            if (idea.refinements?.length > 0) {
                const latest = idea.refinements[idea.refinements.length - 1];
                ideaContext += `\nLatest refinement:\n${latest.result?.substring(0, 5000)}\n`;
            }
        }
    }

    // Build methodology-specific guidance
    const methodTemplates = {
        experimental: 'Focus on: hypothesis formulation, experimental design (control/treatment groups), variables (independent/dependent/confounding), sample size calculation, data collection instruments, statistical analysis plan, reproducibility measures.',
        computational: 'Focus on: algorithm design, computational complexity, implementation stack, dataset preparation, baseline comparisons, evaluation metrics, ablation studies, GPU/compute requirements.',
        survey: 'Focus on: survey instrument design, sampling strategy, target population, response rate targets, pilot testing, data quality checks, statistical analysis (descriptive/inferential).',
        case_study: 'Focus on: case selection criteria, data sources (interviews/documents/observations), triangulation strategy, coding framework, validity/reliability measures.',
        mixed_methods: 'Focus on: integration strategy (convergent/sequential), quantitative component design, qualitative component design, how findings will be merged, validity for both paradigms.',
        meta_analysis: 'Focus on: search strategy (databases/keywords), inclusion/exclusion criteria, quality assessment tool, effect size calculation, heterogeneity analysis, publication bias tests.',
        literature_review: 'Focus on: search protocol, database selection, screening process (PRISMA), quality appraisal, synthesis method (narrative/thematic/framework), gap identification.'
    };
    const methodGuidance = methodology && methodTemplates[methodology] ? `\nMethodology type: ${methodology}\n${methodTemplates[methodology]}\n` : '';

    let planPrompt;

    if (riskAssessmentOnly) {
        planPrompt = `You are a research risk assessment expert. Analyze the following research project and provide a comprehensive risk assessment matrix.

${title ? `Project: ${title}` : ''}
${description ? `Description: ${description}` : ''}
${ideaContext ? `\nResearch context:\n${ideaContext}` : ''}

Generate a detailed risk assessment with:

## ⚠️ Risk Assessment Matrix

| Risk | Category | Probability | Impact | Severity (P×I) | Mitigation Strategy |
|------|----------|-------------|--------|-----------------|---------------------|

Categories: Technical, Data, Timeline, Resource, Novelty, External

For each risk provide:
- **Risk description**: What could go wrong
- **Category**: Technical / Data / Timeline / Resource / Novelty / External
- **Probability**: Low (1) / Medium (2) / High (3)
- **Impact**: Low (1) / Medium (2) / High (3)
- **Severity**: P × I score
- **Mitigation**: Specific actions to reduce risk
- **Contingency**: Backup plan if risk materializes

## 🛡️ Top 3 Critical Risks (Detailed)
For each, explain the worst-case scenario and detailed mitigation plan.

## 📊 Overall Risk Profile
- Overall risk level: [Low/Medium/High]
- Key assumptions that must hold
- Go/No-go decision factors

Use Markdown formatting.`;
    } else if (resourceEstimateOnly) {
        planPrompt = `You are a research resource planning expert. Estimate the resources needed for the following research project.

${title ? `Project: ${title}` : ''}
${description ? `Description: ${description}` : ''}
${ideaContext ? `\nResearch context:\n${ideaContext}` : ''}

Generate a detailed resource estimation:

## 📊 Resource Estimation

### 💰 Budget Breakdown
| Category | Item | Estimated Cost | Notes |
|----------|------|---------------|-------|
| Computing | ... | ... | ... |
| Data | ... | ... | ... |
| Software | ... | ... | ... |
| Personnel | ... | ... | ... |
| Publication | ... | ... | ... |

### 🖥️ Computing Resources
- CPU/GPU requirements
- Cloud vs local
- Storage needs
- Estimated compute hours

### 📁 Data Requirements
- Datasets needed (with sources)
- Data collection effort
- Storage requirements
- Privacy/ethical considerations

### 👥 Personnel & Skills
- Required expertise
- Team size recommendation
- Collaboration needs
- Training requirements

### ⏰ Time Estimation
| Phase | Duration | FTE Required | Key Deliverable |
|-------|----------|-------------|-----------------|
| ... | ... | ... | ... |

### 🔧 Tools & Infrastructure
- Software/libraries
- Hardware
- Cloud services
- Licenses needed

### 💡 Cost Optimization Tips
- Ways to reduce costs
- Free alternatives
- Phased resource allocation

Use Markdown formatting.`;
    } else {
        planPrompt = `You are a research planning expert. Create a detailed, actionable research plan.

${title ? `Project title: ${title}` : ''}
${description ? `Description: ${description}` : ''}
${timeline ? `Target timeline: ${timeline}` : 'Timeline: Flexible'}
${methodGuidance}

${ideaContext ? `\n=== RESEARCH IDEA ===\n${ideaContext}` : ''}

Generate a comprehensive research plan with the following structure:

## 📋 Project Overview
- Title
- Objective
- Scope
- Expected deliverables

## 📅 Timeline & Milestones

Create a detailed timeline with phases:

### Phase 1: Literature Review & Foundation (Week 1-2)
- [ ] Task 1
- [ ] Task 2

### Phase 2: Method Development (Week 3-5)
- [ ] Task 1
- [ ] Task 2

### Phase 3: Implementation (Week 6-10)
- [ ] Task 1
- [ ] Task 2

### Phase 4: Evaluation (Week 11-13)
- [ ] Task 1
- [ ] Task 2

### Phase 5: Writing & Submission (Week 14-16)
- [ ] Task 1
- [ ] Task 2

## 🔧 Resources Needed
- Computing resources
- Datasets
- Tools/libraries
- Collaboration needs

## ⚠️ Risk Mitigation
- Potential risks and backup plans

## 📊 Success Metrics
- How to measure progress
- Definition of done

## 📝 TODO List (Immediate Actions)
Generate a prioritized list of immediate action items:
- [ ] [HIGH] First thing to do
- [ ] [HIGH] Second priority
- [ ] [MEDIUM] Next step
- [ ] [LOW] Can wait

Use Markdown formatting with checkboxes (- [ ]) for all actionable items.`;
    }

    // SSE stream
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    sendEvent('start', { provider, model });

    try {
        const messages = [{ role: 'user', content: planPrompt }];
        const systemPrompt = 'You are a research planning expert. Create detailed, actionable research plans with clear milestones, TODO items, and risk assessment.';
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, {
            method: 'POST',
            headers: apiReq.headers,
            body: JSON.stringify(apiReq.body)
        });

        if (!response.ok) {
            sendEvent('error', { message: `API error: ${response.status}` });
            sendEvent('done', {});
            res.end();
            return;
        }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') {
                        if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text;
                    } else if (provider === 'openai' || provider === 'openrouter') {
                        text = data.choices?.[0]?.delta?.content || null;
                    } else if (provider === 'gemini') {
                        text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    }
                    if (text) {
                        fullText += text;
                        sendEvent('text', { content: text });
                    }
                } catch (e) { }
            }
        }

        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch (err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// ============================================================
// Per-Project Library API (V2)
// ============================================================

// --- Per-Project References ---
app.get('/api/projects/:projectId/library/references', (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const { collection, tag, search, sort, folderId } = req.query;
    let filtered = [...refs];
    if (folderId) filtered = filtered.filter(r => r.folderIds && r.folderIds.includes(folderId));
    if (collection && collection !== 'all') filtered = filtered.filter(r => r.collections && r.collections.includes(collection));
    if (tag) filtered = filtered.filter(r => r.tags && r.tags.includes(tag));
    if (search) {
        const s = search.toLowerCase();
        filtered = filtered.filter(r =>
            (r.title && r.title.toLowerCase().includes(s)) ||
            (r.authors && r.authors.some(a => a.toLowerCase().includes(s))) ||
            (r.abstract && r.abstract.toLowerCase().includes(s))
        );
    }
    if (sort === 'year') filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    else if (sort === 'title') filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    res.json(filtered);
});

app.get('/api/projects/:projectId/library/references/:id', (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ error: 'Not found' });
    res.json(ref);
});

app.post('/api/projects/:projectId/library/references', express.json(), (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const newRef = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        ...req.body,
        addedAt: Date.now(),
        updatedAt: Date.now(),
        folderIds: req.body.folderIds || [],
        tags: req.body.tags || [],
        collections: req.body.collections || []
    };
    refs.push(newRef);
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json(newRef);
});

app.put('/api/projects/:projectId/library/references/:id', express.json(), (req, res) => {
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const idx = refs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    refs[idx] = { ...refs[idx], ...req.body, updatedAt: Date.now() };
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json(refs[idx]);
});

app.delete('/api/projects/:projectId/library/references/:id', (req, res) => {
    let refs = readProjectDB(req.params.projectId, 'references.json');
    const ref = refs.find(r => r.id === req.params.id);
    if (!ref) return res.status(404).json({ error: 'Not found' });
    // Delete associated PDF
    if (ref.pdfPath) {
        const pdfFile = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs', path.basename(ref.pdfPath));
        if (fs.existsSync(pdfFile)) fs.unlinkSync(pdfFile);
    }
    refs = refs.filter(r => r.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json({ success: true });
});

// --- Per-Project PDF Upload ---
app.post('/api/projects/:projectId/library/upload-pdf', (req, res) => {
    const projectId = req.params.projectId;
    const pdfsDir = path.join(getProjectLibraryDir(projectId), 'pdfs');
    const upload = multer({
        dest: pdfsDir,
        limits: { fileSize: 100 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) cb(null, true);
            else cb(new Error('Only PDF files allowed'), false);
        }
    }).single('pdf');

    upload(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const newName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const newPath = path.join(pdfsDir, newName);
        fs.renameSync(req.file.path, newPath);
        res.json({ filename: newName, path: `/api/projects/${projectId}/library/pdfs/${newName}` });
    });
});

// Serve project PDFs
app.get('/api/projects/:projectId/library/pdfs/:filename', (req, res) => {
    const pdfPath = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs', req.params.filename);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(pdfPath);
});

// --- Per-Project Folders ---
app.get('/api/projects/:projectId/library/folders', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'folders.json'));
});

app.post('/api/projects/:projectId/library/folders', express.json(), (req, res) => {
    const folders = readProjectDB(req.params.projectId, 'folders.json');
    const newFolder = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        name: req.body.name || 'New Folder',
        parentId: req.body.parentId || null,
        order: req.body.order || folders.length,
        createdAt: Date.now()
    };
    folders.push(newFolder);
    writeProjectDB(req.params.projectId, 'folders.json', folders);
    res.json(newFolder);
});

app.put('/api/projects/:projectId/library/folders/:id', express.json(), (req, res) => {
    const folders = readProjectDB(req.params.projectId, 'folders.json');
    const idx = folders.findIndex(f => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Folder not found' });
    folders[idx] = { ...folders[idx], ...req.body };
    writeProjectDB(req.params.projectId, 'folders.json', folders);
    res.json(folders[idx]);
});

app.delete('/api/projects/:projectId/library/folders/:id', (req, res) => {
    let folders = readProjectDB(req.params.projectId, 'folders.json');
    // Also remove folder references from all references
    const refs = readProjectDB(req.params.projectId, 'references.json');
    const folderId = req.params.id;
    // Get all descendant folder IDs
    function getDescendants(parentId) {
        const children = folders.filter(f => f.parentId === parentId);
        let ids = [parentId];
        children.forEach(c => { ids = ids.concat(getDescendants(c.id)); });
        return ids;
    }
    const idsToRemove = getDescendants(folderId);
    folders = folders.filter(f => !idsToRemove.includes(f.id));
    refs.forEach(r => {
        if (r.folderIds) r.folderIds = r.folderIds.filter(id => !idsToRemove.includes(id));
    });
    writeProjectDB(req.params.projectId, 'folders.json', folders);
    writeProjectDB(req.params.projectId, 'references.json', refs);
    res.json({ success: true });
});

// --- Per-Project Collections ---
app.get('/api/projects/:projectId/library/collections', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'collections.json'));
});

app.post('/api/projects/:projectId/library/collections', express.json(), (req, res) => {
    const collections = readProjectDB(req.params.projectId, 'collections.json');
    const newCol = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        name: req.body.name || 'New Collection',
        type: 'user',
        icon: req.body.icon || 'folder'
    };
    collections.push(newCol);
    writeProjectDB(req.params.projectId, 'collections.json', collections);
    res.json(newCol);
});

app.delete('/api/projects/:projectId/library/collections/:id', (req, res) => {
    let collections = readProjectDB(req.params.projectId, 'collections.json');
    collections = collections.filter(c => c.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'collections.json', collections);
    res.json({ success: true });
});

// --- Per-Project Reviews ---
app.get('/api/projects/:projectId/library/reviews', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'reviews.json'));
});

app.post('/api/projects/:projectId/library/reviews', express.json(), (req, res) => {
    const reviews = readProjectDB(req.params.projectId, 'reviews.json');
    const newReview = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        ...req.body,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    reviews.push(newReview);
    writeProjectDB(req.params.projectId, 'reviews.json', reviews);
    res.json(newReview);
});

app.put('/api/projects/:projectId/library/reviews/:id', express.json(), (req, res) => {
    const reviews = readProjectDB(req.params.projectId, 'reviews.json');
    const idx = reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    reviews[idx] = { ...reviews[idx], ...req.body, updatedAt: Date.now() };
    writeProjectDB(req.params.projectId, 'reviews.json', reviews);
    res.json(reviews[idx]);
});

app.delete('/api/projects/:projectId/library/reviews/:id', (req, res) => {
    let reviews = readProjectDB(req.params.projectId, 'reviews.json');
    reviews = reviews.filter(r => r.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'reviews.json', reviews);
    res.json({ success: true });
});

// --- Per-Project Ideas ---
app.get('/api/projects/:projectId/library/ideas', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'ideas.json'));
});

app.post('/api/projects/:projectId/library/ideas', express.json(), (req, res) => {
    const ideas = readProjectDB(req.params.projectId, 'ideas.json');
    const newIdea = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        title: req.body.title || 'New Idea',
        description: req.body.description || '',
        methodology: req.body.methodology || '',
        impact: req.body.impact || '',
        feasibility: req.body.feasibility || '',
        status: req.body.status || 'draft',
        tags: req.body.tags || [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    ideas.push(newIdea);
    writeProjectDB(req.params.projectId, 'ideas.json', ideas);
    res.json(newIdea);
});

app.put('/api/projects/:projectId/library/ideas/:id', express.json(), (req, res) => {
    const ideas = readProjectDB(req.params.projectId, 'ideas.json');
    const idx = ideas.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    ideas[idx] = { ...ideas[idx], ...req.body, updatedAt: Date.now() };
    writeProjectDB(req.params.projectId, 'ideas.json', ideas);
    res.json(ideas[idx]);
});

app.delete('/api/projects/:projectId/library/ideas/:id', (req, res) => {
    let ideas = readProjectDB(req.params.projectId, 'ideas.json');
    ideas = ideas.filter(i => i.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'ideas.json', ideas);
    res.json({ success: true });
});

// --- Per-Project Plans ---
app.get('/api/projects/:projectId/library/plans', (req, res) => {
    res.json(readProjectDB(req.params.projectId, 'plans.json'));
});

app.post('/api/projects/:projectId/library/plans', express.json(), (req, res) => {
    const plans = readProjectDB(req.params.projectId, 'plans.json');
    const newPlan = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        title: req.body.title || 'New Plan',
        description: req.body.description || '',
        objectives: req.body.objectives || [],
        timeline: req.body.timeline || '',
        resources: req.body.resources || '',
        risks: req.body.risks || '',
        todos: req.body.todos || [],
        status: req.body.status || 'draft',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    plans.push(newPlan);
    writeProjectDB(req.params.projectId, 'plans.json', plans);
    res.json(newPlan);
});

app.put('/api/projects/:projectId/library/plans/:id', express.json(), (req, res) => {
    const plans = readProjectDB(req.params.projectId, 'plans.json');
    const idx = plans.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    plans[idx] = { ...plans[idx], ...req.body, updatedAt: Date.now() };
    writeProjectDB(req.params.projectId, 'plans.json', plans);
    res.json(plans[idx]);
});

app.delete('/api/projects/:projectId/library/plans/:id', (req, res) => {
    let plans = readProjectDB(req.params.projectId, 'plans.json');
    plans = plans.filter(p => p.id !== req.params.id);
    writeProjectDB(req.params.projectId, 'plans.json', plans);
    res.json({ success: true });
});

// --- Paper Search (Semantic Scholar) ---
app.get('/api/search/papers', async (req, res) => {
    const { query, limit = 10 } = req.query;
    if (!query) return res.status(400).json({ error: 'Query required' });
    try {
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,abstract,citationCount,url,externalIds,openAccessPdf`;
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'SenkouAgent/1.0' }
        });
        // Handle rate limiting specifically
        if (response.status === 429) {
            return res.status(429).json({ error: 'Rate limited by Semantic Scholar. Please wait a moment and try again.' });
        }
        if (!response.ok) {
            const text = await response.text();
            // Check if response is HTML instead of JSON
            if (text.startsWith('<') || text.startsWith('<!')) {
                return res.status(502).json({ error: `Semantic Scholar returned an error page (HTTP ${response.status}). Try again later.` });
            }
            throw new Error(`S2 API error: ${response.status} - ${text.substring(0, 200)}`);
        }
        const text = await response.text();
        // Validate it's actually JSON before parsing
        if (text.startsWith('<') || text.startsWith('<!')) {
            return res.status(502).json({ error: 'Semantic Scholar returned HTML instead of JSON. The service may be temporarily unavailable.' });
        }
        const data = JSON.parse(text);
        res.json(data);
    } catch (err) {
        if (err instanceof SyntaxError) {
            return res.status(502).json({ error: 'Invalid response from Semantic Scholar. Please try again.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// --- DOI Lookup (CrossRef) ---
app.get('/api/doi/lookup', async (req, res) => {
    const { doi } = req.query;
    if (!doi) return res.status(400).json({ error: 'DOI required' });
    try {
        const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error(`CrossRef API error: ${response.status}`);
        const data = await response.json();
        const work = data.message;
        const result = {
            title: work.title?.[0] || '',
            authors: (work.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()),
            year: work.published?.['date-parts']?.[0]?.[0] || null,
            journal: work['container-title']?.[0] || '',
            doi: work.DOI,
            abstract: work.abstract || '',
            url: work.URL || '',
            type: work.type || ''
        };
        // Try to get open access PDF via Unpaywall
        try {
            const upResp = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=senkou@example.com`);
            if (upResp.ok) {
                const upData = await upResp.json();
                if (upData.best_oa_location?.url_for_pdf) {
                    result.pdfUrl = upData.best_oa_location.url_for_pdf;
                }
            }
        } catch(e) { /* ignore unpaywall errors */ }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Translation API ---
app.post('/api/translate', express.json(), async (req, res) => {
    const { text, mode = 'free', sourceLang = 'en', targetLang = 'zh' } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    if (mode === 'ai') {
        // AI translation using configured provider (with per-feature override)
        const defaults = getProviderForFeature('translation');
        const provider = defaults.provider;
        const model = defaults.model;
        if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
        const providerInfo = AI_PROVIDERS[provider];
        if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
        await ensureValidToken(provider);

        const systemPrompt = `You are an academic translation assistant. Translate the following academic text from ${sourceLang} to ${targetLang}. Preserve all technical terms, mathematical notation, and citation references. After the translation, provide a brief explanation of key technical terms found in the text. Format your response as:

TRANSLATION:
[translated text]

TERMS:
- [term1]: [explanation]
- [term2]: [explanation]`;

        try {
            const messages = [{ role: 'user', content: text }];
            const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], false);

            const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            const data = await response.json();
            let content = '';
            if (provider === 'anthropic') {
                content = data.content?.[0]?.text || '';
            } else if (provider === 'gemini') {
                content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else {
                content = data.choices?.[0]?.message?.content || '';
            }

            // Parse translation and terms
            const parts = content.split(/TERMS:/i);
            const translation = (parts[0] || '').replace(/^TRANSLATION:\s*/i, '').trim();
            const terms = (parts[1] || '').trim();

            res.json({ translation, terms, mode: 'ai' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    } else {
        // Free translation via MyMemory API
        try {
            const langPair = `${sourceLang}|${targetLang === 'zh' ? 'zh-CN' : targetLang}`;
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.substring(0, 500))}&langpair=${langPair}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`MyMemory API error: ${response.status}`);
            const data = await response.json();
            res.json({
                translation: data.responseData?.translatedText || '',
                terms: '',
                mode: 'free'
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
});

// --- Download PDF from URL ---
app.post('/api/projects/:projectId/library/references/:id/download-pdf', express.json(), async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        const pdfsDir = path.join(getProjectLibraryDir(req.params.projectId), 'pdfs');
        const filename = `${req.params.id}_${Date.now()}.pdf`;
        const filePath = path.join(pdfsDir, filename);
        fs.writeFileSync(filePath, buffer);

        // Update reference with PDF path (use pdfFile for consistency)
        const refs = readProjectDB(req.params.projectId, 'references.json');
        const idx = refs.findIndex(r => r.id === req.params.id);
        if (idx !== -1) {
            refs[idx].pdfFile = filename;
            refs[idx].pdfPath = `/api/projects/${req.params.projectId}/library/pdfs/${filename}`;
            refs[idx].updatedAt = Date.now();
            writeProjectDB(req.params.projectId, 'references.json', refs);
        }

        res.json({ success: true, pdfFile: filename, pdfPath: `/api/projects/${req.params.projectId}/library/pdfs/${filename}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- BibTeX Import per Project ---
app.post('/api/projects/:projectId/library/import/bibtex', express.json(), (req, res) => {
    const { bibtex } = req.body;
    if (!bibtex) return res.status(400).json({ error: 'BibTeX content required' });

    try {
        const parsed = parseBibTeX(bibtex);
        const refs = readProjectDB(req.params.projectId, 'references.json');
        const imported = [];

        parsed.forEach(entry => {
            const newRef = {
                id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                title: entry.title || 'Untitled',
                authors: entry.author ? entry.author.split(' and ').map(a => a.trim()) : [],
                year: entry.year ? parseInt(entry.year) : null,
                journal: entry.journal || entry.booktitle || '',
                doi: entry.doi || '',
                abstract: entry.abstract || '',
                bibtexKey: entry.citationKey || '',
                bibtexType: entry.entryType || 'article',
                tags: [],
                folderIds: [],
                collections: [],
                addedAt: Date.now(),
                updatedAt: Date.now()
            };
            refs.push(newRef);
            imported.push(newRef);
        });

        writeProjectDB(req.params.projectId, 'references.json', refs);
        res.json({ imported: imported.length, references: imported });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Per-Project Notes ---
app.get('/api/projects/:projectId/library/notes/:refId', (req, res) => {
    const notesDir = path.join(getProjectLibraryDir(req.params.projectId), 'notes');
    const notePath = path.join(notesDir, `${req.params.refId}.json`);
    try {
        if (fs.existsSync(notePath)) {
            res.json(JSON.parse(fs.readFileSync(notePath, 'utf8')));
        } else {
            res.json({ notes: [] });
        }
    } catch(e) { res.json({ notes: [] }); }
});

app.post('/api/projects/:projectId/library/notes/:refId', express.json(), (req, res) => {
    const notesDir = path.join(getProjectLibraryDir(req.params.projectId), 'notes');
    const notePath = path.join(notesDir, `${req.params.refId}.json`);
    fs.writeFileSync(notePath, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

// --- Per-Project AI Generate Reviews ---
app.post('/api/projects/:projectId/library/reviews/generate', express.json(), async (req, res) => {
    const { referenceIds, prompt } = req.body;
    const defaults = getProviderForFeature('reviews');
    const provider = defaults.provider;
    const model = defaults.model;
    if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const refs = readProjectDB(req.params.projectId, 'references.json');
    const selectedRefs = referenceIds ? refs.filter(r => referenceIds.includes(r.id)) : refs;

    const refsContext = selectedRefs.map(r =>
        `- ${r.title} (${r.authors?.join(', ')}, ${r.year}): ${r.abstract || 'No abstract'}`
    ).join('\n');

    const systemPrompt = `You are a research literature review assistant. Based on the following references, generate a comprehensive literature review. Structure it with clear sections, identify common themes, research gaps, and methodological approaches.\n\nReferences:\n${refsContext}`;

    try {
        const messages = [{ role: 'user', content: prompt || 'Generate a comprehensive literature review based on these papers.' }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) { sendEvent('error', { message: `API error: ${response.status}` }); sendEvent('done', {}); res.end(); return; }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') {
                        if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text;
                    } else if (provider === 'gemini') {
                        text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
                    } else { text = data.choices?.[0]?.delta?.content || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch(e) {}
            }
        }

        // Auto-save the review
        const reviews = readProjectDB(req.params.projectId, 'reviews.json');
        const newReview = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            title: `Literature Review - ${new Date().toLocaleDateString()}`,
            content: fullText,
            referenceIds: referenceIds || selectedRefs.map(r => r.id),
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        reviews.push(newReview);
        writeProjectDB(req.params.projectId, 'reviews.json', reviews);
        sendEvent('saved', { id: newReview.id });
        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch(err) {
        sendEvent('error', { message: err.message });
        sendEvent('done', {});
        res.end();
    }
});

// --- Per-Project AI Generate Ideas ---
app.post('/api/projects/:projectId/library/ideas/generate', express.json(), async (req, res) => {
    const { reviewContent, prompt } = req.body;
    const defaults = getProviderForFeature('ideas');
    const provider = defaults.provider;
    const model = defaults.model;
    if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const refs = readProjectDB(req.params.projectId, 'references.json');
    const refsContext = refs.slice(0, 20).map(r => `- ${r.title} (${r.year})`).join('\n');

    const systemPrompt = `You are a creative research assistant. Based on the literature review and references, generate novel research ideas. For each idea, provide: title, description, methodology, potential impact, and feasibility assessment.\n\n${reviewContent ? 'Literature Review:\n' + reviewContent + '\n\n' : ''}References:\n${refsContext}`;

    try {
        const messages = [{ role: 'user', content: prompt || 'Generate 3 novel research ideas based on the literature.' }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) { sendEvent('error', { message: `API error: ${response.status}` }); sendEvent('done', {}); res.end(); return; }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') { if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text; }
                    else if (provider === 'gemini') { text = data.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                    else { text = data.choices?.[0]?.delta?.content || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch(e) {}
            }
        }

        // Auto-save the idea
        const ideas = readProjectDB(req.params.projectId, 'ideas.json');
        const newIdea = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            title: `AI Generated Ideas - ${new Date().toLocaleDateString()}`,
            description: fullText,
            status: 'draft',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        ideas.push(newIdea);
        writeProjectDB(req.params.projectId, 'ideas.json', ideas);
        sendEvent('saved', { id: newIdea.id });
        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch(err) { sendEvent('error', { message: err.message }); sendEvent('done', {}); res.end(); }
});

// --- Per-Project AI Generate Plans ---
app.post('/api/projects/:projectId/library/plans/generate', express.json(), async (req, res) => {
    const { ideaContent, prompt } = req.body;
    const defaults = getProviderForFeature('plans');
    const provider = defaults.provider;
    const model = defaults.model;
    if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const systemPrompt = `You are a research planning assistant. Based on the research idea, generate a detailed research plan including: objectives, methodology, timeline, required resources, potential risks and mitigation strategies, and expected outcomes.\n\n${ideaContent ? 'Research Idea:\n' + ideaContent : ''}`;

    try {
        const messages = [{ role: 'user', content: prompt || 'Generate a detailed research plan for this idea.' }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], true);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) { sendEvent('error', { message: `API error: ${response.status}` }); sendEvent('done', {}); res.end(); return; }

        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    let text = null;
                    if (provider === 'anthropic') { if (data.type === 'content_block_delta' && data.delta?.text) text = data.delta.text; }
                    else if (provider === 'gemini') { text = data.candidates?.[0]?.content?.parts?.[0]?.text || null; }
                    else { text = data.choices?.[0]?.delta?.content || null; }
                    if (text) { fullText += text; sendEvent('text', { content: text }); }
                } catch(e) {}
            }
        }

        const plans = readProjectDB(req.params.projectId, 'plans.json');
        const newPlan = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            title: `Research Plan - ${new Date().toLocaleDateString()}`,
            description: fullText,
            status: 'draft',
            todos: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        plans.push(newPlan);
        writeProjectDB(req.params.projectId, 'plans.json', plans);
        sendEvent('saved', { id: newPlan.id });
        sendEvent('done', { totalLength: fullText.length });
        res.end();
    } catch(err) { sendEvent('error', { message: err.message }); sendEvent('done', {}); res.end(); }
});

// --- AI Generate Editor Todos ---
app.post('/api/projects/:projectId/generate-todos', express.json(), async (req, res) => {
    const { texContent } = req.body;
    const defaults = getProviderForFeature('writing');
    const provider = defaults.provider;
    const model = defaults.model;
    if (!provider) return res.status(400).json({ error: 'No AI provider configured' });
    const providerInfo = AI_PROVIDERS[provider];
    if (!providerInfo || !providerInfo.isAvailable()) return res.status(400).json({ error: `AI provider ${provider} is not available.` });
    await ensureValidToken(provider);

    const systemPrompt = `You are an academic writing assistant. Analyze the following LaTeX document and identify writing tasks that need to be completed. Consider: missing sections, incomplete arguments, needed citations, figures to add, formatting issues, and content gaps. Return a JSON array of todo items, each with: {"text": "description", "priority": "high|medium|low", "section": "which section it relates to"}`;

    try {
        const messages = [{ role: 'user', content: texContent || 'No content provided' }];
        const apiReq = buildProviderRequest(provider, model, systemPrompt, messages, [], false);

        const response = await fetch(apiReq.url, { method: 'POST', headers: apiReq.headers, body: JSON.stringify(apiReq.body) });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = await response.json();
        let content = '';
        if (provider === 'anthropic') { content = data.content?.[0]?.text || '[]'; }
        else if (provider === 'gemini') { content = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]'; }
        else { content = data.choices?.[0]?.message?.content || '[]'; }

        // Try to parse JSON from the response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const todos = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        res.json({ todos });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// End Library API
// ============================================================

app.listen(PORT, async () => {
    const projects = getProjects();
    const tuAvailable = await isToolUniverseAvailable(true);
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  Senkou Agent - LaTeX & Research Platform                  ║
║  URL: http://localhost:${PORT}/compile.html                  ║
║  Projects found: ${projects.length}                                        ║
║  Auto-compile: ENABLED                                     ║
║  ToolUniverse: ${tuAvailable ? 'CONNECTED ✓' : 'OFFLINE (start with: tooluniverse-http-api)'}${tuAvailable ? '                              ' : ''}║
╚════════════════════════════════════════════════════════════╝
`);
    projects.forEach(p => console.log(`  - ${p.name}`));

    // Start file watcher
    setupFileWatcher();
});
