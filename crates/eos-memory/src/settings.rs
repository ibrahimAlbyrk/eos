//! The user's two switches, kept in `mem_settings`: Learning (whether new
//! notes are made) and Reminders (whether notes go in front of agents). Both
//! are on until the user turns one off.

use eos_contracts::ExperienceSettings;
use eos_core::Error;
use eos_core::store::Tx;

const LEARNING: &str = "learning";
const REMINDERS: &str = "reminders";

fn switch(tx: &dyn Tx, key: &str) -> Result<bool, Error> {
    Ok(tx.mem_book().setting(key)?.is_none_or(|value| value != "off"))
}

pub fn read_in(tx: &dyn Tx) -> Result<ExperienceSettings, Error> {
    Ok(ExperienceSettings { learning: switch(tx, LEARNING)?, reminders: switch(tx, REMINDERS)? })
}

pub fn write_in(tx: &dyn Tx, settings: ExperienceSettings) -> Result<(), Error> {
    let word = |on: bool| if on { "on" } else { "off" };
    tx.mem_book().set_setting(LEARNING, word(settings.learning))?;
    tx.mem_book().set_setting(REMINDERS, word(settings.reminders))
}
