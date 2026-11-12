//! What the shell tells Chromium at launch: command line switches and feature lists.
//!
//! Plain data, so it is tested without building CEF. Two rules, both from measurements
//! (`rust/README.md`, "Memory"):
//!
//! - every switch is spelled `--name`. The runtime hands a bare name without a value to
//!   Chromium as a positional argument, where it does nothing and nothing says so: that is
//!   how the component updater stayed on in the shell gate and cost 51 MB;
//! - features go through the two feature lists, never through a raw `--enable-features` /
//!   `--disable-features` switch, which would replace the lists CEF itself needs.

use std::path::PathBuf;

/// Chromium features that make it look for devices on the local network by itself. macOS
/// answers any such traffic with a "find devices on local networks" prompt in the app's name.
const NO_LOCAL_DISCOVERY: [&str; 4] =
    ["WebRtcHideLocalIpsWithMdns", "MediaRouter", "DialMediaRouteProvider", "CastMediaRouteProvider"];

/// A renderer Chromium keeps warm for the next view: 25 MB and one process at all times,
/// against about 130 ms on the first load of a new view. Electron runs without it.
const SPARE_RENDERER: &str = "SpareRendererForSitePerProcess";

/// The network stack inside the browser process: one process and about 14 MB less, but a
/// crash in network code then takes the app down and the stack loses its own sandbox.
const NETWORK_IN_PROCESS: &str = "NetworkServiceInProcess2";

/// The choices a launch can make.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tuning {
    /// An automated run: no sound.
    pub mute_audio: bool,
    /// Run the network service inside the browser process. Off unless asked for: it trades
    /// crash isolation for memory.
    pub network_in_process: bool,
    /// Keep painting while the window is covered by other windows. For measurements only:
    /// a covered window that stops painting reads far lower than a visible one.
    pub paint_when_covered: bool,
    /// Diagnostics: write every request Chromium makes to this file.
    pub net_log: Option<PathBuf>,
}

/// What Chromium is started with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// Switches as `(--name, value)`.
    pub switches: Vec<(String, Option<String>)>,
    pub disable_features: Vec<&'static str>,
    pub enable_features: Vec<&'static str>,
}

pub fn launch(tuning: &Tuning) -> Launch {
    let flag = |name: &str| (name.to_string(), None);
    let mut switches = vec![
        // WebRTC may only use a configured proxy: no host candidates, so no mDNS names and
        // no probing of the LAN from a page.
        ("--force-webrtc-ip-handling-policy".to_string(), Some("disable_non_proxied_udp".to_string())),
        // The app is not a browser: no update checks, reports or pings behind the user's
        // back (Electron made none). The component updater alone costs 51 MB in the browser
        // process, 135 MB on disk and traffic to Google's update servers; without it there
        // is no Widevine and no component refresh between app releases, as in Electron.
        flag("--disable-component-update"),
        flag("--disable-background-networking"),
        flag("--disable-domain-reliability"),
        flag("--no-pings"),
    ];
    if tuning.mute_audio {
        switches.push(flag("--mute-audio"));
    }
    if tuning.paint_when_covered {
        switches.push(flag("--disable-backgrounding-occluded-windows"));
    }
    if let Some(path) = &tuning.net_log {
        switches.push(("--log-net-log".to_string(), Some(path.to_string_lossy().into_owned())));
    }
    let mut disable_features = NO_LOCAL_DISCOVERY.to_vec();
    disable_features.push(SPARE_RENDERER);
    let enable_features = if tuning.network_in_process { vec![NETWORK_IN_PROCESS] } else { Vec::new() };
    Launch { switches, disable_features, enable_features }
}

impl Launch {
    /// What is wrong with the list, if anything. The shell refuses to start on a list that
    /// would silently not apply.
    pub fn problems(&self) -> Vec<String> {
        let mut found = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (name, value) in &self.switches {
            let bare = name.strip_prefix("--").unwrap_or("");
            let well_spelled = !bare.is_empty()
                && bare.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !bare.starts_with('-');
            if !well_spelled {
                found.push(format!("{name:?}: a switch is spelled `--name` (lower case, no `=`, no spaces)"));
            }
            if matches!(bare, "enable-features" | "disable-features") {
                found.push(format!("{name}: features go through the feature lists, the raw switch replaces CEF's own"));
            }
            if value.as_deref().is_some_and(str::is_empty) {
                found.push(format!("{name}: an empty value"));
            }
            if !seen.insert(bare) {
                found.push(format!("{name}: given twice, the last one wins"));
            }
        }
        for feature in self.disable_features.iter().chain(&self.enable_features) {
            if feature.is_empty() || !feature.bytes().all(|b| b.is_ascii_alphanumeric()) {
                found.push(format!("{feature:?}: not a feature name"));
            }
        }
        for feature in &self.enable_features {
            if self.disable_features.contains(feature) {
                found.push(format!("{feature}: both enabled and disabled"));
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_tuning() -> Vec<Tuning> {
        let mut all = Vec::new();
        for bits in 0..16u8 {
            all.push(Tuning {
                mute_audio: bits & 1 != 0,
                network_in_process: bits & 2 != 0,
                paint_when_covered: bits & 4 != 0,
                net_log: (bits & 8 != 0).then(|| PathBuf::from("/tmp/net log.json")),
            });
        }
        all
    }

    #[test]
    fn every_launch_is_well_formed() {
        for tuning in every_tuning() {
            let launch = launch(&tuning);
            assert_eq!(launch.problems(), Vec::<String>::new(), "{tuning:?}");
            for (name, _) in &launch.switches {
                assert!(name.starts_with("--"), "{name}: a bare name is silently dropped");
            }
        }
    }

    #[test]
    fn the_memory_settings_are_on_by_default() {
        let launch = launch(&Tuning::default());
        let names: Vec<&str> = launch.switches.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"--disable-component-update"));
        assert!(names.contains(&"--disable-background-networking"));
        assert!(launch.disable_features.contains(&"SpareRendererForSitePerProcess"));
        // Crash isolation of the network stack is kept unless asked otherwise.
        assert!(launch.enable_features.is_empty());
        assert!(!names.contains(&"--mute-audio") && !names.contains(&"--disable-backgrounding-occluded-windows"));
    }

    #[test]
    fn one_setting_moves_the_network_service_in_process() {
        let launch = launch(&Tuning { network_in_process: true, ..Tuning::default() });
        assert_eq!(launch.enable_features, ["NetworkServiceInProcess2"]);
    }

    #[test]
    fn a_malformed_list_is_reported() {
        let bad = Launch {
            switches: vec![
                ("mute-audio".into(), None),
                ("--disable-features".into(), Some("X".into())),
                ("--no-pings".into(), None),
                ("--no-pings".into(), None),
                ("--a=b".into(), None),
                ("--log-net-log".into(), Some(String::new())),
            ],
            disable_features: vec!["Spare Renderer", "Both"],
            enable_features: vec!["Both"],
        };
        let problems = bad.problems();
        for needle in [
            "\"mute-audio\"",
            "--disable-features: features go",
            "--no-pings: given twice",
            "\"--a=b\"",
            "empty value",
            "\"Spare Renderer\"",
            "Both: both",
        ] {
            assert!(problems.iter().any(|p| p.contains(needle)), "{needle} not in {problems:?}");
        }
    }
}
