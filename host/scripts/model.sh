# Source this (after env.sh): memory's meaning model, the one home of its pins.
# ibrahimAlbyrk/potion-multilingual-128M-en-tr-int8 (MIT): minishlab/potion-multilingual-128M
# cut to its English and Turkish vocabulary (234,823 pieces) and stored as int8 with one scale
# per row, about 70 MB, at one revision of its Hugging Face repository. The bundle ships it in
# Resources/models/<name>; the files are never committed. Where they come from, in this order:
#
#   EOS_BUNDLE_MODEL_DIR   a folder that holds the three files (read, never changed)
#   .work/models/<name>    the cache scripts/setup.sh keeps
#   the pinned URLs        downloaded by scripts/setup.sh only: a bundle, a test or a dev run
#                          never downloads
#
# Every file is checked against its size and SHA-256 below before it is bundled.
MODEL_NAME=potion-multilingual-128M-en-tr-int8
MODEL_REVISION=869858a74cbb06219019c5f26a3ad5b8c0ff5627
MODEL_URL="https://huggingface.co/ibrahimAlbyrk/$MODEL_NAME/resolve/$MODEL_REVISION"
MODEL_CACHE="$EOS_HOST_WORK/models/$MODEL_NAME"
# name, bytes, SHA-256
MODEL_PINS="config.json 271 595e4cab2093732efd5dbe084fd5c1826b5eea693b73b4c1fd971672867d2e54
tokenizer.json 8733456 50c5178294f7fd0ddfef7410b4fa3c77311ca7dc6d3e89b2af3aaa49976d65b7
model.safetensors 61054140 188dbed2001317afa63dd4d7207746f37118d3d72852b43eb0683f0fc3dfa73b"

# Says what is wrong with one file, or nothing when it is the pinned one.
model_file_problem() {
  local path="$1" bytes="$2" sha="$3" got
  [ -f "$path" ] || { echo "$path is missing"; return; }
  got="$(stat -f %z "$path")"
  [ "$got" = "$bytes" ] || { echo "$path has $got bytes, the pinned file $bytes"; return; }
  got="$(shasum -a 256 "$path" | cut -d' ' -f1)"
  [ "$got" = "$sha" ] || echo "$path has SHA-256 $got, the pinned file $sha"
}

# Succeeds when `dir` holds the three pinned files; names each one that is not.
model_check() {
  local dir="$1" name bytes sha problem ok=0
  while read -r name bytes sha; do
    problem="$(model_file_problem "$dir/$name" "$bytes" "$sha")"
    [ -z "$problem" ] || { echo "meaning model: $problem" >&2; ok=1; }
  done <<<"$MODEL_PINS"
  return $ok
}

# The folder the bundle takes the model from, unchecked; empty when there is none.
model_source() {
  if [ -n "${EOS_BUNDLE_MODEL_DIR:-}" ]; then
    echo "$EOS_BUNDLE_MODEL_DIR"
  elif [ -d "$MODEL_CACHE" ]; then
    echo "$MODEL_CACHE"
  fi
}
