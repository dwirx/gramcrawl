import type { MainMenuAction } from "../api/types";

export function parseMainMenuCallbackData(
  value: string | undefined,
): MainMenuAction | null {
  if (!value || !value.startsWith("menu:")) {
    return null;
  }

  const action = value.slice("menu:".length);
  if (
    action === "extract" ||
    action === "subtitle" ||
    action === "runs" ||
    action === "settings" ||
    action === "help"
  ) {
    return action;
  }

  return null;
}

export function parseSubtitleCallbackData(
  value: string | undefined,
): { sessionId: string; language: string } | null {
  if (!value || !value.startsWith("sub:")) {
    return null;
  }

  const [prefix, sessionId, encodedLanguage] = value.split(":");
  if (prefix !== "sub" || !sessionId || !encodedLanguage) {
    return null;
  }

  try {
    return {
      sessionId,
      language: decodeURIComponent(encodedLanguage),
    };
  } catch {
    return null;
  }
}
