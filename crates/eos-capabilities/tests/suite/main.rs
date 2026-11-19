//! The capability service's tests as one program: the call path, its
//! limits, health, install, rollback and remove, and what routines read
//! and send through GitHub.

mod calls;
mod channels;
mod github;
mod health;
mod install;
mod limits;
mod reads;
mod rig;
mod sources;
