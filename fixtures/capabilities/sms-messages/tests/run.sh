#!/bin/zsh
# The package's offline tests. A fake osascript comes first on PATH, so
# nothing reaches Messages; the tests stop before anything runs if it does not.
emulate -L zsh
here=${0:A:h}
cd "${here:h}" || exit 1
fake=$(mktemp -d "${TMPDIR:-/tmp}/sms-tests.XXXXXX") || exit 1
trap 'rm -rf "$fake"' EXIT
cp tests/fake-osascript "$fake/osascript" && chmod +x "$fake/osascript" || exit 1
export PATH="$fake:/usr/bin:/bin"
if [[ $(whence -p osascript) != "$fake/osascript" ]]; then
  print -u2 "the fake osascript is not the one found"
  exit 1
fi
export FAKE_LOG="$fake/log"
failed=0
fail() { print -u2 "FAIL: $1"; failed=1 }

unset EOS_SETTING_PHONE_NUMBER
print '{"text":"hi"}' | zsh send.sh >/dev/null 2>&1
[[ $? == 2 ]] || fail "without a number it sends nothing"
[[ -e $FAKE_LOG.args ]] && fail "without a number osascript was not asked"

for bad in 'call me' '12' '+1 555 0100; rm -rf ~' '+15550100000000000000000'; do
  print '{"text":"hi"}' | EOS_SETTING_PHONE_NUMBER=$bad zsh send.sh >/dev/null 2>&1
  [[ $? == 2 ]] || fail "a number like '$bad' is refused"
done
[[ -e $FAKE_LOG.args ]] && fail "a bad number never reaches osascript"

out=$(print -rn '{"text":"Your paper is ready"}' | EOS_SETTING_PHONE_NUMBER='+90 555 010 0000' zsh send.sh)
[[ $? == 0 ]] || fail "a text to a set number is sent"
[[ $out == '{"sent":true,"via":"sms"}' ]] || fail "it answers what the script printed"
[[ $(<$FAKE_LOG.args) == $'-l\nJavaScript\nsend.js\n+90 555 010 0000' ]] || fail "the number goes to the script as one argument"
[[ $(<$FAKE_LOG.stdin) == '{"text":"Your paper is ready"}' ]] || fail "the input reaches the script unchanged"

exit $failed
