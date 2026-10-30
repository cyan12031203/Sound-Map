export function parseLyrics(original = '', translated = '') {
  const translations = new Map(parseTimedLines(translated).map((line) => [Math.round(line.time * 100), line.text]));
  const timed = parseTimedLines(original).map((line) => ({
    ...line,
    translation: translations.get(Math.round(line.time * 100)) || '',
  }));
  if (timed.length) return timed;
  return original.split(/\r?\n/).map((text) => text.trim()).filter(Boolean)
    .map((text, index) => ({ time: index * 4, text, translation: '' }));
}

export function parseTimedLines(value = '') {
  const entries = [];
  for (const line of value.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = line.replace(/\[[^\]]+\]/g, '').trim();
    if (!matches.length || !text) continue;
    for (const match of matches) {
      const fraction = match[3] ? Number(`0.${match[3].padEnd(3, '0')}`) : 0;
      entries.push({ time: Number(match[1]) * 60 + Number(match[2]) + fraction, text });
    }
  }
  return entries.sort((a, b) => a.time - b.time);
}
