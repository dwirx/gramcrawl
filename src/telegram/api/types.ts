import type { TelegramChatActionLike } from "../runtime-utils";

export type TelegramApiResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
    caption?: string;
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
    };
  };
  callback_query?: {
    id: string;
    from?: { id: number };
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number };
    };
  };
};

export type TelegramMessage = {
  message_id: number;
};

export type TelegramFile = {
  file_path?: string;
  file_size?: number;
};

export type TelegramChatAction = TelegramChatActionLike;

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

export type TelegramBotCommand = {
  command: string;
  description: string;
};

export type MainMenuAction =
  | "extract"
  | "subtitle"
  | "runs"
  | "settings"
  | "help";
