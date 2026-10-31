// Security: refuse to run inside someone else's page (clickjacking). GitHub Pages cannot send X-Frame-Options.
if (window.top !== window.self) { document.documentElement.innerHTML = ''; throw new Error('framed'); }

import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const LS = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }
};
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const fmt = n => inr.format(n);
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmt0 = n => inr0.format(n); // compact, for tables
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const csvq = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; }; // quotes + blocks spreadsheet formula injection
async function saveCsv(name, lines) {
  const text = '\ufeff' + lines.join('\n');
  try {
    const file = new File([text], name, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const dict = () => Object.create(null); // map keyed by user text (safe for names like 'constructor')
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

// ---- identity: name + family code (invite link: #family=CODE) ----
const validCode = c => /^[A-Za-z0-9_-]{8,60}$/.test(c);
const hashCode = new URLSearchParams(location.hash.slice(1)).get('family');
if (hashCode) { if (validCode(hashCode.trim())) LS.set('familyCode', hashCode.trim()); history.replaceState(null, '', location.pathname + location.search); }
let userName = LS.get('userName') || '';
let familyCode = LS.get('familyCode') || '';
if (familyCode && !validCode(familyCode)) familyCode = ''; // bad/old value -> ask again
const syncConfigured = !!firebaseConfig.apiKey;

// ---- stores: Firestore (shared) or localStorage (fallback) ----
let items = [];   // expenses only
let moves = [];   // income + transfers (stored in the same collection, category starts with '@')
const isMove = x => String(x.category || '').startsWith('@');
const moveKind = x => (x.category === '@income' ? 'income' : 'transfer');
const moveTo = x => String(x.category || '').slice('@transfer:'.length);
const norm = v => String(v || '').trim().toLowerCase();
function setAll(list) {
  list = list.map(x => ({ ...x, amount: Number(x.amount) || 0, note: x.note == null ? '' : String(x.note), date: String(x.date || ''), category: String(x.category || 'Miscellaneous') }));
  items = list.filter(x => !isMove(x)); moves = list.filter(isMove); render();
}
let store = null;

function localStore() {
  const KEY = 'expenses.v2';
  let data = [];
  try { data = JSON.parse(LS.get(KEY)) || []; } catch (e) {}
  const persist = () => LS.set(KEY, JSON.stringify(data));
  const readB = () => { try { return JSON.parse(LS.get('budgets.v1')) || {}; } catch (e) { return {}; } };
  return {
    label: 'Local only',
    subscribe(cb) { cb(data.slice()); },
    add(x) { data.push(x); persist(); if (syncConfigured) LS.set('migrated.v2', ''); this.subscribe(cb2); },
    remove(id) { data = data.filter(d => d.id !== id); persist(); this.subscribe(cb2); },
    subscribeBudgets(cb) { cb(readB()); },
    setBudget(month, amount, by) { const b = readB(); b[month] = amount; LS.set('budgets.v1', JSON.stringify(b)); this.subscribeBudgets(cbB); }
  };
}
let cb2 = setAll;
let budgets = dict();
let cbB = b => { budgets = b; render(); };

async function firestoreStore(code) {
  const V = '10.12.2';
  const [{ initializeApp }, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
  ]);
  const app = initializeApp(firebaseConfig);
  const db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  const col = fs.collection(db, 'families', code, 'expenses');
  const bcol = fs.collection(db, 'families', code, 'budgets');
  return {
    label: 'Synced',
    subscribe(cb, onState) {
      return fs.onSnapshot(col, { includeMetadataChanges: true }, snap => {
        cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        onState && onState(snap.metadata.fromCache && !snap.metadata.hasPendingWrites ? 'offline' : 'online');
      }, err => { console.error(err); onState && onState('error'); });
    },
    add(x) { const { id, ...rest } = x; return fs.setDoc(fs.doc(col, id), { ...rest, createdAt: fs.serverTimestamp() }); },
    remove(id) { return fs.deleteDoc(fs.doc(col, id)); },
    subscribeBudgets(cb) {
      return fs.onSnapshot(bcol, snap => { const b = dict(); snap.docs.forEach(d => b[d.id] = Number(d.data().amount) || 0); cb(b); }, err => console.error(err));
    },
    setBudget(month, amount, by) { return fs.setDoc(fs.doc(bcol, month), { amount, by }); }
  };
}

function setStatus(state) {
  const el = $('status');
  el.className = 'status' + (state === 'online' ? ' on' : '');
  el.textContent = { online: '● Synced', offline: '○ Offline – will sync later', error: '⚠ Sync error', local: 'Local only' }[state] || '';
}

async function start() {
  const needSetup = !userName || (syncConfigured && !familyCode);
  $('setup').hidden = !needSetup;
  $('localWarn').hidden = syncConfigured;
  $('userName').value = userName;
  $('familyCode').value = familyCode;
  $('familyCode').required = syncConfigured;
  if (!syncConfigured) $('familyCode').hidden = true;
  $('share').hidden = !syncConfigured || !familyCode;
  $('genCode').hidden = !syncConfigured;
  $('weakWarn').hidden = !(syncConfigured && familyCode && familyCode.length < 16);

  if (syncConfigured && familyCode) {
    try {
      store = await firestoreStore(familyCode);
      store.subscribe(setAll, setStatus);
      store.subscribeBudgets(cbB);
    } catch (e) {
      console.error(e);
      setStatus('error');
      store = localStore(); store.subscribe(cb2); store.subscribeBudgets(cbB);
    }
  } else {
    store = localStore(); store.subscribe(cb2); store.subscribeBudgets(cbB); setStatus('local');
  }
}

function offerMigration() {
  if (!store || store.label !== 'Synced' || !userName || LS.get('migrated.v2')) return;
  let old = [], ob = {};
  try { old = JSON.parse(LS.get('expenses.v2')) || []; } catch (e) {}
  try { ob = JSON.parse(LS.get('budgets.v1')) || {}; } catch (e) {}
  if (old.length || Object.keys(ob).length) {
    if (confirm(`Found ${old.length} expense(s) saved on this phone from before sync was on. Add them to the shared list?`)) {
      old.forEach(x => store.add({ ...x, by: x.by || userName }).catch(console.error));
      Object.entries(ob).forEach(([k, v]) => store.setBudget(k, v, userName).catch(console.error));
    }
  }
  LS.set('migrated.v2', '1');
}
setTimeout(offerMigration, 2500);

// ---- UI ----
let defaultDate = today();
function refreshDates() {
  const t = today();
  if (t === defaultDate) return;
  if ($('date').value === defaultDate) $('date').value = t;
  if ($('incDate').value === defaultDate) $('incDate').value = t;
  if ($('trDate').value === defaultDate) $('trDate').value = t;
  defaultDate = t; render();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDates(); });
$('date').value = today();
$('month').value = today().slice(0, 7);
$('cmpB').value = today().slice(0, 7);
$('cmpA').value = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
[...$('category').options].forEach(o => $('filterCat').add(new Option(o.value, o.value)));

const CAT_COLOR = { Food:'#f59f00', Transport:'#339af0', Bills:'#845ef7', Shopping:'#f06595', Health:'#20c997', Entertainment:'#fab005', Miscellaneous:'#fa5252', Other:'#fa5252' };
const catColor = c => (Object.prototype.hasOwnProperty.call(CAT_COLOR, c) ? CAT_COLOR[c] : '#868e96');
const PERSON_COLORS = ['#3b5bdb', '#e64980', '#12b886', '#f08c00'];
const MISC = 'Miscellaneous';
const isMisc = c => c === MISC || c === 'Other'; // 'Other' = older entries
function monthItems(m) { return items.filter(x => (x.date || '').startsWith(m)); }
const sumOf = a => a.reduce((s, x) => s + (Number(x.amount) || 0), 0);

const curMonth = () => today().slice(0, 7);
const validMonth = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
function shiftMonth(m, d) { const [y, mo] = m.split('-').map(Number); const t = new Date(y, mo - 1 + d, 1); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; }

function render() {
  if (!validMonth($('month').value)) $('month').value = curMonth(); // cleared field -> fall back to this month
  const m = $('month').value, cat = $('filterCat').value;
  const mi = monthItems(m);
  const spent = sumOf(mi);
  const budget = budgets[m];
  const hasB = typeof budget === 'number';
  if (document.activeElement !== $('budgetInput')) $('budgetInput').value = hasB ? budget : '';
  $('tBudget').textContent = hasB ? fmt(budget) : 'not set';
  $('tSpent').textContent = fmt(spent);
  const rem = hasB ? budget - spent : null;
  $('tRemain').textContent = hasB ? fmt(rem) : '–';
  const pct = hasB && budget > 0 ? spent / budget : 0;
  $('tRemain').className = !hasB ? '' : rem < 0 ? 'neg' : pct >= 0.8 ? 'warnc' : 'pos';
  $('fill').style.width = hasB && budget > 0 ? Math.min(100, spent / budget * 100) + '%' : '0';
  $('fill').className = 'fill' + (hasB && spent > budget ? ' over' : pct >= 0.8 ? ' warn' : '');
  const misc = sumOf(mi.filter(x => isMisc(x.category)));
  $('miscLine').textContent = `Miscellaneous this month: ${fmt(misc)}` + (spent ? ` (${Math.round(misc / spent * 100)}% of spending)` : '');
  $('todayLine').textContent = m === today().slice(0, 7) ? `Spent today: ${fmt(sumOf(items.filter(x => x.date === today())))}` : '';

  const view = mi.filter(x => !cat || x.category === cat).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('list').innerHTML = view.length ? view.map(x => `
    <li>
      <div><div>${esc(x.note)}</div><div class="meta">${esc(x.date)} · <span class="dot" style="background:${catColor(x.category)};margin-right:3px"></span>${esc(x.category)}${x.by ? ' · ' + esc(x.by) : ''}</div></div>
      <div><span class="amt">${fmt(Number(x.amount) || 0)}</span><button class="del" data-id="${esc(x.id)}" aria-label="Delete">✕</button></div>
    </li>`).join('') : '<div class="empty">No expenses for this month.</div>';

  const by = dict();
  mi.forEach(x => by[x.category] = (by[x.category] || 0) + (Number(x.amount) || 0));
  const max = Math.max(0, ...Object.values(by));
  $('breakdown').innerHTML = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    `<div style="margin-top:10px"><div class="row" style="justify-content:space-between;margin:0"><span><span class="dot" style="background:${catColor(k)}"></span>${esc(k)}</span><span>${fmt(v)}</span></div><div class="bar" style="width:${v / max * 100}%;background:${catColor(k)}"></div></div>`
  ).join('') || '<div class="empty">Nothing to show.</div>';
  renderAnalysis(m, mi, spent, budget);
  renderWallets(m);
}

const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleString('en-IN', { month: 'short', year: '2-digit' }); };

// Use the spelling a person typed as their own name; otherwise capitalise the first letter.
function canonName(n) {
  const k = norm(n), t = String(n || '').trim();
  const known = [...items, ...moves].map(x => x.by).find(b => norm(b) === k);
  return known ? String(known).trim() : t.charAt(0).toUpperCase() + t.slice(1);
}

function renderWallets(m) {
  // Per person: balance = income + received - sent - own expenses, counted from that person's first income/transfer.
  const people = new Map(), start = dict();
  const touch = (n, d) => { const k = norm(n); if (!k) return; if (!people.has(k)) people.set(k, String(n).trim()); if (!start[k] || d < start[k]) start[k] = d; };
  moves.forEach(x => { touch(x.by, x.date); if (moveKind(x) === 'transfer') touch(moveTo(x), x.date); });
  [...items, ...moves].forEach(x => { const k = norm(x.by); if (people.has(k)) people.set(k, String(x.by).trim()); });
  const st = dict(); people.forEach((_, k) => st[k] = { bal: 0, inc: 0, recv: 0, sent: 0, spent: 0 });
  const upto = d => (d || '').slice(0, 7) <= m, inMonth = d => (d || '').startsWith(m);
  moves.forEach(x => {
    const a = Number(x.amount) || 0, by = norm(x.by);
    if (!st[by]) return;
    if (moveKind(x) === 'income') { if (upto(x.date)) st[by].bal += a; if (inMonth(x.date)) st[by].inc += a; }
    else { const to = norm(moveTo(x));
      if (upto(x.date)) { st[by].bal -= a; if (st[to]) st[to].bal += a; }
      if (inMonth(x.date)) { st[by].sent += a; if (st[to]) st[to].recv += a; } }
  });
  items.forEach(x => {
    const k = norm(x.by), a = Number(x.amount) || 0;
    if (!st[k] || (x.date || '') < start[k]) return;
    if (upto(x.date)) st[k].bal -= a;
    if (inMonth(x.date)) st[k].spent += a;
  });
  const parts = (o) => [o.inc && `income ${fmt0(o.inc)}`, o.recv && `received ${fmt0(o.recv)}`, o.sent && `sent ${fmt0(o.sent)}`, o.spent && `spent ${fmt0(o.spent)}`].filter(Boolean).join(' · ');
  $('wallets').innerHTML = people.size ? [...people].map(([k, name], i) => `
    <div class="wallet"><div class="top"><span><span class="dot" style="background:${PERSON_COLORS[i % 4]}"></span>${esc(name)}</span>
    <span class="bal ${st[k].bal < 0 ? 'neg' : 'pos'}">${fmt(st[k].bal)}</span></div>
    <div class="det">${parts(st[k]) || 'No activity this month'} <span style="opacity:.7">(this month)</span></div></div>`).join('')
    : '<div class="empty">Add your income, then transfer money to Kajal. Her balance will show here on both phones.</div>';

  const row = x => `
    <li><div><div>${moveKind(x) === 'income' ? '⬇️ ' + (x.note ? esc(x.note) : 'Income') : '➡️ To ' + esc(canonName(moveTo(x))) + (x.note ? ' · ' + esc(x.note) : '')}</div><div class="meta">${esc(x.date)}${x.by ? ' · ' + esc(x.by) : ''}</div></div>
    <div><span class="amt ${moveKind(x) === 'income' ? 'pos' : ''}">${fmt(Number(x.amount) || 0)}</span><button class="del" data-id="${esc(x.id)}" aria-label="Delete">✕</button></div></li>`;
  const cur = moves.filter(x => inMonth(x.date)).sort((p, q) => (q.date || '').localeCompare(p.date || ''));
  const inc = cur.filter(x => moveKind(x) === 'income'), tr = cur.filter(x => moveKind(x) === 'transfer');
  $('incList').innerHTML = inc.length ? inc.map(row).join('') + `<li><strong>Total income</strong><strong class="pos">${fmt(sumOf(inc))}</strong></li>` : '<div class="empty">No income added this month.</div>';
  $('trList').innerHTML = tr.length ? tr.map(row).join('') + `<li><strong>Total transferred</strong><strong>${fmt(sumOf(tr))}</strong></li>` : '<div class="empty">No transfers this month.</div>';
}

function renderAnalysis(m, mi, spent, budget) {
  const isCur = m === today().slice(0, 7);
  const total = daysIn(m);
  const elapsed = isCur ? Number(today().slice(8)) : total;
  const left = total - elapsed;
  const hasB = typeof budget === 'number';

  // per-day totals (and per category for the stacked chart)
  const perDay = Array(total).fill(0);
  const perDayCat = Array.from({ length: total }, () => dict());
  mi.forEach(x => { const d = Number((x.date || '').slice(8, 10)); if (d >= 1 && d <= total) { const a = Number(x.amount) || 0; perDay[d - 1] += a; perDayCat[d - 1][x.category] = (perDayCat[d - 1][x.category] || 0) + a; } });
  const maxDay = Math.max(0, ...perDay);
  const avg = elapsed ? spent / elapsed : 0;
  const biggest = mi.reduce((b, x) => (!b || x.amount > b.amount ? x : b), null);
  const topCat = Object.entries(mi.reduce((o, x) => (o[x.category] = (o[x.category] || 0) + x.amount, o), dict())).sort((a, b) => b[1] - a[1])[0];

  const tile = (l, v) => `<div class="tile"><span>${l}</span><strong>${v}</strong></div>`;
  $('tiles').innerHTML = mi.length ? [
    tile('Average per day', fmt(avg)),
    tile('Highest day', maxDay ? `${fmt(maxDay)} (${perDay.indexOf(maxDay) + 1})` : '–'),
    tile('Biggest expense', biggest ? `${fmt(biggest.amount)}` : '–'),
    tile('Top category', topCat ? esc(topCat[0]) : '–'),
    isCur ? tile('Projected month total', fmt(avg * total)) : tile('Days with spending', perDay.filter(v => v > 0).length + ' of ' + total),
    tile('Entries', mi.length)
  ].join('') : '';

  // advice
  let adv = '';
  if (!mi.length) adv = 'Add some expenses to see analysis.';
  else if (hasB && isCur) {
    const rem = budget - spent;
    const proj = avg * total;
    if (rem < 0) adv = `⚠️ You are over budget by ${fmt(-rem)}.`;
    else if (left === 0) adv = `Last day of the month: you have ${fmt(rem)} left from your budget.`;
    else {
      const safe = left > 0 ? rem / left : rem;
      adv = `You can spend about <b>${fmt(safe)}/day</b> for the remaining ${left} day${left === 1 ? '' : 's'} to stay within budget. ` +
            (proj > budget ? `⚠️ At your current pace (${fmt(avg)}/day) you will cross the budget by about ${fmt(proj - budget)}.` : `✅ At your current pace you will finish with about ${fmt(budget - proj)} left.`);
    }
  } else if (hasB) {
    adv = spent > budget ? `Over budget by ${fmt(spent - budget)}.` : `Finished ${fmt(budget - spent)} under budget.`;
  } else adv = 'Set a monthly budget above to get daily-limit advice.';
  $('advice').innerHTML = adv;

  // daily stacked bars (inline SVG), coloured by category
  const W = 320, H = 90, bw = W / total;
  const catsPresent = [...new Set(mi.map(x => x.category))];
  $('daily').innerHTML = spent ? `<svg viewBox="0 0 ${W} ${H + 14}" width="100%" role="img" aria-label="Daily spending">` +
    perDay.map((v, i) => {
      let y = H;
      return catsPresent.map(c => {
        const val = perDayCat[i][c] || 0; if (!val) return '';
        const h = maxDay ? val / maxDay * H : 0; y -= h;
        return `<rect x="${i * bw + 1}" y="${y}" width="${Math.max(1, bw - 2)}" height="${h}" fill="${catColor(c)}"><title>Day ${i + 1} · ${esc(c)}: ${fmt(val)}</title></rect>`;
      }).join('');
    }).join('') +
    [1, Math.ceil(total / 2), total].map(d => `<text x="${(d - 0.5) * bw}" y="${H + 12}" font-size="9" text-anchor="middle" fill="var(--muted)">${d}</text>`).join('') +
    `</svg><div class="legend">${catsPresent.map(c => `<span><span class="dot" style="background:${catColor(c)}"></span>${esc(c)}</span>`).join('')}</div>` : '<div class="empty">No data.</div>';

  // per person
  const byP = dict();
  mi.forEach(x => { const k = x.by || 'Unknown'; byP[k] = (byP[k] || 0) + x.amount; });
  const maxP = Math.max(0, ...Object.values(byP));
  $('byPerson').innerHTML = Object.entries(byP).sort((a, b) => b[1] - a[1]).map(([k, v], i) =>
    `<div style="margin-top:8px"><div class="row" style="justify-content:space-between;margin:0"><span><span class="dot" style="background:${PERSON_COLORS[i % 4]}"></span>${esc(k)}</span><span>${fmt(v)} · ${Math.round(v / spent * 100)}%</span></div><div class="bar" style="width:${v / maxP * 100}%;background:${PERSON_COLORS[i % 4]}"></div></div>`
  ).join('') || '<div class="empty">No data.</div>';

  // month history: last 12 months that have data (tap to open)
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const key = shiftMonth(m, -i);
    const its = monthItems(key);
    const bd = budgets[key];
    if (its.length || typeof bd === 'number' || key === m) rows.push({ key, spent: sumOf(its), misc: sumOf(its.filter(x => isMisc(x.category))), budget: bd, n: its.length });
  }
  $('history').innerHTML = `<table><tr><th>Month</th><th>Budget</th><th>Spent</th><th>Misc</th><th>Left</th></tr>` +
    rows.map(r => `<tr class="go${r.key === m ? ' sel' : ''}" data-month="${r.key}"><td>${monthLabel(r.key)}</td><td>${typeof r.budget === 'number' ? fmt0(r.budget) : '–'}</td><td>${r.n ? fmt0(r.spent) : '–'}</td><td>${r.n ? fmt0(r.misc) : '–'}</td><td class="${typeof r.budget !== 'number' ? '' : r.budget - r.spent < 0 ? 'neg' : 'pos'}">${typeof r.budget === 'number' ? fmt0(r.budget - r.spent) : '–'}</td></tr>`).join('') + '</table>';
  renderCompare();
  renderMoM(m);
  renderTrend(m);
}

const sumKind = (m, kind) => sumOf(moves.filter(x => (x.date || '').startsWith(m) && moveKind(x) === kind));
function compareHtml(A, B) {
  const ia = monthItems(A), ib = monthItems(B);
  const sumBy = its => its.reduce((o, x) => (o[x.category] = (o[x.category] || 0) + (Number(x.amount) || 0), o), dict());
  const ca = sumBy(ia), cb = sumBy(ib);
  const cats = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort((x, y) => ((cb[y] || 0) + (ca[y] || 0)) - ((cb[x] || 0) + (ca[x] || 0)));
  const delta = (p, q, neutral) => {
    const d = q - p;
    if (!d) return '<td>–</td>';
    const pct = p ? `<br><small>${Math.round(Math.abs(d) / p * 100)}%</small>` : '';
    return `<td class="${neutral ? '' : d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmt0(Math.abs(d))}${pct}</td>`;
  };
  const row = (label, p, q, bold, neutral) => `<tr${bold ? ' style="font-weight:700"' : ''}><td>${label}</td><td>${fmt0(p)}</td><td>${fmt0(q)}</td>${delta(p, q, neutral)}</tr>`;
  const extra = [];
  if (typeof budgets[A] === 'number' || typeof budgets[B] === 'number') extra.push(row('Budget', budgets[A] || 0, budgets[B] || 0, false, true));
  const incA = sumKind(A, 'income'), incB = sumKind(B, 'income'), trA = sumKind(A, 'transfer'), trB = sumKind(B, 'transfer');
  if (incA || incB) extra.push(row('Income received', incA, incB, false, true));
  if (trA || trB) extra.push(row('Transferred to family', trA, trB, false, true));
  return `<table style="margin-top:8px"><tr><th>Category</th><th>${monthLabel(A)}</th><th>${monthLabel(B)}</th><th>Change</th></tr>` +
    (cats.length ? cats.map(c => row(`<span class="dot" style="background:${catColor(c)}"></span>${esc(c)}`, ca[c] || 0, cb[c] || 0)).join('') : '<tr><td colspan="4" class="empty">No expenses in either month.</td></tr>') +
    row('Total spent', sumOf(ia), sumOf(ib), true) + extra.join('') +
    `</table><div class="meta" style="margin-top:6px">▲ red = spent more in ${monthLabel(B)}, ▼ green = spent less. Budget, income and transfers are shown without colour.</div>`;
}
function renderCompare() {
  const A = $('cmpA').value, B = $('cmpB').value;
  $('cmpOut').innerHTML = validMonth(A) && validMonth(B) ? compareHtml(A, B) : '<div class="empty">Pick two months.</div>';
}
function renderMoM(m) {
  const A = shiftMonth(m, -1), ta = sumOf(monthItems(A)), tb = sumOf(monthItems(m)), d = tb - ta;
  $('momSummary').innerHTML = !ta && !tb ? `No expenses in ${monthLabel(A)} or ${monthLabel(m)} yet.`
    : !ta ? `${monthLabel(m)}: ${fmt0(tb)} spent. No expenses recorded in ${monthLabel(A)} to compare with.`
    : `${monthLabel(m)} spending is <b class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲ up' : d < 0 ? '▼ down' : 'unchanged'} ${d ? fmt0(Math.abs(d)) + ' (' + Math.round(Math.abs(d) / ta * 100) + '%)' : ''}</b> compared with ${monthLabel(A)} (${fmt0(ta)} → ${fmt0(tb)}).`;
  $('momOut').innerHTML = compareHtml(A, m);
}
const compact = n => n >= 100000 ? (n / 100000).toFixed(1).replace(/\.0$/, '') + 'L' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(n));
function renderTrend(m) {
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(m, i - 5));
  const data = months.map(k => { const its = monthItems(k), by = dict(); its.forEach(x => by[x.category] = (by[x.category] || 0) + x.amount); return { k, by, total: sumOf(its) }; });
  const max = Math.max(0, ...data.map(d => d.total));
  if (!max) { $('trend').innerHTML = '<div class="empty">No data yet.</div>'; return; }
  const cats = [...new Set(data.flatMap(d => Object.keys(d.by)))];
  const W = 320, H = 100, top = 14, bw = W / 6;
  $('trend').innerHTML = `<svg viewBox="0 0 ${W} ${H + top + 16}" width="100%" role="img" aria-label="Spending in the last 6 months">` +
    data.map((d, i) => {
      let y = top + H; const x = i * bw + 8, w = bw - 16;
      const bars = cats.map(c => { const v = d.by[c] || 0; if (!v) return ''; const h = v / max * H; y -= h; return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${catColor(c)}"><title>${monthLabel(d.k)} · ${esc(c)}: ${fmt(v)}</title></rect>`; }).join('');
      return `<g data-month="${d.k}">${bars}<rect x="${i * bw}" y="0" width="${bw}" height="${H + top + 16}" fill="transparent"></rect>` +
        `<text x="${i * bw + bw / 2}" y="${y - 3}" font-size="9" text-anchor="middle" fill="var(--text)">${d.total ? compact(d.total) : ''}</text>` +
        `<text x="${i * bw + bw / 2}" y="${top + H + 12}" font-size="9" text-anchor="middle" fill="var(--muted)" ${d.k === m ? 'font-weight="700"' : ''}>${monthLabel(d.k)}</text></g>`;
    }).join('') + `</svg><div class="legend">${cats.map(c => `<span><span class="dot" style="background:${catColor(c)}"></span>${esc(c)}</span>`).join('')}</div>`;
}

$('setupForm').addEventListener('submit', e => {
  e.preventDefault();
  LS.set('userName', $('userName').value.trim());
  if (syncConfigured) LS.set('familyCode', $('familyCode').value.trim());
  location.reload();
});
$('genCode').addEventListener('click', () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // 31 symbols, no look-alikes
  const buf = new Uint32Array(20); crypto.getRandomValues(buf);
  const chars = [...buf].map(n => alphabet[n % alphabet.length]);
  const code = [0, 5, 10, 15].map(i => chars.slice(i, i + 5).join('')).join('-');
  $('familyCode').value = code;
  $('codeHint').hidden = false;
  $('codeHint').textContent = 'New code created. Save it, then tap "Copy invite link" to send it to Kajal privately. Do not post it anywhere.';
});
$('settings').addEventListener('click', () => { $('setup').hidden = false; $('setup').scrollIntoView({ behavior: 'smooth' }); });

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!userName) { $('setup').hidden = false; $('userName').focus(); return; }
  if (!store) { alert('Still connecting – please wait a moment and tap Add again.'); return; }
  const note = $('note').value.trim(), amt = $('amount').value;
  const x = { id: uid(), note, amount: parseFloat(amt), category: $('category').value, date: $('date').value, by: userName };
  if (!note || !(x.amount > 0) || !x.date) return;
  $('note').value = ''; $('amount').value = ''; $('note').focus();
  try { await store.add(x); } catch (err) { console.error(err); setStatus('error'); if (!$('note').value) $('note').value = note; if (!$('amount').value) $('amount').value = amt; alert('Could not save this expense. Please try again.'); }
});
$('trTo').value = LS.get('lastTo') || 'Kajal';
$('incDate').value = today();
$('trDate').value = today();
async function addMove(type, amtEl, dateEl, noteEl, to) {
  if (!userName) { $('setup').hidden = false; $('userName').focus(); return; }
  if (!store) { alert('Still connecting – please wait a moment and tap again.'); return; }
  const amt = parseFloat(amtEl.value);
  if (!(amt > 0) || !dateEl.value || (type === 'transfer' && !to)) return;
  if (type === 'transfer') { if (norm(to) === norm(userName)) { alert('Transfer to someone else (not yourself).'); return; } LS.set('lastTo', to); }
  const x = { id: uid(), note: noteEl.value.trim(), amount: amt, category: type === 'income' ? '@income' : '@transfer:' + canonName(to), date: dateEl.value, by: userName };
  amtEl.value = ''; noteEl.value = '';
  try { await store.add(x); } catch (err) { console.error(err); setStatus('error'); if (!amtEl.value) amtEl.value = amt; alert('Could not save. Please try again.'); }
}
$('incForm').addEventListener('submit', e => { e.preventDefault(); addMove('income', $('incAmt'), $('incDate'), $('incNote')); });
$('trForm').addEventListener('submit', e => { e.preventDefault(); addMove('transfer', $('trAmt'), $('trDate'), $('trNote'), $('trTo').value.trim()); });
const delMove = async e => {
  const id = e.target.dataset.id;
  if (!id || !confirm('Delete this entry?')) return;
  try { await store.remove(id); } catch (err) { console.error(err); setStatus('error'); }
};
$('incList').addEventListener('click', delMove);
$('trList').addEventListener('click', delMove);

// ---- two pages: Entry / Analysis ----
function showTab(name) {
  const an = name === 'analysis';
  $('pageEntry').hidden = an; $('pageAnalysis').hidden = !an;
  $('tabEntry').classList.toggle('on', !an); $('tabAnalysis').classList.toggle('on', an);
  LS.set('tab', an ? 'analysis' : 'entry');
}
$('tabEntry').addEventListener('click', () => { showTab('entry'); scrollTo({ top: 0 }); });
$('tabAnalysis').addEventListener('click', () => { showTab('analysis'); scrollTo({ top: 0 }); });
showTab(LS.get('tab') === 'analysis' ? 'analysis' : 'entry');
$('list').addEventListener('click', async e => {
  const id = e.target.dataset.id;
  if (!id || !confirm('Delete this expense?')) return;
  try { await store.remove(id); } catch (err) { console.error(err); setStatus('error'); }
});
$('month').addEventListener('change', () => { $('budgetInput').value = ''; render(); });
$('prevM').addEventListener('click', () => { $('month').value = shiftMonth($('month').value || curMonth(), -1); $('budgetInput').value = ''; render(); });
$('nextM').addEventListener('click', () => { $('month').value = shiftMonth($('month').value || curMonth(), 1); $('budgetInput').value = ''; render(); });
$('cmpA').addEventListener('change', renderCompare);
$('cmpB').addEventListener('change', renderCompare);
$('trend').addEventListener('click', e => {
  const g = e.target.closest('[data-month]');
  if (!g) return;
  $('month').value = g.dataset.month; $('budgetInput').value = ''; render();
});
$('history').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-month]');
  if (!tr) return;
  $('month').value = tr.dataset.month; $('budgetInput').value = ''; render();
  scrollTo({ top: 0, behavior: 'smooth' });
});
$('budgetSave').addEventListener('click', async () => {
  const v = parseFloat($('budgetInput').value);
  if (!(v >= 0 && v < 1e9)) { alert('Enter the budget amount for this month (less than 100 crore).'); return; }
  if (!userName) { $('setup').hidden = false; $('userName').focus(); return; }
  if (!store) { alert('Still connecting – try again in a moment.'); return; }
  try { await store.setBudget($('month').value, v, userName); } catch (err) { console.error(err); setStatus('error'); }
});
$('filterCat').addEventListener('change', render);

$('share').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}#family=${encodeURIComponent(familyCode)}`;
  try { await navigator.clipboard.writeText(link); alert('Invite link copied. Send it to your wife and open it on her phone.'); }
  catch (e) { prompt('Copy this invite link:', link); }
});
$('export').addEventListener('click', () => {
  if (!validMonth($('month').value)) return;
  const m = $('month').value, mi = monthItems(m).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const spent = sumOf(mi), budget = budgets[m], hasB = typeof budget === 'number';
  const misc = sumOf(mi.filter(x => isMisc(x.category)));
  const by = dict(); mi.forEach(x => by[x.category] = (by[x.category] || 0) + (Number(x.amount) || 0));
  saveCsv(`expenses-${m}.csv`, [
    `Monthly report,${m}`,
    `Budget,${hasB ? budget : ''}`,
    `Total spent,${spent}`,
    `Remaining,${hasB ? budget - spent : ''}`,
    `Miscellaneous spent,${misc}`,
    `Miscellaneous % of spending,${spent ? (misc / spent * 100).toFixed(1) : 0}`,
    '', 'Category,Spent,% of spending',
    ...Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${csvq(k)},${v},${spent ? (v / spent * 100).toFixed(1) : 0}`),
    '', 'Date,Note,Category,Amount,Added by',
    ...mi.map(x => [x.date, csvq(x.note), csvq(x.category), x.amount, csvq(x.by || '')].join(',')),
    '', 'Income and transfers (this month)', 'Date,Type,To,Amount,Added by,Note',
    ...moves.filter(x => (x.date || '').startsWith(m)).sort((a, b) => a.date.localeCompare(b.date)).map(x => [x.date, moveKind(x), csvq(moveKind(x) === 'transfer' ? moveTo(x) : ''), x.amount, csvq(x.by || ''), csvq(x.note)].join(','))
  ]);
});
$('exportAll').addEventListener('click', () => {
  const all = items.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  saveCsv(`expenses-ALL-${today()}.csv`, [
    'Month,Budget',
    ...Object.entries(budgets).sort().map(([k, v]) => `${k},${v}`),
    '', 'Date,Note,Category,Amount,Added by',
    ...all.map(x => [x.date, csvq(x.note), csvq(x.category), x.amount, csvq(x.by || '')].join(',')),
    '', 'Income and transfers', 'Date,Type,To,Amount,Added by,Note',
    ...moves.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(x => [x.date, moveKind(x), csvq(moveKind(x) === 'transfer' ? moveTo(x) : ''), x.amount, csvq(x.by || ''), csvq(x.note)].join(','))
  ]);
});

// Import card bill: the importer (PDF reader + OCR) is loaded only when this button is tapped.
$('importBtn').addEventListener('click', async () => {
  if (!userName) { $('setup').hidden = false; $('userName').focus(); return; }
  if (!store) { alert('Still connecting – please wait a moment and tap again.'); return; }
  try {
    const m = await import('./import.js');
    m.openImport({ existingIds: new Set(items.map(x => x.id)), userName, add: x => store.add(x), categories: [...$('category').options].map(o => o.value) });
  } catch (e) { console.error(e); alert('Could not open the importer.'); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
start();
