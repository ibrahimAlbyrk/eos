//! The page of the splash shown while the app restarts into an update
//! (`app/src/main/splash.ts`, `updates.ts`): the logo floating, "Eos", a sweeping bar and
//! the caption ("Updating · 0.1.2 → 0.1.3"), on a 30 px rounded panel.

use base64::Engine;

/// The panel's size: wide, and tall enough for the caption.
pub const SIZE: (f64, f64) = (280.0, 224.0);

fn escape(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '>' => "&gt;".to_owned(),
            '"' => "&quot;".to_owned(),
            c => c.to_string(),
        })
        .collect()
}

/// What the update splash says.
pub fn update_caption(from: &str, to: &str) -> String {
    format!("Updating · {from} → {to}")
}

/// The splash document; `logo` is the dashboard's `logo.png`, when there is one.
pub fn splash_html(caption: &str, logo: Option<&[u8]>) -> String {
    let logo = logo.map_or_else(String::new, |png| {
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
    });
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;cursor:default;}}
.panel{{position:fixed;inset:0;border-radius:30px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:rgba(18,18,20,0.92);}}
.logo{{width:64px;height:64px;border-radius:16px;object-fit:cover;animation:floaty 1.6s ease-in-out infinite alternate;}}
.name{{font:600 16px -apple-system,system-ui,sans-serif;color:#fff;letter-spacing:2.5px;}}
.bar{{position:relative;width:168px;height:3px;border-radius:1.5px;background:rgba(255,255,255,0.18);overflow:hidden;}}
.bar::after{{content:"";position:absolute;top:0;left:0;width:84px;height:3px;background:linear-gradient(90deg,transparent,rgba(107,158,255,1),transparent);animation:sweep 1.25s ease-in-out infinite;}}
.caption{{font:500 12px ui-monospace,SFMono-Regular,monospace;color:rgba(255,255,255,0.62);margin-top:-6px;}}
@keyframes floaty{{from{{transform:translateY(0)}}to{{transform:translateY(-5px)}}}}
@keyframes sweep{{from{{transform:translateX(-90px)}}to{{transform:translateX(174px)}}}}
</style></head><body><div class="panel"><img class="logo" src="{logo}"/><div class="name">Eos</div><div class="bar"></div><div class="caption">{caption}</div></div></body></html>"#,
        caption = escape(caption),
    )
}

/// The document as a `data:` URL a view can load.
pub fn splash_url(html: &str) -> String {
    format!("data:text/html;charset=utf-8;base64,{}", base64::engine::general_purpose::STANDARD.encode(html))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_caption_is_text_and_the_logo_is_inline() {
        let html = splash_html(&update_caption("0.1.2", "<0.1.3>"), Some(b"\x89PNG"));
        assert!(html.contains("Updating · 0.1.2 → &lt;0.1.3&gt;"));
        assert!(html.contains(r#"src="data:image/png;base64,iVBORw==""#));
        assert!(!splash_html("x", None).contains("base64,"));
        assert!(splash_url("<b>").starts_with("data:text/html;charset=utf-8;base64,PGI+"));
    }
}
