// Multitap's throwaway /dev page. Vanilla JS, no build. Everything shown comes from
// addons, so it's only ever set as text, never as HTML.
/* global document, sessionStorage, fetch, URLSearchParams, HTMLElement, location, crypto,
   TextDecoderStream, AbortController, setTimeout */

const KEY_STORAGE = 'multitap-dev-key';
const $ = (id) => document.getElementById(id);

/** Makes an element: el('li', { className: 'x', onclick }, 'text', child, …). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node[name] = value;
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof HTMLElement ? child : String(child));
  }
  return node;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = message === '';
}

// ---- API ---------------------------------------------------------------------

// Kept in sessionStorage so it survives reloads but not the tab. If storage is
// blocked it lasts until reload.
let key = '';
try {
  key = sessionStorage.getItem(KEY_STORAGE) ?? '';
} catch {
  // Storage blocked.
}

function setKey(value) {
  key = value;
  try {
    if (value === '') sessionStorage.removeItem(KEY_STORAGE);
    else sessionStorage.setItem(KEY_STORAGE, value);
  } catch {
    // Storage blocked.
  }
}

async function api(path, query = {}, { method = 'GET', body } = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== '' && value !== undefined) params.set(name, value);
  }
  const qs = params.toString();
  const headers = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(qs === '' ? path : `${path}?${qs}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const problem = json ?? {};
    const detail = [problem.title, problem.detail].filter(Boolean).join(': ');
    const errors = (problem.errors ?? []).map((e) => `\n  ${e.in} ${e.path}: ${e.message}`);
    throw new Error(`${method} ${path}: ${res.status} ${detail}${errors.join('')}`);
  }
  return json;
}

/** A JSON request with a method: send('POST', path, body). */
const send = (method, path, body) => api(path, {}, { method, body });

/** Runs an async step, showing its error instead of throwing. */
async function step(fn) {
  showError('');
  try {
    await fn();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

const seg = (value) => encodeURIComponent(value);

function addonStatuses(target, addons) {
  target.replaceChildren(
    ...addons.map((a) =>
      el(
        'span',
        { className: `status ${a.status === 'ok' ? 'ok' : 'bad'}` },
        `${a.addonName}: ${a.status}`,
        a.errorCode ? ` (${a.errorCode})` : '',
        ` · ${a.count} items`,
        a.dropped > 0 ? ` · ${a.dropped} dropped` : '',
      ),
    ),
  );
}

// ---- Catalogs ----------------------------------------------------------------

async function loadCatalogs() {
  const catalogs = await api('/v1/catalogs');
  $('catalogs').replaceChildren(
    ...catalogs.map((cat) =>
      el(
        'li',
        {},
        el(
          'button',
          { type: 'button', onclick: () => void step(() => openCatalog(cat)) },
          `${cat.addonName} · ${cat.type} · ${cat.name ?? cat.id}`,
        ),
        cat.extra.length > 0
          ? el(
              'span',
              { className: 'muted' },
              ` [${cat.extra.map((e) => e.name + (e.isRequired ? '*' : '')).join(', ')}]`,
            )
          : null,
      ),
    ),
  );
  if (catalogs.length === 0) {
    $('catalogs').append(el('li', { className: 'muted' }, 'No catalogs. Add addons first.'));
  }
}

// ---- A catalog -----------------------------------------------------------------

let currentCatalog = null;

/** One input per declared extra: a select when the addon lists options. */
function extraInput(extra) {
  const id = `extra-${extra.name}`;
  let input;
  if (extra.options.length > 0) {
    input = el('select', { id }, el('option', { value: '' }, '(any)'));
    for (const option of extra.options) input.append(el('option', { value: option }, option));
  } else {
    input = el('input', {
      id,
      size: extra.name === 'skip' ? 6 : 20,
      type: extra.name === 'skip' ? 'number' : 'text',
    });
  }
  return el('label', {}, `${extra.name}${extra.isRequired ? '*' : ''} `, input);
}

async function openCatalog(cat) {
  currentCatalog = cat;
  $('catalog-section').hidden = false;
  $('catalog-title').textContent =
    `Catalog: ${cat.addonName} · ${cat.type} · ${cat.name ?? cat.id}`;
  $('extras').replaceChildren(
    ...cat.extra.map(extraInput),
    el('button', { type: 'submit' }, 'Load'),
  );
  $('metas').replaceChildren();
  $('catalog-status').replaceChildren();
  // A catalog with a required extra can't load until it's filled in.
  if (!cat.extra.some((e) => e.isRequired)) await loadCatalog();
}

async function loadCatalog() {
  const cat = currentCatalog;
  const query = {};
  for (const extra of cat.extra) query[extra.name] = $(`extra-${extra.name}`).value.trim();
  const page = await api(`/v1/catalog/${seg(cat.addonId)}/${seg(cat.type)}/${seg(cat.id)}`, query);
  addonStatuses($('catalog-status'), [page.addon]);
  $('metas').replaceChildren(
    ...page.metas.map((meta) =>
      el(
        'li',
        {},
        el(
          'button',
          { type: 'button', onclick: () => void step(() => openMeta(meta.type, meta.id)) },
          meta.name,
        ),
        el(
          'span',
          { className: 'muted' },
          ` ${meta.type} · ${meta.id} · ${meta.releaseInfo ?? ''}`,
        ),
      ),
    ),
  );
}

// ---- Meta ----------------------------------------------------------------------------

let currentStreams = null;

async function openMeta(type, id) {
  $('meta-section').hidden = false;
  $('streams-section').hidden = true;
  $('meta-title').textContent = `Meta: ${type} ${id}`;
  $('videos').replaceChildren();
  const result = await api(`/v1/meta/${seg(type)}/${seg(id)}`);
  const meta = result.meta;
  addonStatuses($('meta-status'), result.addons);
  $('meta-title').textContent = `Meta: ${meta.name} (${meta.type} ${meta.id})`;
  $('meta-info').textContent = [
    meta.releaseInfo,
    meta.runtime,
    meta.genres.join(', '),
    meta.imdbRating && `IMDb ${meta.imdbRating}`,
    `from ${result.addonId}`,
  ]
    .filter(Boolean)
    .join(' · ');

  // Episodes (or other videos) each get their own stream list; a movie with no
  // videos is asked for by its own id.
  $('movie-streams').hidden = meta.videos.length > 0;
  $('movie-streams').onclick = () =>
    void step(() =>
      openStreams(meta.type, meta.id, meta.behaviorHints.defaultVideoId ?? meta.id, meta.name),
    );
  $('videos').replaceChildren(
    ...meta.videos.map((video) => {
      const label =
        video.season === undefined
          ? video.title
          : `S${video.season}E${video.episode ?? '?'} ${video.title}`;
      return el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            onclick: () =>
              void step(() => openStreams(meta.type, meta.id, video.id, `${meta.name} ${label}`)),
          },
          label,
        ),
        el('span', { className: 'muted' }, ` ${video.id}`),
      );
    }),
  );
}

// ---- Sources ---------------------------------------------------------------------------

async function openStreams(type, metaId, videoId, label) {
  currentStreams = { type, metaId, videoId };
  $('streams-section').hidden = false;
  $('streams-title').textContent = `Sources: ${label} (${videoId})`;
  await loadStreams();
}

function parsedText(parsed) {
  return Object.entries(parsed)
    .map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(',') : value}`)
    .join(' ');
}

function playableBadges(c) {
  const badges = [
    c.playable
      ? el('span', { className: 'badge playable' }, 'playable')
      : el('span', { className: 'badge unplayable' }, `unplayable: ${c.unplayableReason ?? '?'}`),
  ];
  if (c.playableWhen) {
    badges.push(' ', el('span', { className: 'badge prepared' }, `when ${c.playableWhen}`));
  }
  if (c.requiresEngine)
    badges.push(' ', el('span', { className: 'badge' }, `engine ${c.requiresEngine}`));
  return badges;
}

async function loadStreams() {
  const { type, videoId } = currentStreams;
  $('candidates').tBodies[0].replaceChildren();
  const list = await api(`/v1/streams/${seg(type)}/${seg(videoId)}`, {
    sort: $('sort').value,
    highRes: $('high-res').value,
    engine: $('engine').value.trim(),
  });
  addonStatuses($('streams-status'), list.addons);
  $('streams-status').append(
    el(
      'span',
      { className: 'muted' },
      `engine ${list.engine} · highRes ${list.highRes} · sort ${list.sort} · ${list.candidates.length} candidates`,
    ),
  );
  $('candidates').tBodies[0].replaceChildren(
    ...list.candidates.map((c, i) =>
      el(
        'tr',
        {},
        el('td', {}, i + 1),
        el('td', {}, c.addonName),
        el('td', {}, c.kind),
        el('td', {}, ...playableBadges(c)),
        el('td', {}, c.score),
        el('td', { className: 'title' }, el('strong', {}, c.name), '\n', c.title),
        el('td', { className: 'parsed' }, parsedText(c.parsed)),
        el(
          'td',
          {},
          el(
            'button',
            { type: 'button', onclick: () => void step(() => playSource({ key: c.key })) },
            'Play',
          ),
        ),
      ),
    ),
  );
}

// ---- Player --------------------------------------------------------------------------
//
// A source becomes a playback session (POST /v1/sessions); its progress comes
// from /v1/events, read with fetch because EventSource can't send the API key.
// Once it's ready, each player mints its own media token (one subject each) and
// plays the master playlist from the media listener with hls.js. Media is on
// another origin, so <video> and <track> are crossorigin and MULTITAP_CORS_ORIGINS must
// list this page. Tokens are credentials: they're never shown on the page.

/** From /dev/config.json: { mediaOrigin, mediaPublicBase, corsOrigins }. */
let devConfig = { mediaOrigin: null, mediaPublicBase: false, corsOrigins: [] };
let session = null;
let events = null;
let subtitles = null;

const players = [1, 2].map((n) => ({
  n,
  box: $(`player-${n}`),
  video: $(`video-${n}`),
  subject: $(`subject-${n}`),
  status: $(`player-status-${n}`),
  hls: null,
  token: null,
}));

async function loadDevConfig() {
  const res = await fetch('/dev/config.json');
  if (res.ok) devConfig = await res.json();
  const notes = [];
  if (devConfig.mediaOrigin === null) {
    notes.push(
      'No media origin: set MULTITAP_MEDIA_PUBLIC_BASE, or open this page by a plain hostname.',
    );
  }
  if (!devConfig.corsOrigins.includes(location.origin)) {
    notes.push(
      `MULTITAP_CORS_ORIGINS doesn't include ${location.origin}, so the media listener won't let this ` +
        `page load media. Restart Multitap with MULTITAP_CORS_ORIGINS=${location.origin}.`,
    );
  }
  $('cors-note').textContent = notes.join('\n');
  $('cors-note').hidden = notes.length === 0;
}

let hlsModule = null;
/** hls.js, loaded on first play so the browsing part works without it. */
async function loadHls() {
  hlsModule ??= (await import('/dev/hls.mjs')).default;
  return hlsModule;
}

function logEvent(text) {
  const log = $('event-log');
  log.prepend(el('li', {}, `${new Date().toLocaleTimeString()} ${text}`));
  while (log.children.length > 100) log.lastChild.remove();
}

function showSession(s) {
  const p = s.progress;
  const progress = p
    ? [
        p.phase,
        p.peers !== undefined && `${p.peers} peers`,
        p.downloadSpeed !== undefined && `${Math.round(p.downloadSpeed / 1024)} KiB/s`,
        p.info?.height && `${p.info.height}p ${p.info.codec ?? ''}`.trim(),
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  $('session-status').textContent = [
    s.status,
    s.failureReason && `(${s.failureReason})`,
    s.engineId && `engine ${s.engineId}`,
    progress,
    `epoch ${s.tokenEpoch}`,
    s.quality?.maxHeight && `max ${s.quality.maxHeight}p`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Applies a session read from the API or an event; starts player 1 when it turns ready. */
function applySession(s) {
  session = s;
  showSession(s);
  if (s.status === 'ready' && players[0].token === null) void step(() => startPlayer(players[0]));
  if (s.status === 'released' || s.status === 'failed') {
    for (const p of players) stopPlayer(p, s.status);
  }
}

async function refreshSession() {
  if (session !== null) applySession(await api(`/v1/sessions/${seg(session.id)}`));
}

/** Parses one SSE message block into { id, event, data }; null for a comment. */
function parseSse(block) {
  const message = { id: undefined, event: 'message', data: [] };
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') message.id = value;
    else if (field === 'event') message.event = value;
    else if (field === 'data') message.data.push(value);
  }
  return message.data.length === 0 ? null : { ...message, data: message.data.join('\n') };
}

function onEvent(event) {
  const d = event.data;
  if (session === null || d.sessionId !== session.id) return;
  switch (event.type) {
    case 'session.status':
      logEvent(`session.status ${d.status}${d.progress ? ` ${d.progress.phase}` : ''}`);
      applySession({ ...session, status: d.status, progress: d.progress ?? session.progress });
      break;
    case 'session.ready':
      logEvent('session.ready');
      applySession(d.session);
      break;
    case 'session.failed':
      logEvent(`session.failed ${d.reason}${d.attempts ? ` after ${d.attempts} attempts` : ''}`);
      applySession({ ...session, status: 'failed', failureReason: d.reason });
      break;
    case 'session.released':
      logEvent(`session.released ${d.reason}`);
      applySession({ ...session, status: 'released' });
      break;
    default:
      logEvent(event.type);
  }
}

/** Follows /v1/events?session= until aborted, reconnecting with Last-Event-ID. */
async function followEvents(sessionId, signal) {
  let lastId;
  while (!signal.aborted) {
    try {
      const headers = { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' };
      if (lastId !== undefined) headers['Last-Event-ID'] = lastId;
      const res = await fetch(`/v1/events?session=${seg(sessionId)}`, { headers, signal });
      if (!res.ok || res.body === null) throw new Error(`/v1/events: ${res.status}`);
      // A reconnect that lost events re-reads the session (okf:architecture/core-events-sse).
      if (res.headers.get('X-Events-Replay') === 'partial') await refreshSession();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + value).replace(/\r\n?/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const message = parseSse(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (message === null) continue;
          if (message.id !== undefined) lastId = message.id;
          onEvent(JSON.parse(message.data));
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      logEvent(`events: ${err instanceof Error ? err.message : String(err)}; reconnecting`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function stopEvents() {
  events?.abort();
  events = null;
}

/** Creates a session for the current source list's item and follows it. */
async function playSource(source) {
  // One session at a time: release the last one, ignoring failure (retention
  // collects it anyway).
  if (session !== null && session.status !== 'released') {
    await send('DELETE', `/v1/sessions/${seg(session.id)}`).catch(() => null);
  }
  stopEvents();
  for (const p of players) stopPlayer(p, '');
  session = null;
  subtitles = null;
  $('event-log').replaceChildren();
  $('viewers').replaceChildren();

  const { type, metaId, videoId } = currentStreams;
  const body = {
    item: videoId === metaId ? { type, id: metaId } : { type, id: metaId, videoId },
    source,
  };
  const engine = $('engine').value.trim();
  if (engine !== '') body.engine = engine;
  if ($('high-res').value !== '') body.highRes = $('high-res').value;
  const maxHeight = Number.parseInt($('max-height').value, 10);
  if (Number.isInteger(maxHeight)) body.quality = { maxHeight };

  $('player-section').hidden = false;
  const created = await send('POST', '/v1/sessions', body);
  $('session-id').textContent = created.id;
  logEvent(`created ${created.id} (${'key' in source ? 'picked source' : 'auto-select'})`);
  session = created;
  events = new AbortController();
  void followEvents(created.id, events.signal);
  // The session may have moved on before the event stream opened.
  await refreshSession();
}

function stopPlayer(p, why) {
  p.hls?.destroy();
  p.hls = null;
  p.token = null;
  p.video.querySelectorAll('track').forEach((track) => track.remove());
  p.video.removeAttribute('src');
  p.video.load();
  p.subject.textContent = '';
  if (why !== undefined) p.status.textContent = why;
}

async function sessionSubtitles() {
  subtitles ??= (await api(`/v1/sessions/${seg(session.id)}/subtitles`)).subtitles;
  return subtitles;
}

/** Mints a token under a fresh subject (a revoked one can't be reused) and plays it. */
async function startPlayer(p) {
  if (session === null) throw new Error('No session.');
  stopPlayer(p, 'minting a token…');
  const subject = `dev-${p.n}-${crypto.randomUUID().slice(0, 8)}`;
  const token = await send('POST', `/v1/sessions/${seg(session.id)}/tokens`, { subject });
  const src =
    token.mediaUrl ??
    (devConfig.mediaOrigin === null ? null : `${devConfig.mediaOrigin}${token.mediaPath}`);
  if (src === null) throw new Error('No media origin: set MULTITAP_MEDIA_PUBLIC_BASE.');
  p.token = token;
  p.subject.textContent = `${subject}, expires ${new Date(token.exp).toLocaleString()}`;

  // Subtitle paths are relative to the token's media directory.
  const mediaDir = src.slice(0, src.lastIndexOf('/') + 1);
  const subs = await sessionSubtitles().catch((err) => {
    logEvent(`subtitles: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
  for (const sub of subs) {
    const track = el('track', {
      kind: 'subtitles',
      srclang: sub.lang,
      label: sub.label ?? `${sub.lang} (${sub.addonId})`,
      src: mediaDir + sub.path,
    });
    // The <video>'s crossorigin is what applies; set here too, as the API docs say.
    track.setAttribute('crossorigin', 'anonymous');
    p.video.append(track);
  }

  p.status.textContent = 'loading…';
  const Hls = await loadHls();
  if (Hls.isSupported()) {
    // No worker: the CSP has no worker-src for its blob: URL.
    const hls = new Hls({ enableWorker: false });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      const code = data.response?.code ? ` HTTP ${data.response.code}` : '';
      p.status.textContent = `hls.js ${data.fatal ? 'fatal ' : ''}${data.type}: ${data.details}${code}`;
    });
    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      p.status.textContent = `playing: ${data.levels.length} level(s), ${subs.length} subtitle track(s)`;
    });
    hls.loadSource(src);
    hls.attachMedia(p.video);
    p.hls = hls;
  } else if (p.video.canPlayType('application/vnd.apple.mpegurl') !== '') {
    p.video.src = src;
    p.status.textContent = `playing with native HLS, ${subs.length} subtitle track(s)`;
  } else {
    throw new Error('This browser has neither MediaSource nor native HLS.');
  }
  void p.video.play().catch(() => {
    // Autoplay blocked: the controls still work.
  });
}

async function revokeSubject(p) {
  if (session === null || p.token === null) return;
  await send('DELETE', `/v1/sessions/${seg(session.id)}/tokens/${seg(p.token.subject)}`);
  logEvent(`revoked ${p.token.subject}`);
  p.status.textContent = `${p.token.subject} revoked: its next media request gets 404`;
}

async function revokeAll() {
  if (session === null) return;
  const { tokenEpoch } = await send('POST', `/v1/sessions/${seg(session.id)}/tokens/revoke-all`);
  logEvent(`revoke-all: epoch ${tokenEpoch}; every token minted before now gets 404`);
  await refreshSession();
}

async function releaseSession() {
  if (session === null) return;
  await send('DELETE', `/v1/sessions/${seg(session.id)}`);
  await refreshSession();
  stopEvents();
}

async function loadViewers() {
  if (session === null) return;
  const { viewers } = await api(`/v1/sessions/${seg(session.id)}/viewers`);
  $('viewers').replaceChildren(
    ...viewers.map((v) =>
      el(
        'li',
        {},
        `${v.subject}: ${v.requests} requests, ${Math.round(v.bytes / 1024)} KiB`,
        v.lastFile ? `, last ${v.lastFile}` : '',
        v.lastRequestAt ? ` at ${new Date(v.lastRequestAt).toLocaleTimeString()}` : '',
      ),
    ),
  );
  if (viewers.length === 0) $('viewers').append(el('li', { className: 'muted' }, 'None yet.'));
}

async function toggleSecondPlayer() {
  const p = players[1];
  if (p.box.hidden) {
    p.box.hidden = false;
    $('second-toggle').textContent = 'Remove second player';
    await startPlayer(p);
  } else {
    stopPlayer(p, '');
    p.box.hidden = true;
    $('second-toggle').textContent = 'Add second player';
  }
}

// ---- Wiring --------------------------------------------------------------------------

$('key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  setKey($('key').value.trim());
  $('key').value = '';
  void step(loadCatalogs);
});
$('forget').addEventListener('click', () => {
  setKey('');
  $('catalogs').replaceChildren();
});
$('reload-catalogs').addEventListener('click', () => void step(loadCatalogs));
$('extras').addEventListener('submit', (event) => {
  event.preventDefault();
  void step(loadCatalog);
});
$('stream-options').addEventListener('submit', (event) => {
  event.preventDefault();
  void step(loadStreams);
});
$('sort').addEventListener('change', () => void step(loadStreams));

$('play-auto').addEventListener('click', () => void step(() => playSource({ auto: true })));
$('second-toggle').addEventListener('click', () => void step(toggleSecondPlayer));
$('revoke-all').addEventListener('click', () => void step(revokeAll));
$('viewers-refresh').addEventListener('click', () => void step(loadViewers));
$('release').addEventListener('click', () => void step(releaseSession));
for (const p of players) {
  $(`revoke-${p.n}`).addEventListener('click', () => void step(() => revokeSubject(p)));
  $(`remint-${p.n}`).addEventListener('click', () => void step(() => startPlayer(p)));
}

void step(loadDevConfig);
if (key !== '') void step(loadCatalogs);
