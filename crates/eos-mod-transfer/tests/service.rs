//! Everything the Transfer tab and an agent rely on, with the other computer
//! reached through the peer port and its real routes.

#![allow(clippy::unwrap_used)]

mod support;

use std::fs;
use std::sync::atomic::Ordering;

use eos_contracts::{
    AgentTransferRequest, LocalLit, MachineRef, TransferDecision, TransferOrigin, TransferOriginKind,
    TransferRecordDestReason, TransferStartRequest, TransferStatus,
};
use eos_mod_transfer::AgentTransferError;
use eos_runtime::jobs::JobStatus;
use eos_runtime::module::Module;
use indexmap::IndexMap;
use support::{Computer, HOST, OTHER, TestClock, host, pair, pair_with, s};

fn local() -> MachineRef {
    MachineRef::Local(LocalLit)
}

fn there() -> MachineRef {
    MachineRef::Text(HOST.into())
}

fn user() -> TransferOrigin {
    TransferOrigin { kind: TransferOriginKind::User, agent_id: None, agent_name: None }
}

fn pull(paths: &[std::path::PathBuf]) -> TransferStartRequest {
    TransferStartRequest { from: there(), to: local(), paths: paths.iter().map(|p| s(p)).collect(), dest_dir: None }
}

async fn start(computer: &Computer, request: TransferStartRequest) -> eos_contracts::TransferRecord {
    computer.service.start_transfer(request, user()).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn pulls_a_folder_from_the_other_computer_into_downloads_and_says_so() {
    let p = pair().await;
    let app = p.there.home.join("neon/builds/Game.app");
    fs::create_dir_all(app.join("Contents")).unwrap();
    fs::write(app.join("Contents/run"), "go").unwrap();
    let t = start(&p.here, pull(&[app])).await;
    assert_eq!(t.dest_dir, s(&p.here.home.join("Downloads/Eos")));
    assert_eq!(t.dest_reason, TransferRecordDestReason::Default);
    assert_eq!(t.status, TransferStatus::Queued);
    let done = p.here.until(&t.id.0, TransferStatus::Done).await;
    assert_eq!(fs::read_to_string(p.here.home.join("Downloads/Eos/Game.app/Contents/run")).unwrap(), "go");
    assert_eq!((done.done_bytes, done.total_bytes, done.file_count), (2, 2, 1));
    assert_eq!(done.placed.len(), 1);
    assert_eq!(done.placed[0].path, s(&p.here.home.join("Downloads/Eos/Game.app")));
    assert!(done.started_at.is_some() && done.finished_at.is_some());
    p.here.kernel.bus.flush().await;
    let banner = p.here.banners.lock().unwrap()[0].clone();
    assert_eq!(banner["title"], "Copied to MacBook Pro");
    assert_eq!(banner["body"], "Game.app · 2 B");
    assert_eq!((banner["route"].as_str(), banner["workerId"].as_str()), (Some("transfers"), Some("")));
    // It is saved: the list and a later look read it from the database.
    assert_eq!(p.here.service.list().await.unwrap()[0].status, TransferStatus::Done);
}

#[tokio::test(flavor = "multi_thread")]
async fn lands_in_the_same_project_when_this_computer_has_that_repo_keeping_the_sub_folder() {
    let p = pair().await;
    let (theirs, ours) = (p.there.home.join("neon/builds"), p.here.home.join("code/neon/builds"));
    fs::create_dir_all(&ours).unwrap();
    p.there.keys.0.lock().unwrap().insert(s(&theirs), "git:github.com/me/neon#builds".into());
    p.here.keys.0.lock().unwrap().insert(s(&ours), "git:github.com/me/neon#builds".into());
    fs::write(theirs.join("web.zip"), "zip").unwrap();
    let found = p.here.service.destination(&there(), &local(), &[s(&theirs.join("web.zip"))]).await.unwrap();
    assert_eq!(serde_json::to_value(&found).unwrap(), serde_json::json!({ "destDir": s(&ours), "reason": "project" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn copies_while_a_conflict_waits_for_the_user_then_keeps_both() {
    let p = pair().await;
    let downloads = p.here.home.join("Downloads/Eos");
    fs::create_dir_all(&downloads).unwrap();
    fs::write(downloads.join("web.zip"), "old").unwrap();
    fs::write(p.there.home.join("neon/builds/web.zip"), "new!").unwrap();
    let t = start(&p.here, pull(&[p.there.home.join("neon/builds/web.zip")])).await;
    let waiting = p.here.until(&t.id.0, TransferStatus::Conflict).await;
    assert_eq!(waiting.conflicts[0].name, "web.zip");
    assert_eq!(waiting.conflicts[0].incoming.size, 4);
    assert_eq!(waiting.done_bytes, 4, "the bytes are already here");
    // A decision for something that is no conflict is ignored.
    let decisions: IndexMap<String, TransferDecision> =
        [("web.zip".to_owned(), TransferDecision::Keep), ("other".to_owned(), TransferDecision::Replace)].into();
    let decided = p.here.service.decide(&t.id.0, decisions).await.unwrap();
    assert_eq!(decided.decisions.len(), 1);
    let done = p.here.until(&t.id.0, TransferStatus::Done).await;
    assert_eq!(fs::read_to_string(downloads.join("web.zip")).unwrap(), "old");
    assert_eq!(fs::read_to_string(downloads.join("web 2.zip")).unwrap(), "new!");
    assert_eq!(done.placed[0].name, "web 2.zip");
}

#[tokio::test(flavor = "multi_thread")]
async fn pauses_with_the_staging_kept_and_resumes_to_the_end() {
    let p = pair().await;
    fs::write(p.there.home.join("neon/a.bin"), "a".repeat(64)).unwrap();
    p.links.hold_reads.store(true, Ordering::SeqCst);
    let t = start(&p.here, pull(&[p.there.home.join("neon/a.bin")])).await;
    p.here.until(&t.id.0, TransferStatus::Copying).await;
    // The first read is on its way (and held): the staging is set up by then.
    let staging = p.here.home.join("Downloads/Eos/.eos-incoming").join(&t.id.0);
    while !staging.is_dir() {
        tokio::task::yield_now().await;
    }
    p.here.service.pause(&t.id.0).await.unwrap();
    p.links.hold_reads.store(false, Ordering::SeqCst);
    p.links.release.notify_waiters();
    p.here.until(&t.id.0, TransferStatus::Paused).await;
    assert!(staging.is_dir(), "staging kept for the resume");
    // While paused it still reads as a running job: it will go on.
    let job = p.here.kernel.jobs.list().into_iter().find(|j| j.kind == "transfer").unwrap();
    assert_eq!((job.status, job.detail.as_deref()), (JobStatus::Running, Some("Paused")));
    p.here.service.resume(&t.id.0).await.unwrap();
    p.here.until(&t.id.0, TransferStatus::Done).await;
    assert_eq!(fs::read_to_string(p.here.home.join("Downloads/Eos/a.bin")).unwrap(), "a".repeat(64));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_drops_what_was_staged() {
    let p = pair().await;
    let downloads = p.here.home.join("Downloads/Eos");
    fs::create_dir_all(&downloads).unwrap();
    fs::write(p.there.home.join("neon/a.bin"), "abc").unwrap();
    fs::write(downloads.join("a.bin"), "mine").unwrap();
    let t = start(&p.here, pull(&[p.there.home.join("neon/a.bin")])).await;
    p.here.until(&t.id.0, TransferStatus::Conflict).await;
    p.here.service.cancel(&t.id.0).await.unwrap();
    p.here.until(&t.id.0, TransferStatus::Cancelled).await;
    // The staging folder is cleared in the background once the cancel is reported.
    let staged = downloads.join(".eos-incoming");
    for _ in 0..2_000 {
        if !staged.exists() {
            break;
        }
        tokio::task::yield_now().await;
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(!staged.exists());
    assert_eq!(fs::read_to_string(downloads.join("a.bin")).unwrap(), "mine");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_that_stays_down_leaves_it_interrupted_resumable_with_a_banner() {
    let p = pair_with(vec![host(HOST, "Office", "live")], TestClock::stepping(30_000)).await;
    fs::write(p.there.home.join("neon/a.bin"), "abc").unwrap();
    // The home is asked for while the link is up; then it drops.
    let request = TransferStartRequest {
        dest_dir: Some(Some(s(&p.here.home.join("in")))),
        ..pull(&[p.there.home.join("neon/a.bin")])
    };
    p.links.down.store(true, Ordering::SeqCst);
    let t = start(&p.here, request).await;
    let stuck = p.here.until(&t.id.0, TransferStatus::Interrupted).await;
    let error = stuck.error.unwrap();
    assert_eq!((error.code.as_str(), error.message.as_str()), ("unreachable", "the link to that computer dropped"));
    p.here.kernel.bus.flush().await;
    assert_eq!(p.here.banner_titles(), ["Transfer paused"]);
    assert_eq!(
        p.here.banners.lock().unwrap()[0]["body"],
        "Office went out of reach — resume it from the Transfer tab."
    );
    // The link is back: the same transfer goes through.
    p.links.down.store(false, Ordering::SeqCst);
    p.here.service.resume(&t.id.0).await.unwrap();
    let done = p.here.until(&t.id.0, TransferStatus::Done).await;
    assert_eq!(done.error, None);
    assert_eq!(fs::read_to_string(p.here.home.join("in/a.bin")).unwrap(), "abc");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hard_failure_says_why_and_cleans_up() {
    let p = pair().await;
    let t = start(&p.here, pull(&[p.there.home.join("neon/missing.zip")])).await;
    let failed = p.here.until(&t.id.0, TransferStatus::Failed).await;
    assert_eq!(failed.error.as_ref().unwrap().code, "not-found");
    p.here.kernel.bus.flush().await;
    assert_eq!(p.here.banner_titles(), ["Transfer failed"]);
    let job = p.here.kernel.jobs.list().into_iter().find(|j| j.kind == "transfer").unwrap();
    assert_eq!(job.status, JobStatus::Failed);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agents_send_goes_to_downloads_there_and_never_replaces_anything() {
    let p = pair().await;
    // The seeded focused chat w-CHAT works in <home>/alpha.
    fs::create_dir_all(p.here.home.join("alpha")).unwrap();
    fs::write(p.here.home.join("alpha/out.zip"), "fresh").unwrap();
    let downloads = p.there.home.join("Downloads/Eos");
    fs::create_dir_all(&downloads).unwrap();
    fs::write(downloads.join("out.zip"), "theirs").unwrap();
    let request = AgentTransferRequest { machine: "office".into(), paths: vec!["out.zip".into()] };
    let t = p.here.service.send("w-CHAT", request).await.unwrap();
    assert_eq!((t.from.clone(), t.to.clone(), t.origin.agent_id.as_deref()), (local(), there(), Some("w-CHAT")));
    assert_eq!(t.dest_dir, s(&downloads));
    p.here.until(&t.id.0, TransferStatus::Done).await;
    assert_eq!(fs::read_to_string(downloads.join("out.zip")).unwrap(), "theirs");
    assert_eq!(fs::read_to_string(downloads.join("out 2.zip")).unwrap(), "fresh");
    p.here.kernel.bus.flush().await;
    assert_eq!(p.here.banners.lock().unwrap().last().unwrap()["workerId"], "w-CHAT");
    // The agent follows its own transfer, and nobody else's.
    assert_eq!(p.here.service.poll("w-CHAT", &t.id.0).await.unwrap().status, TransferStatus::Done);
    assert_eq!(p.here.service.poll("w-LONG", &t.id.0).await.unwrap_err(), AgentTransferError::NotYours);
    // The tool's two calls answer what the routes answer the same agent.
    let tools = p.here.module.agent_transfers();
    assert_eq!(tools.get("w-CHAT", &t.id.0).await.unwrap().status, TransferStatus::Done);
    let not_theirs = tools.get("w-LONG", &t.id.0).await.unwrap_err();
    assert_eq!((not_theirs.status, not_theirs.message.as_str()), (404, "not one of your transfers"));
    let unknown = tools.start("w-CHAT", " iMac ", vec!["out.zip".into()]).await.unwrap_err();
    assert_eq!(
        (unknown.status, unknown.message.as_str()),
        (400, "No paired Mac matches \"iMac\". Paired Macs: Office (online).")
    );
    let unfocused = tools.start("w-KID1", "office", vec!["out.zip".into()]).await.unwrap_err();
    assert_eq!(
        (unfocused.status, unfocused.message.as_str()),
        (403, "only a focused session can send files to another Mac")
    );
    let nothing = tools.start("w-CHAT", "office", Vec::new()).await.unwrap_err();
    assert_eq!(nothing.status, 400);
    assert!(nothing.message.starts_with("invalid request: paths:"), "{}", nothing.message);
    // Only a focused session may send at all.
    let again = AgentTransferRequest { machine: "office".into(), paths: vec!["out.zip".into()] };
    assert_eq!(p.here.service.send("w-KID1", again.clone()).await.unwrap_err(), AgentTransferError::NotFocused);
    assert_eq!(p.here.service.send("w-nobody", again).await.unwrap_err(), AgentTransferError::NotFocused);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_naming_no_paired_computer_or_an_offline_one_hears_which_there_are() {
    let hosts = vec![host(HOST, "Office", "live"), host(OTHER, "MacBook Air", "offline")];
    let p = pair_with(hosts, TestClock::real()).await;
    let ask = |machine: &str| AgentTransferRequest { machine: machine.into(), paths: vec!["x".into()] };
    let unknown = p.here.service.send("w-CHAT", ask("iMac")).await.unwrap_err().to_string();
    assert_eq!(unknown, "No paired Mac matches \"iMac\". Paired Macs: Office (online), MacBook Air (offline).");
    let offline = p.here.service.send("w-CHAT", ask("air")).await.unwrap_err().to_string();
    assert_eq!(
        offline,
        "MacBook Air isn't reachable right now (offline). Paired Macs: Office (online), MacBook Air (offline)."
    );
    // "the Mac" is the Air here; with a Pro paired too it is a question, never a guess.
    p.links.hosts.lock().unwrap().push(host(&"d".repeat(64), "MacBook Pro", "live"));
    let either = p.here.service.send("w-CHAT", ask("the mac")).await.unwrap_err().to_string();
    assert_eq!(
        either,
        "\"the mac\" could be MacBook Air or MacBook Pro — name one. Paired Macs: Office (online), MacBook Air (offline), MacBook Pro (online)."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_pair_that_is_not_this_computer_plus_one_paired_computer() {
    let p = pair().await;
    let between =
        |from: MachineRef, to: MachineRef| TransferStartRequest { from, to, paths: vec!["/x".into()], dest_dir: None };
    let two = p.here.service.start_transfer(between(there(), MachineRef::Text(OTHER.into())), user()).await;
    assert_eq!(two.unwrap_err().to_string(), "one side of a transfer must be this Mac");
    let unpaired = p.here.service.start_transfer(between(local(), MachineRef::Text(OTHER.into())), user()).await;
    assert_eq!(unpaired.unwrap_err().to_string(), "that computer isn't paired with this Mac");
    let same = p.here.service.start_transfer(between(local(), local()), user()).await;
    assert_eq!(same.unwrap_err().to_string(), "pick two different computers");
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_restart_a_transfer_that_was_running_can_be_resumed() {
    let p = pair().await;
    fs::write(p.there.home.join("neon/a.bin"), "abc").unwrap();
    p.links.hold_reads.store(true, Ordering::SeqCst);
    let t = start(&p.here, pull(&[p.there.home.join("neon/a.bin")])).await;
    p.here.until(&t.id.0, TransferStatus::Copying).await;
    // The app stops mid-copy: the run ends and the record says so.
    p.here.module.stop().await;
    let id = t.id.0.clone();
    let saved = p.here.store.port().read(move |tx| tx.transfers().get(&id)).await.unwrap().unwrap();
    assert_eq!((saved.status, saved.rate.as_f64()), (TransferStatus::Interrupted, 0.0));
    // A record a crash left as "copying" is corrected at the next start.
    let mut crashed = saved.clone();
    crashed.status = TransferStatus::Copying;
    p.here.store.port().write(move |tx, _| tx.transfers().save(&crashed)).await.unwrap();
    p.here.service.start().await.unwrap();
    assert_eq!(p.here.service.get(&t.id.0).await.unwrap().status, TransferStatus::Interrupted);
    p.links.hold_reads.store(false, Ordering::SeqCst);
    p.here.service.resume(&t.id.0).await.unwrap();
    p.here.until(&t.id.0, TransferStatus::Done).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn clears_finished_ones_from_the_list() {
    let p = pair().await;
    fs::write(p.there.home.join("neon/a.bin"), "abc").unwrap();
    let t = start(&p.here, pull(&[p.there.home.join("neon/a.bin")])).await;
    p.here.until(&t.id.0, TransferStatus::Done).await;
    assert_eq!(p.here.service.clear_finished().await.unwrap(), std::slice::from_ref(&t.id.0));
    assert!(p.here.service.list().await.unwrap().is_empty());
    assert!(p.here.service.clear_finished().await.unwrap().is_empty());
    p.here.kernel.bus.flush().await;
    assert!(p.here.kernel.jobs.list().iter().all(|j| j.kind != "transfer"), "and from the Jobs list");
}

#[tokio::test(flavor = "multi_thread")]
async fn one_transfer_runs_per_paired_computer_and_the_rest_wait() {
    let p = pair().await;
    for name in ["a.bin", "b.bin"] {
        fs::write(p.there.home.join("neon").join(name), name).unwrap();
    }
    p.links.hold_reads.store(true, Ordering::SeqCst);
    let first = start(&p.here, pull(&[p.there.home.join("neon/a.bin")])).await;
    let second = start(&p.here, pull(&[p.there.home.join("neon/b.bin")])).await;
    p.here.until(&first.id.0, TransferStatus::Copying).await;
    assert_eq!(p.here.service.get(&second.id.0).await.unwrap().status, TransferStatus::Queued);
    // A queued one pauses without ever running, and resumes into the queue.
    assert_eq!(p.here.service.pause(&second.id.0).await.unwrap().status, TransferStatus::Paused);
    assert_eq!(p.here.service.resume(&second.id.0).await.unwrap().status, TransferStatus::Queued);
    p.links.hold_reads.store(false, Ordering::SeqCst);
    p.links.release.notify_waiters();
    p.here.until(&first.id.0, TransferStatus::Done).await;
    p.here.until(&second.id.0, TransferStatus::Done).await;
    assert_eq!(fs::read_to_string(p.here.home.join("Downloads/Eos/b.bin")).unwrap(), "b.bin");
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_tree_to_the_other_computer_through_its_routes() {
    let p = pair().await;
    let app = p.here.home.join("Game.app");
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::write(app.join("Contents/MacOS/Game"), vec![7u8; 300_000]).unwrap();
    fs::write(app.join("Contents/Info.plist"), "<plist/>").unwrap();
    std::os::unix::fs::symlink("MacOS", app.join("Contents/Current")).unwrap();
    let request = TransferStartRequest { from: local(), to: there(), paths: vec![s(&app)], dest_dir: None };
    let t = start(&p.here, request).await;
    assert_eq!(t.dest_dir, s(&p.there.home.join("Downloads/Eos")), "the other computer's home, asked over the link");
    let done = p.here.until(&t.id.0, TransferStatus::Done).await;
    let out = p.there.home.join("Downloads/Eos/Game.app/Contents");
    assert_eq!(fs::read(out.join("MacOS/Game")).unwrap(), vec![7u8; 300_000]);
    assert_eq!(fs::read_link(out.join("Current")).unwrap(), std::path::Path::new("MacOS"));
    assert_eq!(done.total_bytes, 300_008);
    assert!(p.links.calls.load(Ordering::SeqCst) >= 4, "home, prepare, write, commit crossed the link");
}
