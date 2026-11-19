//! What a test's own thread logs, kept as text for the test to scan.

use std::io;
use std::sync::{Arc, Mutex};

use tracing::subscriber::DefaultGuard;

/// Every event logged on this thread while it lives; a `current_thread`
/// test sees all its service code logs.
pub struct LogCapture {
    text: Arc<Mutex<Vec<u8>>>,
    _guard: DefaultGuard,
}

impl LogCapture {
    pub fn start() -> Self {
        let text = Arc::new(Mutex::new(Vec::new()));
        let writer = Writer(text.clone());
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish();
        Self { text, _guard: tracing::subscriber::set_default(subscriber) }
    }

    /// The log so far.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.text.lock().unwrap_or_else(|p| p.into_inner())).into_owned()
    }
}

impl std::fmt::Debug for LogCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LogCapture").finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct Writer(Arc<Mutex<Vec<u8>>>);

impl io::Write for Writer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
