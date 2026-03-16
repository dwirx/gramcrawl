# 🤖 TeleExtract

Bot Telegram + CLI untuk ekstraksi konten web, subtitle YouTube, dan workflow cookie anti-bot, dibangun dengan **Bun + TypeScript**.

Proyek ini fokus ke:

- ⚡ Kecepatan eksekusi
- 🧠 Penggunaan memory yang efisien
- 🧩 Alur operasional yang praktis (CLI, API, Telegram)

## ✨ Fitur Utama

- 🌐 **Web Extractor**: ambil konten halaman jadi `JSON`, `Markdown`, `TXT`
- 🧠 **Multi-Engine Parsing**: `Cheerio` (utama) → `JSDOM + Readability` (fallback lokal) → rendered/browser fallback untuk kasus sulit
- 📚 **Mode Scribd**: shortcut ekstraksi 1 halaman + export tambahan
- 🎬 **YouTube Subtitle**: list bahasa subtitle, download, dan konversi
- 🍪 **Cookie Management**: import cookies Netscape/JSON ke `.env`
- 🧪 **Quality Gate Cepat**: `tsgo` + `oxlint` + `oxfmt`
- 🤖 **Telegram Bot**: command interaktif untuk extract/subtitle/runs/settings
- 🧵 **Queue per Chat + Cancel**: job berat diproses berurutan per chat
- ⚡ **Extract Cache**: request URL yang sama bisa dilayani dari cache runtime
- 🚦 **Rate Limit User**: mencegah spam command agar bot tetap stabil
- 🧹 **Remote Cleanup**: bersihkan cache/chat/output langsung dari Telegram
- 🐼 **Lightpanda Support**: engine browser performa tinggi (CDP based) untuk ekstraksi super cepat
- 🛡️ **Auto-Bypass Anti-Bot**: otomatis mencari snapshot **Archive.is** jika halaman utama di-blokir (Cloudflare/CAPTCHA/Paywall)
- 🧠 **Multi-Engine Parsing**: `Cheerio` (utama) → `JSDOM + Readability` (fallback lokal) → rendered/browser fallback → Archive.is fallback

## 🧱 Arsitektur Singkat

- `src/cli.ts`: entrypoint CLI
- `src/telegram-bot.ts`: entrypoint bot Telegram
- `src/telegram/bot.ts`: orchestration command Telegram
- `src/app/extract-service.ts`: pipeline extract + simpan output + manifest
- `src/extractor/*`: crawler + parser konten halaman
- `src/subtitle/service.ts`: integrasi `yt-dlp` untuk subtitle
- `src/app/server.ts`: API server (`Elysia`)

## ✅ Prasyarat

- 🟢 Bun `>=1.3`
- 🟢 Node-compatible environment (untuk toolchain)
- 🟢 Token bot Telegram (jika pakai bot)

## 🚀 Quick Start

### 1) Install dependency

```bash
bun install
```

### 2) Jalankan quality check awal

```bash
bun run check:fast
```

### 3) Jalankan CLI extract

```bash
bun run extract -- https://example.com/article --max-pages 1
```

### 4) Jalankan Telegram bot

```bash
TELEGRAM_BOT_TOKEN=xxxx bun run bot:telegram
```

## 🧰 Daftar Script Penting

| Script                                          | Fungsi                                                        |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `bun run check:fast`                            | Lint + format check cepat                                     |
| `bun run check`                                 | Typecheck + lint + format check (wajib sebelum selesai kerja) |
| `bun run fix`                                   | Auto-fix lint + format                                        |
| `bun run extract -- <url> [--max-pages N]`      | Extract halaman web                                           |
| `bun run scribd -- <url-scribd>`                | Extract cepat Scribd                                          |
| `bun run subtitle -- <youtube-url> [--lang xx]` | Cek/download subtitle                                         |
| `bun run extract:list -- --limit 10`            | Lihat riwayat run                                             |
| `bun run extract:serve -- --port 3000`          | Jalankan API server                                           |
| `bun run bot:telegram`                          | Jalankan bot Telegram                                         |

## 💻 Panduan CLI Lengkap

### Extract umum

```bash
bun run src/cli.ts extract https://example.com/post --max-pages 3 --out output
```

### Extract Scribd (1 halaman)

```bash
bun run src/cli.ts scribd https://www.scribd.com/document/123456789/sample --out output
```

### Scribd browser mode (login/challenge manual)

```bash
bun run src/cli.ts scribd-browser https://www.scribd.com/document/123456789/sample --format pdf --wait-ms 300000
```

### List history run

```bash
bun run src/cli.ts list --limit 20 --out output
```

### Jalankan API

```bash
bun run src/cli.ts serve --port 3000 --out output
```

### Cookie import dari file

```bash
bun run src/cli.ts cookie-import example.com /path/to/cookies.txt --env .env
bun run src/cli.ts cookie-import example.com /path/to/cookies.json --env .env
```

### Cookie set manual

```bash
bun run src/cli.ts cookie-set example.com "cf_clearance=...; __cf_bm=..." --env .env
```

### Subtitle

```bash
bun run src/cli.ts subtitle "https://www.youtube.com/watch?v=xxxx"
bun run src/cli.ts subtitle "https://www.youtube.com/watch?v=xxxx" --lang en
```

## 📲 Command Telegram Bot

- `/start` atau `/menu` → tampilkan menu utama
- `/help` → bantuan lengkap
- `/extract <url> [maxPages]` → extract website
- `/archive <url> [maxPages]` → extract URL biasa atau link archive (archive.is/archive.today/archive.ph)
- `/scribd <url-scribd>` → extract Scribd 1 halaman
- `/bloomberg <url-bloomberg>` → extract Bloomberg 1 halaman (auto browser fallback)
- `/subtitle <url-youtube>` → pilih bahasa subtitle via tombol
- `/mark <url>` atau `/md <url>` → convert URL ke Markdown
- `/runs [limit]` → lihat riwayat run
- `/browser <on|off|status>` → mode browser fallback
- `/subtitletimestamp <on|off|status>` / `/timestamp ...` → mode timestamp subtitle
- `/ytdlp <status|version|update>` → status/update binary `yt-dlp`
- `/cookieimport <domain>` → import cookie dari file upload
- `/cookieset <domain> <cookie-header>` → set cookie manual
- `/cancel` → batalkan job aktif (best effort) + hapus antrian chat
- `/stop` → alias cepat dari `/cancel`
- `/restart` → restart proses bot (butuh PM2/systemd/docker restart policy)
- `/stats` → status runtime (queue/cache/memory/rate-limit)
- `/clearcache` → bersihkan cache runtime bot
- `/cleanoutput <all|site>` → hapus output untuk semua site / site tertentu
- `/cleandownloads <all|site>` → hapus folder subtitle/download hasil
- `/clearchat [limit]` → hapus message chat (best effort, default 20)

Tip:

- Kirim URL langsung tanpa command untuk extract 1 halaman.
- Upload `cookies.txt` tanpa command untuk auto-import multi domain.
- Command `clean*` bersifat destruktif. Gunakan dengan hati-hati.

## 🔐 Konfigurasi Environment

### Wajib (bot)

| Variable             | Fungsi             |
| -------------------- | ------------------ |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram |

### Umum

| Variable                     | Default  | Fungsi                                      |
| ---------------------------- | -------- | ------------------------------------------- |
| `EXTRACT_OUTPUT_ROOT`        | `output` | Root folder output                          |
| `EXTRACT_ENV_PATH`           | `.env`   | Path file env untuk bot                     |
| `EXTRACT_SUBTITLE_TIMESTAMP` | `1`      | Sertakan timestamp subtitle (`0` untuk off) |

### 🤖 Queue, Cache, Rate Limit (Bot)

| Variable                              | Default    | Fungsi                           |
| ------------------------------------- | ---------- | -------------------------------- |
| `EXTRACT_BOT_CACHE_TTL_MS`            | `21600000` | TTL cache extract bot (6 jam)    |
| `EXTRACT_BOT_CACHE_MAX_ENTRIES`       | `200`      | Maks entry cache extract runtime |
| `EXTRACT_BOT_RATE_LIMIT_WINDOW_MS`    | `60000`    | Window rate limit per user       |
| `EXTRACT_BOT_RATE_LIMIT_MAX_REQUESTS` | `8`        | Maks request per user per window |

### Cookie & anti-bot

| Variable                   | Default    | Fungsi                                    |
| -------------------------- | ---------- | ----------------------------------------- |
| `EXTRACT_COOKIE`           | `""`       | Cookie global untuk semua domain          |
| `EXTRACT_COOKIE_MAP`       | `""`       | Cookie per domain (JSON string)           |
| `EXTRACT_BROWSER_FALLBACK` | `0`        | Aktifkan browser fallback                 |
| `EXTRACT_BROWSER_ENGINE`   | `chromium` | Browser engine: `chromium` / `lightpanda` |
| `EXTRACT_BROWSER_FORCE`    | `0`        | Paksa browser fallback sejak awal         |
| `EXTRACT_BROWSER_HEADLESS` | `1`        | `0` untuk mode visible                    |
| `EXTRACT_BROWSER_WAIT_MS`  | `90000`    | Waktu tunggu challenge/CAPTCHA            |

Contoh `EXTRACT_COOKIE_MAP`:

```bash
EXTRACT_COOKIE_MAP='{"example.com":"cf_clearance=...; __cf_bm=..."}'
```

### yt-dlp

| Variable                     | Default     | Fungsi                    |
| ---------------------------- | ----------- | ------------------------- |
| `EXTRACT_YT_DLP_BIN`         | auto-detect | Path binary yt-dlp manual |
| `EXTRACT_YT_DLP_AUTO_UPDATE` | `1`         | Auto-update yt-dlp lokal  |

### 🧠 Optimasi Memory/Retensi Data

| Variable                       | Default | Fungsi                                                  |
| ------------------------------ | ------- | ------------------------------------------------------- |
| `EXTRACT_HISTORY_KEEP_PER_EXT` | `120`   | Maks history per ekstensi (`md/txt/json`) per artikel   |
| `EXTRACT_MAX_GLOBAL_RUNS`      | `800`   | Maks item pada `output/runs-manifest.json`              |
| `EXTRACT_MAX_SITE_RUNS`        | `240`   | Maks item pada `output/sites/<site>/runs-manifest.json` |

## 📁 Struktur Output

```text
output/
└── sites/
    └── <domain>/
        ├── last-extract.json
        ├── latest.json
        ├── runs-manifest.json
        ├── history/
        │   └── <timestamp>__extract.json
        └── <article-slug>/
            ├── latest.md
            ├── latest.txt
            ├── latest.json
            ├── latest.meta.json
            └── history/
                ├── <timestamp>.md
                ├── <timestamp>.txt
                └── <timestamp>.json
```

## ⚙️ Optimasi Performa & Memory yang Sudah Aktif

- 🚦 Pembatasan antrean link crawler agar tidak menumpuk URL berlebih
- 🛡️ **Deteksi Blokir Cerdas**: mengenali halaman "Are you a robot" / Captcha / unusual activity secara real-time
- 🐼 **Lightpanda Integration**: opsi engine browser super cepat tanpa overhead Playwright/Chromium penuh
- ⚡ **Auto-Bypass Archive.is**: otomatis mencoba mengambil konten dari snapshot Archive jika web target memblokir crawler, dilengkapi dengan JSDOM-Readability fallback untuk hasil yang bersih
- 🪶 Response extract bisa mode ringan (`pages` tidak dibawa ke caller)
- 🧵 Queue job per chat agar job berat tidak saling tabrak
- 🛑 Cancel job (best effort) + clear antrian per chat lewat `/cancel`
- ⚡ Cache hasil extract per URL/maxPages (TTL configurable)
- 🚧 Rate limit per user untuk menahan spam request
- 🧹 Cleanup sesi subtitle + batas maksimum sesi aktif
- 🧾 Batas capture output `yt-dlp` supaya buffer stdout/stderr tidak membengkak
- 📄 Reuse browser/page Playwright saat export PDF Scribd batch
- 🗃️ Retensi manifest/history agar ukuran data jangka panjang tetap terkontrol
- 🧼 Cleanup operasional dari Telegram: cache, downloads, output, chat

## 🧪 Quality Gate (Wajib)

Jalankan ini sebelum menganggap pekerjaan selesai:

```bash
bun run check
```

Opsional saat iterasi cepat:

```bash
bun run check:fast
```

Unit test:

```bash
bun test
```

## 🩺 Troubleshooting

### Bot gagal extract situs tertentu

- Pastikan cookie valid (`cf_clearance`, dsb.)
- Aktifkan browser fallback:

```bash
EXTRACT_BROWSER_FALLBACK=1
```

### Playwright Chromium belum terpasang

```bash
bunx playwright install chromium
```

### yt-dlp tidak ditemukan

- Set path manual:

```bash
EXTRACT_YT_DLP_BIN=/path/to/yt-dlp
```

Atau jalankan `/ytdlp update` dari bot.

## 🤝 Catatan Pengembangan

- Gunakan API Bun (`Bun.file`, `Bun.write`, dll.) saat memungkinkan
- Hindari `any`; jaga type-safety
- Ikuti standar lint/format project

---

Dibuat untuk workflow ekstraksi konten yang cepat, praktis, dan stabil. 🚀
