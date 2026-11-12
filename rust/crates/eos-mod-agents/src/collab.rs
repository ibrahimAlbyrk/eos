//! What agents send each other and the user: a worker's report to its
//! parent, workers consulting their peers, a banner for the user
//! (`manager/routes/workers.ts`: report, peers, peer-request, peer-response,
//! notify). An agent's tools reach the same use-cases through the methods here.

use eos_contracts::stream::topics::NOTIFICATION_FIRE;
use eos_contracts::{NotifyRequest, PeerRequestRegisterRequest, PeerResponseRequest, ReportRequest, SettingValue};
use eos_core::Error;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_sessions::{PeerAnswer, PeerAsk};
use serde_json::json;

use crate::AgentsModule;
use crate::routes::id_of;

pub(crate) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![
        report(m.clone()),
        peers(m.clone()),
        peer_request(m.clone()),
        peer_request_poll(m.clone()),
        peer_response(m.clone()),
        notify(m.clone()),
    ]
}

impl AgentsModule {
    /// `git.autoApplyOnReport`: a finished worker's work goes into the user's checkout by itself.
    fn applies_on_report(&self) -> bool {
        matches!(self.spawning.settings.read().get("git.autoApplyOnReport"), Some(SettingValue::Flag(true)))
    }

    /// A banner on the user's computer, shown while the app's window is not
    /// in front; clicking it opens `worker_id`.
    pub async fn notify_user(&self, worker_id: &str, title: &str, body: &str) -> Result<(), Error> {
        let banner = json!({"title": title, "body": body, "workerId": worker_id, "ts": self.sessions.clock().now_ms()});
        self.store
            .write(move |_, out| {
                out.push(NOTIFICATION_FIRE, &banner);
                Ok(())
            })
            .await
    }
}

fn report(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/report", move |req: Request| {
        let m = m.clone();
        async move {
            let body: ReportRequest = req.parse()?;
            let id = id_of(&req);
            let done = match m.sessions.report(&id, &body.text).await {
                Ok(done) => done,
                Err(Error::NotFound { .. }) => return Err(ApiError::NotFound("worker not found".into())),
                Err(e) => return Err(e.into()),
            };
            if done.parent_found
                && m.applies_on_report()
                && let Some(worker) = m.worker(&id).await?
            {
                crate::git::auto_apply(&m, &worker);
            }
            let mut answer = json!({"ok": true, "delivered": done.delivered});
            if let (true, Some(fields)) = (done.held, answer.as_object_mut()) {
                fields.insert("held".into(), true.into());
            }
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().local_only())
}

fn peers(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/peers", move |req: Request| {
        let m = m.clone();
        async move { Ok(Response::json(200, &m.sessions.peers_of(&id_of(&req)).await?)) }
    })
    .access(Access::open().phone(Tier::Read))
}

fn peer_request(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{fromWorker}/peer-request", move |req: Request| {
        let m = m.clone();
        async move {
            let body: PeerRequestRegisterRequest = req.parse()?;
            let from = req.param("fromWorker").unwrap_or_default();
            let answer = match m.sessions.ask_peer(from, body.target, &body.question).await? {
                PeerAsk::Registered { request_id } => json!({"requestId": request_id}),
                PeerAsk::Declined { reason } => json!({"declined": true, "reason": reason}),
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().local_only())
}

fn peer_request_poll(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{fromWorker}/peer-request/{requestId}", move |req: Request| {
        let m = m.clone();
        async move {
            let answer = match m.sessions.peer_request(req.param("requestId").unwrap_or_default()) {
                PeerAnswer::Pending => json!({"status": "pending"}),
                PeerAnswer::Answered(answer) => json!({"status": "answered", "answer": answer}),
                PeerAnswer::Declined(reason) => json!({"status": "declined", "reason": reason}),
                PeerAnswer::Gone => json!({"status": "gone"}),
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().local_only())
}

fn peer_response(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/peer-response", move |req: Request| {
        let m = m.clone();
        async move {
            let body: PeerResponseRequest = req.parse()?;
            let answer = match m.sessions.respond_to_peer(&id_of(&req), &body.answer).await? {
                Some(asker) => {
                    json!({"ok": true, "outcome": "answered", "toWorker": asker.to_worker, "toName": asker.to_name})
                }
                None => json!({"ok": true, "outcome": "none"}),
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().local_only())
}

fn notify(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/notify", move |req: Request| {
        let m = m.clone();
        async move {
            let body: NotifyRequest = req.parse()?;
            m.notify_user(&id_of(&req), &body.title, &body.body).await?;
            Ok(Response::json(200, &json!({"ok": true})))
        }
    })
    .access(Access::open().phone(Tier::Low))
}
