import { LANGUAGE_COUNTRY_MAP } from "../constants";
import type { SubtitleLanguage } from "../../subtitle/service";

export function renderField(label: string, value: string | number): string {
  return `• ${label}: ${String(value)}`;
}

export function buildStatusCard(
  title: string,
  fields: Array<{ label: string; value: string | number }>,
  note?: string,
): string {
  const lines = [
    title,
    ...fields.map((field) => renderField(field.label, field.value)),
  ];
  if (note) {
    lines.push("", note);
  }
  return lines.join("\n");
}

export function countryCodeToFlagEmoji(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return "🌐";
  }
  const codePoints = Array.from(countryCode).map(
    (char) => 127397 + char.charCodeAt(0),
  );
  return String.fromCodePoint(...codePoints);
}

export function languageToCountryCode(languageCode: string): string | null {
  const normalized = languageCode.replaceAll("_", "-");
  const segments = normalized.split("-");
  const maybeRegion = segments.at(-1)?.toUpperCase();

  if (
    maybeRegion &&
    /^[A-Z]{2}$/.test(maybeRegion) &&
    maybeRegion !== segments[0]?.toUpperCase()
  ) {
    return maybeRegion;
  }

  const base = segments[0]?.toLowerCase();
  if (!base) {
    return null;
  }

  return LANGUAGE_COUNTRY_MAP[base] ?? null;
}

export function languageFlagIcon(languageCode: string): string {
  const country = languageToCountryCode(languageCode);
  if (!country) {
    return "🌐";
  }
  return countryCodeToFlagEmoji(country);
}

export function subtitleButtonLabel(language: SubtitleLanguage): string {
  const icon = languageFlagIcon(language.code);
  if (language.hasManual && language.hasAuto) {
    return `${icon} ${language.code} [M+A]`;
  }
  if (language.hasManual) {
    return `${icon} ${language.code} [M]`;
  }
  if (language.hasAuto) {
    return `${icon} ${language.code} [A]`;
  }
  return `${icon} ${language.code}`;
}

export function modeLabel(enabled: boolean): string {
  return enabled ? "AKTIF" : "NONAKTIF";
}

export function modeEnvValue(enabled: boolean): "1" | "0" {
  return enabled ? "1" : "0";
}
