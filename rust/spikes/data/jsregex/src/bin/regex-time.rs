//! Times the regress-backed JsRegex: the ordinary case (policy-like patterns on
//! command-like inputs) and the pathological one, next to what the same
//! pattern costs in Node (ts/regex-time.ts).

use std::time::Instant;

use spike_jsregex::JsRegex;

fn main() {
    let ordinary = [
        r"^\s*rm\s+-[rRf]+\s+/(\s|$)",
        r"rm\s+-[rRf]+\s+[~/]?[^\s]*\.eos(?!/scratch/[^\s/]+/)",
        r"(^|\s)curl(?!.*--max-time)",
        r"^src/(?!generated/).*\.(ts|tsx)$",
        r"\.(env|pem|key)(\.[\w-]+)?$",
    ];
    let inputs = [
        "git status --short",
        "cd /Users/someone/Projects/app && npm test -- --watch=false 2>&1 | tail -40",
        "rm -rf ~/.eos/scratch/abc/build",
        "curl -s https://example.test/api/v1/items?limit=100 | jq '.items[] | .name'",
        "/Users/someone/Projects/app/src/components/Sidebar/SidebarItem.tsx",
    ];
    let compiled: Vec<JsRegex> = ordinary.iter().map(|p| JsRegex::new(p).expect("compiles")).collect();
    let rounds = 20_000;
    let start = Instant::now();
    let mut hits = 0u32;
    for _ in 0..rounds {
        for re in &compiled {
            for text in &inputs {
                hits += u32::from(re.test(text));
            }
        }
    }
    let per = start.elapsed().as_nanos() as f64 / (rounds * compiled.len() * inputs.len()) as f64;
    let start = Instant::now();
    for _ in 0..2000 {
        for p in &ordinary {
            std::hint::black_box(JsRegex::new(p).expect("compiles"));
        }
    }
    let compile = start.elapsed().as_nanos() as f64 / (2000 * ordinary.len()) as f64;
    println!("ordinary: {per:.0} ns per test(), {compile:.0} ns per compile ({hits} hits)");

    let evil = JsRegex::new(r"(a+)+$").expect("compiles");
    for n in [16usize, 20, 24] {
        let text = format!("{}!", "a".repeat(n));
        let start = Instant::now();
        let hit = evil.test(&text);
        println!("(a+)+$ on {n} a's + '!': {:.1} ms (match: {hit})", start.elapsed().as_secs_f64() * 1000.0);
    }
}
