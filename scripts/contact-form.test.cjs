const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const html = readFileSync(new URL('../profile.html', `file://${__filename}`), 'utf8');
const start = html.indexOf("      const contactForm = document.getElementById('contact-form');");
const source = html.slice(start, html.indexOf('      const broadcast =', start));
function submit(fields, valid) {
  let listener, reported = false;
  const status = {};
  const form = { addEventListener: (_, fn) => listener = fn, checkValidity: () => valid, reportValidity: () => reported = true };
  const window = { location: { href: 'unchanged' } };
  const context = { document: { getElementById: id => id === 'contact-form' ? form : status }, FormData: class { get(key) { return fields[key]; } }, window, encodeURIComponent };
  vm.runInNewContext(source, context);
  listener({ preventDefault() {} });
  return { status, href: window.location.href, reported };
}
test('contact rejects empty and whitespace-only messages', () => {
  const result = submit({ name: 'Ty', from: 'fan@example.com', message: '   ' }, true);
  assert.equal(result.href, 'unchanged');
  assert.match(result.status.textContent, /Fill in/);
});
test('contact rejects invalid email without opening an email app', () => {
  const result = submit({ name: 'Fan', from: 'invalid', message: 'Hello' }, false);
  assert.equal(result.href, 'unchanged');
  assert.equal(result.reported, true);
  assert.match(result.status.textContent, /valid email/);
});
test('valid contact creates an escaped email draft', () => {
  const result = submit({ name: 'Fan & friend', from: 'fan@example.com', subject: 'Collaboration', message: 'Hello? & thanks!' }, true);
  const url = new URL(result.href);
  assert.equal(url.protocol, 'mailto:');
  assert.equal(url.searchParams.get('subject'), '[Collaboration] Fan & friend');
  assert.match(url.searchParams.get('body'), /Hello\? & thanks!/);
});
