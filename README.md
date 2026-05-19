# Qishui BGM Workbench

本项目是一个本地 BGM 曲库整理工作台，用于浏览、筛选、标注和在线试听从汽水音乐同步出的曲目元数据。

## 启动

```bash
node bgm-workbench/server.mjs 4179
```

打开：

```text
http://127.0.0.1:4179
```

## 数据说明

`exports/` 目录包含个人曲库导出和标注数据，默认不会提交到 Git。工作台服务会优先读取本地 `exports/bgm-tag-draft.json` 和 `exports/bgm-user-overrides.json`。

仓库里的 `bgm-workbench/data.js` 是空占位文件，只用于避免提交个人曲库明细。
