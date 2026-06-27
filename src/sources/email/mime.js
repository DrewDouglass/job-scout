/**
 * mime.js — PURE, zero-dep extraction of headers + the text/html body from a raw RFC822 message.
 * Enough MIME to read job-alert emails (multipart/alternative + quoted-printable/base64). Not a full
 * MIME parser — best-effort, defensive, used by both the Apple Mail (.emlx) and IMAP readers.
 */

function splitHeadersBody(raw) {
  const s = String(raw || '');
  let i = s.indexOf('\r\n\r\n'); let sep = 4;
  if (i < 0) { i = s.indexOf('\n\n'); sep = 2; }
  if (i < 0) return { head: s, body: '' };
  return { head: s.slice(0, i), body: s.slice(i + sep) };
}

/** Parse a header block into a lowercase-keyed map; unfolds continued (indented) lines. */
function parseHeaders(head) {
  const out = {};
  const lines = String(head || '').replace(/\r\n/g, '\n').split('\n');
  let cur = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += ' ' + line.trim(); continue; }
    const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
    if (m) { cur = m[1].toLowerCase(); out[cur] = (out[cur] ? out[cur] + ' ' : '') + m[2]; }
  }
  return out;
}

function decodeQuotedPrintable(s) {
  return String(s || '')
    .replace(/=\r?\n/g, '')                                   // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function charsetOf(contentType) {
  const m = String(contentType || '').match(/charset="?([^";]+)"?/i);
  return m ? m[1].toLowerCase() : 'utf-8';
}
/** Decode a byte Buffer with the declared charset, falling back to utf-8 then latin1 (never throws). */
function decodeWithCharset(bytes, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch { try { return new TextDecoder('utf-8').decode(bytes); } catch { return bytes.toString('latin1'); } }
}
function decodeBody(body, cte, charset) {
  const enc = String(cte || '').toLowerCase();
  const cs = charset || 'utf-8';
  // base64: decode from the ORIGINAL encoded bytes, so any charset round-trips cleanly.
  if (enc.includes('base64')) { try { return decodeWithCharset(Buffer.from(String(body).replace(/\s+/g, ''), 'base64'), cs); } catch { return ''; } }
  // quoted-printable: =XX → raw bytes → charset decode (so utf-8-in-QP, the common alert case, isn't mojibake).
  if (enc.includes('quoted-printable')) return decodeWithCharset(Buffer.from(decodeQuotedPrintable(body), 'latin1'), cs);
  if (cs === 'utf-8' || cs === 'utf8') return String(body || '');
  return decodeWithCharset(Buffer.from(String(body || ''), 'latin1'), cs);
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function boundaryOf(contentType) {
  const m = String(contentType || '').match(/boundary="?([^";]+)"?/i);
  return m ? m[1] : null;
}

/**
 * Extract the best text/html body from a raw message (recurses into multipart). Returns '' if none.
 */
function extractHtml(raw, depth = 0) {
  if (depth > 6) return '';
  const { head, body } = splitHeadersBody(raw);
  const headers = parseHeaders(head);
  const ct = (headers['content-type'] || 'text/plain').toLowerCase();

  if (ct.startsWith('multipart/')) {
    const boundary = boundaryOf(headers['content-type']);
    if (!boundary) return '';
    // Split only on a boundary at the START of a line (real MIME) — a body line that merely
    // contains "--boundary" mid-text must not mis-split and truncate the part. (M4)
    const parts = String(body).split(new RegExp('(?:^|\\r?\\n)--' + escapeRegex(boundary))).slice(1);
    let htmlFromAny = '';
    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, '');
      if (trimmed.startsWith('--')) break; // closing boundary
      const inner = extractHtml(trimmed, depth + 1);
      if (inner) {
        // prefer the html part; multipart/alternative lists text then html, so last wins
        htmlFromAny = inner;
      }
    }
    return htmlFromAny;
  }

  if (ct.startsWith('text/html')) return decodeBody(body, headers['content-transfer-encoding'], charsetOf(headers['content-type']));
  return ''; // text/plain etc. — we only want the HTML for link extraction
}

/** Convenience: headers + html in one pass. */
function parseMessage(raw) {
  const { head } = splitHeadersBody(raw);
  return { headers: parseHeaders(head), html: extractHtml(raw) };
}

module.exports = { splitHeadersBody, parseHeaders, decodeQuotedPrintable, decodeBody, charsetOf, extractHtml, parseMessage };
