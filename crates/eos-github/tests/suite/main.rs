//! The GitHub capability against `FakeGitHub`: sign-in, health and limits,
//! reads, reviews and the pull request source. Nothing reaches GitHub.

mod health;
mod reads;
mod reviews;
mod rig;
mod sign_in;
mod source;
mod webhooks;
