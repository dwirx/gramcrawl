import type { MainMenuAction } from "../api/types";
import type { readManifest } from "../../app/run-store";
import { modeLabel, modeEnvValue } from "./formatter";

export function buildHelpMessage(): string {
  return [
    "TeleExtract Bot - Bantuan",
    "",
    "Perintah utama:",
    "• /extract <url> [maxPages]",
    "  Ekstrak website ke JSON + Markdown + TXT (maxPages 1-30).",
    "• /archive <url> [maxPages]",
    "  Bisa pakai URL biasa atau archive.is/archive.today/archive.ph.",
    "• /scribd <url-scribd>",
    "  Shortcut extract 1 halaman khusus Scribd.",
    "  Bot akan kirim TXT + DOCX + PDF jika konten terbaca.",
    "• /full <url>",
    "  Extract lengkap (MD + TXT + PDF + DOCX) untuk website apa saja.",
    "  (Alias: /pdf, /docx)",
    "• /force <url>",
    "  Shortcut extract 1 halaman dengan memaksa browser fallback (untuk bypass Cloudflare/Captcha).",
    "  (Alias: /bloomberg, /nytimes, /wsj, /medium)",
    "• /lightpanda <url>",
    "  Extract cepat menggunakan engine Lightpanda (high performance).",
    "• /subtitle <url>",
    "  Ambil subtitle YouTube (tombol ⚡ Auto Terbaik + pilih bahasa).",
    "• /mark <url>",
    "  Convert URL ke Markdown via markdown.new.",
    "• /md <url>",
    "  Alias cepat dari /mark.",
    "• /defuddle <url>",
    "  Convert URL ke Markdown via defuddle.md.",
    "• /df <url>",
    "  Alias cepat dari /defuddle.",
    "• /runs [limit]",
    "  Lihat riwayat extract terbaru (limit 1-20).",
    "• /ytdlp <status|version|update>",
    "  Cek versi yt-dlp atau update manual lewat bot.",
    "• /cancel",
    "  Batalkan job aktif (best effort) dan hapus antrian chat ini.",
    "• /stop",
    "  Alias cepat dari /cancel.",
    "• /restart",
    "  Restart proses bot (disarankan jalankan bot via PM2/systemd).",
    "• /stats",
    "  Lihat status bot: queue, cache, memory, rate-limit.",
    "",
    "Pengaturan:",
    "• /subtitletimestamp <on|off|status>",
    "• /timestamp <on|off|status> (alias cepat)",
    "• /browser <on|off|status>",
    "• /clearcache",
    "  Bersihkan cache runtime (extract cache, sesi subtitle, limiter).",
    "• /cleanoutput <all|site>",
    "  Hapus folder output penuh atau per-site.",
    "• /cleandownloads <all|site>",
    "  Bersihkan folder subtitle/download hasil.",
    "• /clearchat [limit]",
    "  Hapus message di chat (best effort, default 20).",
    "",
    "Cookie:",
    "• Upload cookies.txt tanpa command",
    "  Auto import semua domain dari file.",
    "• /cookieimport <domain> (pakai caption saat upload file)",
    "• /cookieset <domain> <cookie-header>",
    "",
    "Tips cepat:",
    "• Kirim URL langsung (atau kalimat yang berisi URL) untuk extract 1 halaman.",
    "• /menu atau /help untuk tampilkan bantuan ini.",
  ].join("\n");
}

export function buildWelcomeMenuMessage(): string {
  return [
    "TeleExtract Bot - Menu Utama",
    "",
    "Pilih aksi dari tombol di bawah:",
    "• Extract artikel website",
    "• Ambil subtitle YouTube",
    "• Lihat riwayat run",
    "• Cek status pengaturan",
    "",
    "Tips: Anda juga bisa kirim URL langsung atau kalimat yang berisi URL untuk extract cepat.",
  ].join("\n");
}

export function buildUnknownCommandMessage(input: string): string {
  return [
    "Perintah tidak dikenali.",
    `Input: ${input}`,
    "",
    "Contoh yang benar:",
    "• /extract https://example.com/artikel 1",
    "• /archive https://archive.is/xxxxx/https://example.com/artikel 1",
    "• /archive https://www.nytimes.com/...?... 1",
    "• /scribd https://www.scribd.com/document/123456789/judul",
    "• /full https://example.com/artikel",
    "• /pdf https://example.com/artikel",
    "• /subtitle https://www.youtube.com/watch?v=xxxx",
    "• /mark https://si.inc/posts/fdm1/",
    "• /md https://si.inc/posts/fdm1/",
    "• /defuddle https://si.inc/posts/fdm1/",
    "• /df https://si.inc/posts/fdm1/",
    "• /runs 5",
    "• /ytdlp status",
    "• /ytdlp update",
    "• /cancel",
    "• /stop",
    "• /restart",
    "• /stats",
    "• /clearcache",
    "• /cleanoutput all",
    "• /cleanoutput example.com",
    "• /cleandownloads all",
    "• /clearchat 30",
    "",
    "Ketik /help atau /menu untuk daftar perintah lengkap.",
  ].join("\n");
}

export function buildMenuActionMessage(action: MainMenuAction): string {
  if (action === "extract") {
    return [
      "Panduan cepat Extract:",
      "• /extract <url> [maxPages]",
      "• Contoh: /extract https://example.com/artikel 1",
      "• /scribd <url-scribd> (khusus Scribd)",
      "",
      "Anda juga bisa kirim URL langsung (atau kalimat berisi URL) tanpa command.",
    ].join("\n");
  }

  if (action === "subtitle") {
    return [
      "Panduan cepat Subtitle:",
      "• /subtitle <url-youtube>",
      "• Contoh: /subtitle https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "",
      "Bot akan menampilkan tombol ⚡ Auto Terbaik + pilihan bahasa subtitle.",
    ].join("\n");
  }

  return "";
}

export function buildRunsMessage(
  runs: Awaited<ReturnType<typeof readManifest>>,
  limit: number,
): string {
  const selectedRuns = runs.slice(0, limit);
  const lines = selectedRuns.map((run, index) =>
    [
      `${index + 1}. ${run.site}`,
      `Run ID: ${run.id}`,
      `Halaman dicrawl: ${run.crawledPages}`,
      `File markdown: ${run.articleFiles}`,
      `URL: ${run.rootUrl}`,
    ].join("\n"),
  );

  return lines.length > 0
    ? [
        `Riwayat extract (${selectedRuns.length}/${runs.length})`,
        "",
        lines.join("\n\n"),
      ].join("\n")
    : "Belum ada history extract.";
}

export function buildSettingsStatusMessage(): string {
  const subtitleTimestampEnabled =
    (process.env.EXTRACT_SUBTITLE_TIMESTAMP ?? "1").trim() === "1";
  const browserFallbackEnabled =
    (process.env.EXTRACT_BROWSER_FALLBACK ?? "0").trim() === "1";
  return [
    "Status pengaturan bot:",
    `• Subtitle timestamp: ${modeLabel(subtitleTimestampEnabled)} (EXTRACT_SUBTITLE_TIMESTAMP=${modeEnvValue(subtitleTimestampEnabled)})`,
    `• Browser fallback: ${modeLabel(browserFallbackEnabled)} (EXTRACT_BROWSER_FALLBACK=${modeEnvValue(browserFallbackEnabled)})`,
  ].join("\n");
}
