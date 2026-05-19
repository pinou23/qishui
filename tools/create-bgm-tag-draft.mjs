import fs from "node:fs";
import path from "node:path";

const inputPath =
  process.argv[2] ||
  "/Users/caopanfeng/Documents/Codex/2026-05-18/new-chat/exports/soda-douyin-favorites.full.json";
const outDir = process.argv[3] || path.join(process.cwd(), "exports");

const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const rows = source.rows || [];

function add(set, values) {
  for (const value of values) {
    if (value) set.add(value);
  }
}

function has(text, pattern) {
  return pattern.test(text);
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

function classify(row) {
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
  add(traits, duration.tags);
  reasons.push(`时长=${duration.bucket}`);

  if (row.media_type === "ugc_clip") {
    add(traits, ["抖音原声", "需试听复核"]);
    add(usage, ["灵感原声库"]);
    reasons.push("类型=抖音原声");
  } else if (row.media_type === "track") {
    add(traits, ["标准曲目"]);
    reasons.push("类型=标准曲目");
  }

  for (const tag of sourceTags) {
    const lower = tag.toLowerCase();
    if (lower.includes("easy listening")) {
      add(mood, ["松弛", "温柔", "治愈"]);
      add(scene, ["城市漫步", "生活空镜"]);
      add(usage, ["口播垫乐", "情绪铺底"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("pop")) {
      add(mood, ["流行", "叙事"]);
      add(scene, ["人物故事", "日常观察"]);
      add(usage, ["情绪铺底", "结尾收束"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("electronic") || lower.includes("dj") || lower.includes("edm")) {
      add(mood, ["动感", "兴奋"]);
      add(scene, ["快剪", "转场"]);
      add(usage, ["卡点", "开头提速"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("hip hop") || lower.includes("rap")) {
      add(mood, ["街头感", "节奏感"]);
      add(scene, ["观点表达", "城市街头"]);
      add(usage, ["节奏铺底", "态度强化"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("rock")) {
      add(mood, ["宣泄", "燃"]);
      add(scene, ["情绪爆发", "转折"]);
      add(usage, ["高潮推进", "反转"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("folk") || lower.includes("chinese style") || lower.includes("tradition")) {
      add(mood, ["怀旧", "人文", "质朴"]);
      add(scene, ["市井生活", "人物故事"]);
      add(usage, ["叙事铺底", "结尾回味"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("classical") || lower.includes("jazz")) {
      add(mood, ["高级感", "克制"]);
      add(scene, ["安静空间", "慢节奏观察"]);
      add(usage, ["氛围铺底", "观点留白"]);
      reasons.push(`汽水曲风=${tag}`);
    }
    if (lower.includes("bgm") || lower.includes("epic")) {
      add(mood, ["戏剧感", "铺垫感"]);
      add(scene, ["故事推进", "结尾升华"]);
      add(usage, ["情绪递进", "大段叙事"]);
      reasons.push(`汽水曲风=${tag}`);
    }
  }

  if (has(text, /氛围|ambient|lofi|piano|钢琴|canon|雨|夜|night|moon|月|海|风|天空|sky|sunset|落日|dream|memory|memories|孤独|想你|温柔|治愈/)) {
    add(mood, ["氛围", "安静", "治愈"]);
    add(scene, ["夜晚街景", "城市漫步", "生活空镜"]);
    add(usage, ["情绪铺底", "结尾留白"]);
    reasons.push("歌名/专辑含氛围关键词");
  }

  if (has(text, /dj|remix|慢摇|phonk|beat|bass|dance|funk|卡点|快节奏/)) {
    add(mood, ["动感", "兴奋"]);
    add(scene, ["快剪", "转场", "开头抓人"]);
    add(usage, ["卡点", "节奏推进"]);
    reasons.push("歌名/曲风含节奏关键词");
  }

  if (has(text, /片尾|电影|电视剧|ost|soundtrack|配乐|插曲|主题曲/)) {
    add(mood, ["影视感", "叙事"]);
    add(scene, ["人物故事", "结尾升华"]);
    add(usage, ["情绪收束", "故事转场"]);
    reasons.push("包含影视/配乐信息");
  }

  if (has(text, /sad|cry|tear|tears|miss|想你|心碎|遗憾|不在|困住|孤单|lonely|alone/)) {
    add(mood, ["失落", "思念", "反思"]);
    add(scene, ["深夜独白", "关系观察"]);
    add(usage, ["情绪铺垫", "结尾回味"]);
    reasons.push("包含低落/思念关键词");
  }

  if (has(text, /happy|smile|good|阳光|快乐|可爱|甜|夏天|青春|少年|旧时光/)) {
    add(mood, ["轻快", "温暖", "怀旧"]);
    add(scene, ["日常观察", "青春回忆"]);
    add(usage, ["开头铺垫", "轻松转场"]);
    reasons.push("包含轻快/怀旧关键词");
  }

  if (has(text, /搞笑|魔性|oops|kung fu|喜剧|funny|meme/)) {
    add(mood, ["荒诞", "幽默"]);
    add(scene, ["反差瞬间", "轻松吐槽"]);
    add(usage, ["反转", "笑点强调"]);
    reasons.push("包含幽默/反差关键词");
  }

  if (mood.size === 0) add(mood, ["待判断"]);
  if (scene.size === 0) add(scene, ["待匹配"]);
  if (usage.size === 0) add(usage, ["待试听"]);

  let score = 0;
  if (sourceTags.length) score += 35;
  if (row.media_type === "track") score += 15;
  if (row.duration_ms) score += 10;
  if (!mood.has("待判断")) score += 20;
  if (!scene.has("待匹配")) score += 10;
  if (row.relation_media) score += 10;
  if (row.media_type === "ugc_clip" && !sourceTags.length) score -= 20;
  score = Math.max(5, Math.min(95, score));

  const review =
    score >= 70
      ? "可先使用"
      : score >= 45
        ? "建议快听复核"
        : "优先试听";

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
    review_status: review,
    confidence: score,
    reason: [...new Set(reasons)].join("; "),
    user_tags: "",
    notes: "",
    rating: "",
    last_used: "",
    use_count: 0,
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

const enriched = rows.map(classify);
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

fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, "bgm-tag-draft.json");
const csvPath = path.join(outDir, "bgm-tag-draft.csv");

fs.writeFileSync(
  jsonPath,
  `${JSON.stringify(
    {
      source: inputPath,
      generated_at: new Date().toISOString(),
      count: enriched.length,
      rows: enriched,
    },
    null,
    2,
  )}\n`,
);

fs.writeFileSync(
  csvPath,
  `${[
    headers.join(","),
    ...enriched.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n")}\n`,
);

const summary = enriched.reduce(
  (acc, row) => {
    acc[row.review_status] = (acc[row.review_status] || 0) + 1;
    return acc;
  },
  {},
);

console.log(
  JSON.stringify(
    {
      count: enriched.length,
      summary,
      csv: csvPath,
      json: jsonPath,
    },
    null,
    2,
  ),
);
