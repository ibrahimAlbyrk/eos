use eos_surface::template::{Node, PageTemplate};
use eos_surface::{Contract, format_problems};
use serde_json::json;

use crate::paper;

fn small() -> Contract {
    Contract::parse(&json!({"type": "object", "fields": {
        "title": {"type": "text", "max": 20},
        "note": {"type": "text", "max": 20, "required": false},
        "when": {"type": "date"},
        "flag": {"type": "bool"},
        "lead": {"type": "object", "required": false, "fields": {
            "image": {"type": "image", "required": false},
            "url": {"type": "url"}}},
        "rows": {"type": "list", "max": 3, "of": {"type": "object", "fields": {
            "name": {"type": "text", "max": 10},
            "tags": {"type": "list", "max": 3, "of": {"type": "text", "max": 10}}}}}}}))
    .expect("valid")
}

fn small_problems(src: &str) -> String {
    match PageTemplate::check(src, &small()) {
        Ok(_) => String::new(),
        Err(problems) => format_problems(&problems),
    }
}

#[test]
fn the_morning_paper_passes_and_names_its_parts_actions_and_nothing_else() {
    let template = PageTemplate::check(&paper::file("template.html"), &paper::contract()).expect("the paper passes");
    assert_eq!(
        template.parts,
        [
            "masthead",
            "front",
            "lead",
            "lead-image",
            "rail",
            "desk",
            "starred",
            "left-out",
            "filters",
            "stories",
            "story",
            "ask",
            "feedback",
            "good",
            "not-today"
        ]
    );
    assert_eq!(template.actions, ["surface.feedback"]);
    assert!(template.queries.is_empty());
}

#[test]
fn a_template_written_back_reads_to_the_same_tree() {
    let template = PageTemplate::check(&paper::file("template.html"), &paper::contract()).expect("passes");
    let again = PageTemplate::check(&template.to_markup(), &paper::contract()).expect("its markup passes too");
    assert_eq!(strip(&again.nodes), strip(&template.nodes));
}

/// The tree without the source positions, which move when it is written back.
fn strip(nodes: &[Node]) -> Vec<Node> {
    nodes
        .iter()
        .map(|node| match node {
            Node::Element(el) => {
                let mut el = el.clone();
                el.line = 0;
                el.col = 0;
                el.children = strip(&el.children);
                Node::Element(el)
            }
            Node::Text(text) => {
                let mut text = text.clone();
                text.line = 0;
                text.col = 0;
                Node::Text(text)
            }
        })
        .collect()
}

#[test]
fn words_beside_an_inline_element_stay_apart() {
    let template = PageTemplate::check("<p part=\"p\">Hello <b>you</b> there</p>", &small()).expect("passes");
    assert_eq!(template.to_markup(), "<p part=\"p\">Hello <b>you</b> there</p>");
}

#[test]
fn only_the_listed_elements_and_attributes_are_allowed() {
    let cases = [
        ("<script>alert(1)</script>", "<script> is not an element a page may use"),
        ("<iframe src=\"x\"/>", "<iframe> is not an element"),
        ("<form/>", "<form> is not an element"),
        ("<svg/>", "<svg> is not an element"),
        ("<p onclick=\"x\">a</p>", "<p> may not carry onclick="),
        ("<div href=\"{lead.url}\">a</div>", "<div> may not carry href="),
        ("<Chart/>", "<Chart> is not a component"),
        ("<p hidden>a</p>", "<p> may not carry hidden="),
    ];
    for (src, expected) in cases {
        let found = small_problems(src);
        assert!(found.contains(expected), "{src}: {found}");
    }
}

#[test]
fn parts_are_required_where_pointing_needs_them_and_unique() {
    assert!(small_problems("<section><p>a</p></section>").contains("<section> needs a part name"));
    assert!(small_problems("<ul each=\"rows\"><li>{item.name}</li></ul>").contains("needs a part name"));
    assert!(small_problems("<Ask label=\"x\"/>").contains("<Ask> needs a part name"));
    let twice = small_problems("<div part=\"a\">x</div><div part=\"a\">y</div>");
    assert!(twice.contains("part a is used twice"), "{twice}");
    assert!(small_problems("<div part=\"Big Part\">x</div>").contains("part= is a name of a-z"));
}

#[test]
fn every_slot_names_a_field_of_the_right_type_in_its_scope() {
    let cases = [
        ("<p>{nope}</p>", "{nope}: nope is not a field of the contract"),
        ("<p>{item.name}</p>", "item is read only inside a repeat"),
        ("<p>{rows}</p>", "{rows}: is a list: repeat it with each="),
        ("<p>{flag}</p>", "is true or false"),
        ("<p>{title|date}</p>", "its format does not fit its type"),
        ("<p>{when|count:day}</p>", "its format does not fit its type"),
        ("<p>{issue.secret}</p>", "issue.secret is not a name Eos fills"),
        ("<p>{query.count}</p>", "query.… is read only inside a Live part"),
        ("<p>{title|shout}</p>", "shout is not a format"),
        ("<p>{lead.url.host}</p>", "lead.url is a url: it has no field host"),
        ("<p>{title</p>", "a slot is never closed"),
        ("<a href=\"https://example.com\">x</a>", "href= takes one slot of a url field"),
        ("<a href=\"{title}\">x</a>", "href= takes a url field"),
        ("<a href=\"javascript:alert(1)\">x</a>", "href= takes one slot of a url field"),
        ("<img src=\"https://evil/x.png\" alt=\"x\"/>", "src= takes one slot of an image field"),
        ("<p class=\"{title}\">x</p>", "a slot in class= must be an enum field"),
        ("<p style=\"color: {title}\">x</p>", "style= may not hold a slot"),
    ];
    for (src, expected) in cases {
        let found = small_problems(src);
        assert!(found.contains(expected), "{src}: {found}");
    }
    assert_eq!(
        small_problems("<p part=\"t\">{title} on {when|weekday}, {{braces}}</p><a href=\"eos:needs-you\">Open</a>"),
        ""
    );
}

#[test]
fn an_optional_field_is_used_only_under_its_guard() {
    assert!(small_problems("<p>{note}</p>").contains("{note}: note is optional"));
    assert_eq!(small_problems("<p if=\"note\">{note}</p>"), "");
    assert!(small_problems("<p unless=\"note\">{note}</p>").contains("note is optional"));
    let nested =
        small_problems("<div part=\"l\" if=\"lead\"><img src=\"{lead.image}\" alt=\"{lead.image.alt}\"/></div>");
    assert!(nested.contains("lead.image is optional"), "{nested}");
    let guarded = "<div part=\"l\" if=\"lead\"><a href=\"{lead.url}\">x</a><img if=\"lead.image\" src=\"{lead.image}\" alt=\"{lead.image.alt}\"/></div>";
    assert_eq!(small_problems(guarded), "");
    // A guard on a deeper path proves the fields above it.
    assert_eq!(small_problems("<a if=\"lead.url\" href=\"{lead.url}\">x</a>"), "");
    assert!(small_problems("<a if=\"note\" href=\"{lead.url}\">x</a>").contains("lead is optional"));
}

#[test]
fn repeats_nest_two_deep_and_a_nested_one_names_its_item() {
    let ok = "<ul part=\"r\" each=\"rows\"><li>{item.name}<span part=\"t\" each=\"item.tags\" as=\"tag\">{tag}</span></li></ul>";
    assert_eq!(small_problems(ok), "");
    let unnamed = "<ul part=\"r\" each=\"rows\"><li><span part=\"t\" each=\"item.tags\">{item}</span></li></ul>";
    assert!(small_problems(unnamed).contains("name its item with as="));
    assert!(small_problems("<ul part=\"r\" each=\"title\"><li>x</li></ul>").contains("title is not a list"));
    assert!(small_problems("<p as=\"x\">a</p>").contains("as= names a repeat's item and needs each="));
    assert!(
        small_problems("<ul part=\"r\" each=\"rows\" as=\"title\"><li>x</li></ul>")
            .contains("must be a new single name")
    );
}

#[test]
fn components_take_their_own_attributes_and_filters_need_their_repeat() {
    assert!(small_problems("<Button part=\"b\" label=\"Go\"/>").contains("<Button part=\"b\"> needs action="));
    assert!(small_problems("<Button part=\"b\" action=\"x.y\" label=\"Go\">kid</Button>").contains("holds nothing"));
    let args =
        small_problems("<Button part=\"b\" action=\"routine.run_with\" label=\"Go\" args={{\"item\": \"{nope}\"}}/>");
    assert!(args.contains("{nope}: nope is not a field"), "{args}");
    let lonely = small_problems("<Filters part=\"f\" of=\"rows\" by=\"name\"/>");
    assert!(lonely.contains("no element repeats rows with each="), "{lonely}");
    let wrong_by =
        small_problems("<Filters part=\"f\" of=\"rows\" by=\"tags\"/><ul part=\"r\" each=\"rows\"><li>x</li></ul>");
    assert!(wrong_by.contains("by=tags must be a required text or enum field"), "{wrong_by}");
    let live = "<Live part=\"d\" query=\"needs_you.summary\"><p>{query.count|count:review} wait</p></Live>";
    let template = PageTemplate::check(live, &small()).expect("a Live part reads its query");
    assert_eq!(template.queries, ["needs_you.summary"]);
}

#[test]
fn images_carry_alt_text_headings_do_not_skip_and_void_elements_hold_nothing() {
    assert!(small_problems("<img part=\"i\" if=\"lead.image\" src=\"{lead.image}\"/>").contains("needs alt="));
    assert!(small_problems("<h1>a</h1><h3>b</h3>").contains("<h3> skips a heading level: h1 comes before it"));
    assert_eq!(small_problems("<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>"), "");
    assert!(small_problems("<br>").contains("never closed"));
}

#[test]
fn problems_say_where_they_are() {
    let found = small_problems("<p>ok</p>\n  <p>{nope}</p>");
    assert!(found.starts_with("template:2:"), "{found}");
}
