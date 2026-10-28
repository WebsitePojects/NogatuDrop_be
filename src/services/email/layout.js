const env = require('../../config/env');
const { escapeHtml } = require('../../utils/escapeHtml');

// One designed layout for every email the system sends (store buyers and staff). Email clients ignore
// most modern CSS, so this is table-based with inline styles, a 600px card that shrinks on phones, and
// web-safe font stacks. Callers pass structured blocks, never raw HTML: every value is escaped here.

const C = Object.freeze({
  page: '#F4EDE4', card: '#FFFFFF', line: '#EADFCF', brand: '#3D1800', accent: '#B85C00',
  accentSoft: '#FFF4E6', ink: '#1F1712', muted: '#6B5E53', faint: '#A39587',
  good: '#1E7B34', goodSoft: '#EAF6EC', bad: '#B3311F', badSoft: '#FDECEA', warnSoft: '#FFF8E6', warn: '#8A5A00',
});
const SERIF = "'DM Serif Display', Georgia, 'Times New Roman', serif";
const SANS = "'Plus Jakarta Sans', 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Consolas, 'Courier New', monospace";

/** The store's public address (links, logo). */
function siteUrl(path = '') {
  return `${String(env.PUBLIC_BASE_URL || 'https://nogatu.store').replace(/\/+$/, '')}${path}`;
}

const TONES = {
  info: [C.accentSoft, C.accent], good: [C.goodSoft, C.good], bad: [C.badSoft, C.bad], warn: [C.warnSoft, C.warn],
};

function steps({ labels, current, cancelled = false }) {
  const cells = labels.map((label, i) => {
    const done = !cancelled && i < current;
    const now = !cancelled && i === current;
    const dot = done ? `background:${C.good};border:2px solid ${C.good};color:#fff`
      : now ? `background:${C.accent};border:2px solid ${C.accent};color:#fff`
        : `background:#fff;border:2px solid ${C.line};color:${C.faint}`;
    const mark = done ? '&#10003;' : String(i + 1);
    const text = now ? `color:${C.ink};font-weight:700` : `color:${done ? C.muted : C.faint}`;
    return `<td align="center" valign="top" style="padding:0 2px;width:${Math.floor(100 / labels.length)}%">
      <div style="width:26px;height:26px;line-height:26px;border-radius:13px;margin:0 auto;font:700 12px ${SANS};${dot}">${mark}</div>
      <div style="margin-top:6px;font:12px/1.3 ${SANS};${text}">${escapeHtml(label)}</div></td>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 22px"><tr>${cells}</tr></table>`;
}

function details(rows) {
  const body = rows.filter(([, v]) => v != null && v !== '').map(([label, value, mono]) => `<tr>
      <td style="padding:9px 0;border-bottom:1px solid ${C.line};font:13px ${SANS};color:${C.muted};width:42%">${escapeHtml(label)}</td>
      <td align="right" style="padding:9px 0;border-bottom:1px solid ${C.line};font:600 14px ${mono ? MONO : SANS};color:${C.ink}">${escapeHtml(value)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid ${C.line}">${body}</table>`;
}

function highlight({ label, value, mono = false }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>
    <td align="center" style="background:${C.accentSoft};border-radius:12px;padding:18px 12px">
      <div style="font:600 11px ${SANS};letter-spacing:2px;text-transform:uppercase;color:${C.accent}">${escapeHtml(label)}</div>
      <div style="margin-top:6px;font:700 ${mono ? '30px' : '26px'} ${mono ? MONO : SANS};letter-spacing:${mono ? '6px' : '0'};color:${C.brand}">${escapeHtml(value)}</div>
    </td></tr></table>`;
}

function notice({ tone = 'info', text }) {
  const [bg, fg] = TONES[tone] || TONES.info;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>
    <td style="background:${bg};border:1px solid ${fg}33;border-radius:10px;padding:12px 14px;font:14px/1.5 ${SANS};color:${fg}">${escapeHtml(text)}</td></tr></table>`;
}

function button({ label, href }, primary = true) {
  const style = primary
    ? `background:${C.accent};color:#ffffff;border:1px solid ${C.accent}`
    : `background:#ffffff;color:${C.brand};border:1px solid ${C.line}`;
  return `<a href="${escapeHtml(href)}" style="${style};display:inline-block;padding:13px 22px;border-radius:10px;font:700 15px ${SANS};text-decoration:none;margin:0 6px 8px 0">${escapeHtml(label)}</a>`;
}

const paragraph = (text) => `<p style="margin:0 0 14px;font:15px/1.6 ${SANS};color:${C.ink}">${escapeHtml(text)}</p>`;

/**
 * Builds an email from blocks. Every string is text (escaped); links must be http(s).
 * @param {object} spec
 * @param {string} spec.subject
 * @param {string} spec.preheader      one line shown after the subject in the inbox list
 * @param {string} [spec.eyebrow]      small label above the heading (e.g. "Order #PUB-…")
 * @param {string} spec.heading
 * @param {string} [spec.greeting]     e.g. "Hi Maria,"
 * @param {Array}  spec.blocks         [{ p }, { steps }, { details }, { highlight }, { notice }, { actions }]
 * @param {string} spec.footerNote     why the reader got this email
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderEmail(spec) {
  const parts = [];
  const text = [spec.eyebrow, spec.greeting, spec.heading, ''].filter((t) => t !== undefined);
  for (const block of spec.blocks) {
    if (block.p) { parts.push(paragraph(block.p)); text.push(block.p, ''); }
    if (block.steps) {
      parts.push(steps(block.steps));
      text.push(block.steps.cancelled ? 'Status: cancelled' : `Status: ${block.steps.labels[block.steps.current]}`, '');
    }
    if (block.details) {
      parts.push(details(block.details));
      for (const [label, value] of block.details) if (value != null && value !== '') text.push(`${label}: ${value}`);
      text.push('');
    }
    if (block.highlight) { parts.push(highlight(block.highlight)); text.push(`${block.highlight.label}: ${block.highlight.value}`, ''); }
    if (block.notice) { parts.push(notice(block.notice)); text.push(block.notice.text, ''); }
    if (block.actions) {
      const safe = block.actions.filter((a) => /^https?:\/\//i.test(a.href));
      parts.push(`<div style="margin:6px 0 18px">${safe.map((a, i) => button(a, i === 0)).join('')}</div>`);
      for (const a of safe) text.push(`${a.label}: ${a.href}`);
      text.push('');
    }
  }
  text.push('--', spec.footerNote, `Nogatu Alliance Official Store  ${siteUrl()}`);

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(spec.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${escapeHtml(spec.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
    <tr><td style="background:${C.brand};border-radius:16px 16px 0 0;padding:18px 24px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle" style="padding-right:12px"><img src="${escapeHtml(siteUrl('/assets/email/nogatu-logo-112.png'))}" width="44" height="40" alt="Nogatu" style="display:block;border:0"></td>
        <td valign="middle"><div style="font:400 20px ${SERIF};color:#FFF4E6">Nogatu Alliance</div>
          <div style="font:600 10px ${SANS};letter-spacing:3px;text-transform:uppercase;color:#E9B97A">Official Store</div></td>
      </tr></table>
    </td></tr>
    <tr><td style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 16px 16px;padding:28px 24px 12px">
      ${spec.eyebrow ? `<div style="font:600 11px ${SANS};letter-spacing:2px;text-transform:uppercase;color:${C.accent};margin-bottom:6px">${escapeHtml(spec.eyebrow)}</div>` : ''}
      <h1 style="margin:0 0 16px;font:400 26px/1.25 ${SERIF};color:${C.brand}">${escapeHtml(spec.heading)}</h1>
      ${spec.greeting ? paragraph(spec.greeting) : ''}
      ${parts.join('\n      ')}
    </td></tr>
    <tr><td align="center" style="padding:18px 16px 8px;font:12px/1.6 ${SANS};color:${C.muted}">
      ${escapeHtml(spec.footerNote)}<br>
      <a href="${escapeHtml(siteUrl())}" style="color:${C.accent};text-decoration:none;font-weight:600">nogatu.store</a> &middot; Nogatu Alliance Official Store
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject: spec.subject, html, text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

module.exports = { renderEmail, siteUrl };
