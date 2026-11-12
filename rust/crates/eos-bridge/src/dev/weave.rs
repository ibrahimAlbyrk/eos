//! One event stream out of two. During the transition the dashboard's stream is the
//! daemon's, but the features that already live in the Rust core announce their changes on
//! the Rust bus (a page saved, the browser's tabs). Without them the dashboard would show
//! what a Rust route changed only after a reload. So the daemon's stream is served with the
//! Rust core's `change` events woven in, frame by frame.
//!
//! The stream's ids stay the daemon's: a Rust frame goes out without its `id` line, so the
//! page's "resume after this id" is never moved by one. A Rust event that happens while
//! the page reconnects is missed; the page re-reads its state on reconnect anyway.

use std::sync::Arc;

use tokio::sync::Notify;

use crate::transport::{Body, Read, Sink};

/// A frame larger than this is not an event of ours: the buffer starts over.
const MAX_FRAME: usize = 4 << 20;

/// Splits a byte stream into event-stream frames (each ends with a blank line).
#[derive(Default)]
struct Frames {
    pending: Vec<u8>,
}

impl Frames {
    /// Takes more bytes; returns the frames now complete, each with its closing blank line.
    fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.pending.windows(2).position(|pair| pair == b"\n\n") {
            out.push(self.pending.drain(..end + 2).collect());
        }
        if self.pending.len() > MAX_FRAME {
            self.pending.clear();
        }
        out
    }
}

/// A frame of the Rust core's stream as it may join the daemon's: only a `change` event,
/// without its id. Greetings, pings and resync notices are that stream's own business.
fn foreign(frame: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(frame).ok()?;
    if !text.lines().any(|line| line == "event: change") {
        return None;
    }
    let kept: Vec<&str> = text.lines().filter(|line| !line.is_empty() && !line.starts_with("id:")).collect();
    Some(format!("{}\n\n", kept.join("\n")).into_bytes())
}

/// The next bytes of `body`; `None` at its end.
async fn next(body: &Body, buf: &mut [u8]) -> Option<usize> {
    loop {
        let ready = Arc::new(Notify::new());
        let wake = ready.clone();
        match body.read(buf, move || wake.notify_one()) {
            Read::Data(n) => return Some(n),
            Read::End => return None,
            Read::Pending => ready.notified().await,
        }
    }
}

async fn head_of(body: &Body) {
    let ready = Arc::new(Notify::new());
    let wake = ready.clone();
    body.on_head(move || wake.notify_one());
    ready.notified().await;
}

/// Serves `main` (the daemon's stream) to `sink` with the `change` frames of `extra` (the
/// Rust core's) woven in. Ends with `main`, or when the page drops the request; both
/// sources are then cancelled.
pub(crate) async fn weave(main: Body, extra: Body, sink: Sink) {
    tokio::select! {
        () = head_of(&main) => {}
        () = sink.cancelled() => {}
    }
    if let Some(head) = main.head() {
        sink.head(head);
        let (mut main_frames, mut extra_frames) = (Frames::default(), Frames::default());
        let (mut main_buf, mut extra_buf) = (vec![0u8; 16 * 1024], vec![0u8; 16 * 1024]);
        let mut extra_open = true;
        'stream: loop {
            let frames: Vec<Vec<u8>> = tokio::select! {
                read = next(&main, &mut main_buf) => match read {
                    Some(n) => main_frames.push(&main_buf[..n]),
                    None => {
                        // What the daemon sent last goes out as it is, whole frame or not.
                        let _ = sink.chunk_async(&main_frames.pending).await;
                        break;
                    }
                },
                read = next(&extra, &mut extra_buf), if extra_open => match read {
                    Some(n) => extra_frames.push(&extra_buf[..n]).iter().filter_map(|frame| foreign(frame)).collect(),
                    None => {
                        extra_open = false;
                        Vec::new()
                    }
                },
                () = sink.cancelled() => break,
            };
            for frame in frames {
                if !sink.chunk_async(&frame).await {
                    break 'stream;
                }
            }
        }
    }
    sink.end();
    main.cancel();
    extra.cancel();
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::transport::{Head, channel};

    #[test]
    fn frames_are_cut_at_blank_lines_whatever_the_chunks() {
        let mut frames = Frames::default();
        assert!(frames.push(b"id: 1\ndata: {\"a\"").is_empty());
        let out = frames.push(b":1}\n\nid: 2\ndata: x\n\n: ping\n");
        assert_eq!(out, [b"id: 1\ndata: {\"a\":1}\n\n".to_vec(), b"id: 2\ndata: x\n\n".to_vec()]);
        assert_eq!(frames.push(b"\n"), [b": ping\n\n".to_vec()]);
    }

    #[test]
    fn only_change_events_join_and_without_their_id() {
        let change = b"id: e1-7\nevent: change\ndata: {\"reason\":\"browser:tabs\",\"payload\":{}}\n\n";
        assert_eq!(
            foreign(change).as_deref(),
            Some(&b"event: change\ndata: {\"reason\":\"browser:tabs\",\"payload\":{}}\n\n"[..])
        );
        assert_eq!(foreign(b"id: e1-0\nevent: hello\ndata: {\"epoch\":\"e1\"}\n\n"), None);
        assert_eq!(foreign(b"id: e1-9\nevent: resync\ndata: {}\n\n"), None);
        assert_eq!(foreign(b": ping\n\n"), None);
    }

    #[tokio::test]
    async fn the_page_gets_the_daemons_stream_with_the_rust_events_in_it() {
        let (daemon_sink, daemon_body) = channel();
        let (rust_sink, rust_body) = channel();
        let (page_sink, page_body) = channel();
        tokio::spawn(weave(daemon_body, rust_body, page_sink));
        rust_sink.head(Head { status: 200, headers: vec![] });
        rust_sink.chunk(b"id: r-0\nevent: hello\ndata: {}\n\n");
        daemon_sink.head(Head { status: 200, headers: vec![("content-type".into(), "text/event-stream".into())] });
        // A daemon frame that arrives in two pieces, with a Rust event in between.
        daemon_sink.chunk(b"id: d-1\nevent: change\ndata: {\"reason\":");
        rust_sink.chunk(b"id: r-1\nevent: change\ndata: {\"reason\":\"browser:tabs\"}\n\n");
        tokio::time::sleep(Duration::from_millis(30)).await;
        daemon_sink.chunk(b"\"worker:change\"}\n\n");
        daemon_sink.end();

        let mut text = Vec::new();
        let mut buf = [0u8; 1024];
        while let Some(n) = next(&page_body, &mut buf).await {
            text.extend_from_slice(&buf[..n]);
        }
        let text = String::from_utf8(text).unwrap();
        assert_eq!(
            text,
            "event: change\ndata: {\"reason\":\"browser:tabs\"}\n\nid: d-1\nevent: change\ndata: {\"reason\":\"worker:change\"}\n\n"
        );
        assert_eq!(page_body.head().unwrap().header("content-type"), Some("text/event-stream"));
        // The Rust stream is let go when the daemon's ends.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(rust_sink.is_cancelled());
    }

    #[tokio::test]
    async fn a_page_that_leaves_ends_both_streams() {
        let (daemon_sink, daemon_body) = channel();
        let (rust_sink, rust_body) = channel();
        let (page_sink, page_body) = channel();
        tokio::spawn(weave(daemon_body, rust_body, page_sink));
        daemon_sink.head(Head { status: 200, headers: vec![] });
        tokio::time::sleep(Duration::from_millis(20)).await;
        page_body.cancel();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(daemon_sink.is_cancelled() && rust_sink.is_cancelled());
    }
}
