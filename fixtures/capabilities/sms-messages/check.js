// Sees that Messages can be asked, without opening it: a Messages that is not
// running is started by the first send. Prints {"ok":true,…}.
function run() {
  const messages = Application('Messages');
  if (!messages.running()) {
    return JSON.stringify({ ok: true, running: false });
  }
  const sms = messages.accounts.whose({ serviceType: 'SMS' }).length;
  return JSON.stringify({ ok: true, running: true, sms: sms > 0 });
}
