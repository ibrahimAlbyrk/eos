//! The closed sets a surface's rows are made of, each stored and sent as its
//! word. `parse` answers `None` for a word this version does not know.

macro_rules! words {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $word:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($(#[$vmeta])* $variant),+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $word),+ }
            }

            pub fn parse(text: &str) -> Option<$name> {
                $name::ALL.iter().copied().find(|w| w.as_str() == text)
            }
        }
    };
}

words!(
    /// How much a surface can do: a View of the kit's parts, a Page of Eos
    /// markup, an App of its own code.
    Level { View = "view", Page = "page", App = "app" }
);

words!(
    /// Where Eos shows a surface.
    Place { RoutinePage = "routine_page", NeedsYou = "needs_you", SidePanel = "side_panel", Tool = "tool" }
);

words!(
    /// What a surface is for in its routine.
    Role { Result = "result", Decisions = "decisions", Page = "page", App = "app" }
);

words!(
    VersionStatus {
        /// Its checks have not all run.
        Checking = "checking",
        /// Passed its checks; waits for the user to keep or discard it.
        Candidate = "candidate",
        Kept = "kept",
        Discarded = "discarded",
        /// Was kept until another version was.
        Superseded = "superseded",
    }
);

words!(
    /// Who made a version.
    MadeBy { Designer = "designer", User = "user", Arrange = "arrange", Restore = "restore", Builder = "builder" }
);

words!(
    IssueKind {
        Page = "page",
        View = "view",
        /// Built by Eos from the data a run last sent, when its fills kept
        /// failing.
        Fallback = "fallback",
    }
);

words!(
    IssueStatus {
        /// Stored; its images are still coming in.
        Preparing = "preparing",
        Ready = "ready",
        Failed = "failed",
    }
);
