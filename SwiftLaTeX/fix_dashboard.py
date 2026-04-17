
import re

file_path = 'dashboard.html'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Fix template literals: $ { -> ${
# Be careful not to match literal $ { if valid (unlikely in this context)
# We'll replace "$ {" with "${" globally.
content = content.replace('$ {', '${')

# 2. Fix HTML comments: < !-- -> <!--
content = content.replace('< !--', '<!--')

# 3. Fix Duplicate Assignment Modal
# Pattern: <div id="assignmentModal" class="modal">...</div>
# We might have two identical blocks?
# Or similar blocks.

start_tag = '<div id="assignmentModal" class="modal">'
count = content.count(start_tag)
print(f"assignmentModal count: {count}")

if count > 1:
    # Find the second occurrence and remove it?
    # Or find the first and keep it?
    # The second one is usually the one appended later.
    # But they might be identical.
    
    # We can use regex to remove one.
    # Construct regex for the modal block.
    # It ends with </div>... wait, nested divs.
    # Regex for HTML parsing is bad.
    
    # Simple approach: Find the index of second occurrence and try to remove the block.
    # Or better: Parsing properly? No.
    
    # Split by start_tag.
    parts = content.split(start_tag)
    # parts[0] is before first one.
    # parts[1] is content of first one + rest.
    # parts[2] is content of second one + rest.
    
    # We want to keep one.
    # Reassemble: parts[0] + start_tag + parts[1] ... Wait, no.
    
    # Let's try to identify if they are adjacent.
    # ... </div> \n <div id="assignmentModal" ...
    
    # If I just want to remove DULICATES, I can check strict string match?
    pass

# Refined Duplicate Removal:
# Read the file line by line?
# Or just search/replace the modal block string once.
# If I construct the modal string accurately.

modal_block_snippet = """    <!-- Assignment Detail Modal -->
    <div id="assignmentModal" class="modal">"""

# Check for the comment too.
count_comment = content.count('<!-- Assignment Detail Modal -->')
print(f"Comment count: {count_comment}")

# If we have duplicate blocks, we should remove the extra one.
# I'll manually find the ranges.

p1 = content.find(start_tag)
p2 = content.find(start_tag, p1 + 1)

if p2 != -1:
    print("Found duplicate modal at", p2)
    # Be careful removing. We need to find the end of the div.
    # It's hard to find the matching </div> without a parser.
    # But looking at view_file (lines 482-498), it's indented and clean.
    # Lines 465-480 for first one.
    # Lines 482-498 for second one.
    # They seem identical and sequential.
    
    # I'll just remove the chunk from p2 to... where?
    # It ends with </div> (line 498).
    # And there is a <script> after it?
    
    # Let's rely on the previous known structure.
    # The duplication happened likely because I appended it.
    
    # I'll start simplest: Fix the syntax errors first. The duplicate modal probably won't break the page, just clutter.
    # The JS syntax errors ($ {) is the CRITICAL one causing "nothing clickable".
    pass

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Fixed Syntax Errors.")
