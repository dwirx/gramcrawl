import type {
  TelegramInlineKeyboardMarkup,
  TelegramBotCommand,
} from "../api/types";
import { LANGUAGE_COUNTRY_MAP } from "../constants";

export function buildTelegramCommandSuggestions(): TelegramBotCommand[] {
  return [
    { command: "start", description: "Buka menu utama" },
    {
      command: "extract",
      description: "Extract konten (URL [maxPages] [site])",
    },
    { command: "subtitle", description: "Download subtitle YouTube" },
    { command: "runs", description: "Liat history extraction" },
    { command: "stats", description: "Statistik bot" },
    { command: "cancel", description: "Batalin job yang lagi jalan" },
    { command: "help", description: "Bantuan penggunaan" },
  ];
}

export function buildMainMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📑 Extract Content", callback_data: "menu:extract" },
        { text: "🎬 YouTube Subtitle", callback_data: "menu:subtitle" },
      ],
      [
        { text: "📜 History Runs", callback_data: "menu:runs" },
        { text: "⚙️ Settings", callback_data: "menu:settings" },
      ],
      [{ text: "❓ Bantuan", callback_data: "menu:help" }],
    ],
  };
}

export function buildSubtitleKeyboard(
  sessionId: string,
  languages: string[],
  bestLanguage: string | null,
): TelegramInlineKeyboardMarkup {
  const buttons: Array<{ text: string; callback_data: string }> = [];

  if (bestLanguage) {
    const flag = LANGUAGE_COUNTRY_MAP[bestLanguage]
      ? ` ${getFlagEmoji(LANGUAGE_COUNTRY_MAP[bestLanguage])}`
      : "";
    buttons.push({
      text: `✨ Auto (${bestLanguage.toUpperCase()}${flag})`,
      callback_data: `sub:${sessionId}:__auto__`,
    });
  }

  for (const lang of languages) {
    const flag = LANGUAGE_COUNTRY_MAP[lang]
      ? ` ${getFlagEmoji(LANGUAGE_COUNTRY_MAP[lang])}`
      : "";
    buttons.push({
      text: `${lang.toUpperCase()}${flag}`,
      callback_data: `sub:${sessionId}:${lang}`,
    });
  }

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  return { inline_keyboard: rows };
}

function getFlagEmoji(countryCode: string): string {
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}
