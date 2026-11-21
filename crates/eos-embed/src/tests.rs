//! A tiny model written by the test itself: the real one is never fetched by
//! a test.

use std::path::Path;

use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};

use super::*;

/// Counts the heap, so the real-model test can say what the loaded model holds.
#[global_allocator]
static HEAP: &StatsAlloc<std::alloc::System> = &INSTRUMENTED_SYSTEM;

/// Held by each test that loads the real model, so one load never counts in
/// another's heap.
static REAL_MODEL: std::sync::Mutex<()> = std::sync::Mutex::new(());

const VOCAB: [&str; 5] = ["[UNK]", "lint", "push", "before", "template"];
const DIMS: usize = 4;

fn tokenizer() -> String {
    let vocab: Vec<String> = VOCAB.iter().enumerate().map(|(i, w)| format!("\"{w}\": {i}")).collect();
    format!(
        r###"{{"version": "1.0", "truncation": null, "padding": null,
        "added_tokens": [{{"id": 0, "content": "[UNK]", "single_word": false, "lstrip": false, "rstrip": false, "normalized": false, "special": true}}],
        "normalizer": {{"type": "BertNormalizer", "clean_text": true, "handle_chinese_chars": true, "strip_accents": null, "lowercase": true}},
        "pre_tokenizer": {{"type": "BertPreTokenizer"}}, "post_processor": null, "decoder": null,
        "model": {{"type": "WordPiece", "unk_token": "[UNK]", "continuing_subword_prefix": "##", "max_input_chars_per_word": 100, "vocab": {{{}}}}}}}"###,
        vocab.join(", ")
    )
}

/// One f32 row per word, each pointing its own way.
fn safetensors() -> Vec<u8> {
    let rows = VOCAB.len();
    let mut data = Vec::new();
    for row in 0..rows {
        for col in 0..DIMS {
            let value: f32 = if row % DIMS == col { 1.0 } else { 0.1 };
            data.extend_from_slice(&value.to_le_bytes());
        }
    }
    let mut header =
        format!(r#"{{"embeddings":{{"dtype":"F32","shape":[{rows},{DIMS}],"data_offsets":[0,{}]}}}}"#, data.len());
    while header.len() % 8 != 0 {
        header.push(' ');
    }
    let mut out = (header.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&data);
    out
}

fn write_model(dir: &Path) {
    std::fs::create_dir_all(dir).expect("dir");
    std::fs::write(dir.join("tokenizer.json"), tokenizer()).expect("tokenizer");
    std::fs::write(dir.join("model.safetensors"), safetensors()).expect("model");
    std::fs::write(dir.join("config.json"), r#"{"normalize": true}"#).expect("config");
}

#[tokio::test]
async fn a_model_folder_loads_and_embeds_each_text_the_same_way_every_time() {
    let tmp = tempfile::tempdir().expect("tmp");
    let dir = tmp.path().join("tiny-model");
    write_model(&dir);
    let embedder = LocalEmbedder::load(&dir).expect("loads");
    assert_eq!(embedder.model(), "tiny-model");
    assert_eq!(embedder.dims(), DIMS);
    let texts = vec!["Lint before push".to_owned(), "template".to_owned(), "lint before push".to_owned()];
    let vectors = embedder.embed(&texts).await.expect("embeds");
    assert_eq!(vectors.len(), 3);
    assert!(vectors.iter().all(|v| v.len() == DIMS));
    assert_eq!(vectors[0], vectors[2], "the same words, the same vector");
    assert_ne!(vectors[0], vectors[1]);
    let norm: f32 = vectors[1].iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!((norm - 1.0).abs() < 1e-4, "normalized: {norm}");
}

#[test]
fn a_folder_without_a_model_file_is_refused_by_name() {
    let tmp = tempfile::tempdir().expect("tmp");
    let dir = tmp.path().join("m");
    write_model(&dir);
    std::fs::remove_file(dir.join("model.safetensors")).expect("remove");
    match LocalEmbedder::load(&dir) {
        Err(Error::Missing(path)) => assert!(path.ends_with("model.safetensors")),
        other => panic!("{other:?}"),
    }
    std::fs::write(dir.join("model.safetensors"), b"not a model").expect("write");
    assert!(matches!(LocalEmbedder::load(&dir), Err(Error::Invalid(_))));
}

/// The shipped model, loaded from the folder `EOS_EMBED_MODEL_DIR` names;
/// skipped without it, so the normal check never needs the files.
#[tokio::test]
async fn the_real_model_loads_and_puts_near_meanings_closer_than_unrelated_ones() {
    let Some(dir) = std::env::var_os(MODEL_DIR_VAR) else {
        eprintln!("skipped: {MODEL_DIR_VAR} is not set");
        return;
    };
    let alone = REAL_MODEL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let started = std::time::Instant::now();
    let embedder = LocalEmbedder::load(Path::new(&dir)).expect("the real model loads");
    drop(alone);
    eprintln!("load: {:?}", started.elapsed());
    assert_eq!(embedder.dims(), 256);
    let texts: Vec<String> = [
        "Run the linter before you push.",
        "Lint the code before pushing it.",
        "Push etmeden önce linter'ı çalıştır.",
        "Kodu göndermeden önce lint çalıştır.",
        "The cat sleeps on the warm sofa.",
        "Kedi sıcak kanepede uyuyor.",
    ]
    .map(str::to_owned)
    .to_vec();
    let started = std::time::Instant::now();
    let vectors = embedder.embed(&texts).await.expect("embeds");
    eprintln!("per text: {:?}", started.elapsed() / texts.len() as u32);
    for v in &vectors {
        assert_eq!(v.len(), 256);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "normalized: {norm}");
    }
    let cos = |a: usize, b: usize| -> f32 { vectors[a].iter().zip(&vectors[b]).map(|(x, y)| x * y).sum() };
    // English near English, Turkish near Turkish, and each language near the other.
    for (near, far) in [((0, 1), (0, 4)), ((2, 3), (2, 5)), ((0, 2), (0, 5)), ((5, 4), (5, 3))] {
        assert!(
            cos(near.0, near.1) > cos(far.0, far.1),
            "{near:?} {} vs {far:?} {}",
            cos(near.0, near.1),
            cos(far.0, far.1)
        );
    }
}

/// English and Turkish texts whose vectors were recorded from model2vec-rs
/// 0.4.0 as published, with the shipped potion-multilingual-128M-en-tr-int8.
const RECORDED: [(&str, u64); 11] = [
    ("Run the linter before you push.", 0x63b620af05da50f1),
    ("Lint the code before pushing it.", 0x37dc8dd009345d2e),
    ("Push etmeden önce linter'ı çalıştır.", 0x26bd5b7b9f47dc91),
    ("Kodu göndermeden önce lint çalıştır.", 0xd191f2d3f92e9437),
    ("The database migration failed because the table already exists.", 0x7d0e43d6d2841a46),
    ("Veritabanı göçü tablo zaten var olduğu için başarısız oldu.", 0x310409f07f9c2e59),
    ("Keep review remarks short and skip style nits.", 0xc07167403054ffe0),
    ("İnceleme notlarını kısa tut, biçim ayrıntılarını atla.", 0x9b3e3957ac52dd3e),
    ("Ölçüm sonuçları dün akşamdan beri değişmedi; İstanbul'daki sunucu yavaş.", 0x388f687b6927e916),
    ("ünïcödé — mixed 123 symbols: ∑ ≤ ∞ 🙂", 0x2fe02dd4af099fe2),
    ("", 0x51d88627df287325),
];

/// FNV-1a over a vector's bits: equal hashes mean byte-for-byte equal vectors.
fn bits_hash(vector: &[f32]) -> u64 {
    vector
        .iter()
        .flat_map(|x| x.to_bits().to_le_bytes())
        .fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

/// The shipped model gives exactly the vectors recorded from the published
/// loader, and the test reports what the loaded model holds on the heap.
#[tokio::test]
async fn the_real_model_gives_the_recorded_vectors_byte_for_byte() {
    let Some(dir) = std::env::var_os(MODEL_DIR_VAR) else {
        eprintln!("skipped: {MODEL_DIR_VAR} is not set");
        return;
    };
    let alone = REAL_MODEL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let heap = Region::new(HEAP);
    let embedder = LocalEmbedder::load(Path::new(&dir)).expect("the real model loads");
    let change = heap.change();
    drop(alone);
    let live = change.bytes_allocated as i64 - change.bytes_deallocated as i64 + change.bytes_reallocated as i64;
    eprintln!("live heap after load: {} MB", live / 1_000_000);
    // The int8 table is 60 MB: a table widened to f32 or a second copy of the
    // vocabulary would each go far over this.
    assert!(live < 200_000_000, "the loaded model holds {live} bytes");
    let texts: Vec<String> = RECORDED.iter().map(|(text, _)| (*text).to_owned()).collect();
    let vectors = embedder.embed(&texts).await.expect("embeds");
    let got: Vec<(&str, u64)> = RECORDED.iter().zip(&vectors).map(|((text, _), v)| (*text, bits_hash(v))).collect();
    assert_eq!(got, RECORDED, "the vectors differ from the recorded ones");
}
