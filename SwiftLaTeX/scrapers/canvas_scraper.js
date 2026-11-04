const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
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
} = require('./canvas_utils');

const APP_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(APP_DIR, 'data', 'canvas');
const SESSION_FILE = path.join(__dirname, 'session.json');
const PROJECTS_BASE = resolveProjectsBase(APP_DIR);

// 学校 Canvas 地址：CANVAS_BASE_URL > config.json 的 canvas_base_url > 命令行传入的 ICS 地址 > canvas_ics_url
const { baseUrl, source } = resolveBaseUrl({
    argv: process.argv.slice(2),
    env: process.env,
    config: readConfig(path.join(APP_DIR, 'config.json')),
});

if (!baseUrl) {
    console.error('没有配置 Canvas 地址。请在 config.json 里填 canvas_base_url（例如 "https://canvas.你的学校.edu"），');
    console.error('或填 canvas_ics_url（Canvas → 日历 → 日历订阅 里的链接），或设置环境变量 CANVAS_BASE_URL。');
    process.exit(1);
}

console.log(`Target Canvas URL: ${baseUrl} (from ${source})`);

(async () => {
    // Ensure directories exist
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(PROJECTS_BASE)) fs.mkdirSync(PROJECTS_BASE, { recursive: true });

    console.log('Launching browser...');
    // 默认弹出可见浏览器让用户自己登录（学校 SSO / 二次验证）；已保存登录态时可设 CANVAS_HEADLESS=1 后台跑
    const browser = await chromium.launch({ headless: process.env.CANVAS_HEADLESS === '1' });
    let context;

    if (fs.existsSync(SESSION_FILE)) {
        console.log('Loading saved session...');
        context = await browser.newContext({ storageState: SESSION_FILE });
    } else {
        context = await browser.newContext();
    }

    const page = await context.newPage();

    console.log('Navigating to Canvas...');
    try {
        await page.goto(baseUrl);
    } catch (e) {
        console.error('Failed to navigate:', e);
        await browser.close();
        process.exit(1);
    }

    console.log('Please login if needed... (Waiting up to 5 mins for #global_nav_profile_link)');
    try {
        await page.waitForSelector('#global_nav_profile_link', { timeout: 300000 });
        await page.waitForTimeout(2000);
    } catch (e) {
        console.error('Login timeout or error. Please try again.');
        await browser.close();
        process.exit(1);
    }

    console.log('Login successful! Saving session...');
    await context.storageState({ path: SESSION_FILE });

    const termInfo = getCurrentTermInfo();
    console.log(`Detecting courses for term: ${termInfo.name} or ${termInfo.short}`);

    const assignments = [];

    try {
        // Fetch active courses
        const coursesRes = await page.request.get(`${baseUrl}/api/v1/courses?per_page=100&include[]=term&enrollment_state=active`);
        if (!coursesRes.ok()) throw new Error(`Failed to fetch courses: ${coursesRes.status()}`);

        const allCourses = await coursesRes.json();
        const now = new Date();

        // 本学期课程：优先看 Canvas 返回的学期起止日期，没有日期再按学期名 / 创建时间判断
        const activeCourses = allCourses.filter(c => isCurrentCourse(c, now));

        console.log(`Found ${activeCourses.length} relevant courses for this semester.`);

        for (const course of activeCourses) {
            console.log(`Fetching assignments for: ${course.name} (${course.id})`);
            const cNameSafe = safeName(course.course_code || course.name, `course_${course.id}`);

            try {
                const assignRes = await page.request.get(`${baseUrl}/api/v1/courses/${course.id}/assignments?per_page=100`);
                if (!assignRes.ok()) continue;

                const courseAssignments = await assignRes.json();
                console.log(`  - Found ${courseAssignments.length} total assignments.`);

                for (const a of courseAssignments) {
                    assignments.push({
                        ...a,
                        course_name: course.name,
                        course_code: course.course_code
                    });

                    // Determine if assignment is pending (no submission, and not past due by a large margin)
                    const isFuture = a.due_at && new Date(a.due_at) > now;

                    // We generate folder if it's due in the future (or no due date)
                    if (isFuture || (!a.due_at)) {
                        const aNameSafe = safeName(a.name, `assignment_${a.id}`);
                        const assignDir = path.join(PROJECTS_BASE, cNameSafe, aNameSafe);

                        if (!fs.existsSync(assignDir)) {
                            fs.mkdirSync(assignDir, { recursive: true });
                            console.log(`  -> Created workspace: ${assignDir}`);
                        }

                        // Save Instructions
                        const instructionsPath = path.join(assignDir, 'instructions.html');
                        if (!fs.existsSync(instructionsPath)) {
                            const htmlContent = htmlDocument(a.name, `<h1>${escapeHtml(a.name)}</h1><p><strong>Due:</strong> ${escapeHtml(a.due_at || 'No date')}</p><hr/>${a.description || 'No description provided.'}`);
                            fs.writeFileSync(instructionsPath, htmlContent);
                        }

                        // Extract links for downloads
                        if (a.description) {
                            const fileLinks = [];
                            const externalLinks = [];

                            // Regex to find hrefs
                            const linkRegex = /href="([^"]+)"/g;
                            let match;
                            while ((match = linkRegex.exec(a.description)) !== null) {
                                const url = match[1];
                                if (url.includes('/files/')) {
                                    // Make sure it's a file by converting it to a direct download link
                                    fileLinks.push(toDownloadUrl(url));
                                } else if (url.includes('/pages/')) {
                                    // Internal Canvas page linked in description
                                    const pageUrlMatch = url.match(/\/courses\/\d+\/pages\/([^/?#]+)/);
                                    if (pageUrlMatch) {
                                        const pageSlug = pageUrlMatch[1];
                                        try {
                                            const pageRes = await page.request.get(`${baseUrl}/api/v1/courses/${course.id}/pages/${pageSlug}`);
                                            if (pageRes.ok()) {
                                                const pageData = await pageRes.json();
                                                const pagePath = path.join(assignDir, `LinkedPage_${safeName(pageData.title || pageSlug, 'page')}.html`);
                                                if (!fs.existsSync(pagePath)) {
                                                    const pageHtml = htmlDocument(pageData.title, `<h1>${escapeHtml(pageData.title)}</h1><hr/>${pageData.body || ''}`);
                                                    fs.writeFileSync(pagePath, pageHtml);
                                                    console.log(`    Downloaded linked page: ${pageData.title}`);

                                                    // Recursively look for file links in this page too
                                                    if (pageData.body) {
                                                        const innerRegex = /href="([^"]+)"/g;
                                                        let innerMatch;
                                                        while ((innerMatch = innerRegex.exec(pageData.body)) !== null) {
                                                            const innerUrl = innerMatch[1];
                                                            if (innerUrl.includes('/files/')) {
                                                                fileLinks.push(toDownloadUrl(innerUrl));
                                                            } else if (innerUrl.startsWith('http') && !innerUrl.includes(baseUrl)) {
                                                                externalLinks.push(innerUrl);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        } catch (e) { console.error(`Failed to fetch linked page ${pageSlug}`, e.message); }
                                    } else {
                                        externalLinks.push(url);
                                    }
                                } else if (url.startsWith('http') && !url.includes(baseUrl)) {
                                    externalLinks.push(url);
                                }
                            }

                            // Download files
                            for (let i = 0; i < fileLinks.length; i++) {
                                const fUrl = fileLinks[i];
                                try {
                                    const fullUrl = fUrl.startsWith('http') ? fUrl : `${baseUrl}${fUrl}`;
                                    // 只用 Canvas 登录态下载本校 Canvas 上的文件，别的网站的链接记到 external_links.md
                                    if (!isSameOrigin(fullUrl, baseUrl)) {
                                        externalLinks.push(fullUrl);
                                        continue;
                                    }
                                    const fRes = await page.request.get(fullUrl);
                                    if (fRes.ok()) {
                                        // 优先用 Content-Disposition（含 filename*=UTF-8'' 的中文名），没有再从 URL 取
                                        const cd = fRes.headers()['content-disposition'];
                                        const filename = filenameFromContentDisposition(cd) || filenameFromUrl(fullUrl) || `file_${i}`;

                                        const savePath = path.join(assignDir, safeFileName(filename, `file_${i}`));
                                        if (!fs.existsSync(savePath)) {
                                            const buf = await fRes.body();
                                            fs.writeFileSync(savePath, buf);
                                            console.log(`    Downloaded config: ${filename}`);
                                        }
                                    }
                                } catch (e) {
                                    console.error(`    Failed to download ${fUrl}`);
                                }
                            }

                            // Save external links
                            if (externalLinks.length > 0) {
                                const extPath = path.join(assignDir, 'external_links.md');
                                if (!fs.existsSync(extPath)) {
                                    let content = '# External Resources\n\nThe following resources could not be automatically downloaded. Please review them manually:\n\n';
                                    // Deduplicate
                                    const uniqueLinks = [...new Set(externalLinks)];
                                    uniqueLinks.forEach(link => {
                                        content += `- [${link}](${link})\n`;
                                    });
                                    fs.writeFileSync(extPath, content);
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`  - Error fetching assignments:`, err.message);
            }
        }

        // Save global assignments list
        const outFile = path.join(OUTPUT_DIR, 'assignments.json');
        fs.writeFileSync(outFile, JSON.stringify(assignments, null, 2));
        console.log(`Successfully saved ${assignments.length} assignments to ${outFile}`);

    } catch (err) {
        console.error('Scraping process failed:', err);
        process.exit(1);
    }

    console.log('Closing browser...');
    await browser.close();
})();
