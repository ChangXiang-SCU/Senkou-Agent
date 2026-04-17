 // Emergency Error Handler

        window.onerror = function (msg, url, line, col, error) {
            const log = document.createElement('div');
            log.style.cssText = 'position:fixed; top:10px; left:10px; right:10px; background:#ef4444; color:white; padding:12px; z-index:9999; border-radius:8px; font-family:monospace; box-shadow:0 4px 6px rgba(0,0,0,0.3);';

            log.textContent = `JS Error: ${msg
                }

            (Line ${line
                })`;
            document.body.appendChild(log);
            return false;
        }

            ;

        async function fetchProjects() {
            try {
                console.log('Fetching projects...');
                const res = await fetch('/api/projects');
                const projects = await res.json();
                renderProjects(projects);
            }

            catch (err) {
                console.error(err);
                document.getElementById('projectGrid').innerHTML = '<div class="loading">Failed to load projects. Make sure server API is reachable.</div>';
            }
        }

        async function renderProjects(projects) {
            const grid = document.getElementById('projectGrid');
            grid.innerHTML = '';

            if (!projects || projects.length === 0) {
                grid.innerHTML = '<div class="loading">No projects found. Add a project folder in "projects".</div>';
                return;
            }

            // Group projects by top-level folder
            const groups = {};
            for (const p of projects) {
                let groupName = 'Local Projects';
                let displayName = p.name;
                if (p.name.includes('/')) {
                    const parts = p.name.split('/');
                    groupName = parts[0];
                    displayName = parts.slice(1).join('/');
                }
                if (!groups[groupName]) groups[groupName] = [];
                // add display name
                groups[groupName].push({ ...p, displayName });
            }

            // Render groups
            for (const [groupName, groupProjects] of Object.entries(groups)) {
                // Add group header
                const header = document.createElement('div');
                header.style.cssText = 'grid-column: 1 / -1; margin-top: 32px; margin-bottom: 12px; font-size: 20px; font-weight: 600; color: var(--text-primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; display: flex; align-items: center; gap: 8px;';
                header.innerHTML = `<span style="font-size: 24px;">📁</span> ${groupName}`;
                grid.appendChild(header);

                for (const p of groupProjects) {
                    const card = document.createElement('div');
                    card.className = 'card';
                    const projectId = p.id;
                    const projectName = p.displayName;
                    const lastModified = new Date(p.lastModified);
                    let typeTag = 'LaTeX';
                    let typeColor = 'var(--accent-blue)';
                    if (p.type === 'code') { typeTag = 'Code'; typeColor = '#f59e0b'; }
                    else if (p.type === 'workspace') { typeTag = 'Workspace'; typeColor = '#10b981'; }

                    card.id = `card-${projectId}`;
                    card.onclick = () => {
                        if (p.type === 'latex') {
                            openProjectDetails(p);
                        } else {
                            window.location.href = `compile.html?id=${projectId}`;
                        }
                    };

                    card.innerHTML = `
                        <div class="card-header">
                            <div>
                                <div class="project-name">${projectName}</div>
                                <div class="project-meta">Last modified: ${lastModified.toLocaleDateString()}</div>
                            </div>
                            <div class="tag" style="background-color: ${typeColor};">${typeTag}</div>
                        </div>
                        <div class="stats-grid">
                            <div class="stat-item"><div class="stat-value" id="wc-${projectId}">-</div><div class="stat-label">Words</div></div>
                            <div class="stat-item"><div class="stat-value" id="pg-${projectId}">-</div><div class="stat-label">Pages</div></div>
                        </div>
                        <div class="progress-section">
                            <div class="progress-label"><span>Research Progress</span><span id="prog-txt-${projectId}">0%</span></div>
                            <div class="progress-bar-bg"><div class="progress-bar-fill" id="prog-bar-${projectId}" style="width: 0%"></div></div>
                        </div>
                        <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
                            <button onclick="event.stopPropagation(); window.location.href='compile.html?id=${projectId}'" style="background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;">
                                Open IDE &rarr;
                            </button>
                        </div>
                    `;
                    grid.appendChild(card);

                    // Lazy load analysis data only for LaTeX
                    if (p.type === 'latex') {
                        loadAnalysisData(projectId, card);
                    } else {
                        const wcEl = card.querySelector(`#wc-${projectId}`);
                        const pgEl = card.querySelector(`#pg-${projectId}`);
                        if (wcEl) wcEl.innerText = 'N/A';
                        if (pgEl) pgEl.innerText = 'N/A';
                    }
                }
            }
        }

        async function loadAnalysisData(projectId, cardElement) {
            try {
                // 1. Load Todos
                fetch(`/api/todos/${projectId}`).then(r => r.json()).then(todoData => {
                    if (todoData) {
                        const progress = todoData.overallProgress || 0;
                        const txt = cardElement.querySelector(`#prog-txt-${projectId}`);
                        const bar = cardElement.querySelector(`#prog-bar-${projectId}`);
                        if (txt) txt.innerText = progress + '%';
                        if (bar) bar.style.width = progress + '%';
                    }
                }).catch(e => console.log('No todo data'));

                // 2. Analyze PDF text/stats
                const anaRes = await fetch(`/api/analyze-pdf/${projectId}`);
                const data = await anaRes.json();

                if (data && !data.error) {
                    const wc = data.wordCount ? (data.wordCount / 1000).toFixed(1) + 'k' : '-';
                    const wcEl = cardElement.querySelector(`#wc-${projectId}`);
                    const pgEl = cardElement.querySelector(`#pg-${projectId}`);

                    if (wcEl) wcEl.innerText = wc;
                    if (pgEl) pgEl.innerText = data.pages || '-';

                    // Store detailed data on element for modal
                    cardElement.dataset.details = JSON.stringify(data);
                }
            } catch (e) {
                console.error('Analysis failed', e);
            }
        }

        function openProjectDetails(project) {
            const projectId = project.id;
            const modal = document.getElementById('detailModal');
            const title = document.getElementById('modalTitle');
            const body = document.getElementById('modalBody');

            title.innerText = project.name;

            // Try to get stored details
            const card = document.getElementById(`card-${projectId
                }

                `);
            let details = null;

            if (card && card.dataset.details) {
                details = JSON.parse(card.dataset.details);
            }

            let html = ` <h3>Paper Statistics</h3><div class="stats-grid" style="grid-template-columns: repeat(4, 1fr);"><div class="stat-item"><div class="stat-value">${details ? details.wordCount : '-'
                }

            </div><div class="stat-label">Words</div></div><div class="stat-item"><div class="stat-value">${details ? details.pages : '-'
                }

            </div><div class="stat-label">Pages</div></div><div class="stat-item"><div class="stat-value">${details && details.sections ? details.sections.length : '-'
                }

            </div><div class="stat-label">Sections</div></div><div class="stat-item"><div class="stat-value">PDF</div><div class="stat-label">Format</div></div></div>`;

            if (details && details.sections && details.sections.length > 0) {
                html += `<h3>Section Breakdown</h3><ul class="section-list">`;

                details.sections.forEach(sec => {
                    html += ` <li class="section-item" > <div class="section-title" >${sec.title
                        }

                        </div> <div class="section-preview" >Page ${sec.page || 1
                        }

                        </div> </li> `;
                });
                html += `</ul>`;
            }

            else {
                html += `<p style="color: var(--text-muted); text-align: center; margin-top: 24px;">No section details available. Try compiling the PDF first.</p>`;
            }

            // Add Todo List
            html += `<h3>Research Tasks</h3><div id="modalTodoList">Loading tasks...</div>`;

            body.innerHTML = html;
            modal.classList.add('active');

            // Fetch Todos for modal
            fetch(`/api/todos/${projectId
                }

                `).then(r => r.json()).then(todos => {
                    const listDiv = document.getElementById('modalTodoList');

                    if (todos && todos.todos && todos.todos.length > 0) {
                        let todoHtml = '<ul class="section-list">';

                        todos.todos.forEach(t => {
                            todoHtml += ` <li class="section-item" style="justify-content: flex-start; gap: 12px; opacity: ${t.status === 'completed' ? 0.5 : 1}" > <span>${t.status === 'completed' ? '✅' : '⬜'
                                }

                                </span> <span>${t.text
                                }

                                </span> </li> `;
                        });
                        todoHtml += '</ul>';
                        listDiv.innerHTML = todoHtml;
                    }

                    else {
                        listDiv.innerHTML = '<p style="color: var(--text-muted);">No tasks tracked.</p>';
                    }
                });
        }

        function closeModal() {
            document.getElementById('detailModal').classList.remove('active');
        }

        // AI Settings Modal logic
        function openAiSettingsModal() {
            document.getElementById('aiSettingsModal').classList.add('active');
            // Fetch global config to populate the key if it exists
            fetch('/api/config')
                .then(r => r.json())
                .then(config => {
                    if (config.openai_api_key) {
                        document.getElementById('openaiApiKey').value = config.openai_api_key;
                    }
                })
                .catch(err => console.error('Error loading AI config:', err));
        }

        function closeAiSettingsModal() {
            document.getElementById('aiSettingsModal').classList.remove('active');
            document.getElementById('aiConfigResult').innerText = '';
        }

        async function saveAiConfig() {
            const key = document.getElementById('openaiApiKey').value.trim();
            const resDiv = document.getElementById('aiConfigResult');
            resDiv.innerText = 'Saving...';
            resDiv.style.color = 'var(--text-secondary)';

            try {
                const res = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ openai_api_key: key })
                });

                if (res.ok) {
                    resDiv.innerText = '✅ API Key saved successfully!';
                    resDiv.style.color = 'var(--accent-green)';
                    setTimeout(closeAiSettingsModal, 1500);
                } else {
                    resDiv.innerText = 'Failed to save API key.';
                    resDiv.style.color = 'var(--accent-red)';
                }
            } catch (err) {
                console.error(err);
                resDiv.innerText = 'Network error saving config.';
                resDiv.style.color = 'var(--accent-red)';
            }
        }

        // GitHub Integration
        function openGitHubModal() {
            const modal = document.getElementById('githubModal');
            modal.classList.add('active');

            // Auto-fill token if exists
            const token = localStorage.getItem('github_pat');

            if (token) {
                document.getElementById('githubToken').value = token;
            }
        }

        function closeGitHubModal() {
            document.getElementById('githubModal').classList.remove('active');
        }

        async function fetchGitHubRepos() {
            const token = document.getElementById('githubToken').value.trim();
            if (!token) return alert('Please enter a GitHub Token');

            // Save token locally
            localStorage.setItem('github_pat', token);

            const listDiv = document.getElementById('repoList');
            listDiv.innerHTML = '<div class="loading">Fetching repositories...</div>';

            try {
                const res = await fetch('/api/github/repos', {
                    headers: {
                        'Authorization': `Bearer ${token
                            }

                        `
                    }
                });

                if (!res.ok) throw new Error('Failed to fetch repos');

                const repos = await res.json();

                if (repos.length === 0) {
                    listDiv.innerHTML = '<div class="loading">No repositories found.</div>';
                    return;
                }

                let html = '<ul class="section-list">';

                repos.forEach(repo => {
                    html += ` <li class="section-item" style="align-items: center;" > <div style="flex: 1;" > <div class="section-title" style="display: flex; gap: 8px; align-items: center;" > ${repo.private ? '🔒' : 'PUBLIC'
                        }

                    ${repo.name
                        }

                    </div> <div class="section-preview" >${repo.description || 'No description'
                        }

                    </div> </div> <button onclick="cloneRepo('${repo.clone_url}', '${repo.name}')" style="background: var(--bg-hover); border: 1px solid var(--border-color); color: var(--text-primary); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;" > Import </button> </li> `;
                });
                html += '</ul>';
                listDiv.innerHTML = html;

            }

            catch (err) {
                console.error(err);

                listDiv.innerHTML = `<div class="loading" style="color: var(--accent-red);">Error: ${err.message
                    }

            . Check your token.</div>`;
            }
        }

        async function cloneRepo(url, name) {
            if (!confirm(`Import ${name
                }

                    to local projects?`)) return;

            const token = localStorage.getItem('github_pat');
            const btn = event.target;
            const originalText = btn.innerText;
            btn.innerText = 'Importing...';
            btn.disabled = true;

            try {
                const res = await fetch('/api/github/clone', {

                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }

                    ,
                    body: JSON.stringify({
                        token: token, // Used for git auth
                        repoUrl: url,
                        repoName: name
                    })
                });

                const data = await res.json();

                if (data.success) {
                    btn.innerText = 'Done!';
                    btn.style.background = 'var(--accent-green)';

                    setTimeout(() => {
                        closeGitHubModal();
                        fetchProjects(); // Refresh dashboard
                    }

                        , 1000);
                }

                else {
                    throw new Error(data.error || 'Clone failed');
                }
            }

            catch (err) {
                alert('Import failed: ' + err.message);
                btn.innerText = originalText;
                btn.disabled = false;
            }
        }

        window.onclick = function (event) {
            const modal = document.getElementById('detailModal');
            const ghModal = document.getElementById('githubModal');
            if (event.target == modal) closeModal();
            if (event.target == ghModal) closeGitHubModal();
        }

        // ---- Overleaf Import ----
        function openOverleafModal() {
            const token = localStorage.getItem('overleaf_token') || '';
            document.getElementById('overleafCloneToken').value = token;
            document.getElementById('overleafModal').style.display = 'flex';
        }

        async function cloneFromOverleaf() {
            const url = document.getElementById('overleafCloneUrl').value.trim();
            const token = document.getElementById('overleafCloneToken').value.trim();
            const name = document.getElementById('overleafProjectName').value.trim();
            const resultDiv = document.getElementById('overleafCloneResult');
            const btn = document.getElementById('overleafCloneBtn');

            if (!url || !token) {
                resultDiv.innerHTML = '<div style="color:#ef4444;">请填写 URL 和 Token</div>';
                return;
            }

            localStorage.setItem('overleaf_token', token);
            btn.disabled = true;
            btn.textContent = 'Cloning...';
            resultDiv.innerHTML = '<div style="color:#f59e0b;">正在从 Overleaf 克隆，请稍候...</div>';

            try {
                const res = await fetch('/api/overleaf/clone', {

                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }

                    ,
                    body: JSON.stringify({
                        overleafUrl: url, token, projectName: name
                    })
                });
                const data = await res.json();

                if (data.success) {
                    resultDiv.innerHTML = `<div style="color:#22c55e;">✓ 导入成功！项目名: ${data.name
                        }

            </div>`;

                    setTimeout(() => {
                        document.getElementById('overleafModal').style.display = 'none';
                        fetchProjects();
                    }

                        , 1500);
                }

                else {
                    resultDiv.innerHTML = `<div style="color:#ef4444;">✗ ${data.error
                        }

            </div>`;
                }
            }

            catch (e) {
                resultDiv.innerHTML = `<div style="color:#ef4444;">Error: ${e.message
                    }

            </div>`;
            }

            finally {
                btn.disabled = false;
                btn.textContent = 'Clone Project';
            }
        }

        // ---- Create New Project ----
        function openCreateProjectModal() {
            document.getElementById('newProjectName').value = '';
            document.getElementById('createProjectResult').innerHTML = '';
            document.getElementById('createProjectModal').style.display = 'flex';
            document.getElementById('newProjectName').focus();
        }

        async function createProject() {
            const name = document.getElementById('newProjectName').value.trim();
            const template = document.getElementById('newProjectTemplate').value;
            const resultDiv = document.getElementById('createProjectResult');
            const btn = document.getElementById('createProjectBtn');

            if (!name) {
                resultDiv.innerHTML = '<div style="color:#ef4444;">Please enter a project name</div>';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Creating...';

            try {
                const res = await fetch('/api/project/create', {

                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }

                    ,
                    body: JSON.stringify({
                        name, template
                    })
                });
                const data = await res.json();

                if (data.success) {
                    resultDiv.innerHTML = `<div style="color:#22c55e;">✓ Created ! Opening...</div>`;

                    setTimeout(() => {
                        window.location.href = `compile.html?project=${data.name
                            }

                    `;
                    }

                        , 1000);
                }

                else {
                    resultDiv.innerHTML = `<div style="color:#ef4444;">✗ ${data.error
                        }

            </div>`;
                    btn.disabled = false;
                    btn.textContent = 'Create Project';
                }
            }

            catch (e) {
                resultDiv.innerHTML = `<div style="color:#ef4444;">Error: ${e.message
                    }

            </div>`;
                btn.disabled = false;
                btn.textContent = 'Create Project';
            }
        }

        fetchProjects();


        // ---- Canvas Integration ----
        function toggleCanvasConfig() {
            const el = document.getElementById('canvas-config');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }

        async function saveCanvasConfig() {
            const url = document.getElementById('canvas-ics-url').value.trim();
            if (!url) return alert('Please enter a URL');

            try {
                const res = await fetch('/api/canvas/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ icsUrl: url })
                });
                const data = await res.json();
                if (data.success) {
                    toggleCanvasConfig();
                    loadCanvasDeadlines();
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (e) { alert('Error: ' + e.message); }
        }

        async function startScraper() {
            if (!confirm('This will open a browser window to scrape full assignment details. Please login to Canvas manually if prompted. Continue?')) return;

            try {
                const res = await fetch('/api/canvas/scrape', { method: 'POST' });
                const data = await res.json();
                alert(data.message);
            } catch (e) {
                alert('Error starting scraper: ' + e.message);
            }
        }

        let fullAssignments = [];

        async function loadCanvasDeadlines() {
            const statusEl = document.getElementById('canvas-status');
            if (statusEl) statusEl.innerText = 'Checking...';

            try {
                // Fetch ICS deadlines
                const resICS = await fetch('/api/canvas/deadlines');
                if (!resICS.ok) throw new Error(`Server returned ${resICS.status}`);
                const dataICS = await resICS.json();

                if (statusEl) {
                    if (!dataICS.configured) {
                        statusEl.innerText = 'Not configured';
                    } else {
                        const count = dataICS.deadlines.length;
                        statusEl.innerText = `Synced: ${count} upcoming deadline${count !== 1 ? 's' : ''}`;
                        statusEl.style.color = 'var(--accent-green)';
                    }
                }
            } catch (e) {
                if (statusEl) {
                    statusEl.innerText = 'Sync failed';
                    statusEl.style.color = 'var(--accent-red)';
                }
            }
        }

        function openAssignmentModal(id) {
            const assignment = fullAssignments.find(a => a.id == id);
            if (!assignment) return;

            document.getElementById('modalTitle').textContent = assignment.name;
            document.getElementById('modalMeta').textContent = `${assignment.course_name || 'Canvas'} | Due: ${assignment.due_at || 'No date'}`;
            document.getElementById('modalBody').innerHTML = assignment.description || '<p>No description available.</p>';
            document.getElementById('assignmentModal').style.display = 'flex';
        }

        function closeAssignmentModal() {
            document.getElementById('assignmentModal').style.display = 'none';
        }

        window.onclick = function (event) {
            const modal = document.getElementById('assignmentModal');
            if (event.target == modal) {
                modal.style.display = "none";
            }
        }

        loadCanvasDeadlines();

    