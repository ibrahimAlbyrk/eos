# present — visual answers
Write the keys in this order: title, tone, icon, replaces, data, actions, ui, summary.
- title ≤ 80 chars. tone (one accent): blue|green|amber|red|violet|teal. icon: utensils map map-pin calendar clock star flask git-branch chart list check alert-triangle info lightbulb book plane car train hotel coffee wine shopping-bag wallet user users file folder code terminal bug rocket heart sun cloud music film globe link search sparkles.
- replaces: id of an earlier view this one updates (it folds to a stub).
- data: each entity once; a collection is an array of objects. ui only references data — never repeat a row in markup.
- actions: {id: {label, kind, primary?, text?, href?, set?}} — send (posts a turn to you; text may template {field} and {state.key}; default = label) · prefill (text → composer) · open (href: URL, file path, maps:{geo}) · copy (text) · set ({stateKey: value}, local). ≤ 2 primary.
- ui ≤ 24 KB. summary: the answer as plain text ≤ 600 chars (fallback, notifications, phones).

## Entities {type, id, …} — extra fields stay usable in templates
Place: name rating(0–5) reviews price(1–4) geo[lat,lon] address hours{until|closed|text} area cuisine distance
Product: name price currency brand specs inStock · Event: name start end venue geo price · Person: name role org
Article: title author date excerpt · Media: title kind duration · File: path line added removed · Generic: any
All: image (http URL from results, never invented) site (domain → logo) url source (1-based into data.sources) tags[]. Untyped rows need no type/id.
data.sources: [{title, url, site, at, note}] — required when stating facts. Unknown → leave it out.

## Markup
<Tag a="text" n={3} list={["a","b"]} flag>children</Tag> · <Tag a="x"/>. {…} is JSON, never JS. Text children: inline markdown, no HTML. Depth ≤ 8.
⊂ = takes of="collection" + where= sort="field|-field" limit= skip="ids".
Field attrs (x y cols, Meter value) take a bare name (y="amount"); text attrs read a field only in braces (meta="{cuisine} · {area}"): title="title" prints "title". Omit title/text/meta to show the item's own.
Lists: ids "a b" or "a, b"; labels "A | B" or "A, B"; or JSON arrays.
where: open · field · !field · field op value (== != < <= > >= ~contains), joined by &&; value may be state.key.
expr (Value, Progress, when=): arithmetic, comparisons, && || ! ?:; names = state keys, item fields, data (places.rating = all ratings); fns sum count min max avg round abs floor ceil fv(payment, annualRate, years).
Inputs bind="key" to view state. Any element: when="expr", label= (its tab in Tabs). Filters and selection apply to every lens of a collection.

## Components (* required)
Layout:
- Section title meta icon collapsed — titled group
- Stack gap=sm|md|lg dir=col|row align=start|center|end|stretch wrap — vertical flow, or a row
- Grid cols=1–4 gap=sm|md|lg min=120–480 (px) — columns; reflows when narrow
- Split ratio=1:1|1:2|2:1|2:3|3:2 align — two children side by side; stacks when narrow
- Carousel of card=row|compact|hero meta actions ⊂ — 3–8 cards scrolling sideways, from of= or child elements
- Tabs bind labels — segmented switch between child elements (each child's label=)
- Disclosure title* meta badge tone icon open — row that expands to show its children
- Divider — hairline; label= puts text on it
Content:
- Text size=sm|md|lg tone muted — inline-markdown paragraph
- Heading level=1–3 meta icon — heading
- Image src* alt ratio=16:9|4:3|3:2|1:1|21:9 credit fit=cover|contain — one image
- Gallery of field images (URLs) layout=bento|grid|strip ⊂ — several images, +N tile
- Logo site name size=sm|md|lg — brand logo → site icon → monogram
- Badge tone icon variant=soft|solid|outline — short tag
- Rating value=0–5* count source=1–100 — ★ value (count)
- Price level=1–4 amount currency per — price level (₺₺) or an amount
- Status state=open|closing|closed|ok|warn|error|info|running|idle* until — colored dot + text
- Callout kind=info|tip|warning|danger|success title icon action — highlighted note; action= adds its button
- Quote cite source=1–100 — quotation
- Code lang title value wrap — code block: raw text child, or value= from a template
- FileRef path* line — file chip that opens in the side panel
- Sources of compact — numbered sources (default of=sources)
Data:
- Stat label* value* meta delta trend=up|down|flat good=up|down tone icon spark (number list) — KPI tile; spark= draws a sparkline under it; delta is coloured only with good= (the direction that is good news)
- KeyValue of items ({"Label":"value"}) key value cols=1–2 ⊂ — label/value rows
- Table of* cols* best numbered actions ⊂ — sortable compare table; a row selects its entity in every lens
- Chart type=bar|line|area|donut|sparkline* of x y values (number list) unit height=60–400 stacked ⊂ — chart from rows (x field, y field(s)) or values
- Meter value* max label unit tone of ⊂ — bar meter; with of= one per item and value= names the field
- Timeline of* time title note meta leg (to next) numbered ⊂ — time-ordered stops or events
- Steps of variant=list|stepper bind title text code ⊂ — ordered steps; stepper shows one at a time with Back/Next
- Progress value max expr label tone — progress bar
- Value expr* label format=number|int|currency|percent|compact prefix suffix decimals=0–6 currency tone size=sm|md|lg — live computed number
Entities:
- Card of* pick* variant=row|compact|hero kind (entity type) meta badge actions — one entity
- Hero of* pick* badge meta actions gallery — the top pick, large; children say why
- List of* variant=row|compact|disclosure title meta badge tone numbered actions ⊂ — a row per item; child elements repeat per item (a disclosure row's detail)
Geo:
- Map of* pin=index|dot|logo route you height=160–600 zoom=1–19 ⊂ — pins from geo or address; route joins them in order; you = the user
Inputs:
- Filters of* chips* on (initially on) bind — chips filtering a collection in every lens
- Segmented bind* options* default — one of 2–5 options
- Toggle bind* label default — on/off
- Slider bind* min* max* step default label prefix suffix format (as Value) — number in a range
- Stepper bind* min max step default label unit — − n +
- Select bind* options* default label — dropdown
- Field bind* label placeholder type=text|number|date|time|multiline default — text input
- Checklist bind* of items title text ⊂ — tick list with a done count
- Choice bind* options* question answer (index or label) explain action — quiz or poll; answer= reveals right/wrong locally; children = the question
- Form action* submit — groups inputs; submit sends the action with their values
- Actions ids* align=start|end|stretch — buttons for actions

Limits: data ≤ 64 KB · Carousel 3–8 items · ≤ 1 Map · ≤ 40 images. A rejected call lists each problem with its path — fix all, call again.
