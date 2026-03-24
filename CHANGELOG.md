# Changelog

Semua perubahan besar pada project GramCrawl.

## [2026-03-24] - Refactoring & Modularisasi Bot Telegram

### Added
- **Struktur Folder Modular**: Memecah `src/telegram/bot.ts` menjadi modul-modul kecil:
  - `api/`: Klien API Telegram dan tipe data API.
  - `handlers/`: Logika perintah (`extract`, `subtitle`, `mark`, dll).
  - `services/`: Layanan inti (`Queue`, `Cache`, `RateLimit`, `Session`).
  - `ui/`: Komponen antarmuka (`Message`, `Keyboard`, `Formatter`).
- **Queue System**: Implementasi `QueueService` untuk menangani antrian job per-chat secara berurutan tanpa memblokir polling bot.
- **Rate Limiting**: Implementasi `RateLimitService` untuk mencegah spam perintah dari user.
- **Caching**: Implementasi `CacheService` untuk menyimpan hasil ekstraksi sementara guna menghemat resource.
- **YouTube Auth Support**: Dukungan cookies untuk `yt-dlp` via `.env` (`EXTRACT_YT_DLP_COOKIES` atau `EXTRACT_YT_DLP_COOKIES_BROWSER`).
- **File Utils**: Menambahkan `src/telegram/handlers/file-utils.ts` untuk manajemen nama file kiriman yang lebih rapi (slugified title).

### Fixed
- **SyntaxError**: Memperbaiki lokasi import `buildStatusCard` yang salah di beberapa file handler.
- **Type Safety**: Memperbaiki pemanggilan `runExtraction` dan akses properti hasil ekstraksi yang tidak sesuai tipe data.
- **Callback Mismatch**: Memperbaiki prefix `sub:` pada callback subtitle yang sebelumnya tidak dikenali oleh parser.
- **Lightpanda Config**: Menghapus opsi `args` pada `lightpanda.serve` yang tidak didukung.
- **Age Restriction**: Memperbaiki kegagalan download subtitle YouTube pada video yang dibatasi umur dengan integrasi cookies browser.

### Changed
- Migrasi penggunaan `any` ke tipe data `TelegramCommand` yang lebih ketat di semua handler.
- Pembersihan import yang tidak digunakan (*dead code removal*) di seluruh folder `src/telegram`.

### Performance
- Peningkatan stabilitas polling bot dengan penanganan timeout yang lebih baik.
- Reduksi beban CPU/Memory melalui pemisahan logika eksekusi job berat ke dalam antrian asinkron.
