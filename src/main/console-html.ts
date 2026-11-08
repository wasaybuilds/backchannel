/**
 * The control console, served at `/`.
 *
 * Inlined as a string rather than a file so it survives bundling into
 * out/main/index.js with no asset path to resolve at runtime. It is a single
 * page with no dependencies — it has to load over a phone hotspot.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Backchannel console</title>
<style>
  :root {
    --bg:#0e0f12; --card:#16181d; --line:#262a33; --text:#e8eaed; --dim:#8b8f98;
    --go:#35c46b; --warn:#f0b429; --err:#f2585b; --accent:#5b8def;
  }
  * { box-sizing:border-box; margin:0; -webkit-tap-highlight-color:transparent; }
  body {
    background:var(--bg); color:var(--text); padding:16px 14px 40px;
    font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;
    max-width:620px; margin:0 auto;
  }
  h1 { font-size:17px; font-weight:600; letter-spacing:-.01em; }
  header { display:flex; align-items:center; gap:9px; margin-bottom:16px; }
  #dot { width:9px; height:9px; border-radius:50%; background:var(--dim); flex:none; }
  #dot.on { background:var(--go); box-shadow:0 0 9px var(--go); }
  #dot.warm { background:var(--warn); }
  #meta { margin-left:auto; font-size:12px; color:var(--dim); text-align:right; }

  section { background:var(--card); border:1px solid var(--line); border-radius:12px;
            padding:14px; margin-bottom:12px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em;
       color:var(--dim); font-weight:600; margin-bottom:11px; }

  button {
    font:inherit; font-weight:550; color:var(--text); background:#222630;
    border:1px solid var(--line); border-radius:9px; padding:11px 14px;
    cursor:pointer; min-height:44px;
  }
  button:active { transform:translateY(1px); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.wide { width:100%; }
  button:disabled { opacity:.45; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  .row > button { flex:1 1 0; min-width:96px; }

  #drop { border:1.5px dashed var(--line); border-radius:10px; padding:20px 12px;
          text-align:center; color:var(--dim); font-size:13.5px; }
  #drop.over { border-color:var(--accent); color:var(--text); }

  ul { list-style:none; margin-top:10px; }
  li { display:flex; align-items:center; gap:9px; padding:9px 0;
       border-top:1px solid var(--line); font-size:14px; }
  li:first-child { border-top:0; }
  .tag { font-size:10px; text-transform:uppercase; letter-spacing:.04em;
         padding:2px 6px; border-radius:4px; background:#222630; color:var(--dim); flex:none; }
  .tag.pdf { color:#e2a0ff; } .tag.text { color:#7fd7a4; }
  .tag.ignored { color:var(--err); }
  .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .size { color:var(--dim); font-size:12px; flex:none; }
  .x { background:none; border:0; color:var(--dim); font-size:20px; padding:0 6px;
       min-height:auto; cursor:pointer; }
  .empty { color:var(--dim); font-size:13.5px; font-style:italic; padding:8px 0; }

  .lbl { display:flex; align-items:center; justify-content:space-between; gap:10px;
         font-size:14px; padding:4px 0; }
  select { font:inherit; color:var(--text); background:#0f1116; border:1px solid var(--line);
           border-radius:9px; padding:9px 10px; min-height:42px; flex:0 1 60%; }
  textarea { width:100%; background:#0f1116; color:var(--text); border:1px solid var(--line);
             border-radius:9px; padding:11px; font:inherit; resize:vertical; min-height:74px; }
  #toast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%);
           background:#222630; border:1px solid var(--line); border-radius:9px;
           padding:11px 16px; font-size:13.5px; opacity:0; transition:opacity .18s;
           pointer-events:none; max-width:90vw; }
  #toast.show { opacity:1; }
  #toast.bad { border-color:var(--err); color:#ffb4b6; }
</style>
</head>
<body>
<header>
  <span id="dot"></span>
  <h1>Backchannel</h1>
  <span id="meta"></span>
</header>

<section>
  <h2>Language</h2>
  <label class="lbl">They speak
    <select id="stt">
      <option value="en">English only</option>
      <option value="multi">Urdu + English mixed</option>
      <option value="ur">Urdu only</option>
    </select>
  </label>
  <label class="lbl">Answer me in
    <select id="reply">
      <option value="English">English</option>
      <option value="Roman Urdu">Roman Urdu</option>
      <option value="match">Same language they asked in</option>
    </select>
  </label>
</section>

<section>
  <h2>Briefing</h2>
  <div id="drop">Tap to add files, or drop them here<br><span style="font-size:12px">pdf, md, txt, csv, json, code</span></div>
  <input id="file" type="file" multiple hidden
         accept=".pdf,.md,.txt,.json,.csv,.ts,.js,.py,.sql,.yaml,.yml">
  <ul id="files"></ul>
</section>

<section>
  <h2>Job description <span id="jdstate" style="text-transform:none; letter-spacing:0; font-weight:400"></span></h2>
  <textarea id="jd" rows="7" placeholder="Paste the job description here. Answers will be aimed at this role, using only what's really in your CV."></textarea>
  <div class="row" style="margin-top:8px">
    <button id="jdsave" class="primary">Save &amp; apply</button>
    <button id="jdclear">Clear</button>
  </div>
</section>

<section>
  <h2>Apply</h2>
  <button id="apply" class="primary wide">Apply &amp; warm the cache</button>
  <p style="color:var(--dim); font-size:12.5px; margin-top:9px">
    Reloads the briefing and pre-pays the cache, so the next question is fast
    instead of waiting on the upload.
  </p>
</section>

<section>
  <h2>During the call</h2>
  <div class="row">
    <button data-ask="">Answer them</button>
    <button data-panel="1">Show panel</button>
    <button data-panel="0">Hide panel</button>
  </div>
  <textarea id="q" placeholder="Or ask something specific..." style="margin-top:10px"></textarea>
  <button id="send" class="wide" style="margin-top:8px">Ask this</button>
</section>

<div id="toast"></div>

<script>
const T = new URLSearchParams(location.search).get('t') || '';
const $ = (s) => document.querySelector(s);
let busy = false;

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = ''), 2600);
}

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(path + sep + 't=' + encodeURIComponent(T), opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}

function render(s) {
  if (s.files) {
    const ul = $('#files');
    ul.innerHTML = '';
    if (!s.files.length) {
      ul.innerHTML = '<li class="empty">Nothing loaded. It will answer from the call alone.</li>';
    }
    for (const f of s.files) {
      const li = document.createElement('li');
      const kb = f.bytes < 1024 ? f.bytes + ' B' : (f.bytes / 1024).toFixed(0) + ' KB';
      li.innerHTML =
        '<span class="tag ' + f.kind + '">' + f.kind + '</span>' +
        '<span class="name"></span><span class="size">' + kb + '</span>' +
        '<button class="x" title="Remove">&times;</button>';
      li.querySelector('.name').textContent = f.name;
      li.querySelector('.x').onclick = () => remove(f.name);
      ul.appendChild(li);
    }
  }
  if (s.jd !== undefined) {
    $('#jdstate').textContent = s.jd ? '· saved' : '· none';
    $('#jdstate').style.color = s.jd ? 'var(--go)' : 'var(--dim)';
  }
  if (s.language && document.activeElement !== $('#stt')) $('#stt').value = s.language;
  if (s.reply && document.activeElement !== $('#reply')) {
    if (![...$('#reply').options].some((o) => o.value === s.reply)) $('#reply').add(new Option(s.reply, s.reply));
    $('#reply').value = s.reply;
  }
  if (s.warm !== undefined) {
    $('#dot').className = s.listening ? (s.warm ? 'on' : 'warm') : '';
    const bits = [];
    if (s.language) bits.push('hears ' + s.language);
    if (s.reply) bits.push('replies ' + s.reply);
    bits.push(s.warm ? 'cache warm' : 'cache cold');
    var NAMES = { claude: 'Claude', openai: 'OpenAI', grok: 'Grok', groq: 'Groq', gemini: 'Gemini' };
    if (s.provider) bits.push('via ' + (NAMES[s.provider] || s.provider));
    $('#meta').title = s.down ? 'Skipping for now:\n' + s.down : '';
    $('#meta').textContent = bits.join(' · ');
  }
}

async function refresh() {
  try { render(await api('/api/state')); }
  catch (e) { toast(e.message, true); }
}

async function remove(name) {
  try { render(await api('/api/delete?name=' + encodeURIComponent(name), { method: 'POST' })); }
  catch (e) { toast(e.message, true); }
}

async function upload(files) {
  for (const f of files) {
    try {
      toast('Uploading ' + f.name + '...');
      render(await api('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f }));
      toast(f.name + ' added');
    } catch (e) { toast(f.name + ': ' + e.message, true); }
  }
}

$('#drop').onclick = () => $('#file').click();
$('#file').onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
['dragover', 'dragleave', 'drop'].forEach((ev) =>
  $('#drop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('#drop').classList.toggle('over', ev === 'dragover');
    if (ev === 'drop') upload([...e.dataTransfer.files]);
  })
);

async function saveJd(text, b) {
  if (busy) return;
  busy = true;
  const label = b.textContent;
  b.textContent = 'Saving...';
  b.disabled = true;
  try {
    await api('/api/jd', { method: 'POST', body: text });
    b.textContent = 'Warming...';
    render(await api('/api/apply', { method: 'POST' }));
    toast(text ? 'Job description applied' : 'Job description cleared');
  } catch (err) { toast(err.message, true); }
  b.textContent = label;
  b.disabled = false;
  busy = false;
}
$('#jdsave').onclick = (e) => saveJd($('#jd').value.trim(), e.target);
$('#jdclear').onclick = (e) => { $('#jd').value = ''; saveJd('', e.target); };
api('/api/jd').then((r) => { if (!$('#jd').value) $('#jd').value = r.text || ''; }).catch(() => {});

async function setLang(param, value) {
  try {
    toast(param === 'reply' ? 'Switching answers, warming...' : 'Switching listener...');
    render(await api('/api/language?' + param + '=' + encodeURIComponent(value), { method: 'POST' }));
    toast('Language updated');
  } catch (err) { toast(err.message, true); }
}
$('#stt').onchange = (e) => setLang('stt', e.target.value);
$('#reply').onchange = (e) => setLang('reply', e.target.value);

$('#apply').onclick = async (e) => {
  if (busy) return;
  busy = true;
  const b = e.target;
  const label = b.textContent;
  b.textContent = 'Warming...';
  b.disabled = true;
  try { render(await api('/api/apply', { method: 'POST' })); toast('Briefing applied, cache warm'); }
  catch (err) { toast(err.message, true); }
  b.textContent = label;
  b.disabled = false;
  busy = false;
};

document.querySelectorAll('[data-ask]').forEach((b) => {
  b.onclick = async () => {
    try { await api('/api/ask', { method: 'POST', body: '' }); toast('Asked'); }
    catch (e) { toast(e.message, true); }
  };
});
document.querySelectorAll('[data-panel]').forEach((b) => {
  b.onclick = async () => {
    try { await api('/api/panel?show=' + b.dataset.panel, { method: 'POST' }); }
    catch (e) { toast(e.message, true); }
  };
});
$('#send').onclick = async () => {
  const q = $('#q').value.trim();
  if (!q) return;
  try { await api('/api/ask', { method: 'POST', body: q }); $('#q').value = ''; toast('Asked'); }
  catch (e) { toast(e.message, true); }
};

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`
