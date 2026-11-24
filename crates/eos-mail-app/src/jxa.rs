//! The JavaScript for Automation programs that talk to the Mail app. Each
//! reads its input as JSON on standard input (a page's mail is larger than
//! an argument may be) and returns JSON text. Reads stay
//! in the inboxes and inside the window they are given, so a large mailbox
//! stays fast; a message is found again by its RFC Message-ID, never by
//! Mail's local id.

/// Reads the program's input: JSON on standard input.
const READ_INPUT: &str = r"
ObjC.import('Foundation');
function readInput() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
}
";

/// A program with what reads its input before it.
pub(crate) fn with_input(program: &str) -> String {
    format!("{READ_INPUT}{program}")
}

/// Whether Mail answers and has an account.
pub(crate) const CHECK: &str = r"
function run() {
  const Mail = Application('Mail');
  return JSON.stringify({ accounts: Mail.accounts().length });
}
";

/// The inbox messages received after `since` (ms), newest first, at most
/// `limit`, without their text. Properties are read in one batch each.
pub(crate) const RECENT: &str = r"
function run() {
  const input = readInput();
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
function run() {
  const input = readInput();
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

/// Sends one mail to one address, without a window: its text, and for a
/// page its html, its images and its PDF as attachments. Images are written
/// to a folder of their own under the user's temporary folder, which goes
/// once Mail has taken the mail.
pub(crate) const SEND: &str = r"
function run() {
  const input = readInput();
  const Mail = Application('Mail');
  const message = Mail.OutgoingMessage({ subject: input.subject, content: input.body, visible: false });
  Mail.outgoingMessages.push(message);
  message.toRecipients.push(Mail.Recipient({ address: input.to }));
  if (input.html) {
    try { message.htmlContent = input.html; } catch (e) {}
  }
  const files = [];
  const images = input.images || [];
  let dir = null;
  if (images.length > 0) {
    dir = $.NSTemporaryDirectory().js + 'eos-mail-' + $.NSUUID.UUID.UUIDString.js + '/';
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
    images.forEach((image, n) => {
      const ext = image.contentType === 'image/png' ? 'png' : image.contentType === 'image/gif' ? 'gif'
        : image.contentType === 'image/webp' ? 'webp' : 'jpg';
      const path = dir + 'image-' + (n + 1) + '.' + ext;
      $.NSData.alloc.initWithBase64EncodedStringOptions(image.data, 0).writeToFileAtomically(path, true);
      files.push(path);
    });
  }
  if (input.pdf) files.push(input.pdf);
  files.forEach(path => message.content.attachments.push(Mail.Attachment({ fileName: Path(path) })));
  const sent = message.send() !== false;
  if (dir) $.NSFileManager.defaultManager.removeItemAtPathError(dir, $());
  return JSON.stringify({ sent: sent });
}
";
