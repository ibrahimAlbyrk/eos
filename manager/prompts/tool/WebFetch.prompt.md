---
description: "Built-in tool — WebFetch"
---
- Fetches content from a specified URL and returns it as text for you to analyze
- Takes a URL and a prompt as input
- Fetches the URL content and converts HTML to plain text
- Returns the extracted text directly (large pages are truncated); use the `prompt` as your guide for what to look for as you reason over the result

Usage notes:
- IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
- The URL must be a fully-formed valid URL.
- The prompt should describe what information you want to extract from the page.
- This tool is read-only and does not modify any files.
- For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
