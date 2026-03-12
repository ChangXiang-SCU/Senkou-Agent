const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const icsUrl = process.argv[2];
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'canvas');
const SESSION_FILE = path.join(__dirname, 'session.json');
const PROJECTS_BASE = path.resolve(__dirname, '..', '..', 'projects');

// Extract base URL from ICS URL if provided, otherwise default to Cornell
let baseUrl = 'https://canvas.cornell.edu';
if (icsUrl && icsUrl.startsWith('http')) {
    try {
        const u = new URL(icsUrl);
        baseUrl = `${u.protocol}//${u.host}`;
    } catch (e) {
        console.error('Invalid ICS URL, using default base URL');
    }
}

console.log(`Target Canvas URL: ${baseUrl}`);

// Helper to get current term info
function getCurrentTermInfo() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    let name = '';
    let short = '';
    if (month <= 5) { name = `Spring ${year}`; short = `SP${year.toString().slice(-2)}`; }
    else if (month <= 8) { name = `Summer ${year}`; short = `SU${year.toString().slice(-2)}`; }
    else { name = `Fall ${year}`; short = `FA${year.toString().slice(-2)}`; }
    return { name, short };
}

(async () => {
    // Ensure directories exist
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(PROJECTS_BASE)) fs.mkdirSync(PROJECTS_BASE, { recursive: true });

    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: false }); // Headless: false so user sees login
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

        // Filter courses dynamically based on current semester
        const activeCourses = allCourses.filter(c => {
            if (!c.name) return false;
            const tName = c.term ? c.term.name || '' : '';
            const cName = c.name || '';

            // Check term name or course name
            if (tName.includes(termInfo.name) || cName.includes(termInfo.name) || cName.includes(termInfo.short)) return true;

            // Fallback: check creation date (within last 5 months)
            if (c.created_at) {
                const created = new Date(c.created_at);
                const diffMonths = (now - created) / (1000 * 60 * 60 * 24 * 30);
                if (diffMonths <= 5) return true;
            }
            return false;
        });

        console.log(`Found ${activeCourses.length} relevant courses for this semester.`);

        const safeName = (str) => str.replace(/[^a-zA-Z0-9_\- ]/g, '').trim();

        for (const course of activeCourses) {
            console.log(`Fetching assignments for: ${course.name} (${course.id})`);
            const cNameSafe = safeName(course.course_code || course.name);

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
                        const aNameSafe = safeName(a.name);
                        const assignDir = path.join(PROJECTS_BASE, cNameSafe, aNameSafe);

                        if (!fs.existsSync(assignDir)) {
                            fs.mkdirSync(assignDir, { recursive: true });
                            console.log(`  -> Created workspace: ${assignDir}`);
                        }

                        // Save Instructions
                        const instructionsPath = path.join(assignDir, 'instructions.html');
                        if (!fs.existsSync(instructionsPath)) {
                            const htmlContent = `<h1>${a.name}</h1><p><strong>Due:</strong> ${a.due_at || 'No date'}</p><hr/>${a.description || 'No description provided.'}`;
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
                                    let downloadUrl = url;
                                    if (!downloadUrl.includes('download')) {
                                        downloadUrl = downloadUrl.split('?')[0] + '/download?download_frd=1';
                                    }
                                    fileLinks.push(downloadUrl);
                                } else if (url.includes('/pages/')) {
                                    // Internal Canvas page linked in description
                                    const pageUrlMatch = url.match(/\/courses\/\d+\/pages\/([^/?#]+)/);
                                    if (pageUrlMatch) {
                                        const pageSlug = pageUrlMatch[1];
                                        try {
                                            const pageRes = await page.request.get(`${baseUrl}/api/v1/courses/${course.id}/pages/${pageSlug}`);
                                            if (pageRes.ok()) {
                                                const pageData = await pageRes.json();
                                                const pagePath = path.join(assignDir, `LinkedPage_${safeName(pageData.title || pageSlug)}.html`);
                                                if (!fs.existsSync(pagePath)) {
                                                    const pageHtml = `<h1>${pageData.title}</h1><hr/>${pageData.body}`;
                                                    fs.writeFileSync(pagePath, pageHtml);
                                                    console.log(`    Downloaded linked page: ${pageData.title}`);

                                                    // Recursively look for file links in this page too
                                                    if (pageData.body) {
                                                        const innerRegex = /href="([^"]+)"/g;
                                                        let innerMatch;
                                                        while ((innerMatch = innerRegex.exec(pageData.body)) !== null) {
                                                            const innerUrl = innerMatch[1];
                                                            if (innerUrl.includes('/files/')) {
                                                                let dUrl = innerUrl;
                                                                if (!dUrl.includes('download')) dUrl = dUrl.split('?')[0] + '/download?download_frd=1';
                                                                fileLinks.push(dUrl);
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
                                    const fRes = await page.request.get(fullUrl);
                                    if (fRes.ok()) {
                                        let filename = 'downloaded_file';

                                        // Attempt to get filename from URL first before falling back to index
                                        const urlParts = fullUrl.split(/[?#]/)[0].split('/');
                                        let urlName = urlParts[urlParts.length - 1] || '';
                                        if (urlName === 'download') urlName = urlParts[urlParts.length - 2] || '';

                                        const cd = fRes.headers()['content-disposition'];
                                        if (cd && cd.includes('filename=')) {
                                            const fnMatch = cd.match(/filename="?([^";]+)"?/);
                                            if (fnMatch) filename = fnMatch[1];
                                        } else {
                                            filename = urlName || `file_${i}`;
                                        }

                                        // clean filename of URL encoding artifacts
                                        filename = decodeURIComponent(filename);

                                        const savePath = path.join(assignDir, safeName(filename) + (filename.includes('.') ? '.' + filename.split('.').pop() : ''));
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
