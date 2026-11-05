'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// require 时会自动给 express 打补丁，下面的集成测试就是测打完补丁的行为
const harden = require('../lib/harden');
const express = require('express');

const { hostnameOf, isAllowedHost, isBlockedStaticPath, checkRequest } = harden;

test('hostnameOf 解析 Host 头', () => {
    assert.equal(hostnameOf('localhost:3000'), 'localhost');
    assert.equal(hostnameOf('LOCALHOST'), 'localhost');
    assert.equal(hostnameOf('[::1]:3000'), '::1');
    assert.equal(hostnameOf('127.0.0.1:3000'), '127.0.0.1');
    assert.equal(hostnameOf(''), '');
    assert.equal(hostnameOf(undefined), '');
});

test('isAllowedHost：本机名和 IP 放行，陌生域名拦截', () => {
    assert.equal(isAllowedHost('localhost:3000'), true);
    assert.equal(isAllowedHost('127.0.0.1:3000'), true);
    assert.equal(isAllowedHost('[::1]:3000'), true);
    assert.equal(isAllowedHost('192.168.1.20:3000'), true);
    assert.equal(isAllowedHost('app.localhost:3000'), true);
    assert.equal(isAllowedHost('evil.example.com:3000'), false);
    assert.equal(isAllowedHost('localhost.evil.com'), false);
    assert.equal(isAllowedHost(undefined), false);
    assert.equal(isAllowedHost('mypc.local:3000', ['mypc.local']), true);
});

test('静态黑名单：密钥和登录态文件拦住，包括 Windows 下的变体写法', () => {
    const blocked = [
        '/config.json',
        '/CONFIG.JSON',
        '/config.json.',
        '/config.json%20',
        '/config.json::$DATA',
        '/%63onfig.json',
        '/./config.json',
        '/css/../config.json',
        '/config.json.bak',
        '/scrapers/session.json',
        '/Scrapers/Session.json',
        '/scrapers%2fsession.json',
        '/scrapers\\session.json',
        '/data/library/references.json',
        '/data/canvas/assignments.json',
        '/projects/paper/main.tex',
        '/CONFIG~1.JSO',
        '/SCRAPE~1/SESSIO~1.JSO',
        '/PROJEC~1/paper/main.tex',
        '/%E0%A4%A', // 解码失败
    ];
    for (const p of blocked) assert.equal(isBlockedStaticPath(p), true, p);

    const allowed = ['/', '/compile.html', '/dashboard.html', '/config.example.json', '/css/custom.css', '/lang/zh.json', '/engines/PdfTeXEngine.js', '/datasets.html'];
    for (const p of allowed) assert.equal(isBlockedStaticPath(p), false, p);
});

function req(method, url, headers = {}) {
    return { method, url, headers: { host: 'localhost:3000', ...headers } };
}

test('checkRequest：同源请求全部放行', () => {
    assert.equal(checkRequest(req('GET', '/compile.html')), null);
    assert.equal(checkRequest(req('GET', '/api/config', { 'sec-fetch-site': 'same-origin' })), null);
    assert.equal(checkRequest(req('POST', '/api/config', { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' })), null);
    assert.equal(checkRequest(req('PUT', '/api/file/abc', { origin: 'http://localhost:3000' })), null);
    // 命令行工具（curl、脚本）不带 Origin 和 Sec-Fetch-*
    assert.equal(checkRequest(req('POST', '/api/compile/abc')), null);
    // 地址栏直接打开
    assert.equal(checkRequest(req('GET', '/api/projects', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })), null);
});

test('checkRequest：DNS rebinding（Host 是攻击者域名）被拦', () => {
    assert.match(checkRequest(req('GET', '/api/config', { host: 'rebind.attacker.test:3000' })), /host/);
    assert.match(checkRequest(req('GET', '/config.example.json', { host: 'rebind.attacker.test:3000' })), /host/);
});

test('checkRequest：跨站调用 API 被拦（含跨站跳转触发 GET）', () => {
    assert.match(checkRequest(req('GET', '/api/git/diff/abc/HEAD', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })), /cross-site/);
    assert.match(checkRequest(req('GET', '/api/config', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })), /cross-site/);
    assert.match(checkRequest(req('POST', '/api/library/upload', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })), /cross-site/);
    // 本机其他端口的页面（如 localhost:8080）是 same-site，也要拦
    assert.match(checkRequest(req('POST', '/api/config', { 'sec-fetch-site': 'same-site', origin: 'http://localhost:8080' })), /cross-site/);
    // 大小写绕过：Express 路由默认大小写不敏感
    assert.match(checkRequest(req('GET', '/API/config', { 'sec-fetch-site': 'cross-site' })), /cross-site/);
});

test('checkRequest：OAuth 登录回跳放行', () => {
    const h = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
    assert.equal(checkRequest(req('GET', '/api/oauth/google/callback?code=x&state=y', h)), null);
    assert.equal(checkRequest(req('GET', '/api/oauth/openai/callback?code=x', h)), null);
    // 但不能借 OAuth 路径做跨站 POST
    assert.match(checkRequest(req('POST', '/api/oauth/google/callback', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })), /cross-site/);
});

test('checkRequest：没有 Sec-Fetch 头的老浏览器，跨源写操作看 Origin', () => {
    assert.match(checkRequest(req('POST', '/api/config', { origin: 'https://evil.example.com' })), /cross-origin/);
    assert.match(checkRequest(req('DELETE', '/api/projects/x', { origin: 'null' })), /cross-origin/);
    assert.match(checkRequest(req('PUT', '/api/file/x', { origin: 'not a url' })), /cross-origin/);
    assert.match(checkRequest(req('POST', '/api/config', { origin: 'http://localhost:8080' })), /cross-origin/);
});

test('checkRequest：静态黑名单只作用于非 API 路径', () => {
    assert.match(checkRequest(req('GET', '/config.json')), /not served/);
    assert.equal(checkRequest(req('GET', '/api/canvas/assignments')), null);
});

test('checkRequest：absolute-form 请求行不能绕过黑名单', () => {
    assert.match(checkRequest(req('GET', 'http://localhost:3000/config.json')), /not served/);
    assert.match(checkRequest(req('GET', 'http://localhost:3000/a/../scrapers/session.json')), /not served/);
    assert.match(checkRequest(req('GET', 'http://localhost:3000/api/config', { 'sec-fetch-site': 'cross-site' })), /cross-site/);
    assert.match(checkRequest(req('OPTIONS', '*')), /bad request/);
    assert.equal(checkRequest(req('GET', 'http://localhost:3000/compile.html')), null);
});

// ---- 集成测试：真实 express app + 静态目录 ----

function request(port, method, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', c => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        r.on('error', reject);
        r.end();
    });
}

test('集成：app.listen 默认只绑 127.0.0.1，敏感文件 403，正常页面 200', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'senkou-harden-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'config.json'), '{"anthropic_api_key":"SECRET"}');
    fs.writeFileSync(path.join(root, 'config.example.json'), '{"anthropic_api_key":""}');
    fs.writeFileSync(path.join(root, 'compile.html'), '<h1>ok</h1>');
    fs.mkdirSync(path.join(root, 'scrapers'));
    fs.writeFileSync(path.join(root, 'scrapers', 'session.json'), '{"cookies":["SECRET"]}');

    const app = express();
    app.use(express.json());
    app.use(express.static(root));
    app.post('/api/echo', (req, res) => res.json({ ok: true }));

    const server = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s));
    });
    t.after(() => server.close());

    assert.equal(server.address().address, '127.0.0.1');
    const { port } = server.address();
    const local = { host: `localhost:${port}` };

    assert.equal((await request(port, 'GET', '/compile.html', local)).status, 200);
    assert.equal((await request(port, 'GET', '/config.example.json', local)).status, 200);

    for (const p of ['/config.json', '/CONFIG.JSON', '/scrapers/session.json', '/%63onfig.json', `http://localhost:${port}/config.json`]) {
        const r = await request(port, 'GET', p, local);
        assert.equal(r.status, 403, p);
        assert.doesNotMatch(r.body, /SECRET/, p);
    }

    assert.equal((await request(port, 'GET', '/compile.html', { host: 'rebind.attacker.test' })).status, 403);
    assert.equal((await request(port, 'POST', '/api/echo', { ...local, origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await request(port, 'POST', '/api/echo', { ...local, origin: `http://localhost:${port}` })).status, 200);
});
