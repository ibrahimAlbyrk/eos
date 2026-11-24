---
description: "Tool — fill_page"
variables:
  - SUBMIT_RESULT_TOOL
---

Hand the run's answer in as the data of the routine's page, for a routine whose result is a page: Eos draws it in the page's own design, so you write data, never markup.

- `data`: one object that fits the page's contract. Call this without `data` first: the answer is the contract this run fills and a sample that fits it.
- Text is plain: no markdown, no HTML. A long text splits into paragraphs on blank lines.
- An image is `{"src": …, "alt": …}`: `src` an http(s) address, or the name of a file you made in your run's folder; `alt` says what it shows. Eos fetches or reads each image once and keeps it.

The answer names the issue, or lists every problem with its path: fix them all and call this again. After three refused calls the issue is shown as a plain view instead. A second call that is accepted replaces the first. Then hand the result in with {{SUBMIT_RESULT_TOOL}}, kind `page`, naming the issue.

When NOT to use:
- For a routine whose result is not a page: hand the result in with {{SUBMIT_RESULT_TOOL}} alone.
