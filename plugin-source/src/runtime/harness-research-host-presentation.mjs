// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const MAX_XIAOMEI_PRESENTATION_CHARS = 24_000;
const MAX_SPOKEN_CHARS = 600;
const SPOKEN_HEADING = "## 语音回应";

function presentation(text, spokenText, speechStatus) {
  return Object.freeze({ version: 1, text, spokenText, speechStatus });
}

// This is an application text convention, not a provider structured-output API.
// Keep plain historical messages untouched, and never turn malformed speech
// into a truncated but apparently successful answer.
export function parseXiaomeiPresentation(value, {
  complete = false,
  interrupted = false,
  overflow = false,
} = {}) {
  const raw = typeof value === "string" ? value : "";
  const exceeded = overflow || raw.length > MAX_XIAOMEI_PRESENTATION_CHARS;
  const text = raw.slice(0, MAX_XIAOMEI_PRESENTATION_CHARS).replace(/\r\n?/gu, "\n").trimStart();
  if (!text) return null;
  const prefix = SPOKEN_HEADING.startsWith(text.trimEnd());
  const startsSpoken = text.startsWith(SPOKEN_HEADING);
  const containsHeading = /^##[ \t]+(?:语音回应|文字详情)(?:[ \t]*\n|[ \t]*$)/mu.test(text);
  if (!prefix && !startsSpoken && !containsHeading) return null;
  const incompleteStatus = complete || interrupted || exceeded ? "unavailable" : "pending";
  if (prefix) return presentation("", "", incompleteStatus);
  const opening = text.match(/^## 语音回应[ \t]*\n/u);
  if (!opening) return presentation(text.trim(), "", "unavailable");
  const body = text.slice(opening[0].length);
  const separator = /(?:^|\n)## 文字详情[ \t]*\n/u.exec(body);
  if (!separator) return presentation("", "", incompleteStatus);
  const spoken = body.slice(0, separator.index).trim();
  const written = body.slice(separator.index + separator[0].length).trim();
  const malformed = !spoken || Array.from(spoken).length > MAX_SPOKEN_CHARS
    || /^#{1,6}[ \t]/mu.test(spoken)
    || /^##[ \t]+(?:语音回应|文字详情)(?:[ \t]*\n|[ \t]*$)/mu.test(written);
  if (exceeded || interrupted || malformed) return presentation(written, "", "unavailable");
  if (!written) return presentation("", "", incompleteStatus);
  return presentation(written, spoken, "ready");
}

export function createXiaomeiPresentationStream() {
  let text = "";
  let overflow = false;
  return Object.freeze({
    push(delta, options = {}) {
      if (typeof delta === "string") {
        const remaining = MAX_XIAOMEI_PRESENTATION_CHARS - text.length;
        overflow ||= delta.length > remaining;
        text += delta.slice(0, remaining);
      }
      return parseXiaomeiPresentation(text, { ...options, overflow });
    },
    finish(options = {}) {
      return parseXiaomeiPresentation(text, { ...options, complete: true, overflow });
    },
    reset() { text = ""; overflow = false; },
  });
}
