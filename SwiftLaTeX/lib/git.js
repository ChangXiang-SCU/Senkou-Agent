'use strict';

// 调 git 的安全封装：参数用数组传给 execFileSync，不经过 shell。
// 原来 server.js 用 execSync(`git ... "${用户输入}"`) 拼字符串，提交信息里写 $x$ 会被 shell 展开，
// 写 $(命令) 或 `命令` 会被执行；冲突文件名、commit hash、Overleaf URL 也都是这样拼进去的。

const { execFileSync } = require('child_process');

// 把 URL 里的 user:token@ 换成 ***@，避免报错信息把 token 带回前端或写进日志
function redactSecrets(text) {
    if (text === undefined || text === null) return text;
    return String(text).replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@');
}

function isCommitHash(value) {
    return typeof value === 'string' && /^[0-9a-f]{4,40}$/i.test(value);
}

// 只接受 http(s) 远程地址，挡住 "-u..." 这类会被 git 当成选项的输入，以及 ext::、file:// 等协议
function isSafeRemoteUrl(value) {
    if (typeof value !== 'string' || /\s/.test(value)) return false;
    try {
        const u = new URL(value);
        return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
        return false;
    }
}

// 和原代码一致：https://host/... -> https://TOKEN@host/...
function withToken(remoteUrl, token) {
    if (!token) return remoteUrl;
    return String(remoteUrl).replace(/^https:\/\//, `https://${token}@`);
}

function git(args, options = {}) {
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
        throw new TypeError('git(args): args 必须是字符串数组');
    }
    try {
        return execFileSync('git', args, { encoding: 'utf8', windowsHide: true, ...options });
    } catch (err) {
        err.message = redactSecrets(err.message);
        if (typeof err.stderr === 'string') err.stderr = redactSecrets(err.stderr);
        if (typeof err.stdout === 'string') err.stdout = redactSecrets(err.stdout);
        if (Array.isArray(err.spawnargs)) err.spawnargs = err.spawnargs.map(redactSecrets);
        throw err;
    }
}

module.exports = { git, redactSecrets, isCommitHash, isSafeRemoteUrl, withToken };
