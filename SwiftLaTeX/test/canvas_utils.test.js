'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../scrapers/canvas_utils');

test('resolveBaseUrl：优先级 环境变量 > canvas_base_url > 命令行 > canvas_ics_url', () => {
    const ics = 'https://canvas.school-a.edu/feeds/calendars/user_abc.ics';
    assert.deepEqual(
        u.resolveBaseUrl({ env: { CANVAS_BASE_URL: 'https://canvas.env.edu/' }, config: { canvas_base_url: 'https://canvas.cfg.edu' }, argv: [ics] }),
        { baseUrl: 'https://canvas.env.edu', source: 'CANVAS_BASE_URL 环境变量' }
    );
    assert.equal(u.resolveBaseUrl({ config: { canvas_base_url: 'https://canvas.cfg.edu/courses' }, argv: [ics] }).baseUrl, 'https://canvas.cfg.edu');
    assert.equal(u.resolveBaseUrl({ argv: [ics] }).baseUrl, 'https://canvas.school-a.edu');
    assert.equal(u.resolveBaseUrl({ config: { canvas_ics_url: ics } }).baseUrl, 'https://canvas.school-a.edu');
});

test('resolveBaseUrl：什么都没配时返回 null，不再默认 Cornell', () => {
    assert.deepEqual(u.resolveBaseUrl({}), { baseUrl: null, source: null });
    assert.equal(u.resolveBaseUrl({ argv: [''] }).baseUrl, null);
    // server.js 没配置时会传这个占位值
    assert.equal(u.resolveBaseUrl({ argv: ['https://canvas.instructure.com'] }).baseUrl, null);
    // 但用户自己明确填 instructure 是可以的
    assert.equal(u.resolveBaseUrl({ config: { canvas_base_url: 'https://canvas.instructure.com' } }).baseUrl, 'https://canvas.instructure.com');
});

test('resolveBaseUrl：非法值跳过', () => {
    assert.equal(u.resolveBaseUrl({ config: { canvas_base_url: 'not a url', canvas_ics_url: 'https://c.edu/x.ics' } }).baseUrl, 'https://c.edu');
    assert.equal(u.resolveBaseUrl({ config: { canvas_base_url: 'javascript:alert(1)' } }).baseUrl, null);
    assert.equal(u.resolveBaseUrl({ config: { canvas_base_url: 'file:///etc/passwd' } }).baseUrl, null);
    assert.equal(u.resolveBaseUrl({ config: { canvas_base_url: 42 } }).baseUrl, null);
});

test('爬虫源码里不再写死 Cornell', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scrapers', 'canvas_scraper.js'), 'utf8');
    assert.doesNotMatch(src, /cornell/i);
});

test('safeName：英文名和原规则结果一致，中文名不再被清空', () => {
    const oldRule = s => s.replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
    for (const s of ['CS 5382: HCI', 'HW #3 (Due 3/4)', 'INFO6120-Final_Project', '  Lab 1  ']) {
        assert.equal(u.safeName(s), oldRule(s), s);
    }
    assert.equal(u.safeName('人机交互导论 HCI'), '人机交互导论 HCI');
    assert.equal(u.safeName('作业一：用户调研'), '作业一用户调研');
});

test('safeName：清空后用后备名，挡掉路径符号和 Windows 保留名', () => {
    assert.equal(u.safeName('', 'course_42'), 'course_42');
    assert.equal(u.safeName('!!!', 'assignment_7'), 'assignment_7');
    assert.equal(u.safeName('../../etc'), 'etc');
    assert.equal(u.safeName('..\\..\\Windows'), 'Windows');
    assert.equal(u.safeName('CON'), '_CON');
    assert.equal(u.safeName('a'.repeat(300)).length, 150);
});

test('safeFileName：保留扩展名，中文文件名不再变成 ".pdf"', () => {
    assert.equal(u.safeFileName('report.pdf'), 'report.pdf');
    assert.equal(u.safeFileName('作业要求.pdf'), '作业要求.pdf');
    assert.equal(u.safeFileName('Lecture 3 - Slides.PPTX'), 'Lecture 3 - Slides.pptx');
    assert.equal(u.safeFileName('archive.tar.gz'), 'archivetar.gz');
    assert.equal(u.safeFileName('README'), 'README');
    assert.equal(u.safeFileName('.pdf', 'file_0'), 'file_0.pdf');
    assert.equal(u.safeFileName('../../evil.sh'), 'evil.sh');
    assert.equal(u.safeFileName('a./../../x'), 'x');
    assert.equal(u.safeFileName(''), 'file');
});

test('filenameFromContentDisposition：优先 filename*（UTF-8 中文名）', () => {
    assert.equal(
        u.filenameFromContentDisposition(`attachment; filename="???.pdf"; filename*=UTF-8''%E4%BD%9C%E4%B8%9A%E8%A6%81%E6%B1%82.pdf`),
        '作业要求.pdf'
    );
    assert.equal(u.filenameFromContentDisposition('attachment; filename="Syllabus Fall.pdf"'), 'Syllabus Fall.pdf');
    assert.equal(u.filenameFromContentDisposition('attachment; filename=notes.txt'), 'notes.txt');
    assert.equal(u.filenameFromContentDisposition('attachment; filename="100%.pdf"'), '100%.pdf'); // 原代码这里 decodeURIComponent 会抛错
    assert.equal(u.filenameFromContentDisposition('inline'), null);
    assert.equal(u.filenameFromContentDisposition(undefined), null);
});

test('filenameFromUrl / toDownloadUrl / isSameOrigin', () => {
    assert.equal(u.filenameFromUrl('https://c.edu/courses/1/files/99/download?download_frd=1'), '99');
    assert.equal(u.filenameFromUrl('https://c.edu/files/%E8%AF%BE%E4%BB%B6.pdf'), '课件.pdf');
    assert.equal(u.toDownloadUrl('https://c.edu/courses/1/files/99?wrap=1'), 'https://c.edu/courses/1/files/99/download?download_frd=1');
    assert.equal(u.toDownloadUrl('https://c.edu/courses/1/files/99/download'), 'https://c.edu/courses/1/files/99/download');
    assert.equal(u.isSameOrigin('https://c.edu/files/1', 'https://c.edu'), true);
    assert.equal(u.isSameOrigin('https://evil.com/files/1', 'https://c.edu'), false);
    assert.equal(u.isSameOrigin('https://c.edu.evil.com/files/1', 'https://c.edu'), false);
    assert.equal(u.isSameOrigin('/courses/1/files/2', 'https://c.edu'), false);
});

test('isCurrentCourse：有学期日期时按日期判断（不依赖英文学期名）', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const course = (term, extra = {}) => ({ name: 'Course', term, ...extra });
    assert.equal(u.isCurrentCourse(course({ name: '2026-27 秋季学期', start_at: '2026-09-01', end_at: '2026-12-31' }), now), true);
    assert.equal(u.isCurrentCourse(course({ name: '2025-26 春季学期', start_at: '2026-02-01', end_at: '2026-06-30' }), now), false);
    // 开学前 30 天内
    assert.equal(u.isCurrentCourse(course({ name: 'Spring', start_at: '2026-11-25', end_at: '2027-05-01' }), now), true);
    // 名字像本学期但日期早就结束了
    assert.equal(u.isCurrentCourse(course({ name: 'Fall 2026', start_at: '2025-09-01', end_at: '2025-12-20' }), now), false);
    // 课程自己的日期也算
    assert.equal(u.isCurrentCourse(course({ name: 'Default Term' }, { start_at: '2026-08-20', end_at: '2026-12-15' }), now), true);
});

test('isCurrentCourse：没有日期时保留原来的学期名 / 创建时间判断', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    assert.equal(u.isCurrentCourse({ name: 'INFO 6120', term: { name: 'Fall 2026' } }, now), true);
    assert.equal(u.isCurrentCourse({ name: 'CS 5382 FA26', term: { name: 'Default Term' } }, now), true);
    assert.equal(u.isCurrentCourse({ name: 'Old', term: { name: 'Spring 2025' }, created_at: '2025-01-01' }, now), false);
    assert.equal(u.isCurrentCourse({ name: 'New', term: { name: 'Default Term' }, created_at: '2026-08-01' }, now), true);
    assert.equal(u.isCurrentCourse({ term: { name: 'Fall 2026' } }, now), false);
    assert.equal(u.isCurrentCourse(null, now), false);
});

test('resolveProjectsBase 和 server.js 选同一个目录', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'senkou-canvas-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const app = path.join(root, 'SwiftLaTeX');
    fs.mkdirSync(app);
    assert.equal(u.resolveProjectsBase(app), path.join(app, 'projects'));
    fs.mkdirSync(path.join(root, 'projects'));
    assert.equal(u.resolveProjectsBase(app), path.join(root, 'projects'));
});

test('htmlDocument：标题转义、带 charset 和禁脚本 CSP', () => {
    const html = u.htmlDocument('<img src=x onerror=alert(1)>', '<p>body</p>');
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /script-src 'none'/);
    assert.match(html, /<title>&lt;img src=x onerror=alert\(1\)&gt;<\/title>/);
    assert.match(html, /<p>body<\/p>/);
});
