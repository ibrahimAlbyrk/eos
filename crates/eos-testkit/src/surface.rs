//! Surfaces as routines see them: every call recorded.

use std::sync::Mutex;

use eos_core::surface::SurfaceAuthoring;
use eos_core::{BoxFuture, Error};

/// What routines asked of surfaces, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceCall {
    Create { routine_id: String, version_id: String, makes: String },
    Keep(String),
    Archive(String),
    Restore(String),
    Remove(String),
}

#[derive(Debug, Default)]
pub struct FakeSurfaceAuthoring {
    calls: Mutex<Vec<SurfaceCall>>,
}

impl FakeSurfaceAuthoring {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn calls(&self) -> Vec<SurfaceCall> {
        self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    fn record(&self, call: SurfaceCall) -> BoxFuture<'_, Result<(), Error>> {
        self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(call);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl SurfaceAuthoring for FakeSurfaceAuthoring {
    fn create_for_routine<'a>(
        &'a self,
        routine_id: &'a str,
        version_id: &'a str,
        makes: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Create {
            routine_id: routine_id.to_owned(),
            version_id: version_id.to_owned(),
            makes: makes.to_owned(),
        })
    }

    fn keep<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Keep(routine_id.to_owned()))
    }

    fn archive_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Archive(routine_id.to_owned()))
    }

    fn restore_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Restore(routine_id.to_owned()))
    }

    fn remove_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(SurfaceCall::Remove(routine_id.to_owned()))
    }
}

/// Needs you's items for returned Views: each card opened gets the id
/// `ny-view-<n>`; a question View's run hears `answer` at once. Every card and
/// every answer recorded.
#[derive(Debug, Default)]
pub struct FakeViewCards {
    opened: Mutex<Vec<eos_core::surface::ViewCard>>,
    answered: Mutex<Vec<(String, String)>>,
    redesigns: Mutex<Vec<String>>,
    answer: Mutex<String>,
}

impl FakeViewCards {
    pub fn new() -> Self {
        Self::default()
    }

    /// What a question View's run hears.
    pub fn hearing(self, answer: &str) -> Self {
        *self.answer.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = answer.to_owned();
        self
    }

    pub fn opened(&self) -> Vec<eos_core::surface::ViewCard> {
        self.opened.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// The surfaces a "needs a redesign" item was opened for.
    pub fn redesigns(&self) -> Vec<String> {
        self.redesigns.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Each answer, as (item id, what was pressed).
    pub fn answered(&self) -> Vec<(String, String)> {
        self.answered.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl eos_core::surface::ViewCards for FakeViewCards {
    fn open_in(
        &self,
        _tx: &dyn eos_core::store::Tx,
        _out: &mut eos_core::store::Outbox,
        _now: i64,
        card: &eos_core::surface::ViewCard,
    ) -> Result<String, Error> {
        let mut opened = self.opened.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        opened.push(card.clone());
        Ok(format!("ny-view-{}", opened.len()))
    }

    fn heard<'a>(&'a self, _item_id: &'a str) -> BoxFuture<'a, String> {
        let answer = self.answer.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        Box::pin(std::future::ready(answer))
    }

    fn answer<'a>(&'a self, item_id: &'a str, pressed: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let pair = (item_id.to_owned(), pressed.to_owned());
        self.answered.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(pair);
        Box::pin(std::future::ready(Ok(())))
    }

    fn redesign_in(
        &self,
        _tx: &dyn eos_core::store::Tx,
        _out: &mut eos_core::store::Outbox,
        _now: i64,
        _routine_id: &str,
        _run_id: &str,
        surface_id: &str,
        _title: &str,
    ) -> Result<String, Error> {
        let mut redesigns = self.redesigns.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        redesigns.push(surface_id.to_owned());
        Ok(format!("ny-redesign-{}", redesigns.len()))
    }
}

/// Surface images over memory: an image source the test names gets the
/// hash it names (`"https://x/a.jpg" → "aa…"`); any other fails as
/// unreachable. Every intake and collection recorded.
#[derive(Debug, Default)]
pub struct FakeSurfaceImages {
    known: Mutex<std::collections::HashMap<String, String>>,
    taken: Mutex<Vec<(String, String)>>,
    collected: Mutex<Vec<(String, Vec<String>)>>,
}

impl FakeSurfaceImages {
    pub fn new() -> Self {
        Self::default()
    }

    /// `src` (a URL, or a run file's path) is an image with this hash.
    pub fn with(self, src: &str, hash: &str) -> Self {
        self.known.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(src.to_owned(), hash.to_owned());
        self
    }

    /// Each intake, as (surface, source).
    pub fn taken(&self) -> Vec<(String, String)> {
        self.taken.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    pub fn collected(&self) -> Vec<(String, Vec<String>)> {
        self.collected.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl eos_core::surface::SurfaceImages for FakeSurfaceImages {
    fn intake<'a>(
        &'a self,
        surface_id: &'a str,
        src: eos_core::surface::ImageSource,
    ) -> BoxFuture<'a, Result<eos_core::surface::ImageRef, eos_core::surface::ImageFailure>> {
        let key = match src {
            eos_core::surface::ImageSource::Url(url) => url,
            eos_core::surface::ImageSource::RunFile(path) => path.display().to_string(),
        };
        self.taken.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((surface_id.to_owned(), key.clone()));
        let found = self.known.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&key).cloned();
        let answer = found
            .map(|hash| eos_core::surface::ImageRef {
                hash,
                content_type: "image/jpeg".into(),
                width: 800,
                height: 450,
                bytes: 4,
            })
            .ok_or(eos_core::surface::ImageFailure::Unreachable);
        Box::pin(std::future::ready(answer))
    }

    fn read<'a>(
        &'a self,
        _surface_id: &'a str,
        hash: &'a str,
        _max_width: Option<u32>,
    ) -> BoxFuture<'a, Result<Option<eos_core::surface::StoredImage>, Error>> {
        let known = self.known.lock().unwrap_or_else(std::sync::PoisonError::into_inner).values().any(|h| h == hash);
        let image = known.then(|| eos_core::surface::StoredImage {
            content_type: "image/jpeg".into(),
            body: bytes::Bytes::from_static(b"JPEG"),
        });
        Box::pin(std::future::ready(Ok(image)))
    }

    fn collect<'a>(&'a self, surface_id: &'a str, keep: &'a [String]) -> BoxFuture<'a, Result<u64, Error>> {
        self.collected
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((surface_id.to_owned(), keep.to_vec()));
        Box::pin(std::future::ready(Ok(0)))
    }
}

/// A probe that finds what the test says at each width, or is away as
/// Eos's window can be; records every page it loaded.
#[derive(Debug)]
pub struct FakePageProbe {
    available: std::sync::atomic::AtomicBool,
    findings: Mutex<Vec<eos_core::surface::ProbeFinding>>,
    loaded: Mutex<Vec<eos_core::surface::ProbeDoc>>,
}

impl Default for FakePageProbe {
    fn default() -> Self {
        Self {
            available: std::sync::atomic::AtomicBool::new(true),
            findings: Mutex::default(),
            loaded: Mutex::default(),
        }
    }
}

impl FakePageProbe {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_available(&self, available: bool) {
        self.available.store(available, std::sync::atomic::Ordering::SeqCst);
    }

    /// Every page measured from now on finds `findings` at every width.
    pub fn finding(&self, findings: Vec<eos_core::surface::ProbeFinding>) {
        *self.findings.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = findings;
    }

    pub fn loaded(&self) -> Vec<eos_core::surface::ProbeDoc> {
        self.loaded.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl eos_core::surface::PageProbe for FakePageProbe {
    fn is_available(&self) -> bool {
        self.available.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn measure<'a>(
        &'a self,
        doc: eos_core::surface::ProbeDoc,
        widths: &'a [u16],
        shots: &'a std::path::Path,
    ) -> BoxFuture<'a, Result<Vec<eos_core::surface::ProbeWidth>, Error>> {
        let answer = if self.is_available() {
            self.loaded.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(doc);
            let findings = self.findings.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            Ok(widths
                .iter()
                .map(|width| eos_core::surface::ProbeWidth {
                    width: *width,
                    findings: findings.clone(),
                    screenshot: Some(shots.join(format!("{width}.png"))),
                })
                .collect())
        } else {
            Err(Error::Unreachable("Eos's window is not open".into()))
        };
        Box::pin(std::future::ready(answer))
    }
}
