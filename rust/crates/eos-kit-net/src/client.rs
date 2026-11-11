use std::time::Duration;

use crate::error::Error;

#[derive(Debug, Clone)]
pub struct ClientOptions {
    pub user_agent: String,
    pub connect_timeout: Duration,
    /// A deadline for every request of this client; `None` leaves it to each request.
    pub timeout: Option<Duration>,
    /// Idle connections kept per host, and for how long.
    pub pool_max_idle_per_host: usize,
    pub pool_idle_timeout: Duration,
}

impl ClientOptions {
    pub fn new(user_agent: impl Into<String>) -> Self {
        Self {
            user_agent: user_agent.into(),
            connect_timeout: Duration::from_secs(10),
            timeout: None,
            pool_max_idle_per_host: 8,
            pool_idle_timeout: Duration::from_secs(90),
        }
    }
}

pub(crate) fn builder(options: &ClientOptions) -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder()
        .user_agent(options.user_agent.clone())
        .connect_timeout(options.connect_timeout)
        .pool_max_idle_per_host(options.pool_max_idle_per_host)
        .pool_idle_timeout(options.pool_idle_timeout)
        // As today: requests go out directly, whatever HTTP_PROXY says.
        .no_proxy();
    if let Some(timeout) = options.timeout {
        builder = builder.timeout(timeout);
    }
    builder
}

/// A client for ordinary API traffic: TLS through rustls with the system's
/// roots, HTTP/2 where offered, gzip/brotli/deflate decoded, redirects followed.
pub fn http_client(options: &ClientOptions) -> Result<reqwest::Client, Error> {
    builder(options).build().map_err(|e| Error::Client(e.to_string()))
}
