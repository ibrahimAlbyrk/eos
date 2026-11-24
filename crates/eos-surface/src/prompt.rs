//! The designer's catalog (`PAGE_CATALOG`): what a page design may be made
//! of, written from the same tables the checks read, so what the designer is
//! told and what is checked never drift apart.

use crate::css::{FAMILIES, PROPERTIES, SYSTEM};
use crate::limits::{CONTRACT_BYTES, SAMPLE_BYTES, STYLE_BYTES, TEMPLATE_BYTES};
use crate::template::{COMPONENTS, ELEMENTS, EOS_TARGETS, ISSUE_FIELDS};

/// The catalog, as Markdown.
pub fn page_catalog_prompt() -> String {
    let components: Vec<String> = COMPONENTS
        .iter()
        .map(|c| {
            let attrs: Vec<String> = c
                .attrs
                .iter()
                .map(|a| if c.required.contains(a) { format!("{a}=") } else { format!("{a}= (optional)") })
                .collect();
            format!("- `<{}>` {}: {}", c.name, attrs.join(", "), c.about)
        })
        .collect();
    let fonts: Vec<&str> = FAMILIES.iter().map(|f| f.name).collect();
    let issue: Vec<String> = ISSUE_FIELDS.iter().map(|f| format!("`{{issue.{f}}}`")).collect();
    let targets: Vec<String> = EOS_TARGETS.iter().map(|t| format!("`{t}`")).collect();
    format!(
        "## A page design\n\n\
         A design has a `template`, a `style`, a `contract` and a `sample`; `uses` lists the direct actions its \
         Buttons run and `queries` the named queries its Live parts read. Each run fills the contract with data; \
         Eos draws every issue from the design with no agent.\n\n\
         ### Contract\n\n\
         An object type: `{{\"type\": \"object\", \"fields\": {{…}}}}`. Each field is a type with `required` \
         (default true) and `edit` (the reader may change it in place). Types: `text` and `longtext` with `max` \
         characters, `number`, `int`, `bool`, `date`, `datetime`, `url`, `image` (`{{src, alt, credit?}}`), \
         `enum` with `values`, `object` with `fields`, `list` with `of`, `min` and `max`. At most {CONTRACT_BYTES} bytes.\n\n\
         ### Template\n\n\
         Elements: {elements}. Every section, article, aside, header, footer and main has a `part=` name, unique \
         in the page: the reader points at parts. Any element takes `class`, `style`, `part`, `lang`, `dir`, \
         `aria-label`; `img` takes `src` and `alt` (alt text is required), `a` takes `href`, `time` takes \
         `datetime`, `th` and `td` take `colspan` and `rowspan`. Headings never skip a level.\n\n\
         - A slot `{{field.path}}` puts a value in as text, never as markup; `{{field|format}}` formats it: \
         date, time, datetime, weekday, number or count:<word>.\n\
         - `each=\"list\"` repeats an element per item, named `item` (or `as=\"name\"`); at most two levels deep.\n\
         - `if=\"field\"` and `unless=\"field\"` guard an element. An optional field is used only under its guard.\n\
         - {issue} are Eos's own: the issue's number, its date and the reader's first name.\n\
         - A link goes to a `url` field or to {targets}.\n\n\
         Components Eos draws itself:\n{components}\n\n\
         At most {TEMPLATE_BYTES} bytes.\n\n\
         ### Style\n\n\
         Plain CSS on elements and classes, with descendant and child combinators, lists, `:first-child`, \
         `:last-child` and `:nth-child(odd|even)`. Properties: {props}. Custom properties are \
         resolved. Nothing that loads, layers or leaves the flow: no `url()`, `@import`, `@font-face`, `content`, \
         `z-index` or fixed positions. Fonts: {fonts}, and the system families {system}. At most {STYLE_BYTES} \
         bytes. Write `@media print` for the PDF.\n\n\
         ### Sample\n\n\
         Data that fits the contract, as a real run would fill it: it is drawn and checked like an issue. At most \
         {SAMPLE_BYTES} bytes.\n\n\
         ### Checks\n\n\
         Before the user sees it, the design is drawn with its sample, the least data its contract allows and the \
         newest issues that fit, at 360 and 1000 px wide. Text is at least 12 px (14 px for runs over 80 \
         characters) with WCAG contrast (4.5:1, 3:1 from 24 px or 18.66 px bold); nothing is wider than the \
         window except inside `overflow-x: auto`; every part shows something.",
        elements = ELEMENTS.join(", "),
        props = PROPERTIES.join(", "),
        fonts = fonts.join(", "),
        system = SYSTEM.join(", "),
        components = components.join("\n"),
        issue = issue.join(", "),
        targets = targets.join(", "),
    )
}
