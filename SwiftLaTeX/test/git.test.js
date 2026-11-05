'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { git, redactSecrets, isCommitHash, isSafeRemoteUrl, withToken } = require('../lib/git');

function hasGit() {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('redactSecrets 去掉 URL 里的 token', () => {
    assert.equal(
        redactSecrets('Command failed: git push https://ghp_abc123@github.com/u/r.git'),
        'Command failed: git push https://***@github.com/u/r.git'
    );
    assert.equal(redactSecrets('https://git:olp_xyz@git.overleaf.com/123'), 'https://***@git.overleaf.com/123');
    assert.equal(redactSecrets('no secrets here'), 'no secrets here');
    assert.equal(redactSecrets(undefined), undefined);
});

test('isCommitHash 只认十六进制 hash', () => {
    assert.equal(isCommitHash('a1b2c3d'), true);
    assert.equal(isCommitHash('A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2'), true);
    assert.equal(isCommitHash('HEAD'), false);
    assert.equal(isCommitHash('abc;rm -rf ~'), false);
    assert.equal(isCommitHash('$(whoami)'), false);
    assert.equal(isCommitHash('--output=/tmp/x'), false);
    assert.equal(isCommitHash(undefined), false);
});

test('isSafeRemoteUrl 只接受 http(s)', () => {
    assert.equal(isSafeRemoteUrl('https://git.overleaf.com/6a0c0abc'), true);
    assert.equal(isSafeRemoteUrl('https://github.com/u/r.git'), true);
    assert.equal(isSafeRemoteUrl('--upload-pack=touch /tmp/pwned'), false);
    assert.equal(isSafeRemoteUrl('ext::sh -c touch% /tmp/pwned'), false);
    assert.equal(isSafeRemoteUrl('file:///etc'), false);
    assert.equal(isSafeRemoteUrl('https://a.com/x" && calc'), false);
    assert.equal(isSafeRemoteUrl(''), false);
});

test('withToken 和原逻辑一致', () => {
    assert.equal(withToken('https://github.com/u/r.git', 'TKN'), 'https://TKN@github.com/u/r.git');
    assert.equal(withToken('https://github.com/u/r.git', ''), 'https://github.com/u/r.git');
});

test('git() 拒绝非数组参数', () => {
    assert.throws(() => git('status'), TypeError);
    assert.throws(() => git(['commit', '-m', 42]), TypeError);
});

test('git() 提交信息里的 $x$、反引号、$(...) 原样保存，不被 shell 执行', { skip: !hasGit() && 'git 不可用' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senkou-git-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const marker = path.join(dir, 'pwned');
    const opts = { cwd: dir };
    git(['init', '-q'], opts);
    git(['config', 'user.email', 'test@example.com'], opts);
    git(['config', 'user.name', 'Test'], opts);
    fs.writeFileSync(path.join(dir, 'main.tex'), '\\documentclass{article}');
    git(['add', '-A'], opts);

    const message = `Fix $\\alpha$ "quote" \`touch ${marker}\` $(touch ${marker})`;
    git(['commit', '-q', '-m', message], opts);

    assert.equal(git(['log', '-1', '--format=%B'], opts).trim(), message);
    assert.equal(fs.existsSync(marker), false);
});

test('git() 报错信息里的 token 被打码', { skip: !hasGit() && 'git 不可用' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senkou-git-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    git(['init', '-q'], { cwd: dir });
    let err;
    try {
        // 不存在的远程，必定失败；127.0.0.1:9 不会真的发出去
        git(['push', 'https://SECRET_TOKEN@127.0.0.1:9/x.git'], { cwd: dir, stdio: 'pipe', timeout: 15000 });
    } catch (e) {
        err = e;
    }
    assert.ok(err, '应该失败');
    assert.doesNotMatch(err.message, /SECRET_TOKEN/);
    assert.doesNotMatch(String(err.stderr || ''), /SECRET_TOKEN/);
});
