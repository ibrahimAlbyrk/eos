# Eos Export — Dark Theme Visual Specification

Design system for the self-contained HTML conversation export (`manager/templates/export.html`).
Values are exact and map to the class names the renderer already emits. Hand this to a developer for a pixel-perfect implementation.

Theme replaces the current light "Letterpress Archive". Same DOM, new skin.

---

## 0. DOM → component map (what the renderer actually emits)

| Real class(es) | Component | Content mode |
|---|---|---|
| `.archive` | Page container | — |
| `.archive-header` `.archive-mark` `.archive-title` `.archive-subtitle` `.rule-ornament>.diamond` `.archive-meta>span+.meta-sep` | Page header (§5.1) | — |
| `.worker-section` `.worker-header` `.worker-name` `.worker-badge`(`.orch`) | Worker section header (§5.2) | — |
| `.event.msg-user` `.event-time` `.event-body` `.event-body-inner` | User message (§5.3) | plain text, italic (escHtml) |
| `.event.msg-assistant` `.event-body` `.msg-text.md-body` | Assistant text (§5.4) | **markdown** |
| `.md-body` children: `p h1 h2 h3 code pre>code ul ol li strong em a hr` | Markdown (§5.4.1) | markdown |
| `details.thinking-block>summary>.thinking-label` + `.thinking-content` | Thinking block (§5.5) | plain text, pre-wrap |
| `details.tool-call-block>summary>.chevron+.tool-name` + `.tool-detail` | Tool call (§5.6) | pretty JSON, pre-wrap |
| `details.tool-result-block>summary>.dot`(`.result-error`)`+.result-err-label` + `.result-content` | Tool result (§5.7) | plain text, pre-wrap |
| `.archive-footer>a` | Page footer (§5.8) | — |
| `.empty-state>.empty-title+p` | Empty state | — |

Present in stylesheet but **not currently emitted** — keep the rules, treat as optional: `.model-tag` (assistant model chip), `.worker-stats` (per-worker counts).

---

## 1. Aesthetic Concept

**"Obsidian Dawn."** The screen of a terminal at 5 a.m.: a deep blue-violet near-black, with the first warm light of sunrise bleeding in from the top edge — rose, coral, amber. Eos is the Greek goddess of dawn, so the palette is literal: a cold obsidian night lit by a warm gradient horizon, with a cool aurora-teal for machine/tool voices. Modern, spacious, minimal — depth comes from soft colored glows and layered near-blacks, never from heavy borders or drop-shadow chrome.

---

## 2. Typography System

### Google Fonts import (only external dependency)
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:ital,wght@0,400;0,500;0,700;1,400&display=swap" rel="stylesheet">
```

### Roles
| Role | Family | Fallback stack |
|---|---|---|
| Display / heading | **Bricolage Grotesque** | `'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif` |
| Body | **Hanken Grotesk** | `'Hanken Grotesk', system-ui, -apple-system, sans-serif` |
| Monospace | **JetBrains Mono** | `'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace` |

`html { font-size: 16px; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }`
`body { font-optical-sizing: auto; }`

### Type scale
| Element | Family | Size | Weight | Line-height | Letter-spacing |
|---|---|---|---|---|---|
| Page title `.archive-title` | Bricolage | `3.25rem` (52px) | 800 | 1.04 | `-0.03em` |
| Eyebrow `.archive-subtitle` | JetBrains Mono | `0.72rem` | 500 | 1.4 | `0.3em`, uppercase |
| Header meta `.archive-meta` | JetBrains Mono | `0.8rem` | 400 | 1.5 | `0.02em` |
| Worker name `.worker-name` | Bricolage | `1.5rem` (24px) | 700 | 1.2 | `-0.02em` |
| Worker badge `.worker-badge` | JetBrains Mono | `0.625rem` (10px) | 600 | 1 | `0.14em`, uppercase |
| Body / assistant `.md-body` | Hanken | `1rem` (16px) | 400 | 1.72 | normal |
| User message `.event-body-inner` | Hanken | `1rem` | 400 *(italic)* | 1.7 | normal |
| md `h1` | Bricolage | `1.5em` | 700 | 1.25 | `-0.01em` |
| md `h2` | Bricolage | `1.25em` | 700 | 1.3 | `-0.01em` |
| md `h3` | Hanken | `1.05em` | 700 | 1.4 | `0.01em` |
| Inline `code` | JetBrains Mono | `0.85em` | 400 | inherit | normal |
| `pre code` block | JetBrains Mono | `0.8125rem` (13px) | 400 | 1.65 | normal |
| Tool name `.tool-name` | JetBrains Mono | `0.8125rem` | 600 | 1 | `0.01em` |
| Tool JSON `.tool-detail` | JetBrains Mono | `0.78rem` (12.5px) | 400 | 1.6 | normal |
| Result text `.result-content` | JetBrains Mono | `0.78rem` | 400 | 1.6 | normal |
| Thinking label `.thinking-label` | Hanken *(italic)* | `0.8rem` | 500 | 1 | `0.01em` |
| Thinking body `.thinking-content` | Hanken | `0.875rem` (14px) | 400 | 1.7 | normal |
| Timestamp `.event-time` | JetBrains Mono | `0.6875rem` (11px) | 400 | 1.4 | `-0.01em`, `tabular-nums` |
| Footer `.archive-footer` | JetBrains Mono | `0.72rem` | 400 | 1.6 | `0.05em` |

---

## 3. Color System

```css
:root {
  /* ── background layers (blue-violet near-black, deepest → highest) ── */
  --bg-void:      #05060b;  /* vignette base, code-block interior */
  --bg-base:      #0a0c13;  /* page background */
  --bg-surface:   #10131d;  /* worker tint, tool-result & thinking closed */
  --bg-elevated:  #161a26;  /* tool-call closed, inline code, chips */
  --bg-hover:     #1e2331;  /* hover + open-summary header */
  --bg-inset:     #0c0e16;  /* open content panels (json / result text) */

  /* ── text hierarchy ── */
  --text-bright:    #f6f8ff; /* strong/bold pops */
  --text-primary:   #e9ebf4; /* body, headings */
  --text-secondary: #aab2c8; /* user msg, thinking body, secondary */
  --text-muted:     #6f7891; /* labels, meta, tool JSON */
  --text-faint:     #464d61; /* timestamps, dividers-as-text */

  /* ── dawn brand gradient ── */
  --dawn-rose:   #ff6b8a;
  --dawn-coral:  #ff8a5c;
  --dawn-amber:  #ffb454;
  --dawn-grad:   linear-gradient(115deg, #ff6b8a 0%, #ff8a5c 45%, #ffb454 100%);

  /* ── element accents ── */
  --accent-user:      #ff6b8a; /* rose — the human */
  --accent-assistant: #ffb454; /* amber — AI marker/model chip */
  --accent-tool:      #3dd8c0; /* teal — tool calls / action */
  --accent-result:    #7e8bb8; /* slate-blue — quiet results */
  --accent-think:     #9b8cff; /* violet — reasoning */
  --accent-error:     #ff5d6c; /* red-coral — errors */
  --accent-link:      #ff9d6b; /* coral, lightened for link contrast */
  --accent-code:      #7fd8c8; /* inline code text (teal family) */

  /* ── borders ── */
  --border-subtle:  #1a1e2b;
  --border-default: #262b3d;
  --border-strong:  #363d54;

  /* ── glows & shadows ── */
  --glow-dawn:   0 0 60px rgba(255,138,92,.12);
  --glow-user:   0 2px 24px rgba(255,107,138,.08);
  --glow-tool:   0 0 24px rgba(61,216,192,.10);
  --glow-think:  0 0 28px rgba(155,140,255,.10);
  --glow-error:  0 0 24px rgba(255,93,108,.14);
  --shadow-sm:   0 1px 2px rgba(0,0,0,.4);
  --shadow-md:   0 6px 24px rgba(0,0,0,.4);
  --shadow-lg:   0 16px 48px rgba(0,0,0,.5);
}
```

Selection + focus:
```css
::selection { background: rgba(255,138,92,.25); color: var(--text-bright); }
:focus-visible { outline: 2px solid var(--accent-link); outline-offset: 2px; border-radius: 4px; }
```

---

## 4. Spacing & Layout

Spacing scale (use throughout): `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96` px.
Radii: `--radius-sm: 5px` (chips/inline code) · `--radius-md: 8px` (details blocks) · `--radius-lg: 12px` (user msg, code blocks) · `--radius-pill: 999px` (badges).

### Container
```css
.archive {
  position: relative; z-index: 1;
  max-width: 940px;          /* wide, per brief */
  margin: 0 auto;
  padding: 5rem 2.5rem 6rem; /* generous top, airy sides, deep bottom */
}
```

### Event row — timestamp gutter + content
Two-column grid. Timestamp sits in a fixed right-aligned gutter; content flexes.
```css
.event {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 1.5rem;
  padding: 0.55rem 0;
  align-items: start;
}
.event-time {
  font: 400 0.6875rem/1.4 'JetBrains Mono', monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  text-align: right;
  padding-top: 0.2rem;
  letter-spacing: -0.01em;
  transition: color .15s ease;
}
.event:hover .event-time { color: var(--text-muted); }  /* brighten on hover */
.event-body { min-width: 0; }  /* allow code/JSON to scroll instead of blow out */
```

### Vertical rhythm & margins
- Header: `padding-bottom: 3.5rem; margin-bottom: 3rem;`
- Worker section: `margin-bottom: 4rem;` (last-child `0`)
- Worker header → first event: `margin-bottom: 2rem`
- Between consecutive collapsible blocks in one assistant turn: `0.4rem`
- Footer: `margin-top: 4rem; padding-top: 3rem;`

Gutter width collapses on mobile (see §7 responsive).

---

## 5. Component Specs

### 5.1 Page header — `.archive-header`
Centered masthead over the dawn glow.
- **Layout**: `text-align: center;` bottom divider = fading dawn hairline.
- **Mark** `.archive-mark` (svg, ~40px): a sun cresting a horizon in `--dawn-coral`; soft glow `filter: drop-shadow(0 0 12px rgba(255,138,92,.5));` margin-bottom `1.25rem`.
- **Eyebrow** `.archive-subtitle` ("CONVERSATION ARCHIVE"): mono, `0.72rem`, `0.3em` tracking, uppercase, `--text-muted`; render **above** the title, `margin-bottom: 1rem`.
- **Title** `.archive-title` ("Eos Export"): Bricolage 800, `3.25rem`, `-0.03em`; painted with the dawn gradient:
  ```css
  .archive-title{
    background: var(--dawn-grad);
    -webkit-background-clip: text; background-clip: text;
    color: transparent;
    filter: drop-shadow(0 0 24px rgba(255,138,92,.25));
  }
  ```
- **Ornament** `.rule-ornament>.diamond`: keep as a centered gradient hairline (transparent→`--border-strong`→transparent, width 220px) with a 6px rotated diamond in `--dawn-coral`, `opacity:.9`, `margin-top:1.5rem`.
- **Meta** `.archive-meta`: flex, centered, gap `1.25rem`; date · UTC time · worker count; mono `0.8rem` `--text-secondary`; `.meta-sep` dot in `--text-faint`.
- **Divider**: `border-bottom: 1px solid transparent;` use a `::after` gradient rule spanning full width, fading at both edges:
  `background: linear-gradient(90deg, transparent, var(--border-default) 20%, var(--border-default) 80%, transparent);`

### 5.2 Worker section header — `.worker-header`
```css
.worker-header{
  display:flex; align-items:baseline; gap:.75rem; flex-wrap:wrap;
  padding-bottom:.9rem; margin-bottom:2rem;
  border-bottom:1px solid var(--border-subtle);
  position: sticky; top: 0; z-index: 5;         /* nav aid for long exports */
  background: color-mix(in srgb, var(--bg-base) 82%, transparent);
  backdrop-filter: blur(12px);
}
.worker-name{ font:700 1.5rem/1.2 'Bricolage Grotesque'; letter-spacing:-.02em; color:var(--text-primary); }
```
- **Leading node** (add via `.worker-name::before`, 8px rounded square): `--dawn-coral` for orchestrator, `--accent-tool` for worker; `box-shadow: 0 0 10px currentColor;` `margin-right:.6rem`.
- **Badge** `.worker-badge`: pill, mono `0.625rem` `600`, uppercase, `0.14em`; `padding:.3em .7em; border-radius:var(--radius-pill); background:var(--bg-elevated); border:1px solid var(--border-default); color:var(--text-muted);`
- **Orchestrator** `.worker-badge.orch`:
  ```css
  color:var(--dawn-coral);
  background:rgba(255,138,92,.10);
  border-color:rgba(255,138,92,.35);
  box-shadow:0 0 16px rgba(255,138,92,.15);
  ```
- **Stats** `.worker-stats` (optional): `margin-left:auto; font:0.75rem; color:var(--text-faint);`

### 5.3 User message — `.event.msg-user .event-body-inner`
Plain italic text; warm rose; shifted right for a "human input" feel.
```css
.msg-user .event-body-inner{
  max-width: 90%; margin-left: auto;              /* right-aligned feel */
  padding: 1rem 1.25rem;
  background: linear-gradient(rgba(255,107,138,.08), rgba(255,107,138,.03));
  border: 1px solid rgba(255,107,138,.18);
  border-left: 3px solid var(--accent-user);
  border-radius: 4px 12px 12px 4px;
  box-shadow: var(--glow-user);
  font-style: italic;
  color: var(--text-secondary);
  line-height: 1.7;
  transition: border-color .2s ease, box-shadow .2s ease;
}
.msg-user .event-body-inner:hover{
  border-color: rgba(255,107,138,.3);
  box-shadow: 0 2px 28px rgba(255,107,138,.14);
}
```

### 5.4 Assistant text — `.event.msg-assistant .msg-text.md-body`
No box — AI voice flows open (contrast with the boxed human prompt). Primary text color.
- Container: `color:var(--text-primary); line-height:1.72;` no border/background.
- **Model chip** `.model-tag` (if emitted): inline-block chip above text — mono `0.65rem` `500`, uppercase, `0.1em`; `padding:.2em .6em; border-radius:var(--radius-sm); background:var(--bg-elevated); border:1px solid var(--border-subtle); color:var(--text-muted); margin-bottom:.6rem;` leading `◆` in `--accent-assistant`.

#### 5.4.1 Markdown children (`.md-body`)
```css
.md-body p{ margin:.7em 0; }
.md-body p:first-child{ margin-top:0; } .md-body p:last-child{ margin-bottom:0; }
.md-body h1{ font:700 1.5em/1.25 'Bricolage Grotesque'; letter-spacing:-.01em; color:var(--text-primary); margin:1.4em 0 .5em; }
.md-body h2{ font:700 1.25em/1.3 'Bricolage Grotesque'; letter-spacing:-.01em; color:var(--text-primary); margin:1.2em 0 .4em; }
.md-body h3{ font:700 1.05em/1.4 'Hanken Grotesk'; color:var(--text-secondary); margin:1em 0 .3em; }
.md-body strong{ font-weight:700; color:var(--text-bright); }
.md-body em{ font-style:italic; color:var(--text-secondary); }
.md-body a{
  color:var(--accent-link); text-decoration:underline; text-underline-offset:3px;
  text-decoration-color:rgba(255,157,107,.4); transition:color .15s, text-decoration-color .15s;
}
.md-body a:hover{ color:var(--dawn-amber); text-decoration-color:var(--dawn-amber); }
.md-body ul,.md-body ol{ margin:.5em 0; padding-left:1.5em; }
.md-body li{ margin:.3em 0; line-height:1.7; }
.md-body li::marker{ color:var(--dawn-coral); }
.md-body hr{ border:none; height:1px; margin:1.5em 0;
  background:linear-gradient(90deg,transparent,var(--border-default),transparent); }

/* inline code */
.md-body code{
  font:400 .85em 'JetBrains Mono', monospace;
  color:var(--accent-code);
  background:var(--bg-elevated);
  border:1px solid var(--border-subtle);
  border-radius:var(--radius-sm);
  padding:.15em .4em;
}
/* fenced code block */
.md-body pre{
  background:var(--bg-void);
  border:1px solid var(--border-default);
  border-radius:var(--radius-lg);
  padding:1rem 1.25rem; margin:.9em 0; overflow-x:auto;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.02);
}
.md-body pre code{
  color:#c8d0e6; background:none; border:none; padding:0;
  font-size:.8125rem; line-height:1.65;
}
```
Note: syntax is monochrome (renderer does not tokenize) — `#c8d0e6` on `--bg-void`. The `.lang-*` class on `pre code` may drive an optional top-right language label.

### 5.5 Thinking block — `details.thinking-block`
Violet; collapsible; usually long. Plain pre-wrap text.
```css
.thinking-block{
  background:rgba(155,140,255,.04);
  border:1px solid rgba(155,140,255,.15);
  border-left:2px solid var(--accent-think);
  border-radius:var(--radius-md);
  margin:.4rem 0; overflow:hidden;
  transition:box-shadow .2s ease, background .2s ease;
}
.thinking-block summary{
  display:flex; align-items:center; gap:.5rem;
  padding:.6rem .9rem; cursor:pointer; user-select:none; list-style:none;
}
.thinking-label{ font:italic 500 .8rem 'Hanken Grotesk'; color:var(--accent-think); }
.thinking-label::before{ content:'◈ '; font-style:normal; }
.thinking-content{
  font:400 .875rem/1.7 'Hanken Grotesk'; color:var(--text-secondary);
  white-space:pre-wrap; word-break:break-word;
  padding:.25rem 1rem 1rem 1.35rem;
  max-height:400px; overflow-y:auto;
  -webkit-mask-image:linear-gradient(#000 calc(100% - 24px), transparent); /* fade tail when scrollable */
          mask-image:linear-gradient(#000 calc(100% - 24px), transparent);
}
.thinking-block[open]{ background:rgba(155,140,255,.05); box-shadow:var(--glow-think); }
.thinking-block[open] summary{ border-bottom:1px solid rgba(155,140,255,.12); }
```
Chevron: prepend a `.chevron` (see §6) tinted `--accent-think`. (Current markup omits it on thinking — add one, or use the `::after` chevron pattern from §6.)

### 5.6 Tool call — `details.tool-call-block`
Teal; tool name + JSON input.
```css
.tool-call-block{
  background:var(--bg-elevated);
  border:1px solid var(--border-default);
  border-left:2px solid var(--accent-tool);
  border-radius:var(--radius-md);
  overflow:hidden; margin:.4rem 0;
  transition:box-shadow .2s ease, border-color .2s ease;
}
.tool-call-block summary{
  display:flex; align-items:center; gap:.5rem;
  padding:.65rem .9rem; cursor:pointer; user-select:none; list-style:none;
  font:500 .8125rem 'JetBrains Mono', monospace;
}
.tool-call-block summary:hover{ background:var(--bg-hover); }
.tool-call-block .tool-name{ font-weight:600; color:var(--accent-tool); }
.tool-detail{
  font:400 .78rem/1.6 'JetBrains Mono', monospace; color:#c8d0e6;
  white-space:pre-wrap; word-break:break-word;
  background:var(--bg-inset); border-radius:6px;
  margin:0 .6rem .6rem 1.9rem; padding:.75rem .9rem;
  max-height:480px; overflow:auto;
}
.tool-call-block[open]{ box-shadow:var(--glow-tool); border-color:rgba(61,216,192,.3); }
.tool-call-block[open] summary{ background:var(--bg-hover); border-bottom:1px solid var(--border-subtle); }
```
Chevron `.chevron` tinted `--accent-tool` (§6). Optional: truncated first-arg preview after `.tool-name` in `--text-muted`.

### 5.7 Tool result — `details.tool-result-block`
Quietest block; slate normally, red on error. Marker is a status **dot**, plus a right-aligned CSS chevron.
```css
.tool-result-block{
  background:var(--bg-surface);
  border:1px solid var(--border-subtle);
  border-left:2px solid var(--accent-result);
  border-radius:var(--radius-md);
  overflow:hidden; margin:.4rem 0;
  transition:box-shadow .2s ease, border-color .2s ease;
}
.tool-result-block summary{
  display:flex; align-items:center; gap:.5rem;
  padding:.55rem .9rem; cursor:pointer; user-select:none; list-style:none;
  font:400 .75rem 'JetBrains Mono', monospace; color:var(--text-muted);
}
.tool-result-block summary:hover{ background:var(--bg-hover); }
.tool-result-block .dot{
  width:5px; height:5px; border-radius:50%; flex-shrink:0;
  background:var(--accent-result);
}
.tool-result-block summary::after{      /* right-aligned chevron, no markup change */
  content:''; margin-left:auto; width:8px; height:8px; flex-shrink:0;
  border-right:1.5px solid var(--text-muted); border-bottom:1.5px solid var(--text-muted);
  transform:rotate(45deg); transition:transform .2s ease;
}
.tool-result-block[open] summary::after{ transform:rotate(225deg); }
.result-content{
  font:400 .78rem/1.6 'JetBrains Mono', monospace; color:var(--text-secondary);
  white-space:pre-wrap; word-break:break-word;
  background:var(--bg-inset);
  padding:.75rem .9rem; margin:0 .6rem .6rem 1.55rem; border-radius:6px;
  max-height:460px; overflow-y:auto;
}
.tool-result-block[open] summary{ border-bottom:1px solid var(--border-subtle); }

/* error variant */
.tool-result-block:has(.result-error){
  border-left-color:var(--accent-error);
  background:rgba(255,93,108,.04);
}
.dot.result-error{ background:var(--accent-error); box-shadow:0 0 8px rgba(255,93,108,.6); }
.result-err-label{
  font:600 .6rem 'JetBrains Mono', monospace; text-transform:uppercase; letter-spacing:.08em;
  color:var(--accent-error); margin-right:.3em;
}
.tool-result-block:has(.result-error)[open]{ box-shadow:var(--glow-error); }
```

### 5.8 Page footer — `.archive-footer`
```css
.archive-footer{
  text-align:center; margin-top:4rem; padding-top:3rem;
  border-top:1px solid transparent;   /* gradient hairline via ::before, like header */
  font:400 .72rem 'JetBrains Mono', monospace; letter-spacing:.05em; color:var(--text-faint);
}
.archive-footer a{ color:var(--text-muted); text-decoration:none; transition:color .15s; }
.archive-footer a:hover{ color:var(--accent-link); }
```
Separator between "Eos" and the repo link: `◆` in `--dawn-coral`, `opacity:.7`.

### Empty state — `.empty-state`
Centered, `padding:4rem 2rem; color:var(--text-muted);` `.empty-title` = Bricolage 700 `1.5rem` `--text-secondary`.

---

## 6. Background Treatment

Four fixed layers behind the `z-index:1` container.
```css
body{
  background: var(--bg-base);
  color: var(--text-primary);
  font-family:'Hanken Grotesk', system-ui, sans-serif;
  min-height:100vh;
}
/* dawn glow bleeding from the top edge + faint aurora in a corner */
body::before{
  content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
  background:
    radial-gradient(ellipse 1200px 620px at 50% -12%,
      rgba(255,138,92,.10), rgba(255,107,138,.05) 32%, transparent 62%),
    radial-gradient(ellipse 900px 700px at 100% 108%,
      rgba(61,216,192,.05), transparent 55%);
}
/* fine grain to kill gradient banding on dark (+ optional vignette) */
body::after{
  content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
  opacity:.035; mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```
Optional vignette (add to `body::after` background, before the noise): `radial-gradient(ellipse at 50% 40%, transparent 55%, rgba(0,0,0,.35))`.
The grain layer is important — smooth dark radial gradients band visibly without it.

---

## 7. Animation / Transition

### Page load — staggered fade-rise
```css
@keyframes fadeRise{ from{ opacity:0; transform:translateY(12px); } to{ opacity:1; transform:translateY(0); } }
.archive-header{ animation:fadeRise .6s .05s both cubic-bezier(.22,.68,.28,1); }
.worker-section{ animation:fadeRise .55s both cubic-bezier(.22,.68,.28,1); }
.worker-section:nth-child(2){ animation-delay:.15s; }
.worker-section:nth-child(3){ animation-delay:.22s; }
.worker-section:nth-child(4){ animation-delay:.29s; }
.worker-section:nth-child(5){ animation-delay:.36s; }
.worker-section:nth-child(n+6){ animation-delay:.43s; }
```

### Hover
- Details summaries: background → `--bg-hover`, chevron/accent brighten; `transition:.15s ease`.
- Blocks (`[open]`): colored glow (`--glow-*`) + border brightens; `transition:.2s ease`.
- Links, timestamps: color transitions (§4, §5.4.1).

### Details open/close
- Chevron rotates (`.15–.2s cubic-bezier(.4,0,.2,1)`).
- Content reveal (CSS-only): `.thinking-block[open] .thinking-content, .tool-call-block[open] .tool-detail, .tool-result-block[open] .result-content { animation:revealDown .25s ease both; }` with `@keyframes revealDown{ from{opacity:0; transform:translateY(-4px);} to{opacity:1; transform:translateY(0);} }`.
- Progressive height animation (modern browsers): `:root{ interpolate-size: allow-keywords; }` + `details::details-content{ transition:height .25s ease, content-visibility .25s allow-discrete; }`.

### Reduced motion
```css
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{ animation:none !important; transition:none !important; }
}
```

### Custom scrollbars (open panels)
```css
.thinking-content,.tool-detail,.result-content,.md-body pre{ scrollbar-width:thin; scrollbar-color:var(--bg-hover) transparent; }
::-webkit-scrollbar{ width:8px; height:8px; }
::-webkit-scrollbar-thumb{ background:var(--bg-hover); border-radius:4px; }
::-webkit-scrollbar-thumb:hover{ background:var(--border-strong); }
::-webkit-scrollbar-track{ background:transparent; }
```

---

## 8. Details / Summary Styling

**Reset native markers (all three block types):**
```css
details summary{ list-style:none; cursor:pointer; }
summary::-webkit-details-marker{ display:none; }
summary::marker{ content:''; }
```

**Chevron** (`.chevron` span in tool-call & thinking summaries) — CSS-drawn caret, rotates on open:
```css
.chevron{
  width:8px; height:8px; flex-shrink:0;
  border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor;
  transform:rotate(-45deg);              /* points right when closed */
  transition:transform .2s cubic-bezier(.4,0,.2,1);
}
details[open] .chevron{ transform:rotate(45deg); }  /* points down when open */
```
Tint the chevron per block: `.tool-call-block .chevron{ color:var(--accent-tool); }` · `.thinking-block .chevron{ color:var(--accent-think); }`. Tool-result uses the `summary::after` chevron (§5.7) so no markup change is required there.

| State | Closed | Open |
|---|---|---|
| Shape | single-line bar, compact | bar + inset content panel below |
| Header bg | block base (`--bg-surface`/`--bg-elevated`) | `--bg-hover` + bottom hairline separating summary/content |
| Left accent bar | dim (2px solid accent) | brighter + block gets `--glow-*` |
| Chevron | points right (`-45deg`) / result: `45deg` | points down (`45deg`) / result: `225deg` |
| Content | hidden | `--bg-inset` panel, reveal-animates in, capped height + scroll |

---

## 9. Print & responsive (carry-overs, restyled)

**Responsive** — collapse the timestamp gutter on narrow screens:
```css
@media (max-width:640px){
  html{ font-size:15px; }
  .archive{ padding:2.5rem 1.1rem 3.5rem; }
  .archive-title{ font-size:2.25rem; }
  .event{ grid-template-columns:1fr; gap:.25rem; }
  .event-time{ text-align:left; padding-top:0; }
  .msg-user .event-body-inner{ max-width:100%; }
  .worker-header{ position:static; backdrop-filter:none; }
}
```

**Print** — the export is a keepable document; force a clean light print so it's readable on paper (mirrors the current template's `@media print`): white background, dark ink, drop the glow/grain/noise layers (`body::before,body::after{ display:none }`), expand all capped-height panels to full, disable sticky headers and entrance animations, and set `@page{ margin:2cm 2.2cm }`. Optionally open all `<details>` for print via `details{ open:… }` is not stylable — leave as-authored.
