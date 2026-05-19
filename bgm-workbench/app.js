const state = {
  tracks: [],
  selectedId: "",
  sort: "priority",
  dirty: false,
  serverMode: true,
  syncing: false,
  player: {
    trackId: "",
    audioUrl: "",
    status: "",
    message: "",
  },
  filters: {
    search: "",
    review: "全部",
    listen: "全部",
    media: "全部",
    favorite: false,
    tag: "",
  },
};

const els = {
  libraryMeta: document.querySelector("#libraryMeta"),
  statsRow: document.querySelector("#statsRow"),
  searchInput: document.querySelector("#searchInput"),
  reviewFilter: document.querySelector("#reviewFilter"),
  listenFilter: document.querySelector("#listenFilter"),
  mediaFilter: document.querySelector("#mediaFilter"),
  favoriteFilter: document.querySelector("#favoriteFilter"),
  tagFilters: document.querySelector("#tagFilters"),
  resultCount: document.querySelector("#resultCount"),
  syncLibraryButton: document.querySelector("#syncLibraryButton"),
  trackList: document.querySelector("#trackList"),
  detailPane: document.querySelector("#detailPane"),
  saveButton: document.querySelector("#saveButton"),
  exportButton: document.querySelector("#exportButton"),
  exportOverridesButton: document.querySelector("#exportOverridesButton"),
  importOverridesButton: document.querySelector("#importOverridesButton"),
  importOverridesInput: document.querySelector("#importOverridesInput"),
};

const reviewOrder = {
  "优先试听": 0,
  "建议快听复核": 1,
  "可先使用": 2,
};

const listenOptions = ["待试听", "试听中", "已听", "常用", "不适合"];
const ratingOptions = ["", "1", "2", "3", "4", "5"];
const presetTags = [
  "口播垫乐",
  "城市漫步",
  "夜晚街景",
  "生活空镜",
  "人物故事",
  "情绪收束",
  "开头抓人",
  "转场",
  "卡点",
  "治愈",
  "松弛",
  "孤独感",
  "烟火气",
  "高级感",
  "轻快",
  "反转",
  "怀旧",
  "备用",
];

function splitList(value) {
  return String(value || "")
    .split(/;\s*|,\s*|，\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstItems(value, count = 2) {
  return splitList(value).slice(0, count);
}

function mergeTag(current, tag) {
  const tags = splitList(current);
  if (!tags.includes(tag)) tags.push(tag);
  return tags.join("；");
}

function suggestedTags(track) {
  const fromTrack = [
    ...splitList(track.auto_scene),
    ...splitList(track.auto_usage),
    ...splitList(track.auto_mood),
  ].filter((tag) => !tag.startsWith("待"));
  return [...new Set([...fromTrack, ...presetTags])].slice(0, 20);
}

function textOf(track) {
  return [
    track.name,
    track.artists,
    track.album,
    track.source_tags,
    track.auto_mood,
    track.auto_scene,
    track.auto_usage,
    track.auto_traits,
    track.user_tags,
    track.notes,
  ]
    .join(" ")
    .toLowerCase();
}

function clsForReview(status) {
  if (status === "优先试听") return "rose";
  if (status === "建议快听复核") return "amber";
  return "green";
}

function clsForMedia(type) {
  return type === "ugc_clip" ? "blue" : "teal";
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 1800);
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function setDirty(value) {
  state.dirty = value;
  els.saveButton.textContent = value ? "保存*" : "保存";
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function updateLibraryMeta(library) {
  const parts = [`${library.count || 0} 首`];
  if (library.synced_from_soda_at) {
    parts.push(`汽水同步 ${formatDateTime(library.synced_from_soda_at)}`);
  } else if (library.generated_at) {
    parts.push(`本地库 ${formatDateTime(library.generated_at)}`);
  } else {
    parts.push("未同步汽水");
  }
  parts.push(library.overrides_updated_at ? "已载入人工标注" : "未添加人工标注");
  if (library.sync?.ok) parts.push("刚刚刷新");
  if (!state.serverMode) parts.push("静态模式");
  els.libraryMeta.textContent = parts.join(" · ");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function localOverrides() {
  try {
    return JSON.parse(localStorage.getItem("bgm-user-overrides") || '{"updated_at":"","tracks":{}}');
  } catch {
    return { updated_at: "", tracks: {} };
  }
}

function setLocalOverrides(overrides) {
  localStorage.setItem("bgm-user-overrides", JSON.stringify(overrides));
}

function compactOverrides(overrides) {
  const clean = { updated_at: overrides?.updated_at || "", tracks: {} };
  const tracks = overrides?.tracks || {};
  for (const [trackId, raw] of Object.entries(tracks)) {
    if (!state.tracks.some((track) => track.track_id === trackId)) continue;
    const entry = {};
    for (const key of [
      "user_tags",
      "notes",
      "rating",
      "last_used",
      "use_count",
      "listen_status",
      "favorite",
      "hidden",
    ]) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) entry[key] = raw[key];
    }
    if (Object.keys(entry).length) clean.tracks[trackId] = entry;
  }
  clean.updated_at = Object.keys(clean.tracks).length
    ? clean.updated_at || new Date().toISOString()
    : "";
  return clean;
}

function downloadJson(name, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function saveLocalOverride(trackId, patch) {
  const overrides = localOverrides();
  const old = overrides.tracks[trackId] || {};
  const next = { ...old, ...patch };
  const compact = {};
  for (const [key, value] of Object.entries(next)) {
    if (key === "favorite" || key === "hidden") {
      if (value === true) compact[key] = true;
      continue;
    }
    if (key === "use_count") {
      const count = Number(value) || 0;
      if (count > 0) compact[key] = count;
      continue;
    }
    if (key === "listen_status") {
      if (value && value !== "待试听") compact[key] = value;
      continue;
    }
    if (String(value ?? "").trim()) compact[key] = value;
  }
  if (Object.keys(compact).length) {
    compact.updated_at = new Date().toISOString();
    overrides.tracks[trackId] = compact;
  } else {
    delete overrides.tracks[trackId];
  }
  overrides.updated_at = Object.keys(overrides.tracks).length ? new Date().toISOString() : "";
  setLocalOverrides(overrides);
}

function localLibrary() {
  const draft = window.BGM_TAG_DRAFT;
  if (!draft?.rows?.length) {
    throw new Error("静态数据未加载");
  }
  const overrides = localOverrides();
  const rows = draft.rows.map((row) => {
    const override = overrides.tracks[row.track_id] || {};
    return {
      ...row,
      listen_status: override.listen_status || "待试听",
      favorite: Boolean(override.favorite),
      hidden: Boolean(override.hidden),
      ...override,
      use_count: Number(override.use_count ?? row.use_count ?? 0) || 0,
    };
  });
  const by = (field) =>
    rows.reduce((acc, row) => {
      const key = row[field] || "未设置";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  const uniqueTagValues = (field) => {
    const values = new Map();
    for (const row of rows) {
      for (const value of String(row[field] || "").split(/;\s*/)) {
        const clean = value.trim();
        if (clean && !clean.startsWith("待")) {
          values.set(clean, (values.get(clean) || 0) + 1);
        }
      }
    }
    return [...values.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"))
      .slice(0, 48)
      .map(([name, count]) => ({ name, count }));
  };
  return {
    source: draft.source,
    generated_at: draft.generated_at,
    synced_from_soda_at: draft.synced_from_soda_at || draft.generated_at || "",
    overrides_updated_at: overrides.updated_at || "",
    count: rows.length,
    rows,
    stats: {
      total: rows.length,
      favorite: rows.filter((row) => row.favorite).length,
      tagged: rows.filter((row) => String(row.user_tags || "").trim()).length,
      notes: rows.filter((row) => String(row.notes || "").trim()).length,
      by_review: by("review_status"),
      by_listen: by("listen_status"),
      by_media: by("media_type"),
    },
    options: {
      mood: uniqueTagValues("auto_mood"),
      scene: uniqueTagValues("auto_scene"),
      usage: uniqueTagValues("auto_usage"),
      traits: uniqueTagValues("auto_traits"),
    },
  };
}

function optionList(select, values, current = "全部") {
  select.innerHTML = "";
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    if (value === current) option.selected = true;
    select.appendChild(option);
  }
}

function setupFilters(library) {
  const reviews = ["全部", ...Object.keys(library.stats.by_review)];
  const listens = ["全部", ...listenOptions];
  const media = ["全部", ...Object.keys(library.stats.by_media)];
  optionList(els.reviewFilter, reviews, state.filters.review);
  optionList(els.listenFilter, listens, state.filters.listen);
  optionList(els.mediaFilter, media, state.filters.media);

  const tags = [
    ...library.options.scene.slice(0, 14),
    ...library.options.mood.slice(0, 10),
    ...library.options.usage.slice(0, 10),
  ];
  const seen = new Set();
  els.tagFilters.innerHTML = "";
  const all = document.createElement("button");
  all.className = `chip${state.filters.tag ? "" : " active"}`;
  all.textContent = "全部标签";
  all.addEventListener("click", () => {
    state.filters.tag = "";
    render();
  });
  els.tagFilters.appendChild(all);

  for (const tag of tags) {
    if (seen.has(tag.name)) continue;
    seen.add(tag.name);
    const button = document.createElement("button");
    button.className = `chip${state.filters.tag === tag.name ? " active" : ""}`;
    button.textContent = `${tag.name} ${tag.count}`;
    button.addEventListener("click", () => {
      state.filters.tag = state.filters.tag === tag.name ? "" : tag.name;
      render();
    });
    els.tagFilters.appendChild(button);
  }
}

function renderStats() {
  const total = state.tracks.length;
  const tagged = state.tracks.filter((track) => String(track.user_tags || "").trim()).length;
  const heard = state.tracks.filter((track) => ["已听", "常用", "不适合"].includes(track.listen_status)).length;
  const favorite = state.tracks.filter((track) => track.favorite).length;
  const urgent = state.tracks.filter((track) => track.review_status === "优先试听").length;
  const items = [
    ["总数", total],
    ["已打人工标签", tagged],
    ["已试听", heard],
    ["常用", favorite],
    ["优先试听", urgent],
  ];
  els.statsRow.innerHTML = items
    .map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`)
    .join("");
}

function filteredTracks() {
  let rows = [...state.tracks];
  const search = state.filters.search.trim().toLowerCase();
  if (search) {
    rows = rows.filter((track) => textOf(track).includes(search));
  }
  if (state.filters.review !== "全部") {
    rows = rows.filter((track) => track.review_status === state.filters.review);
  }
  if (state.filters.listen !== "全部") {
    rows = rows.filter((track) => track.listen_status === state.filters.listen);
  }
  if (state.filters.media !== "全部") {
    rows = rows.filter((track) => track.media_type === state.filters.media);
  }
  if (state.filters.favorite) {
    rows = rows.filter((track) => track.favorite);
  }
  if (state.filters.tag) {
    rows = rows.filter((track) =>
      [track.auto_mood, track.auto_scene, track.auto_usage, track.auto_traits, track.user_tags]
        .join("; ")
        .includes(state.filters.tag),
    );
  }

  rows.sort((a, b) => {
    if (state.sort === "order") return a.order - b.order;
    if (state.sort === "confidence") return b.confidence - a.confidence || a.order - b.order;
    return (
      (reviewOrder[a.review_status] ?? 9) - (reviewOrder[b.review_status] ?? 9) ||
      a.confidence - b.confidence ||
      a.order - b.order
    );
  });
  return rows;
}

function trackBadges(track) {
  const badges = [
    `<span class="badge ${clsForReview(track.review_status)}">${track.review_status}</span>`,
    `<span class="badge ${clsForMedia(track.media_type)}">${track.media_type === "ugc_clip" ? "原声" : "曲目"}</span>`,
  ];
  for (const tag of firstItems(track.auto_scene, 2)) {
    badges.push(`<span class="badge">${tag}</span>`);
  }
  for (const tag of firstItems(track.user_tags, 2)) {
    badges.push(`<span class="badge teal">${tag}</span>`);
  }
  if (track.playback_cached) badges.push(`<span class="badge green">有缓存</span>`);
  return badges.join("");
}

function renderTrackList() {
  const rows = filteredTracks();
  els.resultCount.textContent = `${rows.length} 首`;
  if (!state.selectedId && rows[0]) state.selectedId = rows[0].track_id;
  els.trackList.innerHTML = rows
    .map(
      (track) => `
        <button class="track-row ${track.track_id === state.selectedId ? "selected" : ""}" data-id="${track.track_id}">
          <div class="order">#${track.order}</div>
          <div class="track-title">
            <strong title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</strong>
            <span>${escapeHtml(track.artists || track.album || "未知来源")}</span>
          </div>
          <div class="track-tags">${trackBadges(track)}</div>
          <div class="row-status">
            <span>${escapeHtml(track.duration || "未知")}</span>
            <span>${track.favorite ? "常用" : escapeHtml(track.listen_status)}</span>
          </div>
        </button>
      `,
    )
    .join("");

  els.trackList.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      render();
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function selectedTrack() {
  return state.tracks.find((track) => track.track_id === state.selectedId) || null;
}

function segmentGroup(values, current, onSelect, labels = {}) {
  return values
    .map((value) => {
      const text = labels[value] ?? (value || "未评");
      return `<button class="segment ${value === current ? "active" : ""}" data-value="${escapeHtml(value)}">${escapeHtml(text)}</button>`;
    })
    .join("");
}

function tagRow(title, value, tone = "") {
  const tags = splitList(value);
  if (!tags.length) return "";
  return `
    <div>
      <h2>${title}</h2>
      <div class="tag-row">
        ${tags.map((tag) => `<span class="badge ${tone}">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderDetail() {
  const track = selectedTrack();
  if (!track) {
    els.detailPane.innerHTML = `<div class="empty-state">选择一首音乐</div>`;
    return;
  }

  const copyText = [track.name, track.artists].filter(Boolean).join(" ");
  const playerActive = state.player.trackId === track.track_id && state.player.audioUrl;
  const playerMessage =
    state.player.trackId === track.track_id && state.player.message
      ? state.player.message
      : state.serverMode
        ? track.playback_cached
          ? "可在线获取试听链路；有缓存兜底"
          : "可在线获取试听链路"
        : "静态模式不能获取在线播放链路";
  els.detailPane.innerHTML = `
    <div class="detail-head">
      <div class="detail-title" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</div>
      <div class="detail-meta">${escapeHtml(track.artists || track.album || "未知来源")} · ${escapeHtml(track.duration || "未知时长")} · ${escapeHtml(track.media_type)}</div>
      <div class="tag-row">
        <span class="badge ${clsForReview(track.review_status)}">${escapeHtml(track.review_status)}</span>
        <span class="badge ${clsForMedia(track.media_type)}">${track.media_type === "ugc_clip" ? "抖音原声" : "标准曲目"}</span>
        <span class="badge">置信度 ${track.confidence}</span>
      </div>
    </div>

    <section class="detail-section">
      <h2>试听状态</h2>
      <div class="shortcut-hint">快捷键：J/K 上下切换 · P 在线试听 · C 复制检索词 · H 已听并跳下首 · F 常用 · 1-5 评分 · N 下一首待试听</div>
      <div class="segment-row" id="listenSegments">
        ${segmentGroup(listenOptions, track.listen_status, null)}
      </div>
      <div class="player-box">
        <div class="player-actions">
          <button class="secondary-button" id="playTrack" ${state.serverMode ? "" : "disabled"}>
            在线试听
          </button>
          <span>${escapeHtml(playerMessage)}</span>
        </div>
        <audio
          id="playbackAudio"
          controls
          preload="none"
          ${playerActive ? `src="${escapeHtml(state.player.audioUrl)}"` : ""}
          ${playerActive ? "" : "hidden"}
        ></audio>
      </div>
      <div class="copy-row">
        <button class="secondary-button" id="copySearch">复制检索词</button>
        <button class="secondary-button" id="markUsed">记录使用</button>
        <button class="secondary-button" id="favoriteToggle">${track.favorite ? "取消常用" : "设为常用"}</button>
        <button class="secondary-button" id="nextTrack">下一首</button>
      </div>
    </section>

    <section class="detail-section">
      <h2>自动标签</h2>
      ${tagRow("情绪", track.auto_mood, "teal")}
      ${tagRow("场景", track.auto_scene, "blue")}
      ${tagRow("用途", track.auto_usage, "green")}
      ${tagRow("特征", track.auto_traits, "amber")}
      <div class="reason-text">${escapeHtml(track.reason || "")}</div>
    </section>

    <section class="detail-section">
      <h2>快速标签</h2>
      <div class="quick-tags">
        ${suggestedTags(track)
          .map((tag) => {
            const active = splitList(track.user_tags).includes(tag);
            return `<button class="quick-tag ${active ? "active" : ""}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
          })
          .join("")}
      </div>
      <label>
        <span>人工标签</span>
        <input id="userTagsInput" value="${escapeHtml(track.user_tags || "")}" placeholder="生活观察；夜晚街景；口播垫乐" />
      </label>
      <label>
        <span>备注</span>
        <textarea id="notesInput" placeholder="适合哪类视频、从哪里开始用、是否容易抢戏">${escapeHtml(track.notes || "")}</textarea>
      </label>
      <div>
        <h2>评分</h2>
        <div class="segment-row" id="ratingSegments">
          ${segmentGroup(ratingOptions, String(track.rating || ""), null, {
            "": "未评",
            1: "1",
            2: "2",
            3: "3",
            4: "4",
            5: "5",
          })}
        </div>
      </div>
    </section>

    <section class="detail-section">
      <div class="field-row">
        <label>
          <span>最近使用</span>
          <input id="lastUsedInput" type="date" value="${escapeHtml(track.last_used || "")}" />
        </label>
        <label>
          <span>使用次数</span>
          <input id="useCountInput" type="number" min="0" step="1" value="${Number(track.use_count || 0)}" />
        </label>
      </div>
    </section>
  `;

  bindDetailEvents(track, copyText);
}

async function persistTrackPatch(trackId, patch) {
  if (state.serverMode) {
    await api(`/api/tracks/${encodeURIComponent(trackId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  } else {
    saveLocalOverride(trackId, patch);
  }
  setDirty(false);
}

async function startPlayback(trackId) {
  if (!state.serverMode) {
    toast("静态模式不能获取在线播放链路");
    return;
  }
  const track = state.tracks.find((item) => item.track_id === trackId);
  if (!track) {
    toast("没有找到这首歌");
    return;
  }

  state.player = {
    trackId,
    audioUrl: "",
    status: "loading",
    message: "正在获取汽水播放链路",
  };
  renderDetail();

  try {
    updateLocal(trackId, { listen_status: "试听中" });
    await persistTrackPatch(trackId, { listen_status: "试听中" });
    const data = await api(`/api/playback/${encodeURIComponent(trackId)}`);
    state.player = {
      trackId,
      audioUrl: data.audio_url,
      status: "ready",
      message: data.message || (data.source === "online" ? "正在播放汽水在线播放链路" : "正在播放汽水本地缓存"),
    };
    renderDetail();
    requestAnimationFrame(() => {
      const audio = document.querySelector("#playbackAudio");
      audio?.play().catch(() => toast("请手动点击播放器播放"));
    });
  } catch (error) {
    state.player = {
      trackId,
      audioUrl: "",
      status: "error",
      message: error.message || "试听失败",
    };
    renderDetail();
    toast(state.player.message);
  }
}

function bindDetailEvents(track, copyText) {
  document.querySelector("#playTrack")?.addEventListener("click", () => {
    startPlayback(track.track_id);
  });

  document.querySelector("#playbackAudio")?.addEventListener("error", () => {
    toast("音频播放失败；这首可能是汽水加密流或链接已过期");
  });

  document.querySelector("#copySearch").addEventListener("click", async () => {
    await writeClipboard(copyText);
    await patchTrack(track.track_id, { listen_status: "试听中" });
    toast("已复制");
  });

  document.querySelector("#favoriteToggle").addEventListener("click", async () => {
    await patchTrack(track.track_id, {
      favorite: !track.favorite,
      listen_status: !track.favorite ? "常用" : track.listen_status,
    });
  });

  document.querySelector("#markUsed").addEventListener("click", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await patchTrack(track.track_id, {
      last_used: today,
      use_count: Number(track.use_count || 0) + 1,
      listen_status: track.listen_status === "待试听" ? "已听" : track.listen_status,
    });
  });

  document.querySelector("#nextTrack").addEventListener("click", () => {
    selectNeighbor(1);
  });

  document.querySelectorAll(".quick-tag").forEach((button) => {
    button.addEventListener("click", () => {
      patchTrack(track.track_id, {
        user_tags: mergeTag(track.user_tags, button.dataset.tag),
        listen_status: track.listen_status === "待试听" ? "已听" : track.listen_status,
      });
    });
  });

  document.querySelector("#userTagsInput").addEventListener("input", (event) => {
    updateLocal(track.track_id, { user_tags: event.target.value });
    debounceSave(track.track_id, { user_tags: event.target.value });
  });

  document.querySelector("#notesInput").addEventListener("input", (event) => {
    updateLocal(track.track_id, { notes: event.target.value });
    debounceSave(track.track_id, { notes: event.target.value });
  });

  document.querySelector("#lastUsedInput").addEventListener("change", (event) => {
    patchTrack(track.track_id, { last_used: event.target.value });
  });

  document.querySelector("#useCountInput").addEventListener("change", (event) => {
    patchTrack(track.track_id, { use_count: Number(event.target.value || 0) });
  });

  document.querySelectorAll("#listenSegments .segment").forEach((button) => {
    button.addEventListener("click", () => patchTrack(track.track_id, { listen_status: button.dataset.value }));
  });

  document.querySelectorAll("#ratingSegments .segment").forEach((button) => {
    button.addEventListener("click", () => patchTrack(track.track_id, { rating: button.dataset.value }));
  });
}

function selectNeighbor(offset) {
  const rows = filteredTracks();
  if (!rows.length) return;
  const index = rows.findIndex((track) => track.track_id === state.selectedId);
  const nextIndex = Math.max(0, Math.min(rows.length - 1, (index < 0 ? 0 : index) + offset));
  state.selectedId = rows[nextIndex].track_id;
  render();
  requestAnimationFrame(() => {
    document.querySelector(".track-row.selected")?.scrollIntoView({ block: "nearest" });
  });
}

function selectNextUnheard() {
  const rows = filteredTracks();
  const currentIndex = rows.findIndex((track) => track.track_id === state.selectedId);
  const candidates = [...rows.slice(currentIndex + 1), ...rows.slice(0, Math.max(currentIndex, 0))];
  const next = candidates.find((track) => track.listen_status === "待试听") || candidates[0];
  if (!next) return;
  state.selectedId = next.track_id;
  render();
  requestAnimationFrame(() => {
    document.querySelector(".track-row.selected")?.scrollIntoView({ block: "nearest" });
  });
}

function updateLocal(trackId, patch) {
  const track = state.tracks.find((item) => item.track_id === trackId);
  if (!track) return;
  Object.assign(track, patch);
  setDirty(true);
  renderStats();
  renderTrackList();
}

const pending = new Map();
function debounceSave(trackId, patch) {
  const old = pending.get(trackId) || {};
  pending.set(trackId, { ...old, ...patch });
  clearTimeout(debounceSave.timer);
  debounceSave.timer = setTimeout(flushPending, 600);
}

async function flushPending() {
  const entries = [...pending.entries()];
  pending.clear();
  for (const [trackId, patch] of entries) {
    if (state.serverMode) {
      await api(`/api/tracks/${encodeURIComponent(trackId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    } else {
      saveLocalOverride(trackId, patch);
    }
  }
  setDirty(false);
}

async function patchTrack(trackId, patch) {
  updateLocal(trackId, patch);
  if (state.serverMode) {
    await api(`/api/tracks/${encodeURIComponent(trackId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  } else {
    saveLocalOverride(trackId, patch);
  }
  setDirty(false);
  render();
}

function render() {
  renderStats();
  renderTrackList();
  renderDetail();
  setupTagFilterState();
}

function setupTagFilterState() {
  els.tagFilters.querySelectorAll(".chip").forEach((button) => {
    const label = button.textContent.replace(/\s+\d+$/, "");
    const active = label === "全部标签" ? !state.filters.tag : state.filters.tag === label;
    button.classList.toggle("active", active);
  });
}

async function refreshLibraryFromStorage() {
  const library = state.serverMode ? await api("/api/library") : localLibrary();
  applyLibrary(library);
}

function applyLibrary(library) {
  state.tracks = library.rows;
  updateLibraryMeta(library);
  setupFilters(library);
  if (!state.tracks.some((track) => track.track_id === state.selectedId)) {
    state.selectedId = state.tracks[0]?.track_id || "";
  }
  render();
}

async function syncLibraryFromSoda() {
  if (!state.serverMode) {
    toast("请使用本地服务模式同步汽水列表");
    return;
  }
  if (state.syncing) return;

  state.syncing = true;
  els.syncLibraryButton.disabled = true;
  els.syncLibraryButton.textContent = "同步中";
  els.libraryMeta.textContent = "正在从汽水音乐同步抖音收藏";
  try {
    await flushPending();
    const library = await api("/api/sync-library", { method: "POST", body: "{}" });
    applyLibrary(library);
    const skipped = Number(library.sync?.skipped_ugc_clip_count || 0);
    toast(skipped ? `已同步 ${library.count} 首，跳过 ${skipped} 条原声` : `已同步 ${library.count} 首`);
  } catch (error) {
    toast(error.message || "同步失败");
    await refreshLibraryFromStorage();
  } finally {
    state.syncing = false;
    els.syncLibraryButton.disabled = false;
    els.syncLibraryButton.textContent = "同步汽水";
  }
}

async function load() {
  let library;
  try {
    library = await api("/api/library");
    state.serverMode = true;
  } catch {
    library = localLibrary();
    state.serverMode = false;
  }
  bindGlobalEvents();
  applyLibrary(library);
}

function bindGlobalEvents() {
  els.syncLibraryButton.addEventListener("click", syncLibraryFromSoda);

  els.searchInput.addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    render();
  });
  els.reviewFilter.addEventListener("change", (event) => {
    state.filters.review = event.target.value;
    render();
  });
  els.listenFilter.addEventListener("change", (event) => {
    state.filters.listen = event.target.value;
    render();
  });
  els.mediaFilter.addEventListener("change", (event) => {
    state.filters.media = event.target.value;
    render();
  });
  els.favoriteFilter.addEventListener("change", (event) => {
    state.filters.favorite = event.target.checked;
    render();
  });
  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sort = button.dataset.sort;
      document.querySelectorAll("[data-sort]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      render();
    });
  });
  els.saveButton.addEventListener("click", async () => {
    await flushPending();
    toast("已保存");
  });

  els.exportOverridesButton.addEventListener("click", async () => {
    await flushPending();
    const overrides = state.serverMode
      ? state.tracks.reduce(
          (acc, track) => {
            const entry = {};
            for (const key of [
              "user_tags",
              "notes",
              "rating",
              "last_used",
              "use_count",
              "listen_status",
              "favorite",
              "hidden",
            ]) {
              if (
                key === "listen_status"
                  ? track[key] && track[key] !== "待试听"
                  : key === "favorite" || key === "hidden"
                    ? track[key]
                    : String(track[key] ?? "").trim()
              ) {
                entry[key] = track[key];
              }
            }
            if (Object.keys(entry).length) acc.tracks[track.track_id] = entry;
            return acc;
          },
          { updated_at: new Date().toISOString(), tracks: {} },
        )
      : localOverrides();
    downloadJson("bgm-user-overrides.json", compactOverrides(overrides));
    toast("已导出人工标注");
  });

  els.importOverridesButton.addEventListener("click", () => {
    els.importOverridesInput.click();
  });

  els.importOverridesInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      const overrides = compactOverrides(imported);
      if (!Object.keys(overrides.tracks).length) {
        toast("没有可导入的标注");
        return;
      }
      if (state.serverMode) {
        for (const [trackId, patch] of Object.entries(overrides.tracks)) {
          await api(`/api/tracks/${encodeURIComponent(trackId)}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
          });
        }
      } else {
        setLocalOverrides(overrides);
      }
      await refreshLibraryFromStorage();
      toast("已导入人工标注");
    } catch {
      toast("导入失败");
    }
  });

  els.exportButton.addEventListener("click", async () => {
    await flushPending();
    if (state.serverMode) {
      await api("/api/export", { method: "POST", body: "{}" });
      toast("已导出");
    } else {
      downloadJson("bgm-library-current.json", { rows: state.tracks });
      toast("已生成导出文件");
    }
  });

  window.addEventListener("keydown", async (event) => {
    const tagName = event.target?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tagName)) return;
    const track = selectedTrack();
    if (!track) return;

    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      selectNeighbor(1);
      return;
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      selectNeighbor(-1);
      return;
    }
    if (event.key === "n") {
      event.preventDefault();
      selectNextUnheard();
      return;
    }
    if (event.key === "p") {
      event.preventDefault();
      await startPlayback(track.track_id);
      return;
    }
    if (event.key === "h") {
      event.preventDefault();
      await patchTrack(track.track_id, { listen_status: "已听" });
      selectNextUnheard();
      return;
    }
    if (event.key === "f") {
      event.preventDefault();
      await patchTrack(track.track_id, {
        favorite: !track.favorite,
        listen_status: !track.favorite ? "常用" : track.listen_status,
      });
      return;
    }
    if (event.key === "c") {
      event.preventDefault();
      await writeClipboard([track.name, track.artists].filter(Boolean).join(" "));
      await patchTrack(track.track_id, { listen_status: "试听中" });
      toast("已复制");
      return;
    }
    if (/^[1-5]$/.test(event.key)) {
      event.preventDefault();
      await patchTrack(track.track_id, { rating: event.key });
    }
  });
}

load().catch((error) => {
  els.detailPane.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
