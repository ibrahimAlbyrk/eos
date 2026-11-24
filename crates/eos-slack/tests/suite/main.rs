//! The Slack capability against `FakeSlack`: errors and limits, health,
//! the PKCE sign-in and rotating tokens, reads, posts and the two sources.
//! Nothing reaches Slack.

mod health;
mod rig;
mod sends;
mod sign_in;
mod source;
