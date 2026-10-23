// Song, sound and photo search through Openverse (https://openverse.org), which indexes Creative Commons media
// from Jamendo, Freesound, ccMixter, Flickr, Wikimedia and others. No account or key needed.
// Results are limited to licenses that allow changes, since editing a clip into a video is a change.

import { fetchJson, fetchBlob } from './net.js';

const API = 'https://api.openverse.org/v1';

const LICENSE_NAMES = { by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC', 'by-nc-sa': 'CC BY-NC-SA', cc0: 'CC0', pdm: 'Public domain', sampling: 'Sampling+', 'nc-sampling': 'NC Sampling+' };
export const licenseName = (l, v) => (LICENSE_NAMES[l] || (l || '').toUpperCase()) + (v && l !== 'cc0' && l !== 'pdm' ? ' ' + v : '');
// Can it be used in a video that makes money?
export const commercialOk = (l) => !/nc/.test(l || '');

const credit = (r) => ({
  title: r.title || 'Untitled',
  creator: r.creator || 'Unknown',
  license: r.license,
  licenseVersion: r.license_version,
  licenseUrl: r.license_url,
  source: r.source,
  url: r.foreign_landing_url || r.url,
  attribution: r.attribution || `"${r.title}" by ${r.creator} (${licenseName(r.license, r.license_version)})`,
});

// Openverse first; when it is slow or down, Internet Archive (music) or Wikimedia Commons (photos) answer instead.
export async function searchAudio(query, opts = {}) {
  try {
    return await searchOpenverseAudio(query, opts);
  } catch (e) {
    const res = await searchArchive(query, opts);
    res.note = 'Openverse is not answering right now, so these come from the Internet Archive.';
    return res;
  }
}

export async function searchPhotos(query, opts = {}) {
  try {
    return await searchOpenversePhotos(query, opts);
  } catch (e) {
    const res = await searchCommons(query, opts);
    res.note = 'Openverse is not answering right now, so these come from Wikimedia Commons.';
    return res;
  }
}

async function searchOpenverseAudio(query, { kind = 'music', page = 1, commercial = false } = {}) {
  const q = new URLSearchParams({ q: query, page_size: '20', page: String(page), license_type: commercial ? 'commercial,modification' : 'modification' });
  // Freesound entries carry no category, so sound effects are picked by source instead.
  if (kind === 'sounds') q.set('source', 'freesound');
  else q.set('category', 'music');
  const data = await fetchJson(`${API}/audio/?${q}`, {}, 15000);
  return {
    total: data.result_count || 0,
    pages: data.page_count || 1,
    results: (data.results || []).filter((r) => r.url).map((r) => ({
      id: r.id,
      kind: 'audio',
      title: r.title || 'Untitled',
      creator: r.creator || 'Unknown',
      duration: r.duration ? r.duration / 1000 : 0,
      url: r.url,
      thumb: r.thumbnail || null,
      license: r.license,
      licenseLabel: licenseName(r.license, r.license_version),
      commercial: commercialOk(r.license),
      genres: r.genres || [],
      credit: credit(r),
    })),
  };
}

async function searchOpenversePhotos(query, { page = 1, shape = '', commercial = false } = {}) {
  const q = new URLSearchParams({ q: query, page_size: '20', page: String(page), license_type: commercial ? 'commercial,modification' : 'modification', mature: 'false' });
  if (shape) q.set('aspect_ratio', shape);
  const data = await fetchJson(`${API}/images/?${q}`, {}, 15000);
  return {
    total: data.result_count || 0,
    pages: data.page_count || 1,
    results: (data.results || []).filter((r) => r.url).map((r) => ({
      id: r.id,
      kind: 'image',
      title: r.title || 'Untitled',
      creator: r.creator || 'Unknown',
      url: r.url,
      // Openverse serves its thumbnails with open CORS, so they always load.
      thumb: `${API}/images/${r.id}/thumb/`,
      width: r.width,
      height: r.height,
      license: r.license,
      licenseLabel: licenseName(r.license, r.license_version),
      commercial: commercialOk(r.license),
      credit: credit(r),
    })),
  };
}

// ---------- Internet Archive ----------

// "http://creativecommons.org/licenses/by-sa/4.0/" -> ['by-sa', '4.0']
function parseLicenseUrl(u) {
  const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/?([\d.]*)/i.exec(u || '');
  if (!m) return ['', ''];
  if (m[1] === 'publicdomain') return [m[2] === 'zero' ? 'cc0' : 'pdm', ''];
  return [m[2].toLowerCase(), m[3]];
}

async function searchArchive(query, { kind = 'music', page = 1, commercial = false } = {}) {
  const words = query.replace(/[()":]/g, ' ').trim();
  const parts = [`(${words})`, 'mediatype:audio', 'format:"VBR MP3"', 'licenseurl:*creativecommons*', 'NOT collection:librivoxaudio'];
  if (kind === 'sounds') parts.push('(subject:"sound effect" OR subject:sfx OR subject:"sound effects")');
  else parts.push('(collection:netlabels OR collection:audio_music OR collection:opensource_audio)');
  if (commercial) parts.push('NOT licenseurl:*nc*');
  else parts.push('NOT licenseurl:*nd*');
  const q = new URLSearchParams({ q: parts.join(' AND '), rows: '20', page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'licenseurl']) q.append('fl[]', f);
  q.append('sort[]', 'downloads desc');
  const data = await fetchJson(`https://archive.org/advancedsearch.php?${q}`);
  const docs = (data.response && data.response.docs) || [];
  return {
    total: (data.response && data.response.numFound) || 0,
    pages: Math.ceil(((data.response && data.response.numFound) || 0) / 20),
    results: docs.map((d) => {
      const [lic, ver] = parseLicenseUrl(d.licenseurl);
      const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator || 'Unknown';
      const title = Array.isArray(d.title) ? d.title[0] : d.title || d.identifier;
      return {
        id: 'ia:' + d.identifier,
        ia: d.identifier,
        kind: 'audio',
        title,
        creator,
        duration: 0,
        url: null,
        license: lic,
        licenseLabel: licenseName(lic, ver),
        commercial: commercialOk(lic),
        credit: { title, creator, license: lic, licenseVersion: ver, licenseUrl: d.licenseurl, source: 'Internet Archive', url: `https://archive.org/details/${d.identifier}`, attribution: `"${title}" by ${creator} is licensed under ${licenseName(lic, ver)}.` },
      };
    }),
  };
}

// Archive items hold several files; pick the first MP3 track.
export async function resolveResult(r) {
  if (r.url || !r.ia) return r;
  const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(r.ia)}`);
  const files = (meta.files || []).filter((f) => /\.mp3$/i.test(f.name) && !/_64kb\.mp3$/i.test(f.name));
  const originals = files.filter((x) => x.source === 'original');
  const byTrack = (a, b) => (parseInt(a.track, 10) || 0) - (parseInt(b.track, 10) || 0) || a.name.localeCompare(b.name);
  const f = (originals.length ? originals : files).sort(byTrack)[0];
  if (!f) throw new Error('This item has no MP3 to download.');
  r.url = `https://archive.org/download/${encodeURIComponent(r.ia)}/${f.name.split('/').map(encodeURIComponent).join('/')}`;
  const len = String(f.length || '');
  r.duration = len.includes(':') ? len.split(':').reduce((s, v) => s * 60 + +v, 0) : +len || 0;
  if (f.title && f.title !== r.title) {
    const album = r.title;
    r.title = f.title;
    r.credit = { ...r.credit, title: f.title, attribution: `"${f.title}" from "${album}" by ${r.creator} is licensed under ${r.licenseLabel}.` };
  }
  return r;
}

// ---------- Wikimedia Commons ----------

const stripHtml = (s) => (s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();

async function searchCommons(query, { page = 1, shape = '' } = {}) {
  const q = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '20', gsroffset: String((page - 1) * 20),
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '640', iiextmetadatafilter: 'LicenseShortName|Artist|ObjectName|LicenseUrl',
  });
  const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?${q}`);
  const pages = Object.values((data.query && data.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  let results = pages.map((pg) => {
    const ii = (pg.imageinfo || [])[0];
    if (!ii) return null;
    const md = ii.extmetadata || {};
    const licShort = (md.LicenseShortName && md.LicenseShortName.value) || '';
    const lic = /cc0|public domain/i.test(licShort) ? 'cc0' : /by-sa/i.test(licShort) ? 'by-sa' : /by/i.test(licShort) ? 'by' : '';
    if (!lic) return null;
    const title = stripHtml(md.ObjectName && md.ObjectName.value) || pg.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
    const creator = stripHtml(md.Artist && md.Artist.value) || 'Unknown';
    return {
      id: 'wm:' + pg.pageid,
      kind: 'image',
      title,
      creator,
      // Commons serves resized copies in fixed widths; they download faster and are rate limited less than originals.
      url: ii.width > 1280 ? ii.thumburl.replace(/\/\d+px-/, `/${ii.width > 1920 ? 1920 : 1280}px-`) : ii.url,
      fallbackUrl: ii.thumburl,
      thumb: ii.thumburl,
      width: ii.width,
      height: ii.height,
      license: lic,
      licenseLabel: licShort || licenseName(lic),
      commercial: true,
      credit: { title, creator, license: lic, licenseUrl: md.LicenseUrl && md.LicenseUrl.value, source: 'Wikimedia Commons', url: ii.descriptionurl, attribution: `"${title}" by ${creator}, ${licShort}, via Wikimedia Commons.` },
    };
  }).filter(Boolean);
  if (shape === 'wide') results = results.filter((r) => r.width > r.height * 1.2);
  else if (shape === 'tall') results = results.filter((r) => r.height > r.width * 1.1);
  else if (shape === 'square') results = results.filter((r) => Math.abs(r.width - r.height) < r.width * 0.15);
  return { total: (data.query && data.query.searchinfo && data.query.searchinfo.totalhits) || results.length, pages: data.continue ? page + 1 : page, results };
}

const extFor = (type, url) => {
  const t = (type || '').split(';')[0];
  const map = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  if (map[t]) return map[t];
  const m = /\.(mp3|ogg|wav|flac|m4a|jpe?g|png|webp|gif)(\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : t.startsWith('image/') ? 'jpg' : 'mp3';
};

// Downloads a result and adds it to the media library with its credit line attached.
export async function importResult(lib, r) {
  await resolveResult(r);
  let blob;
  try {
    blob = await fetchBlob(r.url);
  } catch (e) {
    // Photos have a smaller copy that allows cross-origin downloads (Openverse keeps one on its own server).
    if (r.kind !== 'image') throw e;
    blob = await fetchBlob(r.fallbackUrl || `${API}/images/${r.id}/thumb/?full_size=true&compressed=false`);
  }
  if (!blob.size) throw new Error('The file was empty.');
  let type = blob.type;
  if (!type || type === 'application/octet-stream') type = r.kind === 'image' ? 'image/jpeg' : 'audio/mpeg';
  const safe = (r.title || 'clip').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60).trim();
  const m = await lib.addBlob(new Blob([blob], { type }), `${safe}.${extFor(type, r.url)}`);
  if (!m) throw new Error('The file could not be read.');
  m.credit = r.credit;
  lib.persist(m);
  return m;
}

// Credit lines for every licensed file used on the timeline.
export function projectCredits(project, lib) {
  const used = new Set();
  for (const t of project.tracks) for (const c of t.clips) if (c.mediaId) used.add(c.mediaId);
  const lines = [];
  for (const id of used) {
    const m = lib.get(id);
    if (m && m.credit) lines.push(m.credit.attribution + (m.credit.url ? ` ${m.credit.url}` : ''));
  }
  return lines;
}
