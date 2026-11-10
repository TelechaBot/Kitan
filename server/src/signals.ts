import type { Signal, SignalInput } from "./types";

const LINK_PATTERN = /(https?:\/\/|t\.me\/|telegram\.me\/|tg:\/\/|wa\.me\/)/i;
const MENTION_PATTERN = /@[a-zA-Z0-9_]{3,}/g;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function contentHash(text: string): string {
  return Bun.hash(normalize(text)).toString(16);
}

export function detectSignals(input: SignalInput): Signal[] {
  const signals: Signal[] = [];
  if (LINK_PATTERN.test(input.text)) {
    signals.push({ name: "link", weight: 0.6, detail: "message contains a link" });
  }
  if (input.mentions >= 4) {
    signals.push({
      name: "mention",
      weight: 0.5,
      detail: `${input.mentions} mentions in one message`,
    });
  }
  if (input.duplicateCount >= 2) {
    signals.push({
      name: "duplicate",
      weight: 0.7,
      detail: "same content repeated within 10 minutes",
    });
  }
  if (input.recentCount >= 5 || input.shortCount >= 5) {
    signals.push({
      name: "flood",
      weight: 0.6,
      detail: `recent=${input.recentCount} short=${input.shortCount}`,
    });
  }
  if (input.mediaOnly && input.state === "probation") {
    signals.push({
      name: "media_only",
      weight: 0.2,
      detail: "media without text from a new member",
    });
  }
  if (input.external) {
    signals.push({
      name: "external",
      weight: 0.4,
      detail: "forwarded or external reply",
    });
  }
  return signals;
}

export function messageFeatures(message: {
  message_id: number;
  text?: string;
  caption?: string;
  photo?: unknown;
  video?: unknown;
  document?: unknown;
  voice?: unknown;
  video_note?: unknown;
  audio?: unknown;
  animation?: unknown;
  sticker?: unknown;
  external_reply?: unknown;
  forward_origin?: unknown;
}) {
  const text = message.text ?? message.caption ?? "";
  const trimmed = text.trim();
  return {
    text,
    hash: trimmed.length > 0 ? contentHash(text) : `media:${message.message_id}`,
    length: trimmed.length,
    mentions: [...text.matchAll(MENTION_PATTERN)].length,
    mediaOnly:
      Boolean(
        message.photo ||
          message.video ||
          message.document ||
          message.voice ||
          message.video_note ||
          message.audio ||
          message.animation ||
          message.sticker,
      ) && trimmed.length === 0,
    external: Boolean(message.external_reply || message.forward_origin),
  };
}
