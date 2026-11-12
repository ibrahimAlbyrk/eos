//! The escape-sequence state machine (`common/parser/EscapeSequenceParser.ts`,
//! `Params.ts`, `OscParser.ts`): the same transition table, built the same
//! way, over code points. What a sequence does is the [`Perform`]er's job.

use std::sync::LazyLock;

const GROUND: u8 = 0;
const ESCAPE: u8 = 1;
const ESCAPE_INTERMEDIATE: u8 = 2;
const CSI_ENTRY: u8 = 3;
const CSI_PARAM: u8 = 4;
const CSI_INTERMEDIATE: u8 = 5;
const CSI_IGNORE: u8 = 6;
const SOS_PM_APC_STRING: u8 = 7;
const OSC_STRING: u8 = 8;
const DCS_ENTRY: u8 = 9;
const DCS_PARAM: u8 = 10;
const DCS_IGNORE: u8 = 11;
const DCS_INTERMEDIATE: u8 = 12;
const DCS_PASSTHROUGH: u8 = 13;
const STATES: u8 = 14;

const IGNORE: u8 = 0;
const ERROR: u8 = 1;
const PRINT: u8 = 2;
const EXECUTE: u8 = 3;
const OSC_START: u8 = 4;
const OSC_PUT: u8 = 5;
const OSC_END: u8 = 6;
const CSI_DISPATCH: u8 = 7;
const PARAM: u8 = 8;
const COLLECT: u8 = 9;
const ESC_DISPATCH: u8 = 10;
const CLEAR: u8 = 11;
const DCS_HOOK: u8 = 12;
const DCS_PUT: u8 = 13;
const DCS_UNHOOK: u8 = 14;

/// Every code point from here up counts as this one in the table.
const NON_ASCII_PRINTABLE: u32 = 0xA0;

/// `action << 4 | next state`, indexed by `state << 8 | code`.
static TABLE: LazyLock<Vec<u8>> = LazyLock::new(build_table);

fn build_table() -> Vec<u8> {
    let mut table = vec![(ERROR << 4) | GROUND; usize::from(STATES) << 8];
    let mut add = |code: u32, state: u8, action: u8, next: u8| {
        table[(usize::from(state) << 8) | code as usize] = (action << 4) | next;
    };
    let mut many = |codes: &mut dyn Iterator<Item = u32>, state: u8, action: u8, next: u8| {
        for code in codes {
            add(code, state, action, next);
        }
    };
    let printables = || 0x20..0x7f;
    let executables = || (0x00..0x18).chain([0x19]).chain(0x1c..0x20);

    many(&mut printables(), GROUND, PRINT, GROUND);
    for state in 0..STATES {
        many(&mut [0x18, 0x1a, 0x99, 0x9a].into_iter(), state, EXECUTE, GROUND);
        many(&mut (0x80..0x90), state, EXECUTE, GROUND);
        many(&mut (0x90..0x98), state, EXECUTE, GROUND);
        many(&mut [0x9c].into_iter(), state, IGNORE, GROUND);
        many(&mut [0x1b].into_iter(), state, CLEAR, ESCAPE);
        many(&mut [0x9d].into_iter(), state, OSC_START, OSC_STRING);
        many(&mut [0x98, 0x9e, 0x9f].into_iter(), state, IGNORE, SOS_PM_APC_STRING);
        many(&mut [0x9b].into_iter(), state, CLEAR, CSI_ENTRY);
        many(&mut [0x90].into_iter(), state, CLEAR, DCS_ENTRY);
    }
    many(&mut executables(), GROUND, EXECUTE, GROUND);
    many(&mut executables(), ESCAPE, EXECUTE, ESCAPE);
    many(&mut [0x7f].into_iter(), ESCAPE, IGNORE, ESCAPE);
    many(&mut executables(), OSC_STRING, IGNORE, OSC_STRING);
    many(&mut executables(), CSI_ENTRY, EXECUTE, CSI_ENTRY);
    many(&mut [0x7f].into_iter(), CSI_ENTRY, IGNORE, CSI_ENTRY);
    many(&mut executables(), CSI_PARAM, EXECUTE, CSI_PARAM);
    many(&mut [0x7f].into_iter(), CSI_PARAM, IGNORE, CSI_PARAM);
    many(&mut executables(), CSI_IGNORE, EXECUTE, CSI_IGNORE);
    many(&mut executables(), CSI_INTERMEDIATE, EXECUTE, CSI_INTERMEDIATE);
    many(&mut [0x7f].into_iter(), CSI_INTERMEDIATE, IGNORE, CSI_INTERMEDIATE);
    many(&mut executables(), ESCAPE_INTERMEDIATE, EXECUTE, ESCAPE_INTERMEDIATE);
    many(&mut [0x7f].into_iter(), ESCAPE_INTERMEDIATE, IGNORE, ESCAPE_INTERMEDIATE);
    // OSC
    many(&mut [0x5d].into_iter(), ESCAPE, OSC_START, OSC_STRING);
    many(&mut printables(), OSC_STRING, OSC_PUT, OSC_STRING);
    many(&mut [0x7f].into_iter(), OSC_STRING, OSC_PUT, OSC_STRING);
    many(&mut [0x9c, 0x1b, 0x18, 0x1a, 0x07].into_iter(), OSC_STRING, OSC_END, GROUND);
    many(&mut (0x1c..0x20), OSC_STRING, IGNORE, OSC_STRING);
    // SOS / PM / APC do nothing
    many(&mut [0x58, 0x5e, 0x5f].into_iter(), ESCAPE, IGNORE, SOS_PM_APC_STRING);
    many(&mut printables(), SOS_PM_APC_STRING, IGNORE, SOS_PM_APC_STRING);
    many(&mut executables(), SOS_PM_APC_STRING, IGNORE, SOS_PM_APC_STRING);
    many(&mut [0x9c].into_iter(), SOS_PM_APC_STRING, IGNORE, GROUND);
    many(&mut [0x7f].into_iter(), SOS_PM_APC_STRING, IGNORE, SOS_PM_APC_STRING);
    // CSI
    many(&mut [0x5b].into_iter(), ESCAPE, CLEAR, CSI_ENTRY);
    many(&mut (0x40..0x7f), CSI_ENTRY, CSI_DISPATCH, GROUND);
    many(&mut (0x30..0x3c), CSI_ENTRY, PARAM, CSI_PARAM);
    many(&mut [0x3c, 0x3d, 0x3e, 0x3f].into_iter(), CSI_ENTRY, COLLECT, CSI_PARAM);
    many(&mut (0x30..0x3c), CSI_PARAM, PARAM, CSI_PARAM);
    many(&mut (0x40..0x7f), CSI_PARAM, CSI_DISPATCH, GROUND);
    many(&mut [0x3c, 0x3d, 0x3e, 0x3f].into_iter(), CSI_PARAM, IGNORE, CSI_IGNORE);
    many(&mut (0x20..0x40), CSI_IGNORE, IGNORE, CSI_IGNORE);
    many(&mut [0x7f].into_iter(), CSI_IGNORE, IGNORE, CSI_IGNORE);
    many(&mut (0x40..0x7f), CSI_IGNORE, IGNORE, GROUND);
    many(&mut (0x20..0x30), CSI_ENTRY, COLLECT, CSI_INTERMEDIATE);
    many(&mut (0x20..0x30), CSI_INTERMEDIATE, COLLECT, CSI_INTERMEDIATE);
    many(&mut (0x30..0x40), CSI_INTERMEDIATE, IGNORE, CSI_IGNORE);
    many(&mut (0x40..0x7f), CSI_INTERMEDIATE, CSI_DISPATCH, GROUND);
    many(&mut (0x20..0x30), CSI_PARAM, COLLECT, CSI_INTERMEDIATE);
    // ESC
    many(&mut (0x20..0x30), ESCAPE, COLLECT, ESCAPE_INTERMEDIATE);
    many(&mut (0x20..0x30), ESCAPE_INTERMEDIATE, COLLECT, ESCAPE_INTERMEDIATE);
    many(&mut (0x30..0x7f), ESCAPE_INTERMEDIATE, ESC_DISPATCH, GROUND);
    many(&mut (0x30..0x50), ESCAPE, ESC_DISPATCH, GROUND);
    many(&mut (0x51..0x58), ESCAPE, ESC_DISPATCH, GROUND);
    many(&mut [0x59, 0x5a, 0x5c].into_iter(), ESCAPE, ESC_DISPATCH, GROUND);
    many(&mut (0x60..0x7f), ESCAPE, ESC_DISPATCH, GROUND);
    // DCS
    many(&mut [0x50].into_iter(), ESCAPE, CLEAR, DCS_ENTRY);
    many(&mut executables(), DCS_ENTRY, IGNORE, DCS_ENTRY);
    many(&mut [0x7f].into_iter(), DCS_ENTRY, IGNORE, DCS_ENTRY);
    many(&mut (0x1c..0x20), DCS_ENTRY, IGNORE, DCS_ENTRY);
    many(&mut (0x20..0x30), DCS_ENTRY, COLLECT, DCS_INTERMEDIATE);
    many(&mut (0x30..0x3c), DCS_ENTRY, PARAM, DCS_PARAM);
    many(&mut [0x3c, 0x3d, 0x3e, 0x3f].into_iter(), DCS_ENTRY, COLLECT, DCS_PARAM);
    many(&mut executables(), DCS_IGNORE, IGNORE, DCS_IGNORE);
    many(&mut (0x20..0x80), DCS_IGNORE, IGNORE, DCS_IGNORE);
    many(&mut (0x1c..0x20), DCS_IGNORE, IGNORE, DCS_IGNORE);
    many(&mut executables(), DCS_PARAM, IGNORE, DCS_PARAM);
    many(&mut [0x7f].into_iter(), DCS_PARAM, IGNORE, DCS_PARAM);
    many(&mut (0x1c..0x20), DCS_PARAM, IGNORE, DCS_PARAM);
    many(&mut (0x30..0x3c), DCS_PARAM, PARAM, DCS_PARAM);
    many(&mut [0x3c, 0x3d, 0x3e, 0x3f].into_iter(), DCS_PARAM, IGNORE, DCS_IGNORE);
    many(&mut (0x20..0x30), DCS_PARAM, COLLECT, DCS_INTERMEDIATE);
    many(&mut executables(), DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE);
    many(&mut [0x7f].into_iter(), DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE);
    many(&mut (0x1c..0x20), DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE);
    many(&mut (0x20..0x30), DCS_INTERMEDIATE, COLLECT, DCS_INTERMEDIATE);
    many(&mut (0x30..0x40), DCS_INTERMEDIATE, IGNORE, DCS_IGNORE);
    many(&mut (0x40..0x7f), DCS_INTERMEDIATE, DCS_HOOK, DCS_PASSTHROUGH);
    many(&mut (0x40..0x7f), DCS_PARAM, DCS_HOOK, DCS_PASSTHROUGH);
    many(&mut (0x40..0x7f), DCS_ENTRY, DCS_HOOK, DCS_PASSTHROUGH);
    many(&mut executables(), DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH);
    many(&mut printables(), DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH);
    many(&mut [0x7f].into_iter(), DCS_PASSTHROUGH, IGNORE, DCS_PASSTHROUGH);
    many(&mut [0x1b, 0x9c, 0x18, 0x1a].into_iter(), DCS_PASSTHROUGH, DCS_UNHOOK, GROUND);
    // Everything from U+00A0 up
    many(&mut [NON_ASCII_PRINTABLE].into_iter(), GROUND, PRINT, GROUND);
    many(&mut [NON_ASCII_PRINTABLE].into_iter(), OSC_STRING, OSC_PUT, OSC_STRING);
    many(&mut [NON_ASCII_PRINTABLE].into_iter(), CSI_IGNORE, IGNORE, CSI_IGNORE);
    many(&mut [NON_ASCII_PRINTABLE].into_iter(), DCS_IGNORE, IGNORE, DCS_IGNORE);
    many(&mut [NON_ASCII_PRINTABLE].into_iter(), DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH);
    table
}

const MAX_PARAMS: usize = 32;

/// A sequence's numeric parameters and their colon-separated sub-parameters.
/// A sub-parameter left empty reads `-1`.
#[derive(Debug, Clone)]
pub(super) struct Params {
    params: [i32; MAX_PARAMS],
    len: usize,
    subs: [i32; MAX_PARAMS],
    subs_len: usize,
    /// Per parameter: `start << 8 | end` into `subs`.
    subs_idx: [u16; MAX_PARAMS],
    reject_digits: bool,
    reject_sub_digits: bool,
    digit_is_sub: bool,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            params: [0; MAX_PARAMS],
            len: 0,
            subs: [0; MAX_PARAMS],
            subs_len: 0,
            subs_idx: [0; MAX_PARAMS],
            reject_digits: false,
            reject_sub_digits: false,
            digit_is_sub: false,
        }
    }
}

impl Params {
    pub(super) fn len(&self) -> usize {
        self.len
    }

    /// Parameter `i`, `0` where the sequence gave none.
    pub(super) fn get(&self, i: usize) -> i32 {
        if i < self.len { self.params[i] } else { 0 }
    }

    /// The parameters themselves, without their sub-parameters.
    pub(super) fn main(&self) -> &[i32] {
        &self.params[..self.len]
    }

    pub(super) fn subs(&self, i: usize) -> &[i32] {
        let Some(idx) = self.subs_idx.get(i).filter(|_| i < self.len) else { return &[] };
        let (start, end) = (usize::from(idx >> 8), usize::from(idx & 0xFF));
        self.subs.get(start..end).unwrap_or(&[])
    }

    fn reset(&mut self) {
        self.len = 0;
        self.subs_len = 0;
        self.reject_digits = false;
        self.reject_sub_digits = false;
        self.digit_is_sub = false;
    }

    fn add_param(&mut self, value: i32) {
        self.digit_is_sub = false;
        if self.len >= MAX_PARAMS {
            self.reject_digits = true;
            return;
        }
        let at = self.subs_len as u16;
        self.subs_idx[self.len] = (at << 8) | at;
        self.params[self.len] = value;
        self.len += 1;
    }

    fn add_sub_param(&mut self, value: i32) {
        self.digit_is_sub = true;
        if self.len == 0 {
            return;
        }
        if self.reject_digits || self.subs_len >= MAX_PARAMS {
            self.reject_sub_digits = true;
            return;
        }
        self.subs[self.subs_len] = value;
        self.subs_len += 1;
        self.subs_idx[self.len - 1] += 1;
    }

    fn add_digit(&mut self, value: i32) {
        let len = if self.digit_is_sub { self.subs_len } else { self.len };
        if self.reject_digits || len == 0 || (self.digit_is_sub && self.reject_sub_digits) {
            return;
        }
        let store = if self.digit_is_sub { &mut self.subs } else { &mut self.params };
        let cur = store[len - 1];
        store[len - 1] = if cur == -1 { value } else { cur.saturating_mul(10).saturating_add(value) };
    }
}

/// What a parsed piece of the stream does.
pub(super) trait Perform {
    /// A run of printable characters. `join` is what is remembered of the
    /// character before the run, and is updated for the next.
    fn print(&mut self, text: &[u32], join: &mut u32);
    /// A C0 or C1 control.
    fn execute(&mut self, code: u32);
    /// `ident` is the prefix and intermediate bytes followed by the final
    /// byte, eight bits each (`?` `h` → `0x3f68`).
    fn csi(&mut self, ident: u32, params: &Params, join: u32);
    /// `true` when the sequence resets the terminal: the parser starts over.
    fn esc(&mut self, ident: u32) -> bool;
    /// A finished operating-system command the terminal acts on.
    fn osc(&mut self, id: i32, data: &str);
    /// Whether [`osc`](Self::osc) wants the text of command `id`.
    fn wants_osc(&self, id: i32) -> bool;
}

/// The longest command text kept (xterm's limit, in UTF-16 units); a longer
/// one is dropped whole.
const OSC_LIMIT: usize = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OscState {
    Start,
    Id,
    Payload,
    Abort,
}

#[derive(Debug, Clone)]
struct Osc {
    state: OscState,
    id: i32,
    data: String,
    units: usize,
    hit_limit: bool,
    wanted: bool,
}

impl Osc {
    fn new() -> Self {
        Self { state: OscState::Start, id: -1, data: String::new(), units: 0, hit_limit: false, wanted: false }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }

    fn put(&mut self, text: &[u32], performer: &impl Perform) {
        if self.state == OscState::Abort {
            return;
        }
        let mut start = 0;
        if self.state == OscState::Id {
            while start < text.len() {
                let code = text[start];
                start += 1;
                if code == 0x3b {
                    self.state = OscState::Payload;
                    self.wanted = performer.wants_osc(self.id);
                    break;
                }
                if !(0x30..=0x39).contains(&code) {
                    self.state = OscState::Abort;
                    return;
                }
                if self.id == -1 {
                    self.id = 0;
                }
                self.id = self.id.saturating_mul(10).saturating_add(code as i32 - 48);
            }
        }
        if self.state == OscState::Payload && self.wanted && !self.hit_limit {
            for code in &text[start..] {
                let c = char::from_u32(*code).unwrap_or('\u{FFFD}');
                self.units += c.len_utf16();
                self.data.push(c);
            }
            if self.units > OSC_LIMIT {
                self.data = String::new();
                self.hit_limit = true;
            }
        }
    }

    fn end(&mut self, success: bool, performer: &mut impl Perform) {
        if self.state == OscState::Start {
            return;
        }
        if self.state != OscState::Abort {
            if self.state == OscState::Id {
                self.wanted = performer.wants_osc(self.id);
            }
            if self.wanted && success && !self.hit_limit {
                performer.osc(self.id, &self.data);
            }
        }
        self.reset();
    }
}

#[derive(Debug, Clone)]
pub(super) struct Parser {
    state: u8,
    params: Params,
    collect: u32,
    osc: Osc,
    /// Width and joining of the last printed character, `0` after anything
    /// that is not printing.
    join: u32,
}

impl Parser {
    pub(super) fn new() -> Self {
        let mut params = Params::default();
        params.add_param(0);
        Self { state: GROUND, params, collect: 0, osc: Osc::new(), join: 0 }
    }

    fn reset(&mut self) {
        self.state = GROUND;
        self.osc.reset();
        self.params.reset();
        self.params.add_param(0);
        self.collect = 0;
        self.join = 0;
    }

    fn clear(&mut self) {
        self.params.reset();
        self.params.add_param(0);
        self.collect = 0;
    }

    pub(super) fn parse(&mut self, data: &[u32], performer: &mut impl Perform) {
        let table = &*TABLE;
        let len = data.len();
        let mut i = 0;
        while i < len {
            let mut code = data[i];
            let column = if code < NON_ASCII_PRINTABLE { code } else { NON_ASCII_PRINTABLE } as usize;
            let mut transition = table[(usize::from(self.state) << 8) | column];
            match transition >> 4 {
                PRINT => {
                    let mut j = i + 1;
                    while j < len && data[j] >= 0x20 && !(data[j] > 0x7e && data[j] < NON_ASCII_PRINTABLE) {
                        j += 1;
                    }
                    performer.print(&data[i..j], &mut self.join);
                    i = j - 1;
                }
                EXECUTE => {
                    performer.execute(code);
                    self.join = 0;
                }
                CSI_DISPATCH => {
                    performer.csi((self.collect << 8) | code, &self.params, self.join);
                    self.join = 0;
                }
                PARAM => {
                    loop {
                        match code {
                            0x3b => self.params.add_param(0),
                            0x3a => self.params.add_sub_param(-1),
                            _ => self.params.add_digit(code as i32 - 48),
                        }
                        i += 1;
                        if i >= len {
                            break;
                        }
                        code = data[i];
                        if !(code > 0x2f && code < 0x3c) {
                            break;
                        }
                    }
                    i -= 1;
                }
                COLLECT => self.collect = (self.collect << 8) | code,
                ESC_DISPATCH => {
                    if performer.esc((self.collect << 8) | code) {
                        self.reset();
                    }
                    self.join = 0;
                }
                CLEAR => self.clear(),
                DCS_PUT => {
                    let mut j = i + 1;
                    while j < len
                        && !matches!(data[j], 0x18 | 0x1a | 0x1b)
                        && !(data[j] > 0x7f && data[j] < NON_ASCII_PRINTABLE)
                    {
                        j += 1;
                    }
                    i = j - 1;
                }
                DCS_UNHOOK => {
                    if code == 0x1b {
                        transition |= ESCAPE;
                    }
                    self.clear();
                    self.join = 0;
                }
                OSC_START => {
                    self.osc.reset();
                    self.osc.state = OscState::Id;
                }
                OSC_PUT => {
                    let mut j = i + 1;
                    while j < len && data[j] >= 0x20 && !(data[j] > 0x7f && data[j] < NON_ASCII_PRINTABLE) {
                        j += 1;
                    }
                    self.osc.put(&data[i..j], performer);
                    i = j - 1;
                }
                OSC_END => {
                    self.osc.end(code != 0x18 && code != 0x1a, performer);
                    if code == 0x1b {
                        transition |= ESCAPE;
                    }
                    self.clear();
                    self.join = 0;
                }
                // IGNORE, ERROR and DCS_HOOK change nothing but the state.
                _ => {}
            }
            self.state = transition & 15;
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Log(Vec<String>);

    impl Perform for Log {
        fn print(&mut self, text: &[u32], _join: &mut u32) {
            self.0.push(format!("print {}", text.iter().filter_map(|c| char::from_u32(*c)).collect::<String>()));
        }
        fn execute(&mut self, code: u32) {
            self.0.push(format!("exec {code:02x}"));
        }
        fn csi(&mut self, ident: u32, params: &Params, _join: u32) {
            let subs: Vec<&[i32]> = (0..params.len()).map(|i| params.subs(i)).collect();
            self.0.push(format!("csi {ident:x} {:?} {subs:?}", params.main()));
        }
        fn esc(&mut self, ident: u32) -> bool {
            self.0.push(format!("esc {ident:x}"));
            false
        }
        fn osc(&mut self, id: i32, data: &str) {
            self.0.push(format!("osc {id} {data}"));
        }
        fn wants_osc(&self, id: i32) -> bool {
            id == 8
        }
    }

    fn run(chunks: &[&str]) -> Vec<String> {
        let mut parser = Parser::new();
        let mut log = Log::default();
        for chunk in chunks {
            let data: Vec<u32> = chunk.chars().map(u32::from).collect();
            parser.parse(&data, &mut log);
        }
        log.0
    }

    #[test]
    fn splits_text_controls_and_sequences() {
        assert_eq!(
            run(&["ab\r\x1b[1;31mé\x1b7"]),
            ["print ab", "exec 0d", "csi 6d [1, 31] [[], []]", "print é", "esc 37"]
        );
    }

    #[test]
    fn a_sequence_may_arrive_in_pieces() {
        assert_eq!(run(&["\x1b", "[", "?10", "49", "h"]), ["csi 3f68 [1049] [[]]"]);
        assert_eq!(run(&["\x1b]8;;http://x", "/y\x1b", "\\z"]), ["osc 8 ;http://x/y", "esc 5c", "print z"]);
    }

    #[test]
    fn sub_parameters_ride_with_their_parameter() {
        assert_eq!(run(&["\x1b[4:3;38:2::1:2:3m"]), ["csi 6d [4, 38] [[3], [2, -1, 1, 2, 3]]"]);
    }

    #[test]
    fn strings_nobody_reads_are_swallowed() {
        assert_eq!(
            run(&["\x1bP$qm\x1b\\a\x1b_x\x1b\\b\x1b]0;t\x07c"]),
            ["esc 5c", "print a", "esc 5c", "print b", "print c"]
        );
    }

    #[test]
    fn a_cancelled_command_is_not_performed() {
        assert_eq!(run(&["\x1b]8;;http://x\x18a"]), ["print a"]);
        assert_eq!(run(&["\x1b]8x;;http://x\x07a"]), ["print a"], "a command id must be a number");
    }

    #[test]
    fn huge_parameters_saturate() {
        assert_eq!(run(&["\x1b[99999999999A"]), [format!("csi 41 [{}] [[]]", i32::MAX)]);
    }
}
