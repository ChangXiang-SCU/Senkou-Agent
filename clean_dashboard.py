
import re

file_path = 'dashboard.html'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Target start of Canvas Integration
start_marker = "// ---- Canvas Integration ----"
# Target end of script (to ensure we wipe out all duplicates/dangling code)
end_marker = "</script>"

idx_start = content.find(start_marker)
idx_end = content.rfind(end_marker)

if idx_start == -1 or idx_end == -1:
    print("Could not find markers.")
    import sys; sys.exit(1)

# New JS Code (Clean)
# Note: I'm including the start_marker in the replacement to keep it, 
# and adding the invocation at the end.
js_code = """// ---- Canvas Integration ----
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
            const loading = document.getElementById('canvas-loading');
            const list = document.getElementById('canvas-list');
            const empty = document.getElementById('canvas-empty');
            
            loading.style.display = 'block';
            list.innerHTML = '';
            empty.style.display = 'none';

            try {
                // Fetch ICS deadlines
                const resICS = await fetch('/api/canvas/deadlines');
                if (!resICS.ok) throw new Error(`Server returned ${resICS.status}`);
                const dataICS = await resICS.json();

                // Fetch Full Assignments (if available)
                try {
                    const resFull = await fetch('/api/canvas/assignments');
                    if (resFull.ok) fullAssignments = await resFull.json();
                } catch (e) { console.log('No full assignments yet'); }
                
                loading.style.display = 'none';

                if (!dataICS.configured) {
                    toggleCanvasConfig();
                    return;
                }

                if (dataICS.deadlines.length === 0) {
                    empty.style.display = 'block';
                    return;
                }

                list.innerHTML = dataICS.deadlines.map(d => {
                    const due = new Date(d.due);
                    const now = new Date();
                    const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
                    let statusColor = 'var(--text-muted)';
                    if (diffDays < 0) statusColor = 'var(--text-muted)'; // Past
                    else if (diffDays <= 3) statusColor = '#ef4444'; // Urgent (Red)
                    else if (diffDays <= 7) statusColor = '#f59e0b'; // Soon (Amber)
                    else statusColor = '#22c55e'; // Safe (Green)

                    // Find matching full assignment
                    const match = fullAssignments.find(a => a.name === d.title || (a.name && d.title && a.name.includes(d.title)));
                    const hasDetails = !!match;

                    return `
                        <div class="card" style="padding:16px; min-height:auto;">
                            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${d.course}</div>
                            <div style="font-weight:600; margin-bottom:8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                                <a href="${d.url}" target="_blank" style="color:var(--text-primary); text-decoration:none;">${d.title}</a>
                            </div>
                            <div style="font-size:12px; display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                <span style="color:${statusColor}; font-weight:500;">
                                    ${diffDays < 0 ? 'Overdue' : (diffDays === 0 ? 'Due Today' : `In ${diffDays} days`)}
                                </span>
                                <span style="color:var(--text-muted);">${due.toLocaleDateString()} ${due.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                            </div>
                            <div style="display:flex; gap:8px;">
                                ${hasDetails ? `<button onclick="openAssignmentModal('${match.id}')" style="font-size:11px; padding:4px 8px; background:var(--bg-tertiary); border:1px solid var(--border-color); color:var(--text-primary); border-radius:4px; cursor:pointer;">📄 View Details</button>` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                loading.style.display = 'none';
                list.innerHTML = `<div style="color:#ef4444;">Error loading deadlines: ${e.message}</div>`;
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
        
        window.onclick = function(event) {
            const modal = document.getElementById('assignmentModal');
            if (event.target == modal) {
                modal.style.display = "none";
            }
        }

        loadCanvasDeadlines();
        """

# Replace content
new_content = content[:idx_start] + js_code + "\n        " + content[idx_end:]

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Replaced JS block cleanly.")
