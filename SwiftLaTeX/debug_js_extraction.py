
import re

html_path = 'dashboard.html'
js_path = 'temp_debug.js'

with open(html_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find script content
# We look for the main script block
# It starts around line 500
match = re.search(r'<script>(.*?)</script>', content, re.DOTALL)

if match:
    js_content = match.group(1)
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)
    print(f"Extracted {len(js_content)} chars to {js_path}")
else:
    print("No script tag found.")
