// import.js - "Import card bill". Loaded only when the user taps the button.
// Reads a PDF (text, or scanned -> OCR) or a photo ON THIS PHONE. Nothing is uploaded.
// The user reviews and edits every line before anything is saved.
import { parseStatement, categorize, assignIds, itemsToLines, merchantKey } from './parse.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
const MAX_PAGES = 12;
const url = p => new URL(p, import.meta.url).href;

// ---------- text extraction ----------
async function pdfLines(file, say) {
  say('Opening PDF…');
  const pdfjs = await import('./vendor/pdfjs/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = url('./vendor/pdfjs/pdf.worker.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  let cancelled = false;
  task.onPassword = (update, reason) => {
    const wrong = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    const pw = prompt(wrong ? 'Wrong password. Try again:' : 'This bill is password protected. Enter the password (it is not saved):');
    if (pw === null) { cancelled = true; task.destroy(); } else update(pw);
  };
  let pdf;
  try { pdf = await task.promise; } catch (e) { if (cancelled) throw new Error('Cancelled.'); throw e; }
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  let lines = [];
  for (let i = 1; i <= pages; i++) {
    say(`Reading page ${i} of ${pages}…`);
    const tc = await (await pdf.getPage(i)).getTextContent();
    lines = lines.concat(itemsToLines(tc.items.map(t => ({ str: t.str, x: t.transform[4], y: t.transform[5] }))));
  }
  if (lines.join('').length >= 150) return { lines, method: 'PDF text' };

  // Scanned PDF (no real text): render each page and run OCR.
  const canvases = [];
  for (let i = 1; i <= pages; i++) {
    say(`Preparing scanned page ${i} of ${pages}…`);
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4, Math.max(2.2, 2000 / base.width)) }); // ~2000px wide is enough for clear OCR
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    canvases.push(c);
  }
  return { lines: await ocr(canvases, say), method: 'OCR (scanned PDF)' };
}

async function imageCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { throw new Error('Could not read this image. Try a screenshot, a JPEG/PNG photo, or the PDF.'); }
  const long = Math.max(bmp.width, bmp.height);
  const scale = long > 3000 ? 3000 / long : bmp.width < 1400 ? 1600 / bmp.width : 1;
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

let tessLoaded = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return tessLoaded || (tessLoaded = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = url('./vendor/tesseract/tesseract.min.js');
    s.onload = res; s.onerror = () => rej(new Error('Could not load the OCR engine.'));
    document.head.appendChild(s);
  }));
}

async function ocr(canvases, say) {
  say('Loading the OCR engine (first time takes a few seconds)…');
  await loadTesseract();
  const worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: url('./vendor/tesseract/worker.min.js'),
    corePath: url('./vendor/tesseract/core/'),
    langPath: url('./vendor/tesseract/lang/'),
    workerBlobURL: false,
    logger: m => { if (m.status === 'recognizing text') say(`Reading text… ${Math.round(m.progress * 100)}%`); }
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    let lines = [];
    for (let i = 0; i < canvases.length; i++) {
      say(`Reading text from page ${i + 1} of ${canvases.length}…`);
      const { data } = await worker.recognize(canvases[i]);
      lines = lines.concat(String(data.text).split('\n'));
    }
    return lines;
  } finally { await worker.terminate(); }
}

async function extract(file, say) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return pdfLines(file, say);
  return { lines: await ocr([await imageCanvas(file)], say), method: 'OCR (photo)' };
}

// ---------- UI ----------
const CSS = `
#ccOv{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}
#ccOv .ccbox{background:var(--card);color:var(--text);width:100%;max-width:640px;max-height:92vh;border-radius:16px 16px 0 0;display:flex;flex-direction:column;overflow:hidden}
#ccOv .cchead{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border)}
#ccOv .ccbody{padding:14px 16px;overflow:auto;flex:1}
#ccOv .ccfoot{padding:10px 16px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--border);display:flex;gap:8px;align-items:center}
#ccOv .ccrow{border-bottom:1px solid var(--border);padding:8px 0}
#ccOv .ccrow.dim{opacity:.55}
#ccOv .ccl1{display:flex;gap:8px;align-items:center;margin-bottom:6px}
#ccOv .ccl2{display:flex;gap:8px}
#ccOv .ccl1 input[type=checkbox]{width:22px;height:22px;flex:0 0 auto}
#ccOv .ccl1 input[type=date]{flex:1 1 0}
#ccOv .ccl1 input[type=number]{flex:0 0 120px;text-align:right}
#ccOv .ccl2 input{flex:2 1 0}
#ccOv .ccl2 select{flex:1.2 1 0}
#ccOv input,#ccOv select,#ccOv button{font:inherit;font-size:16px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);min-width:0}
#ccOv button.p{background:var(--accent);color:#fff;border:none;font-weight:600;padding:12px 16px;cursor:pointer}
#ccOv button:disabled{opacity:.5}
#ccOv .m{font-size:.8rem;color:var(--muted)}
#ccOv .cchead button{width:44px;flex:0 0 44px;padding:8px 0}
#ccOv .ccfoot button.p{width:auto;flex:0 0 auto}
#ccOv input[type=file]{display:none}
`;

export function openImport({ existingIds, userName, add, categories }) {
  if (document.getElementById('ccOv')) return;
  if (!document.getElementById('ccStyle')) { const st = document.createElement('style'); st.id = 'ccStyle'; st.textContent = CSS; document.head.appendChild(st); }
  let learned = {};
  try { learned = JSON.parse(localStorage.getItem('ccMap') || '{}') || {}; } catch (e) {}
  const ov = document.createElement('div'); ov.id = 'ccOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  ov.innerHTML = `<div class="ccbox"><div class="cchead"><strong>💳 Import credit-card bill</strong><button id="ccX" type="button" aria-label="Close">✕</button></div>
    <div class="ccbody" id="ccBody"></div><div class="ccfoot" id="ccFoot" hidden></div></div>`;
  document.body.appendChild(ov);
  const body = ov.querySelector('#ccBody'), foot = ov.querySelector('#ccFoot');
  const close = () => ov.remove();
  ov.querySelector('#ccX').onclick = close;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });

  const picker = () => {
    body.innerHTML = `<p style="margin-top:0">Choose your credit-card bill (<b>PDF</b> or a <b>photo / screenshot</b>).</p>
      <p class="m">🔒 The file is read on this phone only. It is never uploaded, and only the transactions you approve are saved (not the bill, card number or name).</p>
      <input type="file" id="ccFile" accept="application/pdf,image/*" style="display:none">
      <button class="p" id="ccPick" type="button" style="width:100%">Choose bill…</button>
      <p class="m" id="ccMsg" style="margin-top:12px"></p>`;
    foot.hidden = true;
    const input = body.querySelector('#ccFile'), msg = body.querySelector('#ccMsg');
    body.querySelector('#ccPick').onclick = () => input.click();
    input.onchange = async () => {
      const f = input.files[0]; if (!f) return;
      body.querySelector('#ccPick').disabled = true;
      try {
        const { lines, method } = await extract(f, t => { msg.textContent = t; });
        const parsed = parseStatement(lines);
        review(parsed, method);
      } catch (e) {
        console.error(e);
        msg.textContent = '⚠️ ' + (e && e.message ? e.message : 'Could not read this file.');
        body.querySelector('#ccPick').disabled = false; input.value = '';
      }
    };
  };

  const review = (parsed, method) => {
    const rows = assignIds(parsed.debits).map(r => ({ ...r, cat: categorize(r.desc, learned, categories), exists: existingIds.has(r.id) }));
    const credits = parsed.credits;
    if (!rows.length) {
      body.innerHTML = `<p><b>No purchases found.</b> (${esc(method)})</p><p class="m">Tips: use the PDF from your bank instead of a photo; for a photo, hold the phone straight, good light, and include the full table. If it is a PDF with a password, enter it when asked.</p><button class="p" id="ccAgain" type="button">Try another file</button>`;
      body.querySelector('#ccAgain').onclick = picker; foot.hidden = true; return;
    }
    const newCount = rows.filter(r => !r.exists).length;
    body.innerHTML = `<p style="margin-top:0"><b>${rows.length} purchase${rows.length === 1 ? '' : 's'} found</b> <span class="m">(${esc(method)})</span>${rows.length - newCount ? ` · <span class="m">${rows.length - newCount} already added earlier</span>` : ''}</p>
      <p class="m" style="margin-top:0">Check each line: fix the date, text, amount or category, or untick what you do not want. OCR from photos can misread digits.</p>
      <div class="m"><a href="#" id="ccAll">Select all</a> · <a href="#" id="ccNone">Select none</a></div><div id="ccRows"></div>
      ${credits.length ? `<details style="margin-top:12px"><summary class="m">${credits.length} payment/refund line${credits.length === 1 ? '' : 's'} skipped (not expenses)</summary>${credits.map(c => `<div class="m" style="padding:3px 0">${esc(c.iso)} · ${esc(c.desc)} · ${fmt(c.amount)}</div>`).join('')}</details>` : ''}`;
    const list = body.querySelector('#ccRows');
    list.innerHTML = rows.map((r, i) => `<div class="ccrow${r.exists ? ' dim' : ''}" data-i="${i}">
      <div class="ccl1"><input type="checkbox" class="on" ${r.exists ? 'disabled' : 'checked'} aria-label="Include"><input type="date" class="dt" value="${esc(r.iso)}"><input type="number" class="am" step="0.01" min="0.01" max="999999999" inputmode="decimal" value="${r.amount}"></div>
      <div class="ccl2"><input class="ds" maxlength="80" value="${esc(r.desc)}"><select class="ct">${categories.map(c => `<option${c === r.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      ${r.exists ? '<div class="m">Already added</div>' : ''}</div>`).join('');

    foot.hidden = false;
    foot.innerHTML = `<div style="flex:1"><div id="ccTotal" style="font-weight:700"></div><div class="m" id="ccCount"></div></div><button id="ccSave" class="p" type="button"></button>`;
    const refresh = () => {
      let n = 0, sum = 0;
      list.querySelectorAll('.ccrow').forEach(el => { const on = el.querySelector('.on'); if (on.checked && !on.disabled) { n++; sum += parseFloat(el.querySelector('.am').value) || 0; } });
      foot.querySelector('#ccTotal').textContent = fmt(sum); foot.querySelector('#ccCount').textContent = `${n} selected`;
      const b = foot.querySelector('#ccSave'); b.textContent = `Add ${n} expense${n === 1 ? '' : 's'}`; b.disabled = n === 0;
    };
    list.addEventListener('input', refresh); list.addEventListener('change', refresh);
    body.querySelector('#ccAll').onclick = e => { e.preventDefault(); list.querySelectorAll('.on:not(:disabled)').forEach(c => c.checked = true); refresh(); };
    body.querySelector('#ccNone').onclick = e => { e.preventDefault(); list.querySelectorAll('.on').forEach(c => c.checked = false); refresh(); };
    refresh();

    foot.querySelector('#ccSave').onclick = async () => {
      const btn = foot.querySelector('#ccSave'); btn.disabled = true;
      const todo = [];
      list.querySelectorAll('.ccrow').forEach(el => {
        const on = el.querySelector('.on'); if (!on.checked || on.disabled) return;
        const r = rows[+el.dataset.i], amount = parseFloat(el.querySelector('.am').value), date = el.querySelector('.dt').value;
        const desc = el.querySelector('.ds').value.trim(), cat = el.querySelector('.ct').value;
        if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !desc) return;
        todo.push({ r, x: { id: r.id, note: ('💳 ' + desc).slice(0, 100), amount, category: cat, date, by: userName }, desc, cat });
      });
      let ok = 0, bad = 0;
      for (const t of todo) {
        btn.textContent = `Saving ${ok + bad + 1} of ${todo.length}…`;
        try { await add(t.x); ok++; if (t.cat !== t.r.cat) learned[merchantKey(t.desc)] = t.cat; } catch (e) { console.error(e); bad++; }
      }
      try { localStorage.setItem('ccMap', JSON.stringify(learned)); } catch (e) {}
      close();
      alert(`Added ${ok} expense${ok === 1 ? '' : 's'}.` + (bad ? ` ${bad} could not be saved - please try again.` : '') + (ok ? '\nThey appear in this month and in the Analysis page.' : ''));
    };
  };

  picker();
}
