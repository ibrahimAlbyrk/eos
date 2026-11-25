//! The app's tests as one program: each file in this folder is a module, so a build links the
//! whole app once instead of once per file. A test that needs the process to itself, or that a
//! script runs by name, is a file of its own beside this folder.

#[path = "../support/capabilities.rs"]
mod planted;
#[path = "../support/rig.rs"]
mod rig;
#[path = "../support/routines.rs"]
mod routines_rig;

mod agent_smoke;
mod boot;
mod capabilities;
mod crash;
mod first_run;
mod flows;
mod injection;
mod injection_pages;
mod injection_sending;
mod isolation;
mod machines;
mod memory;
mod notes;
mod peer;
mod phone;
mod plan_switch;
mod reach;
mod read_path;
mod result_shape;
mod routine_e2e;
mod routine_failures;
mod routines;
mod samples;
mod skeleton;
mod upgrade;
