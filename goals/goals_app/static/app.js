"use strict";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const $ = (id) => document.getElementById(id);
const RING = 2 * Math.PI * 52;

let state = null;
let viewMonth = null; // null = current month

function getToken() {
  try { return localStorage.getItem("goals_token") || ""; } catch { return ""; }
}
function setToken(t) {
  try { localStorage.setItem("goals_token", t); } catch { /* private mode */ }
}

async function api(path, body) {
  const opts = { headers: { "Authorization": "Bearer " + getToken() } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    $("login").showModal();
    throw new Error("401");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3000);
}

async function load() {
  const q = viewMonth ? "?month=" + viewMonth : "";
  try {
    render(await api("/api/summary" + q));
  } catch (e) {
    if (e.message !== "401") toast("Ошибка: " + e.message);
  }
}

function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function render(s) {
  state = s;
  const [y, m] = s.month.split("-").map(Number);
  const current = s.today.slice(0, 7) === s.month;
  $("month").textContent = MONTHS[m - 1] + " " + y;
  $("next").disabled = current;
  $("next").style.visibility = current ? "hidden" : "visible";

  const pct = s.overall_percent;
  $("pct").textContent = Math.round(pct) + "%";
  const ring = $("ring");
  ring.style.strokeDasharray = RING;
  ring.style.strokeDashoffset = RING * (1 - Math.min(pct, 100) / 100);
  ring.style.stroke = s.reward_unlocked ? "var(--accent)" : "var(--warn)";

  let sub;
  if (!s.goals.length) sub = "Добавь цели на месяц";
  else if (!current) sub = s.reward ? "Заработано: " + s.reward : "Награда не взята";
  else {
    const todayDone = s.goals.filter((g) => g.done_today).length;
    sub = `Сегодня ${todayDone} из ${s.goals.length}. Осталось дней: ${s.days_left}.`;
    if (s.next_reward) sub += ` До ${s.next_reward.percent}% не хватает ${Math.max(0, s.next_reward.percent - pct).toFixed(1)}.`;
  }
  $("sub").textContent = sub;

  const rw = $("rewards");
  rw.replaceChildren(...s.rewards.map((r) => {
    const div = document.createElement("div");
    div.className = "reward" + (r.unlocked ? " on" : "");
    div.innerHTML = `<span class="lvl"></span><span class="txt"></span><span class="state"></span>`;
    div.querySelector(".lvl").textContent = r.percent + "%";
    div.querySelector(".txt").textContent = r.text;
    div.querySelector(".state").textContent = r.unlocked ? (current ? "открыто" : "получено") : "закрыто";
    return div;
  }));

  const list = $("goals");
  list.replaceChildren(...s.goals.map((g) => goalItem(g, s, current)));
  $("empty").hidden = s.goals.length > 0;
  $("copy").hidden = s.goals.length > 0 || !current;
  $("add").hidden = s.month < s.today.slice(0, 7);

  renderRewardEditor(s.rewards);
}

function goalItem(g, s, current) {
  const li = document.createElement("li");
  li.className = "goal";
  li.innerHTML = `
    <div class="goal-head">
      <button class="check" aria-label="Отметить сегодня"></button>
      <div class="goal-title"><div class="name"></div><div class="goal-meta"></div></div>
      <div class="goal-pct"></div>
      <button class="del" aria-label="Удалить цель">×</button>
    </div>
    <div class="days"></div>`;
  li.querySelector(".name").textContent = g.title;
  li.querySelector(".goal-meta").textContent = `${g.done_days} из ${g.days_counted} дн.`;
  li.querySelector(".goal-pct").textContent = Math.round(g.percent) + "%";

  const check = li.querySelector(".check");
  if (current) {
    check.classList.toggle("on", g.done_today);
    check.textContent = g.done_today ? "✓" : "";
    check.onclick = () => toggle(g, s.today, !g.done_today);
  } else {
    check.hidden = true;
  }
  li.querySelector(".del").onclick = () => removeGoal(g);

  const done = new Set(g.done_dates);
  const days = li.querySelector(".days");
  for (let d = 1; d <= s.days_in_month; d++) {
    const iso = s.month + "-" + String(d).padStart(2, "0");
    const b = document.createElement("button");
    b.className = "day" + (done.has(iso) ? " done" : "") + (iso === s.today ? " today" : "");
    b.textContent = d;
    b.title = iso;
    b.disabled = iso > s.today || iso < g.created;
    b.onclick = () => toggle(g, iso, !done.has(iso));
    days.appendChild(b);
  }
  return li;
}

async function toggle(g, date, done) {
  try {
    const r = await api("/api/checkin", { goal_id: g.id, date, done });
    const before = state.reward;
    render(r.summary);
    if (r.summary.reward && r.summary.reward !== before) toast("Награда открыта: " + r.summary.reward);
  } catch (e) {
    if (e.message !== "401") toast(e.message);
  }
}

async function removeGoal(g) {
  if (!confirm(`Удалить цель "${g.title}" вместе с отметками?`)) return;
  try {
    render((await api("/api/goals/delete", { goal_id: g.id, month: state.month })).summary);
  } catch (e) { toast(e.message); }
}

function renderRewardEditor(rewards) {
  const box = $("reward-edit");
  if (box.contains(document.activeElement)) return; // don't wipe what is being typed
  box.replaceChildren(...rewards.map((r) => rewardRow(r.percent, r.text)));
}

function rewardRow(percent, text) {
  const row = document.createElement("div");
  row.className = "reward-row";
  row.innerHTML = `<input type="number" min="1" max="100" inputmode="numeric"><input type="text" maxlength="200" placeholder="Что получаю"><button class="del" type="button" aria-label="Убрать">×</button>`;
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
  } catch (e) { toast(e.message); }
};

$("add").onsubmit = async (ev) => {
  ev.preventDefault();
  const title = $("title").value.trim();
  if (!title) return;
  try {
    render((await api("/api/goals", { title, month: state.month })).summary);
    $("title").value = "";
  } catch (e) { toast(e.message); }
};

$("copy").onclick = async () => {
  try {
    const r = await api("/api/goals/copy", { month: state.month });
    render(r.summary);
    toast(r.added ? `Перенесено целей: ${r.added}` : "В прошлом месяце целей не было");
  } catch (e) { toast(e.message); }
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
