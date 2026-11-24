// Sends the input's text to the number it is given, through the first SMS
// account Messages has, or as an iMessage when it has none. Prints
// {"sent":true,"via":…}.
ObjC.import('Foundation');

function readInput() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  return JSON.parse(text || '{}');
}

function run(argv) {
  const number = argv[0];
  const text = String(readInput().text || '');
  if (!number || !text) {
    throw new Error('nothing to send');
  }
  const messages = Application('Messages');
  const sms = messages.accounts.whose({ serviceType: 'SMS' });
  const via = sms.length > 0 ? 'sms' : 'imessage';
  const account = via === 'sms' ? sms[0] : messages.accounts.whose({ serviceType: 'iMessage' })[0];
  messages.send(text, { to: account.participants.byName(number) });
  return JSON.stringify({ sent: true, via: via });
}
