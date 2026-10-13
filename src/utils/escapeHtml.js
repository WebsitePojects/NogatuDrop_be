// Escapes text for an HTML email body. Anything a buyer typed (name, address) goes through this before it
// is placed in a template, so it shows as text and can never add markup or links to an email we send.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

module.exports = { escapeHtml };
