//! What fits in a pack or a reminder. Sizes are `estimate_tokens` of the
//! line as written; the profile block has its own budget and is never cut
//! for memory.

/// A chat's pack: the recalled notes at the start of each epoch.
pub const CHAT_PACK_TOKENS: i64 = 400;
/// A routine run's pack, and its parts.
pub const RUN_PACK_TOKENS: i64 = 1_600;
pub const RUN_PLAYBOOK_TOKENS: i64 = 600;
pub const RUN_RECALLED_TOKENS: i64 = 500;
pub const RUN_EXAMPLES_TOKENS: i64 = 500;
/// Reminders: notes per moment, per turn, and the size of each.
pub const REMINDER_NOTES_PER_MOMENT: usize = 3;
pub const REMINDER_NOTES_PER_TURN: usize = 6;
pub const REMINDER_NOTE_TOKENS: i64 = 60;

/// One line a pack may hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line {
    pub tokens: i64,
    /// A rule the user stated for this routine: never cut.
    pub pinned: bool,
}

/// The lines, best first, that fit `budget` taken in order; a pinned line
/// is always taken and counts against the budget.
pub fn fit(lines: &[Line], budget: i64) -> Vec<usize> {
    let pinned: i64 = lines.iter().filter(|l| l.pinned).map(|l| l.tokens).sum();
    let mut room = budget - pinned;
    let mut kept = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.pinned {
            kept.push(i);
        } else if line.tokens <= room {
            room -= line.tokens;
            kept.push(i);
        }
    }
    kept
}

/// What a run's pack offers, each part best first (playbook lines strongest
/// first, notes by rank, examples by choice).
#[derive(Debug, Clone, Default)]
pub struct RunOffer {
    pub playbook: Vec<Line>,
    pub recalled: Vec<Line>,
    pub examples: Vec<Line>,
}

/// Indices kept from each part of a [`RunOffer`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunPick {
    pub playbook: Vec<usize>,
    pub recalled: Vec<usize>,
    pub examples: Vec<usize>,
}

impl RunPick {
    fn tokens(&self, offer: &RunOffer) -> i64 {
        let sum = |kept: &[usize], lines: &[Line]| kept.iter().map(|&i| lines[i].tokens).sum::<i64>();
        sum(&self.playbook, &offer.playbook)
            + sum(&self.recalled, &offer.recalled)
            + sum(&self.examples, &offer.examples)
    }
}

/// Removes the last unpinned index of `kept`, if any.
fn drop_last(kept: &mut Vec<usize>, lines: &[Line]) -> bool {
    match kept.iter().rposition(|&i| !lines[i].pinned) {
        Some(at) => {
            kept.remove(at);
            true
        }
        None => false,
    }
}

/// Each part within its own budget, then the whole within
/// [`RUN_PACK_TOKENS`], cutting the second example first, then recalled
/// notes from the bottom, then the first example, then playbook lines from
/// the weakest. Pinned lines are never cut.
pub fn fit_run(offer: &RunOffer) -> RunPick {
    let mut pick = RunPick {
        playbook: fit(&offer.playbook, RUN_PLAYBOOK_TOKENS),
        recalled: fit(&offer.recalled, RUN_RECALLED_TOKENS),
        examples: fit(&offer.examples, RUN_EXAMPLES_TOKENS),
    };
    while pick.tokens(offer) > RUN_PACK_TOKENS {
        let cut = (pick.examples.len() > 1 && drop_last(&mut pick.examples, &offer.examples))
            || drop_last(&mut pick.recalled, &offer.recalled)
            || drop_last(&mut pick.examples, &offer.examples)
            || drop_last(&mut pick.playbook, &offer.playbook);
        if !cut {
            break;
        }
    }
    pick
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(tokens: i64) -> Line {
        Line { tokens, pinned: false }
    }

    #[test]
    fn fit_takes_what_fits_in_order_and_always_the_pinned() {
        let lines = [line(200), line(250), line(150), Line { tokens: 100, pinned: true }];
        assert_eq!(fit(&lines, 400), vec![0, 3], "the pinned line's 100 leaves 300");
        assert_eq!(fit(&lines, 50), vec![3], "pinned even over budget");
        assert_eq!(fit(&[], 400), Vec::<usize>::new());
    }

    #[test]
    fn each_run_part_keeps_its_own_budget() {
        let offer = RunOffer {
            playbook: vec![line(400), line(300)],
            recalled: vec![line(300), line(300)],
            examples: vec![line(250), line(250), line(10)],
        };
        let pick = fit_run(&offer);
        assert_eq!(pick, RunPick { playbook: vec![0], recalled: vec![0], examples: vec![0, 1] });
    }

    #[test]
    fn an_overfull_run_pack_cuts_in_the_stated_order() {
        let pin = |tokens| Line { tokens, pinned: true };
        // Pinned notes push the whole over 1,600.
        let offer = RunOffer {
            playbook: vec![line(300), line(300)],
            recalled: vec![pin(500), line(0), line(100)],
            examples: vec![line(250), line(250)],
        };
        let pick = fit_run(&offer);
        // 600 + 500 + 500 = 1,600 fits: nothing cut yet.
        assert_eq!(pick.examples, vec![0, 1]);
        let heavy = RunOffer { recalled: vec![pin(700), line(50)], ..offer };
        let pick = fit_run(&heavy);
        // 600 + 700 + 500 = 1,800: the second example goes (1,550).
        assert_eq!(pick, RunPick { playbook: vec![0, 1], recalled: vec![0], examples: vec![0] });
        let heavier = RunOffer { recalled: vec![pin(1_000), line(100)], ..heavy };
        let pick = fit_run(&heavier);
        // 600 + 1,000 + 500: the second example, no note to cut (pinned), then the first example.
        assert_eq!(pick, RunPick { playbook: vec![0, 1], recalled: vec![0], examples: vec![] });
        let heaviest = RunOffer { recalled: vec![pin(1_500)], ..heavier };
        assert_eq!(fit_run(&heaviest).playbook, Vec::<usize>::new(), "playbook lines go last");
    }
}
