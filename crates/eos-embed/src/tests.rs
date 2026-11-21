//! A tiny model written by the test itself: the real one is never fetched by
//! a test.

use std::path::Path;

use super::*;

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
    let started = std::time::Instant::now();
    let embedder = LocalEmbedder::load(Path::new(&dir)).expect("the real model loads");
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
