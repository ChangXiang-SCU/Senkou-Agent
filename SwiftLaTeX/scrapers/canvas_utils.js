'use strict';

// Canvas 爬虫用到的纯函数，单独放出来方便测试，不依赖 Playwright。

const fs = require('fs');
const path = require('path');

// server.js 在没配置 ICS 地址时会把这个占位值传给爬虫，不能当成真的学校地址
const SERVER_PLACEHOLDER_URL = 'https://canvas.instructure.com';

function originOf(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const u = new URL(value.trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        return `${u.protocol}//${u.host}`;
    } catch {
        return null;
    }
}

/**
 * 决定连哪个 Canvas。优先级：
 *   1. 环境变量 CANVAS_BASE_URL
 *   2. config.json 的 canvas_base_url
 *   3. 命令行参数（server.js 传进来的 ICS 地址）
 *   4. config.json 的 canvas_ics_url（取域名部分）
 * 都没有就返回 baseUrl: null，由调用方报错，不再默认连 Cornell。
 */
function resolveBaseUrl({ argv = [], env = {}, config = {} } = {}) {
    const candidates = [
        { value: env.CANVAS_BASE_URL, source: 'CANVAS_BASE_URL 环境变量' },
        { value: config.canvas_base_url, source: 'config.json 的 canvas_base_url' },
        { value: argv[0], source: '命令行参数', skipPlaceholder: true },
        { value: config.canvas_ics_url, source: 'config.json 的 canvas_ics_url' },
    ];
    for (const c of candidates) {
        const origin = originOf(c.value);
        if (!origin) continue;
        if (c.skipPlaceholder && origin === SERVER_PLACEHOLDER_URL) continue;
        return { baseUrl: origin, source: c.source };
    }
    return { baseUrl: null, source: null };
}

function readConfig(configPath) {
    try {
        if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error(`读取 ${configPath} 失败：${e.message}`);
    }
    return {};
}

// 和 server.js 的选择逻辑保持一致，否则爬下来的作业文件夹编辑器里看不到
function resolveProjectsBase(appDir) {
    const parent = path.resolve(appDir, '..', 'projects');
    const local = path.resolve(appDir, 'projects');
    return fs.existsSync(parent) ? parent : local;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * 文件夹名清洗。在原规则（只留字母数字、空格、_、-）基础上放行中文等 Unicode 字母数字。
 * 原来的 /[^a-zA-Z0-9_\- ]/ 会把中文课程名清成空字符串，结果作业文件直接写进 projects 根目录。
 * 纯英文名字的结果和原来完全一样，已经建好的作业文件夹不会重复创建。
 */
function safeName(value, fallback = 'untitled', maxLength = 150) {
    let s = String(value ?? '')
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
        .trim();
    if (s.length > maxLength) s = s.slice(0, maxLength).trim();
    if (!s) s = String(fallback);
    if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
    return s;
}

// 文件名清洗，保留扩展名。原来 "report.pdf" 会变成 "reportpdf.pdf"，"作业要求.pdf" 会变成 ".pdf"
function safeFileName(filename, fallback = 'file') {
    const raw = String(filename ?? '').split(/[\\/]/).pop();
    const m = raw.match(/^(.*?)\.([A-Za-z0-9]{1,10})$/);
    const base = m ? m[1] : raw;
    const ext = m ? `.${m[2].toLowerCase()}` : '';
    return `${safeName(base, fallback)}${ext}`;
}

function tryDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

// 从 Content-Disposition 取文件名，优先 RFC 5987 的 filename*=UTF-8''...（中文文件名在这里）
function filenameFromContentDisposition(header) {
    if (!header) return null;
    const star = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
    if (star) return tryDecode(star[2].trim().replace(/^"|"$/g, ''));
    const quoted = header.match(/filename\s*=\s*"([^"]*)"/i);
    if (quoted) return tryDecode(quoted[1]);
    const bare = header.match(/filename\s*=\s*([^;]+)/i);
    return bare ? tryDecode(bare[1].trim()) : null;
}

function filenameFromUrl(url) {
    const parts = String(url || '').split(/[?#]/)[0].split('/').filter(Boolean);
    let name = parts[parts.length - 1] || '';
    if (name === 'download') name = parts[parts.length - 2] || '';
    return tryDecode(name);
}

// Canvas 文件链接转成直接下载地址
function toDownloadUrl(url) {
    if (url.includes('download')) return url;
    return url.split('?')[0] + '/download?download_frd=1';
}

function isSameOrigin(url, baseUrl) {
    const a = originOf(url);
    return !!a && a === originOf(baseUrl);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 生成保存到作业目录里的 HTML。
 * 加 charset 防止本地双击打开时中文乱码；加 CSP 禁止脚本，这些文件会经 /api/file 以同源方式打开，
 * 里面要是能跑脚本就能调本机所有接口。
 */
function htmlDocument(title, bodyHtml) {
    return '<!doctype html>\n<html><head><meta charset="utf-8">'
        + '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'">'
        + `<title>${escapeHtml(title)}</title></head><body>\n`
        + `${bodyHtml}\n</body></html>\n`;
}

function getCurrentTermInfo(now = new Date()) {
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const yy = year.toString().slice(-2);
    if (month <= 5) return { name: `Spring ${year}`, short: `SP${yy}` };
    if (month <= 8) return { name: `Summer ${year}`, short: `SU${yy}` };
    return { name: `Fall ${year}`, short: `FA${yy}` };
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * 判断课程是不是本学期的。
 * 先看 Canvas 返回的学期起止日期（任何学校、任何学期命名都适用），
 * 没有日期再按原来的办法：学期名含 "Fall 2026" / "FA26"，或者 5 个月内创建。
 * 港科广这类学期名不是 "Fall 2026" 格式的学校主要靠日期判断。
 */
function isCurrentCourse(course, now = new Date()) {
    if (!course || !course.name) return false;
    const term = course.term || {};
    const start = parseDate(term.start_at) || parseDate(course.start_at);
    const end = parseDate(term.end_at) || parseDate(course.end_at);
    if (start && end) {
        // 开学前 30 天、结课后 14 天内都算（提前发作业、期末补交）
        return start.getTime() - 30 * DAY <= now.getTime() && now.getTime() <= end.getTime() + 14 * DAY;
    }
    if (end && end.getTime() + 14 * DAY < now.getTime()) return false;

    const termInfo = getCurrentTermInfo(now);
    const tName = term.name || '';
    const cName = course.name || '';
    if (tName.includes(termInfo.name) || cName.includes(termInfo.name) || cName.includes(termInfo.short)) return true;

    const created = parseDate(course.created_at);
    if (created && (now - created) / (30 * DAY) <= 5) return true;
    return false;
}

module.exports = {
    SERVER_PLACEHOLDER_URL,
    originOf,
    resolveBaseUrl,
    readConfig,
    resolveProjectsBase,
    safeName,
    safeFileName,
    filenameFromContentDisposition,
    filenameFromUrl,
    toDownloadUrl,
    isSameOrigin,
    escapeHtml,
    htmlDocument,
    getCurrentTermInfo,
    isCurrentCourse,
};
