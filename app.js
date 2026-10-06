'use strict';

// ---------- 定数 ----------
const MAX_CHARS = 30000; // 1件あたりの本文の上限(note記事を丸ごと貼れる長さ)
const PAGE_SIZE = 50;
const DEFAULT_CATS = ['ビジネス', '哲学', '心理・ケア', '科学', '文学', 'その他'];
const TYPE_LABEL = { book: '書籍', note: 'note', paper: '論文', web: 'Web記事', other: 'その他' };
const DB_NAME = 'kotobacho';
const STORE = 'entries';

const $ = (sel) => document.querySelector(sel);

const state = {
  entries: [],
  q: '',
  cat: null, // null=すべて / ''=未分類 / 文字列=その分野
  sort: 'new',
  shown: PAGE_SIZE,
  detailId: null,
  editingId: null,
  formCat: '',
  dirty: false,
};

// ---------- 小さなユーティリティ ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid);
  }
  return el;
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function safeUrl(u) {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.href : null;
  } catch {
    return null;
  }
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function parseTags(s) {
  const seen = new Set();
  return s
    .split(/[,、，\s]+/)
    .map((t) => t.replace(/^[#＃]/, '').trim())
    .filter((t) => t && !seen.has(t) && seen.add(t));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------- 出典の表記 ----------
function titleMark(e) {
  return e.type === 'book' ? `『${e.title}』` : `「${e.title}」`;
}

function citationText(e) {
  return `${e.author || ''}${titleMark(e)}${e.loc ? ' ' + e.loc : ''}`;
}

// ---------- 保存(IndexedDB) ----------
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const dbAll = () => tx('readonly', (s) => s.getAll());
const dbPutMany = (list) => tx('readwrite', (s) => list.forEach((e) => s.put(e)));
const dbDelete = (id) => tx('readwrite', (s) => s.delete(id));

async function persist(list) {
  if (!db) return;
  try {
    await dbPutMany(list);
  } catch (err) {
    console.error(err);
    toast('保存に失敗しました。容量を確認してください');
    throw err;
  }
}

function normalize(raw) {
  const now = Date.now();
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    id: str(raw.id) || uid(),
    text: str(raw.text).slice(0, MAX_CHARS),
    title: str(raw.title).trim(),
    author: str(raw.author).trim(),
    type: TYPE_LABEL[raw.type] ? raw.type : 'other',
    url: str(raw.url).trim(),
    loc: str(raw.loc).trim(),
    category: str(raw.category).trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string' && t) : [],
    note: str(raw.note),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now,
  };
}

const byId = (id) => state.entries.find((e) => e.id === id);

// ---------- 絞り込み・並び替え ----------
function filtered() {
  const terms = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = state.entries.filter((e) => {
    if (state.cat !== null && e.category !== state.cat) return false;
    if (!terms.length) return true;
    const hay = [e.text, e.title, e.author, e.note, e.category, e.loc, e.tags.join(' ')].join('\n').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const sorters = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    updated: (a, b) => b.updatedAt - a.updatedAt,
    source: (a, b) => a.title.localeCompare(b.title, 'ja') || b.createdAt - a.createdAt,
  };
  list = list.sort(sorters[state.sort]);
  return list;
}

function categoryCounts() {
  const m = new Map();
  for (const e of state.entries) m.set(e.category, (m.get(e.category) || 0) + 1);
  return m;
}

// ---------- 描画 ----------
function renderChips() {
  const counts = categoryCounts();
  const named = [...counts.keys()].filter(Boolean).sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'ja'));
  const chip = (label, value, n) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(state.cat === value),
        onclick: () => {
          state.cat = value === null || state.cat === value ? null : value;
          state.shown = PAGE_SIZE;
          render();
        },
      },
      label,
      h('span', { class: 'n' }, String(n)),
    );
  const nodes = [chip('すべて', null, state.entries.length), ...named.map((c) => chip(c, c, counts.get(c)))];
  if (counts.get('')) nodes.push(chip('未分類', '', counts.get('')));
  $('#chips').replaceChildren(...nodes);
}

function card(e) {
  const open = () => showDetail(e.id);
  const more = h('p', { class: 'more', hidden: true }, `続きを読む（全${e.text.length.toLocaleString()}字）`);
  return h(
    'article',
    {
      class: 'card',
      tabindex: '0',
      role: 'button',
      onclick: open,
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      },
    },
    e.category ? h('span', { class: 'badge' }, e.category) : null,
    h('blockquote', { class: 'quote' }, e.text),
    more,
    h('p', { class: 'source' }, citationText(e)),
    e.tags.length || e.note
      ? h('div', { class: 'meta' }, e.tags.map((t) => h('span', { class: 'tag' }, '#' + t)), e.note ? h('span', null, '✎ メモあり') : null)
      : null,
  );
}

function render() {
  renderChips();
  const all = state.entries;
  const list = filtered();
  $('#count').textContent = all.length ? `${all.length.toLocaleString()}件` : '';
  $('#resultInfo').textContent = state.q || state.cat !== null ? `${list.length.toLocaleString()}件を表示` : '';

  const root = $('#list');
  if (!all.length) {
    root.replaceChildren(
      h('div', { class: 'empty' }, '読んだ本・noteの中で、思考の助けになった言葉をここに集めましょう。', h('br'), '右下の「＋」から最初の一つを追加できます。'),
    );
    return;
  }
  if (!list.length) {
    root.replaceChildren(h('div', { class: 'empty' }, '該当する言葉が見つかりません'));
    return;
  }
  const nodes = list.slice(0, state.shown).map(card);
  if (list.length > state.shown) {
    nodes.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn-line load-more',
          onclick: () => {
            state.shown += PAGE_SIZE;
            render();
          },
        },
        `さらに表示（残り${(list.length - state.shown).toLocaleString()}件）`,
      ),
    );
  }
  root.replaceChildren(...nodes);
  // 6行を超えて切れているカードにだけ「続きを読む」を出す
  requestAnimationFrame(() => {
    root.querySelectorAll('.card').forEach((c) => {
      const q = c.querySelector('.quote');
      c.querySelector('.more').hidden = !(q.scrollHeight > q.clientHeight + 1);
    });
  });
}

// ---------- 確認ダイアログ(confirm()は環境によって使えないため自前) ----------
async function askConfirm(msg, okLabel) {
  const dlg = $('#confirmDlg');
  $('#confirmMsg').textContent = msg;
  $('#confirmOk').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise((resolve) => dlg.addEventListener('close', resolve, { once: true }));
  return dlg.returnValue === 'ok';
}

// ---------- シートの開閉(スマホの戻るボタン対応) ----------
let sheetOpen = false;

function closeAllDialogs() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
}

function openSheet(dlg) {
  closeAllDialogs();
  dlg.showModal();
  if (!sheetOpen) {
    history.pushState({ sheet: 1 }, '');
    sheetOpen = true;
  }
}

function closeSheet() {
  if (sheetOpen) history.back();
  else closeAllDialogs();
}

window.addEventListener('popstate', async () => {
  if ($('#formDlg').open && state.dirty) {
    // 入力中は閉じさせず、確認してから閉じる
    history.pushState({ sheet: 1 }, '');
    sheetOpen = true;
    if (await askConfirm('入力中の内容を破棄しますか？', '破棄する')) {
      state.dirty = false;
      closeSheet();
    }
    return;
  }
  sheetOpen = false;
  closeAllDialogs();
});

document.querySelectorAll('dialog:not(#confirmDlg)').forEach((d) =>
  d.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    closeSheet();
  }),
);

// ---------- 詳細 ----------
function showDetail(id) {
  const e = byId(id);
  if (!e) return;
  state.detailId = id;
  const url = safeUrl(e.url);
  $('#detailBody').replaceChildren(
    e.category ? h('span', { class: 'badge' }, e.category) : null,
    h('p', { class: 'detail-text' }, e.text),
    h(
      'div',
      { class: 'detail-source' },
      h('span', { class: 'type' }, `出典 / ${TYPE_LABEL[e.type]}`),
      citationText(e),
      url ? h('div', null, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, e.url)) : null,
    ),
    e.note ? h('div', { class: 'detail-note' }, h('h3', null, '自分のメモ'), h('p', null, e.note)) : null,
    e.tags.length ? h('div', { class: 'meta', style: 'margin-top:16px' }, e.tags.map((t) => h('span', { class: 'tag' }, '#' + t))) : null,
    h('p', { class: 'detail-meta' }, `追加 ${fmtDate(e.createdAt)}　更新 ${fmtDate(e.updatedAt)}　${e.text.length.toLocaleString()}字`),
  );
  openSheet($('#detailDlg'));
  $('#detailBody').scrollTop = 0;
}

async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = s;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function quoteBlock(e) {
  const url = safeUrl(e.url);
  return `${e.text}\n\n— ${citationText(e)}${url ? '\n' + url : ''}`;
}

// ---------- 追加・編集フォーム ----------
function updateCounter() {
  const n = $('#fText').value.length;
  const c = $('#fCount');
  c.textContent = `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}字`;
  c.classList.toggle('warn', n > MAX_CHARS * 0.9);
}

function renderCatPicker() {
  const typed = $('#fCat').value.trim();
  const existing = [...categoryCounts().keys()].filter(Boolean);
  const cats = [...new Set([...DEFAULT_CATS, ...existing, state.formCat].filter(Boolean))];
  $('#catPicker').replaceChildren(
    ...cats.map((c) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(!typed && state.formCat === c),
          onclick: () => {
            state.formCat = state.formCat === c && !typed ? '' : c;
            $('#fCat').value = '';
            state.dirty = true;
            renderCatPicker();
          },
        },
        c,
      ),
    ),
  );
}

function openForm(entry, prefill) {
  const e = entry || { type: 'book', tags: [], ...prefill };
  state.editingId = entry ? entry.id : null;
  state.formCat = e.category || '';
  state.dirty = false;
  $('#formHeading').textContent = entry ? '言葉を編集' : '言葉を追加';
  $('#fText').value = e.text || '';
  $('#fType').value = e.type || 'book';
  $('#fTitle').value = e.title || '';
  $('#fAuthor').value = e.author || '';
  $('#fLoc').value = e.loc || '';
  $('#fUrl').value = e.url || '';
  $('#fCat').value = '';
  $('#fTags').value = (e.tags || []).join(', ');
  $('#fNote').value = e.note || '';
  updateCounter();
  renderCatPicker();
  openSheet($('#formDlg'));
  $('#formDlg .sheet-body').scrollTop = 0;
}

async function saveForm(ev) {
  ev.preventDefault();
  const text = $('#fText').value.trim();
  const title = $('#fTitle').value.trim();
  if (!text) return toast('言葉・文章を入力してください');
  if (!title) return toast('出典のタイトルを入力してください');
  if (text.length > MAX_CHARS) return toast(`本文は${MAX_CHARS.toLocaleString()}字までです`);

  const now = Date.now();
  const prev = state.editingId ? byId(state.editingId) : null;
  const e = normalize({
    ...(prev || {}),
    id: prev ? prev.id : uid(),
    text,
    title,
    type: $('#fType').value,
    author: $('#fAuthor').value,
    loc: $('#fLoc').value,
    url: $('#fUrl').value,
    category: $('#fCat').value.trim() || state.formCat,
    tags: parseTags($('#fTags').value),
    note: $('#fNote').value.trim(),
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
  });
  await persist([e]);
  if (prev) state.entries[state.entries.indexOf(prev)] = e;
  else state.entries.push(e);
  state.dirty = false;
  render();
  closeSheet();
  toast(prev ? '更新しました' : '保存しました');
}

// ---------- 書き出し・読み込み ----------
async function download(filename, mime, content) {
  try {
    // 閲覧環境(Artifact)ではページからの直接ダウンロードが禁止なので、提供されていればそちらを使う
    const dl = await window.claude?.use?.('downloads');
    if (dl) {
      await dl.save({ filename, data: content });
      return;
    }
  } catch (err) {
    if (err && err.code === 'declined') return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function exportJson() {
  const data = { app: 'kotobacho', version: 1, exportedAt: new Date().toISOString(), entries: state.entries };
  download(`kotobacho-${stamp()}.json`, 'application/json', JSON.stringify(data, null, 2));
}

function exportMarkdown() {
  const groups = new Map();
  for (const e of [...state.entries].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = e.category || '未分類';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let md = '# ことば帳\n';
  for (const [cat, list] of groups) {
    md += `\n## ${cat}\n`;
    for (const e of list) {
      const url = safeUrl(e.url);
      md += '\n' + e.text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n') + '\n';
      md += `\n— ${citationText(e)}${url ? ` ${url}` : ''}\n`;
      if (e.tags.length) md += `\n${e.tags.map((t) => '#' + t).join(' ')}\n`;
      if (e.note) md += `\n**メモ:** ${e.note.replace(/\n/g, '  \n')}\n`;
      md += '\n---\n';
    }
  }
  download(`kotobacho-${stamp()}.md`, 'text/markdown', md);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const arr = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(arr)) throw new Error('形式が違います');
    const changed = [];
    let added = 0;
    let updated = 0;
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const e = normalize(raw);
      if (!e.text || !e.title) continue;
      const cur = byId(e.id);
      if (!cur) {
        state.entries.push(e);
        changed.push(e);
        added++;
      } else if (e.updatedAt > cur.updatedAt) {
        state.entries[state.entries.indexOf(cur)] = e;
        changed.push(e);
        updated++;
      }
    }
    await persist(changed);
    render();
    renderStats();
    toast(`読み込み完了: 追加${added}件・更新${updated}件`);
  } catch (err) {
    console.error(err);
    toast('読み込めませんでした。ファイルを確認してください');
  }
}

function renderStats() {
  const chars = state.entries.reduce((n, e) => n + e.text.length, 0);
  $('#stats').textContent = `${state.entries.length.toLocaleString()}件 / 本文 合計${chars.toLocaleString()}字`;
}

// ---------- 共有シートからの受け取り(Android) ----------
function handleShare() {
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].some((k) => ['title', 'text', 'url'].includes(k))) return;
  let text = p.get('text') || '';
  let url = p.get('url') || '';
  if (!url) {
    // 共有元によってはURLがtextの末尾に入る
    const m = text.match(/\s*(https?:\/\/\S+)\s*$/);
    if (m) {
      url = m[1];
      text = text.slice(0, m.index).trim();
    }
  }
  history.replaceState(null, '', location.pathname);
  openForm(null, { text, title: p.get('title') || '', url, type: url ? 'web' : 'book' });
}

// ---------- イベント ----------
function bind() {
  $('#search').addEventListener('input', (ev) => {
    state.q = ev.target.value;
    state.shown = PAGE_SIZE;
    render();
  });
  $('#sort').addEventListener('change', (ev) => {
    state.sort = ev.target.value;
    render();
  });
  $('#fab').addEventListener('click', () => openForm(null));
  $('#menuBtn').addEventListener('click', () => {
    renderStats();
    openSheet($('#menuDlg'));
  });
  $('#menuClose').addEventListener('click', closeSheet);

  $('#detailClose').addEventListener('click', closeSheet);
  $('#detailEdit').addEventListener('click', () => openForm(byId(state.detailId)));
  $('#detailCopy').addEventListener('click', async () => {
    const e = byId(state.detailId);
    toast((await copyText(quoteBlock(e))) ? '引用をコピーしました' : 'コピーできませんでした');
  });
  $('#detailDelete').addEventListener('click', async () => {
    const e = byId(state.detailId);
    if (!e || !(await askConfirm('この言葉を削除しますか？\n元に戻せません。', '削除する'))) return;
    if (db) await dbDelete(e.id);
    state.entries.splice(state.entries.indexOf(e), 1);
    if (state.cat !== null && !state.entries.some((x) => x.category === state.cat)) state.cat = null;
    render();
    closeSheet();
    toast('削除しました');
  });

  $('#entryForm').addEventListener('submit', saveForm);
  $('#entryForm').addEventListener('input', () => (state.dirty = true));
  $('#fText').addEventListener('input', updateCounter);
  $('#fCat').addEventListener('input', renderCatPicker);
  $('#formCancel').addEventListener('click', closeSheet);

  $('#exportJson').addEventListener('click', exportJson);
  $('#exportMd').addEventListener('click', exportMarkdown);
  $('#importJson').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (f) importJson(f);
    ev.target.value = '';
  });
}

// ---------- 起動 ----------
async function init() {
  bind();
  try {
    db = await openDB();
    state.entries = (await dbAll()).map(normalize);
  } catch (err) {
    console.error(err);
    toast('この環境では保存できません（閉じると消えます）');
  }
  render();
  handleShare();
  // ブラウザによる自動削除を避けるため、永続化を依頼する(対応ブラウザのみ)
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
