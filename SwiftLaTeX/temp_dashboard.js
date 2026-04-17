
        // Emergency Error Handler
        window.onerror = function (msg, url, line, col, error) {
            const log = document.createElement('div');
            log.style.cssText = 'position:fixed; top:10px; left:10px; right:10px; background:#ef4444; color:white; padding:12px; z-index:9999; border-radius:8px; font-family:monospace; box-shadow:0 4px 6px rgba(0,0,0,0.3);';
            log.textContent = `JS Error: ${msg} (Line ${line})`;
            document.body.appendChild(log);
            return false;
        };

        async function fetchProjects() {
            try {
                console.log('Fetching projects...');
                const res = await fetch('/api/projects');
                const projects = await res.json();
                renderProjects(projects);
            } catch (err) {
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

            for (const p of projects) {
                const card = document.createElement('div');
                card.className = 'card';

                // Fix: Use correct properties from project object
                const projectId = p.id;
                const projectName = p.name;
                const lastModified = new Date(p.lastModified);

                card.id = `card-${projectId}`;
                card.onclick = () => openProjectDetails(p);

                card.innerHTML = `
                <div class="card-header">
                    <div>
                        <div class="project-name">${projectName}</div>
                        <div class="project-meta">Last modified: ${lastModified.toLocaleDateString()}</div>
                    </div>
                    <div class="tag">LaTeX</div>
                </div>

                <div class="stats-grid">
                    <div class="stat-item">
                        <div class="stat-value" id="wc-${projectId}">-</div>
                        <div class="stat-label">Words</div>
                    </div>
                     <div class="stat-item">
                        <div class="stat-value" id="pg-${projectId}">-</div>
                        <div class="stat-label">Pages</div>
                    </div>
                </div>

                <div class="progress-section">
                    <div class="progress-label">
                        <span>Research Progress</span>
                        <span id="prog-txt-${projectId}">0%</span>
                    </div>
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill" id="prog-bar-${projectId}" style="width: 0%"></div>
                    </div>
                </div>
            `;
                grid.appendChild(card);

                // Lazy load analysis data
                loadAnalysisData(projectId, card);
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
            const card = document.getElementById(`card-${projectId}`);
            let details = null;
            if (card && card.dataset.details) {
                details = JSON.parse(card.dataset.details);
            }

            let html = `
            <h3>Paper Statistics</h3>
            <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr);">
                <div class="stat-item"><div class="stat-value">${details ? details.wordCount : '-'}</div><div class="stat-label">Words</div></div>
                <div class="stat-item"><div class="stat-value">${details ? details.pages : '-'}</div><div class="stat-label">Pages</div></div>
                <div class="stat-item"><div class="stat-value">${details && details.sections ? details.sections.length : '-'}</div><div class="stat-label">Sections</div></div>
                <div class="stat-item"><div class="stat-value">PDF</div><div class="stat-label">Format</div></div>
            </div>
        `;

            if (details && details.sections && details.sections.length > 0) {
                html += `<h3>Section Breakdown</h3><ul class="section-list">`;
                details.sections.forEach(sec => {
                    html += `
                    <li class="section-item">
                        <div class="section-title">${sec.title}</div>
                        <div class="section-preview">Page ${sec.page || 1}</div>
                    </li>
                `;
                });
                html += `</ul>`;
            } else {
                html += `<p style="color: var(--text-muted); text-align: center; margin-top: 24px;">No section details available. Try compiling the PDF first.</p>`;
            }

            // Add Todo List
            html += `<h3>Research Tasks</h3><div id="modalTodoList">Loading tasks...</div>`;

            body.innerHTML = html;
            modal.classList.add('active');

            // Fetch Todos for modal
            fetch(`/api/todos/${projectId}`).then(r => r.json()).then(todos => {
                const listDiv = document.getElementById('modalTodoList');
                if (todos && todos.todos && todos.todos.length > 0) {
                    let todoHtml = '<ul class="section-list">';
                    todos.todos.forEach(t => {
                        todoHtml += `
                        <li class="section-item" style="justify-content: flex-start; gap: 12px; opacity: ${t.status === 'completed' ? 0.5 : 1}">
                            <span>${t.status === 'completed' ? '✅' : '⬜'}</span>
                            <span>${t.text}</span>
                        </li>
                    `;
                    });
                    todoHtml += '</ul>';
                    listDiv.innerHTML = todoHtml;
                } else {
                    listDiv.innerHTML = '<p style="color: var(--text-muted);">No tasks tracked.</p>';
                }
            });
        }

        function closeModal() {
            document.getElementById('detailModal').classList.remove('active');
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
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (!res.ok) throw new Error('Failed to fetch repos');

                const repos = await res.json();

                if (repos.length === 0) {
                    listDiv.innerHTML = '<div class="loading">No repositories found.</div>';
                    return;
                }

                let html = '<ul class="section-list">';
                repos.forEach(repo => {
                    html += `
                        <li class="section-item" style="align-items: center;">
                            <div style="flex: 1;">
                                <div class="section-title" style="display: flex; gap: 8px; align-items: center;">
                                    ${repo.private ? '🔒' : 'PUBLIC'} 
                                    ${repo.name}
                                </div>
                                <div class="section-preview">${repo.description || 'No description'}</div>
                            </div>
                            <button onclick="cloneRepo('${repo.clone_url}', '${repo.name}')" style="background: var(--bg-hover); border: 1px solid var(--border-color); color: var(--text-primary); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                Import
                            </button>
                        </li>
                    `;
                });
                html += '</ul>';
                listDiv.innerHTML = html;

            } catch (err) {
                console.error(err);
                listDiv.innerHTML = `<div class="loading" style="color: var(--accent-red);">Error: ${err.message}. Check your token.</div>`;
            }
        }

        async function cloneRepo(url, name) {
            if (!confirm(`Import ${name} to local projects?`)) return;

            const token = localStorage.getItem('github_pat');
            const btn = event.target;
            const originalText = btn.innerText;
            btn.innerText = 'Importing...';
            btn.disabled = true;

            try {
                const res = await fetch('/api/github/clone', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
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
                    }, 1000);
                } else {
                    throw new Error(data.error || 'Clone failed');
                }
            } catch (err) {
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

        fetchProjects();
    