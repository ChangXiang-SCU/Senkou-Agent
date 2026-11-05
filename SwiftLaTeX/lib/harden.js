'use strict';

/*
 * 安全加固预加载模块。不改 server.js，启动时用 -r 加载：
 *
 *   node -r ./lib/harden.js server.js      （npm start 已经这样写好）
 *
 * 做四件事：
 *   1. 默认只监听 127.0.0.1（原来 app.listen(PORT) 会监听所有网卡，同一 WiFi 下的人能直接访问）
 *   2. 检查 Host 头，挡 DNS rebinding（恶意网站把自己的域名解析到 127.0.0.1 再读接口）
 *   3. 挡跨站请求：别的网站页面不能调 /api/*，也不能跨站 POST/PUT/DELETE
 *   4. 静态文件黑名单：config.json（全部 API key）、scrapers/（Canvas 登录态）、data/、projects/
 *      原来 express.static(__dirname) 会把它们原样发出去
 *
 * 环境变量：
 *   SENKOU_HOST           监听地址，默认 127.0.0.1。设成 0.0.0.0 就是局域网开放，服务本身没有登录，慎用
 *   SENKOU_PORT           覆盖端口（主要给测试用；OAuth 回调地址写死了 3000，日常别改）
 *   SENKOU_ALLOWED_HOSTS  额外允许的 Host 名，逗号分隔，例如 mypc.local
 *   SENKOU_HARDEN=off     临时关掉检查（只保留监听地址），排查问题用
 */

const net = require('net');
const path = require('path');

const DEFAULT_HOST = '127.0.0.1';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseList(value) {
    return String(value || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

// "localhost:3000" -> "localhost"，"[::1]:3000" -> "::1"
function hostnameOf(hostHeader) {
    if (!hostHeader) return '';
    const h = String(hostHeader).trim().toLowerCase();
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        return end > 0 ? h.slice(1, end) : '';
    }
    const first = h.indexOf(':');
    if (first === -1) return h;
    if (first === h.lastIndexOf(':')) return h.slice(0, first);
    return h; // 不带方括号的 IPv6，原样返回
}

function isAllowedHost(hostHeader, extraAllowed = []) {
    const name = hostnameOf(hostHeader).replace(/\.$/, '');
    if (!name) return false;
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    // IP 字面量没法被 DNS rebinding 利用，局域网用 IP 访问时也要放行
    if (net.isIP(name)) return true;
    return extraAllowed.includes(name);
}

function isLoopbackHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

// 把 URL 路径规范成用来匹配黑名单的段列表。
// 按 Windows 文件系统的宽松规则处理：大小写不敏感、段尾的点和空格会被忽略、"::$DATA" 之类的流名。
function normalizeStaticPath(urlPath) {
    let p = String(urlPath || '/');
    const q = p.indexOf('?');
    if (q !== -1) p = p.slice(0, q);
    try {
        p = decodeURIComponent(p);
    } catch {
        return null;
    }
    if (p.includes('\0')) return null;
    p = path.posix.normalize(p.replace(/\\/g, '/').toLowerCase());
    return p
        .split('/')
        .map(seg => seg.replace(/:.*$/, '').replace(/[. ]+$/, ''))
        .filter(Boolean);
}

function isBlockedStaticPath(urlPath) {
    const segs = normalizeStaticPath(urlPath);
    if (segs === null) return true; // 解码失败、带 \0，直接拒
    if (segs.length === 0) return false;
    // Windows 8.3 短文件名（SCRAPE~1\SESSIO~1.JSO 会指向 scrapers\session.json），静态资源里没有这种名字，一律拒
    if (segs.some(seg => /~\d/.test(seg))) return true;
    const [first] = segs;
    if (segs.length === 1 && first.startsWith('config') && first !== 'config.example.json') return true;
    return first === 'scrapers' || first === 'data' || first === 'projects';
}

// req.url 一般是 "/a/b?x"，但 HTTP 允许 absolute-form（"GET http://host/config.json"），Express 照样能路由，
// 所以统一取 pathname 再判断。解析不了返回 null。
function pathnameOf(url) {
    const u = String(url || '/');
    if (u.startsWith('/')) return u.split(/[?#]/)[0];
    try {
        return new URL(u).pathname;
    } catch {
        return null;
    }
}

function isOAuthPath(urlPath) {
    return /^\/api\/oauth\//i.test(String(urlPath || ''));
}

/**
 * 判断一个请求要不要拦。返回 null 表示放行，返回字符串表示拦截原因。
 * 只读 req.method / req.url / req.headers，方便单测。
 */
function checkRequest(req, options = {}) {
    const extraAllowed = options.allowedHosts || [];
    const headers = req.headers || {};
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = pathnameOf(req.url);
    if (pathname === null) return 'bad request target';
    const isApi = /^\/api(\/|$)/i.test(pathname);

    if (!isAllowedHost(headers.host, extraAllowed)) {
        return 'host not allowed';
    }

    const fetchSite = String(headers['sec-fetch-site'] || '').toLowerCase();
    const fetchMode = String(headers['sec-fetch-mode'] || '').toLowerCase();
    const crossSite = fetchSite === 'cross-site' || fetchSite === 'same-site';

    // 浏览器发起的跨站 API 请求（含 <img>、表单、fetch）。
    // 只放行 OAuth 的顶层跳转（Google / OpenAI 登录后会跳回 /api/oauth/*/callback）。
    if (isApi && crossSite) {
        const oauthNavigation = SAFE_METHODS.has(method) && fetchMode === 'navigate' && isOAuthPath(pathname);
        if (!oauthNavigation) return 'cross-site request blocked';
    }

    // 不带 Sec-Fetch-* 的老浏览器：写操作看 Origin
    if (!SAFE_METHODS.has(method) && headers.origin !== undefined) {
        const origin = String(headers.origin);
        let sameOrigin = false;
        if (origin !== 'null') {
            try {
                sameOrigin = new URL(origin).host.toLowerCase() === String(headers.host || '').toLowerCase();
            } catch {
                sameOrigin = false;
            }
        }
        if (!sameOrigin) return 'cross-origin write blocked';
    }

    if (!isApi && isBlockedStaticPath(pathname)) {
        return 'path not served';
    }

    return null;
}

function rejectRequest(res, reason) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`Forbidden (${reason})`);
}

let installed = false;

function install(env = process.env) {
    if (installed) return;
    installed = true;

    const express = require('express');
    const proto = express.application;
    const host = env.SENKOU_HOST || DEFAULT_HOST;
    const portOverride = env.SENKOU_PORT !== undefined && env.SENKOU_PORT !== '' ? Number(env.SENKOU_PORT) : undefined;
    const checksEnabled = String(env.SENKOU_HARDEN || '').toLowerCase() !== 'off';
    const options = { allowedHosts: parseList(env.SENKOU_ALLOWED_HOSTS) };

    // express() 创建 app 时会把 proto 上的方法拷到 app 上，所以必须在 server.js require express 之前改
    const originalHandle = proto.handle;
    proto.handle = function hardenedHandle(req, res, callback) {
        if (checksEnabled) {
            const reason = checkRequest(req, options);
            if (reason) {
                if (env.SENKOU_HARDEN_LOG !== 'off') {
                    console.warn(`[harden] 403 ${req.method} ${String(req.url).split('?')[0]} (${reason})`);
                }
                return rejectRequest(res, reason);
            }
        }
        return originalHandle.call(this, req, res, callback);
    };

    const originalListen = proto.listen;
    proto.listen = function hardenedListen(...args) {
        const first = args[0];
        const looksLikePort = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first));
        if (looksLikePort) {
            if (Number.isInteger(portOverride) && portOverride >= 0) args[0] = portOverride;
            if (typeof args[1] !== 'string') args.splice(1, 0, host);
        }
        const server = originalListen.apply(this, args);
        server.once('listening', () => {
            const addr = server.address();
            const bound = addr && typeof addr === 'object' ? addr.address : String(addr);
            if (!isLoopbackHost(bound)) {
                console.warn(`[harden] 警告：服务监听在 ${bound}，局域网里的人都能访问，而且没有登录验证。`);
            }
        });
        return server;
    };

    if (!checksEnabled) {
        console.warn('[harden] SENKOU_HARDEN=off：只限制监听地址，请求检查已关闭');
    }
}

module.exports = {
    DEFAULT_HOST,
    hostnameOf,
    pathnameOf,
    isAllowedHost,
    isLoopbackHost,
    normalizeStaticPath,
    isBlockedStaticPath,
    checkRequest,
    install,
};

// 用 -r 预加载或被 require 时自动生效
install();
