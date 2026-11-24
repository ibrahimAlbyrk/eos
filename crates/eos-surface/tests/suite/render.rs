use std::collections::HashMap;

use eos_surface::render::{
    Comfort, ImageState, IssueFacts, Mode, RenderInput, frame_csp, frame_document, render_body, runtime_hash,
};
use serde_json::Value;

use crate::paper;

pub(crate) fn facts() -> IssueFacts {
    IssueFacts { id: "si-000000000041".into(), seq: Some(41), date: "2026-11-17".into(), reader: "Ibrahim".into() }
}

pub(crate) fn images() -> HashMap<String, ImageState> {
    HashMap::from([("https://example.com/replays.jpg".to_owned(), ImageState::Ready { hash: "a".repeat(64) })])
}

pub(crate) fn secret(text: &str) -> bool {
    text.contains("ghp_")
}

pub(crate) fn render(data: &Value, mode: Mode) -> String {
    let design = paper::design();
    let facts = facts();
    let images = images();
    let live = HashMap::new();
    let input = RenderInput {
        design: &design,
        data,
        issue: &facts,
        images: &images,
        image_src: &|hash| Some(format!("http://raw.eos.localhost/surfaces/sf-1/img/{hash}")),
        live: &live,
        is_secret: &secret,
        offset: 180,
        lang: "en",
        title: "Morning Paper",
        comfort: Comfort::default(),
    };
    render_body(&input, mode)
}

#[test]
fn the_sample_renders_in_the_frame_as_stored() {
    paper::golden("frame.body.html", &render(&paper::json("sample.json"), Mode::Frame));
}

#[test]
fn each_issue_renders_in_the_frame_as_stored() {
    for n in 1..=3 {
        paper::golden(
            &format!("issue-{n}.frame.body.html"),
            &render(&paper::json(&format!("issue-{n}.json")), Mode::Frame),
        );
    }
}

#[test]
fn the_frame_marks_parts_rows_filters_and_buttons_for_the_runtime() {
    let html = render(&paper::json("sample.json"), Mode::Frame);
    assert!(html.contains("<header data-part=\"masthead\">"));
    assert!(html.contains("data-part=\"story\" data-index=\"2\""), "{html}");
    assert!(html.contains("data-filter-of=\"stories\" data-filter-value=\"tools\""));
    assert!(html.contains("<button type=\"button\" data-filter=\"live-ops\" aria-pressed=\"false\">live-ops</button>"));
    assert!(html.contains(
        "<button type=\"button\" class=\"eos-button\" data-button=\"good\" data-part=\"good\">Good issue</button>"
    ));
    assert!(html.contains("class=\"eos-ask\" data-ask=\"ask\" data-part=\"ask\" data-index=\"1\""));
    assert!(html.contains("Tuesday 17 November 2026"));
    assert!(html.contains("<time datetime=\"2026-11-17T04:10:00Z\">07:10</time>"), "times read in the reader's offset");
    assert!(html.contains("src=\"http://raw.eos.localhost/surfaces/sf-1/img/aaaa"));
    assert!(html.contains("<a href=\"eos:needs-you\" rel=\"noopener noreferrer\">Open Needs you</a>"));
    assert!(html.contains("can you reproduce it&quot; to &quot;which frame&quot;.<br><br>Two of the three"));
}

#[test]
fn outside_text_is_always_text_and_a_secret_is_masked() {
    let html = render(&paper::json("issue-3.json"), Mode::Frame);
    assert!(!html.contains("<script"), "{html}");
    assert!(!html.contains("<img src=x"), "{html}");
    assert!(!html.contains("<b>bold"));
    assert!(!html.contains("javascript:alert(1)\""), "a javascript: url is never a link");
    assert!(
        html.contains(
            "&lt;script&gt;alert(&#39;lead&#39;)&lt;/script&gt; &quot;&gt;&lt;img src=x onerror=alert(1)&gt;"
        )
    );
    assert!(html.contains("{lead.title} is not a slot here"), "a brace in data is not read again");
    assert!(html.contains("<bdi>"), "a direction mark is isolated");
    assert!(html.contains("&amp;amp; stays as written"));
    assert!(!html.contains("ghp_"), "{html}");
    assert!(html.contains("<span class=\"eos-secret\" title=\"hidden: looks like a secret\">••••</span>"));
    assert!(html.contains("href=\"https://example.com/?a=1&amp;b=&lt;2&gt;\""));
}

#[test]
fn a_missing_image_draws_its_alt_text_and_an_absent_optional_part_is_left_out() {
    let mut data = paper::json("sample.json");
    data["lead"]["image"]["src"] = "https://example.com/gone.jpg".into();
    let html = render(&data, Mode::Frame);
    assert!(html.contains(
        "<span class=\"eos-image-missing\" role=\"img\" aria-label=\"A level editor with an input timeline\">"
    ));
    let quiet = render(&paper::json("issue-2.json"), Mode::Frame);
    assert!(!quiet.contains("lead-image") && !quiet.contains("left-out"));
}

#[test]
fn the_frame_document_admits_only_the_runtime_and_loads_nothing() {
    let design = paper::design();
    let facts = facts();
    let images = images();
    let live = HashMap::new();
    let data = paper::json("sample.json");
    let input = RenderInput {
        design: &design,
        data: &data,
        issue: &facts,
        images: &images,
        image_src: &|hash| Some(format!("http://raw.eos.localhost/surfaces/sf-1/img/{hash}")),
        live: &live,
        is_secret: &secret,
        offset: 0,
        lang: "en",
        title: "Morning <Paper>",
        comfort: Comfort { text_scale: 130, more_contrast: false },
    };
    let doc = frame_document(&input, "sf-1");
    let csp = frame_csp("sf-1");
    assert!(csp.contains(&format!("script-src 'sha256-{}'", runtime_hash())));
    assert!(csp.contains("connect-src 'none'") && csp.contains("default-src 'none'"));
    assert!(doc.contains("<title>Morning &lt;Paper&gt;</title>"));
    assert_eq!(doc.matches("<script>").count(), 1, "only the runtime");
    assert!(doc.contains("font-family:'Fraunces'") && doc.contains("font-family:'Geist'"));
    assert!(!doc.contains("font-family:'Source Serif 4'"), "a face the page does not name is not inlined");
    assert!(doc.contains(".eos-page{zoom:130%}"));
    for line in doc.split(['"', '(', ' ']) {
        assert!(!line.starts_with("https://fonts") && !line.starts_with("url(http"), "{line}");
    }
}

fn input_for<'a>(
    design: &'a eos_surface::PageDesign,
    data: &'a Value,
    facts: &'a IssueFacts,
    images: &'a HashMap<String, ImageState>,
    live: &'a HashMap<String, Value>,
    image_src: &'a dyn Fn(&str) -> Option<String>,
) -> RenderInput<'a> {
    RenderInput {
        design,
        data,
        issue: facts,
        images,
        image_src,
        live,
        is_secret: &secret,
        offset: 180,
        lang: "en",
        title: "Morning Paper",
        comfort: Comfort::default(),
    }
}

#[test]
fn the_phone_and_share_documents_run_no_script_and_load_nothing() {
    let design = paper::design();
    let (data, facts, images, live) = (paper::json("sample.json"), facts(), images(), HashMap::new());
    let data_uri = |_: &str| Some("data:image/jpeg;base64,AAAA".to_owned());
    let input = input_for(&design, &data, &facts, &images, &live, &data_uri);
    let phone = eos_surface::render::phone_document(&input);
    assert!(!phone.contains("<script"), "no script on the phone");
    assert!(phone.contains(&eos_surface::render::PHONE_CSP.replace('\'', "&#39;")));
    assert!(phone.contains(
        "<a class=\"eos-button\" href=\"eos-action:si-000000000041/good/\" data-part=\"good\">Good issue</a>"
    ));
    assert!(phone.contains("href=\"eos-action:si-000000000041/ask/1\""));
    assert!(phone.contains("<a href=\"eos://needs-you\""));
    assert!(!phone.contains("data-filters="), "filters are left out");
    assert!(phone.contains("src=\"data:image/jpeg;base64,AAAA\""));
    let share = eos_surface::render::share_document(&input);
    assert!(!share.contains("<script") && !share.contains("eos-action:") && !share.contains("class=\"eos-button\""));
    paper::golden("phone.body.html", &render(&data, Mode::Phone));
    paper::golden("share.body.html", &render(&data, Mode::Share));
}

#[test]
fn the_mail_is_one_column_with_every_style_inline_and_a_text_part() {
    let design = paper::design();
    let (data, facts, images, live) = (paper::json("sample.json"), facts(), images(), HashMap::new());
    let cid = |hash: &str| Some(format!("cid:{}", &hash[..12]));
    let input = input_for(&design, &data, &facts, &images, &live, &cid);
    let mail = eos_surface::render::mail_body(&input);
    assert!(!mail.html.contains("<style") && !mail.html.contains("<script") && !mail.html.contains("class="));
    assert!(mail.html.contains("max-width:640px"));
    assert!(
        !mail.html.contains("display:flex")
            && !mail.html.contains("display:grid")
            && !mail.html.contains("grid-template")
    );
    assert!(!mail.html.contains("Fraunces"), "web fonts are replaced by their stacks");
    assert!(
        mail.html.contains("font-family:Georgia, 'Times New Roman', serif")
            || mail.html.contains("font-family:Georgia,"),
        "{}",
        mail.html
    );
    assert!(mail.html.contains("src=\"cid:aaaaaaaaaaaa\""));
    assert!(mail.html.contains("<a href=\"eos://issue/si-000000000041?button=good\">Good issue · Open in Eos</a>"));
    assert!(mail.html.contains("eos://issue/si-000000000041?button=ask&amp;index=0"));
    assert!(!mail.html.contains("clamp("), "mail clients drop clamp()");
    assert!(!mail.html.contains("data-part"));
    paper::golden("mail.html", &mail.html);
    paper::golden("mail.txt", &mail.text);
    assert!(
        mail.text.contains("Deterministic replays are back in fashion for puzzle games <https://example.com/replays>")
    );
    assert!(mail.text.contains("- A talk on pacing procedural levels, now with slides. <https://example.com/pacing>"));
    assert!(!mail.text.contains('<') || !mail.text.contains("<span"));
}

#[test]
fn the_text_part_masks_secrets_and_keeps_outside_text_as_written() {
    let design = paper::design();
    let (data, facts, images, live) = (paper::json("issue-3.json"), facts(), images(), HashMap::new());
    let none = |_: &str| None;
    let mail = eos_surface::render::mail_body(&input_for(&design, &data, &facts, &images, &live, &none));
    assert!(!mail.text.contains("ghp_") && mail.text.contains("••••"));
    assert!(mail.text.contains("<script>alert('lead')</script>"), "text is text in a text part");
    assert!(!mail.html.contains("<script>alert"));
}
