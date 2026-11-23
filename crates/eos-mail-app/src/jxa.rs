//! The JavaScript for Automation programs that talk to the Mail app. Each
//! takes its input as JSON in `argv[0]` and returns JSON text. Reads stay
//! in the inboxes and inside the window they are given, so a large mailbox
//! stays fast; a message is found again by its RFC Message-ID, never by
//! Mail's local id.

/// Whether Mail answers and has an account.
pub(crate) const CHECK: &str = r"
function run(argv) {
  const Mail = Application('Mail');
  return JSON.stringify({ accounts: Mail.accounts().length });
}
";

/// The inbox messages received after `since` (ms), newest first, at most
/// `limit`, without their text. Properties are read in one batch each.
pub(crate) const RECENT: &str = r"
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application('Mail');
  const found = Mail.inbox.messages.whose({ dateReceived: { _greaterThan: new Date(input.since) } });
  const ids = found.messageId(), subjects = found.subject(), senders = found.sender();
  const dates = found.dateReceived(), read = found.readStatus();
  const messages = [];
  for (let i = 0; i < ids.length; i++) {
    messages.push({ messageId: ids[i], subject: subjects[i] || '', from: senders[i] || '',
                    receivedAt: dates[i].getTime(), read: read[i] });
  }
  messages.sort((a, b) => b.receivedAt - a.receivedAt);
  return JSON.stringify({ messages: messages.slice(0, input.limit) });
}
";

/// One inbox message by its Message-ID, with its text; `found: false` when
/// no inbox holds it.
pub(crate) const READ: &str = r"
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application('Mail');
  const found = Mail.inbox.messages.whose({ messageId: input.messageId });
  if (found.length === 0) return JSON.stringify({ found: false });
  const m = found[0];
  return JSON.stringify({
    found: true, messageId: m.messageId(), subject: m.subject() || '', from: m.sender() || '',
    to: m.toRecipients().map(r => r.address()), receivedAt: m.dateReceived().getTime(),
    body: m.content() || '',
  });
}
";

/// Sends one plain mail to one address, without a window.
pub(crate) const SEND: &str = r"
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application('Mail');
  const message = Mail.OutgoingMessage({ subject: input.subject, content: input.body, visible: false });
  Mail.outgoingMessages.push(message);
  message.toRecipients.push(Mail.Recipient({ address: input.to }));
  return JSON.stringify({ sent: message.send() !== false });
}
";
