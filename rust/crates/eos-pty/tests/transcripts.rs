//! The transcript reader: however the file grows or is replaced, a read
//! gives what a fresh parse of the whole file would
//! (`manager/services/__tests__/transcriptFile.test.ts`).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, SystemTime};

use eos_core::terminal::{ClaudeTranscripts, TranscriptFile};
use eos_domain::claude_transcript::{TranscriptView, transcript_view};
use eos_pty::{ClaudeTranscriptFiles, TranscriptReader};
use serde_json::{Value, json};

/// A transcript in Claude Code's shape with what the view reads: dialogs, a
/// result, turn ends, harness chatter, a torn line, a CRLF line, a line
/// longer than the reader's guard, a rewind.
fn fixture() -> Vec<String> {
    let mut n = 0;
    let mut entry = |mut e: Value| {
        n += 1;
        e["uuid"] = json!(format!("u{n}"));
        e["timestamp"] = json!(format!("2026-09-27T10:00:{:02}.000Z", n % 60));
        e["isSidechain"] = json!(false);
        e
    };
    let user = |parent: Value, content: Value| json!({ "type": "user", "parentUuid": parent, "message": { "role": "user", "content": content } });
    let assistant = |parent: Value, content: Value, stop: Value| json!({ "type": "assistant", "parentUuid": parent, "message": { "role": "assistant", "content": content, "stop_reason": stop } });
    let ask = json!({ "questions": [{ "header": "Renk", "question": "Hangisi?", "multiSelect": false, "options": [{ "label": "Kırmızı" }] }] });

    let p1 = entry(user(json!(null), json!("Merhaba — şu dosyayı düzelt 🙂")));
    let a1 = entry(assistant(
        p1["uuid"].clone(),
        json!([{ "type": "thinking", "thinking": "bakalım" }, { "type": "tool_use", "id": "t1", "name": "Edit", "input": {} }]),
        json!("tool_use"),
    ));
    let r1 = entry(user(a1["uuid"].clone(), json!([{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }])));
    let a2 = entry(assistant(r1["uuid"].clone(), json!([{ "type": "text", "text": "Düzelttim." }]), json!(null)));
    let a3 = entry(assistant(a2["uuid"].clone(), json!([{ "type": "text", "text": "Bitti." }]), json!("end_turn")));
    let end = entry(json!({ "type": "system", "subtype": "turn_duration", "parentUuid": a3["uuid"] }));
    let p2 = entry(user(a3["uuid"].clone(), json!("sor bana")));
    let a4 = entry(assistant(
        p2["uuid"].clone(),
        json!([{ "type": "tool_use", "id": "q1", "name": "AskUserQuestion", "input": ask }]),
        json!("tool_use"),
    ));
    let r2 = entry(user(
        a4["uuid"].clone(),
        json!([{ "type": "tool_result", "tool_use_id": "q1", "content": [{ "type": "text", "text": "x".repeat(10_000) }] }]),
    ));
    let a5 = entry(assistant(
        r2["uuid"].clone(),
        json!([{ "type": "tool_use", "id": "p1", "name": "ExitPlanMode", "input": { "plan": "plan" } }]),
        json!("tool_use"),
    ));
    let retry = entry(user(a3["uuid"].clone(), json!("yeniden dene")));
    let a6 =
        entry(assistant(retry["uuid"].clone(), json!([{ "type": "text", "text": "Tamam ✅" }]), json!("end_turn")));

    let mut lines: Vec<String> = [&p1, &a1, &r1].iter().map(|e| e.to_string()).collect();
    lines.push(format!("{a2}\r"));
    lines.extend([a3.to_string(), end.to_string(), r#"{"type":"user","uuid":"torn""#.to_owned()]);
    lines.extend([&p2, &a4, &r2, &a5, &retry, &a6].iter().map(|e| e.to_string()));
    lines
}

fn append(path: &Path, bytes: &[u8]) {
    OpenOptions::new().append(true).create(true).open(path).expect("the file").write_all(bytes).expect("written");
}

/// Reads through the reader and checks it against a parse of the whole file.
fn same(reader: &mut TranscriptReader, path: &Path) -> TranscriptView {
    let view = reader.read().expect("a readable file");
    assert_eq!(view, transcript_view(&String::from_utf8_lossy(&fs::read(path).expect("the file")), false));
    view
}

#[test]
fn a_growing_transcript_reads_as_a_fresh_parse_of_the_whole_file_would() {
    let dir = tempfile::tempdir().expect("a folder");
    let path = dir.path().join("t.jsonl");
    let mut reader = TranscriptReader::new(&path, false);
    assert_eq!(reader.read(), None, "no file yet");
    assert_eq!(reader.stamp(), None);
    fs::write(&path, "").expect("created");
    same(&mut reader, &path);

    let mut pending = Vec::new();
    for line in fixture() {
        // In pieces: across a multi-byte character, all but the newline, the newline.
        let bytes = format!("{line}\n").into_bytes();
        let wide = bytes.iter().position(|b| *b >= 0x80).map_or(0, |at| at + 1);
        let mut cuts = vec![wide, bytes.len() - 1, bytes.len()];
        cuts.retain(|c| *c > 0);
        cuts.dedup();
        let mut at = 0;
        for cut in cuts {
            append(&path, &bytes[at..cut]);
            at = cut;
            let view = same(&mut reader, &path);
            pending.extend(view.pending.map(|p| format!("{:?}", p.name)));
        }
    }
    assert!(pending.iter().any(|p| p == "AskUserQuestion") && pending.iter().any(|p| p == "ExitPlanMode"));
    assert!(reader.stamp().is_some_and(|(size, _)| size > 10_000));
}

#[test]
fn it_starts_over_when_the_file_is_replaced_goes_back_in_time_is_rewritten_or_cut() {
    let dir = tempfile::tempdir().expect("a folder");
    let path = dir.path().join("t.jsonl");
    let lines = fixture();
    let text = format!("{}\n", lines.join("\n"));
    fs::write(&path, &text).expect("written");
    let mut reader = TranscriptReader::new(&path, false);
    let first = same(&mut reader, &path).rows[0].clone();

    // Replaced by another file (the bytes before the read offset as they were).
    let other = dir.path().join("t.new");
    fs::write(&other, format!("{}{}\n", text.replace("Merhaba", "Selam!!"), lines[1])).expect("written");
    fs::rename(&other, &path).expect("replaced");
    assert_ne!(same(&mut reader, &path).rows[0], first);

    // Back in time.
    fs::write(&path, format!("{}{}\n", text.replace("Merhaba", "Hey!!!!"), lines[1])).expect("written");
    let old = SystemTime::now() - Duration::from_secs(86_400 * 365);
    fs::File::options().write(true).open(&path).expect("the file").set_modified(old).expect("dated");
    same(&mut reader, &path);

    // Rewritten in place and bigger: its size and time alone look like an append.
    fs::write(&path, format!("{}{}{}\n", text.replace("Merhaba", "Selam"), lines[1], lines[2])).expect("written");
    same(&mut reader, &path);

    // Cut short, then growing again.
    fs::File::options().write(true).open(&path).expect("the file").set_len(text.len() as u64 / 2).expect("cut");
    same(&mut reader, &path);
    for line in lines.iter().rev().take(4).rev() {
        append(&path, format!("{line}\n").as_bytes());
        same(&mut reader, &path);
    }
}

#[test]
fn a_transcript_lives_under_the_encoded_real_path_of_its_folder() {
    let home = tempfile::tempdir().expect("a folder");
    let project = home.path().join("My Project.v2");
    fs::create_dir(&project).expect("the project");
    let files = ClaudeTranscriptFiles::new(home.path());
    let real = fs::canonicalize(&project).expect("resolved").to_string_lossy().into_owned();
    let encoded: String =
        real.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect();
    assert_eq!(
        files.path(&project.to_string_lossy(), "abc"),
        home.path().join(".claude/projects").join(&encoded).join("abc.jsonl")
    );
    // A folder that is gone keeps its name as given.
    assert!(files.path("/gone/folder", "abc").ends_with(".claude/projects/-gone-folder/abc.jsonl"));
    assert_eq!(files.open(&project.to_string_lossy(), "abc").read(), None);
}
