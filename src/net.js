// Network helpers. In the desktop app, downloads go through the main process, so files from hosts that don't
// allow cross-origin requests (most music and photo hosts) still work. In a browser they use fetch.

export const desktop = typeof window !== 'undefined' ? window.clipwaveDesktop || null : null;

export async function fetchJson(url, headers = {}, timeoutMs = 20000) {
  if (desktop) {
    const r = await desktop.fetch(url, { headers, timeoutMs });
    if (!r.ok) throw httpError(r.status);
    return JSON.parse(new TextDecoder().decode(r.data));
  }
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(e && e.name === 'TimeoutError' ? 'The search took too long. Check your connection and try again.' : 'Could not reach the search service. Check your connection.');
  }
  if (!res.ok) throw httpError(res.status);
  return res.json();
}

export async function fetchBlob(url, headers = {}) {
  if (desktop) {
    const r = await desktop.fetch(url, { headers });
    if (!r.ok) throw httpError(r.status);
    return new Blob([r.data], { type: r.type || '' });
  }
  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new Error('This host does not allow downloads from a web page. The Clipwave desktop app can download it.');
  }
  if (!res.ok) throw httpError(res.status);
  return res.blob();
}

function httpError(status) {
  if (status === 429) return new Error('Too many searches for now. Wait a minute and try again.');
  if (status === 401 || status === 403) return new Error('The server refused the request (' + status + ').');
  if (status === 404) return new Error('That file is no longer available.');
  return new Error('The download failed (' + status + ').');
}

export function openExternal(url) {
  if (!/^https:\/\//.test(url)) return;
  if (desktop) desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
