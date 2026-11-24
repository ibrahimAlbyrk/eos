# SMS through your iPhone

Sends a short text to the user's own mobile number through the Messages app on this Mac.
Messages hands it to the user's iPhone, which sends it as an SMS (Text Message Forwarding must be
on for this Mac); without an SMS account it goes as an iMessage.

- `send_to_me` takes `{ "text": "…" }`, at most 600 characters, and answers
  `{ "sent": true, "via": "sms" | "imessage" }`. The number is the user's own setting: the input
  cannot name another one.
- `check` sees that Messages can be asked. It never opens Messages.

It works only while this Mac is awake and Eos runs. A text sent to one's own number may not
alert on the iPhone that sends it.
