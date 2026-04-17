
try:
    with open('dashboard.html', 'r', encoding='utf-8') as f:
        lines = f.readlines()
        # Extract function toggleCanvasConfig() to loadCanvasDeadlines();
        # Start at line 854 (index 853)
        # End at line 977 (index 976 is line 977)
        extract = ''.join(lines[853:977])
        print(extract)
except Exception as e:
    print(e)
