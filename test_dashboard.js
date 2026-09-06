"use strict";
/*
 * Интеграционный стенд для dashboard.html (без сборки, без npm-зависимостей,
 * только stdlib Node). Строит мини-DOM (парсер innerHTML + минимальный набор
 * селекторов, которых реально требует виджет: #id, .class(.class2), [attr],
 * [attr="v"], tag[attr], потомки через пробел) и фейковую БД в памяти вместо
 * grist.docApi — так можно по-настоящему кликать по кнопкам/чекбоксам/полям
 * и проверять, что именно ушло в applyUserActions (Add/Update/Remove, id,
 * значения полей), а не просто искать подстроки в готовой разметке.
 *
 * Примечание по безопасности: eval()/new Function() здесь — штатный приём
 * тестового стенда, а не обработка чужих данных: мы подгружаем СВОЙ ЖЕ
 * SCRIPT из dashboard.html (тот же репозиторий, тот же коммит) в область
 * видимости, чтобы получить доступ к его внутренним функциям/состоянию
 * (render, period, sel, fv...) без правки самого виджета. Внешнего ввода
 * в eval не передаётся.
 *
 * Запуск:  node test_dashboard.js   (из папки grist-widgets)
 * Печатает ОК/ПРОВАЛ по каждому сценарию, exit code 1 при провале.
 */
const fs = require("fs");
const path = require("path");

const HTML_PATH = path.join(__dirname, "dashboard.html");
const html = fs.readFileSync(HTML_PATH, "utf8");
const scriptMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/g);
if (!scriptMatch) { console.error("не нашёл <script> в dashboard.html"); process.exit(1); }
const SCRIPT = scriptMatch.pop().replace(/<\/?script>/g, "");

// синтаксическая проверка извлечённого скрипта (аналог node --check)
new Function(SCRIPT);

// ================== мини-DOM ==================
function decodeEntities(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function encodeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function encodeText(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
const VOID_TAGS = new Set(["input", "br", "hr", "img", "meta", "link"]);

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z][a-zA-Z0-9_-]*)(?:=("([^"]*)"|'([^']*)'))?/g;
  let m;
  while ((m = re.exec(s))) {
    const val = m[2] === undefined ? "" : decodeEntities(m[3] !== undefined ? m[3] : m[4]);
    attrs[m[1]] = val;
  }
  return attrs;
}

let RENDER_COUNT = 0;

class ElNode {
  constructor(tagName) {
    this.type = "element";
    this.tagName = (tagName || "div").toLowerCase();
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this._listeners = {};
    this.onclick = null; this.onchange = null; this.oninput = null;
    this.disabled = false;
    this.style = {};
    this.selectionStart = 0;
    this._value = undefined; this._checked = undefined; this._open = undefined;
  }
  get id() { return this.attrs.id || ""; }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = v; }
  get classList() {
    const self = this;
    return {
      add(c) { const cur = (self.attrs.class || "").split(/\s+/).filter(Boolean); if (!cur.includes(c)) { cur.push(c); self.attrs.class = cur.join(" "); } },
      remove(c) { self.attrs.class = (self.attrs.class || "").split(/\s+/).filter(x => x && x !== c).join(" "); },
      contains(c) { return (self.attrs.class || "").split(/\s+/).includes(c); },
    };
  }
  get dataset() {
    const d = {};
    for (const k in this.attrs) if (k.startsWith("data-")) d[k.slice(5).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())] = this.attrs[k];
    return d;
  }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === "select") {
      const opts = this.children.filter(c => c.type === "element" && c.tagName === "option");
      const opt = opts.find(o => "selected" in o.attrs) || opts[0];
      return opt ? (opt.attrs.value !== undefined ? opt.attrs.value : textOf(opt)) : "";
    }
    return this.attrs.value !== undefined ? this.attrs.value : "";
  }
  set value(v) { this._value = v === undefined || v === null ? "" : String(v); }
  get checked() { return this._checked !== undefined ? this._checked : ("checked" in this.attrs); }
  set checked(v) { this._checked = !!v; }
  get open() { return this._open !== undefined ? this._open : ("open" in this.attrs); }
  set open(v) { const prev = this.open; this._open = !!v; if (prev !== this._open) this.dispatchEvent({ type: "toggle" }); }
  get textContent() { return textOf(this); }
  set textContent(v) { this.children = [{ type: "text", text: String(v) }]; }
  get innerHTML() { return this.children.map(serialize).join(""); }
  set innerHTML(htmlStr) { if (this === appEl) RENDER_COUNT++; this.children = parseFragment(htmlStr, this); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter(f => f !== fn); }
  dispatchEvent(evt) {
    if (!evt.target) evt.target = this;
    const prop = this["on" + evt.type];
    if (typeof prop === "function") prop.call(this, evt);
    (this._listeners[evt.type] || []).slice().forEach(fn => fn(evt));
    return true;
  }
  querySelectorAll(sel) { return qsa(this, sel); }
  querySelector(sel) { return qsa(this, sel)[0] || null; }
  closest(sel) {
    const compound = parseCompound(sel.trim());
    let cur = this;
    while (cur && cur.type === "element") { if (matchesCompound(cur, compound)) return cur; cur = cur.parentNode; }
    return null;
  }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  focus() {} setSelectionRange() {} scrollIntoView() {}
}
function textOf(node) { return node.type === "text" ? node.text : node.children.map(textOf).join(""); }
function serialize(node) {
  if (node.type === "text") return encodeText(node.text);
  const attrParts = Object.keys(node.attrs).map(k => node.attrs[k] === "" ? k : `${k}="${encodeAttr(node.attrs[k])}"`);
  const open = `<${node.tagName}${attrParts.length ? " " + attrParts.join(" ") : ""}>`;
  if (VOID_TAGS.has(node.tagName)) return open;
  return open + node.children.map(serialize).join("") + `</${node.tagName}>`;
}
function parseFragment(htmlStr, parent) {
  const root = new ElNode("root");
  const stack = [root];
  let i = 0; const len = htmlStr.length;
  while (i < len) {
    const lt = htmlStr.indexOf("<", i);
    if (lt === -1) { pushText(htmlStr.slice(i)); break; }
    if (lt > i) pushText(htmlStr.slice(i, lt));
    const gt = htmlStr.indexOf(">", lt);
    if (gt === -1) break;
    const tagStr = htmlStr.slice(lt, gt + 1);
    i = gt + 1;
    if (tagStr.startsWith("</")) {
      const name = tagStr.slice(2, -1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tagName === name) { stack.length = k; break; }
    } else if (tagStr.startsWith("<!--")) {
      // комментарий — игнор
    } else {
      const selfClose = /\/>$/.test(tagStr);
      const inner = tagStr.slice(1, selfClose ? -2 : -1).trim();
      const nameMatch = inner.match(/^([a-zA-Z0-9]+)/);
      const tagName = nameMatch ? nameMatch[1].toLowerCase() : "div";
      const node = new ElNode(tagName);
      node.attrs = parseAttrs(inner.slice(nameMatch ? nameMatch[0].length : 0));
      node.parentNode = stack[stack.length - 1];
      stack[stack.length - 1].children.push(node);
      if (!selfClose && !VOID_TAGS.has(tagName)) stack.push(node);
    }
  }
  function pushText(t) { if (t) stack[stack.length - 1].children.push({ type: "text", text: decodeEntities(t), parentNode: stack[stack.length - 1] }); }
  root.children.forEach(c => (c.parentNode = parent));
  return root.children;
}
function parseCompound(tok) {
  const m = tok.match(/^([a-zA-Z][a-zA-Z0-9]*)?/);
  const tag = m && m[1] ? m[1].toLowerCase() : null;
  const rest = tok.slice(tag ? tag.length : 0);
  const classes = []; const attrs = []; let id = null;
  const re = /\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|#([\w-]+)/g;
  let mm;
  while ((mm = re.exec(rest))) {
    if (mm[1]) classes.push(mm[1]);
    else if (mm[2] !== undefined) attrs.push({ name: mm[2], value: mm[3] !== undefined ? mm[3] : null });
    else if (mm[4]) id = mm[4];
  }
  return { tag, classes, attrs, id };
}
function matchesCompound(el, c) {
  if (!el || el.type !== "element") return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) { const cls = (el.attrs.class || "").split(/\s+/); for (const cn of c.classes) if (!cls.includes(cn)) return false; }
  for (const a of c.attrs) { if (!(a.name in el.attrs)) return false; if (a.value !== null && el.attrs[a.name] !== a.value) return false; }
  return true;
}
function walkDescendants(node, cb) { for (const c of node.children) if (c.type === "element") { cb(c); walkDescendants(c, cb); } }
function qsa(root, selector) {
  const tokens = selector.trim().split(/\s+/).map(parseCompound);
  let candidates = [root];
  for (const tok of tokens) {
    const next = [];
    for (const c of candidates) walkDescendants(c, n => { if (matchesCompound(n, tok)) next.push(n); });
    candidates = next;
  }
  return candidates;
}

// ================== document / window / grist — заглушки ==================
const appEl = new ElNode("div");
appEl.attrs.id = "app";

const docListeners = {};
const documentStub = {
  getElementById(id) { if (appEl.attrs.id === id) return appEl; let found = null; walkDescendants(appEl, n => { if (!found && n.attrs.id === id) found = n; }); return found; },
  querySelectorAll(sel) { return qsa(appEl, sel); },
  querySelector(sel) { return qsa(appEl, sel)[0] || null; },
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  createElement(tag) { return new ElNode(tag); },
};

function fireClick(el) {
  if (!el) throw new Error("fireClick: элемент не найден");
  const evt = { target: el, type: "click", _stopped: false, stopPropagation() { this._stopped = true; }, preventDefault() {} };
  let cur = el;
  while (cur && cur.type === "element") {
    if (typeof cur.onclick === "function") cur.onclick(evt);
    if (evt._stopped) break;
    (cur._listeners.click || []).slice().forEach(fn => fn(evt));
    if (evt._stopped) break;
    cur = cur.parentNode;
  }
  if (!evt._stopped) (docListeners.click || []).forEach(fn => fn(evt));
  return evt;
}
function fireKeydown(key) { const evt = { type: "keydown", key }; (docListeners.keydown || []).forEach(fn => fn(evt)); }
function fireChange(el, value) { if (value !== undefined) el.value = value; const evt = { target: el, type: "change" }; if (typeof el.onchange === "function") el.onchange(evt); (el._listeners.change || []).forEach(fn => fn(evt)); }
function fireCheck(el, checked) { el.checked = checked; const evt = { target: el, type: "change" }; if (typeof el.onchange === "function") el.onchange(evt); (el._listeners.change || []).forEach(fn => fn(evt)); }
function fireInput(el, value) { if (value !== undefined) el.value = value; const evt = { target: el, type: "input" }; if (typeof el.oninput === "function") el.oninput(evt); (el._listeners.input || []).forEach(fn => fn(evt)); }

// ---- фейковая БД в памяти ----
let nextId = 1000;
function freshStore() {
  return {
    Departments: { id: [1, 2, 3], name: ["Aport1 Маресьева", "Aport2 11 мкр.", "Aport11 Атырау"], city: ["Актобе", "Актобе", "Атырау"], is_sales: [true, true, true], active: [true, true, true] },
    ExpenseCategories: { id: [1, 2], name: ["Продукты", "Аренда"], active: [true, true] },
    Accounts: { id: [1, 2], name: ["Касса точки", "Kaspi"], revenue_cols: ["cash", "kaspi,glovo,yandex"] },
    Expenses: { id: [], date: [], department: [], category: [], amount: [], account: [], period: [], source: [], supplier: [], note: [], created_by: [], pay_ref: [] },
    PayQueue: { id: [], bill_key: [], date_added: [], department: [], supplier: [], amount: [], invoice_link: [], request_no: [], category: [], paid: [], paid_date: [], paid_account: [], expense_created: [] },
    CashReconciliation: { id: [], date: [], department: [], cash_expected: [], cash_actual: [], diff: [], note: [], submitted_by: [] },
  };
}
let store, appliedLog;
function resetBackend() { store = freshStore(); appliedLog = []; nextId = 1000; }

function applyOne(action) {
  const [kind, table, id, fields] = action;
  const t = store[table];
  const cols = Object.keys(t);
  if (kind === "AddRecord") {
    const newId = ++nextId;
    cols.forEach(c => t[c].push(c === "id" ? newId : (fields[c] !== undefined ? fields[c] : null)));
    return newId;
  } else if (kind === "UpdateRecord") {
    const idx = t.id.indexOf(id);
    if (idx === -1) throw new Error("UpdateRecord: запись не найдена id=" + id + " в " + table);
    for (const k in fields) { if (!t[k]) t[k] = t.id.map(() => null); t[k][idx] = fields[k]; }
    return id;
  } else if (kind === "RemoveRecord") {
    const idx = t.id.indexOf(id);
    if (idx === -1) throw new Error("RemoveRecord: запись не найдена id=" + id + " в " + table);
    cols.forEach(c => t[c].splice(idx, 1));
    return id;
  }
  throw new Error("неизвестное действие " + kind);
}

let onRecordsHandler = async () => {};
const gristStub = {
  ready() {},
  onRecords(cb) { onRecordsHandler = cb; },
  docApi: {
    async fetchTable(name) { const t = store[name]; const copy = {}; for (const k in t) copy[k] = t[k].slice(); return copy; },
    async applyUserActions(actions) { appliedLog.push(actions); return actions.map(applyOne); },
  },
};

global.document = documentStub;
global.window = { location: { search: "" } };
global.Event = class { constructor(type) { this.type = type; } };
global.grist = gristStub;

// ================== загрузка виджета в текущую область видимости ==================
// __set/__get работают через eval ВНУТРИ той же функции, что и SCRIPT (см. комментарий
// про безопасность в шапке файла) — иначе у теста нет доступа к render/period/sel/fv,
// которые являются локальными переменными модуля виджета, а не свойствами глобального объекта.
const loadWidget = new Function(
  SCRIPT +
  "\n;globalThis.__render=render;" +
  "globalThis.__set=(k,v)=>{eval(k+'=v');};" +
  "globalThis.__get=(k)=>eval(k);"
);
loadWidget();
function G(name) { return global.__get(name); }
// __set(k,v) внутри виджета сделан как eval(k+"=v") — где "v" в строке это ИМЯ
// параметра v, который уже содержит настоящее значение (Set/объект/строку).
// Поэтому передаём значение напрямую, без сериализации в строку.
function S(name, value) { global.__set(name, value); }

async function render() { global.__render(); return appEl.innerHTML; }

function resetWidgetState() {
  S("period", "today"); S("cFrom", ""); S("cTo", "");
  S("sel", new Set()); S("selInit", false);
  S("openDD", false); S("modal", null); S("uiMsg", ""); S("fv", {});
  S("tab", "money"); S("expQuery", "");
}
async function freshLoad(recs) { resetWidgetState(); await onRecordsHandler(recs); }
async function reload() { await onRecordsHandler(G("recs")); }

// даты считаем через собственные утилиты виджета (dayKey/addDays), чтобы стенд
// оставался корректным в любой день запуска, а не только «сегодня» на момент написания
const dayKeyFn = G("dayKey"), addDaysFn = G("addDays");
const T0 = dayKeyFn(new Date());  // сегодня
const T1 = addDaysFn(T0, -1);     // вчера
const T2 = addDaysFn(T0, -2);     // позавчера

// ================== раннер тестов ==================
const results = [];
function ok(name) { results.push({ name, pass: true }); console.log("ОК     " + name); }
function fail(name, detail) { results.push({ name, pass: false, detail }); console.log("ПРОВАЛ " + name + (detail ? " — " + detail : "")); }
function check(name, cond, detail) { cond ? ok(name) : fail(name, detail); }

function mkRevRow(id, dk, dep, fields) {
  return Object.assign({ id, key: dk + "|" + dep, date: new Date(dk + "T00:00:00Z"), department: dep,
    cash: 0, kaspi: 0, halyk: 0, bck: 0, glovo: 0, wolt: 0, chocofood: 0, yandex: 0, other: 0, total: 0,
    last_sync_upper: (T0+"T09:00:00+05:00"), updated_at: "" }, fields);
}
function markupSane(htmlStr, label) {
  const badUndef = (htmlStr.match(/undefined/g) || []).length;
  const badNaN = (htmlStr.match(/\bNaN\b/g) || []).length;
  check(label + ": нет undefined в разметке", badUndef === 0, badUndef + " вхождений");
  check(label + ": нет NaN в разметке", badNaN === 0, badNaN + " вхождений");
}

async function main() {
  // ---- 1. базовая загрузка, все периоды, обе вкладки ----
  resetBackend();
  await freshLoad([
    mkRevRow(1, T2, 1, { cash: 120000, kaspi: 80000, total: 200000 }),
    mkRevRow(2, T1, 1, { cash: 140000, kaspi: 90000, total: 230000 }),
    mkRevRow(3, T1, 2, { cash: 60000, kaspi: 40000, total: 100000 }),
    mkRevRow(4, T0, 3, { cash: 10000, kaspi: 5000, total: 15000 }),
  ]);
  let h = await render();
  markupSane(h, "базовый рендер");
  for (const k of ["today", "yest", "7d", "month", "all", "custom"]) { S("period", k); h = await render(); markupSane(h, "период " + k); }
  S("period", "today"); await render();
  for (const t of ["money", "an"]) { S("tab", t); h = await render(); markupSane(h, "вкладка " + t); }
  S("tab", "money"); await render();

  {
    const anBtn = documentStub.querySelector('.pills.tabs [data-tab="an"]');
    check("кнопка вкладки «Аналитика» найдена в разметке", !!anBtn);
    if (anBtn) {
      fireClick(anBtn);
      check("клик по вкладке переключает tab, а не period", G("tab") === "an" && G("period") === "today", "tab=" + G("tab") + " period=" + G("period"));
    }
    S("tab", "money"); await render();
  }

  // ---- 2. период «Всё» не растягивает график на сотни тысяч столбцов ----
  // (график живёт на вкладке «Аналитика»)
  {
    S("period", "all"); S("tab", "an"); h = await render();
    const bars = (h.match(/class="cb/g) || []).length;
    check("период «Всё»: столбцов графика не больше 60", bars > 0 && bars <= 60, "bars=" + bars);
    S("period", "today"); S("tab", "money"); await render();
  }

  // ---- 3. пустые данные / край по датам ----
  for (const scenario of [
    { name: "нет выручки", recs: [] },
    { name: "одна точка данных", recs: [mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })] },
    { name: "данные за один день (2 точки)", recs: [mkRevRow(1, T0, 1, { cash: 1000, total: 1000 }), mkRevRow(2, T0, 2, { kaspi: 2000, total: 2000 })] },
  ]) {
    resetBackend(); await freshLoad(scenario.recs);
    for (const p of ["today", "7d", "month", "all"]) { S("period", p); h = await render(); markupSane(h, scenario.name + " / период " + p); }
  }
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 5000, total: 5000 })]);
  h = await render();
  markupSane(h, "нет расходов/счетов/сдач");
  check("нет расходов: нет NaN%/Infinity в KPI", !/NaN%|Infinity/.test(h));
  check("нет расходов: чистый доход помечен как неизвестный (расходы не вносили)", h.includes("расходы не внесены"));

  // ---- 4. суммы 0 и отрицательные ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 0, kaspi: 0, total: 0 })]);
  store.Expenses = { id: [501], date: [new Date((T0+"T00:00:00Z"))], department: [1], category: [1], amount: [-500], account: [1], period: ["2026-09"], source: ["казначей"], supplier: [""], note: ["сторно"], created_by: ["t"], pay_ref: [""] };
  await reload();
  h = await render();
  markupSane(h, "отрицательный расход");
  check("отрицательный расход: нет двойного знака минуса в разметке", !/−-|-−/.test(h), JSON.stringify(h.match(/.{0,8}(−-|-−).{0,8}/g) || []));

  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  store.Expenses = { id: [502], date: [new Date((T0+"T00:00:00Z"))], department: [1], category: [1], amount: [0], account: [1], period: ["2026-09"], source: ["казначей"], supplier: [""], note: ["ноль"], created_by: ["t"], pay_ref: [""] };
  await reload(); await render();
  {
    const row = documentStub.querySelector("[data-editexp]");
    fireClick(row); await render();
    const amtField = documentStub.getElementById("f-amt");
    check("правка расхода с суммой 0: поле суммы показывает «0», а не пусто", amtField && amtField.value === "0", "value=" + JSON.stringify(amtField && amtField.value));
  }

  // ---- 5. XSS / битая разметка при кавычках и <> в данных ----
  resetBackend();
  store.Departments = { id: [1], name: ['Aport "<script>alert(1)</script>" & Co'], city: ["Актобе"], is_sales: [true], active: [true] };
  store.ExpenseCategories = { id: [1], name: ['Пр"одук<ты>&'], active: [true] };
  store.Expenses = { id: [901], date: [new Date((T0+"T00:00:00Z"))], department: [1], category: [1], amount: [1234], account: [1], period: ["2026-09"], source: ["казначей"], supplier: ["<img src=x onerror=alert(2)>"], note: ['"note" & <b>bold</b>'], created_by: ["t"], pay_ref: [""] };
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  h = await render();
  check("XSS: сырой <script> не попал в разметку", !h.includes("<script>alert(1)</script>"));
  check("XSS: сырой onerror-атрибут не попал в разметку", !h.includes("<img src=x onerror=alert(2)>"));
  check("XSS: сырой <b>bold</b> из note не попал в разметку", !h.includes("<b>bold</b>"));
  markupSane(h, "данные с кавычками и <>");

  // ---- 6. поиск по расходам — не должен дёргать полный render() на каждый символ ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  store.Expenses = {
    id: [1, 2, 3], date: [new Date((T0+"T00:00:00Z")), new Date((T0+"T00:00:00Z")), new Date((T0+"T00:00:00Z"))],
    department: [1, 1, 1], category: [1, 2, 1], amount: [1000, 2000, 3000], account: [1, 1, 1],
    period: ["2026-09", "2026-09", "2026-09"], source: ["казначей", "казначей", "казначей"],
    supplier: ["Молоко ТОО", "Аренда ИП", "Овощи ТОО"], note: ["", "", ""], created_by: ["t", "t", "t"], pay_ref: ["", "", ""],
  };
  await reload(); await render();
  {
    const es = documentStub.getElementById("expsearch");
    check("поле поиска расходов найдено", !!es);
    if (es) {
      RENDER_COUNT = 0;
      fireInput(es, "мол"); fireInput(es, "моло"); fireInput(es, "молоко");
      check("поиск по расходам не вызывает полный render() на каждый символ", RENDER_COUNT === 0, "полных render() при вводе 3 символов: " + RENDER_COUNT);
      const listNode = documentStub.getElementById("explist");
      const listHtml = listNode ? listNode.innerHTML : appEl.innerHTML;
      check("поиск фильтрует список (после «молоко» видна только Молоко ТОО)",
        listHtml.includes("Молоко ТОО") && !listHtml.includes("Аренда ИП") && !listHtml.includes("Овощи ТОО"));
      fireInput(es, "");
      const listHtml2 = (documentStub.getElementById("explist") || appEl).innerHTML;
      check("сброс поиска возвращает полный список расходов", listHtml2.includes("Аренда ИП") && listHtml2.includes("Овощи ТОО"));
    }
  }

  // ---- 7. правка расхода — grabForm сохраняет id, апдейт вместо дубля ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  store.Expenses = { id: [77], date: [new Date((T0+"T00:00:00Z"))], department: [1], category: [1], amount: [5000], account: [1], period: ["2026-09"], source: ["казначей"], supplier: ["Пост"], note: ["исходно"], created_by: ["t"], pay_ref: [""] };
  await reload(); await render();
  {
    const row = documentStub.querySelector("[data-editexp]");
    check("строка расхода для правки найдена", !!row);
    fireClick(row);
    check("модалка открыта как «правка», fv.id выставлен", G("modal") === "exp" && G("fv").id === 77);
    await render();
    fireInput(documentStub.getElementById("f-note"), "правка через тест");
    fireInput(documentStub.getElementById("f-amt"), "6000");
    appliedLog.length = 0;
    const saveBtn = documentStub.getElementById("f-add");
    check("кнопка сохранения найдена", !!saveBtn);
    if (saveBtn) await saveBtn.onclick();
    check("правка расхода — UpdateRecord с исходным id (не дубль)",
      appliedLog.length === 1 && appliedLog[0][0][0] === "UpdateRecord" && appliedLog[0][0][2] === 77, JSON.stringify(appliedLog));
    check("после правки в базе одна запись (не дубль)", store.Expenses.id.length === 1, "id=" + JSON.stringify(store.Expenses.id));
    check("значения полей действительно обновились", store.Expenses.note[0] === "правка через тест" && store.Expenses.amount[0] === 6000);
  }

  // ---- 8. сдача наличных — повторный ввод за тот же день/точку обновляет, не дублирует ----
  resetBackend();
  await freshLoad([mkRevRow(1, T2, 1, { cash: 100000, total: 100000 })]);
  await render();
  {
    const handBtn = documentStub.querySelector("[data-hand]");
    check("кнопка «Внести» по несданной кассе найдена", !!handBtn);
    if (handBtn) {
      fireClick(handBtn);
      check("модалка «Сдача наличных» открылась", G("modal") === "cash");
      await render();
      fireInput(documentStub.getElementById("f-amt"), "95000");
      appliedLog.length = 0;
      await documentStub.getElementById("f-cash").onclick();
      check("первая сдача — AddRecord", appliedLog.length === 1 && appliedLog[0][0][0] === "AddRecord");
      check("в базе одна запись сдачи", store.CashReconciliation.id.length === 1);

      await reload();
      S("modal", "cash"); S("fv", { date: T2, dep: 1 });
      await render();
      fireInput(documentStub.getElementById("f-amt"), "99000");
      appliedLog.length = 0;
      await documentStub.getElementById("f-cash").onclick();
      check("повторная сдача за тот же день/точку — UpdateRecord, а не Add",
        appliedLog.length === 1 && appliedLog[0][0][0] === "UpdateRecord", JSON.stringify(appliedLog));
      check("после повторной сдачи в базе всё ещё одна запись (не дубль)", store.CashReconciliation.id.length === 1, "id=" + JSON.stringify(store.CashReconciliation.id));
      check("сумма обновилась на новую", store.CashReconciliation.cash_actual[0] === 99000);
    }
  }

  // ---- 9. массовая инкассация — без дублей, по одной записи на точку ----
  // модалка по умолчанию открывается на «вчера» (T1) — выручку кладём туда же
  resetBackend();
  await freshLoad([mkRevRow(1, T1, 1, { cash: 50000, total: 50000 }), mkRevRow(2, T1, 2, { cash: 30000, total: 30000 })]);
  await render();
  {
    fireClick(documentStub.getElementById("btn-cash"));
    await render();
    check("модалка «Инкассация за день» открылась", G("modal") === "bulk");
    const bulkInputs = documentStub.querySelectorAll("[data-bulk]");
    check("в форме инкассации есть строки по точкам", bulkInputs.length >= 2, "строк=" + bulkInputs.length);
    bulkInputs.forEach(inp => fireInput(inp, "1000"));
    appliedLog.length = 0;
    await documentStub.getElementById("f-bulk").onclick();
    const addCount = appliedLog[0].filter(a => a[0] === "AddRecord").length;
    check("массовая инкассация создала по одной записи на точку", addCount === bulkInputs.length, "создано=" + addCount);
  }

  // ---- 10. Escape/фон закрывает модалку, не роняя остальные обработчики ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  await render();
  {
    fireClick(documentStub.getElementById("btn-exp"));
    await render();
    check("модалка «+ Расход» открыта", G("modal") === "exp");
    fireKeydown("Escape");
    await render();
    check("Escape закрывает модалку", G("modal") === null);
    fireClick(documentStub.querySelector('[data-p="7d"]'));
    check("после Escape переключение периода по-прежнему работает (баг №1 не вернулся)", G("period") === "7d");
    S("period", "today"); await render();
  }

  // ---- 11. выбор точек: снятие/выбрать все/сбросить ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 }), mkRevRow(2, T0, 2, { cash: 2000, total: 2000 })]);
  await render();
  {
    const cb1 = documentStub.querySelector('[data-dep="1"]');
    check("чекбокс точки найден", !!cb1);
    fireCheck(cb1, false);
    check("снятие точки убирает её из выбора", !G("sel").has(1));
    fireClick(documentStub.querySelector("[data-selnone]"));
    check("«Сбросить» очищает выбор точек", G("sel").size === 0);
    markupSane(appEl.innerHTML, "все точки сняты");
    fireClick(documentStub.querySelector("[data-selall]"));
    check("«Выбрать все» возвращает все точки", G("sel").size === G("depOrder").length, "sel=" + G("sel").size + " depOrder=" + G("depOrder").length);
  }

  // ---- 12. оплата счёта: что выбрано в UI, то и уходит в запись ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  store.PayQueue = { id: [55], bill_key: ["B1"], date_added: [new Date((T1+"T00:00:00Z"))], department: [1], supplier: ["ТОО Рога и копыта"], amount: [45000], invoice_link: [""], request_no: ["PR-1"], category: [1], paid: [false], paid_date: [null], paid_account: [0], expense_created: [false] };
  await reload(); await render();
  {
    const accSelEl = documentStub.querySelector('[data-accfor="55"]');
    const catSelEl = documentStub.querySelector('[data-catfor="55"]');
    check("селекты счёта и статьи для счёта найдены", !!accSelEl && !!catSelEl);
    accSelEl.value = "2"; catSelEl.value = "2";
    appliedLog.length = 0;
    await documentStub.querySelector('[data-pay="55"]').onclick();
    const addAction = appliedLog[0].find(a => a[0] === "AddRecord" && a[1] === "Expenses");
    check("оплата счёта пишет расход с тем счётом, что выбран в UI", addAction && addAction[3].account === 2, JSON.stringify(addAction));
    check("оплата счёта пишет расход с той статьёй, что выбрана в UI", addAction && addAction[3].category === 2, JSON.stringify(addAction));
    check("сумма расхода равна сумме счёта", addAction && addAction[3].amount === 45000);
    const upd = appliedLog[0].find(a => a[0] === "UpdateRecord" && a[1] === "PayQueue");
    check("счёт помечен оплаченным с тем же счётом списания", upd && upd[3].paid === true && upd[3].paid_account === 2);
  }

  // ---- 13. удаление расхода — подтверждение, без падений ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  store.Expenses = { id: [21], date: [new Date((T0+"T00:00:00Z"))], department: [1], category: [1], amount: [1000], account: [1], period: ["2026-09"], source: ["казначей"], supplier: [""], note: [""], created_by: ["t"], pay_ref: [""] };
  await reload(); await render();
  {
    fireClick(documentStub.querySelector("[data-delexp]"));
    await render();
    check("открылась модалка подтверждения удаления расхода", G("modal") === "delexp" && G("fv").id === 21);
    await documentStub.getElementById("f-delexp").onclick();
    check("удаление расхода прошло, запись пропала", store.Expenses.id.length === 0);
  }

  // ---- 14. нет точек продаж (depOrder пуст) не роняет рендер ----
  resetBackend();
  store.Departments = { id: [1], name: ["Склад"], city: ["Актобе"], is_sales: [false], active: [true] };
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  h = await render();
  markupSane(h, "нет точек продаж (depOrder пуст)");
  check("нет точек продаж: показано «Нет данных за период»", h.includes("Нет данных за период"));

  // ---- 15. свежесть данных: чип предупреждает об отставшем обмене ----
  resetBackend();
  const twoHours = 2 * 60 * 60 * 1000;
  const freshCut = new Date(Date.now() - twoHours + 5 * 60000).toISOString();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000, last_sync_upper: freshCut })]);
  h = await render();
  check("свежий обмен: чип без тревоги", h.includes("Обновлено в") && !h.includes("отстал"));
  const staleCut = new Date(Date.now() - twoHours - 3 * 60 * 60000).toISOString();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000, last_sync_upper: staleCut })]);
  h = await render();
  check("отставший обмен: чип предупреждает", h.includes("Обмен с iiko отстал"));
  markupSane(h, "чип свежести данных");

  // ---- 16. клик по точке фильтрует на неё и обратно ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 3000, total: 3000 }),
                   mkRevRow(2, T0, 2, { cash: 2000, total: 2000 })]);
  h = await render();
  check("строки точек кликабельны", h.includes('data-point="1"'));
  fireClick(document.querySelector('[data-point="1"]')); await render();
  check("клик по точке оставил только её", G("sel").size === 1 && G("sel").has(1));
  fireClick(document.querySelector('[data-point="1"]')); await render();
  check("повторный клик вернул все точки", G("sel").size > 1);
  markupSane(document.getElementById("app").innerHTML, "клик по точке");

  // ---- 17. прибыль по точкам на вкладке аналитики ----
  resetBackend();
  store.Expenses = { id: [31], date: [T0], department: [1], category: [1], amount: [500],
    account: [1], period: ["2026-09"], source: ["казначей"], supplier: [""], note: [""],
    created_by: ["t"], pay_ref: [""] };
  await freshLoad([mkRevRow(1, T0, 1, { cash: 3000, total: 3000 }),
                   mkRevRow(2, T0, 2, { cash: 1000, total: 1000 })]);
  S("tab", "an");
  h = await render();
  check("аналитика: есть таблица прибыли по точкам", h.includes("Прибыль по точкам"));
  check("прибыль по точкам: есть итоговая строка", h.includes("Итого"));
  markupSane(h, "прибыль по точкам");
  S("tab", "money");

  // ---- 18. сбой чтения данных виден, а не показан нулями ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  S("loadError", "сеть недоступна");
  h = await render();
  check("сбой загрузки: показан баннер", h.includes("Не удалось прочитать данные"));
  check("сбой загрузки: указана причина", h.includes("сеть недоступна"));
  markupSane(h, "баннер сбоя загрузки");
  S("loadError", "");
  h = await render();
  check("после успешной загрузки баннера нет", !h.includes("Не удалось прочитать данные"));

  // ---- 19. расход можно сохранить, даже если файл не загрузился ----
  resetBackend();
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  h = await render();
  fireClick(documentStub.getElementById("btn-exp"));
  h = await render();
  check("в форме расхода есть поле файла", documentStub.getElementById("f-file") !== null);
  const fileEl = documentStub.getElementById("f-file");
  fileEl.files = [{ name: "чек.jpg" }];   // загрузка упадёт: fetch в стенде нет
  fireInput(documentStub.getElementById("f-amt"), "700");
  const addBtn = documentStub.getElementById("f-add");
  fireClick(addBtn);
  await new Promise(r => setTimeout(r, 30));
  check("расход записан несмотря на сбой загрузки файла", store.Expenses.id.length === 1);
  check("сообщение объясняет, что файл не прикрепился",
    String(G("uiMsg")).includes("Файл не прикрепился"));
  markupSane(appEl.innerHTML, "расход со сбоем файла");

  // ---- 20. вложение расхода видно ссылкой ----
  resetBackend();
  store.Expenses = { id: [41], date: [T0], department: [1], category: [1], amount: [900],
    account: [1], period: ["2026-09"], source: ["казначей"], supplier: [""], note: ["с чеком"],
    created_by: ["t"], pay_ref: [""], attachment: [["L", 7]] };
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  S("docId", "abc123");
  h = await render();
  check("расход с вложением помечен", h.includes(">файл<"));
  check("вложение ведёт на прокси файла",
    h.includes("/file?doc=abc123&att=7") || h.includes("/file?doc=abc123&amp;att=7"));
  markupSane(h, "вложение расхода");
  S("docId", "");
  h = await render();
  check("без id документа метка остаётся, но без ссылки",
    h.includes(">файл<") && !h.includes("/file?doc="));

  // ---- 21. отчёт о прибылях: группы, изъятия, прочие доходы ----
  resetBackend();
  store.ExpenseCategories = { id: [1, 2, 3, 4], name: ["Продукты", "Аренда", "Изъятие", "Возврат"],
    pnl_group: ["Себестоимость", "Операционные", "Изъятия (не PnL)", "Прочие доходы"],
    active: [true, true, true, true] };
  store.Expenses = { id: [51, 52, 53, 54], date: [T0, T0, T0, T0], department: [1, 1, 1, 1],
    category: [1, 2, 3, 4], amount: [3000, 1000, 5000, 200], account: [1, 1, 1, 1],
    period: ["2026-09", "2026-09", "2026-09", "2026-09"],
    source: ["казначей", "казначей", "казначей", "казначей"],
    supplier: ["", "", "", ""], note: ["", "", "", ""], created_by: ["t", "t", "t", "t"],
    pay_ref: ["", "", "", ""] };
  await freshLoad([mkRevRow(1, T0, 1, { cash: 10000, total: 10000 })]);
  S("tab", "an");
  h = await render();
  check("есть отчёт о прибылях", h.includes("Прибыли и убытки"));
  check("себестоимость показана", h.includes("Себестоимость"));
  // 10000 выручки + 200 прочих доходов − 3000 − 1000 = 6200; изъятие 5000 не влияет
  {
    // fmt() ставит неразрывные пробелы — нормализуем перед поиском числа
    const flat = h.replace(/[\s\u00A0\u202F]/g, "");
    check("чистый доход считается без изъятий (ожидаем 6200)", flat.includes("6200"),
      "фрагмент: " + flat.slice(flat.indexOf("Чистыйдоход"), flat.indexOf("Чистыйдоход") + 120));
  }
  check("изъятия показаны отдельной строкой", h.includes("Изъятия владельцев"));
  markupSane(h, "отчёт о прибылях");
  S("tab", "money");

  // ---- 22. реквизиты поставщика видны казначею при оплате ----
  resetBackend();
  store.PayQueue = { id: [61], bill_key: ["B61-x"], date_added: [T0], department: [1],
    supplier: ["ТОО Ромашка"], amount: [5000], invoice_link: [""], request_no: ["PR-1"],
    category: [1], paid: [false], paid_date: [null], paid_account: [0], expense_created: [false],
    requisites: ["БИН 123456789012, Kaspi Bank, БИК CASPKZKA, счёт KZ123"] };
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  h = await render();
  check("реквизиты поставщика показаны в очереди", h.includes("KZ123") && h.includes("БИК"));
  store.PayQueue.requisites = [""];
  await freshLoad([mkRevRow(1, T0, 1, { cash: 1000, total: 1000 })]);
  h = await render();
  check("без реквизитов есть предупреждение", h.includes("реквизиты поставщика не заполнены"));
  markupSane(h, "реквизиты в очереди оплаты");

  // ================== итог ==================
  const total = results.length, passed = results.filter(r => r.pass).length, failed = total - passed;
  console.log("\n==============================");
  console.log(`Итого: ${total}, ОК: ${passed}, ПРОВАЛ: ${failed}`);
  if (failed > 0) {
    console.log("\nПровалившиеся сценарии:");
    results.filter(r => !r.pass).forEach(r => console.log(" - " + r.name + (r.detail ? " (" + r.detail + ")" : "")));
    process.exit(1);
  }
}

main().catch(e => { console.error("НЕОЖИДАННАЯ ОШИБКА СТЕНДА:", e); process.exit(1); });
