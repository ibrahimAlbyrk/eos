//! The Jobs tab's routes. All the dashboard's: a job's output is a command's
//! output, and stopping it acts on an agent's work.
//!
//! ```text
//! GET  /api/jobs                  every job, running first
//! GET  /api/jobs/:id/output       ?since=<offset> — the output after it
//! POST /api/jobs/:id/stop         stop a running job (through its source)
//! POST /api/jobs/:id/dismiss      drop a finished job
//! POST /api/jobs/clear            drop every finished job
//! ```

use serde::Serialize;

use super::{BackgroundJob, JobActionResult, JobRegistry};
use crate::access::Access;
use crate::http::path::percent_decode;
use crate::http::{ApiError, Request, Response};
use crate::router::RouteDef;

#[derive(Serialize)]
struct JobList {
    jobs: Vec<BackgroundJob>,
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

/// The job id of the path; one that does not decode names no job.
fn job_id(req: &Request) -> String {
    req.param("id").and_then(percent_decode).map(|id| id.into_owned()).unwrap_or_default()
}

/// `Math.max(0, parseInt(text, 10) || 0)`.
fn offset(text: &str) -> u64 {
    let digits: String = text.trim_start().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap_or(if digits.is_empty() { 0 } else { u64::MAX })
}

fn answered(result: JobActionResult) -> Result<Response, ApiError> {
    match result {
        Ok(()) => Ok(Response::json(200, &Done { ok: true })),
        Err(refused) => Err(ApiError::status_with(refused.status, refused.error)),
    }
}

pub fn routes(jobs: JobRegistry) -> Vec<RouteDef> {
    let list = {
        let jobs = jobs.clone();
        move |_req: Request| {
            let body = JobList { jobs: jobs.list() };
            async move { Ok(Response::json(200, &body)) }
        }
    };
    let output = {
        let jobs = jobs.clone();
        move |req: Request| {
            let jobs = jobs.clone();
            async move {
                let since = req.query().get("since").map_or(0, |s| offset(&s));
                let id = job_id(&req);
                // A job's output can be a file: read it off the async threads.
                let out = tokio::task::spawn_blocking(move || jobs.output(&id, since))
                    .await
                    .map_err(|e| ApiError::Internal(e.to_string()))?;
                let out = out.ok_or_else(|| ApiError::NotFound("no output for that job".into()))?;
                Ok(Response::json(200, &out))
            }
        }
    };
    let stop = {
        let jobs = jobs.clone();
        move |req: Request| {
            let jobs = jobs.clone();
            async move { answered(jobs.stop(&job_id(&req)).await) }
        }
    };
    let dismiss = {
        let jobs = jobs.clone();
        move |req: Request| {
            let result = jobs.dismiss(&job_id(&req));
            async move { answered(result) }
        }
    };
    let clear = move |_req: Request| {
        jobs.clear_finished();
        async move { Ok(Response::json(200, &Done { ok: true })) }
    };
    vec![
        RouteDef::get("/api/jobs", list).access(Access::ui_token()),
        RouteDef::get("/api/jobs/{id}/output", output).access(Access::ui_token()),
        RouteDef::post("/api/jobs/{id}/stop", stop).access(Access::ui_token()),
        RouteDef::post("/api/jobs/{id}/dismiss", dismiss).access(Access::ui_token()),
        RouteDef::post("/api/jobs/clear", clear).access(Access::ui_token()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_offset_reads_as_parse_int_does() {
        assert_eq!(offset("13"), 13);
        assert_eq!(offset(" 7abc"), 7);
        assert_eq!(offset("abc"), 0);
        assert_eq!(offset("-5"), 0);
        assert_eq!(offset(""), 0);
    }
}
