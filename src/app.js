import {
  carList,
  carsForClass,
  deckSide,
  nearestRoomCars,
  recommend,
  trainServes,
  walkEstimate,
} from "./recommend.js";

const STORAGE_KEY = "kitsuen-navi:form";
const VERIFICATION_LABEL = { official: "公式", unverified: "要確認", conflict: "情報不一致" };
const LINE_LABEL = { tokaido: "東海道新幹線", sanyo: "山陽新幹線", kyushu: "九州新幹線" };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const form = $("#search-form");
const resultEl = $("#result");
let data;

init().catch((err) => {
  resultEl.innerHTML = `<p class="card error">データを読み込めませんでした: ${esc(err.message)}</p>`;
});

async function init() {
  const res = await fetch("data/stations.json");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  data = await res.json();

  $("#data-updated").textContent = `データ更新日: ${data.meta.updatedAt}`;
  fillSelects();
  restoreForm();
  form.addEventListener("change", update);
  $("#swap").addEventListener("click", () => {
    [form.from.value, form.to.value] = [form.to.value, form.from.value];
    update();
  });
  window.addEventListener("hashchange", route);
  route();
  renderStationList();
  update();

  // 開発中(localhost)は古いキャッシュを掴まないよう登録しない
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

function fillSelects() {
  const options = Object.entries(LINE_LABEL)
    .map(([line, label]) => {
      const opts = data.stations
        .filter((s) => s.line === line)
        .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.rooms.length ? "" : "（情報なし）"}</option>`)
        .join("");
      return `<optgroup label="${esc(label)}">${opts}</optgroup>`;
    })
    .join("");
  form.from.innerHTML = options;
  form.to.innerHTML = options;
  form.from.value = "tokyo";
  form.to.value = "shinosaka";
  form.train.innerHTML = Object.entries(data.trains)
    .map(([id, t]) => `<option value="${esc(id)}">${esc(t.name)}</option>`)
    .join("");
}

function restoreForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved) return;
    for (const name of ["from", "to", "train", "seat"]) {
      if (saved[name] && [...form[name].options].some((o) => o.value === saved[name])) form[name].value = saved[name];
    }
    form.before.checked = saved.before ?? true;
    form.after.checked = saved.after ?? true;
  } catch {
    /* 保存値が使えなくても初期値で動かす */
  }
}

function saveForm(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* プライベートモード等では保存しない */
  }
}

function route() {
  const tab = location.hash === "#stations" ? "stations" : "search";
  $("#view-search").hidden = tab !== "search";
  $("#view-stations").hidden = tab !== "stations";
  for (const a of document.querySelectorAll(".tab")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function update() {
  const state = {
    from: form.from.value,
    to: form.to.value,
    train: form.train.value,
    seat: form.seat.value,
    before: form.before.checked,
    after: form.after.checked,
  };
  if (state.from === state.to) {
    saveForm(state);
    resultEl.innerHTML = `<p class="card error">乗車駅と降車駅に別の駅を選んでください。</p>`;
    return;
  }
  state.train = syncTrainOptions(state);
  saveForm(state);
  if (!state.train) {
    resultEl.innerHTML = `<p class="card notice">この区間を直通する列車がありません。新大阪駅などで乗り換える場合は、区間を分けて検索してください。</p>`;
    return;
  }
  if (!state.before && !state.after) {
    resultEl.innerHTML = `<p class="card notice">「乗車前」か「降車後」のどちらかを選んでください。</p>`;
    return;
  }

  const r = recommend({
    data,
    fromId: state.from,
    toId: state.to,
    trainId: state.train,
    seatClass: state.seat,
    smokeBefore: state.before,
    smokeAfter: state.after,
  });
  resultEl.innerHTML = renderResult(r, state);
  $("#copy-memo")?.addEventListener("click", (e) => copyMemo(e.currentTarget));
}

/** 区間を走らない列車を選べないようにし、選択中の列車が走らなければ走る列車に切り替える */
function syncTrainOptions(state) {
  let firstServing = "";
  for (const option of form.train.options) {
    option.disabled = !trainServes(data.stations, data.trains[option.value], state.from, state.to);
    if (!option.disabled && !firstServing) firstServing = option.value;
  }
  if (form.train.selectedOptions[0]?.disabled) form.train.value = firstServing;
  return firstServing ? form.train.value : "";
}

function renderResult(r, state) {
  const train = data.trains[state.train];
  const dirLabel = data.meta.directions[r.direction];
  const best = r.ranked[0];
  const bestCost = best?.cost;
  const ties = r.ranked.filter((c) => c.cost === bestCost).map((c) => c.car);
  const runnersUp = r.ranked.filter((c) => c.cost !== bestCost).slice(0, 3);
  const partial =
    (state.before && r.dep.knownGroups.length > 0 && r.dep.unknownGroups.length > 0) ||
    (state.after && r.arr.knownGroups.length > 0 && r.arr.unknownGroups.length > 0);

  let headline;
  if (!best) {
    headline = `<p>この列車・座席の組み合わせには対象の号車がありません。</p>`;
  } else if (!r.carMatters) {
    const unknownForTrain =
      (state.before && r.dep.unknownGroups.length > 0) || (state.after && r.arr.unknownGroups.length > 0);
    headline = unknownForTrain
      ? `<p class="notice">ホームに喫煙所はありますが、${esc(train.name)}での号車位置がまだ分かっていないため、おすすめ号車を出せません。</p>`
      : `<p class="notice">選んだ駅には号車位置の分かる喫煙所がないため、号車による差はありません（コンコースの喫煙所や駅の案内を下で確認してください）。</p>`;
  } else {
    headline = `
      <div class="best">
        <div>
          <div class="best-car">${best.car}<small>号車</small></div>
          ${ties.length > 1 ? `<div class="best-alt">同じくらい近い: ${ties.slice(1).map((c) => `${c}号車`).join("・")}</div>` : ""}
        </div>
        <div>
          ${best.depDist !== null ? `<div>乗車前: ${walkText(best.depDist)}</div>` : ""}
          ${best.arrDist !== null ? `<div>降車後: ${walkText(best.arrDist)}</div>` : ""}
          ${runnersUp.length ? `<div class="best-alt">次点: ${runnersUp.map((c) => `${c.car}号車`).join("・")}</div>` : ""}
        </div>
        <button type="button" class="copy-btn" id="copy-memo" data-memo="${esc(memoText(r, state, best))}">予約メモをコピー</button>
      </div>
      ${partial ? `<p class="notice">一部の番線は${esc(train.name)}での喫煙所の号車位置が未確認のため、確認できた番線だけで計算しています。発着番線によっては当てはまりません。</p>` : ""}`;
  }

  return `
    <article class="card">
      <h3>${esc(stationName(state.from))} → ${esc(stationName(state.to))} <small class="walk">${esc(dirLabel)}</small></h3>
      ${headline}
      ${renderTrain(r, train, state, best)}
      ${train.note ? `<p class="walk">${esc(train.note)}</p>` : ""}
    </article>
    <article class="card">
      ${state.before ? renderStationDetail("乗車駅", r.dep, r.train, best) : ""}
      ${state.after ? renderStationDetail("降車駅", r.arr, r.train, best) : ""}
    </article>`;
}

function walkText(carDiff) {
  if (carDiff === 0) return "喫煙所のほぼ目の前";
  const { meters, seconds } = walkEstimate(carDiff);
  const approx = Number.isInteger(carDiff) ? "" : "平均";
  return `${approx}約${meters}m（徒歩約${Math.max(1, Math.round(seconds / 60))}分）`;
}

function renderTrain(r, train, state, best) {
  const candidates = new Set(carsForClass(train, state.seat));
  const green = new Set(train.green);
  const unreserved = new Set(train.unreserved);
  const cars = carList(train);
  const markRow = (profile, enabled, symbol) => {
    const marked = new Set(enabled ? profile.knownGroups.flatMap((g) => g.cars) : []);
    return `<div class="marks" aria-hidden="true">${cars.map((c) => `<span class="mark">${marked.has(c) ? symbol : ""}</span>`).join("")}</div>`;
  };
  const cells = cars.map((c) => {
    const cls = ["car"];
    if (green.has(c)) cls.push("is-green");
    if (unreserved.has(c)) cls.push("is-unreserved");
    if (candidates.has(c)) cls.push("is-candidate");
    if (r.carMatters && best && c === best.car) cls.push("is-best");
    return `<span class="${cls.join(" ")}">${c}</span>`;
  }).join("");

  return `
    <div class="formation" style="--cars:${train.cars}">
      <div class="train-ends"><span>← ${esc(train.ends.down)}</span><span>${esc(train.ends.up)} →</span></div>
      ${markRow(r.dep, state.before, "▼")}
      <div class="train" role="img" aria-label="${train.cars}両編成の号車図。おすすめは${best && r.carMatters ? best.car : "なし"}号車">${cells}</div>
      ${markRow(r.arr, state.after, "▲")}
    </div>
    <div class="legend">
      <span>▼ 乗車駅の喫煙所</span><span>▲ 降車駅の喫煙所</span>
      <span><i class="swatch" style="background:var(--green-car)"></i>グリーン車</span>
      <span><i class="swatch" style="background:var(--unreserved-car)"></i>自由席</span>
    </div>`;
}

function renderStationDetail(label, profile, train, best) {
  const s = profile.station;
  const rooms = s.rooms.filter(
    (room) => room.kind === "concourse" || room.direction === "both" || room.direction === profile.direction,
  );
  let body;
  if (!profile.hasData) {
    body = `<p class="notice">この駅の喫煙所情報はまだありません。情報をお持ちでしたらページ下部から報告してください。</p>`;
  } else {
    body = rooms.map((room) => renderRoom(room, s)).join("");
    if (profile.unknownGroups.length) {
      body += `<p class="notice">${esc(train.name)}での号車位置が未確認の喫煙所があります（${esc(profile.unknownGroups.map((g) => (g.tracks.length ? `${g.tracks.join("・")}番線` : "ホーム")).join("、"))}）。</p>`;
    }
    if (best && profile.knownGroups.length) {
      const hints = nearestRoomCars(profile, best.car).map(
        (n) => {
          const side = deckSide(train, best.car, n.car);
          const how = n.car === best.car ? "ほぼ目の前" : `${side}のデッキから`;
          return `${n.tracks.length ? `${n.tracks.join("・")}番線: ` : ""}${n.car}号車付近の喫煙所 → ${how}`;
        },
      );
      body += `<p class="walk">${hints.map(esc).join("<br>")}</p>`;
      if (profile.knownGroups.length > 1) {
        body += `<p class="walk">発着番線によって喫煙所の位置が変わります。番線は時刻表や駅の案内で確認してください。</p>`;
      }
    }
  }
  return `<section class="station-detail"><h3>${esc(label)}: ${esc(s.name)}</h3>${body}</section>`;
}

function renderRoom(room, station) {
  const badge = `<span class="badge badge-${esc(room.verification)}">${esc(VERIFICATION_LABEL[room.verification])}</span>`;
  let main;
  if (room.kind === "concourse") {
    main = `コンコース: ${esc(room.location)}`;
  } else {
    const where = room.tracks.length ? `${room.tracks.join("・")}番線` : (data.meta.directions[room.direction] ?? "");
    const pos = (car) => (Number.isInteger(car) ? `${car}号車付近` : "号車未確認");
    // 8両編成が停まる山陽・九州新幹線の駅だけ、編成ごとの位置を併記する
    const positions =
      station.line === "tokaido"
        ? pos(room.car)
        : station.line === "kyushu"
          ? `8両 ${pos(room.car8)}`
          : `16両 ${pos(room.car)} ／ 8両 ${pos(room.car8)}`;
    main = `ホーム${where ? ` ${esc(where)}` : ""}: ${esc(positions)}`;
  }
  const sources = room.sources
    .map((id) => data.sources[id])
    .map((src) => `<li><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.publisher)}「${esc(src.title)}」</a></li>`)
    .join("");
  return `
    <div class="room">
      <div class="room-main">${main}${badge}</div>
      ${room.note ? `<div class="room-note">${esc(room.note)}</div>` : ""}
      <ul class="sources">${sources}</ul>
    </div>`;
}

function renderStationList() {
  $("#station-list").innerHTML = Object.entries(LINE_LABEL)
    .map(([line, label]) => {
      const items = data.stations
        .filter((s) => s.line === line)
        .map((s) => {
          const body = s.rooms.length
            ? s.rooms.map((room) => renderRoom(room, s)).join("")
            : `<p class="room-note">情報なし</p>`;
          return `<section class="station-detail"><h3>${esc(s.name)}</h3>${body}</section>`;
        })
        .join("");
      return `<h3 class="line-title">${esc(label)}</h3><div class="card">${items}</div>`;
    })
    .join("");
}

function memoText(r, state, best) {
  const train = data.trains[state.train];
  const seat = form.seat.selectedOptions[0].textContent;
  const lines = [
    `${stationName(state.from)}→${stationName(state.to)} ${train.name} ${seat}`,
    `おすすめ: ${best.car}号車`,
  ];
  if (state.before && r.dep.knownGroups.length) {
    lines.push(`乗車前の喫煙所: ${nearestRoomCars(r.dep, best.car).map((n) => `${n.car}号車付近`).join(" / ")}`);
  }
  if (state.after && r.arr.knownGroups.length) {
    lines.push(`降車後の喫煙所: ${nearestRoomCars(r.arr, best.car).map((n) => `${n.car}号車付近`).join(" / ")}`);
  }
  return lines.join("\n");
}

async function copyMemo(button) {
  try {
    await navigator.clipboard.writeText(button.dataset.memo);
    button.textContent = "コピーしました";
  } catch {
    button.textContent = "コピーできませんでした";
  }
  setTimeout(() => (button.textContent = "予約メモをコピー"), 2000);
}

function stationName(id) {
  return data.stations.find((s) => s.id === id)?.name ?? id;
}
