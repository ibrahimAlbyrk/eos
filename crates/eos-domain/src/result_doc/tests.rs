use eos_contracts::{EditOp, Part, PartEdit, ResultDoc};
use serde_json::{Map, json};

use super::*;

fn part(key: &str, role: &str, text: &str) -> Part {
    Part { key: key.into(), role: role.into(), text: text.into(), meta: Map::new() }
}

fn comment(n: usize, text: &str, line: i64) -> Part {
    let mut comment = part(&comment_key(n), "comment", text);
    comment.meta = json!({"path": "src/net.rs", "line": line, "side": "RIGHT"}).as_object().expect("an object").clone();
    comment
}

fn doc(kind: &str, parts: Vec<Part>) -> ResultDoc {
    ResultDoc { kind: kind.into(), channel: "github".into(), action: "post_review".into(), parts }
}

fn review(comments: Vec<Part>) -> ResultDoc {
    let mut parts = vec![part(EVENT, "event", "COMMENT"), part(SUMMARY, "summary", "Two small things.")];
    parts.extend(comments);
    doc(GITHUB_REVIEW, parts)
}

fn mail(paragraphs: &[&str], recipients: &[&str]) -> ResultDoc {
    let mut parts = vec![part(SUBJECT, "subject", "Weekly digest")];
    parts.extend(paragraphs.iter().enumerate().map(|(n, text)| part(&paragraph_key(n + 1), "paragraph", text)));
    parts.extend(recipients.iter().map(|id| part(&recipient_key(id), "recipient", "")));
    doc(MAIL, parts)
}

fn ops(edits: &[PartEdit]) -> Vec<(&str, EditOp)> {
    edits.iter().map(|edit| (edit.key.as_str(), edit.op)).collect()
}

#[test]
fn normalizing_unifies_line_ends_and_drops_white_space_at_line_ends_and_both_ends() {
    assert_eq!(normalize("  \r\n Fix the loop.  \r\n\r\nThen ship.\t\r  \n"), "Fix the loop.\n\nThen ship.");
    assert_eq!(normalize("a \n  b"), "a\n  b", "leading space inside the text stays");
    assert_eq!(normalize(" \n\t"), "");
}

#[test]
fn reordered_review_comments_are_the_same_review() {
    let drafted = review(vec![comment(1, "Off by one.", 42), comment(2, "Name this.", 7)]);
    let sent = review(vec![comment(2, "Name this.  ", 7), comment(1, "Off by one.\r\n", 42)]);
    assert!(equal(&drafted, &sent));
    assert_eq!(diff(&drafted, &sent), []);
    let elsewhere = review(vec![comment(1, "Off by one.", 43), comment(2, "Name this.", 7)]);
    assert_eq!(ops(&diff(&drafted, &elsewhere)), [("c:1", EditOp::Changed)], "a comment on another line");
}

#[test]
fn reordered_mail_paragraphs_are_an_edit_and_reordered_recipients_are_not() {
    let drafted = mail(&["Hello.", "Three things happened."], &["team", "lead"]);
    assert!(equal(&drafted, &mail(&["Hello.", "Three things happened."], &["team", "lead"])));
    let mut recipients_swapped = drafted.clone();
    recipients_swapped.parts.swap(3, 4);
    assert!(equal(&drafted, &recipients_swapped));
    let mut paragraphs_swapped = drafted.clone();
    paragraphs_swapped.parts.swap(1, 2);
    assert!(!equal(&drafted, &paragraphs_swapped));
    assert_eq!(ops(&diff(&drafted, &paragraphs_swapped)), [("p:2", EditOp::Moved)]);
}

#[test]
fn a_pages_fields_keep_their_order_and_a_text_is_its_body() {
    let field = |key: &str| part(key, "field", key);
    let page = doc(PAGE_ISSUE, vec![field("title"), field("stories[0].title"), field("stories[1].title")]);
    let moved = doc(PAGE_ISSUE, vec![field("stories[0].title"), field("stories[1].title"), field("title")]);
    assert!(!equal(&page, &moved));
    assert_eq!(ops(&diff(&page, &moved)), [("title", EditOp::Moved)], "the fewest parts moved");

    let text = doc(TEXT, vec![part(BODY, "body", "On my way.")]);
    assert!(equal(&text, &doc(TEXT, vec![part(BODY, "body", "On my way. \n")])));
    assert!(!equal(&text, &doc(TEXT, vec![part(BODY, "body", "On my way!")])));
    let mut by_mail = text.clone();
    by_mail.channel = "mail".into();
    assert!(!equal(&text, &by_mail), "another channel is another result");
}

#[test]
fn a_diff_names_each_part_that_went_came_changed_or_moved() {
    let field = |key: &str, text: &str| part(key, "field", text);
    let before = doc(PAGE_ISSUE, vec![field("a", "A"), field("b", "B"), field("c", "C"), field("d", "D")]);
    let after = doc(PAGE_ISSUE, vec![field("c", "C"), field("a", "A"), field("b", "B2"), field("e", "E")]);
    let edits = diff(&before, &after);
    assert_eq!(
        ops(&edits),
        [("d", EditOp::Removed), ("c", EditOp::Moved), ("b", EditOp::Changed), ("e", EditOp::Added)],
        "removed first, then in the new order"
    );
    assert_eq!((edits[0].before.as_ref(), edits[0].after.as_ref()), (Some(&field("d", "D")), None));
    assert_eq!((edits[2].before.as_ref(), edits[2].after.as_ref()), (Some(&field("b", "B")), Some(&field("b", "B2"))));
    assert_eq!((edits[3].before.as_ref(), edits[3].after.as_ref()), (None, Some(&field("e", "E"))));

    let reviewed = review(vec![comment(1, "Off by one.", 42), comment(2, "Name this.", 7)]);
    let mut kept_one = review(vec![comment(2, "Name this better.", 7)]);
    kept_one.parts.swap(0, 1);
    assert_eq!(
        ops(&diff(&reviewed, &kept_one)),
        [("c:1", EditOp::Removed), ("summary", EditOp::Moved), ("c:2", EditOp::Changed)],
        "sending one of two comments removes the other"
    );
    let mut moved_and_changed = before.clone();
    moved_and_changed.parts = vec![field("b", "B"), field("c", "C"), field("d", "D"), field("a", "A!")];
    assert_eq!(ops(&diff(&before, &moved_and_changed)), [("a", EditOp::Changed)]);
}

#[test]
fn a_page_issue_is_its_fields_by_path_in_order_and_names_its_issue() {
    let data = json!({"title": "Morning", "stories": [{"title": "One", "score": 3}, {"title": "Two", "image": null}]});
    let page = page_issue_doc(("sf-1", "si-1"), &data, true, "mail", "send_mail");
    let keys: Vec<&str> = page.parts.iter().map(|part| part.key.as_str()).collect();
    assert_eq!(keys, ["title", "stories[0].title", "stories[0].score", "stories[1].title", ISSUE_PART]);
    assert_eq!(page.parts[2].text, "3");
    assert_eq!(issue_of(&page), Some(("si-1", true)));
    assert_eq!(issue_of(&page_issue_doc(("sf-1", "si-2"), &data, false, "mail", "send_mail")), Some(("si-2", false)));
    assert!(names_recipients(PAGE_ISSUE) && names_recipients(MAIL) && !names_recipients(TEXT));
    let mut to = page.clone();
    to.parts.push(part(&recipient_key("b"), "recipient", "b@example.com"));
    to.parts.insert(0, part(&recipient_key("a"), "recipient", "a@example.com"));
    let mut swapped = to.clone();
    let last = swapped.parts.len() - 1;
    swapped.parts.swap(0, last);
    assert!(diff(&to, &swapped).is_empty(), "a page's recipients are a set");
}
