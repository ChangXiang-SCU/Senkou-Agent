'use strict';

// 路径包含判断：防止 ../ 穿越和 "/a/proj" 与 "/a/proj-other" 这类前缀误判。
// pathImpl 参数只给测试用（在 Linux 上验证 Windows 语义），平时不用传。

const path = require('path');

function isInside(base, target, pathImpl = path) {
    if (typeof base !== 'string' || typeof target !== 'string' || !base || !target) return false;
    const rel = pathImpl.relative(pathImpl.resolve(base), pathImpl.resolve(target));
    if (rel === '') return true;
    if (pathImpl.isAbsolute(rel)) return false; // Windows 跨盘符
    return rel !== '..' && !rel.startsWith('..' + pathImpl.sep);
}

// 在 base 下拼路径，越界返回 null
function resolveInside(base, segments, pathImpl = path) {
    const parts = Array.isArray(segments) ? segments : [segments];
    if (parts.some(s => typeof s !== 'string' || s.includes('\0'))) return null;
    const resolved = pathImpl.resolve(base, ...parts);
    return isInside(base, resolved, pathImpl) ? resolved : null;
}

module.exports = { isInside, resolveInside };
