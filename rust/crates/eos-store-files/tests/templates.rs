//! The template folder, as `manager/services/__tests__/UserTemplateService.test.ts` pins it.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use eos_contracts::{Template, TemplateAttachment, TemplateAttachmentKind, TemplateName};
use eos_core::store::TemplateStore;
use eos_store_files::templates::FsTemplateStore;
use eos_testkit::{FakeClock, TempHome};

fn store(home: &TempHome) -> FsTemplateStore {
    // 2026-01-01T09:30:00.125Z
    FsTemplateStore::new(home.join("templates"), Arc::new(FakeClock::at(1_767_259_800_125)))
}

fn template(name: &str, description: &str, content: &str) -> Template {
    Template {
        name: TemplateName(name.into()),
        description: description.into(),
        content: content.into(),
        attachments: vec![],
    }
}

fn attach(label: &str, kind: TemplateAttachmentKind, path: &Path) -> TemplateAttachment {
    TemplateAttachment { label: label.into(), kind, path: path.to_string_lossy().into_owned() }
}

fn read(store: &FsTemplateStore, name: &str) -> Template {
    store.list().expect("lists").into_iter().find(|t| t.name.0 == name).expect("the template")
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        fs::read_dir(dir).expect("a folder").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn a_template_is_a_markdown_file_that_reads_back() {
    let home = TempHome::new();
    let store = store(&home);
    assert_eq!(store.list().expect("lists"), vec![], "no folder yet");

    store.write(&template("bug-fix", "repro & fix", "\n  Fix {{file}}.\nRepro: {{steps}}  \n")).expect("writes");
    assert_eq!(
        home.read("templates/bug-fix.md"),
        "---\ndescription: repro & fix\n---\n\nFix {{file}}.\nRepro: {{steps}}\n"
    );
    assert_eq!(read(&store, "bug-fix"), template("bug-fix", "repro & fix", "Fix {{file}}.\nRepro: {{steps}}"));
    assert!(store.exists("bug-fix").expect("checks"));
    assert!(!store.exists("other").expect("checks"));

    // A save replaces; the list is by name; a hostile description survives.
    store.write(&template("b", "", "one")).expect("writes");
    store.write(&template("a", "", "x")).expect("writes");
    store.write(&template("b", "updated", "two-v2")).expect("writes");
    let hostile = "a: b # c\n- d \"quoted\" 'single' {x}";
    store.write(&template("tricky", hostile, "body")).expect("writes");
    let listed = store.list().expect("lists");
    assert_eq!(listed.iter().map(|t| t.name.0.as_str()).collect::<Vec<_>>(), ["a", "b", "bug-fix", "tricky"]);
    assert_eq!((listed[1].description.as_str(), listed[1].content.as_str()), ("updated", "two-v2"));
    assert_eq!(listed[3].description, hostile);
}

#[test]
fn hand_written_files_are_read_leniently() {
    let home = TempHome::new();
    let store = store(&home);
    home.write("templates/plain.md", "just a prompt\n");
    home.write("templates/broken.md", "---\ndescription: [unclosed\n---\nstill the prompt\n");
    home.write("templates/crlf.md", "---\r\ndescription: windows\r\n---\r\nbody\r\n");
    home.write("templates/Has Spaces.md", "skipped: the name is not a template name");
    home.write("templates/notes.txt", "not a template");
    let listed = store.list().expect("lists");
    assert_eq!(
        listed,
        [
            template("broken", "", "still the prompt"),
            template("crlf", "windows", "body"),
            template("plain", "", "just a prompt")
        ]
    );
    for bad in ["../escape", "Has Spaces", "UPPER", ""] {
        assert!(store.exists(bad).is_err(), "{bad:?}");
        assert!(store.delete(bad).is_err(), "{bad:?}");
        assert!(store.write(&template(bad, "", "x")).is_err(), "{bad:?}");
    }
}

#[test]
fn deleting_moves_the_file_and_its_assets_to_the_trash() {
    let home = TempHome::new();
    let store = store(&home);
    let shot = home.write("elsewhere/shot.png", "PNGBYTES");
    let mut doomed = template("doomed", "", "body");
    doomed.attachments = vec![attach("[shot.png]", TemplateAttachmentKind::Image, &shot)];
    store.write(&doomed).expect("writes");
    assert!(home.join("templates/assets/doomed/shot.png").exists());

    assert_eq!(store.delete("doomed"), Ok(true));
    assert_eq!(store.delete("doomed"), Ok(false));
    assert_eq!(store.list().expect("lists"), vec![]);
    assert_eq!(names(&home.join("templates/.trash")), ["assets", "doomed.2026-01-01T09-30-00-125.md"]);
    assert_eq!(names(&home.join("templates/.trash/assets")), ["doomed.2026-01-01T09-30-00-125"]);
    assert!(!home.join("templates/assets/doomed").exists());
}

#[test]
fn attached_files_are_copied_once_and_stored_relative() {
    let home = TempHome::new();
    let store = store(&home);
    let shot = home.write("tmp/shot.png", "PNGBYTES");
    let mut with_image = template("with-img", "d", "body");
    with_image.attachments = vec![attach("[shot.png]", TemplateAttachmentKind::Image, &shot)];
    store.write(&with_image).expect("writes");
    assert_eq!(
        home.read("templates/with-img.md"),
        "---\ndescription: d\nattachments:\n  - label: \"[shot.png]\"\n    kind: image\n    path: assets/with-img/shot.png\n---\n\nbody\n"
    );
    let saved = read(&store, "with-img");
    let durable = home.join("templates/assets/with-img/shot.png");
    assert_eq!(saved.attachments, [attach("[shot.png]", TemplateAttachmentKind::Image, &durable)]);
    assert_eq!(fs::read_to_string(&durable).expect("the copy"), "PNGBYTES");

    // Saving what was read does not copy again.
    store.write(&saved).expect("writes");
    assert_eq!(names(&home.join("templates/assets/with-img")), ["shot.png"]);

    // Another file of the same name gets a number; a folder is kept as a reference; a vanished source is dropped.
    let other = home.write("other/shot.png", "OTHER");
    let folder = home.join("some-folder");
    fs::create_dir_all(&folder).expect("a folder");
    let mut more = saved.clone();
    more.attachments.push(attach("[shot.png]", TemplateAttachmentKind::File, &other));
    more.attachments.push(attach("[folder]", TemplateAttachmentKind::Folder, &folder));
    more.attachments.push(attach("[gone]", TemplateAttachmentKind::File, &home.join("gone.txt")));
    store.write(&more).expect("writes");
    assert_eq!(names(&home.join("templates/assets/with-img")), ["shot-2.png", "shot.png"]);
    let paths: Vec<String> = read(&store, "with-img").attachments.into_iter().map(|a| a.path).collect();
    assert_eq!(
        paths,
        [
            durable.to_string_lossy().into_owned(),
            home.join("templates/assets/with-img/shot-2.png").to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned()
        ]
    );
}
