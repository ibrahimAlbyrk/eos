#!/bin/sh
# Answers its input back with what it was given to work with. `mode` picks a
# way to misbehave: fail, garble, sleep, flood.
input=$(cat)
case "$input" in
  *'"mode":"fail"'*) echo "it broke" >&2; exit 3 ;;
  *'"mode":"garble"'*) echo "not json"; exit 0 ;;
  *'"mode":"sleep"'*) sleep 10 ;;
  *'"mode":"flood"'*) head -c 2000000 /dev/zero | tr '\0' 'a'; exit 0 ;;
esac
token=no
[ -n "$ECHO_TOKEN" ] && token=yes
vars=$(env | cut -d= -f1 | sort | tr '\n' ' ')
printf '{"input":%s,"token":"%s","vars":"%s","pwd":"%s"}\n' "$input" "$token" "$vars" "$(pwd)"
