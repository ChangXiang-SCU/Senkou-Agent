'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isInside, resolveInside } = require('../lib/paths');

test('isInside: 基本包含关系（posix）', () => {
    const p = path.posix;
    assert.equal(isInside('/srv/projects', '/srv/projects', p), true);
    assert.equal(isInside('/srv/projects', '/srv/projects/paper/main.tex', p), true);
    assert.equal(isInside('/srv/projects', '/srv/projects/../secret', p), false);
    assert.equal(isInside('/srv/projects', '/etc/passwd', p), false);
});

test('isInside: 前缀相同的兄弟目录不算在里面', () => {
    const p = path.posix;
    // 旧代码用 startsWith 判断，这种情况会误放行
    assert.equal(isInside('/srv/projects/paper', '/srv/projects/paper-private/x.tex', p), false);
});

test('isInside: 名字以 .. 开头的普通文件夹不误判', () => {
    const p = path.posix;
    assert.equal(isInside('/srv/projects', '/srv/projects/..notes/a.txt', p), true);
});

test('isInside: Windows 语义（大小写、跨盘符、反斜杠）', () => {
    const w = path.win32;
    assert.equal(isInside('C:\\Users\\Chang\\projects', 'c:\\users\\chang\\PROJECTS\\paper', w), true);
    assert.equal(isInside('C:\\Users\\Chang\\projects', 'D:\\projects\\paper', w), false);
    assert.equal(isInside('C:\\Users\\Chang\\projects', 'C:\\Users\\Chang\\projects\\..\\config.json', w), false);
});

test('isInside: 非法输入返回 false', () => {
    assert.equal(isInside('', '/a'), false);
    assert.equal(isInside('/a', undefined), false);
    assert.equal(isInside(null, '/a'), false);
});

test('resolveInside: 正常拼接与越界', () => {
    const p = path.posix;
    assert.equal(resolveInside('/srv/projects', 'paper/main.tex', p), '/srv/projects/paper/main.tex');
    assert.equal(resolveInside('/srv/projects', ['paper', 'sections/intro.tex'], p), '/srv/projects/paper/sections/intro.tex');
    assert.equal(resolveInside('/srv/projects', '../../etc/passwd', p), null);
    assert.equal(resolveInside('/srv/projects', '/etc/passwd', p), null);
    assert.equal(resolveInside('/srv/projects', 'a\0b', p), null);
    assert.equal(resolveInside('/srv/projects', 42, p), null);
});
