const attr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/,/g, ' ').trim();
const title = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

export function playUrl(baseUrl, id) {
  return `${baseUrl.replace(/\/+$/, '')}/play/${encodeURIComponent(id)}.m3u8`;
}

export function buildM3U(entries, { baseUrl, contentType = 'video', extSize = 'medium', playlistTitle = '' }) {
  const lines = ['#EXTM3U'];
  if (playlistTitle) lines.push(`#PLAYLIST:${title(playlistTitle)}`);
  for (const e of entries) {
    if (extSize) lines.push(`#EXTSIZE:${extSize}`);
    const a = [`tvg-id="${attr(e.id)}"`];
    if (e.logo) a.push(`tvg-logo="${attr(e.logo)}"`);
    a.push(`group-title="${attr(e.category)}"`);
    if (contentType) a.push(`content-type="${contentType}"`);
    lines.push(`#EXTINF:-1 ${a.join(' ')},${title(e.title)}`);
    lines.push(playUrl(baseUrl, e.id));
  }
  return lines.join('\n') + '\n';
}

export function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      const comma = line.lastIndexOf(',');
      cur = { attrs, title: line.slice(comma + 1), url: null };
    } else if (!line.startsWith('#') && cur) {
      cur.url = line;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

export function lintM3U(text) {
  const errors = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines[0] !== '#EXTM3U') errors.push('Primeira linha deve ser #EXTM3U');
  let pending = null;
  let count = 0;
  const urls = new Set();
  lines.forEach((l, i) => {
    if (l.startsWith('#EXTINF:')) {
      if (pending !== null) errors.push(`Linha ${i + 1}: EXTINF sem URL antes`);
      pending = i + 1;
      if (!/,[^,]+$/.test(l)) errors.push(`Linha ${i + 1}: título vazio`);
      if (!/content-type="video"/.test(l)) errors.push(`Linha ${i + 1}: falta content-type="video"`);
      if (!/group-title="[^"]+"/.test(l)) errors.push(`Linha ${i + 1}: falta group-title`);
    } else if (!l.startsWith('#')) {
      if (pending === null) errors.push(`Linha ${i + 1}: URL sem EXTINF`);
      if (!/^https?:\/\/\S+$/.test(l)) errors.push(`Linha ${i + 1}: URL inválida`);
      urls.add(l);
      pending = null;
      count++;
    }
  });
  if (pending !== null) errors.push('Arquivo termina com EXTINF sem URL');
  return { ok: errors.length === 0, errors, count, uniqueUrls: urls.size };
}
