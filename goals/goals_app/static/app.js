"use strict";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WD_FULL = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const $ = (id) => document.getElementById(id);

let state = null;
let viewMonth = null; // null = current month
const open = new Set(); // expanded goal ids
let addDays = [0, 1, 2, 3, 4, 5, 6];

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

function getToken() { try { return localStorage.getItem("goals_token") || ""; } catch { return ""; } }
function setToken(t) { try { localStorage.setItem("goals_token", t); } catch { /* private mode */ } }

async function api(path, body) {
  const opts = { headers: { "Authorization": "Bearer " + getToken() } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { $("login").showModal(); throw new Error("401"); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3000);
}
const fail = (e) => { if (e.message !== "401") toast(e.message); };

async function load() {
  try { render(await api("/api/summary" + (viewMonth ? "?month=" + viewMonth : ""))); } catch (e) { fail(e); }
}

function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
const isoDay = (month, day) => month + "-" + String(day).padStart(2, "0");
const weekdayOf = (iso) => (new Date(iso + "T12:00:00").getDay() + 6) % 7; // Monday = 0

function render(s) {
  state = s;
  const [y, m] = s.month.split("-").map(Number);
  const current = s.today.slice(0, 7) === s.month;
  const past = s.month < s.today.slice(0, 7);
  $("month").textContent = MONTHS[m - 1] + " " + y;
  $("next").style.visibility = current ? "hidden" : "visible";
  $("month-label").textContent = current ? "Этот месяц" : "Итог месяца";

  renderMonthCard(s);
  renderRewards(s, current);
  renderMatrix(s);
  renderTrend(s);
  renderCoach(s, current);
  renderGoals(s, current);
  $("empty").hidden = s.goals.length > 0;
  $("copy").hidden = s.goals.length > 0 || past;
  $("add").hidden = past;
  renderRewardEditor(s.rewards);
}

function renderMonthCard(s) {
  $("pct").textContent = Math.round(s.overall_percent);
  $("ratio").textContent = s.counted_total
    ? `${s.done_total} из ${s.counted_total} запланированных отметок выполнено.`
    : "Пока нечего считать. Первая галочка задаст отсчёт.";
  const pill = $("pill");
  pill.textContent = s.reward_unlocked ? "награда открыта" : `осталось дней: ${s.days_left}`;
  pill.className = "pill" + (s.reward_unlocked ? " on" : "");

  const threshold = s.rewards.length ? s.rewards[0].percent : 70;
  const bars = $("bars");
  bars.replaceChildren(...s.weekday_percent.map((p, i) => {
    const b = el("div", "bar");
    const wrap = el("div", "bar-fill-wrap");
    const fill = el("div", "bar-fill" + (p === null ? " none" : p < threshold ? " low" : ""));
    fill.style.height = p === null ? "6px" : Math.max(4, p) + "%";
    fill.title = p === null ? "нет данных" : Math.round(p) + "%";
    wrap.appendChild(fill);
    b.append(wrap, el("span", "", WD[i]));
    return b;
  }));
  const known = s.weekday_percent.map((p, i) => [p, i]).filter(([p]) => p !== null);
  let cap = "Выполнено ÷ запланировано, по дням недели.";
  if (known.length >= 3) {
    const [wp, wi] = known.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (wp < threshold) cap += ` Проседает ${WD_FULL[wi]}: ${Math.round(wp)}%.`;
  }
  $("bars-caption").textContent = cap;
}

function renderRewards(s, current) {
  const box = $("rewards");
  const rows = s.rewards.map((r) => {
    const div = el("div", "reward" + (r.unlocked ? " on" : ""));
    div.innerHTML = `<span class="lvl">${r.percent}%</span><span class="txt">${esc(r.text)}</span>
      <span class="state">${r.unlocked ? (current ? "открыто" : "получено") : "закрыто"}</span>`;
    return div;
  });
  box.replaceChildren(...rows);
  if (s.next_reward && s.goals.length) {
    const pr = el("div", "progress");
    const fill = el("div");
    fill.style.width = Math.min(100, (s.overall_percent / s.next_reward.percent) * 100) + "%";
    pr.appendChild(fill);
    box.appendChild(pr);
  }
}

function statusOf(g, iso) {
  if (iso.slice(0, 7) !== state.month) return "none";
  return g.day_status[Number(iso.slice(8)) - 1];
}

function cell(g, iso, status, cls) {
  const b = el("button", cls + " " + status);
  const clickable = !["none", "upcoming"].includes(status) && !(status === "off" && iso > state.today);
  b.disabled = !clickable;
  b.setAttribute("aria-label", `${g.title}, ${iso}`);
  if (clickable) b.onclick = (ev) => { ev.stopPropagation(); toggle(g, iso, status !== "done"); };
  return b;
}
const circleButton = (g, iso, status) => cell(g, iso, status, "circle");

function renderMatrix(s) {
  const card = $("matrix-card");
  card.hidden = !s.goals.length;
  if (!s.goals.length) return;
  const grid = $("matrix");
  grid.style.gridTemplateColumns = `116px repeat(${s.days_in_month}, 24px)`;
  const cells = [el("div", "hname head", "Мои цели")];
  for (let d = 1; d <= s.days_in_month; d++) {
    const iso = isoDay(s.month, d);
    cells.push(el("div", "col" + (iso === s.today ? " today" : ""), `<i>${WD[weekdayOf(iso)].toLowerCase()}</i><b>${d}</b>`));
  }
  for (const g of s.goals) {
    const name = el("div", "hname");
    name.textContent = g.title;
    cells.push(name);
    for (let d = 1; d <= s.days_in_month; d++) cells.push(cell(g, isoDay(s.month, d), g.day_status[d - 1], "sq"));
  }
  grid.replaceChildren(...cells);
  const scroller = $("matrix-scroll");
  if (s.month === s.today.slice(0, 7)) {
    const day = Number(s.today.slice(8));
    scroller.scrollLeft = Math.max(0, (day - 6) * 29);
  }
}

function renderTrend(s) {
  const card = $("trend-card");
  const pts = [];
  for (let d = 1; d <= s.days_in_month; d++) {
    let done = 0, counted = 0;
    for (const g of s.goals) {
      const st = g.day_status[d - 1];
      if (st === "done" || st === "missed") counted++;
      if (st === "done") done++;
    }
    if (counted) pts.push([d, (100 * done) / counted]);
  }
  card.hidden = pts.length < 2;
  if (pts.length < 2) return;
  const avg = pts.slice(-7).reduce((a, p) => a + p[1], 0) / Math.min(7, pts.length);
  $("trend-pill").textContent = `за 7 дней: ${Math.round(avg)}%`;

  const svg = $("trend");
  const W = Math.max(240, svg.clientWidth || 320), H = 150, L = 34, R = 6, T = 8, B = 18;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const x = (d) => L + ((d - 1) / Math.max(1, s.days_in_month - 1)) * (W - L - R);
  const y = (p) => T + (1 - p / 100) * (H - T - B);
  const thr = s.rewards.length ? s.rewards[0].percent : 70;
  const line = pts.map(([d, p], i) => (i ? "L" : "M") + x(d).toFixed(1) + " " + y(p).toFixed(1)).join(" ");
  const area = line + ` L${x(pts[pts.length - 1][0]).toFixed(1)} ${y(0)} L${x(pts[0][0]).toFixed(1)} ${y(0)} Z`;
  const last = pts[pts.length - 1];
  const xl = [1, 10, 20, s.days_in_month].map((d) => `<text class="ylab" x="${x(d)}" y="${H - 2}" text-anchor="middle">${d}</text>`).join("");
  svg.innerHTML = `
    <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e0b45a" stop-opacity=".28"/><stop offset="1" stop-color="#e0b45a" stop-opacity="0"/>
    </linearGradient></defs>
    ${[0, 50, 100].map((p) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/><text class="ylab" x="0" y="${y(p) + 4}">${p}%</text>`).join("")}
    <line class="thr" x1="${L}" x2="${W - R}" y1="${y(thr)}" y2="${y(thr)}"/>
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    <circle class="pt" cx="${x(last[0])}" cy="${y(last[1])}" r="3.5"/>${xl}`;
}

function renderCoach(s, current) {
  let html;
  const pct = Math.round(s.overall_percent);
  const yIdx = Number(s.today.slice(8)) - 2;
  const missedY = current && yIdx >= 0 && s.goals.some((g) => g.day_status[yIdx] === "missed");
  const missedTwice = current && yIdx >= 1 && s.goals.some((g) => g.day_status[yIdx] === "missed" && g.day_status[yIdx - 1] === "missed");
  const dueToday = s.goals.filter((g) => g.scheduled_today);
  const allDone = dueToday.length > 0 && dueToday.every((g) => g.done_today);
  if (!s.goals.length) html = "Начни с одной цели. <em>Одной хватит.</em>";
  else if (!current) html = s.reward_unlocked
    ? `Месяц закрыт на ${pct}%. <em>${esc(s.reward)}: заслужил.</em>`
    : `${pct}%. Не идеально. <em>Но ты дошёл до конца месяца.</em>`;
  else if (missedTwice) html = "Пропустить дважды не беда. Беда, если это станет неделей. <em>Сегодня просто сделай.</em>";
  else if (allDone) html = "На сегодня всё сделано. <em>Так и держи.</em>";
  else if (s.next_reward && s.next_reward.percent - s.overall_percent <= 5) html = `До награды осталось ${Math.max(1, Math.ceil(s.next_reward.percent - s.overall_percent))}%. <em>Добей.</em>`;
  else if (missedY) html = "Вчера мимо. Ничего страшного. <em>Сегодня отметь.</em>";
  else if (s.reward_unlocked) html = "Награда открыта. <em>Не отпускай её до конца месяца.</em>";
  else html = "Не идеально. <em>Но каждый день.</em>";
  $("coach").innerHTML = "«" + html + "»";
}

function scheduleText(days) {
  if (days.length === 7) return "каждый день";
  return days.map((d) => WD[d]).join(" ");
}

function chips(selected, onChange) {
  const box = el("div", "chips");
  WD.forEach((w, i) => {
    const c = el("button", "chip" + (selected.includes(i) ? " on" : ""), w);
    c.type = "button";
    c.onclick = () => {
      const next = selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i].sort();
      if (!next.length) return;
      selected = next;
      c.classList.toggle("on");
      onChange(next);
    };
    box.appendChild(c);
  });
  return box;
}

function renderGoals(s, current) {
  $("goals").replaceChildren(...s.goals.map((g) => {
    const li = el("li", "goal");
    const head = el("div", "goal-head");
    const todayStatus = current ? statusOf(g, s.today) : "none";
    const quick = circleButton(g, s.today, current ? todayStatus : "none");
    if (!current) quick.style.visibility = "hidden";
    const info = el("div", "goal-info");
    info.innerHTML = `<div class="goal-title">${esc(g.title)}</div>
      <div class="goal-meta">${g.streak ? `серия <b>${g.streak}</b> · ` : ""}${g.done_days} из ${g.days_counted} · ${scheduleText(g.schedule)}</div>`;
    const pct = el("div", "goal-pct", Math.round(g.percent) + "%");
    head.append(quick, info, pct);
    head.onclick = () => { open.has(g.id) ? open.delete(g.id) : open.add(g.id); render(state); };
    li.appendChild(head);

    if (open.has(g.id)) {
      const body = el("div", "goal-body");
      if (!(s.month < s.today.slice(0, 7))) {
        let days = g.schedule;
        body.appendChild(el("p", "hint", "Расписание. Меняется с сегодняшнего дня, прошлые дни остаются как были."));
        body.appendChild(chips(days, (next) => { days = next; }));
        const row = el("div", "row");
        const save = el("button", "link", "Сохранить расписание");
        save.onclick = async () => {
          try { render((await api("/api/goals/schedule", { goal_id: g.id, days, month: s.month })).summary); toast("Расписание сохранено"); } catch (e) { fail(e); }
        };
        const del = el("button", "danger", "Удалить цель");
        del.onclick = () => removeGoal(g);
        row.append(save, del);
        body.appendChild(row);
      }
      li.appendChild(body);
    }
    return li;
  }));
}

async function toggle(g, date, done) {
  try {
    const before = state.reward;
    const r = await api("/api/checkin", { goal_id: g.id, date, done });
    render(r.summary);
    if (r.summary.reward && r.summary.reward !== before) toast("Награда открыта: " + r.summary.reward);
  } catch (e) { fail(e); }
}

async function removeGoal(g) {
  if (!confirm(`Удалить цель "${g.title}" вместе с отметками?`)) return;
  try { render((await api("/api/goals/delete", { goal_id: g.id, month: state.month })).summary); } catch (e) { fail(e); }
}

function renderRewardEditor(rewards) {
  const box = $("reward-edit");
  if (box.contains(document.activeElement)) return; // don't wipe what is being typed
  box.replaceChildren(...rewards.map((r) => rewardRow(r.percent, r.text)));
}

function rewardRow(percent, text) {
  const row = el("div", "reward-row",
    `<input type="number" min="1" max="100" inputmode="numeric"><input type="text" maxlength="200" placeholder="Что получаю"><button class="x" type="button" aria-label="Убрать">×</button>`);
  const [p, t] = row.querySelectorAll("input");
  p.value = percent;
  t.value = text;
  row.querySelector("button").onclick = () => row.remove();
  return row;
}

$("reward-add").onclick = () => $("reward-edit").appendChild(rewardRow(90, ""));
$("reward-save").onclick = async () => {
  const rewards = [...$("reward-edit").querySelectorAll(".reward-row")]
    .map((row) => { const [p, t] = row.querySelectorAll("input"); return { percent: Number(p.value), text: t.value.trim() }; })
    .filter((r) => r.text);
  try {
    document.activeElement.blur();
    render((await api("/api/rewards", { rewards, month: state.month })).summary);
    toast("Награды сохранены");
  } catch (e) { fail(e); }
};

$("add-days").replaceWith(Object.assign(chips(addDays, (next) => { addDays = next; }), { id: "add-days" }));
$("add").onsubmit = async (ev) => {
  ev.preventDefault();
  const title = $("title").value.trim();
  if (!title) return;
  try {
    render((await api("/api/goals", { title, month: state.month, days: addDays })).summary);
    $("title").value = "";
  } catch (e) { fail(e); }
};

$("copy").onclick = async () => {
  try {
    const r = await api("/api/goals/copy", { month: state.month });
    render(r.summary);
    toast(r.added ? `Перенесено целей: ${r.added}` : "В прошлом месяце целей не было");
  } catch (e) { fail(e); }
};

$("prev").onclick = () => { viewMonth = shiftMonth(state.month, -1); load(); };
$("next").onclick = () => {
  const n = shiftMonth(state.month, 1);
  viewMonth = n >= state.today.slice(0, 7) ? null : n;
  load();
};
$("logout").onclick = () => $("login").showModal();
$("login-form").onsubmit = () => { setToken($("token").value.trim()); load(); };

document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
load();
