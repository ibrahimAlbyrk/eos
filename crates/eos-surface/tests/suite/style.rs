use eos_surface::css::{ElementRef, Medium, StyleSheet, font_faces, write_decls};
use eos_surface::format_problems;

use crate::paper;

fn problems(src: &str) -> String {
    match StyleSheet::sanitize(src) {
        Ok(_) => String::new(),
        Err(problems) => format_problems(&problems),
    }
}

fn el(name: &str, classes: &[&str], index: usize, last: bool) -> ElementRef {
    ElementRef { name: name.into(), classes: classes.iter().map(|c| (*c).to_owned()).collect(), index, last }
}

const SCREEN: Medium = Medium { width: 1000.0, print: false, more_contrast: false };

#[test]
fn the_morning_papers_style_passes_and_resolves_its_custom_properties() {
    let sheet = StyleSheet::sanitize(&paper::file("style.css")).expect("the paper's style passes");
    let css = sheet.to_css();
    assert!(!css.contains("var("), "custom properties are resolved: {css}");
    assert!(!css.contains("--paper"), "and not written out");
    assert!(
        css.contains(".sheet{max-width:1000px;margin:0 auto;border-radius:6px;background:#eceae4;color:#161616;"),
        "{css}"
    );
    assert!(css.contains("@media (max-width: 600px){header,.front,.stories,.feedback{"), "{css}");
    assert_eq!(sheet.families(), ["Fraunces", "IBM Plex Mono", "Geist"]);
}

#[test]
fn every_refused_construct_is_a_problem_with_its_place() {
    let cases = [
        ("p { background: url(https://evil/x.png) }", "url() is refused"),
        ("p { background: url('https://evil/x.png') }", "url() is refused"),
        ("p { background: \\75 rl(https://evil/x.png) }", "url() is refused"),
        ("p { background: u\\72l(x) }", "url() is refused"),
        ("@import 'x.css';", "@import is refused"),
        ("@font-face { font-family: X; }", "@font-face is refused"),
        ("p::before { content: 'x' }", "pseudo-classes"),
        ("p { content: 'x' }", "content is refused"),
        ("p { \\63 ontent: 'x' }", "content is refused"),
        ("p { position: fixed }", "position: fixed is refused"),
        ("p { position: absolute }", "position: absolute is refused"),
        ("p { position: sticky }", "position: sticky is refused"),
        ("p { z-index: 9 }", "z-index is refused"),
        ("p { cursor: pointer }", "cursor is refused"),
        ("p { pointer-events: none }", "pointer-events is refused"),
        ("p { width: expression(alert(1)) }", "expression() is not a function"),
        ("p { color: attr(data-x) }", "attr() is not a function"),
        ("p { font-family: Comic Sans MS }", "Comic Sans MS is not a font Eos has"),
        ("p { font: 12px Fraunces }", "font is refused"),
        ("p { display: table }", "display: table is refused"),
        ("p { transform: rotate(3deg) }", "transform is not a property a page may set"),
        ("#x { color: red }", "a page has no ids"),
        ("* { color: red }", "* selects every element"),
        ("p[x] { color: red }", "attribute selectors"),
        ("script { color: red }", "script is not an element"),
        ("p { color: var(--nope) }", "var(--nope) is never set"),
        ("p { font-family: '</style><script>' }", "a string may not hold < or >"),
        ("p { grid-template-areas: '</style>' }", "a string may not hold < or >"),
        ("@media screen { p { color: red } }", "@media takes print"),
        ("p { color: red } }", "a rule is never finished"),
    ];
    for (src, expected) in cases {
        let found = problems(src);
        assert!(found.contains(expected), "{src}: {found}");
        assert!(found.starts_with("style:1:"), "{src}: {found}");
    }
}

#[test]
fn what_is_written_back_holds_nothing_that_ends_the_style_element() {
    let sheet =
        StyleSheet::sanitize("p { font-family: \"Georgia\"; color: #000 } .a > .b { margin: 0 }").expect("passes");
    let css = sheet.to_css();
    assert!(!css.contains('<'), "{css}");
    assert!(css.contains(".a>.b{margin:0}"), "{css}");
}

#[test]
fn the_cascade_orders_by_importance_specificity_and_source_and_honours_media() {
    let sheet = StyleSheet::sanitize(
        "p { color: #111 } .story p { color: #222 } p.dek { color: #333 } li:nth-child(even) { color: #444 }
         p { margin: 0 !important } @media (max-width: 600px) { p { color: #555 } } @media print { p { color: #666 } }",
    )
    .expect("passes");
    let chain = [el("article", &["story"], 1, true), el("p", &["dek"], 2, true)];
    let decls = write_decls(&sheet.cascade(&chain, &SCREEN));
    assert_eq!(decls, "color:#111;color:#222;color:#333;margin:0 !important");
    let narrow = Medium { width: 360.0, ..SCREEN };
    assert!(write_decls(&sheet.cascade(&chain, &narrow)).contains("color:#555"));
    let print = Medium { print: true, ..SCREEN };
    assert!(write_decls(&sheet.cascade(&chain, &print)).contains("color:#666"));
    let rows = [el("ul", &[], 1, true), el("li", &[], 2, false)];
    assert_eq!(write_decls(&sheet.cascade(&rows, &SCREEN)), "color:#444");
    let first = [el("ul", &[], 1, true), el("li", &[], 1, false)];
    assert_eq!(write_decls(&sheet.cascade(&first, &SCREEN)), "");
}

#[test]
fn a_child_selector_needs_the_parent_right_above() {
    let sheet = StyleSheet::sanitize(".a > p { color: #111 } .a p { margin: 0 }").expect("passes");
    let near = [el("div", &["a"], 1, true), el("p", &[], 1, true)];
    let far = [el("div", &["a"], 1, true), el("div", &[], 1, true), el("p", &[], 1, true)];
    assert_eq!(write_decls(&sheet.cascade(&near, &SCREEN)), "color:#111;margin:0");
    assert_eq!(write_decls(&sheet.cascade(&far, &SCREEN)), "margin:0");
}

#[test]
fn an_inline_style_in_a_template_is_checked_too() {
    let contract = eos_surface::Contract::parse(&serde_json::json!({"type": "object", "fields": {}})).expect("valid");
    let found = match eos_surface::template::PageTemplate::check("<p style=\"position: fixed\">a</p>", &contract) {
        Ok(_) => String::new(),
        Err(problems) => format_problems(&problems),
    };
    assert!(found.contains("template:1:1: position: fixed is refused"), "{found}");
}

#[test]
fn only_the_fonts_a_page_names_are_inlined() {
    let faces = font_faces(&["Fraunces"]);
    assert_eq!(faces.matches("@font-face").count(), 4);
    assert!(faces.contains("font-family:'Fraunces'") && faces.contains("data:font/woff2;base64,"));
    assert!(font_faces(&["Georgia"]).is_empty());
}
