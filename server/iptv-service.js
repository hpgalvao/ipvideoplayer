import 'dotenv/config';
import fetch from 'node-fetch';
import { fetchAgent } from './net.js';
import { queryAll, queryOne, transaction } from './db.js';

const SENSITIVE_LEAK_PATTERNS = [
  /username=[^&\s"'`]+/gi,
  /password=[^&\s"'`]+/gi,
  /api[_-]?key=[^&\s"'`]+/gi,
  /token=[^&\s"'`]+/gi,
  /getaddrinfo\s+ENOTFOUND\s+\S+/gi,
  /ETIMEDOUT\s+\S+/gi,
  /ECONNREFUSED\s+\S+/gi,
  /ECONNRESET\s+\S+/gi,
  /dns\.phaptom\.shop/gi,
  /process\.env(\.|\[)/gi,
  /\.env/gi,
  /sqlite(_\w+)?/gi,
  /SQLITE_/gi,
  /\bSELECT\b.*\bFROM\b/gi,
  /\bINSERT INTO\b/gi,
  /\bDELETE FROM\b/gi,
  /\bUPDATE\b.*\bSET\b/gi,
  /(\d{1,3}\.){3}\d{1,3}:\d{2,5}/g,
  /(iptv|xtream|tvheadend|plex|emby|jellyfin)\b/gi,
];

export function scrubMessage(value) {
  if (value == null) return '';
  let text = String(value);
  for (const pattern of SENSITIVE_LEAK_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (/^(username|password|api[_-]?key|token)=/i.test(match)) {
        return `${match.split('=')[0]}=[REDACTED]`;
      }
      if (/^getaddrinfo|^ETIMEDOUT|^ECONNREFUSED|^ECONNRESET/i.test(match)) {
        return '[NETWORK_REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return text;
}

const LOG_PREFIX = '[IPTV-SAFE]';

export function logServerError(label, raw) {
  try {
    const detail = raw instanceof Error
      ? `${raw.name}: ${raw.message}${raw.stack ? `\n${raw.stack}` : ''}`
      : String(raw || '');
    // Nunca logar credenciais/URLs sensiveis: aplica o scrub antes de escrever no log.
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} ${label} -> ${scrubMessage(detail)}`);
  } catch {
    // Nao deixa o logger quebrar o fluxo.
  }
}

export function safePublicError(label, raw, fallback = 'Falha na operacao. Tente novamente mais tarde.') {
  logServerError(label, raw);
  return fallback;
}

function getEnvValue(name) {
  return String(process.env[name] || '').trim();
}

export const DEFAULT_SETTINGS = {
  baseUrl: getEnvValue('IPTV_BASE_URL'),
  username: getEnvValue('IPTV_USERNAME'),
  password: getEnvValue('IPTV_PASSWORD'),
};

const LIVE_EXT = 'm3u8';
const VOD_EXT = 'ts';
const VALID_SECTIONS = new Set(['live', 'movie', 'series', 'favorites', 'watch-later']);
let seriesMetadataPromise = null;

function cleanUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function flattenText(value) {
  if (!value) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join(', ');
  }

  if (typeof value === 'object') {
    return Object.values(value).map(flattenText).filter(Boolean).join(', ');
  }

  return String(value).trim();
}

function extractMetadataText(apiItem, keys) {
  for (const key of keys) {
    const text = flattenText(apiItem?.[key]);
    if (text) {
      return text;
    }
  }

  return '';
}

function buildPlayerApiUrl(settings) {
  return `${cleanUrl(settings.baseUrl)}/player_api.php?username=${encodeURIComponent(settings.username)}&password=${encodeURIComponent(settings.password)}`;
}

function buildPlaylistUrl(settings, output) {
  return `${cleanUrl(settings.baseUrl)}/get.php?username=${encodeURIComponent(settings.username)}&password=${encodeURIComponent(settings.password)}&type=m3u_plus&output=${output}`;
}

export function buildCatalogDownloadUrl(settings, output) {
  const safeOutput = output === 'ts' ? 'ts' : 'm3u8';
  return buildPlaylistUrl(settings, safeOutput);
}

function parseXcLink(raw) {
  const match = /^xc:\/\/([^:@/?#]+):([^@/?#]*)@([^/?#]+)((?:\/[^?#]*)?)((?:\?[^#]*)?)$/i.exec(String(raw || '').trim());
  if (!match) {
    return null;
  }

  const username = decodeURIComponent(match[1] || '');
  const password = decodeURIComponent(match[2] || '');
  const hostPort = String(match[3] || '').trim();
  const pathPart = match[4] || '';
  const queryPart = match[5] || '';

  const params = new URLSearchParams(queryPart.replace(/^\?/, ''));
  pathPart
    .split('/')
    .filter(Boolean)
    .forEach((segment) => {
      const separator = segment.indexOf('=');
      if (separator > 0) {
        const key = segment.slice(0, separator).trim();
        const value = segment.slice(separator + 1).trim();
        if (key && value && !params.has(key)) {
          params.set(key, value);
        }
      }
    });

  const requested = String(params.get('output') || params.get('streaming') || '').toLowerCase();
  const output = requested === 'ts' ? 'ts' : 'm3u8';
  const scheme = params.get('scheme') === 'https' || /:443$/.test(hostPort) ? 'https' : 'http';

  return {
    baseUrl: `${scheme}://${hostPort}`,
    username,
    password,
    output,
  };
}

export function normalizeCatalogSource(input = {}) {
  const rawUrl = String(input.url || '').trim();
  const explicitBase = String(input.baseUrl || '').trim();
  const explicitUser = String(input.username || '').trim();
  const explicitPass = String(input.password || '').trim();
  const explicitOutput = input.output === 'ts' ? 'ts' : 'm3u8';

  if (rawUrl) {
    const xc = parseXcLink(rawUrl);
    if (xc) {
      return {
        ...xc,
        url: buildCatalogDownloadUrl({ baseUrl: xc.baseUrl, username: xc.username, password: xc.password }, xc.output),
      };
    }

    if (!/^https?:\/\//i.test(rawUrl)) {
      return { error: 'Link nao reconhecido. Use um link xc://, get.php, xmltv.php ou uma URL M3U/M3U8.' };
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { error: 'A URL informada e invalida.' };
    }

    const origin = `${parsed.protocol}//${parsed.host}`;
    const pathname = parsed.pathname.toLowerCase();

    if (/xmltv\.php$/.test(pathname)) {
      const username = parsed.searchParams.get('username') || explicitUser;
      const password = parsed.searchParams.get('password') || explicitPass;
      if (!username || !password) {
        return { error: 'O link EPG nao trouxe usuario e senha. Preencha os campos ou use um link get.php/xc://.' };
      }
      return {
        baseUrl: origin,
        username,
        password,
        output: explicitOutput,
        url: buildCatalogDownloadUrl({ baseUrl: origin, username, password }, explicitOutput),
      };
    }

    if (/get\.php$/.test(pathname) || /\.m3u8?$/.test(pathname)) {
      const linkOutput = String(parsed.searchParams.get('output') || '').toLowerCase();
      return {
        url: rawUrl,
        baseUrl: origin,
        username: parsed.searchParams.get('username') || explicitUser,
        password: parsed.searchParams.get('password') || explicitPass,
        output: linkOutput === 'ts' ? 'ts' : explicitOutput,
      };
    }

    return {
      url: rawUrl,
      baseUrl: origin,
      username: explicitUser,
      password: explicitPass,
      output: explicitOutput,
    };
  }

  const settings = mergeSettings({ baseUrl: explicitBase, username: explicitUser, password: explicitPass });
  if (!settings.baseUrl || !settings.username || !settings.password) {
    return { error: 'Informe a URL da lista ou preencha base URL, usuario e senha.' };
  }

  return {
    ...settings,
    output: explicitOutput,
    url: buildCatalogDownloadUrl(settings, explicitOutput),
  };
}

const DEFAULT_FETCH_USER_AGENT = 'Personal-IPTV-App/1.0';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.IPTV_FETCH_TIMEOUT_MS) || 180000;

async function fetchText(url, label = 'fetch', options = {}) {
  const userAgent = options.userAgent || DEFAULT_FETCH_USER_AGENT;
  const configuredTimeout = options.timeoutMs === 0 ? 0 : Number(options.timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS;
  const controller = configuredTimeout > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), configuredTimeout) : null;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
      },
      agent: fetchAgent,
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response.ok) {
      logServerError(label, new Error(`HTTP ${response.status} ${response.statusText || ''}`));
      throw new Error('REMOTE_HTTP_FAILURE');
    }

    return await response.text();
  } catch (rawError) {
    logServerError(label, rawError);
    if (rawError && rawError.message === 'REMOTE_HTTP_FAILURE') {
      throw new Error('Nao foi possivel acessar o provedor de conteudo no momento.');
    }
    throw new Error('Falha de conexao com o provedor de conteudo. Verifique a internet e tente novamente.');
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function fetchJson(url) {
  const text = await fetchText(url, 'fetchJson');
  try {
    return JSON.parse(text);
  } catch (rawError) {
    logServerError('fetchJson_parse', rawError);
    throw new Error('A resposta do provedor de conteudo nao esta no formato esperado.');
  }
}

function getAttr(line, attribute) {
  const match = line.match(new RegExp(`${attribute}="([^"]*)"`, 'i'));
  return match ? match[1].trim() : '';
}

function parseName(line) {
  const commaIndex = line.lastIndexOf(',');
  return commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : 'Sem nome';
}

function inferContentType(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.includes('/live/')) {
    return 'live';
  }
  if (lower.includes('/series/')) {
    return 'series';
  }
  return 'movie';
}

function parseStreamInfo(url, contentType) {
  const clean = String(url || '').trim();
  const [path] = clean.split('?');
  const parts = path.split('/').filter(Boolean);
  const streamIdWithExt = parts.at(-1) || '';
  const dotIndex = streamIdWithExt.lastIndexOf('.');
  const streamId = dotIndex >= 0 ? streamIdWithExt.slice(0, dotIndex) : streamIdWithExt;
  const extension = dotIndex >= 0 ? streamIdWithExt.slice(dotIndex + 1) : '';
  const streamType = contentType === 'live' ? 'live' : contentType === 'series' ? 'series' : 'movie';
  return {
    streamId,
    extension,
    streamType,
  };
}

function extractYear(apiItem) {
  const candidates = [
    apiItem.year,
    apiItem.releaseDate,
    apiItem.releasedate,
    apiItem.release_date,
    apiItem.added,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const match = String(candidate).match(/\b(19|20)\d{2}\b/);
    if (match) {
      return Number(match[0]);
    }
  }

  return null;
}

function extractAgeRating(apiItem) {
  const candidates = [
    apiItem.age_rating,
    apiItem.age,
    apiItem.parental_rating,
    apiItem.parental_guide,
    apiItem.certification,
    apiItem.certifications,
    apiItem.rated,
    apiItem.mpaa_rating,
    apiItem.mpaa,
  ]
    .map((value) => flattenText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    const directNumber = normalized.match(/\b(0|7|10|12|13|14|15|16|17|18|21)\b/);
    if (directNumber) {
      return Number(directNumber[1]);
    }

    if (/\b(livre|free|all ages|tv y|tv g|g)\b/.test(normalized)) {
      return 0;
    }

    if (/\bpg\b/.test(normalized)) {
      return 10;
    }

    if (/\bpg 13\b/.test(normalized) || /\btv 14\b/.test(normalized)) {
      return 14;
    }

    if (/\br\b/.test(normalized) || /\bma\b/.test(normalized) || /\btv ma\b/.test(normalized) || /\bnc 17\b/.test(normalized)) {
      return 18;
    }
  }

  return null;
}

function extractGenres(apiItem) {
  const raw = apiItem.genre || apiItem.genres || apiItem.genre_name || '';
  const items = Array.isArray(raw) ? raw : String(raw).split(/[,/|]/);
  return Array.from(
    new Set(
      items
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function buildGenresIndex(genres) {
  return genres.length ? `|${genres.join('|')}|` : '';
}

function buildSearchTokens(query) {
  return normalizeText(query)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function cleanSeriesTitle(value) {
  return String(value || '')
    .replace(/[\s._:-]+$/g, '')
    .trim();
}

function parseSeriesMetadata(name) {
  const rawName = String(name || '').trim();
  const patterns = [
    /^(.*?)[\s._:-]+S(\d{1,2})\s*E(\d{1,3})(?:[\s._:-]+(.*))?$/i,
    /^(.*?)[\s._:-]+(\d{1,2})x(\d{1,3})(?:[\s._:-]+(.*))?$/i,
  ];

  for (const pattern of patterns) {
    const match = rawName.match(pattern);
    if (!match) {
      continue;
    }

    const seriesTitle = cleanSeriesTitle(match[1]) || rawName;
    const seasonNumber = Number(match[2]) || null;
    const episodeNumber = Number(match[3]) || null;
    const episodeTitle = String(match[4] || '').trim();
    return {
      seriesTitle,
      normalizedSeriesTitle: normalizeText(seriesTitle),
      seriesKey: normalizeText(seriesTitle),
      seasonNumber,
      episodeNumber,
      episodeTitle,
    };
  }

  return {
    seriesTitle: rawName,
    normalizedSeriesTitle: normalizeText(rawName),
    seriesKey: normalizeText(rawName),
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: '',
  };
}

export function parseM3U(content, playlistType) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXTINF')) {
      continue;
    }

    const streamUrl = lines[index + 1];
    if (!streamUrl || streamUrl.startsWith('#')) {
      continue;
    }

    const contentType = playlistType || inferContentType(streamUrl);
    const streamInfo = parseStreamInfo(streamUrl, contentType);
    const category = getAttr(line, 'group-title') || 'Sem categoria';

    items.push({
      id: `${contentType}:${streamInfo.streamId || parseName(line)}`,
      name: parseName(line),
      logo: getAttr(line, 'tvg-logo'),
      category,
      streamUrl,
      contentType,
      streamType: streamInfo.streamType,
      streamId: streamInfo.streamId,
      extension: streamInfo.extension,
    });
  }

  return items;
}

function classifyCatalogItem(item) {
  const url = String(item.streamUrl || '').toLowerCase();
  if (url.includes('/series/')) {
    return 'series';
  }
  if (url.includes('/movie/')) {
    return 'movie';
  }
  if (url.includes('/live/')) {
    return 'live';
  }
  // Listas m3u_plus (XUI) entregam canais ao vivo sem marcador no caminho.
  if (/\.(mp4|mkv|avi|mov|wmv|flv|m4v|mpg|mpeg)(\?|$)/.test(url)) {
    return 'movie';
  }
  return 'live';
}

function buildCatalogUrlCandidates(source) {
  const candidates = [];
  const seen = new Set();

  const push = (url, label) => {
    const clean = String(url || '').trim();
    if (!clean || seen.has(clean)) {
      return;
    }
    seen.add(clean);
    candidates.push({ url: clean, label });
  };

  push(source.url, 'link informado');

  const base = cleanUrl(source.baseUrl || '');
  const username = String(source.username || '').trim();
  const password = String(source.password || '').trim();
  const output = source.output === 'ts' ? 'ts' : 'm3u8';

  if (base && username && password) {
    const encodedUser = encodeURIComponent(username);
    const encodedPass = encodeURIComponent(password);
    const schemeMatch = /^(https?):\/\//i.exec(base);
    const primaryScheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'http';
    const schemes = primaryScheme === 'https' ? ['https', 'http'] : ['http', 'https'];
    const hostPath = base.replace(/^https?:\/\//i, '');
    const outputs = output === 'ts' ? ['ts', 'm3u8'] : ['m3u8', 'ts'];

    schemes.forEach((scheme, schemeIndex) => {
      const root = `${scheme}://${hostPath}`;
      outputs.forEach((out) => {
        push(
          `${root}/get.php?username=${encodedUser}&password=${encodedPass}&type=m3u_plus&output=${out}`,
          `get.php m3u_plus ${out}${schemeIndex === 1 ? ' (esquema alternativo)' : ''}`,
        );
      });
      push(`${root}/get.php?username=${encodedUser}&password=${encodedPass}&type=m3u`, 'get.php type=m3u');
    });
  }

  return candidates;
}

const CATALOG_USER_AGENTS = [BROWSER_USER_AGENT, DEFAULT_FETCH_USER_AGENT];
const CATALOG_ATTEMPT_TIMEOUT_MS = Number(process.env.IPTV_CATALOG_TIMEOUT_MS) || 180000;
const CATALOG_TOTAL_TIMEOUT_MS = Number(process.env.IPTV_CATALOG_TOTAL_TIMEOUT_MS) || 600000;

export async function downloadM3UCatalog(source) {
  const normalized =
    typeof source === 'string'
      ? { url: String(source || '').trim(), baseUrl: '', username: '', password: '', output: 'm3u8' }
      : {
          url: String(source?.url || '').trim(),
          baseUrl: String(source?.baseUrl || '').trim(),
          username: String(source?.username || '').trim(),
          password: String(source?.password || '').trim(),
          output: source?.output === 'ts' ? 'ts' : 'm3u8',
        };

  const candidates = buildCatalogUrlCandidates(normalized);
  if (!candidates.length) {
    throw new Error('Informe uma URL M3U valida (http ou https).');
  }

  const startedAt = Date.now();
  let lastError = null;
  let attempts = 0;

  for (const candidate of candidates) {
    for (let agentIndex = 0; agentIndex < CATALOG_USER_AGENTS.length; agentIndex += 1) {
      if (Date.now() - startedAt > CATALOG_TOTAL_TIMEOUT_MS) {
        lastError = lastError || new Error('Tempo esgotado ao tentar baixar a lista.');
        break;
      }

      attempts += 1;
      try {
        const content = await fetchText(candidate.url, 'catalog_download', {
          userAgent: CATALOG_USER_AGENTS[agentIndex],
          timeoutMs: CATALOG_ATTEMPT_TIMEOUT_MS,
        });

        const items = parseM3U(content, '');
        if (!items.length) {
          lastError = new Error('A lista respondeu sem canais.');
          continue;
        }

        const counts = { total: items.length, live: 0, movie: 0, series: 0 };
        items.forEach((item) => {
          const kind = classifyCatalogItem(item);
          counts[kind] = (counts[kind] || 0) + 1;
        });

        return {
          ...counts,
          usedUrl: candidate.url,
          usedBrowserAgent: agentIndex > 0,
          attemptLabel: candidate.label,
          attempts,
        };
      } catch (error) {
        lastError = error;
      }
    }

    if (Date.now() - startedAt > CATALOG_TOTAL_TIMEOUT_MS) {
      break;
    }
  }

  const detail = lastError && lastError.message ? lastError.message : '';
  const suffix = `Tentei ${attempts} forma(s) diferente(s) de download.`;
  throw new Error(detail ? `${suffix} ${detail}` : `Nao foi possivel baixar a lista. ${suffix}`);
}

export function normalizeApiData(apiData) {
  return {
    liveCategories: Array.isArray(apiData.live_categories) ? apiData.live_categories : [],
    vodCategories: Array.isArray(apiData.vod_categories) ? apiData.vod_categories : [],
    seriesCategories: Array.isArray(apiData.series_categories) ? apiData.series_categories : [],
    liveStreams: Array.isArray(apiData.available_channels) ? apiData.available_channels : [],
    movies: Array.isArray(apiData.movies) ? apiData.movies : [],
    series: Array.isArray(apiData.series) ? apiData.series : [],
  };
}

function categoryNameMap(apiData) {
  const map = new Map();
  [...apiData.liveCategories, ...apiData.vodCategories, ...apiData.seriesCategories].forEach((item) => {
    map.set(String(item.category_id), item.category_name);
  });
  return map;
}

function mergeApiMetadata(items, apiData) {
  const liveById = new Map((apiData.liveStreams || []).map((item) => [String(item.stream_id), item]));
  const movieById = new Map((apiData.movies || []).map((item) => [String(item.stream_id), item]));
  const seriesById = new Map((apiData.series || []).map((item) => [String(item.series_id), item]));
  const categoriesById = categoryNameMap(apiData);

  return items
    .map((item) => {
      const sourceMap =
        item.contentType === 'live'
          ? liveById
          : item.contentType === 'series'
            ? seriesById
            : movieById;

      const apiItem = sourceMap.get(String(item.streamId)) || {};
      const genres = extractGenres(apiItem);
      const resolvedName = apiItem.name || item.name;
      const plot = extractMetadataText(apiItem, ['plot', 'description', 'storyline', 'overview', 'synopsis']);
      const castText = extractMetadataText(apiItem, ['cast', 'actors', 'actor', 'starring', 'movie_actors']);
      const director = extractMetadataText(apiItem, ['director', 'directors', 'director_name', 'directed_by']);
      const seriesMeta = item.contentType === 'series' ? parseSeriesMetadata(resolvedName) : null;
      const ageRating = extractAgeRating(apiItem);

      return {
        id: item.id,
        name: resolvedName,
        sortName: resolvedName,
        normalizedName: normalizeText(resolvedName),
        contentType: item.contentType,
        streamType: item.streamType,
        streamId: item.streamId,
        streamUrl: item.streamUrl,
        extension: item.extension,
        containerExtension: apiItem.container_extension || item.extension || '',
        poster: apiItem.stream_icon || apiItem.cover || item.logo || '',
        category: categoriesById.get(String(apiItem.category_id || '')) || item.category || 'Sem categoria',
        categoryId: apiItem.category_id ? String(apiItem.category_id) : '',
        year: extractYear(apiItem),
        genre: genres.join(', '),
        genresJson: JSON.stringify(genres),
        genresIndex: buildGenresIndex(genres),
        seriesTitle: seriesMeta?.seriesTitle || '',
        normalizedSeriesTitle: seriesMeta?.normalizedSeriesTitle || '',
        seriesKey: seriesMeta?.seriesKey || '',
        seasonNumber: seriesMeta?.seasonNumber ?? null,
        episodeNumber: seriesMeta?.episodeNumber ?? null,
        episodeTitle: seriesMeta?.episodeTitle || '',
        castText,
        normalizedCast: normalizeText(castText),
        director,
        normalizedDirector: normalizeText(director),
        rating: String(apiItem.rating || apiItem.rating_5based || ''),
        ageRating,
        added: String(apiItem.added || ''),
        plot,
        normalizedPlot: normalizeText(plot),
        tmdbId: String(apiItem.tmdb || apiItem.tmdb_id || ''),
      };
    })
    .filter((item) => item.streamId);
}

function mapRow(row) {
  return {
    id: row.id,
    itemType: row.item_type || 'item',
    name: row.name,
    contentType: row.content_type,
    streamType: row.stream_type,
    streamId: row.stream_id,
    streamUrl: row.stream_url,
    extension: row.extension,
    containerExtension: row.container_extension,
    poster: row.poster,
    category: row.category || 'Sem categoria',
    categoryId: row.category_id || '',
    year: row.year ? Number(row.year) : null,
    genre: row.genre || '',
    seriesTitle: row.series_title || '',
    seriesKey: row.series_key || '',
    seasonNumber: row.season_number ? Number(row.season_number) : null,
    episodeNumber: row.episode_number ? Number(row.episode_number) : null,
    episodeTitle: row.episode_title || '',
    episodeCount: row.episode_count ? Number(row.episode_count) : 0,
    seasonCount: row.season_count ? Number(row.season_count) : 0,
    cast: row.cast_text || '',
    director: row.director || '',
    rating: row.rating || '',
    ageRating: row.age_rating ? Number(row.age_rating) : null,
    added: row.added || '',
    plot: row.plot || '',
    tmdbId: row.tmdb_id || '',
  };
}

function getSearchMatchInfo(row, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return null;
  }

  const normalizedName = row.normalized_name || normalizeText(row.name);
  const normalizedCast = row.normalized_cast || normalizeText(row.cast_text);
  const normalizedDirector = row.normalized_director || normalizeText(row.director);
  const normalizedPlot = row.normalized_plot || normalizeText(row.plot);
  const tokens = buildSearchTokens(query);

  if (normalizedName === normalizedQuery) {
    return { key: 'title_exact', label: 'Titulo exato' };
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return { key: 'title_prefix', label: 'Titulo inicia com' };
  }

  if (normalizedName.includes(normalizedQuery)) {
    return { key: 'title_contains', label: 'Contem no titulo' };
  }

  if (tokens.length > 1 && tokens.every((token) => normalizedName.includes(token))) {
    return { key: 'title_scattered', label: 'Termos no titulo' };
  }

  if (normalizedCast.includes(normalizedQuery)) {
    return { key: 'cast', label: 'Contem no elenco' };
  }

  if (normalizedDirector.includes(normalizedQuery)) {
    return { key: 'director', label: 'Contem no diretor' };
  }

  if (normalizedPlot.includes(normalizedQuery)) {
    return { key: 'plot', label: 'Contem na sinopse' };
  }

  return null;
}

function buildWhereClause(filters, options = {}) {
  const { exclude = new Set(), titleField = 'normalized_name' } = options;
  const clauses = [];
  const params = [];

  if (!exclude.has('catalog') && filters.catalogId) {
    clauses.push('catalog_id = ?');
    params.push(String(filters.catalogId));
  }

  if (!exclude.has('section')) {
    if (filters.section === 'favorites' || filters.section === 'watch-later') {
      const ids = Array.isArray(filters.ids) ? filters.ids.filter(Boolean) : [];
      if (!ids.length) {
        clauses.push('1 = 0');
      } else {
        clauses.push(`id IN (${ids.map(() => '?').join(', ')})`);
        params.push(...ids);
      }
    } else if (VALID_SECTIONS.has(filters.section)) {
      clauses.push('content_type = ?');
      params.push(filters.section);
    }
  }

  if (!exclude.has('query') && filters.query) {
    const normalizedQuery = normalizeText(filters.query);
    if (normalizedQuery) {
      const tokens = buildSearchTokens(filters.query);
      const searchClauses = [
        `${titleField} LIKE ?`,
        'normalized_cast LIKE ?',
        'normalized_director LIKE ?',
        'normalized_plot LIKE ?',
      ];
      const searchParams = [
        `%${normalizedQuery}%`,
        `%${normalizedQuery}%`,
        `%${normalizedQuery}%`,
        `%${normalizedQuery}%`,
      ];

      if (tokens.length > 1) {
        searchClauses.push(`(${tokens.map(() => `${titleField} LIKE ?`).join(' AND ')})`);
        searchParams.push(...tokens.map((token) => `%${token}%`));
      }

      clauses.push(`(${searchClauses.join(' OR ')})`);
      params.push(...searchParams);
    }
  }

  if (!exclude.has('category') && filters.category && filters.category !== 'Todas') {
    clauses.push('category = ?');
    params.push(filters.category);
  }

  if (!exclude.has('year') && filters.year && String(filters.year) !== 'Todos') {
    clauses.push('year = ?');
    params.push(Number(filters.year));
  }

  if (!exclude.has('genre') && filters.genre && filters.genre !== 'Todos') {
    clauses.push('genres_index LIKE ?');
    params.push(`%|${filters.genre}|%`);
  }

  if (!exclude.has('maxAgeRating') && filters.maxAgeRating != null && filters.maxAgeRating !== '') {
    const parsedMaxAgeRating = Number(filters.maxAgeRating);
    if (Number.isFinite(parsedMaxAgeRating)) {
      // Live TV sempre passa. Para VOD (filmes/series), itens SEM classificacao (age_rating NULL)
      // sao considerados "livres" e tambem passam. So bloqueia itens explicitamente marcados
      // com classificacao MAIOR que o maximo permitido no perfil. Evita listas vazias por
      // causa de catalogos que nao enviam age_rating (o normal na maioria dos provedores IPTV).
      clauses.push("(content_type = 'live' OR age_rating IS NULL OR age_rating <= ?)");
      params.push(parsedMaxAgeRating);
    }
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function appendCondition(whereSql, condition) {
  return whereSql ? `${whereSql} AND ${condition}` : `WHERE ${condition}`;
}

function buildSearchOrdering(query, titleField = 'normalized_name') {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return {
      sql: 'sort_name COLLATE NOCASE',
      params: [],
    };
  }

  const tokens = buildSearchTokens(query);
  const whenClauses = [
    {
      condition: `${titleField} = ?`,
      params: [normalizedQuery],
    },
    {
      condition: `${titleField} LIKE ?`,
      params: [`${normalizedQuery}%`],
    },
    {
      condition: `${titleField} LIKE ?`,
      params: [`%${normalizedQuery}%`],
    },
  ];

  if (tokens.length > 1) {
    whenClauses.push({
      condition: `(${tokens.map(() => `${titleField} LIKE ?`).join(' AND ')})`,
      params: tokens.map((token) => `%${token}%`),
    });
  }

  whenClauses.push(
    {
      condition: 'normalized_cast LIKE ?',
      params: [`%${normalizedQuery}%`],
    },
    {
      condition: 'normalized_director LIKE ?',
      params: [`%${normalizedQuery}%`],
    },
    {
      condition: 'normalized_plot LIKE ?',
      params: [`%${normalizedQuery}%`],
    },
  );

  return {
    sql: `CASE ${whenClauses.map((clause, index) => `WHEN ${clause.condition} THEN ${index + 1}`).join(' ')} ELSE 99 END, sort_name COLLATE NOCASE`,
    params: whenClauses.flatMap((clause) => clause.params),
  };
}

async function setMetaValue(tx, key, value) {
  tx.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', [key, String(value ?? '')]);
}

async function ensureSeriesMetadataPopulated() {
  if (seriesMetadataPromise) {
    return seriesMetadataPromise;
  }

  seriesMetadataPromise = (async () => {
    const countRow = await queryOne(
      `
        SELECT COUNT(*) AS total
        FROM items
        WHERE content_type = 'series'
          AND (
            series_key IS NULL OR series_key = ''
            OR series_title IS NULL OR series_title = ''
            OR normalized_series_title IS NULL OR normalized_series_title = ''
          )
      `,
    );

    if (!Number(countRow?.total || 0)) {
      return;
    }

    const rows = await queryAll(
      `
        SELECT id, name
        FROM items
        WHERE content_type = 'series'
          AND (
            series_key IS NULL OR series_key = ''
            OR series_title IS NULL OR series_title = ''
            OR normalized_series_title IS NULL OR normalized_series_title = ''
          )
      `,
    );

    await transaction(async (tx) => {
      rows.forEach((row) => {
        const seriesMeta = parseSeriesMetadata(row.name);
        tx.run(
          `
            UPDATE items
            SET
              series_title = ?,
              normalized_series_title = ?,
              series_key = ?,
              season_number = ?,
              episode_number = ?,
              episode_title = ?
            WHERE id = ?
          `,
          [
            seriesMeta.seriesTitle,
            seriesMeta.normalizedSeriesTitle,
            seriesMeta.seriesKey,
            seriesMeta.seasonNumber,
            seriesMeta.episodeNumber,
            seriesMeta.episodeTitle,
            row.id,
          ],
        );
      });
    });
  })().finally(() => {
    seriesMetadataPromise = null;
  });

  return seriesMetadataPromise;
}

export function mergeSettings(input) {
  return {
    baseUrl: cleanUrl(input.baseUrl || DEFAULT_SETTINGS.baseUrl),
    username: String(input.username || DEFAULT_SETTINGS.username).trim(),
    password: String(input.password || DEFAULT_SETTINGS.password).trim(),
  };
}

export function buildStreamUrl(settings, item) {
  const base = cleanUrl(settings.baseUrl);
  if (item.contentType === 'live') {
    return `${base}/live/${settings.username}/${settings.password}/${item.streamId}.${item.extension || LIVE_EXT}`;
  }

  if (item.contentType === 'series') {
    return item.streamUrl;
  }

  return `${base}/movie/${settings.username}/${settings.password}/${item.streamId}.${item.containerExtension || item.extension || VOD_EXT}`;
}

function swapStreamExtension(url, nextExtension) {
  const clean = String(url || '').trim();
  if (!clean) {
    return '';
  }

  return clean.replace(/\.(m3u8|ts)(\?.*)?$/i, `.${nextExtension}$2`);
}

function inferStreamFormatFromUrl(url) {
  return /\.m3u8(\?.*)?$/i.test(String(url || '')) ? 'm3u8' : 'ts';
}

export function buildStreamCandidates(settings, item) {
  const primaryUrl = buildStreamUrl(settings, item);
  const candidates = [];

  function pushCandidate(url, format, label) {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl || candidates.some((candidate) => candidate.url === cleanUrl)) {
      return;
    }

    candidates.push({
      url: cleanUrl,
      format,
      label,
    });
  }

  if (item.contentType === 'live') {
    pushCandidate(`${cleanUrl(settings.baseUrl)}/live/${settings.username}/${settings.password}/${item.streamId}.m3u8`, 'm3u8', 'HLS direto');
    pushCandidate(`${cleanUrl(settings.baseUrl)}/live/${settings.username}/${settings.password}/${item.streamId}.ts`, 'ts', 'TS direto');
  } else if (item.contentType === 'movie') {
    pushCandidate(primaryUrl, inferStreamFormatFromUrl(primaryUrl), 'Direto');
    pushCandidate(
      `${cleanUrl(settings.baseUrl)}/movie/${settings.username}/${settings.password}/${item.streamId}.m3u8`,
      'm3u8',
      'HLS alternativo',
    );
    pushCandidate(
      `${cleanUrl(settings.baseUrl)}/movie/${settings.username}/${settings.password}/${item.streamId}.ts`,
      'ts',
      'TS alternativo',
    );
  } else {
    pushCandidate(primaryUrl, inferStreamFormatFromUrl(primaryUrl), 'Direto');
    pushCandidate(swapStreamExtension(primaryUrl, 'm3u8'), 'm3u8', 'HLS alternativo');
    pushCandidate(swapStreamExtension(primaryUrl, 'ts'), 'ts', 'TS alternativo');
  }

  return candidates;
}

async function fetchRemoteItems(settings) {
  const apiUrl = buildPlayerApiUrl(settings);
  const livePlaylistUrl = buildPlaylistUrl(settings, 'm3u8');
  const vodPlaylistUrl = buildPlaylistUrl(settings, 'ts');

  const [apiResponse, livePlaylist, vodPlaylist] = await Promise.all([
    fetchJson(apiUrl),
    fetchText(livePlaylistUrl),
    fetchText(vodPlaylistUrl),
  ]);

  const apiData = normalizeApiData(apiResponse);
  const mergedItems = mergeApiMetadata(
    [
      ...parseM3U(livePlaylist, 'live'),
      ...parseM3U(vodPlaylist, ''),
    ],
    apiData,
  );

  const deduped = new Map();
  mergedItems.forEach((item) => {
    deduped.set(item.id, item);
  });

  return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export async function getCatalogStatus(catalogId = '') {
  const scopedCatalogId = catalogId ? String(catalogId) : '';
  const rows = await queryAll(
    catalogId
      ? `
        SELECT content_type, COUNT(*) AS total
        FROM items
        WHERE catalog_id = ?
        GROUP BY content_type
      `
      : `
        SELECT content_type, COUNT(*) AS total
        FROM items
        GROUP BY content_type
      `,
    scopedCatalogId ? [scopedCatalogId] : [],
  );

  let updatedAt = '';
  if (scopedCatalogId) {
    const catalogRow = await queryOne('SELECT last_sync_at FROM catalogs WHERE id = ?', [scopedCatalogId]);
    updatedAt = catalogRow?.last_sync_at ? String(catalogRow.last_sync_at) : '';
  } else {
    const metaRows = await queryAll("SELECT key, value FROM meta WHERE key IN ('last_sync_at')");
    const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
    updatedAt = meta.last_sync_at || '';
  }

  const counts = {
    live: 0,
    movie: 0,
    series: 0,
  };

  rows.forEach((row) => {
    counts[row.content_type] = Number(row.total);
  });

  return {
    hasData: counts.live + counts.movie + counts.series > 0,
    counts,
    updatedAt,
  };
}

export async function getAllowedProviderHosts() {
  const hosts = new Set();

  const addFromUrl = (value) => {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.hostname) {
        hosts.add(parsed.hostname.toLowerCase());
      }
    } catch {
      // Ignora valores que nao forem URL valida.
    }
  };

  addFromUrl(DEFAULT_SETTINGS.baseUrl);

  const sourceEnv = String(process.env.IPTV_SOURCE || '').trim();
  if (sourceEnv) {
    const parsed = normalizeCatalogSource({ url: sourceEnv });
    if (!parsed.error) {
      addFromUrl(parsed.baseUrl);
    }
  }

  try {
    const rows = await queryAll('SELECT base_url, url FROM catalogs');
    rows.forEach((row) => {
      addFromUrl(row.base_url);
      addFromUrl(row.url);
    });
  } catch {
    // Sem catalogs: segue apenas com as fontes de configuracao.
  }

  return hosts;
}

function normalizeProviderCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  const baseUrl = cleanUrl(candidate.baseUrl || '');
  const username = String(candidate.username || '').trim();
  const password = String(candidate.password || '').trim();

  if (!baseUrl || !username || !password) {
    return null;
  }

  return { baseUrl, username, password };
}

async function buildProviderCandidates(rawSettings) {
  const list = [];
  const seen = new Set();

  const push = (candidate) => {
    const normalized = normalizeProviderCandidate(candidate);
    if (!normalized) {
      return;
    }

    const key = `${normalized.baseUrl}|${normalized.username}|${normalized.password}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    list.push(normalized);
  };

  // 1) Fonte informada em IPTV_SOURCE (aceita xc://, get.php, xmltv.php ou URL M3U).
  const sourceEnv = String(process.env.IPTV_SOURCE || '').trim();
  if (sourceEnv) {
    try {
      const parsed = normalizeCatalogSource({ url: sourceEnv });
      if (!parsed.error) {
        push(parsed);
      }
    } catch {
      // Ignora IPTV_SOURCE invalido e segue para as outras fontes.
    }
  }

  // 2) Configuracao/campos informados (env DEFAULT_SETTINGS via mergeSettings).
  push(mergeSettings(rawSettings || {}));

  // 3) Catalogos salvos na tela "Meus catalogos" (ativos primeiro, depois os mais recentes).
  try {
    const rows = await queryAll(
      'SELECT base_url, username, password, is_active FROM catalogs ORDER BY is_active DESC, created_at DESC',
    );
    rows.forEach((row) => push({ baseUrl: row.base_url, username: row.username, password: row.password }));
  } catch {
    // Sem catalogos salvos: segue apenas com as fontes anteriores.
  }

  return list;
}

export async function syncCatalogToDatabase(settings, { force = false, catalogId = '' } = {}) {
  const currentStatus = await getCatalogStatus(catalogId);
  if (currentStatus.hasData && !force) {
    return currentStatus;
  }

  const candidates = await buildProviderCandidates(settings);
  if (!candidates.length) {
    throw new Error('Nenhuma fonte de catalogo configurada. Ajuste o provedor no .env ou cadastre uma lista em Meus catalogos.');
  }

  let items = [];
  let usedSettings = null;
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const fetched = await fetchRemoteItems(candidate);
      if (fetched.length) {
        items = fetched;
        usedSettings = candidate;
        break;
      }
      lastError = new Error('A fonte respondeu sem itens.');
    } catch (error) {
      lastError = error;
    }
  }

  if (!items.length || !usedSettings) {
    throw lastError || new Error('Nao foi possivel baixar o catalogo de nenhuma fonte configurada.');
  }

  return persistCatalogItems(items, {
    baseUrl: usedSettings.baseUrl,
    username: usedSettings.username,
    source: 'xtream',
    catalogId,
  });
}

async function persistCatalogItems(items, meta = {}) {
  const updatedAt = new Date().toISOString();
  const catalogId = meta.catalogId ? String(meta.catalogId) : '';

  await transaction(async (tx) => {
    if (catalogId) {
      // Substitui apenas os itens deste catalogo e remove itens legados (sem catalogo_id).
      tx.run('DELETE FROM items WHERE catalog_id = ? OR catalog_id IS NULL', [catalogId]);
    } else {
      tx.run('DELETE FROM items');
    }
    tx.run('DELETE FROM meta');

    const insertSql = `
      INSERT INTO items(
        id, name, sort_name, normalized_name, content_type, stream_type, stream_id, stream_url,
        extension, container_extension, poster, category, category_id, year, genre, genres_json,
        genres_index, series_title, normalized_series_title, series_key, season_number,
        episode_number, episode_title, cast_text, normalized_cast, director, normalized_director,
        rating, age_rating, added, plot, normalized_plot, tmdb_id, catalog_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    items.forEach((item) => {
      tx.run(insertSql, [
        item.id,
        item.name,
        item.name,
        item.normalizedName,
        item.contentType,
        item.streamType,
        item.streamId,
        item.streamUrl,
        item.extension,
        item.containerExtension,
        item.poster,
        item.category,
        item.categoryId,
        item.year,
        item.genre,
        item.genresJson,
        item.genresIndex,
        item.seriesTitle,
        item.normalizedSeriesTitle,
        item.seriesKey,
        item.seasonNumber,
        item.episodeNumber,
        item.episodeTitle,
        item.castText,
        item.normalizedCast,
        item.director,
        item.normalizedDirector,
        item.rating,
        item.ageRating,
        item.added,
        item.plot,
        item.normalizedPlot,
        item.tmdbId,
        catalogId || null,
      ]);
    });

    await setMetaValue(tx, 'last_sync_at', updatedAt);
    await setMetaValue(tx, 'last_base_url', meta.baseUrl || '');
    await setMetaValue(tx, 'last_username', meta.username || '');
    await setMetaValue(tx, 'last_source', meta.source || '');
    await setMetaValue(tx, 'last_catalog_id', catalogId);
  });

  return getCatalogStatus(catalogId);
}

export async function hasConfiguredCatalogSource() {
  try {
    const candidates = await buildProviderCandidates({});
    return candidates.length > 0;
  } catch {
    return false;
  }
}

// Monta o catalogo do sistema a partir de uma URL M3U direta (sem usuario/senha).
export async function syncCatalogFromM3uUrl(rawUrl, { force = false, catalogId = '' } = {}) {
  const currentStatus = await getCatalogStatus(catalogId);
  if (currentStatus.hasData && !force) {
    return currentStatus;
  }

  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Informe uma URL de lista M3U valida (http ou https).');
  }

  const content = await fetchText(url, 'catalog_source');
  const merged = mergeApiMetadata(parseM3U(content, ''), normalizeApiData({}));
  if (!merged.length) {
    throw new Error('A lista respondeu sem canais. Confira se a URL aponta para um arquivo M3U.');
  }

  const items = merged.map((item) => ({ ...item, contentType: classifyCatalogItem(item) }));

  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    origin = '';
  }

  return persistCatalogItems(items, { baseUrl: origin, username: '', source: 'm3u', catalogId });
}

async function getDistinctCategories(filters, options = {}) {
  const where = buildWhereClause(filters, { exclude: new Set(['category']), ...options });
  const rows = await queryAll(
    `SELECT DISTINCT category FROM items ${appendCondition(where.whereSql, "category IS NOT NULL AND category <> ''")} ORDER BY category COLLATE NOCASE`,
    where.params,
  );
  return rows.map((row) => row.category);
}

async function getDistinctYears(filters, options = {}) {
  const where = buildWhereClause(filters, { exclude: new Set(['year']), ...options });
  const rows = await queryAll(
    `SELECT DISTINCT year FROM items ${appendCondition(where.whereSql, 'year IS NOT NULL')} ORDER BY year DESC`,
    where.params,
  );
  return rows.map((row) => Number(row.year)).filter(Boolean);
}

async function getDistinctGenres(filters, options = {}) {
  const where = buildWhereClause(filters, { exclude: new Set(['genre']), ...options });
  const rows = await queryAll(
    `SELECT genres_json FROM items ${appendCondition(where.whereSql, "genres_json IS NOT NULL AND genres_json <> ''")}`,
    where.params,
  );

  const genres = new Set();
  rows.forEach((row) => {
    try {
      JSON.parse(row.genres_json || '[]').forEach((genre) => {
        if (genre) {
          genres.add(genre);
        }
      });
    } catch {
      // Ignora genero invalido.
    }
  });

  return Array.from(genres).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

export async function queryCatalogPage(input) {
  const filters = {
    section: VALID_SECTIONS.has(input.section) ? input.section : 'live',
    page: Math.max(1, Number(input.page) || 1),
    pageSize: Math.min(60, Math.max(1, Number(input.pageSize) || 24)),
    query: String(input.query || '').trim(),
    category: String(input.category || 'Todas'),
    year: String(input.year || 'Todos'),
    genre: String(input.genre || 'Todos'),
    maxAgeRating: input.maxAgeRating == null || input.maxAgeRating === '' ? null : Number(input.maxAgeRating),
    ids: Array.isArray(input.ids) ? input.ids : [],
  };

  const isSeriesGroups = filters.section === 'series';
  const isScopedIds = filters.section === 'favorites' || filters.section === 'watch-later';
  if (isSeriesGroups) {
    await ensureSeriesMetadataPopulated();
  }

  const whereOptions = isSeriesGroups ? { titleField: 'normalized_series_title' } : {};
  const where = buildWhereClause(filters, whereOptions);
  const searchOrdering = buildSearchOrdering(
    filters.query,
    isSeriesGroups ? 'normalized_series_title' : 'normalized_name',
  );

  let total = 0;
  let rows = [];

  if (isScopedIds) {
    const ids = filters.ids.filter(Boolean);
    const seriesKeys = [];
    const regularIds = [];
    for (const id of ids) {
      if (typeof id === 'string' && id.startsWith('series-group:')) {
        seriesKeys.push(id.slice('series-group:'.length));
      } else {
        regularIds.push(id);
      }
    }

    function buildFilteredClause(whereSql, params, extraCondition, extraParams = []) {
      if (!extraCondition) return { whereSql, params };
      return {
        whereSql: appendCondition(whereSql, extraCondition),
        params: [...params, ...extraParams],
      };
    }

    const extraWhere =
      filters.query || filters.category !== 'Todas' || filters.year !== 'Todos' || filters.genre !== 'Todas' || filters.maxAgeRating != null;

    const regular = buildFilteredClause(
      extraWhere ? where.whereSql : 'WHERE 1 = 1',
      extraWhere ? where.params : [],
      regularIds.length ? `id IN (${regularIds.map(() => '?').join(', ')})` : null,
      regularIds,
    );
    const seriesFiltered = buildFilteredClause(
      extraWhere ? where.whereSql : 'WHERE 1 = 1',
      extraWhere ? where.params : [],
      seriesKeys.length
        ? `series_key IN (${seriesKeys.map(() => '?').join(', ')}) AND series_key IS NOT NULL AND series_key <> ''`
        : "series_key IS NOT NULL AND series_key <> '' AND 1 = 0",
      seriesKeys,
    );

    const totalRegular = regularIds.length
      ? Number((await queryOne(`SELECT COUNT(*) AS total FROM items ${regular.whereSql}`, regular.params))?.total || 0)
      : 0;
    const totalSeries = seriesKeys.length
      ? Number(
          (
            await queryOne(
              `SELECT COUNT(*) AS total FROM (SELECT series_key FROM items ${seriesFiltered.whereSql} GROUP BY series_key) grouped`,
              seriesFiltered.params,
            )
          )?.total || 0,
        )
      : 0;
    total = totalRegular + totalSeries;
    const pages = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, pages);
    const offset = (page - 1) * filters.pageSize;

    const searchOrderingSeries = buildSearchOrdering(filters.query, 'normalized_series_title');
    const limit = filters.pageSize + 1;
    const regularRows = regularIds.length
      ? await queryAll(
          `
            SELECT
              id, 'item' AS item_type, name, content_type, stream_type, stream_id, stream_url, extension, container_extension,
              poster, category, category_id, year, genre, series_title, series_key, season_number, episode_number,
              episode_title, 0 AS episode_count, 0 AS season_count, cast_text, director, rating, age_rating, added, plot, tmdb_id,
              normalized_name, normalized_cast, normalized_director, normalized_plot
            FROM items
            ${regular.whereSql}
            ORDER BY ${searchOrdering.sql}
            LIMIT ?
          `,
          [...regular.params, ...searchOrdering.params, limit],
        )
      : [];
    const seriesRows = seriesKeys.length
      ? await queryAll(
          `
            SELECT
              'series-group:' || series_key AS id,
              'series_group' AS item_type,
              MAX(series_title) AS name,
              'series' AS content_type,
              'series_group' AS stream_type,
              '' AS stream_id,
              '' AS stream_url,
              '' AS extension,
              '' AS container_extension,
              MAX(poster) AS poster,
              MAX(category) AS category,
              MAX(category_id) AS category_id,
              MAX(year) AS year,
              MAX(genre) AS genre,
              MAX(series_title) AS series_title,
              series_key,
              NULL AS season_number,
              NULL AS episode_number,
              '' AS episode_title,
              COUNT(*) AS episode_count,
              COUNT(DISTINCT COALESCE(season_number, 0)) AS season_count,
              MAX(cast_text) AS cast_text,
              MAX(director) AS director,
              '' AS rating,
              MAX(age_rating) AS age_rating,
              MAX(added) AS added,
              MAX(plot) AS plot,
              MAX(tmdb_id) AS tmdb_id,
              MAX(normalized_series_title) AS normalized_name,
              MAX(normalized_cast) AS normalized_cast,
              MAX(normalized_director) AS normalized_director,
              MAX(normalized_plot) AS normalized_plot
            FROM items
            ${seriesFiltered.whereSql}
            GROUP BY series_key
            ORDER BY ${searchOrderingSeries.sql}
            LIMIT ?
          `,
          [...seriesFiltered.params, ...searchOrderingSeries.params, limit],
        )
      : [];

    const mappedRegular = regularRows.map((row) => ({
      ...mapRow(row),
      matchInfo: getSearchMatchInfo(row, filters.query),
    }));
    const mappedSeries = seriesRows.map((row) => ({
      ...mapRow(row),
      matchInfo: getSearchMatchInfo(row, filters.query),
    }));
    const merged = [...mappedSeries, ...mappedRegular];
    rows = merged.slice(offset, offset + filters.pageSize);

    const [categories, years, genres] = await Promise.all([
      getDistinctCategories(filters, whereOptions),
      getDistinctYears(filters, whereOptions),
      getDistinctGenres(filters, whereOptions),
    ]);

    return {
      items: rows,
      pagination: {
        page,
        pageSize: filters.pageSize,
        total,
        pages,
      },
      filters: {
        categories,
        years,
        genres,
        applied: {
          query: filters.query,
          category: filters.category,
          year: filters.year,
          genre: filters.genre,
        },
      },
    };
  }

  if (isSeriesGroups) {
    const groupedWhereSql = appendCondition(where.whereSql, "series_key IS NOT NULL AND series_key <> ''");
    const totalRow = await queryOne(
      `
        SELECT COUNT(*) AS total
        FROM (
          SELECT series_key
          FROM items
          ${groupedWhereSql}
          GROUP BY series_key
        ) grouped
      `,
      where.params,
    );
    total = Number(totalRow?.total || 0);
    const pages = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, pages);
    const offset = (page - 1) * filters.pageSize;

    rows = await queryAll(
      `
        SELECT
          'series-group:' || series_key AS id,
          'series_group' AS item_type,
          MAX(series_title) AS name,
          'series' AS content_type,
          'series_group' AS stream_type,
          '' AS stream_id,
          '' AS stream_url,
          '' AS extension,
          '' AS container_extension,
          MAX(poster) AS poster,
          MAX(category) AS category,
          MAX(category_id) AS category_id,
          MAX(year) AS year,
          MAX(genre) AS genre,
          MAX(series_title) AS series_title,
          series_key,
          NULL AS season_number,
          NULL AS episode_number,
          '' AS episode_title,
          COUNT(*) AS episode_count,
          COUNT(DISTINCT COALESCE(season_number, 0)) AS season_count,
          MAX(cast_text) AS cast_text,
          MAX(director) AS director,
          '' AS rating,
          MAX(age_rating) AS age_rating,
          MAX(added) AS added,
          MAX(plot) AS plot,
          MAX(tmdb_id) AS tmdb_id,
          MAX(normalized_series_title) AS normalized_name,
          MAX(normalized_cast) AS normalized_cast,
          MAX(normalized_director) AS normalized_director,
          MAX(normalized_plot) AS normalized_plot
        FROM items
        ${groupedWhereSql}
        GROUP BY series_key
        ORDER BY ${searchOrdering.sql}
        LIMIT ? OFFSET ?
      `,
      [...where.params, ...searchOrdering.params, filters.pageSize, offset],
    );

    const [categories, years, genres] = await Promise.all([
      getDistinctCategories(filters, whereOptions),
      getDistinctYears(filters, whereOptions),
      getDistinctGenres(filters, whereOptions),
    ]);

    return {
      items: rows.map((row) => ({
        ...mapRow(row),
        matchInfo: getSearchMatchInfo(row, filters.query),
      })),
      pagination: {
        page,
        pageSize: filters.pageSize,
        total,
        pages,
      },
      filters: {
        categories,
        years,
        genres,
        applied: {
          query: filters.query,
          category: filters.category,
          year: filters.year,
          genre: filters.genre,
        },
      },
    };
  }

  const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM items ${where.whereSql}`, where.params);
  total = Number(totalRow?.total || 0);
  const pages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, pages);
  const offset = (page - 1) * filters.pageSize;

  rows = await queryAll(
    `
      SELECT
        id, 'item' AS item_type, name, content_type, stream_type, stream_id, stream_url, extension, container_extension,
        poster, category, category_id, year, genre, series_title, series_key, season_number, episode_number,
        episode_title, 0 AS episode_count, 0 AS season_count, cast_text, director, rating, age_rating, added, plot, tmdb_id,
        normalized_name, normalized_cast, normalized_director, normalized_plot
      FROM items
      ${where.whereSql}
      ORDER BY ${searchOrdering.sql}
      LIMIT ? OFFSET ?
    `,
    [...where.params, ...searchOrdering.params, filters.pageSize, offset],
  );

  const [categories, years, genres] = await Promise.all([
    getDistinctCategories(filters),
    getDistinctYears(filters),
    getDistinctGenres(filters),
  ]);

  return {
    items: rows.map((row) => ({
      ...mapRow(row),
      matchInfo: getSearchMatchInfo(row, filters.query),
    })),
    pagination: {
      page,
      pageSize: filters.pageSize,
      total,
      pages,
    },
    filters: {
      categories,
      years,
      genres,
      applied: {
        query: filters.query,
        category: filters.category,
        year: filters.year,
        genre: filters.genre,
      },
    },
  };
}

export async function getStoredItem(itemId) {
  const row = await queryOne(
    `
      SELECT
        id, 'item' AS item_type, name, content_type, stream_type, stream_id, stream_url, extension, container_extension,
        poster, category, category_id, year, genre, series_title, series_key, season_number, episode_number,
        episode_title, 0 AS episode_count, 0 AS season_count, cast_text, director, rating, age_rating, added, plot, tmdb_id
      FROM items
      WHERE id = ?
      LIMIT 1
    `,
    [itemId],
  );

  return row ? mapRow(row) : null;
}

export async function getSeriesGroupDetails(seriesKey, options = {}) {
  const cleanSeriesKey = normalizeText(seriesKey);
  if (!cleanSeriesKey) {
    return null;
  }

  await ensureSeriesMetadataPopulated();

  const hasAgeLimit = options.maxAgeRating != null && options.maxAgeRating !== '';
  const parsedMaxAgeRating = hasAgeLimit ? Number(options.maxAgeRating) : null;
  const ageSql = hasAgeLimit ? ' AND (age_rating IS NULL OR age_rating <= ?)' : '';
  const ageParams = hasAgeLimit ? [parsedMaxAgeRating] : [];

  const hasCatalog = Boolean(options.catalogId);
  const catalogSql = hasCatalog ? ' AND catalog_id = ?' : '';
  const catalogParams = hasCatalog ? [String(options.catalogId)] : [];

  const summaryRow = await queryOne(
    `
      SELECT
        'series-group:' || series_key AS id,
        'series_group' AS item_type,
        MAX(series_title) AS name,
        'series' AS content_type,
        'series_group' AS stream_type,
        '' AS stream_id,
        '' AS stream_url,
        '' AS extension,
        '' AS container_extension,
        MAX(poster) AS poster,
        MAX(category) AS category,
        MAX(category_id) AS category_id,
        MAX(year) AS year,
        MAX(genre) AS genre,
        MAX(series_title) AS series_title,
        series_key,
        NULL AS season_number,
        NULL AS episode_number,
        '' AS episode_title,
        COUNT(*) AS episode_count,
        COUNT(DISTINCT COALESCE(season_number, 0)) AS season_count,
        MAX(cast_text) AS cast_text,
        MAX(director) AS director,
        '' AS rating,
        MAX(age_rating) AS age_rating,
        MAX(added) AS added,
        MAX(plot) AS plot,
        MAX(tmdb_id) AS tmdb_id
      FROM items
      WHERE content_type = 'series' AND series_key = ?${catalogSql}${ageSql}
      GROUP BY series_key
      LIMIT 1
    `,
    [cleanSeriesKey, ...catalogParams, ...ageParams],
  );

  if (!summaryRow) {
    return null;
  }

  const episodeRows = await queryAll(
    `
      SELECT
        id, 'item' AS item_type, name, content_type, stream_type, stream_id, stream_url, extension, container_extension,
        poster, category, category_id, year, genre, series_title, series_key, season_number, episode_number,
        episode_title, 0 AS episode_count, 0 AS season_count, cast_text, director, rating, age_rating, added, plot, tmdb_id
      FROM items
      WHERE content_type = 'series' AND series_key = ?${catalogSql}${ageSql}
      ORDER BY
        COALESCE(season_number, 0),
        COALESCE(episode_number, 0),
        sort_name COLLATE NOCASE
    `,
    [cleanSeriesKey, ...catalogParams, ...ageParams],
  );

  const seasonsMap = new Map();
  episodeRows.map(mapRow).forEach((episode) => {
    const seasonNumber = episode.seasonNumber || 0;
    if (!seasonsMap.has(seasonNumber)) {
      seasonsMap.set(seasonNumber, {
        seasonNumber,
        label: seasonNumber > 0 ? `Temporada ${seasonNumber}` : 'Sem temporada',
        episodes: [],
      });
    }

    seasonsMap.get(seasonNumber).episodes.push(episode);
  });

  return {
    series: mapRow(summaryRow),
    seasons: Array.from(seasonsMap.values()).sort((left, right) => left.seasonNumber - right.seasonNumber),
  };
}

export function safeError(error) {
  logServerError('safeError_unhandled', error);
  return 'Falha ao processar catalogo. Tente novamente em instantes.';
}

export async function resolveExistingIds(rawIds, catalogId = '') {
  const ids = Array.isArray(rawIds) ? rawIds.filter(Boolean) : [];
  if (!ids.length) {
    return { valid: [], invalid: [] };
  }

  const hasCatalog = Boolean(catalogId);
  const catalogSql = hasCatalog ? ' AND catalog_id = ?' : '';
  const catalogParams = hasCatalog ? [String(catalogId)] : [];

  const regularIds = [];
  const seriesKeys = [];
  for (const id of ids) {
    if (typeof id === 'string' && id.startsWith('series-group:')) {
      seriesKeys.push(id.slice('series-group:'.length));
    } else {
      regularIds.push(id);
    }
  }

  const validRegular = new Set();
  if (regularIds.length) {
    const placeholders = regularIds.map(() => '?').join(', ');
    const rows = await queryAll(
      `SELECT id FROM items WHERE id IN (${placeholders})${catalogSql}`,
      [...regularIds, ...catalogParams],
    );
    for (const row of rows) {
      validRegular.add(String(row.id));
    }
  }

  const validSeries = new Set();
  if (seriesKeys.length) {
    const placeholders = seriesKeys.map(() => '?').join(', ');
    const rows = await queryAll(
      `SELECT DISTINCT series_key FROM items WHERE series_key IS NOT NULL AND series_key <> '' AND series_key IN (${placeholders})${catalogSql}`,
      [...seriesKeys, ...catalogParams],
    );
    for (const row of rows) {
      validSeries.add(`series-group:${String(row.series_key)}`);
    }
  }

  const valid = [];
  const invalid = [];
  for (const id of ids) {
    const key = String(id);
    const isValid = key.startsWith('series-group:') ? validSeries.has(key) : validRegular.has(key);
    if (isValid) {
      valid.push(key);
    } else {
      invalid.push(key);
    }
  }
  return { valid, invalid };
}
