//! The power report of `pmset`.

use std::process::Command;
use std::time::Duration;

use crate::power::PowerReading;
use crate::tool;

const PMSET: &str = "/usr/bin/pmset";
const TIMEOUT: Duration = Duration::from_secs(2);

/// What `pmset` reports now; `None` when it does not answer.
pub(crate) fn read() -> Option<PowerReading> {
    let batteries = tool::run_ok("pmset", Command::new(PMSET).args(["-g", "batt"]), None, TIMEOUT).ok()?;
    let settings = tool::run_ok("pmset", Command::new(PMSET).arg("-g"), None, TIMEOUT).ok()?;
    let (on_battery, battery_percent) = parse_batteries(&batteries.stdout);
    Some(PowerReading { on_battery, battery_percent, low_power: parse_low_power(&settings.stdout) })
}

/// `pmset -g batt`: where the power comes from (`Now drawing from 'Battery Power'`), then a line
/// per battery (` -InternalBattery-0 (id=…)\t80%; discharging; …`). A UPS is a battery too.
fn parse_batteries(text: &str) -> (bool, Option<u8>) {
    let source = text.lines().find_map(|line| line.strip_prefix("Now drawing from '")?.split('\'').next());
    let on_battery = source.is_some_and(|source| source != "AC Power");
    let percent = text
        .lines()
        .find(|line| line.trim_start().starts_with("-InternalBattery"))
        .and_then(|line| line.split_whitespace().find_map(|word| word.strip_suffix("%;")?.parse().ok()));
    (on_battery, percent)
}

/// `pmset -g`: the settings in use, one `name value` per line. Macs that also have High Power
/// Mode say `powermode 1` for Low Power Mode, the others `lowpowermode 1`.
fn parse_low_power(text: &str) -> bool {
    text.lines().any(|line| {
        let mut words = line.split_whitespace();
        matches!((words.next(), words.next()), (Some("lowpowermode" | "powermode"), Some("1")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON_BATTERY: &str = "Now drawing from 'Battery Power'\n \
        -InternalBattery-0 (id=36110435)\t64%; discharging; 5:21 remaining present: true\n";
    const ON_MAINS: &str = "Now drawing from 'AC Power'\n \
        -InternalBattery-0 (id=36110435)\t80%; AC attached; not charging present: true\n";
    const NO_BATTERY: &str = "Now drawing from 'AC Power'\n";
    const ON_UPS: &str = "Now drawing from 'UPS Power'\n \
        -CP1500PFCLCD (id=1234)\t95%; discharging; (no estimate) present: true\n";

    const SETTINGS: &str = "System-wide power settings:\nCurrently in use:\n \
        standby              1\n \
        sleep                1 (sleep prevented by caffeinate, powerd)\n \
        displaysleep         10\n \
        lowpowermode         LOW\n \
        womp                 1\n";

    fn settings(low_power: &str) -> String {
        SETTINGS.replace("lowpowermode         LOW", low_power)
    }

    #[test]
    fn the_battery_report_says_the_source_and_the_internal_batterys_charge() {
        assert_eq!(parse_batteries(ON_BATTERY), (true, Some(64)));
        assert_eq!(parse_batteries(ON_MAINS), (false, Some(80)));
        assert_eq!(parse_batteries(NO_BATTERY), (false, None));
        assert_eq!(parse_batteries(ON_UPS), (true, None));
        assert_eq!(parse_batteries(""), (false, None));
    }

    #[test]
    fn low_power_mode_is_read_from_the_settings_in_use() {
        assert!(parse_low_power(&settings("lowpowermode         1")));
        assert!(!parse_low_power(&settings("lowpowermode         0")));
        assert!(parse_low_power(&settings("powermode            1")));
        assert!(!parse_low_power(&settings("powermode            2")), "High Power Mode");
        assert!(!parse_low_power(&settings("")), "a Mac without the setting");
    }
}
