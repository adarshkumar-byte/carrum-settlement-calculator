// parse.js - pure functions (no DOM). Turns the text lines of a credit-card statement
// into transactions. Used by import.js and unit-tested in Node.
//
// Handles the common layouts of Indian card statements (date first, amount last, optional
// Cr/Dr/C/D marker, optional time / second date / reference number / reward points).
// Anything it cannot read is simply not listed; the user always reviews before saving.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const fullYear = y => (y < 100 ? 2000 + y : y);

export function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

const DATE_NUM = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})(?!\d)/;
const DATE_TXT = /^(\d{1,2})[ \-\/]?([A-Za-z]{3})[A-Za-z]*\.?(?:[ ,\-\/]*(\d{4}|\d{2})(?!\d))?/;

// Reads a date at the start of `s`. Returns { iso, rest } or null.
// ctx = { y, m } (statement year/month) is used when the year is missing ("27 Sep").
export function readDate(s, ctx) {
  let m = s.match(DATE_NUM);
  if (m) {
    const iso = isoDate(fullYear(+m[3]), +m[2], +m[1]);
    return iso ? { iso, rest: s.slice(m[0].length) } : null;
  }
  m = s.match(DATE_TXT);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const mon = MONTHS[m[2].toLowerCase()];
    let y = m[3] ? fullYear(+m[3]) : ctx.y;
    if (!m[3] && mon > ctx.m) y -= 1; // e.g. a December purchase on a January statement
    const iso = isoDate(y, mon, +m[1]);
    return iso ? { iso, rest: s.slice(m[0].length) } : null;
  }
  return null;
}

const AMOUNT_END = /(-?)\s*(\d[\d,]*\.\d{2})\s*(cr|dr|c|d)?\.?\s*$/i;
const CREDIT_DESC = /(payment\s*(received|recd|thank)|received\s*with\s*thanks|thank\s*you|refund|reversal|cash\s*back\s*(credit|received)|credit\s*voucher|waiver|neft\s*payment|imps\s*payment|bbps\s*payment)/i;
const SKIP_DESC = /^(total|sub\s*total|opening|closing|previous\s*balance|minimum|amount\s*due|payment\s*due|credit\s*limit|available|statement|reward|points|balance|page)\b/i;

// Finds the statement date so year-less dates ("27 Sep") can be placed in the right year.
export function detectContext(lines, today = new Date()) {
  const text = lines.join('\n');
  const num = '(\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4})';
  let m = text.match(new RegExp('statement\\s*(?:date|period)?[^0-9A-Za-z]{0,6}(?:\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}\\s*(?:to|-|–)\\s*)?' + num, 'i'));
  if (!m) m = text.match(new RegExp(num + '\\s*(?:to|-|–)\\s*' + num, 'i'));
  if (m) {
    const last = m[m.length - 1];
    const d = readDate(last, { y: today.getFullYear(), m: 12 });
    if (d) return { y: +d.iso.slice(0, 4), m: +d.iso.slice(5, 7), iso: d.iso };
  }
  m = text.match(/statement\s*date[^A-Za-z0-9]{0,6}(\d{1,2})[ \-]([A-Za-z]{3})[a-z]*[ ,\-]*(\d{4}|\d{2})/i);
  if (m && MONTHS[m[2].toLowerCase()]) return { y: fullYear(+m[3]), m: MONTHS[m[2].toLowerCase()] };
  return { y: today.getFullYear(), m: today.getMonth() + 1 };
}

// Parses one text line. Returns { iso, desc, amount, credit } or null if it is not a transaction.
export function parseLine(line, ctx) {
  let s = String(line).replace(/[ \t]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[^\w]+(?=\d)/, '');
  const d1 = readDate(s, ctx);
  if (!d1) return null;
  // Strip separators / OCR noise ("| ] ."), an optional time of day, and an optional posting date.
  const junk = t => t.replace(/^[^A-Za-z0-9]+/, '');
  let rest = junk(d1.rest.trim());
  rest = junk(rest.replace(/^\d{1,2}:\d{2}(:\d{2})?(\s*(am|pm)\b)?/i, ''));        // time of day (AM/PM only when a whole word)
  const d2 = readDate(rest, ctx); if (d2) rest = junk(d2.rest.trim());               // posting date
  rest = rest.replace(/^\d{9,}\s+/, '');                                             // long reference number

  const m = rest.match(AMOUNT_END);
  if (!m) return null;
  let desc = rest.slice(0, m.index).trim();
  const marker = (m[3] || '').toLowerCase();
  const amount = parseFloat(m[2].replace(/,/g, ''));
  if (!(amount > 0)) return null;

  desc = desc.replace(/(\s[A-Z]{2})\s+\d{1,5}$/, '$1');                              // ICICI style: "... MUMBAI IN 4" (4 = reward points)
  desc = desc.replace(/\s*[+\-]\s*\d{1,6}\s*$/, '');                                 // reward points "+ 12"
  desc = desc.replace(/\s*\b[A-Z]{3}\s*[\d,]+\.\d{2}\s*$/, '');                      // foreign amount "USD 12.00"
  desc = desc.replace(/\s*(?:₹|€|£|¢|©|Rs\.?|INR|`|\bC)\s*$/i, '');                          // currency marker before amount ("C 1,250.00")
  desc = desc.replace(/\s*[+\-]\s*\d{1,6}\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]{2}/.test(desc) || desc.length < 2 || SKIP_DESC.test(desc)) return null;

  const credit = m[1] === '-' || marker === 'cr' || marker === 'c' || CREDIT_DESC.test(desc);
  return { iso: d1.iso, desc: desc.slice(0, 80), amount, credit };
}

// Parses a whole statement (array of text lines).
export function parseStatement(lines, today = new Date()) {
  const ctx = detectContext(lines, today);
  const debits = [], credits = [];
  for (const line of lines) {
    const r = parseLine(line, ctx);
    if (r) (r.credit ? credits : debits).push(r);
  }
  return { debits, credits, ctx };
}

// ---- categories ----
export const RULES = [
  ['Food', /swiggy|zomato|restaurant|cafe|coffee|dominos|domino|mcdonald|kfc|pizza|burger|starbucks|bakery|biryani|blinkit|zepto|bigbasket|big basket|instamart|dmart|d mart|grofers|more retail|nature'?s basket|licious|eatfit|barbeque|haldiram|chaayos|food|kitchen|dhaba|sweets/i],
  ['Transport', /uber|ola\b|olacabs|rapido|irctc|redbus|fuel|petrol|diesel|hpcl|bpcl|iocl|indian oil|bharat petroleum|shell|fastag|metro|railway|makemytrip|goibibo|indigo|air india|vistara|akasa|spicejet|cleartrip|yatra|parking|toll/i],
  ['Bills', /airtel|jio\b|reliance jio|vodafone|vi\b|bsnl|electric|bescom|msedcl|tata power|adani|gas\b|water|insurance|lic\b|broadband|fibernet|act fibernet|dth|tatasky|tata play|postpaid|recharge|rent|maintenance|school|tuition|emi\b|loan|bbps|utility|municipal|tax/i],
  ['Shopping', /amazon|flipkart|myntra|ajio|nykaa|meesho|reliance|croma|decathlon|lifestyle|westside|pantaloons|max fashion|tata cliq|shoppers stop|ikea|zara|h&m|uniqlo|bata|titan|tanishq|apple|samsung|vijay sales|mall|store|mart\b|retail/i],
  ['Health', /apollo|pharm|1mg|netmeds|medplus|medical|hospital|clinic|diagnostic|lab\b|labs\b|dental|dr\.? |health|cult\.?fit|gym|wellness|optical|lenskart/i],
  ['Entertainment', /netflix|spotify|hotstar|disney|bookmyshow|pvr|inox|prime video|youtube|steam|playstation|xbox|gaming|zee5|sonyliv|jiocinema|audible|movie|cinema|club|resort|amusement|wonderla/i]
];

// Short key for remembering a merchant -> category choice (first two words, letters only).
export function merchantKey(desc) {
  return String(desc).toLowerCase().replace(/[^a-z ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
}

export function categorize(desc, learned = {}, allowed = null) {
  const k = merchantKey(desc);
  let cat = Object.prototype.hasOwnProperty.call(learned, k) ? learned[k] : null;
  if (!cat) for (const [name, re] of RULES) if (re.test(desc)) { cat = name; break; }
  cat = cat || 'Miscellaneous';
  return !allowed || allowed.includes(cat) ? cat : 'Miscellaneous';
}

// ---- stable ids so importing the same bill twice never creates duplicates ----
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function assignIds(rows) {
  const seen = Object.create(null);
  return rows.map(r => {
    const base = `${r.iso}|${r.amount.toFixed(2)}|${r.desc.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
    const n = seen[base] = (seen[base] || 0) + 1;
    return { ...r, id: 'cc' + hash53(base).toString(36) + (n > 1 ? '-' + n : '') };
  });
}

// ---- PDF text items -> lines ----
// items: [{ str, x, y }]. Items with (almost) the same y form one line, ordered left to right.
export function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    let row = rows.find(r => Math.abs(r.y - it.y) <= 2.5);
    if (!row) { row = { y: it.y, parts: [] }; rows.push(row); }
    row.parts.push(it);
  }
  rows.sort((a, b) => b.y - a.y); // PDF y grows upwards
  return rows.map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.str.trim()).join(' '));
}
