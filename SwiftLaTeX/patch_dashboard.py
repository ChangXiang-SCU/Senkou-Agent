
import sys
import re

html_path = 'dashboard.html'
content = ""

# Try reading with utf-8
try:
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()
except:
    try:
        with open(html_path, 'r', encoding='utf-16') as f:
            content = f.read()
    except Exception as e:
        print(f"Error reading file: {e}")
        sys.exit(1)

print(f"Read {len(content)} chars.")

# 1. Insert Button
# Target: </h2></div><button onclick="toggleCanvasConfig()"
# We want to insert the new button BEFORE the existing config button
button_html = """
                    <div style="display:flex; gap:12px; align-items:center;">
                        <button onclick="startScraper()" style="background:var(--accent-purple); color:white; border:none; padding:6px 12px; border-radius:6px; font-size:13px; cursor:pointer; font-weight:500;">
                            🕷️ Fetch Full Content
                        </button>
                        <button onclick="toggleCanvasConfig()"
"""

# Regex to find the config button and its preceding close div
# The layout is: <div ...><h2>Canvas Deadlines</h2></div><button ...>
# We replace <button onclick="toggleCanvasConfig()" with our new block + button
# But we need to be careful not to double insert.

if "startScraper()" in content and "Fetch Full Content" in content:
    print("Button already seemingly present.")
else:
    # Find the config button
    # It might have attributes or style
    # simple string match might fail if attributes order differs
    # But usually it's stable.
    
    # Try to find the button tag start
    idx = content.find('onclick="toggleCanvasConfig()"')
    if idx != -1:
        # Find the start of the button tag
        btn_start = content.rfind('<button', 0, idx)
        if btn_start != -1:
            # Check if wrapped in our new div?
            # We want to wrap the config button AND the new button in a flex div
            
            # The original HTML was:
            # </div><button onclick="toggleCanvasConfig()"
            
            # We want to replace `<button onclick="toggleCanvasConfig()"` 
            # with the button_html which starts a div and contains the new button and the start of the old button
            
            # Let's target the exact string from previous view_file
            # <button onclick="toggleCanvasConfig()"
            target = '<button onclick="toggleCanvasConfig()"'
            
            # We replace it with:
            # <div style="..."> <button ...>Fetch...</button> <button onclick="toggleCanvasConfig()"
            # And we need to close the div later?
            # Wait, my button_html above creates a div, puts new button, then starts the old button.
            # But where does the div close?
            # It should close AFTER the old button.
            # The old button closes with `</button>`.
            # So we need to add `</div>` after `</button>` of the config button.
            
            # This is becoming complex string manipulation.
            
            # Alternative: Just insert the new button BEFORE the config button.
            # <button ...>Fetch</button> <button ...>Config</button>
            # And wrap them in a div if possible?
            
            # Use strict replacement of the block if possible.
            # Original:
            # <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
            #    <div style="display:flex; align-items:center; gap:8px;"><span style="font-size:20px;">🗓️</span>
            #        <h2 style="margin:0; font-size:18px;">Canvas Deadlines</h2>
            #    </div><button onclick="toggleCanvasConfig()"
            
            # We can target `</div><button onclick="toggleCanvasConfig()"`
            
            pattern = '</div><button onclick="toggleCanvasConfig()"'
            replacement = """</div>
                    <div style="display:flex; gap:12px; align-items:center;">
                        <button onclick="startScraper()" style="background:var(--accent-purple); color:white; border:none; padding:6px 12px; border-radius:6px; font-size:13px; cursor:pointer; font-weight:500;">
                            🕷️ Fetch Full Content
                        </button>
                        <button onclick="toggleCanvasConfig()" """
            
            # Note: I am not closing the div here! The old button continues.
            # `... style="...">⚙️</button>`
            # I need to append `</div>` after the old button closes.
            
            # Let's find where the old button closes.
            # It closes at `</button>`.
            # So we replace `</button>` (of the config button) with `</button></div>`.
            
            # But there are many `</button>`s.
            # We need to find the specific one.
            
            # Let's search for `onclick="toggleCanvasConfig()"`
            # Then find the next `</button>`.
            
            btn_idx = content.find('onclick="toggleCanvasConfig()"')
            if btn_idx != -1:
                close_tag = '</button>'
                close_idx = content.find(close_tag, btn_idx)
                if close_idx != -1:
                    # Insert </div> after it
                    content = content[:close_idx + len(close_tag)] + '</div>' + content[close_idx + len(close_tag):]
                    print("Added closing div.")
                    
                    # Now do the start replacement
                    # We need to find the start of the button again (indices shifted)
                    # simpler: replace string
                    content = content.replace(pattern, replacement, 1)
                    print("Added start button/div.")
                else:
                    print("Could not find closing button tag.")
            else:
                print("Could not find toggleCanvasConfig.")


# 2. Add Modal
modal_html = """
    <!-- Assignment Detail Modal -->
    <div id="assignmentModal" class="modal">
        <div class="modal-content">
            <button class="modal-close" onclick="closeAssignmentModal()">&times;</button>
            <h2 id="modalTitle" style="margin-top:0; margin-bottom:8px;">Assignment Title</h2>
            <div id="modalMeta" style="color:var(--text-muted); font-size:14px; margin-bottom:16px; padding-bottom:16px; border-bottom:1px solid var(--border-color);">
                Course | Due Date
            </div>
            <div id="modalBody" style="line-height:1.6; color:var(--text-secondary);">
                <!-- HTML Content -->
            </div>
            <div id="modalFiles" style="margin-top:24px; padding-top:16px; border-top:1px solid var(--border-color);">
                <!-- Files links -->
            </div>
        </div>
    </div>
"""

if 'id="assignmentModal"' not in content:
    # Insert before <script>
    # Find the script tag that starts the main logic.
    # Usually it's the last script tag or formatted nicely.
    # We'll search for <script> // Emergency Error Handler
    
    script_marker = '<script> // Emergency Error Handler'
    if script_marker in content:
        content = content.replace(script_marker, modal_html + '\n    ' + script_marker)
        print("Modal inserted before script.")
    else:
        # Fallback: insert before any <script> that looks main
        # Search relative to end of file
        idx = content.rfind('<script>')
        if idx != -1:
             content = content[:idx] + modal_html + content[idx:]
             print("Modal inserted before last script.")
        else:
            print("Error: No script tag found.")

# 3. Replace JS
js_code = """
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
                    // Heuristic: matching title and fuzzy course name
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
            
            // Files? logic here
            document.getElementById('assignmentModal').style.display = 'flex';
        }

        function closeAssignmentModal() {
            document.getElementById('assignmentModal').style.display = 'none';
        }
        
        // Close modal on outside click
        window.onclick = function(event) {
            const modal = document.getElementById('assignmentModal');
            if (event.target == modal) {
                modal.style.display = "none";
            }
        }
"""

# Extract JS block
# Find unique anchors for existing JS block
# Start: // ---- Canvas Integration ----
# End: loadCanvasDeadlines();

start_marker = "// ---- Canvas Integration ----"
end_marker = "loadCanvasDeadlines();"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx != -1 and end_idx != -1:
    end_idx += len(end_marker)
    # Validate indices
    if end_idx > start_idx:
        content = content[:start_idx] + js_code + content[end_idx:]
        print("JS Code Replaced.")
    else:
        print("Error: JS start/end indices invalid.")
else:
    print(f"Error: Could not find JS markers. Start: {start_idx}, End: {end_idx}")

# Write back
with open(html_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done.")
