//! Routines: the rules over a routine's blueprint (`eos_contracts::routine`),
//! the states a run moves through, the limits its runs keep and the numbers
//! they add up to. Pure: nothing here reads a clock or a file, and nothing
//! logs (a blueprint is the user's text).

/// A closed set of words a row stores: the enum, every value in order, the
/// word of each and the value a stored word names (`None` for a word this
/// version does not know).
macro_rules! words {
    ($(#[$meta:meta])* pub enum $name:ident { $($(#[$doc:meta])* $variant:ident = $word:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($(#[$doc])* $variant,)+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $word,)+
                }
            }

            pub fn parse(text: &str) -> Option<$name> {
                $name::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }
    };
}

pub mod blueprint;
pub mod item;
pub mod limits;
pub mod numbers;
pub mod run;
