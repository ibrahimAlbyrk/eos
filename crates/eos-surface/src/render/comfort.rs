//! Reading comfort, the reader's own settings over any design (05 Q11): a
//! larger text scale as `zoom` on the page root, and more contrast, which
//! sets all text to black on white and drops muted greys. More contrast
//! also applies when the Mac asks for it.

use super::Comfort;

const MORE_CONTRAST: &str = "body,.eos-page,.eos-page *{color:#000!important;background-color:#fff!important;background-image:none!important;border-color:#000!important;text-shadow:none!important;box-shadow:none!important;opacity:1!important}.eos-page a{text-decoration:underline!important}";

/// The style Eos adds after the page's own.
pub(crate) fn css(comfort: Comfort) -> String {
    let mut out = String::from("<style>");
    if comfort.text_scale > 100 {
        out.push_str(&format!(".eos-page{{zoom:{}%}}", comfort.text_scale.min(130)));
    }
    if comfort.more_contrast {
        out.push_str(MORE_CONTRAST);
    } else {
        out.push_str(&format!("@media (prefers-contrast: more){{{MORE_CONTRAST}}}"));
    }
    out.push_str("</style>");
    out
}
