// Headless прогон purchase.html: подменяет grist и document мини-DOM'ом,
// который умеет парсить сгенерированный innerHTML (id, data-*, value у
// select/input) и реально прокликивать обработчики, навешанные wire().
// node test_purchase.js — печатает ОК/ПРОВАЛ построчно, exit 1 при провале.
"use strict";
const fs = require("fs");
const path = require("path");

const FAILS = [];
function ok(cond, label) {
  if (cond) console.log("ОК     " + label);
  else { console.log("ПРОВАЛ " + label); FAILS.push(label); }
}

const html = fs.readFileSync(path.join(__dirname, "purchase.html"), "utf8");
const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/g).pop().replace(/<\/?script>/g, "");

// ---------- мини-DOM ----------
function unquote(v) {
  if (v === undefined) return undefined;
  if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) return v.slice(1, -1);
  return v;
}
function parseAttrs(attrStr) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(attrStr))) {
    out[m[1]] = m[2] === undefined ? "" : unquote(m[2]);
  }
  return out;
}
function toCamel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function buildDataset(attrs) {
  const ds = {};
  for (const k in attrs) if (k.startsWith("data-")) ds[toCamel(k.slice(5))] = attrs[k];
  return ds;
}
function makeEl(tag, attrs, selectValue) {
  const el = {
    tagName: tag.toUpperCase(),
    id: attrs.id,
    dataset: buildDataset(attrs),
    _attrs: attrs,
    files: undefined,
    onclick: null,
    onchange: null,
    _listeners: [],
    get value() {
      if (this._val !== undefined) return this._val;
      if (tag === "select") return selectValue !== undefined ? selectValue : "";
      return attrs.value !== undefined ? attrs.value : "";
    },
    set value(v) { this._val = v; },
    get disabled() { return this._disabled !== undefined ? this._disabled : "disabled" in attrs; },
    set disabled(v) { this._disabled = v; },
    addEventListener(t, fn) { this._listeners.push([t, fn]); },
    removeEventListener() {},
    click(target) {
      if (this.disabled) return;
      const evt = { target: target || this };
      if (this.onclick) this.onclick(evt);
      this._listeners.filter(([t]) => t === "click").forEach(([, fn]) => fn(evt));
    },
    change() { if (this.onchange) this.onchange({ target: this }); },
  };
  return el;
}

let idIndex = {}, dataIndex = {};
const WATCHED_DATA = ["tab","close","billfor","editbill","delbill","ready","unready","part",
  "order","received","editreq","delreq","delitemrow","editsup","delsup"];

function reindex(htmlStr) {
  idIndex = {}; dataIndex = {}; WATCHED_DATA.forEach(k => dataIndex[k] = []);
  // селекты целиком, чтобы вытащить выбранную опцию
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  const selectSpans = [];
  let sm;
  while ((sm = selectRe.exec(htmlStr))) {
    const attrs = parseAttrs(sm[1]);
    const inner = sm[2];
    let selVal = "";
    const optRe = /<option\b([^>]*)>/g;
    let om, first;
    while ((om = optRe.exec(inner))) {
      const oa = parseAttrs(om[1]);
      if (first === undefined) first = oa.value;
      if ("selected" in oa) selVal = oa.value;
    }
    if (!selVal && first !== undefined) selVal = first;
    const el = makeEl("select", attrs, selVal);
    if (attrs.id) idIndex[attrs.id] = el;
    for (const k in attrs) if (k.startsWith("data-") && WATCHED_DATA.includes(k.slice(5))) dataIndex[k.slice(5)].push(el);
    selectSpans.push([sm.index, sm.index + sm[0].length]);
  }
  // все остальные открывающие теги (кроме тех, что внутри уже обработанных select)
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let tm;
  while ((tm = tagRe.exec(htmlStr))) {
    if (tm[1] === "option") continue;
    if (selectSpans.some(([s, e]) => tm.index > s && tm.index < e)) continue; // внутри select, уже учтено
    const attrs = parseAttrs(tm[2]);
    const el = makeEl(tm[1], attrs);
    if (attrs.id && !idIndex[attrs.id]) idIndex[attrs.id] = el;
    for (const k in attrs) if (k.startsWith("data-") && WATCHED_DATA.includes(k.slice(5))) dataIndex[k.slice(5)].push(el);
  }
}

const appEl = {
  tagName: "DIV",
  id: "app",
  get innerHTML() { return this._html || ""; },
  set innerHTML(v) { this._html = v; reindex(v); },
};

global.document = {
  getElementById: id => (id === "app" ? appEl : idIndex[id] || null),
  querySelectorAll(sel) {
    const m = sel.match(/^\[data-([\w-]+)\]$/);
    if (m) return dataIndex[m[1]] || [];
    return [];
  },
  addEventListener() {},
  createElement: () => makeEl("div", {}),
};
global.window = { location: { search: "" } };
global.location = { origin: "https://work.anyq.chat", hostname: "work.anyq.chat" };
global.Event = class {};

// ---------- фикстуры и grist-мок ----------
let seq = { Bills: 100, Purchase_requests: 100, Purchase_Request_Items: 100, Suppliers: 100 };
const dbRows = {
  Purchase_requests: [],
  Purchase_Request_Items: [],
  Suppliers: [],
  Departments: [],
  Bills: [],
};
function toColumnar(rows) {
  const ids = rows.map(r => r.id);
  const keys = new Set(["id"]);
  rows.forEach(r => Object.keys(r).forEach(k => keys.add(k)));
  const out = { id: ids };
  keys.forEach(k => { if (k !== "id") out[k] = rows.map(r => (r[k] === undefined ? null : r[k])); });
  return out;
}
const actionLog = [];
async function fetchTable(t) {
  if (t === "__missing__Bills" ) return null;
  if (global.__noBills && t === "Bills") throw new Error("no such table");
  return toColumnar(dbRows[t] || []);
}
async function applyUserActions(actions) {
  actionLog.push(...actions.map(a => JSON.parse(JSON.stringify(a))));
  // как настоящий Grist: возвращает retValues — id новых записей в порядке
  // действий (нужно purchase.html, чтобы узнать id только что созданной заявки/поставщика)
  const retValues = [];
  for (const a of actions) {
    const [kind, table, id, fields] = a;
    const rows = dbRows[table];
    if (kind === "AddRecord") {
      const newId = ++seq[table];
      rows.push(Object.assign({ id: newId }, fields));
      retValues.push(newId);
    } else if (kind === "UpdateRecord") {
      const row = rows.find(r => r.id === id);
      if (row) Object.assign(row, fields);
      retValues.push(null);
    } else if (kind === "RemoveRecord") {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      retValues.push(null);
    }
  }
  return { retValues };
}
global.grist = {
  ready() {},
  onRecords(f) { global.__onRec = f; },
  docApi: { fetchTable, applyUserActions, getDocName: async () => "doc1" },
};
global.fetch = async () => ({ ok: true, json: async () => [777] });

// ---------- загрузка виджета ----------
// eval() здесь безопасен: script — не внешний/пользовательский ввод, а код
// самого purchase.html, извлечённый из локального файла этим же тестом
// (см. чтение файла и match(/<script>.../) выше). Это тестовый стенд,
// исполняющий проверяемый код в изолированном Node-процессе, а не приём
// произвольных данных.
eval(script + "\n;globalThis.__render=render;globalThis.__wire=wire;" +
  "globalThis.__get=k=>eval(k);globalThis.__set=(k,v)=>{eval(k+'=v');};" +
  "globalThis.__loadAll=loadAll;");

async function boot() { await __loadAll(); __render(); }
function click(sel) {
  const els = typeof sel === "string" ? document.querySelectorAll(sel) : [sel];
  els.forEach(e => e.click());
  return els;
}
function byData(name, val) {
  return document.querySelectorAll("[data-" + name + "]").find(e => String(e.dataset[toCamelLocal(name)]) === String(val));
}
function toCamelLocal(n) { return n.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

// ---------- фикстуры ----------
function seedBase() {
  dbRows.Departments.length = 0;
  dbRows.Departments.push(
    { id: 1, name: "Марьесева", is_sales: true },
    { id: 2, name: "11 мкр.", is_sales: true },
    { id: 3, name: "Склад (не точка)", is_sales: false },
  );
  dbRows.Suppliers.length = 0;
  dbRows.Suppliers.push(
    { id: 1, Name: "ТОО Ромашка", Contact_person: "Иванов", Phone: "+7 700" },
    { id: 2, Name: "ИП Молоко", Contact_person: "", Phone: "" },
    { id: 3, Name: 'Постав "Кавычка" <b>Тег</b>', Contact_person: "<script>alert(1)</script>", Phone: "" },
  );
  // Expected_date — как реальный Grist Date-столбец: JS Date, не строка
  // (dstr() понимает только Date/epoch-число; со строкой ISO молча даёт "").
  dbRows.Purchase_requests.length = 0;
  dbRows.Purchase_requests.push(
    { id: 1, PR_Number: "PR-1", department_ref: 1, Status: "Approved", Expected_date: new Date("2026-09-10T00:00:00Z"), Is_received: false, Total_amount: 0, Requested_by: "Аня" },
    { id: 2, PR_Number: "PR-2", department_ref: 1, Status: "Approved", Expected_date: new Date("2026-01-01T00:00:00Z"), Is_received: false, Total_amount: 0, Requested_by: "Боря" }, // просрочена
    { id: 3, PR_Number: "PR-3", department_ref: 2, Status: "Approved", Expected_date: new Date("2026-09-12T00:00:00Z"), Is_received: false, Total_amount: 0, Requested_by: "" }, // без позиций
    { id: 4, PR_Number: "PR-4", department_ref: 2, Status: "Received", Expected_date: new Date("2026-08-01T00:00:00Z"), Is_received: true, Total_amount: 50000, Requested_by: "" },
  );
  dbRows.Purchase_Request_Items.length = 0;
  dbRows.Purchase_Request_Items.push(
    // заявка 1: один поставщик
    { id: 1, Request_ID: 1, Supplier: 1, Item_name: "Мука", Quantity: 10, Unit_price: 1000, Total_price: 0 },
    { id: 2, Request_ID: 1, Supplier: 1, Item_name: "Сахар", Quantity: 5, Unit_price: 500, Total_price: 0 },
    // заявка 2: три поставщика (один без поставщика — id 0)
    { id: 3, Request_ID: 2, Supplier: 1, Item_name: "Масло", Quantity: 1, Unit_price: 20000, Total_price: 0 },
    { id: 4, Request_ID: 2, Supplier: 2, Item_name: "Молоко", Quantity: 2, Unit_price: 3000, Total_price: 0 },
    { id: 5, Request_ID: 2, Supplier: 0, Item_name: "Прочее", Quantity: 1, Unit_price: 0, Total_price: 0 }, // сумма 0, поставщик не указан
    // заявка 4: получена, позиций нет (используется Total_amount)
  );
  dbRows.Bills.length = 0;
  seq.Bills = 100; seq.Purchase_requests = 100; seq.Purchase_Request_Items = 100; seq.Suppliers = 100;
  actionLog.length = 0;
}

(async () => {
  // 1) базовый прогон трёх вкладок
  seedBase();
  await boot();
  ok(!/undefined/.test(appEl.innerHTML) && !/NaN/.test(appEl.innerHTML), "вкладка Счета: нет undefined/NaN в разметке");
  __set("tab", "reqs"); __render();
  ok(appEl.innerHTML.includes("PR-1") && appEl.innerHTML.includes("PR-3"), "вкладка Заявки: показаны заявки, включая без позиций");
  ok(!/undefined/.test(appEl.innerHTML) && !/NaN/.test(appEl.innerHTML), "вкладка Заявки: нет undefined/NaN");
  ok(appEl.innerHTML.includes("просрочено"), "вкладка Заявки: просроченная заявка помечена");
  // 2) XSS: имя с кавычками и <>/<script> нигде не проникает как теги/не ломает атрибуты
  // (проверяем на самой вкладке "Поставщики", где эти данные видны как текст таблицы)
  __set("tab", "sups"); __render();
  ok(appEl.innerHTML.includes("ТОО Ромашка"), "вкладка Поставщики: список отрисован");
  ok(!/undefined/.test(appEl.innerHTML) && !/NaN/.test(appEl.innerHTML), "вкладка Поставщики: нет undefined/NaN");
  ok(!appEl.innerHTML.includes("<script>alert(1)</script>"), "поставщик с <script> в контакте — не исполняемый тег в разметке (экранирован)");
  ok(appEl.innerHTML.includes("&lt;script&gt;"), "контакт-строка с <script> экранирована в тексте таблицы");
  ok(appEl.innerHTML.includes("Постав &quot;Кавычка&quot; &lt;b&gt;Тег&lt;/b&gt;"), "имя поставщика с кавычками/тегами полностью экранировано");
  __set("tab", "bills"); __render();

  // 3) отсутствие таблицы Bills (до создания каких-либо счетов)
  global.__noBills = true;
  await boot();
  ok(__get("noBills") === true, "noBills выставлен, когда таблицы Bills нет");
  ok(appEl.innerHTML.includes("Bills ещё не создана"), "сообщение об отсутствующей таблице показано");
  ok(!/undefined/.test(appEl.innerHTML) && !/NaN/.test(appEl.innerHTML), "экран без Bills: нет undefined/NaN");
  ok(document.getElementById("btn-bill").disabled === true, "кнопка «+Счёт» отключена, когда Bills нет");
  global.__noBills = false;
  await boot();

  // 4) пустые справочники — не должно падать (тоже до создания счетов)
  {
    const savedDeps = dbRows.Departments.splice(0), savedSups = dbRows.Suppliers.splice(0);
    const savedReqs = dbRows.Purchase_requests.splice(0), savedItems = dbRows.Purchase_Request_Items.splice(0);
    let threwEmpty = false;
    try { await boot(); } catch (e) { threwEmpty = true; }
    ok(!threwEmpty, "пустые справочники (нет точек/поставщиков/заявок): рендер не падает");
    ok(!/NaN/.test(appEl.innerHTML), "пустые справочники: нет NaN в разметке");
    dbRows.Departments.push(...savedDeps); dbRows.Suppliers.push(...savedSups);
    dbRows.Purchase_requests.push(...savedReqs); dbRows.Purchase_Request_Items.push(...savedItems);
    await boot();
  }

  // 5) заявка с ОДНИМ поставщиком — "Выставить счёт" подставляет его и сумму
  __set("tab", "reqs"); __render();
  let btn = byData("billfor", 1);
  ok(!!btn, "кнопка «Выставить счёт» для заявки-1 найдена");
  btn.click();
  ok(__get("modal") === "bill", "модалка счёта открылась");
  ok(String(__get("fv").sup) === "1" && Number(__get("fv").amt) === 12500, "один поставщик: sup и сумма (10*1000+5*500) подставлены автоматически");
  document.getElementById("f-note").value = "тестовая правка";
  document.getElementById("f-save").click();
  await new Promise(r => setTimeout(r, 5));
  ok(__get("modal") === null, "счёт по заявке-1 создан без предупреждения, модалка закрылась");
  ok(dbRows.Bills.some(b => b.request === 1 && b.supplier === 1 && b.amount === 12500), "запись счёта появилась с верной суммой/поставщиком");

  // 4) заявка с ТРЕМЯ поставщиками (включая "без поставщика") — сумму не угадываем
  __render();
  btn = byData("billfor", 2);
  btn.click();
  ok(String(__get("fv").sup) === "0" && __get("fv").amt === "", "три поставщика: сумма и поставщик НЕ подставлены (закупщик выбирает)");
  const parts = __get("reqBySupplier")(2);
  ok(parts.length === 3, "reqBySupplier: найдены все 3 группы (в т.ч. без поставщика)");
  const partBtn = byData("part", 2); // поставщик id=2 (Молоко)
  ok(!!partBtn, "кнопка выбора поставщика в подсказке найдена");
  partBtn.click();
  ok(String(__get("fv").sup) === "2" && Number(__get("fv").amt) === 6000, "выбор поставщика из подсказки подставляет его сумму (2*3000)");
  document.getElementById("f-save").click();
  await new Promise(r => setTimeout(r, 5));
  ok(dbRows.Bills.some(b => b.request === 2 && b.supplier === 2 && b.amount === 6000), "счёт по второму поставщику заявки-2 создан корректно");

  // 5) заявка БЕЗ позиций
  __render();
  btn = byData("billfor", 3);
  btn.click();
  ok(__get("fv").amt === "" && String(__get("fv").sup) === "0", "заявка без позиций: пустая сумма, поставщик не выбран, без падений");
  ok(appEl.innerHTML.includes("Счетов по ней ещё нет"), "заявка без позиций: подсказка отрисована без ошибок");
  __set("modal", null); __render();

  // 6) создание счёта (общий путь) + защита от ДВОЙНОГО клика на "Создать"
  document.getElementById("btn-bill").click();
  document.getElementById("f-dep").value = "1";
  document.getElementById("f-sup").value = "1";
  document.getElementById("f-amt").value = "5000";
  document.getElementById("f-req").value = "0"; // без заявки — предупреждения не будет
  let s1 = document.getElementById("f-save");
  const addsBefore = actionLog.filter(a => a[0] === "AddRecord").length;
  s1.click(); s1.click(); // синхронный "двойной клик" до завершения первого save()
  ok(s1.disabled === true, "после клика кнопка «Создать» немедленно блокируется (защита от дабл-клика)");
  await new Promise(r => setTimeout(r, 10));
  const addsAfter = actionLog.filter(a => a[0] === "AddRecord").length;
  ok(addsAfter - addsBefore === 1, "двойной клик по «Создать» не создал счёт-дубль (ровно одна запись, а не две): было " + (addsAfter - addsBefore));

  // 9) ПРАВКА существующего счёта + двойное нажатие "Сохранить"
  const targetBill = dbRows.Bills.find(b => b.request === 1);
  __set("tab", "bills"); __render();
  let editBtn = byData("editbill", targetBill.id);
  editBtn.click();
  ok(Number(__get("fv").id) === targetBill.id, "форма правки: id счёта сохранён в fv (grab() его не теряет)");
  document.getElementById("f-amt").value = "12345";
  document.getElementById("f-req").value = "0"; // снимаем заявку, чтобы не ловить предупреждение о дубле
  document.getElementById("f-req").onchange();
  const updsBefore = actionLog.filter(a => a[0] === "UpdateRecord" && a[2] === targetBill.id).length;
  const addsBefore2 = actionLog.filter(a => a[0] === "AddRecord").length;
  const sEdit = document.getElementById("f-save");
  sEdit.click(); sEdit.click(); // двойное "Сохранить"
  await new Promise(r => setTimeout(r, 10));
  const updsAfter = actionLog.filter(a => a[0] === "UpdateRecord" && a[2] === targetBill.id).length;
  const addsAfter2 = actionLog.filter(a => a[0] === "AddRecord").length;
  ok(addsAfter2 === addsBefore2, "двойное «Сохранить» при правке НЕ создало новую запись (нет лишних AddRecord)");
  ok(updsAfter - updsBefore === 1, "двойное «Сохранить» при правке применилось ровно один раз (не задублировано): апдейтов " + (updsAfter - updsBefore));
  ok(dbRows.Bills.find(b => b.id === targetBill.id).amount === 12345, "сумма после правки действительно обновилась в хранилище");

  // 10) XSS через поле amount (не-числовая строка в данных, напр. из внешнего источника)
  const xssBillId = ++seq.Bills;
  dbRows.Bills.push({ id: xssBillId, request: 0, department: 1, supplier: 1, supplier_name: "ТОО Ромашка",
    amount: '1" onmouseover="alert(1)', note: "", ready: false, paid: false, date_added: Math.floor(Date.now() / 1000) });
  await __loadAll(); __render();
  const editXss = byData("editbill", xssBillId);
  editXss.click();
  const modalHtmlStr = appEl.innerHTML;
  ok(!modalHtmlStr.includes('onmouseover="alert(1)"'), "вредоносное значение amount не вырывается из атрибута value (экранировано)");
  __set("modal", null); dbRows.Bills.pop(); await __loadAll(); __render();

  // 11) отправка/возврат счёта (data-ready/unready)
  __render();
  const readyBtn = byData("ready", targetBill.id);
  ok(!!readyBtn, "кнопка «Отправить» найдена для черновика");
  readyBtn.click();
  await new Promise(r => setTimeout(r, 5));
  ok(dbRows.Bills.find(b => b.id === targetBill.id).ready === true, "счёт переведён в статус «отправлен»");
  __render();
  const unreadyBtn = byData("unready", targetBill.id);
  ok(!!unreadyBtn, "кнопка «Вернуть» найдена для отправленного счёта");
  unreadyBtn.click();
  await new Promise(r => setTimeout(r, 5));
  ok(dbRows.Bills.find(b => b.id === targetBill.id).ready === false, "счёт возвращён в черновики");

  // 12) удаление счёта
  __render();
  const before = dbRows.Bills.length;
  const delOpenBtn = byData("delbill", targetBill.id);
  delOpenBtn.click();
  ok(__get("modal") === "delbill", "модалка подтверждения удаления открылась");
  document.getElementById("f-del").click();
  await new Promise(r => setTimeout(r, 10));
  ok(dbRows.Bills.length === before - 1, "счёт удалён");
  ok(__get("modal") === null, "модалка удаления закрылась после успеха");

  // 13) предупреждение о дубле + подтверждение вторым кликом
  // (заявка-2/поставщик-2 уже имеют счёт на 6000 из шага "4" выше)
  __render();
  document.getElementById("btn-bill").click();
  document.getElementById("f-dep").value = "1";
  document.getElementById("f-req").value = "2";
  document.getElementById("f-req").onchange();
  document.getElementById("f-sup").value = "2";
  document.getElementById("f-sup").onchange();
  document.getElementById("f-amt").value = "20000";
  document.getElementById("f-amt").onchange();
  __render();
  ok(/уже есть/.test(appEl.innerHTML), "предупреждение о дубле «заявка+поставщик» показано");
  const addsBeforeWarn = actionLog.filter(a => a[0] === "AddRecord").length;
  let saveBtn = document.getElementById("f-save");
  saveBtn.click(); // первый клик — только предупреждает
  await new Promise(r => setTimeout(r, 10));
  ok(actionLog.filter(a => a[0] === "AddRecord").length === addsBeforeWarn, "первый клик при предупреждении НЕ создал счёт");
  ok(__get("fv").force === true, "флаг force выставлен после первого клика");
  saveBtn = document.getElementById("f-save"); // форма перерисована — берём свежую кнопку
  ok(!!saveBtn && saveBtn.disabled !== true, "кнопка доступна для повторного клика после предупреждения");
  saveBtn.click(); // второй клик — создаёт
  await new Promise(r => setTimeout(r, 10));
  ok(actionLog.filter(a => a[0] === "AddRecord").length === addsBeforeWarn + 1, "второй клик при подтверждении создал ровно один счёт");

  // 14) суммы 0 и отрицательные отклоняются на сохранении
  __render();
  document.getElementById("btn-bill").click();
  document.getElementById("f-amt").value = "0";
  const addsBeforeZero = actionLog.filter(a => a[0] === "AddRecord").length;
  document.getElementById("f-save").click();
  await new Promise(r => setTimeout(r, 5));
  ok(actionLog.filter(a => a[0] === "AddRecord").length === addsBeforeZero, "сумма 0 не создаёт счёт");
  ok(/Ошибка/.test(__get("uiMsg")), "сумма 0: показана ошибка ввода");
  document.getElementById("f-amt").value = "-500";
  document.getElementById("f-save").click();
  await new Promise(r => setTimeout(r, 5));
  ok(actionLog.filter(a => a[0] === "AddRecord").length === addsBeforeZero, "отрицательная сумма не создаёт счёт");

  // 15) пустая дата счёта не роняет вкладку — подставляется сегодня
  document.getElementById("f-date").value = "";
  document.getElementById("f-amt").value = "700";
  document.getElementById("f-req").value = "0";
  let threw = false;
  try {
    document.getElementById("f-save").click();
    await new Promise(r => setTimeout(r, 10));
  } catch (e) { threw = true; }
  ok(!threw, "пустая дата счёта не вызывает исключение");
  ok(!dbRows.Bills.some(b => Number.isNaN(b.date_added)), "дата счёта не превратилась в NaN при пустом поле");

  // 16) общая устойчивость wire(): за весь прогон wire() ни разу не поймал исключение
  const origErr = console.error;
  let wireCaught = 0;
  console.error = (...a) => { if (String(a[0]).includes("wire:")) wireCaught++; else origErr(...a); };
  ["bills", "reqs", "sups"].forEach(t => { __set("tab", t); __render(); });
  __set("tab", "bills");
  console.error = origErr;
  ok(wireCaught === 0, "wire() ни разу не падал с исключением на всех вкладках/состояниях");

  // ===================== новый функционал закупщика =====================

  // 17) Поставщики: создание, правка, запрет удаления используемого,
  // удаление неиспользуемого, двойной клик по кнопкам не плодит дублей/сбоев
  __set("tab", "sups"); __render();
  const addSupBtn = document.getElementById("btn-sup");
  ok(!!addSupBtn, "кнопка «+ Поставщик» найдена");
  addSupBtn.click();
  ok(__get("modal") === "sup", "модалка поставщика открылась");
  document.getElementById("s-name").value = "ТОО Новый";
  document.getElementById("s-contact").value = "Петров";
  document.getElementById("s-phone").value = "+7 701";
  document.getElementById("s-address").value = "ул. Тестовая, 1";
  const supAddsBefore = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Suppliers").length;
  let sSaveBtn = document.getElementById("s-save");
  sSaveBtn.click(); sSaveBtn.click(); // двойной клик
  ok(sSaveBtn.disabled === true, "кнопка «Создать» поставщика блокируется по клику");
  await new Promise(r => setTimeout(r, 10));
  const supAddsAfter = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Suppliers").length;
  ok(supAddsAfter - supAddsBefore === 1, "двойной клик по созданию поставщика не создал дубль: было " + (supAddsAfter - supAddsBefore));
  ok(dbRows.Suppliers.some(s => s.Name === "ТОО Новый"), "поставщик действительно создан");
  ok(__get("modal") === null, "модалка поставщика закрылась после создания (не «быстрое» открытие)");

  __render();
  const newSup = dbRows.Suppliers.find(s => s.Name === "ТОО Новый");
  const editSupBtn = byData("editsup", newSup.id);
  ok(!!editSupBtn, "кнопка «Правка» поставщика найдена");
  editSupBtn.click();
  ok(Number(__get("fv").id) === newSup.id, "форма правки поставщика: id сохранён");
  document.getElementById("s-phone").value = "+7 702";
  const supUpdsBefore = actionLog.filter(a => a[0] === "UpdateRecord" && a[1] === "Suppliers" && a[2] === newSup.id).length;
  sSaveBtn = document.getElementById("s-save");
  sSaveBtn.click(); sSaveBtn.click(); // двойное «Сохранить»
  await new Promise(r => setTimeout(r, 10));
  const supUpdsAfter = actionLog.filter(a => a[0] === "UpdateRecord" && a[1] === "Suppliers" && a[2] === newSup.id).length;
  ok(supUpdsAfter - supUpdsBefore === 1, "двойное «Сохранить» правки поставщика применилось ровно один раз");
  ok(dbRows.Suppliers.find(s => s.id === newSup.id).Phone === "+7 702", "телефон поставщика обновился");

  __render();
  let delSupBtn = byData("delsup", 1); // «ТОО Ромашка» — используется в счетах/позициях
  ok(!!delSupBtn, "кнопка удаления поставщика-1 найдена");
  delSupBtn.click();
  ok(__get("modal") === "delsup", "модалка удаления поставщика открылась");
  ok(__get("fv").blocked === true, "используемый поставщик помечен как неудаляемый");
  ok(!document.getElementById("f-delsup"), "кнопки «Удалить» нет, когда поставщик используется");
  ok(/Нельзя удалить/.test(appEl.innerHTML), "объяснение о запрете удаления показано");

  __set("modal", null); __render();
  delSupBtn = byData("delsup", newSup.id); // неиспользуемый «ТОО Новый»
  delSupBtn.click();
  ok(__get("fv").blocked === false, "неиспользуемый поставщик можно удалить");
  const supsBefore = dbRows.Suppliers.length;
  const fDelSup = document.getElementById("f-delsup");
  ok(!!fDelSup, "кнопка «Удалить» есть для неиспользуемого поставщика");
  fDelSup.click(); fDelSup.click(); // двойной клик
  await new Promise(r => setTimeout(r, 10));
  ok(dbRows.Suppliers.length === supsBefore - 1, "неиспользуемый поставщик удалён ровно один раз (двойной клик не сломал)");
  ok(__get("modal") === null, "модалка закрылась после удаления поставщика");

  // 18) Заявки: создание с позициями прямо в модальном окне + генерация PR-номера
  __set("tab", "reqs"); __render();
  const addReqBtn = document.getElementById("btn-req");
  ok(!!addReqBtn, "кнопка «+ Заявка» найдена");
  addReqBtn.click();
  ok(__get("modal") === "req", "модалка заявки открылась");
  document.getElementById("r-dep").value = "2";
  document.getElementById("r-by").value = "Света";
  document.getElementById("r-priority").value = "Срочно";
  document.getElementById("r-ed").value = "2026-09-20";
  document.getElementById("r-status").value = "Approved";
  let addItemBtn = document.getElementById("r-additem");
  ok(!!addItemBtn, "кнопка «+ строка» найдена");
  addItemBtn.click(); // строка 1
  let keys = (__get("fv").itemsList || []).map(it => it._key);
  ok(keys.length === 1, "после «+ строка» появилась одна позиция");
  document.getElementById("ri-name-" + keys[0]).value = "Молоток";
  document.getElementById("ri-qty-" + keys[0]).value = "3";
  document.getElementById("ri-price-" + keys[0]).value = "1500";
  document.getElementById("ri-sup-" + keys[0]).value = "1";
  addItemBtn = document.getElementById("r-additem"); // форма пересобрана — берём свежую кнопку
  addItemBtn.click(); // строка 2, первая не должна потеряться
  keys = (__get("fv").itemsList || []).map(it => it._key);
  ok(keys.length === 2, "после второго «+ строка» — две позиции, первая не потеряна");
  ok((__get("fv").itemsList || [])[0].name === "Молоток", "данные первой строки сохранились при добавлении второй");
  document.getElementById("ri-name-" + keys[1]).value = "Гвозди";
  document.getElementById("ri-qty-" + keys[1]).value = "10";
  document.getElementById("ri-price-" + keys[1]).value = "50";

  ok(__get("nextPRNumber")() === "PR-0005", "следующий PR-номер вычислен как PR-0005 (максимум PR-4)");
  const reqAddsBefore = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Purchase_requests").length;
  const itemAddsBefore = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Purchase_Request_Items").length;
  let rSaveBtn = document.getElementById("r-save");
  ok(!!rSaveBtn, "кнопка «Создать» заявки найдена");
  rSaveBtn.click(); rSaveBtn.click(); // двойной клик
  ok(rSaveBtn.disabled === true, "кнопка «Создать» заявки блокируется по клику");
  await new Promise(r => setTimeout(r, 15));
  const reqAddsAfter = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Purchase_requests").length;
  const itemAddsAfter = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Purchase_Request_Items").length;
  ok(reqAddsAfter - reqAddsBefore === 1, "двойной клик по «Создать» заявку не создал дубль заявки");
  ok(itemAddsAfter - itemAddsBefore === 2, "созданы ровно две позиции заявки (не задублированы двойным кликом)");
  ok(__get("modal") === null, "модалка заявки закрылась после создания");

  const newReq = dbRows.Purchase_requests.find(r => r.Requested_by === "Света");
  ok(!!newReq, "новая заявка появилась в хранилище");
  ok(newReq.PR_Number === "PR-0005", "PR-номер сгенерирован автоматически: " + newReq.PR_Number);
  ok(newReq.department_ref === 2, "заявка сохранена с выбранной точкой (department_ref)");
  ok(newReq.Priority === "Срочно" && newReq.Status === "Approved", "приоритет и статус сохранены");
  ok(Math.abs(newReq.Total_amount - 5000) < 0.01, "итог заявки = сумма позиций (3*1500+10*50=5000): " + newReq.Total_amount);
  const newItems = dbRows.Purchase_Request_Items.filter(i => i.Request_ID === newReq.id);
  ok(newItems.length === 2, "у новой заявки сохранены обе позиции");
  ok(newItems.some(i => i.Item_name === "Молоток" && i.Quantity === 3 && i.Unit_price === 1500 && i.Supplier === 1),
    "позиция «Молоток» сохранена корректно (кол-во/цена/поставщик)");
  ok(newItems.some(i => i.Item_name === "Гвозди" && i.Total_price === 500), "позиция «Гвозди» и её сумма сохранены");

  // 19) Правка заявки: удаление позиции, добавление новой, пересчёт суммы
  __set("tab", "reqs"); __render();
  const editReqBtn = byData("editreq", newReq.id);
  ok(!!editReqBtn, "кнопка «Правка» заявки найдена");
  editReqBtn.click();
  ok(Number(__get("fv").id) === newReq.id, "форма правки заявки: id сохранён");
  const curKeys = (__get("fv").itemsList || []).map(it => it._key);
  ok(curKeys.length === 2, "в форме правки подгружены обе существующие позиции");
  const delRowBtn = byData("delitemrow", curKeys[1]); // «Гвозди»
  ok(!!delRowBtn, "кнопка удаления строки позиции найдена");
  delRowBtn.click(); delRowBtn.click(); // двойной клик по удалению строки не должен падать/дублировать
  ok((__get("fv").itemsList || []).length === 1, "позиция «Гвозди» убрана из формы (двойной клик не сломал)");
  addItemBtn = document.getElementById("r-additem");
  addItemBtn.click();
  const keys2 = (__get("fv").itemsList || []).map(it => it._key);
  ok(keys2.length === 2, "после удаления одной и добавления одной — снова две позиции");
  const brandNewKey = keys2[1];
  document.getElementById("ri-name-" + brandNewKey).value = "Скотч";
  document.getElementById("ri-qty-" + brandNewKey).value = "4";
  document.getElementById("ri-price-" + brandNewKey).value = "200";

  const itemAdds2Before = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Purchase_Request_Items").length;
  const itemRemBefore = actionLog.filter(a => a[0] === "RemoveRecord" && a[1] === "Purchase_Request_Items").length;
  const reqUpdsBefore = actionLog.filter(a => a[0] === "UpdateRecord" && a[1] === "Purchase_requests" && a[2] === newReq.id).length;
  rSaveBtn = document.getElementById("r-save");
  rSaveBtn.click(); rSaveBtn.click(); // двойное «Сохранить»
  await new Promise(r => setTimeout(r, 15));
  const itemAdds2After = actionLog.filter(a => a[0] === "AddRecord" && a[1] === "Purchase_Request_Items").length;
  const itemRemAfter = actionLog.filter(a => a[0] === "RemoveRecord" && a[1] === "Purchase_Request_Items").length;
  const reqUpdsAfter = actionLog.filter(a => a[0] === "UpdateRecord" && a[1] === "Purchase_requests" && a[2] === newReq.id).length;
  ok(itemAdds2After - itemAdds2Before === 1, "добавлена ровно одна новая позиция «Скотч» (не задублирована)");
  ok(itemRemAfter - itemRemBefore === 1, "убранная позиция «Гвозди» удалена из Grist ровно один раз");
  ok(reqUpdsAfter - reqUpdsBefore === 1, "заявка обновлена ровно один раз при двойном клике «Сохранить»");
  const itemsAfterEdit = dbRows.Purchase_Request_Items.filter(i => i.Request_ID === newReq.id);
  ok(itemsAfterEdit.length === 2, "у заявки теперь две позиции: «Молоток» и «Скотч»");
  ok(itemsAfterEdit.some(i => i.Item_name === "Скотч" && i.Total_price === 800), "позиция «Скотч» сохранена с верной суммой (4*200)");
  ok(!itemsAfterEdit.some(i => i.Item_name === "Гвозди"), "позиция «Гвозди» больше не существует");
  const reqAfterEdit = dbRows.Purchase_requests.find(r => r.id === newReq.id);
  ok(Math.abs(reqAfterEdit.Total_amount - (3 * 1500 + 800)) < 0.01, "итог заявки пересчитан после правки позиций: " + reqAfterEdit.Total_amount);
  ok(reqAfterEdit.PR_Number === "PR-0005", "PR-номер при правке не перегенерируется, если уже был присвоен");

  // 20) Заявки: быстрые статусы «Заказано»/«Получено» прямо в строке, без дублей по двойному клику
  __set("modal", null); __render();
  const orderBtn = byData("order", newReq.id);
  ok(!!orderBtn, "кнопка «Заказано» найдена для заявки в работе");
  orderBtn.click(); orderBtn.click(); // двойной клик
  await new Promise(r => setTimeout(r, 10));
  const ordUpds = actionLog.filter(a => a[0] === "UpdateRecord" && a[1] === "Purchase_requests" && a[2] === newReq.id && a[3].Status === "Ordered").length;
  ok(ordUpds === 1, "двойной клик «Заказано» применился ровно один раз");
  ok(dbRows.Purchase_requests.find(r => r.id === newReq.id).Status === "Ordered", "статус заявки сменился на Ordered");

  __render();
  const recvBtn = byData("received", newReq.id);
  ok(!!recvBtn, "кнопка «Получено» найдена");
  recvBtn.click(); recvBtn.click(); // двойной клик
  await new Promise(r => setTimeout(r, 10));
  const recvUpds = actionLog.filter(a => a[0] === "UpdateRecord" && a[1] === "Purchase_requests" && a[2] === newReq.id && a[3].Is_received === true).length;
  ok(recvUpds === 1, "двойной клик «Получено» применился ровно один раз");
  const gotReq = dbRows.Purchase_requests.find(r => r.id === newReq.id);
  ok(gotReq.Is_received === true && gotReq.Status === "Received", "заявка помечена полученной (Is_received=true + Status=Received)");

  // 21) Быстрое создание поставщика прямо из формы счёта («+ создать поставщика»)
  __set("tab", "bills"); __render();
  document.getElementById("btn-bill").click();
  const fSup = document.getElementById("f-sup");
  fSup.value = "__new__";
  fSup.onchange();
  ok(__get("modal") === "sup", "выбор «+ создать поставщика» в счёте открыл форму поставщика");
  document.getElementById("s-name").value = "Экспресс Снаб";
  const quickSupBefore = dbRows.Suppliers.length;
  document.getElementById("s-save").click();
  await new Promise(r => setTimeout(r, 10));
  ok(dbRows.Suppliers.length === quickSupBefore + 1, "поставщик создан из формы счёта");
  ok(__get("modal") === "bill", "после создания поставщика форма счёта вернулась (не закрылась целиком)");
  const quickSup1 = dbRows.Suppliers.find(s => s.Name === "Экспресс Снаб");
  ok(Number(__get("fv").sup) === quickSup1.id, "новый поставщик подставлен в поле «Поставщик» формы счёта");
  __set("modal", null); __render();

  // 22) Быстрое создание поставщика прямо из строки позиции заявки
  __set("tab", "reqs"); __render();
  document.getElementById("btn-req").click();
  document.getElementById("r-additem").click();
  const ik = (__get("fv").itemsList || [])[0]._key;
  const riSup = document.getElementById("ri-sup-" + ik);
  riSup.value = "__new__";
  riSup.onchange();
  ok(__get("modal") === "sup", "выбор «+ создать поставщика» в строке позиции открыл форму поставщика");
  document.getElementById("s-name").value = "Стройбаза №2";
  document.getElementById("s-save").click();
  await new Promise(r => setTimeout(r, 10));
  ok(__get("modal") === "req", "после создания поставщика форма заявки вернулась");
  const quickSup2 = dbRows.Suppliers.find(s => s.Name === "Стройбаза №2");
  const restoredItem = (__get("fv").itemsList || []).find(it => it._key === ik);
  ok(!!restoredItem && Number(restoredItem.sup) === quickSup2.id, "новый поставщик подставлен именно в ту строку позиции, из которой был вызван");
  __set("modal", null); __render();

  // 23) Удаление заявки вместе со всеми её позициями (каскад), двойной клик не ломает
  __set("tab", "reqs"); __render();
  const delReqBtn = byData("delreq", newReq.id);
  ok(!!delReqBtn, "кнопка удаления заявки найдена");
  delReqBtn.click();
  ok(__get("modal") === "delreq", "модалка удаления заявки открылась");
  ok(/вместе с позициями/.test(appEl.innerHTML), "предупреждение о каскадном удалении позиций показано");
  const reqsBeforeDel = dbRows.Purchase_requests.length;
  ok(dbRows.Purchase_Request_Items.filter(i => i.Request_ID === newReq.id).length === 2, "перед удалением у заявки есть позиции");
  const fDelReq = document.getElementById("f-delreq");
  fDelReq.click(); fDelReq.click(); // двойной клик
  await new Promise(r => setTimeout(r, 10));
  ok(dbRows.Purchase_requests.length === reqsBeforeDel - 1, "заявка удалена");
  ok(!dbRows.Purchase_requests.some(r => r.id === newReq.id), "заявки больше нет в хранилище");
  ok(dbRows.Purchase_Request_Items.filter(i => i.Request_ID === newReq.id).length === 0, "все позиции удалённой заявки тоже удалены");
  ok(__get("modal") === null, "модалка удаления заявки закрылась");

  console.log("\n" + (FAILS.length ? "ПРОВАЛ: " + FAILS.length + " проверок не прошли" : "ОК: все проверки прошли"));
  process.exit(FAILS.length ? 1 : 0);
})().catch(e => { console.error("КРИТИЧЕСКАЯ ОШИБКА СТЕНДА:", e); process.exit(1); });
