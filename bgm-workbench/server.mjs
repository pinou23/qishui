import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(appDir, "..");
const exportsDir = path.join(workspaceDir, "exports");
const draftPath = path.join(exportsDir, "bgm-tag-draft.json");
const overridesPath = path.join(exportsDir, "bgm-user-overrides.json");
const currentJsonPath = path.join(exportsDir, "bgm-library-current.json");
const currentCsvPath = path.join(exportsDir, "bgm-library-current.csv");
const sodaFavoritesJsonPath = path.join(exportsDir, "soda-douyin-favorites.full.json");
const sodaFavoritesCsvPath = path.join(exportsDir, "soda-douyin-favorites.full.csv");
const sodaCacheDir = path.join(
  process.env.HOME || "",
  "Library/Application Support/SodaMusic/LunaCacheV2",
);
const sodaEntriesDbPath = path.join(sodaCacheDir, "entries.db");
const sodaCookieDbPath = path.join(process.env.HOME || "", "Library/Application Support/SodaMusic/Cookies");
const sodaUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.3.0 Chrome/134.0.6998.179 Electron/35.2.2 Safari/537.36";
const sodaDouyinPlaylistId = process.env.SODA_DOUYIN_PLAYLIST_ID || "7070375826013814797";
const sodaPlaylistEndpoint = "https://api.qishui.com/luna/pc/playlist/detail";
const sodaPlaylistPageSize = 100;
const sodaPlaylistPageDelayMs = 500;
const port = Number(process.env.PORT || process.argv[2] || 4173);
const cacheIndexTtlMs = 15_000;
const playbackSessionTtlMs = 10 * 60 * 1000;
const playbackLinkMinTtlMs = 60_000;
const playbackLinkDefaultTtlMs = 10 * 60 * 1000;
const playbackLinkMaxTtlMs = 45 * 60 * 1000;
let playbackCacheIndex = { loadedAt: 0, trackToFile: new Map(), trackToCache: new Map() };
const playbackSessions = new Map();
const playbackLinkCache = new Map();
let librarySyncInFlight = null;

const editableFields = new Set([
  "user_tags",
  "notes",
  "rating",
  "last_used",
  "use_count",
  "listen_status",
  "favorite",
  "hidden",
]);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function loadDraft() {
  const draft = readJson(draftPath, null);
  if (!draft?.rows?.length) {
    throw new Error(`没有找到标签草稿：${draftPath}`);
  }
  return draft;
}

function emptyDraft() {
  return {
    source: "",
    playlist: {},
    generated_at: "",
    synced_from_soda_at: "",
    count: 0,
    rows: [],
  };
}

function loadDraftOrEmpty() {
  return readJson(draftPath, emptyDraft());
}

function loadOverrides() {
  return readJson(overridesPath, { updated_at: "", tracks: {} });
}

function normalizeOverride(raw = {}) {
  const out = {};
  for (const key of editableFields) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key];
    }
  }
  return out;
}

function compactOverride(raw = {}) {
  const normalized = normalizeOverride(raw);
  const compact = {};
  for (const [key, value] of Object.entries(normalized)) {
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
  return compact;
}

function mergedLibrary() {
  const draft = loadDraftOrEmpty();
  const overrides = loadOverrides();
  const rows = draft.rows.map((row) => {
    const override = normalizeOverride(overrides.tracks[row.track_id]);
    return {
      ...row,
      listen_status: override.listen_status || "待试听",
      favorite: Boolean(override.favorite),
      hidden: Boolean(override.hidden),
      ...override,
      use_count: Number(override.use_count ?? row.use_count ?? 0) || 0,
    };
  });
  return {
    source: draft.source,
    playlist: draft.playlist || {},
    generated_at: draft.generated_at,
    synced_from_soda_at: draft.synced_from_soda_at || draft.generated_at || "",
    overrides_updated_at: overrides.updated_at || "",
    count: rows.length,
    rows,
  };
}

function libraryPayload(sync = null) {
  const library = mergedLibrary();
  const cachedIds = new Set(loadPlaybackCacheIndex().keys());
  const cacheDetails = loadPlaybackCacheDetails();
  const rows = library.rows.map((row) => ({
    ...row,
    playback_cached: cachedIds.has(row.track_id),
    playback_cache_encrypted: Boolean(cacheDetails.get(row.track_id)?.encrypted),
    playback_cache_any: cacheDetails.has(row.track_id),
  }));
  return {
    ...library,
    rows,
    sync,
    playback_cache_count: rows.filter((row) => row.playback_cached).length,
    stats: stats(rows),
    options: {
      mood: uniqueTagValues(rows, "auto_mood"),
      scene: uniqueTagValues(rows, "auto_scene"),
      usage: uniqueTagValues(rows, "auto_usage"),
      traits: uniqueTagValues(rows, "auto_traits"),
    },
  };
}

function findTrack(trackId) {
  return mergedLibrary().rows.find((row) => row.track_id === trackId) || null;
}

function uniqueTagValues(rows, field) {
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
}

function stats(rows) {
  const by = (field) =>
    rows.reduce((acc, row) => {
      const key = row[field] || "未设置";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

  return {
    total: rows.length,
    favorite: rows.filter((row) => row.favorite).length,
    tagged: rows.filter((row) => String(row.user_tags || "").trim()).length,
    notes: rows.filter((row) => String(row.notes || "").trim()).length,
    by_review: by("review_status"),
    by_listen: by("listen_status"),
    by_media: by("media_type"),
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(rows) {
  const headers = [
    "order",
    "track_id",
    "name",
    "artists",
    "album",
    "duration",
    "media_type",
    "source_tags",
    "auto_mood",
    "auto_scene",
    "auto_usage",
    "auto_traits",
    "review_status",
    "confidence",
    "listen_status",
    "favorite",
    "user_tags",
    "notes",
    "rating",
    "last_used",
    "use_count",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function durationText(ms) {
  const value = Number(ms) || 0;
  if (!value) return "";
  const seconds = Math.round(value / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function artistName(artist) {
  return artist?.name || artist?.simple_display_name || artist?.user_info?.nickname || "";
}

function normalizeSodaMedia(media, order) {
  const track =
    media?.entity?.track_wrapper?.track ||
    media?.entity?.track ||
    media?.track ||
    {};
  const artists = Array.isArray(track.artists)
    ? track.artists.map(artistName).filter(Boolean).join(", ")
    : "";
  const tags = Array.isArray(track.tags)
    ? track.tags
        .map((tag) =>
          [tag.first_level_tag?.tag_name, tag.second_level_tag?.tag_name]
            .filter(Boolean)
            .join("/"),
        )
        .filter(Boolean)
        .join("; ")
    : "";

  return {
    order,
    track_id: track.id || media.id || "",
    name: track.name || "",
    sub_name: track.sub_name || "",
    artists,
    album: track.album?.name || "",
    duration: durationText(track.duration),
    duration_ms: track.duration || "",
    media_type: track.media_type || media.type || "",
    relation_media: track.relation_media || "",
    tags,
    source_app_id: media.collect_info?.source_app_id || "",
  };
}

function sodaCsv(rows) {
  const headers = [
    "order",
    "track_id",
    "name",
    "sub_name",
    "artists",
    "album",
    "duration",
    "duration_ms",
    "media_type",
    "relation_media",
    "tags",
    "source_app_id",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function draftCsv(rows) {
  const headers = [
    "order",
    "track_id",
    "name",
    "artists",
    "album",
    "duration",
    "media_type",
    "source_tags",
    "auto_mood",
    "auto_scene",
    "auto_usage",
    "auto_traits",
    "review_status",
    "confidence",
    "reason",
    "user_tags",
    "notes",
    "rating",
    "last_used",
    "use_count",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

async function fetchSodaPlaylistPage(cookieHeader, cursor) {
  const url = new URL(sodaPlaylistEndpoint);
  url.searchParams.set("aid", "386088");
  url.searchParams.set("device_platform", "PC");
  url.searchParams.set("version_code", "3.3.0");
  url.searchParams.set("playlist_id", sodaDouyinPlaylistId);
  url.searchParams.set("cursor", cursor);
  url.searchParams.set("count", String(sodaPlaylistPageSize));

  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: cookieHeader,
      "user-agent": sodaUserAgent,
    },
  });
  if (!response.ok) throw new Error(`汽水歌单接口请求失败：HTTP ${response.status}`);

  const data = await response.json();
  if (data.status_code && data.status_code !== 0) {
    throw new Error(data.status_info?.status_msg || `汽水歌单接口返回错误：${data.status_code}`);
  }
  return data;
}

async function fetchSodaDouyinFavorites() {
  const cookieHeader = readSodaCookieHeader();
  const pages = [];
  let cursor = "";

  for (;;) {
    const page = await fetchSodaPlaylistPage(cookieHeader, cursor);
    pages.push(page);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
    await delay(sodaPlaylistPageDelayMs);
  }

  let order = 0;
  const rows = pages.flatMap((page) =>
    (page.media_resources || []).map((media) => {
      order += 1;
      return normalizeSodaMedia(media, order);
    }),
  );

  return {
    playlist: {
      id: pages[0]?.playlist?.id || sodaDouyinPlaylistId,
      title: pages[0]?.playlist?.title || "抖音收藏的音乐",
      count_tracks: pages[0]?.playlist?.count_tracks || "",
      resource_track_count: pages[0]?.playlist?.resource_cnt?.track_cnt || "",
    },
    exported_at: new Date().toISOString(),
    pages: pages.length,
    count: rows.length,
    rows,
  };
}

function addAll(set, values) {
  for (const value of values) {
    if (value) set.add(value);
  }
}

function splitTags(tags) {
  return String(tags || "")
    .split(/;\s*/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function durationBucket(ms) {
  const value = Number(ms) || 0;
  if (!value) return { bucket: "未知时长", tags: ["需试听确认"] };
  if (value <= 45_000) return { bucket: "45秒内", tags: ["短原声", "适合开头钩子"] };
  if (value <= 90_000) return { bucket: "45-90秒", tags: ["短段落", "适合单段叙事"] };
  if (value <= 180_000) return { bucket: "1.5-3分钟", tags: ["完整段落", "适合口播垫乐"] };
  return { bucket: "3分钟以上", tags: ["完整歌曲", "适合截取高潮"] };
}

function classifySodaRow(row) {
  const text = [
    row.name,
    row.sub_name,
    row.artists,
    row.album,
    row.relation_media,
    row.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const sourceTags = splitTags(row.tags);
  const mood = new Set();
  const scene = new Set();
  const usage = new Set();
  const traits = new Set();
  const reasons = [];

  const duration = durationBucket(row.duration_ms);
  addAll(traits, duration.tags);
  reasons.push(`时长=${duration.bucket}`);

  if (row.media_type === "ugc_clip") {
    addAll(traits, ["抖音原声", "需试听复核"]);
    addAll(usage, ["灵感原声库"]);
    reasons.push("类型=抖音原声");
  } else if (row.media_type === "track") {
    addAll(traits, ["标准曲目"]);
    reasons.push("类型=标准曲目");
  }

  for (const tag of sourceTags) {
    const lower = tag.toLowerCase();
    if (lower.includes("easy listening")) {
      addAll(mood, ["松弛", "温柔", "治愈"]);
      addAll(scene, ["城市漫步", "生活空镜"]);
      addAll(usage, ["口播垫乐", "情绪铺底"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("pop")) {
      addAll(mood, ["流行", "叙事"]);
      addAll(scene, ["人物故事", "日常观察"]);
      addAll(usage, ["情绪铺底", "结尾收束"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("electronic") || lower.includes("dj") || lower.includes("edm")) {
      addAll(mood, ["动感", "兴奋"]);
      addAll(scene, ["快剪", "转场"]);
      addAll(usage, ["卡点", "开头提速"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("hip hop") || lower.includes("rap")) {
      addAll(mood, ["街头感", "节奏感"]);
      addAll(scene, ["观点表达", "城市街头"]);
      addAll(usage, ["节奏铺底", "态度强化"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("rock")) {
      addAll(mood, ["宣泄", "燃"]);
      addAll(scene, ["情绪爆发", "转折"]);
      addAll(usage, ["高潮推进", "反转"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("folk") || lower.includes("chinese style") || lower.includes("tradition")) {
      addAll(mood, ["怀旧", "人文", "质朴"]);
      addAll(scene, ["市井生活", "人物故事"]);
      addAll(usage, ["叙事铺底", "结尾回味"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("classical") || lower.includes("jazz")) {
      addAll(mood, ["高级感", "克制"]);
      addAll(scene, ["安静空间", "慢节奏观察"]);
      addAll(usage, ["氛围铺底", "观点留白"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("bgm") || lower.includes("epic")) {
      addAll(mood, ["戏剧感", "铺垫感"]);
      addAll(scene, ["故事推进", "结尾升华"]);
      addAll(usage, ["情绪递进", "大段叙事"]);
      reasons.push(`汽水曲风=${tag}`);
    }
  }

  if (/氛围|ambient|lofi|piano|钢琴|canon|雨|夜|night|moon|月|海|风|天空|sky|sunset|落日|dream|memory|memories|孤独|想你|温柔|治愈/.test(text)) {
    addAll(mood, ["氛围", "安静", "治愈"]);
    addAll(scene, ["夜晚街景", "城市漫步", "生活空镜"]);
    addAll(usage, ["情绪铺底", "结尾留白"]);
    reasons.push("歌名/专辑含氛围关键词");
  }
  if (/dj|remix|慢摇|phonk|beat|bass|dance|funk|卡点|快节奏/.test(text)) {
    addAll(mood, ["动感", "兴奋"]);
    addAll(scene, ["快剪", "转场", "开头抓人"]);
    addAll(usage, ["卡点", "节奏推进"]);
    reasons.push("歌名/曲风含节奏关键词");
  }
  if (/片尾|电影|电视剧|ost|soundtrack|配乐|插曲|主题曲/.test(text)) {
    addAll(mood, ["影视感", "叙事"]);
    addAll(scene, ["人物故事", "结尾升华"]);
    addAll(usage, ["情绪收束", "故事转场"]);
    reasons.push("包含影视/配乐信息");
  }
  if (/sad|cry|tear|tears|miss|想你|心碎|遗憾|不在|困住|孤单|lonely|alone/.test(text)) {
    addAll(mood, ["失落", "思念", "反思"]);
    addAll(scene, ["深夜独白", "关系观察"]);
    addAll(usage, ["情绪铺垫", "结尾回味"]);
    reasons.push("包含低落/思念关键词");
  }
  if (/happy|smile|good|阳光|快乐|可爱|甜|夏天|青春|少年|旧时光/.test(text)) {
    addAll(mood, ["轻快", "温暖", "怀旧"]);
    addAll(scene, ["日常观察", "青春回忆"]);
    addAll(usage, ["开头铺垫", "轻松转场"]);
    reasons.push("包含轻快/怀旧关键词");
  }
  if (/搞笑|魔性|oops|kung fu|喜剧|funny|meme/.test(text)) {
    addAll(mood, ["荒诞", "幽默"]);
    addAll(scene, ["反差瞬间", "轻松吐槽"]);
    addAll(usage, ["反转", "笑点强调"]);
    reasons.push("包含幽默/反差关键词");
  }

  if (mood.size === 0) addAll(mood, ["待判断"]);
  if (scene.size === 0) addAll(scene, ["待匹配"]);
  if (usage.size === 0) addAll(usage, ["待试听"]);

  let score = 0;
  if (sourceTags.length) score += 35;
  if (row.media_type === "track") score += 15;
  if (row.duration_ms) score += 10;
  if (!mood.has("待判断")) score += 20;
  if (!scene.has("待匹配")) score += 10;
  if (row.relation_media) score += 10;
  if (row.media_type === "ugc_clip" && !sourceTags.length) score -= 20;
  score = Math.max(5, Math.min(95, score));

  return {
    order: row.order,
    track_id: row.track_id,
    name: row.name,
    artists: row.artists,
    album: row.album,
    duration: row.duration,
    duration_ms: row.duration_ms,
    media_type: row.media_type,
    source_tags: row.tags,
    auto_mood: [...mood].join("; "),
    auto_scene: [...scene].join("; "),
    auto_usage: [...usage].join("; "),
    auto_traits: [...traits].join("; "),
    review_status: score >= 70 ? "可先使用" : score >= 45 ? "建议快听复核" : "优先试听",
    confidence: score,
    reason: [...new Set(reasons)].join("; "),
    user_tags: "",
    notes: "",
    rating: "",
    last_used: "",
    use_count: 0,
  };
}

function draftFromSodaExport(source) {
  const rows = (source.rows || []).map(classifySodaRow);
  return {
    source: `soda:playlist:${source.playlist?.id || sodaDouyinPlaylistId}`,
    playlist: source.playlist || {},
    generated_at: new Date().toISOString(),
    synced_from_soda_at: source.exported_at,
    count: rows.length,
    rows,
  };
}

async function syncLibraryFromSoda() {
  if (librarySyncInFlight) return librarySyncInFlight;
  librarySyncInFlight = (async () => {
    const source = await fetchSodaDouyinFavorites();
    const draft = draftFromSodaExport(source);
    writeJson(sodaFavoritesJsonPath, source);
    fs.writeFileSync(sodaFavoritesCsvPath, `${sodaCsv(source.rows)}\n`);
    writeJson(draftPath, draft);
    fs.writeFileSync(path.join(exportsDir, "bgm-tag-draft.csv"), `${draftCsv(draft.rows)}\n`);
    return {
      ok: true,
      playlist_id: source.playlist.id,
      playlist_title: source.playlist.title,
      pages: source.pages,
      count: source.count,
      synced_at: draft.generated_at,
    };
  })();
  try {
    return await librarySyncInFlight;
  } finally {
    librarySyncInFlight = null;
  }
}

async function syncLibraryWithFallback() {
  try {
    return await syncLibraryFromSoda();
  } catch (error) {
    if (!fs.existsSync(draftPath)) throw error;
    return {
      ok: false,
      error: error.message,
      fallback: true,
      synced_at: readJson(draftPath, {})?.generated_at || "",
    };
  }
}

function parseSodaCacheIndex() {
  if (!fs.existsSync(sodaEntriesDbPath)) {
    return { trackToFile: new Map(), trackToCache: new Map() };
  }
  const lines = execFileSync("strings", ["-n", "8", sodaEntriesDbPath], {
    encoding: "utf8",
    maxBuffer: 25 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).split(/\n/);
  const trackToFile = new Map();
  const trackToCache = new Map();
  let currentFile = "";
  let currentLines = [];

  const flush = () => {
    if (!currentFile || !currentLines.length) return;
    const filePath = path.join(sodaCacheDir, currentFile);
    if (!fs.existsSync(filePath)) return;
    const text = currentLines.join("\n");
    const preferred = text.match(/track-(\d{10,})/);
    const fallback = text.match(/\b(\d{16,})\b/);
    const trackId = preferred?.[1] || fallback?.[1] || "";
    if (!trackId) return;

    const cacheInfo = inspectAudioCacheFile(filePath);
    const old = trackToCache.get(trackId);
    if (!old || (!old.playable && cacheInfo.playable)) {
      trackToCache.set(trackId, { ...cacheInfo, filePath });
    }
    if (cacheInfo.playable && !trackToFile.has(trackId)) {
      trackToFile.set(trackId, filePath);
    }
  };

  for (const line of lines) {
    const fileMatch = line.match(/^\$([0-9a-f]{8}-[0-9a-f-]{27,})/i);
    if (fileMatch) {
      flush();
      currentFile = `${fileMatch[1]}.bin`;
      currentLines = [];
      continue;
    }
    if (currentFile) currentLines.push(line);
  }
  flush();
  return { trackToFile, trackToCache };
}

function isPlayableAudioFile(filePath) {
  try {
    execFileSync("afinfo", [filePath], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function isEncryptedAudioCacheFile(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      return ["enca", "cenc", "senc", "tenc"].some((marker) =>
        buffer.includes(Buffer.from(marker, "ascii")),
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function inspectAudioCacheFile(filePath) {
  const stat = fs.statSync(filePath);
  const playable = isPlayableAudioFile(filePath);
  return {
    playable,
    encrypted: !playable && isEncryptedAudioCacheFile(filePath),
    size: stat.size,
  };
}

function loadPlaybackCacheIndex(force = false) {
  const now = Date.now();
  if (!force && now - playbackCacheIndex.loadedAt < cacheIndexTtlMs) {
    return playbackCacheIndex.trackToFile;
  }
  try {
    playbackCacheIndex = { loadedAt: now, ...parseSodaCacheIndex() };
  } catch {
    playbackCacheIndex = { loadedAt: now, trackToFile: new Map(), trackToCache: new Map() };
  }
  return playbackCacheIndex.trackToFile;
}

function loadPlaybackCacheDetails(force = false) {
  loadPlaybackCacheIndex(force);
  return playbackCacheIndex.trackToCache;
}

function cachedPlaybackForTrack(trackId) {
  if (!findTrack(trackId)) return null;
  const trackToFile = loadPlaybackCacheIndex();
  const filePath = trackToFile.get(trackId);
  if (!filePath) return null;
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(sodaCacheDir) || !fs.existsSync(normalized)) return null;
  if (!isPlayableAudioFile(normalized)) return null;
  return normalized;
}

function cacheDetailsForTrack(trackId) {
  if (!findTrack(trackId)) return null;
  const details = loadPlaybackCacheDetails().get(trackId);
  if (!details) return null;
  const normalized = path.normalize(details.filePath);
  if (!normalized.startsWith(sodaCacheDir) || !fs.existsSync(normalized)) return null;
  return { ...details, filePath: normalized };
}

function readSodaCookieHeader() {
  const query =
    "select group_concat(name || '=' || value, '; ') from cookies where host_key='.qishui.com';";
  const cookie = execFileSync("sqlite3", [sodaCookieDbPath, query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!cookie) throw new Error("没有读取到汽水音乐登录态，请先打开汽水音乐并确认已登录");
  return cookie;
}

async function requestTrackV2(track, mediaType) {
  const url = new URL("https://api.qishui.com/luna/pc/track_v2");
  url.searchParams.set("aid", "386088");
  url.searchParams.set("device_platform", "PC");
  url.searchParams.set("version_code", "3.3.0");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      cookie: readSodaCookieHeader(),
      "user-agent": sodaUserAgent,
    },
    body: JSON.stringify({
      media_type: mediaType || track.media_type || "track",
      track_id: track.track_id,
      queue_type: "",
      scene_name: "",
      play_count: { 600: 0, 3600: 0, 86400: 0 },
    }),
  });

  if (!response.ok) throw new Error(`汽水播放接口请求失败：HTTP ${response.status}`);
  const data = await response.json();
  if (data.status_code && data.status_code !== 0) {
    throw new Error(data.status_info?.status_msg || `汽水播放接口返回错误：${data.status_code}`);
  }
  return data;
}

async function fetchTrackV2(track) {
  try {
    return await requestTrackV2(track, track.media_type || "track");
  } catch (error) {
    if (track.media_type === "track") throw error;
    return requestTrackV2(track, "track");
  }
}

async function videoModelFromTrackPlayer(trackPlayer) {
  if (!trackPlayer) throw new Error("汽水播放接口没有返回 track_player");
  if (trackPlayer.video_model) return JSON.parse(trackPlayer.video_model);
  if (!trackPlayer.url_player_info) throw new Error("汽水播放接口没有返回可用播放信息");

  const response = await fetch(trackPlayer.url_player_info, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": sodaUserAgent,
    },
  });
  if (!response.ok) throw new Error(`汽水播放地址解析失败：HTTP ${response.status}`);
  const data = await response.json();
  const playInfoList = data?.Result?.Data?.PlayInfoList || [];
  if (!playInfoList.length) throw new Error("汽水播放地址列表为空");
  return {
    video_list: playInfoList.map((item) => ({
      main_url: item.MainPlayUrl,
      backup_url: item.BackupPlayUrl,
      video_meta: {
        quality: item.Quality || "unknown",
        bitrate: item.Bitrate || 0,
      },
      encrypt_info: item.PlayAuth ? { encrypt: true, spade_a: item.PlayAuth } : undefined,
    })),
  };
}

function normalizePlaybackOption(item) {
  const url = item.main_url || item.MainPlayUrl || "";
  const backupUrl = item.backup_url || item.BackupPlayUrl || "";
  const meta = item.video_meta || {};
  const encryptInfo = item.encrypt_info || {};
  const encrypted = Boolean(encryptInfo.encrypt || encryptInfo.spade_a || item.PlayAuth);
  return {
    url,
    backup_url: backupUrl,
    quality: meta.quality || item.Quality || "unknown",
    bitrate: meta.bitrate || item.Bitrate || 0,
    codec: meta.codec_type || "",
    encrypted,
  };
}

function playbackLinkExpiresAt(videoModel = {}) {
  const now = Date.now();
  const raw = Number(
    videoModel.url_expire ??
      videoModel.UrlExpire ??
      videoModel.urlExpire ??
      videoModel.expire_time ??
      videoModel.ExpireTime ??
      0,
  );
  const parsed = raw > 1_000_000_000_000 ? raw : raw * 1000;
  if (parsed > now + playbackLinkMinTtlMs) {
    return Math.min(parsed, now + playbackLinkMaxTtlMs);
  }
  return now + playbackLinkDefaultTtlMs;
}

function cloneOnlinePlayback(online) {
  return {
    ...online,
    qualities: (online.qualities || []).map((quality) => ({ ...quality })),
  };
}

function purgePlaybackLinkCache() {
  const now = Date.now();
  for (const [trackId, entry] of playbackLinkCache) {
    if (entry.expiresAt - now <= playbackLinkMinTtlMs) {
      playbackLinkCache.delete(trackId);
    }
  }
}

function cachedOnlinePlaybackForTrack(trackId) {
  purgePlaybackLinkCache();
  const entry = playbackLinkCache.get(trackId);
  if (!entry) return null;
  return {
    ...cloneOnlinePlayback(entry.online),
    link_cache_hit: true,
    link_expires_at: new Date(entry.expiresAt).toISOString(),
  };
}

function cacheOnlinePlayback(trackId, online, expiresAt) {
  purgePlaybackLinkCache();
  const entry = {
    expiresAt,
    online: {
      ...cloneOnlinePlayback(online),
      link_cache_hit: false,
      link_expires_at: new Date(expiresAt).toISOString(),
    },
  };
  playbackLinkCache.set(trackId, entry);
  return cloneOnlinePlayback(entry.online);
}

function playbackLinkCacheSnapshot() {
  purgePlaybackLinkCache();
  return [...playbackLinkCache.entries()].map(([trackId, entry]) => ({
    track_id: trackId,
    playable: Boolean(entry.online.playable),
    encrypted: Boolean(entry.online.encrypted),
    quality: entry.online.quality || "",
    expires_at: new Date(entry.expiresAt).toISOString(),
  }));
}

async function onlinePlaybackForTrack(track) {
  const cached = cachedOnlinePlaybackForTrack(track.track_id);
  if (cached) return cached;

  const data = await fetchTrackV2(track);
  const videoModel = await videoModelFromTrackPlayer(data.track_player);
  const options = (videoModel.video_list || [])
    .map(normalizePlaybackOption)
    .filter((item) => item.url || item.backup_url);
  if (!options.length) throw new Error("汽水播放地址列表为空");

  const direct = options.find((item) => !item.encrypted && (item.url || item.backup_url));
  return cacheOnlinePlayback(track.track_id, {
    online: true,
    encrypted: !direct && options.some((item) => item.encrypted),
    playable: Boolean(direct),
    audio_url: direct ? direct.url || direct.backup_url : "",
    quality: direct?.quality || options[0]?.quality || "",
    qualities: options.map(({ quality, bitrate, codec, encrypted }) => ({
      quality,
      bitrate,
      codec,
      encrypted,
    })),
  }, playbackLinkExpiresAt(videoModel));
}

async function playbackForTrack(trackId) {
  const track = findTrack(trackId);
  if (!track) return { status: 404, body: { ok: false, error: "曲库中没有这首歌" } };

  const cachedFile = cachedPlaybackForTrack(trackId);
  const cacheDetails = cacheDetailsForTrack(trackId);
  const cachedAudioUrl = `/api/playback/${encodeURIComponent(trackId)}/audio`;
  try {
    const online = await onlinePlaybackForTrack(track);
    if (online.playable) {
      return {
        status: 200,
        body: {
          ok: true,
          track_id: trackId,
          source: "online",
          cached: Boolean(cachedFile),
          message: online.link_cache_hit
            ? "正在播放已缓存的汽水临时链路"
            : "正在播放汽水在线播放链路",
          ...online,
          audio_url: createPlaybackSession(trackId, online.audio_url),
          proxied: true,
        },
      };
    }
    if (cachedFile) {
      const stat = fs.statSync(cachedFile);
      return {
        status: 200,
        body: {
          ok: true,
          track_id: trackId,
          source: "cache",
          cached: true,
          online: true,
          encrypted: true,
          playable: true,
          size: stat.size,
          audio_url: cachedAudioUrl,
          message: online.link_cache_hit
            ? "已复用汽水加密识别结果，改用本地缓存"
            : "在线播放链路需要汽水播放器解密，已改用本地缓存",
          link_cache_hit: online.link_cache_hit,
          link_expires_at: online.link_expires_at,
          qualities: online.qualities,
        },
      };
    }
    return {
      status: 409,
      body: {
        ok: false,
        track_id: trackId,
        online: true,
        encrypted: true,
        cached: Boolean(cacheDetails),
        cache_encrypted: Boolean(cacheDetails?.encrypted),
        playable: false,
        error: cacheDetails?.encrypted
          ? "汽水本地有缓存，但这个缓存是 CENC 加密 M4A；汽水 App 能解密，普通网页播放器不能直接播放"
          : online.link_cache_hit
            ? "这首歌之前已识别为汽水加密流；普通网页播放器不能直接播放"
            : "已获取在线播放链路，但这首是汽水加密流；普通网页播放器不能直接播放",
        cache_size: cacheDetails?.size || 0,
        link_cache_hit: online.link_cache_hit,
        link_expires_at: online.link_expires_at,
        qualities: online.qualities,
      },
    };
  } catch (error) {
    if (cachedFile) {
      const stat = fs.statSync(cachedFile);
      return {
        status: 200,
        body: {
          ok: true,
          track_id: trackId,
          source: "cache",
          cached: true,
          online: false,
          playable: true,
          size: stat.size,
          audio_url: cachedAudioUrl,
          message: "在线播放链路暂不可用，已改用本地缓存",
          online_error: error.message,
        },
      };
    }
    return {
      status: 502,
      body: {
        ok: false,
        track_id: trackId,
        online: false,
        cached: Boolean(cacheDetails),
        cache_encrypted: Boolean(cacheDetails?.encrypted),
        playable: false,
        error: cacheDetails?.encrypted
          ? `在线播放链路获取失败；汽水本地缓存存在但已加密，网页不能直接播放：${error.message}`
          : `在线播放链路获取失败：${error.message}`,
      },
    };
  }
}

function audioContentType(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
    if (header.subarray(4, 8).toString("ascii") === "ftyp") return "audio/mp4";
    return "application/octet-stream";
  } finally {
    fs.closeSync(fd);
  }
}

function sendAudio(req, res, filePath, headOnly = false) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const type = audioContentType(filePath);
  const range = req.headers.range;

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (!match || start >= total || end < start) {
      res.writeHead(416, { "content-range": `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${total}`,
      "accept-ranges": "bytes",
    });
    if (headOnly) {
      res.end();
      return;
    }
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "content-type": type,
    "content-length": total,
    "accept-ranges": "bytes",
  });
  if (headOnly) {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function purgePlaybackSessions() {
  const now = Date.now();
  for (const [token, session] of playbackSessions) {
    if (now - session.createdAt > playbackSessionTtlMs) playbackSessions.delete(token);
  }
}

function createPlaybackSession(trackId, audioUrl) {
  const parsed = new URL(audioUrl);
  if (!parsed.hostname.endsWith("douyinvod.com")) {
    throw new Error("播放地址不是汽水音频域名");
  }
  purgePlaybackSessions();
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  playbackSessions.set(token, {
    trackId,
    audioUrl,
    createdAt: Date.now(),
  });
  return `/api/playback-session/${encodeURIComponent(token)}/audio`;
}

async function sendRemoteAudio(req, res, session) {
  const audioUrl = typeof session === "string" ? session : session.audioUrl;
  const headers = {
    accept: "*/*",
    "user-agent": sodaUserAgent,
  };
  if (req.headers.range) headers.range = req.headers.range;

  const response = await fetch(audioUrl, { headers });
  if (!response.ok && response.status !== 206) {
    if (session.trackId) playbackLinkCache.delete(session.trackId);
    sendText(res, "Remote audio unavailable", response.status);
    return;
  }

  const outHeaders = {
    "content-type": response.headers.get("content-type") || "audio/mpeg",
    "accept-ranges": response.headers.get("accept-ranges") || "bytes",
  };
  for (const name of ["content-length", "content-range"]) {
    const value = response.headers.get(name);
    if (value) outHeaders[name] = value;
  }
  res.writeHead(response.status, outHeaders);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(res);
}

function persistCurrentLibrary() {
  const library = mergedLibrary();
  writeJson(currentJsonPath, {
    exported_at: new Date().toISOString(),
    count: library.rows.length,
    rows: library.rows,
  });
  fs.writeFileSync(currentCsvPath, `${toCsv(library.rows)}\n`);
  return { json: currentJsonPath, csv: currentCsvPath };
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, text, status = 200, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(appDir, requested));
  if (!filePath.startsWith(appDir)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, "Not found", 404);
      return;
    }
    const ext = path.extname(filePath);
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
      }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/library") {
      sendJson(res, libraryPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sync-library") {
      const sync = await syncLibraryFromSoda();
      sendJson(res, libraryPayload(sync));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/playback-cache") {
      const library = mergedLibrary();
      const cachedIds = new Set(loadPlaybackCacheIndex(true).keys());
      const track_ids = library.rows
        .map((row) => row.track_id)
        .filter((trackId) => cachedIds.has(trackId));
      sendJson(res, { ok: true, count: track_ids.length, track_ids });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/playback-link-cache") {
      const entries = playbackLinkCacheSnapshot();
      sendJson(res, { ok: true, count: entries.length, entries });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/api/playback-session/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const token = decodeURIComponent(parts[2] || "");
      const session = playbackSessions.get(token);
      if (!session || Date.now() - session.createdAt > playbackSessionTtlMs || parts[3] !== "audio") {
        playbackSessions.delete(token);
        sendText(res, "Playback session expired", 404);
        return;
      }
      await sendRemoteAudio(req, res, session);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/api/playback/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const trackId = decodeURIComponent(parts[2] || "");
      if (parts[3] === "audio") {
        const filePath = cachedPlaybackForTrack(trackId);
        if (!filePath) {
          sendJson(res, { ok: false, error: "这首歌还没有可用的汽水本地缓存" }, 404);
          return;
        }
        sendAudio(req, res, filePath, req.method === "HEAD");
        return;
      }
      if (req.method === "HEAD") {
        sendText(res, "Method not allowed", 405);
        return;
      }
      const result = await playbackForTrack(trackId);
      sendJson(res, result.body, result.status);
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/tracks/")) {
      const trackId = decodeURIComponent(url.pathname.replace("/api/tracks/", ""));
      const body = await readBody(req);
      const overrides = loadOverrides();
      const old = normalizeOverride(overrides.tracks[trackId]);
      const next = { ...old };
      for (const key of Object.keys(body)) {
        if (editableFields.has(key)) next[key] = body[key];
      }
      const compact = compactOverride(next);
      const now = new Date().toISOString();
      if (Object.keys(compact).length) {
        compact.updated_at = now;
        overrides.tracks[trackId] = compact;
      } else {
        delete overrides.tracks[trackId];
      }
      overrides.updated_at = Object.keys(overrides.tracks).length ? now : "";
      writeJson(overridesPath, overrides);
      sendJson(res, { ok: true, track_id: trackId, override: overrides.tracks[trackId] || {} });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/export") {
      sendJson(res, { ok: true, ...persistCurrentLibrary() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, { ok: true });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`BGM 工作台已启动：http://127.0.0.1:${port}`);
});
