#!/bin/zsh
# Sends the text in the JSON on stdin to the user's own number. The number is
# the user's setting, never part of the input, so this reaches only the user.
emulate -L zsh
number=${EOS_SETTING_PHONE_NUMBER-}
if [[ ! $number =~ '^\+?[0-9][0-9 ()-]{5,19}$' ]]; then
  print -u2 "no phone number is set"
  exit 2
fi
# stdin passes through to the script, which reads the text from it.
exec osascript -l JavaScript send.js "$number"
