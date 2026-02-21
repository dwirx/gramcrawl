# Bun Template: High-Performance Tooling

Template Bun yang dioptimalkan untuk kecepatan pengembangan maksimal menggunakan ekosistem **Oxc** (`oxlint`, `oxfmt`) dan **tsgo**.

## 🚀 Fitur Utama

- **Runtime:** [Bun](https://bun.sh) - Cepat, all-in-one JavaScript runtime & package manager.
- **Linter Ultra Cepat:** Menggunakan `oxlint` (10-100x lebih cepat dari ESLint).
- **Formatter Kilat:** Menggunakan `oxfmt` (Alternatif Prettier yang sangat cepat).
- **Type-checker Instan:** Menggunakan `tsgo` untuk diagnosa TypeScript tanpa menunggu lama.
- **Struktur Rapi:** Kode sumber berada di dalam folder `src/`.
- **Integrasi VS Code:** Konfigurasi otomatis untuk format dan perbaikan lint saat simpan (Save).

## 🛠 Cara Penggunaan

### 1. Instalasi Dependensi

Gunakan Bun untuk menginstal semua package yang dibutuhkan:

```bash
bun install
```

### 2. Menjalankan Proyek

Untuk menjalankan file utama (`src/index.ts`):

```bash
bun run src/index.ts
```

Untuk mode pengembangan dengan _hot reload_:

```bash
bun --hot src/index.ts
```

### 3. Quality Control (Pemeriksaan Kode)

Template ini memiliki sistem pemeriksaan kualitas yang sudah diatur di `package.json`:

- **Cek Semua:** Jalankan pemeriksaan tipe, lint, dan format sekaligus.
  ```bash
  bun run check
  ```

````
- **Perbaikan Otomatis:** Perbaiki masalah lint dan format secara otomatis.
  ```bash
  bun run fix
````

- **Cek Cepat:** Hanya lint dan format (tanpa type-check) untuk iterasi cepat.
  ```bash
  bun run check:fast
  ```

### 4. CLI Website Extractor

Tool ini sekarang punya mode CLI modular dan history run.

- **Extract halaman**
  ```bash
  bun run extract -- https://example.com/article --max-pages 1
  ```
- **Lihat history extract**
  ```bash
  bun run extract:list -- --limit 10
  ```
- **Jalankan API server (Elysia)**
  ```bash
  bun run extract:serve -- --port 3000
  ```
- **Jalankan Telegram bot**
  ```bash
  TELEGRAM_BOT_TOKEN=xxx bun run bot:telegram
  ```
- **Import cookie browser (format Netscape cookies.txt) ke .env**
  ```bash
  bun run src/cli.ts cookie-import projectmultatuli.org /path/to/cookies.txt
  ```
- **Set cookie manual ke .env**
  ```bash
  bun run src/cli.ts cookie-set projectmultatuli.org "cf_clearance=...; __cf_bm=..."
  ```

Output disimpan per-domain dan per-judul artikel agar rapi:

- `output/sites/<domain>/last-extract.json`
- `output/sites/<domain>/latest.json`
- `output/sites/<domain>/history/<timestamp>__extract.json`
- `output/sites/<domain>/<judul-artikel>/latest.md`
- `output/sites/<domain>/<judul-artikel>/latest.txt`
- `output/sites/<domain>/<judul-artikel>/latest.json`
- `output/sites/<domain>/<judul-artikel>/history/<timestamp>.md`
- `output/sites/<domain>/<judul-artikel>/history/<timestamp>.txt`
- `output/sites/<domain>/<judul-artikel>/history/<timestamp>.json`
- `output/sites/<domain>/runs-manifest.json`
- `output/runs-manifest.json` (gabungan semua situs)

Catatan:

- Folder artikel memakai slug judul artikel.
- File history pakai prefix timestamp (tanggal + jam) supaya urutan otomatis.
- Jika isi artikel tidak berubah, file history tidak ditambah lagi (anti-duplicate).

Command Telegram bot:

- `/extract <url> [maxPages]`
- `/browser <on|off|status>`
- upload `cookies.txt` langsung (tanpa command) untuk auto import domain dari file
- `/cookieimport <domain>` (kirim file `cookies.txt` dan pakai command ini di caption)
- `/cookieset <domain> <cookie-header>`
- `/runs [limit]`
- `/help`

Variabel env tambahan untuk website anti-bot:

- `EXTRACT_COOKIE` untuk cookie global semua domain
- `EXTRACT_COOKIE_MAP` untuk cookie per domain (format JSON string)
  - contoh:
    `EXTRACT_COOKIE_MAP="{\"projectmultatuli.org\":\"cf_clearance=...; __cf_bm=...\"}"`
- `EXTRACT_BROWSER_FALLBACK=1` untuk aktifkan fallback browser session (Playwright)
- `EXTRACT_BROWSER_HEADLESS=0` untuk mode non-headless (agar bisa verifikasi manual)
- `EXTRACT_BROWSER_WAIT_MS=120000` untuk lama tunggu challenge/verification

Jika memakai browser fallback, install browser binary dulu:

```bash
bunx playwright install chromium
```

Saat `/extract` selesai, bot akan mengirim file:

- `extract.json`
- `.md`
- `.txt`

## 📂 Struktur Direktori

- `src/`: Folder utama untuk kode sumber TypeScript.
- `.vscode/`: Konfigurasi editor untuk integrasi tooling otomatis.
- `.oxlintrc.json`: Pengaturan aturan linter.
- `.oxfmtrc.jsonc`: Pengaturan pemformatan kode.
- `SKILL.md`: Panduan teknis penggunaan stack tooling ini.
- `AGENTS.md`: Instruksi khusus untuk asisten AI (LLM).

## 📝 Konvensi Pengembangan

1. **Gunakan Primitif Bun:** Lebih disukai menggunakan API bawaan Bun (`Bun.file`, `Bun.serve`) daripada modul Node.js.
2. **Type Safety:** Hindari penggunaan `any`. Linter akan memberikan peringatan jika ditemukan.
3. **Format Otomatis:** Pastikan editor Anda menggunakan pengaturan yang ada di `.vscode/settings.json` agar kode selalu rapi secara konsisten.

```

```
