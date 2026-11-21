# Source this (after env.sh): memory's meaning model, the one home of its pins. The official
# minishlab/potion-multilingual-128M (MIT) at full size, f32, at one revision of its
# Hugging Face repository. The bundle ships it in Resources/models/<name>; the files are never
# committed. Where they come from, in this order:
#
#   EOS_BUNDLE_MODEL_DIR   a folder that holds the three files (read, never changed)
#   .work/models/<name>    the cache scripts/setup.sh keeps
#   the pinned URLs        downloaded by scripts/setup.sh only: a bundle, a test or a dev run
#                          never downloads
#
# Every file is checked against its size and SHA-256 below before it is bundled.
MODEL_NAME=potion-multilingual-128M
MODEL_REVISION=73908c3438cf03b6a01bcb9611d62b23d0726f08
MODEL_URL="https://huggingface.co/minishlab/$MODEL_NAME/resolve/$MODEL_REVISION"
MODEL_CACHE="$EOS_HOST_WORK/models/$MODEL_NAME"
# name, bytes, SHA-256
MODEL_PINS="config.json 271 595e4cab2093732efd5dbe084fd5c1826b5eea693b73b4c1fd971672867d2e54
tokenizer.json 18616131 19f1909063da3cfe3bd83a782381f040dccea475f4816de11116444a73e1b6a1
model.safetensors 512361560 14b5eb39cb4ce5666da8ad1f3dc6be4346e9b2d601c073302fa0a31bf7943397"

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
