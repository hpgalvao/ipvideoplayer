import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';

const STORAGE_KEYS = {
  favorites: 'iptv-favorites',
  watchLater: 'iptv-watch-later',
  recommendations: 'iptv-recommendations',
  settings: 'iptv-settings',
  recent: 'iptv-recent-item',
  progress: 'iptv-playback-progress',
  searchHistory: 'iptv-search-history',
  profiles: 'iptv-profiles',
  activeProfile: 'iptv-active-profile',
  watched: 'iptv-watched-items',
  playerPreferences: 'iptv-player-preferences',
};

const DEFAULT_SETTINGS = {
  baseUrl: '',
  username: '',
  password: '',
};

const DEFAULT_PLAYER_PREFERENCES = {
  disableIdlePrompt: false,
};

const PAGE_SIZE = 24;
const VIEW_SECTIONS = new Set(['live', 'movie', 'series', 'favorites', 'watch-later']);
const PROFILE_AGE_OPTIONS = ['', '8', '10', '12', '14', '16', '18'];
const DEFAULT_PROFILES = [
  { id: 'geral', name: 'Geral', maxAgeRating: null },
  { id: 'kids', name: 'kids', maxAgeRating: 10 },
  { id: 'visita', name: 'Laura Valentina', maxAgeRating: null },
];

const SECTIONS = [
  { key: 'live', label: 'Live TV', icon: '📺' },
  { key: 'movie', label: 'Filmes', icon: '🍿' },
  { key: 'series', label: 'Série', icon: '🎬' },
];

const QUICK_ACTIONS = [
  { key: 'catalog', label: 'Listas de reproducao', icon: '≣' },
  { key: 'recent', label: 'Continuar', icon: '⟲' },
  { key: 'favorites', label: 'Favoritos', icon: '❤' },
  { key: 'watch-later', label: 'Mais tarde', icon: '◷' },
  { key: 'recommendations', label: 'Indicados', icon: '✦' },
  { key: 'settings', label: 'Configuracoes', icon: '⚙' },
];

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function persistJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function buildProfileStorageKey(baseKey, profileId) {
  return `${baseKey}:${profileId}`;
}

function createProfileId(name) {
  const normalized = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || `perfil-${Date.now()}`;
}

function loadScopedProfileValue(baseKey, profileId, fallback, legacyKey = '') {
  const scoped = readStoredJson(buildProfileStorageKey(baseKey, profileId));
  if (scoped !== undefined) {
    return scoped;
  }

  if (profileId === 'helio' && legacyKey) {
    const legacy = readStoredJson(legacyKey);
    if (legacy !== undefined) {
      return legacy;
    }
  }

  return fallback;
}

function formatProfileAgeLabel(maxAgeRating) {
  return (maxAgeRating == null || String(maxAgeRating) === '999') ? 'Sem restricao' : `Ate ${maxAgeRating} anos`;
}

function formatDate(value) {
  if (!value) {
    return 'Nao sincronizado';
  }

  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function inferMimeType(url) {
  const clean = String(url || '').toLowerCase();
  if (clean.includes('.m3u8')) {
    return 'application/vnd.apple.mpegurl';
  }
  if (clean.includes('.mp4')) {
    return 'video/mp4';
  }
  return 'video/mp2t';
}

function statLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function catalogStatusLabel(status) {
  if (status === 'ok') return 'Pronta';
  if (status === 'error') return 'Falha ao baixar';
  return 'Baixando...';
}

function createCaptchaChallenge() {
  const left = Math.floor(Math.random() * 8) + 2;
  const right = Math.floor(Math.random() * 8) + 2;
  return {
    prompt: `Quanto e ${left} + ${right}?`,
    answer: String(left + right),
  };
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatEpisodeLabel(item) {
  if (item.seasonNumber && item.episodeNumber) {
    return `T${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`;
  }
  return '';
}

function isResumeEligible(item) {
  return item?.contentType === 'movie' || item?.contentType === 'series';
}

function createPlaybackItemSnapshot(item) {
  if (!item?.id) {
    return null;
  }

  return {
    id: item.id,
    name: item.name,
    poster: item.poster || '',
    category: item.category || '',
    year: item.year || '',
    genre: item.genre || '',
    contentType: item.contentType || '',
    ageRating: item.ageRating ?? null,
    seriesKey: item.seriesKey || '',
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    episodeTitle: item.episodeTitle || '',
  };
}

function createCatalogItemSnapshot(item) {
  if (!item?.id) {
    return null;
  }

  return {
    id: item.id,
    itemType: item.itemType || '',
    name: item.name,
    poster: item.poster || '',
    category: item.category || '',
    year: item.year || '',
    genre: item.genre || '',
    contentType: item.contentType || '',
    ageRating: item.ageRating ?? null,
    seriesKey: item.seriesKey || '',
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    episodeTitle: item.episodeTitle || '',
    seasonCount: item.seasonCount ?? null,
    episodeCount: item.episodeCount ?? null,
  };
}

function getNextEpisodeFromDetails(details, currentItem) {
  const episodes = (details?.seasons || [])
    .flatMap((season) => season.episodes || [])
    .sort((left, right) => {
      const seasonDiff = Number(left.seasonNumber || 0) - Number(right.seasonNumber || 0);
      if (seasonDiff !== 0) {
        return seasonDiff;
      }
      return Number(left.episodeNumber || 0) - Number(right.episodeNumber || 0);
    });

  if (!episodes.length || !currentItem?.id) {
    return null;
  }

  const currentIndex = episodes.findIndex((episode) => episode.id === currentItem.id);
  if (currentIndex >= 0) {
    return episodes[currentIndex + 1] || null;
  }

  const fallbackIndex = episodes.findIndex(
    (episode) =>
      Number(episode.seasonNumber || 0) === Number(currentItem.seasonNumber || 0) &&
      Number(episode.episodeNumber || 0) === Number(currentItem.episodeNumber || 0),
  );

  return fallbackIndex >= 0 ? episodes[fallbackIndex + 1] || null : null;
}

function getPreviousEpisodeFromDetails(details, currentItem) {
  const episodes = (details?.seasons || [])
    .flatMap((season) => season.episodes || [])
    .sort((left, right) => {
      const seasonDiff = Number(left.seasonNumber || 0) - Number(right.seasonNumber || 0);
      if (seasonDiff !== 0) {
        return seasonDiff;
      }
      return Number(left.episodeNumber || 0) - Number(right.episodeNumber || 0);
    });

  if (!episodes.length || !currentItem?.id) {
    return null;
  }

  const currentIndex = episodes.findIndex((episode) => episode.id === currentItem.id);
  if (currentIndex > 0) {
    return episodes[currentIndex - 1] || null;
  }

  const fallbackIndex = episodes.findIndex(
    (episode) =>
      Number(episode.seasonNumber || 0) === Number(currentItem.seasonNumber || 0) &&
      Number(episode.episodeNumber || 0) === Number(currentItem.episodeNumber || 0),
  );

  return fallbackIndex > 0 ? episodes[fallbackIndex - 1] || null : null;
}

function isItemAllowedForProfile(item, profile) {
  if (!item) {
    return false;
  }

  // Sem perfil ou perfil sem limite / liberado (999 ou 999 em número)
  if (
    !profile ||
    profile.maxAgeRating == null ||
    profile.maxAgeRating === '' ||
    String(profile.maxAgeRating) === '999'
  ) {
    return true;
  }

  // Canais ao vivo liberados
  if (item.contentType === 'live') {
    return true;
  }

  // Aceita tanto ageRating (camelCase) quanto age_rating (snake_case)
  const rawRating = item.ageRating ?? item.age_rating;

  // Se não tem classificação definida, permite (igual ao SQL: age_rating IS NULL)
  if (rawRating == null || rawRating === '') {
    return true;
  }

  // Trata classificações como "L", "Livre" ou strings com texto (ex: "16+")
  const ratingStr = String(rawRating).trim().toUpperCase();
  if (ratingStr === 'L' || ratingStr === 'LIVRE' || ratingStr === '0') {
    return true;
  }

  // Extrai apenas os números (ex: "16+" vira 16)
  const itemAge = parseInt(ratingStr.replace(/\D/g, ''), 10);
  const maxAge = parseInt(String(profile.maxAgeRating).replace(/\D/g, ''), 10);

  // Se não conseguiu identificar o número, libera por padrão
  if (isNaN(itemAge) || isNaN(maxAge)) {
    return true;
  }

  return itemAge <= maxAge;
}

function SearchHistory({ items, onSelect, onRemove, onClear, emptyLabel = 'Nenhuma busca recente', visible }) {
  if (!visible) {
    return null;
  }

  if (!items.length) {
    return <div className="search-history-empty">{emptyLabel}</div>;
  }

  return (
    <div className="search-history-wrap">
      <div className="search-history" aria-label="Historico de buscas">
        {items.map((entry) => (
          <div key={entry} className="search-history-chip">
            <button
              type="button"
              className="search-history-select"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(entry)}
            >
              {entry}
            </button>
            <button
              type="button"
              className="search-history-remove"
              aria-label={`Remover ${entry} do historico`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRemove(entry)}
            >
              x
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="search-history-clear"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClear}
      >
        Limpar historico
      </button>
    </div>
  );
}

function NFIconRewind10({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden="true" className={className}>
      <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M28 17.5a10.1 10.1 0 1 0 3 7.4"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 13.5 L28 17.5 L21 21.5 Z"
        fill="currentColor"
      />
      <text
        x="26.6"
        y="31.6"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="16"
        fontWeight="800"
        fill="currentColor"
        textAnchor="middle"
        letterSpacing="-0.4"
      >
        10
      </text>
    </svg>
  );
}

function NFIconForward10({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden="true" className={className}>
      <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M20 17.5a10.1 10.1 0 0 1 11.1 10.1 10.1 10.1 0 0 1-8.1 9.8"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M27 13.5 L20 17.5 L27 21.5 Z"
        fill="currentColor"
      />
      <text
        x="21.2"
        y="31.6"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="16"
        fontWeight="800"
        fill="currentColor"
        textAnchor="middle"
        letterSpacing="-0.4"
      >
        10
      </text>
    </svg>
  );
}

function NFIconPrevEpisode({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="7" y="11" width="4.4" height="26" rx="1.4" />
      <path d="M39 12 L19.5 24 L39 36 Z" />
      <rect x="16" y="12" width="4.2" height="24" rx="1.4" opacity="0.9" />
    </svg>
  );
}

function NFIconNextEpisode({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="36.6" y="11" width="4.4" height="26" rx="1.4" />
      <path d="M9 12 L28.5 24 L9 36 Z" />
      <rect x="27.8" y="12" width="4.2" height="24" rx="1.4" opacity="0.9" />
    </svg>
  );
}

function NFIconPlay({ className }) {
  return (
    <svg viewBox="0 0 64 64" width="64" height="64" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M20 15 L54 32 L20 49 Z" />
    </svg>
  );
}

function NFIconPause({ className }) {
  return (
    <svg viewBox="0 0 64 64" width="64" height="64" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="15" y="13" width="12" height="38" rx="3" />
      <rect x="37" y="13" width="12" height="38" rx="3" />
    </svg>
  );
}

function NFIconVolume({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M6 20 H16 L26 12 V36 L16 28 H6 Z" fill="currentColor" stroke="none" />
      <path d="M32 15.5 C35.4 18.2 37.2 20.9 37.2 24 C37.2 27.1 35.4 29.8 32 32.5" />
      <path d="M35.5 11.2 C41.2 15.6 44.6 19.7 44.6 24 C44.6 28.3 41.2 32.4 35.5 36.8" opacity="0.7" />
    </svg>
  );
}

function NFIconMaximize({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M14 7 H7 V14" />
      <path d="M34 7 H41 V14" />
      <path d="M14 41 H7 V34" />
      <path d="M34 41 H41 V34" />
    </svg>
  );
}

function NFIconCC({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <rect x="4" y="9" width="40" height="30" rx="4" />
      <path d="M14.5 24 A5.5 5.5 0 1 1 20 31.6" />
      <path d="M20 16.4 A5.5 5.5 0 1 1 14.5 24" />
      <path d="M30.5 24 A5.5 5.5 0 1 1 36 31.6" />
      <path d="M36 16.4 A5.5 5.5 0 1 1 30.5 24" />
    </svg>
  );
}

function NFIconCCDisabled({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <rect x="4" y="9" width="40" height="30" rx="4" opacity="0.55" />
      <path d="M14.5 24 A5.5 5.5 0 1 1 20 31.6" opacity="0.55" />
      <path d="M20 16.4 A5.5 5.5 0 1 1 14.5 24" opacity="0.55" />
      <path d="M30.5 24 A5.5 5.5 0 1 1 36 31.6" opacity="0.55" />
      <path d="M36 16.4 A5.5 5.5 0 1 1 30.5 24" opacity="0.55" />
      <line x1="6" y1="8" x2="42" y2="40" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}

function NFIconAudioLang({ className }) {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M10 20 H20 L28 12 V36 L20 28 H10 Z" fill="currentColor" stroke="none" />
      <path d="M35.5 24 L39.5 20" />
      <path d="M35.5 24 L39.5 28" />
      <text
        x="34.6"
        y="43.2"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="8.5"
        fontWeight="800"
        fill="currentColor"
        stroke="none"
        textAnchor="middle"
        letterSpacing="0.2"
      >
        AUDIO
      </text>
    </svg>
  );
}

const FRONTEND_SENSITIVE_PATTERNS = [
  /username=[^&\s"'`]+/gi,
  /password=[^&\s"'`]+/gi,
  /api[_-]?key=[^&\s"'`]+/gi,
  /token=[^&\s"'`]+/gi,
  /getaddrinfo\s+ENOTFOUND\s+\S+/gi,
  /ETIMEDOUT\s+\S+/gi,
  /ECONNREFUSED\s+\S+/gi,
  /ECONNRESET\s+\S+/gi,
  /process\.env(\.|\[)/gi,
  /\.env/gi,
  /sqlite(_\w+)?/gi,
  /SQLITE_/gi,
  /\bSELECT\b.*\bFROM\b/gi,
  /\bINSERT INTO\b/gi,
  /\bDELETE FROM\b/gi,
  /\bUPDATE\b.*\bSET\b/gi,
  /dns\.phaptom\.shop/gi,
  /https?:\/\/[^\s"'`<>]+/gi,
];

function scrubErrorMessageFrontend(rawMessage) {
  if (rawMessage == null) return '';
  let text = String(rawMessage);
  for (const pattern of FRONTEND_SENSITIVE_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (/^(username|password|api[_-]?key|token)=/i.test(match)) {
        return `${match.split('=')[0]}=[OCULTO]`;
      }
      //if (/^getaddrinfo|^ETIMEDOUT|^ECONNREFUSED|^ECONNRESET/i.test(match)) {
      //  return '[ERRO_REDE_OCULTO]';
      //}
      if (/^https?:/i.test(match)) {
        return '[URL_OCULTA]';
      }
      return '[OCULTO]';
    });
  }
  return text;
}

async function requestJson(url, options) {
  const safeOptions = options || {};
  const finalHeaders = safeOptions.headers || {};
  const hasJsonBody =
    safeOptions.body &&
    typeof safeOptions.body === 'string' &&
    safeOptions.method &&
    String(safeOptions.method).toUpperCase() !== 'GET';
  const mergedHeaders = hasJsonBody
    ? {
        'Content-Type': 'application/json',
        ...finalHeaders,
      }
    : finalHeaders;

  const response = await fetch(url, {
    ...safeOptions,
    credentials: 'include',
    headers: mergedHeaders,
  });

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    let preview = '';
    try {
      preview = await response.text();
    } catch {
      preview = '';
    }
    const isHtml = contentType.includes('text/html') || preview.trim().startsWith('<');
    if (isHtml) {
      if (response.status === 401) {
        throw new Error('Sessao expirada. Faca login novamente.');
      }
      throw new Error(
        'O servidor nao esta respondendo como API. Verifique se o backend esta rodando na porta 8787 antes de acessar.',
      );
    }
    if (response.status === 401) {
      throw new Error('Sessao expirada. Faca login novamente.');
    }
    throw new Error('Resposta invalida do servidor.');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    if (response.status === 401) {
      throw new Error('Sessao expirada. Faca login novamente.');
    }
    throw new Error('Resposta JSON invalida do servidor.');
  }

  if (!response.ok || !payload.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('iptv:force-logout'));
    }
    const serverMessage = scrubErrorMessageFrontend(payload.message || '');
    if (!serverMessage || /\[OCULTO\]|\[URL_OCULTA\]|\[ERRO_REDE_OCULTO\]/.test(serverMessage)) {
      // Se a mensagem parecia vazia ou soh scrub, retorna generica:
      throw new Error('Falha na comunicacao com o servidor. Tente novamente em instantes.');
    }
    throw new Error(serverMessage);
  }

  return payload;
}

function ItemCard({ item, favorite, watchLater, recommended, onFavorite, onWatchLater, onRecommend, watched, onPlay }) {
  const isSeriesGroup = item.itemType === 'series_group';
  const meta = isSeriesGroup
    ? [
        item.category,
        item.seasonCount ? `${item.seasonCount} temporadas` : '',
        item.episodeCount ? `${item.episodeCount} episodios` : '',
      ].filter(Boolean).join(' • ')
    : [item.category, item.year, item.genre].filter(Boolean).join(' • ');

  return (
    <article className="media-card">
      <div
        className="media-thumb"
        onClick={() => onPlay(item)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            onPlay(item);
          }
        }}
      >
        {item.poster ? (
          <img src={item.poster} alt={item.name} loading="lazy" />
        ) : (
          <div className="media-placeholder">{item.name.slice(0, 2).toUpperCase()}</div>
        )}
        {watched && !isSeriesGroup && <span className="watched-badge">Assistido</span>}
        <div className="media-thumb-actions">
          <button
            type="button"
            className={`media-icon-btn ${favorite ? 'is-active is-favorite' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
                  event.preventDefault();
              event.stopPropagation();
              onFavorite(item.id);
            }}
            aria-label={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
            aria-pressed={favorite}
            title={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
          >
            {favorite ? '★' : '☆'}
          </button>
          <button
            type="button"
            className={`media-icon-btn ${watchLater ? 'is-active is-watch-later' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
                  event.preventDefault();
              event.stopPropagation();
              onWatchLater(item.id);
            }}
            aria-label={watchLater ? 'Remover de assistir mais tarde' : 'Adicionar em assistir mais tarde'}
            aria-pressed={watchLater}
            title={watchLater ? 'Remover de assistir mais tarde' : 'Adicionar em assistir mais tarde'}
          >
                {watchLater ? '◴' : '◷'}
          </button>
          <button
            type="button"
            className={`media-icon-btn ${recommended ? 'is-active is-recommendation' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRecommend(item);
            }}
            aria-label={recommended ? 'Remover indicacao' : 'Indicar para outros perfis'}
            aria-pressed={recommended}
            title={recommended ? 'Remover indicacao' : 'Indicar para outros perfis'}
          >
            ✦
          </button>
        </div>
      </div>
      <div className="media-meta">
        <h3>{item.name}</h3>
        <p>{meta || item.category || 'Sem categoria'}</p>
        {item.matchInfo?.label && <em className="match-reason">{item.matchInfo.label}</em>}
        <span>
          {isSeriesGroup ? 'Serie' : item.contentType === 'live' ? 'Ao vivo' : item.contentType === 'movie' ? 'Filme' : 'Serie'}
        </span>
      </div>
    </article>
  );
}

function ContinueWatchingCard({ item, progressEntry, watched, onPlay, onRemove }) {
  const progressPercent = progressEntry?.duration > 0
    ? Math.min(100, Math.max(0, (Number(progressEntry.position || 0) / Number(progressEntry.duration)) * 100))
    : 0;
  const meta = [
    item.category,
    formatEpisodeLabel(item),
    item.episodeTitle || item.year || item.genre,
  ].filter(Boolean).join(' • ');

  return (
    <article className="continue-card">
      <button type="button" className="continue-thumb" onClick={() => onPlay(item)}>
        {item.poster ? (
          <img src={item.poster} alt={item.name} loading="lazy" />
        ) : (
          <div className="media-placeholder">{item.name.slice(0, 2).toUpperCase()}</div>
        )}
        {watched && <span className="watched-badge">Assistido</span>}
      </button>

      <div className="continue-body">
        <strong>{item.name}</strong>
        <span>{meta || 'Sem detalhes extras'}</span>
        <small>Retomar em {formatDuration(progressEntry?.position || 0)}</small>
        <div className="continue-progress" aria-hidden="true">
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="continue-actions">
          <button type="button" className="primary-btn" onClick={() => onPlay(item)}>
            Retomar
          </button>
          <button type="button" className="ghost-btn" onClick={() => onRemove(item.id)}>
            Excluir
          </button>
</div>
      </div>
    </article>
  );
}

function SyncConfirmModal({
  onClose,
  onConfirm,
  captchaPrompt,
  captchaValue,
  onCaptchaChange,
  syncLoading,
  captchaError,
}) {
  return (
    <div className="player-overlay" role="dialog" aria-modal="true">
      <div className="confirm-modal">
        <div className="player-header">
          <div>
            <h2>Confirmar recarga do catalogo</h2>
            <p>Essa acao pode demorar bastante porque baixa a lista novamente e recria o banco local.</p>
          </div>
          <button type="button" className="ghost-btn" onClick={onClose} disabled={syncLoading}>
            Fechar
          </button>
        </div>

        <div className="confirm-body">
          <strong>Captcha simples</strong>
          <span>{captchaPrompt}</span>
          <input
            value={captchaValue}
            onChange={(event) => onCaptchaChange(event.target.value)}
            placeholder="Digite a resposta"
            inputMode="numeric"
            autoFocus
          />
          {captchaError && <div className="inline-alert modal-alert">{captchaError}</div>}
        </div>

        <div className="confirm-actions">
          <button type="button" className="ghost-btn" onClick={onClose} disabled={syncLoading}>
            Cancelar
          </button>
          <button type="button" className="primary-btn" onClick={onConfirm} disabled={syncLoading}>
            {syncLoading ? 'Sincronizando...' : 'Confirmar e recarregar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileManagerModal({
  profiles,
  activeProfileId,
  onClose,
  onSelectProfile,
  onAddProfile,
  onUpdateProfileAge,
  onEditProfile,
  onDeleteProfile,
  onEditUser,
  authUser,
  profileCountMax,
}) {
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileAge, setNewProfileAge] = useState('');
  const profileCount = Array.isArray(profiles) ? profiles.length : 0;

  return (
    <div className="player-overlay" role="dialog" aria-modal="true">
      <div className="confirm-modal profile-modal">
        <div className="player-header">
          <div className="profile-manager-head-row">
            {authUser?.foto ? (
              <button type="button" className="user-chip-avatar is-small" onClick={onEditUser} title="Editar conta">
                <img src={authUser.foto} alt="Foto do usuario" />
              </button>
            ) : (
              <button type="button" className="user-chip-avatar is-small" onClick={onEditUser} title="Editar conta">
                <span style={{ background: '#4338ca' }}>
                  {String(authUser?.nome || 'U').slice(0, 2).toUpperCase()}
                </span>
              </button>
            )}
            <div>
              <h2>Gerenciar perfis</h2>
              <p>Edite foto, nome, idade de cada perfil, ou atualize os dados da sua conta.</p>
            </div>
          </div>
          <div className="player-header-actions">
            <button type="button" className="ghost-btn" onClick={onEditUser}>
              Editar conta
            </button>
            <button type="button" className="ghost-btn" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>

        <div className="profile-list">
          {profiles.map((profile) => (
            <div key={profile.id} className={`profile-item ${profile.id === activeProfileId ? 'is-active' : ''}`}>
              <div className="profile-item-copy">
                {profile.avatar ? (
                  <div className="profile-item-avatar has-image">
                    <img src={profile.avatar} alt={`Avatar de ${profile.name}`} />
                  </div>
                ) : (
                  <div className="profile-item-avatar" style={{ background: profile.color || '#7c3aed' }}>
                    <span>{String(profile.name || '?').slice(0, 2).toUpperCase()}</span>
                  </div>
                )}
                <div>
                  <strong>{profile.name}</strong>
                  <span>{formatProfileAgeLabel(profile.maxAgeRating)}</span>
                  {profile.id === activeProfileId && <small>Perfil em uso agora</small>}
                </div>
              </div>

              <div className="profile-item-actions">
                <select
                  value={profile.maxAgeRating == null ? '' : String(profile.maxAgeRating)}
                  onChange={(event) => onUpdateProfileAge(profile.id, event.target.value)}
                >
                  <option value="">Sem restricao</option>
                  {PROFILE_AGE_OPTIONS.filter(Boolean).map((option) => (
                    <option key={option} value={option}>
                      Ate {option} anos
                    </option>
                  ))}
                </select>
                <button type="button" className="ghost-btn" onClick={() => onEditProfile(profile)} title="Editar foto, nome e idade">
                  Editar
                </button>
                {profileCount > 1 && (
                  <button
                    type="button"
                    className="ghost-btn is-danger"
                    onClick={() => onDeleteProfile(profile.id)}
                    title="Excluir perfil"
                  >
                    Excluir
                  </button>
                )}
                <button type="button" className={profile.id === activeProfileId ? 'primary-btn is-soft' : 'primary-btn'} onClick={() => onSelectProfile(profile.id)} disabled={profile.id === activeProfileId}>
                  {profile.id === activeProfileId ? 'Em uso' : 'Usar perfil'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {profileCount < (profileCountMax || 5) ? (
          <div className="profile-create">
            <strong>Criar novo perfil</strong>
            <span className="profile-create-hint">{(profileCountMax || 5) - profileCount} perfil(is) restante(s)</span>
            <div className="profile-create-grid">
              <input
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
                placeholder="Nome do perfil"
              />
              <select value={newProfileAge} onChange={(event) => setNewProfileAge(event.target.value)}>
                <option value="">Sem restricao</option>
                {PROFILE_AGE_OPTIONS.filter(Boolean).map((option) => (
                  <option key={option} value={option}>
                    Ate {option} anos
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  if (!newProfileName.trim()) {
                    return;
                  }

                  const created = onAddProfile(newProfileName.trim(), newProfileAge);
                  if (created) {
                    setNewProfileName('');
                    setNewProfileAge('');
                  }
                }}
              >
                Criar perfil
              </button>
            </div>
          </div>
        ) : (
          <div className="profile-create is-locked">
            <strong>Limite de perfis atingido</strong>
            <p>Exclua um perfil existente para criar um novo.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function CatalogManagerModal({ onClose, activeProfileId, profiles, userCatalogLimit }) {
  const [catalogs, setCatalogs] = useState([]);
  const [publicCatalogs, setPublicCatalogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [publicLoading, setPublicLoading] = useState(false);
  const [error, setError] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addModalMode, setAddModalMode] = useState('form');
  const [form, setForm] = useState({ name: '', baseUrl: '', username: '', password: '', output: 'm3u8', url: '' });
  const [provider, setProvider] = useState({ baseUrl: '', username: '', hasPassword: false });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [useCustomUrl, setUseCustomUrl] = useState(false);

  const loadCatalogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catalogsPayload, providerPayload] = await Promise.all([
        requestJson('/api/catalogs'),
        requestJson('/api/catalogs/provider').catch(() => null),
      ]);
      setCatalogs(Array.isArray(catalogsPayload.catalogs) ? catalogsPayload.catalogs : []);

      if (providerPayload?.provider) {
        const info = providerPayload.provider;
        setProvider(info);
        setForm((current) => ({
          ...current,
          baseUrl: current.baseUrl || info.baseUrl || '',
          username: current.username || info.username || '',
        }));
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPublicCatalogs = useCallback(async () => {
    setPublicLoading(true);
    try {
      const payload = await requestJson('/api/catalogs/public');
      setPublicCatalogs(Array.isArray(payload.catalogs) ? payload.catalogs : []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPublicLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalogs();
  }, [loadCatalogs]);

  function updateForm(patch) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function submitCatalog(event) {
    event.preventDefault();
    const customUrl = form.url.trim();
    const baseUrl = form.baseUrl.trim();
    const username = form.username.trim();

    if (!customUrl && (!baseUrl || !username)) {
      setFormError('Preencha base URL, usuario e senha, ou informe um link xc:// / get.php / xmltv.php.');
      return;
    }
    if (!customUrl && !form.password.trim() && !provider.hasPassword) {
      setFormError('Informe a senha do provedor.');
      return;
    }

    setFormError('');
    setSaving(true);
    try {
      const payload = await requestJson('/api/catalogs', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          url: customUrl,
          baseUrl,
          username,
          password: form.password.trim(),
          output: form.output,
        }),
      });
      setCatalogs((current) => [payload.catalog, ...current]);
      setForm((current) => ({ ...current, name: '', url: '' }));
      setAddModalOpen(false);
    } catch (requestError) {
      setFormError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function useCatalog(catalogId) {
    setBusyId(catalogId);
    setError('');
    try {
      const payload = await requestJson(`/api/catalogs/${encodeURIComponent(catalogId)}/use`, {
        method: 'POST',
        body: JSON.stringify({ profileId: activeProfileId }),
      });
      setCatalogs((current) => current.map((entry) => (entry.id === payload.catalog.id ? payload.catalog : entry)));
      onClose();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId('');
    }
  }

  async function retryCatalog(catalogId) {
    setBusyId(catalogId);
    setError('');
    try {
      const payload = await requestJson(`/api/catalogs/${encodeURIComponent(catalogId)}/retry`, {
        method: 'POST',
      });
      setCatalogs((current) => current.map((entry) => (entry.id === payload.catalog.id ? payload.catalog : entry)));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId('');
    }
  }

  async function removeCatalog(catalogId) {
    setBusyId(catalogId);
    setError('');
    try {
      await requestJson(`/api/catalogs/${encodeURIComponent(catalogId)}`, { method: 'DELETE' });
      setCatalogs((current) => current.filter((entry) => entry.id !== catalogId));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId('');
    }
  }

  async function togglePublic(catalogId, currentIsPublic) {
    setBusyId(catalogId);
    setError('');
    try {
      const payload = await requestJson(`/api/catalogs/${encodeURIComponent(catalogId)}/toggle-public`, {
        method: 'POST',
      });
      setCatalogs((current) => current.map((entry) => (entry.id === payload.catalog.id ? payload.catalog : entry)));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId('');
    }
  }

  function openAddModal() {
    setForm({ name: '', baseUrl: '', username: '', password: '', output: 'm3u8', url: '' });
    setFormError('');
    setUseCustomUrl(false);
    setAddModalMode('form');
    setAddModalOpen(true);
  }

  function closeAddModal() {
    setAddModalOpen(false);
  }

  const canAddCatalog = catalogs.length < (userCatalogLimit || 5);

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-panel is-catalog-manager" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header className="modal-head">
            <div>
              <h2>Meus catalogos</h2>
              <p>Baixe e guarde varias listas M3U. Se uma forma de download falhar, o sistema tenta alternativas automaticamente.</p>
            </div>
            <button type="button" className="ghost-btn" onClick={onClose}>
              Fechar
            </button>
          </header>

          {error && <div className="inline-alert">{error}</div>}

          <div className="catalog-list">
            {loading ? (
              <div className="empty-state compact">
                <strong>Carregando catalogos...</strong>
              </div>
            ) : catalogs.length === 0 ? (
              <div className="empty-state compact">
                <strong>Nenhuma lista ainda</strong>
                <span>Clique em "Adicionar catalogo" para comecar.</span>
              </div>
            ) : (
              catalogs.map((catalog) => (
                <div key={catalog.id} className={`catalog-card is-${catalog.status}`}>
                  <div className="catalog-card-header">
                    <div className="catalog-card-title">
                      <strong>{catalog.name}</strong>
                      <span className={`catalog-status is-${catalog.status}`}>{catalogStatusLabel(catalog.status)}</span>
                      {catalog.isPublic && <span className="catalog-badge is-public">Publico</span>}
                    </div>
                  </div>

                  <div className="catalog-card-info">
                    {catalog.url && (
                      <small className="catalog-card-url">{catalog.url}</small>
                    )}

                    {catalog.status === 'ok' && (
                      <div className="catalog-card-stats">
                        <span>{statLabel(catalog.liveCount, 'canal', 'canais')}</span>
                        <span>{statLabel(catalog.movieCount, 'filme', 'filmes')}</span>
                        <span>{statLabel(catalog.seriesCount, 'serie', 'series')}</span>
                      </div>
                    )}

                    {catalog.status === 'error' && (
                      <span className="catalog-card-error">
                        {catalog.error || 'Nao foi possivel baixar esta lista.'}
                      </span>
                    )}

                    {catalog.status === 'pending' && (
                      <span className="catalog-card-hint">Baixando lista...</span>
                    )}

                    <small className="catalog-card-date">
                      {catalog.lastSyncAt ? `Baixada em ${formatDate(catalog.lastSyncAt)}` : `Adicionada em ${formatDate(catalog.createdAt)}`}
                    </small>
                  </div>

                  <div className="catalog-card-actions">
                    {catalog.status === 'ok' && (
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => useCatalog(catalog.id)}
                        disabled={busyId === catalog.id}
                      >
                        {busyId === catalog.id ? 'Carregando...' : 'Usar catalogo'}
                      </button>
                    )}
                    {catalog.status !== 'pending' && (
                      <button
                        type="button"
                        className={catalog.status === 'error' ? 'primary-btn' : 'ghost-btn'}
                        onClick={() => retryCatalog(catalog.id)}
                        disabled={busyId === catalog.id}
                      >
                        {busyId === catalog.id
                          ? 'Baixando...'
                          : catalog.status === 'error'
                            ? 'Tentar novamente'
                            : 'Atualizar'}
                      </button>
                    )}
                    {catalog.status === 'ok' && (
                      <button
                        type="button"
                        className={`ghost-btn ${catalog.isPublic ? 'is-danger' : ''}`}
                        onClick={() => togglePublic(catalog.id, catalog.isPublic)}
                        disabled={busyId === catalog.id}
                      >
                        {busyId === catalog.id ? '...' : (catalog.isPublic ? 'Tornar privado' : 'Tornar publico')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost-btn is-danger"
                      onClick={() => removeCatalog(catalog.id)}
                      disabled={busyId === catalog.id}
                    >
                      Remover
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {canAddCatalog && (
            <div className="catalog-add-button-wrap">
              <button type="button" className="primary-btn is-wide" onClick={openAddModal}>
                Adicionar catalogo
              </button>
            </div>
          )}

          {!canAddCatalog && catalogs.length > 0 && (
            <div className="catalog-limit-reached">
              <strong>Limite de catalogos atingido</strong>
              <p>Voce atingiu o limite de {userCatalogLimit || 5} catalogos. Remova um catalogo para adicionar outro.</p>
            </div>
          )}

          <div className="catalog-public-section">
            <div className="catalog-public-header">
              <h3>Catalogos publicos</h3>
              <button
                type="button"
                className="ghost-btn"
                onClick={loadPublicCatalogs}
                disabled={publicLoading}
              >
                {publicLoading ? 'Carregando...' : 'Buscar catalogos publicos'}
              </button>
            </div>
            {publicCatalogs.length > 0 && (
              <div className="catalog-public-list">
                {publicCatalogs.map((catalog) => (
                  <div key={catalog.id} className={`catalog-card is-${catalog.status} is-public-catalog`}>
                    <div className="catalog-card-header">
                      <div className="catalog-card-title">
                        <strong>{catalog.name}</strong>
                        <span className={`catalog-status is-${catalog.status}`}>{catalogStatusLabel(catalog.status)}</span>
                        <span className="catalog-badge is-public">Publico</span>
                      </div>
                    </div>

                    <div className="catalog-card-info">
                      {catalog.url && (
                        <small className="catalog-card-url">{catalog.url}</small>
                      )}

                      {catalog.status === 'ok' && (
                        <div className="catalog-card-stats">
                          <span>{statLabel(catalog.liveCount, 'canal', 'canais')}</span>
                          <span>{statLabel(catalog.movieCount, 'filme', 'filmes')}</span>
                          <span>{statLabel(catalog.seriesCount, 'serie', 'series')}</span>
                        </div>
                      )}

                      <small className="catalog-card-date">
                        {catalog.lastSyncAt ? `Baixada em ${formatDate(catalog.lastSyncAt)}` : `Adicionada em ${formatDate(catalog.createdAt)}`}
                      </small>
                      {catalog.ownerName && (
                        <small className="catalog-card-owner">Dono: {catalog.ownerName}</small>
                      )}
                    </div>

                    <div className="catalog-card-actions">
                      {catalog.status === 'ok' && (
                        <button
                          type="button"
                          className="primary-btn"
                          onClick={() => useCatalog(catalog.id)}
                          disabled={busyId === catalog.id}
                        >
                          {busyId === catalog.id ? 'Carregando...' : 'Usar catalogo'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {addModalOpen && (
        <div className="modal-overlay" onClick={closeAddModal}>
          <div className="modal-panel is-catalog-add" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <header className="modal-head">
              <div>
                <h2>Adicionar catalogo</h2>
                <p>Escolha como deseja adicionar a lista.</p>
              </div>
              <button type="button" className="ghost-btn" onClick={closeAddModal}>
                Fechar
              </button>
            </header>

            <div className="catalog-add-mode-toggle">
              <button
                type="button"
                className={addModalMode === 'form' ? 'is-active' : ''}
                onClick={() => setAddModalMode('form')}
              >
                Formulario
              </button>
              <button
                type="button"
                className={addModalMode === 'link' ? 'is-active' : ''}
                onClick={() => setAddModalMode('link')}
              >
                Link direto
              </button>
            </div>

            {formError && <div className="inline-alert">{formError}</div>}

            {addModalMode === 'form' && (
              <form className="catalog-add-form" onSubmit={submitCatalog}>
                <div className="catalog-form-grid">
                  <label className="auth-field">
                    <span>Nome da lista (opcional)</span>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(event) => updateForm({ name: event.target.value })}
                      placeholder="Ex.: Provedor principal"
                      disabled={saving}
                    />
                  </label>
                  <label className="auth-field">
                    <span>Base URL do provedor</span>
                    <input
                      type="text"
                      value={form.baseUrl}
                      onChange={(event) => updateForm({ baseUrl: event.target.value })}
                      placeholder="http://seu-servidor-iptv"
                      disabled={saving || useCustomUrl}
                    />
                  </label>
                  <label className="auth-field">
                    <span>Usuario</span>
                    <input
                      type="text"
                      value={form.username}
                      onChange={(event) => updateForm({ username: event.target.value })}
                      placeholder="usuario do provedor"
                      disabled={saving || useCustomUrl}
                    />
                  </label>
                  <label className="auth-field">
                    <span>Senha</span>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => updateForm({ password: event.target.value })}
                      placeholder={provider.hasPassword ? 'Usar a senha do sistema' : 'senha do provedor'}
                      disabled={saving || useCustomUrl}
                      autoComplete="off"
                    />
                  </label>
                  <label className="auth-field">
                    <span>Saida da lista</span>
                    <select
                      value={form.output}
                      onChange={(event) => updateForm({ output: event.target.value })}
                      disabled={saving || useCustomUrl}
                    >
                      <option value="m3u8">m3u8 (HLS)</option>
                      <option value="ts">ts (MPEG-TS)</option>
                    </select>
                  </label>
                </div>

                {provider.hasPassword && !form.password.trim() && !useCustomUrl && (
                  <small className="catalog-form-hint">Deixe a senha vazia para usar a senha configurada no sistema.</small>
                )}

                <div className="modal-actions">
                  <button type="submit" className="primary-btn" disabled={saving}>
                    {saving ? 'Baixando lista...' : 'Baixar lista'}
                  </button>
                </div>
              </form>
            )}

            {addModalMode === 'link' && (
              <form className="catalog-add-form" onSubmit={submitCatalog}>
                <div className="catalog-form-grid">
                  <label className="auth-field">
                    <span>Nome da lista (opcional)</span>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(event) => updateForm({ name: event.target.value })}
                      placeholder="Ex.: Provedor principal"
                      disabled={saving}
                    />
                  </label>
                  <label className="auth-field is-full-width">
                    <span>Link Xtream / M3U / M3U8</span>
                    <input
                      type="text"
                      value={form.url}
                      onChange={(event) => updateForm({ url: event.target.value })}
                      placeholder="xc://usuario:senha@host/streaming=ts ou https://exemplo.com/lista.m3u8"
                      disabled={saving}
                    />
                  </label>
                </div>

                <small className="catalog-form-hint">
                  Aceita links xc://, get.php, xmltv.php ou uma URL M3U/M3U8 direta.
                </small>

                <div className="modal-actions">
                  <button type="submit" className="primary-btn" disabled={saving}>
                    {saving ? 'Baixando lista...' : 'Baixar lista'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function UserManagerModal({ onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ nome: '', email: '', contato: '', username: '', password: '', tipo: 'usuario', plano: 'free', profileLimit: 5, catalogLimit: 5 });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [userFormModalOpen, setUserFormModalOpen] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await requestJson('/api/users?scope=all');
      setUsers(Array.isArray(payload.users) ? payload.users : []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  function updateForm(patch) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function submitUser(event) {
    event.preventDefault();
    const username = form.username.trim();
    const password = form.password.trim();
    const nome = form.nome.trim();

    if (!username || !password || !nome) {
      setFormError('Usuario, senha e nome sao obrigatorios.');
      return;
    }

    setFormError('');
    setSaving(true);
    try {
      const url = editingId ? `/api/users/${encodeURIComponent(editingId)}` : '/api/users';
      const method = editingId ? 'PUT' : 'POST';
      const body = editingId
        ? { nome: form.nome.trim(), email: form.email.trim(), contato: form.contato.trim(), tipo: form.tipo, plano: form.plano, profileLimit: Number(form.profileLimit) || 5, catalogLimit: Number(form.catalogLimit) || 5 }
        : { nome, username, password, email: form.email.trim(), contato: form.contato.trim(), tipo: form.tipo, plano: form.plano, profileLimit: Number(form.profileLimit) || 5, catalogLimit: Number(form.catalogLimit) || 5 };
      const payload = await requestJson(url, {
        method,
        body: JSON.stringify(body),
      });
      setUsers((current) => editingId
        ? current.map((u) => (u.id === editingId ? payload.user : u))
        : [payload.user, ...current]);
      setForm({ nome: '', email: '', contato: '', username: '', password: '', tipo: 'usuario', plano: 'free', profileLimit: 5, catalogLimit: 5 });
      setEditingId(null);
      setUserFormModalOpen(false);
    } catch (requestError) {
      setFormError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleUserStatus(userId, currentActive) {
    setBusyId(userId);
    setError('');
    try {
      const payload = await requestJson(`/api/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ativo: !currentActive }),
      });
      setUsers((current) => current.map((u) => (u.id === userId ? payload.user : u)));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId('');
    }
  }

  async function removeUser(userId) {
    if (!confirm('Tem certeza que deseja excluir este usuario? Todos os perfis e catalogos vinculados serao removidos.')) {
      return;
    }
    setBusyId(userId);
    setError('');
    try {
      await requestJson(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      setUsers((current) => current.filter((u) => u.id !== userId));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId('');
    }
  }

  function openEdit(user) {
    setEditingId(user.id);
    setForm({
      nome: user.nome || '',
      email: user.email || '',
      contato: user.contato || '',
      username: user.username || '',
      password: '',
      tipo: user.tipo || 'usuario',
      plano: user.plano || 'free',
      profileLimit: user.profileLimit ?? 5,
      catalogLimit: user.catalogLimit ?? 5,
    });
    setFormError('');
    setUserFormModalOpen(true);
  }

  function openCreate() {
    setEditingId(null);
    setForm({ nome: '', email: '', contato: '', username: '', password: '', tipo: 'usuario', plano: 'free', profileLimit: 5, catalogLimit: 5 });
    setFormError('');
    setUserFormModalOpen(true);
  }

  function closeUserFormModal() {
    setUserFormModalOpen(false);
    setEditingId(null);
    setForm({ nome: '', email: '', contato: '', username: '', password: '', tipo: 'usuario', plano: 'free', profileLimit: 5, catalogLimit: 5 });
    setFormError('');
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel is-user-manager" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div>
            <h2>Gerenciar clientes</h2>
            <p>Crie, edite e controle o acesso dos usuarios do sistema.</p>
          </div>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Fechar
          </button>
        </header>

        {error && <div className="inline-alert">{error}</div>}

        <div className="user-list-header">
          <h3>Usuarios</h3>
          <button type="button" className="primary-btn" onClick={openCreate} disabled={loading}>
            Criar usuario
          </button>
        </div>

        <div className="user-list">
          {loading ? (
            <div className="empty-state compact">
              <strong>Carregando usuarios...</strong>
            </div>
          ) : users.length === 0 ? (
            <div className="empty-state compact">
              <strong>Nenhum usuario ainda</strong>
              <span>Clique em "Criar usuario" para comecar.</span>
            </div>
          ) : (
            users.map((user) => (
              <div key={user.id} className={`user-card ${!user.ativo ? 'is-inactive' : ''}`}>
                <div className="user-card-info">
                  <div className="user-card-main">
                    <strong>{user.nome}</strong>
                    <span className="user-card-username">@{user.username}</span>
                  </div>
                  <div className="user-card-meta">
                    {user.email && <span>{user.email}</span>}
                    {user.contato && <span>{user.contato}</span>}
                    <span className={`user-badge is-${user.tipo}`}>{user.tipo === 'admin' ? 'Admin' : 'Usuario'}</span>
                    <span className="user-badge is-plano">{user.plano || 'free'}</span>
                    <span>Perfis: {user.profileLimit ?? 5}</span>
                    <span>Catalogos: {user.catalogLimit ?? 5}</span>
                    <small>{user.ativo ? 'Ativo' : 'Inativo'}</small>
                  </div>
                </div>

                <div className="user-card-actions">
                  <button
                    type="button"
                    className={user.ativo ? 'ghost-btn is-danger' : 'primary-btn'}
                    onClick={() => toggleUserStatus(user.id, user.ativo)}
                    disabled={busyId === user.id}
                  >
                    {busyId === user.id ? '...' : (user.ativo ? 'Desativar' : 'Ativar')}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => openEdit(user)}
                    disabled={busyId === user.id}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="ghost-btn is-danger"
                    onClick={() => removeUser(user.id)}
                    disabled={busyId === user.id}
                  >
                    Excluir
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SeriesDetailsModal({ seriesKey, onClose, onPlay, playbackProgress, watchedMap, profileAgeLimit, onCastOpen, catalogId }) {
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedSeason, setSelectedSeason] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadSeriesDetails() {
      setLoading(true);
      setError('');

      try {
        const ageParam = profileAgeLimit == null ? '' : `?maxAgeRating=${encodeURIComponent(profileAgeLimit)}`;
        const catalogParam = catalogId ? `&catalogId=${encodeURIComponent(catalogId)}` : '';
        const payload = await requestJson(`/api/series/${encodeURIComponent(seriesKey)}${ageParam}${catalogParam}`);
        if (cancelled) {
          return;
        }

        setDetails(payload);
        const firstSeason = payload.seasons?.[0];
        setSelectedSeason(firstSeason ? String(firstSeason.seasonNumber) : '');
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSeriesDetails();

    return () => {
      cancelled = true;
    };
  }, [profileAgeLimit, seriesKey]);

  const activeSeason = useMemo(
    () => details?.seasons?.find((season) => String(season.seasonNumber) === selectedSeason) || details?.seasons?.[0],
    [details, selectedSeason],
  );

  return (
    <div className="player-overlay" role="dialog" aria-modal="true">
      <div className="series-modal">
        <div className="player-header">
          <div>
            <h2>{details?.series?.name || 'Serie'}</h2>
            <p>{details?.series?.category || 'Carregando detalhes da serie'}</p>
          </div>
          <div className="player-header-actions">
            {onCastOpen && details?.series?.name && (
              <button
                type="button"
                className="ghost-btn cast-inline-btn"
                onClick={() => onCastOpen(details.series.name, 'series')}
              >
                <span className="cast-icon" aria-hidden>★</span>
                <span>Elenco</span>
              </button>
            )}
            <button type="button" className="ghost-btn" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>

        {loading && <div className="player-state">Carregando episodios...</div>}
        {error && !loading && <div className="player-state is-error">{error}</div>}

        {!loading && !error && details && (
          <div className="series-layout">
            <div className="series-summary">
              {details.series.poster ? (
                <img src={details.series.poster} alt={details.series.name} className="series-poster" />
              ) : (
                <div className="series-poster series-poster-fallback">{details.series.name.slice(0, 2).toUpperCase()}</div>
              )}
              <div className="series-summary-copy">
                <strong>{details.series.name}</strong>
                <span>{[details.series.genre, details.series.year].filter(Boolean).join(' • ') || details.series.category}</span>
                <span>{details.series.seasonCount} temporadas • {details.series.episodeCount} episodios</span>
                {details.series.plot && <p>{details.series.plot}</p>}
              </div>
            </div>

            <div className="season-toolbar">
              <label>
                <span>Temporada</span>
                <select value={selectedSeason} onChange={(event) => setSelectedSeason(event.target.value)}>
                  {details.seasons.map((season) => (
                    <option key={season.seasonNumber} value={season.seasonNumber}>
                      {season.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="episode-list">
              {activeSeason?.episodes.map((episode) => {
                const resumeEntry = playbackProgress[episode.id];
                const episodeLabel = formatEpisodeLabel(episode);
                const watched = Boolean(watchedMap[episode.id]);
                return (
                  <button
                    key={episode.id}
                    type="button"
                    className="episode-item"
                    onClick={() => onPlay(episode)}
                  >
                    <div className="episode-art">
                      {episode.poster ? (
                        <img src={episode.poster} alt={episode.episodeTitle || episode.name} />
                      ) : (
                        <div className="episode-art-fallback">{(episodeLabel || episode.name).slice(0, 2).toUpperCase()}</div>
                      )}
                    </div>
                    <div className="episode-copy">
                      <strong>{episodeLabel || episode.name}</strong>
                      <span>{episode.episodeTitle || episode.name}</span>
                      <small>{episode.category}</small>
                    </div>
                    <div className="episode-meta">
                      {watched && <span className="episode-badge watched">Assistido</span>}
                      {resumeEntry?.position > 30 && <span>Continuar em {formatDuration(resumeEntry.position)}</span>}
                      {episode.ageRating != null && <small>Faixa: {episode.ageRating}+</small>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CastModal({ loading, error, data, onClose }) {
  const cast = data?.cast || [];
  const directors = data?.directors || [];
  const writers = data?.writers || [];
  const hasAny = cast.length || directors.length || writers.length;

  return (
    <div className="player-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="series-modal cast-modal" onClick={(e) => e.stopPropagation()}>
        <div className="player-header">
          <div>
            <h2>Elenco</h2>
            <p>{data?.title || loading ? 'Consultando Google...' : 'Sem informacao'}</p>
          </div>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Fechar
          </button>
        </div>

        {loading && (
          <div className="player-state cast-loading">
            <div className="loading-spinner" aria-hidden="true" />
            <span>Buscando informacoes no Google...</span>
          </div>
        )}

        {!loading && error && (
          <div className="player-state is-error">
            <strong>Ops.</strong>
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && data?.summary && (
          <div className="cast-summary">
            <p>{data.summary}</p>
          </div>
        )}

        {!loading && !error && !hasAny && (
          <div className="player-state">
            Nao foi possivel extrair o elenco do resultado da busca do Google.
          </div>
        )}

        {!loading && !error && directors.length > 0 && (
          <section className="cast-section">
            <h3>Direcao / Criacao</h3>
            <div className="cast-chip-grid">
              {directors.map((person, idx) => (
                <div key={`dir-${idx}-${person.name}`} className="cast-chip">
                  <strong>{person.name}</strong>
                  {person.role && <span>{person.role}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {!loading && !error && writers.length > 0 && (
          <section className="cast-section">
            <h3>Roteiro</h3>
            <div className="cast-chip-grid">
              {writers.map((person, idx) => (
                <div key={`wrt-${idx}-${person.name}`} className="cast-chip">
                  <strong>{person.name}</strong>
                  {person.role && <span>{person.role}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {!loading && !error && cast.length > 0 && (
          <section className="cast-section">
            <h3>Elenco principal</h3>
            <div className="cast-grid">
              {cast.map((person, idx) => (
                <div key={`cast-${idx}-${person.name}`} className="cast-card">
                  <div className="cast-avatar">
                    <strong aria-hidden>
                      {person.name
                        .trim()
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part.charAt(0).toUpperCase())
                        .join('')}
                    </strong>
                  </div>
                  <div className="cast-card-copy">
                    <strong>{person.name}</strong>
                    {person.role && <span>{person.role}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {!loading && !error && data?.queryUsed && (
          <div className="cast-footer">
            <small>Fonte: Pesquisa Google — consulta usada: "{data.queryUsed}"</small>
          </div>
        )}
      </div>
    </div>
  );
}

function MediaDetailsModal({ item, onClose, onPlay, onCastOpen, onChangeItem, catalogId, profileAgeLimit }) {
  const [recommendations, setRecommendations] = useState([]);
  const [recLoading, setRecLoading] = useState(true);
  const [scrollLeft, setScrollLeft] = useState(0);
  const carouselRef = useRef(null);

  const handleCarouselScroll = useCallback((e) => {
    setScrollLeft(e.currentTarget.scrollLeft);
  }, []);

  const canScrollRight = carouselRef.current
    ? carouselRef.current.scrollLeft + carouselRef.current.clientWidth < carouselRef.current.scrollWidth - 1
    : false;

  const handleSuggestionClick = (suggestionItem) => {
    if (onChangeItem) {
      onChangeItem(suggestionItem);
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function loadRecommendations() {
      if (!item?.id) return;
      setRecLoading(true);
      try {
        const payload = await requestJson('/api/catalog/query', {
          method: 'POST',
          body: JSON.stringify({
            section: item.contentType === 'live' ? 'live' : item.contentType === 'movie' ? 'movie' : 'series',
            category: item.category || 'Todas',
            genre: item.genre || 'Todos',
            year: item.year || 'Todos',
            page: 1,
            pageSize: 8,
            catalogId,
            maxAgeRating: profileAgeLimit,
          }),
        });
        if (!cancelled) {
          const filtered = (payload.items || []).filter((i) => i.id !== item.id).slice(0, 6);
          setRecommendations(filtered);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to load recommendations:', err);
          setRecommendations([]);
        }
      } finally {
        if (!cancelled) {
          setRecLoading(false);
        }
      }
    }

    loadRecommendations();

    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.contentType, item?.category, item?.genre, item?.year, catalogId, profileAgeLimit]);

  const handlePlay = () => {
    onPlay(item);
    onClose();
  };

  const handleTrailer = () => {
    const query = encodeURIComponent(`${item.name} ${item.year || ''} trailer`);
    window.open(`https://www.youtube.com/results?search_query=${query}`, '_blank');
  };

  const isLive = item.contentType === 'live';
  const isMovie = item.contentType === 'movie';
  const isSeries = item.contentType === 'series' || item.itemType === 'series_group';

  return (
    <div className="player-overlay" role="dialog" aria-modal="true">
      <div className="media-details-modal">
        <header className="media-details-header">
          <div className="media-details-title-block">
            <h2>{item.name}</h2>
            <div className="media-details-meta">
              <span>{isLive ? 'Ao vivo' : isMovie ? 'Filme' : 'Serie'}</span>
              {item.year && <span>{item.year}</span>}
              {item.genre && <span>{item.genre}</span>}
              {item.category && item.category !== 'Sem categoria' && <span>{item.category}</span>}
            </div>
            {item.plot && <p className="media-details-plot">{item.plot}</p>}
          </div>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Fechar
          </button>
        </header>

        <div className="media-details-body">
          <div className="media-details-main">
            {item.poster ? (
              <img src={item.poster} alt={item.name} className="media-details-poster" />
            ) : (
              <div className="media-details-poster media-details-poster-fallback">{item.name.slice(0, 2).toUpperCase()}</div>
            )}

            <div className="media-details-actions">
              <button type="button" className="primary-btn is-large" onClick={handlePlay}>
                <span>▶</span> Assistir
              </button>
              {!isLive && item.trailer && (
                <button type="button" className="ghost-btn is-large" onClick={handleTrailer}>
                  <span>🎬</span> Trailer
                </button>
              )}
              {!isLive && !item.trailer && (
                <button type="button" className="ghost-btn is-large" onClick={handleTrailer} disabled>
                  <span>🎬</span> Trailer (indisponivel)
                </button>
              )}
            </div>
          </div>

          {isLive && item.epg && (
            <div className="media-details-epg">
              <h3>Programacao</h3>
              <div className="epg-list">
                {item.epg.map((program) => (
                  <div key={program.start} className="epg-item">
                    <span className="epg-time">{program.start} - {program.end}</span>
                    <span className="epg-title">{program.title}</span>
                    {program.description && <span className="epg-desc">{program.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(recommendations.length > 0 || recLoading) && (
            <section className="media-details-recommendations">
              <h3>Sugeridos</h3>
              {recLoading ? (
                <div className="rec-skeleton">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="rec-skeleton-card">
                      <div className="rec-skeleton-img" />
                      <div className="rec-skeleton-text" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rec-carousel-wrapper">
                  <button
                    type="button"
                    className="rec-carousel-btn"
                    onClick={() => carouselRef.current?.scrollBy({ left: -300, behavior: 'smooth' })}
                    aria-label="Sugeridos anteriores"
                    disabled={scrollLeft === 0}
                  >
                    ‹
                  </button>
                  <div className="rec-carousel" ref={carouselRef} onScroll={handleCarouselScroll}>
                    {recommendations.map((rec) => (
                      <ItemCard
                        key={rec.id}
                        item={rec}
                        favorite={false}
                        watchLater={false}
                        recommended={false}
                        watched={false}
                        onFavorite={() => {}}
                        onWatchLater={() => {}}
                        onRecommend={() => {}}
                        onPlay={() => handleSuggestionClick(rec)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="rec-carousel-btn"
                    onClick={() => carouselRef.current?.scrollBy({ left: 300, behavior: 'smooth' })}
                    aria-label="Proximos sugeridos"
                    disabled={!canScrollRight}
                  >
                    ›
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerModal({
  item,
  onClose,
  onBackToEpisodes,
  onPlayEpisode,
  onCastOpen,
  settings,
  resumeEntry,
  playbackProgress = {},
  watchedMap = {},
  onProgressSave,
  onProgressClear,
  onWatched,
  onPlayNextEpisode,
  profileAgeLimit,
  catalogId,
  playerPreferences,
  onUpdatePlayerPreferences,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const streamRequestAbortRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const stallWatchdogRef = useRef(null);
  const [streamUrl, setStreamUrl] = useState('');
  const [streamCandidates, setStreamCandidates] = useState([]);
  const [activeStreamIndex, setActiveStreamIndex] = useState(0);
  const [streamInfoVersion, setStreamInfoVersion] = useState(0);
  const [streamSessionVersion, setStreamSessionVersion] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reconnectMessage, setReconnectMessage] = useState('');
  const [isRecovering, setIsRecovering] = useState(false);
  const [showRetryAction, setShowRetryAction] = useState(false);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const [previousEpisode, setPreviousEpisode] = useState(null);
  const [nextEpisode, setNextEpisode] = useState(null);
  const [nextEpisodeCountdown, setNextEpisodeCountdown] = useState(0);
  const [nextEpisodeCancelled, setNextEpisodeCancelled] = useState(false);
  const [idlePromptVisible, setIdlePromptVisible] = useState(false);
  const [idlePromptTimedOut, setIdlePromptTimedOut] = useState(false);
  const [idleCountdown, setIdleCountdown] = useState(120);
  const [seriesDetails, setSeriesDetails] = useState(null);
  const [episodesSidebarOpen, setEpisodesSidebarOpen] = useState(false);
  const [selectedSidebarSeason, setSelectedSidebarSeason] = useState('');
  const [isMaximized, setIsMaximized] = useState(false);
  const [maximizedBounds, setMaximizedBounds] = useState(null);
  const resizeDragRef = useRef(null);
  const [subtitleTracks, setSubtitleTracks] = useState([]);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState(-1);
  const [audioTracks, setAudioTracks] = useState([]);
  const [activeAudioGroupId, setActiveAudioGroupId] = useState('');
  const [subtitlesMenuOpen, setSubtitlesMenuOpen] = useState(false);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const subtitleTracksRef = useRef([]);
  const audioTracksRef = useRef([]);
  const resumePromptRef = useRef(false);
  const pendingResumeRef = useRef(0);
  const lastSavedSecondRef = useRef(-1);
  const initialResumePositionRef = useRef(0);
  const autoAdvanceTriggeredRef = useRef(false);
  const idleWarningTimeoutRef = useRef(null);
  const idlePauseTimeoutRef = useRef(null);
  const idleCountdownIntervalRef = useRef(null);
  const startupPlayTimeoutRef = useRef(null);
  const requestedResumePositionRef = useRef(0);
  const activeStreamIndexRef = useRef(0);
  const previousEpisodeRef = useRef(null);
  const nextEpisodeRef = useRef(null);
  const nextEpisodeCancelledRef = useRef(false);
  const idlePromptVisibleRef = useRef(false);
  const playbackStartedRef = useRef(false);
  const recoveryStateRef = useRef({ total: 0, candidateAttempts: 0 });
  const stallStartedAtRef = useRef(0);
  const lastPlaybackSnapshotRef = useRef({ time: 0, clock: 0 });
  const hlsMediaRecoveryRef = useRef(false);

  useEffect(() => {
    const initialResumePosition = Number(resumeEntry?.position || 0);
    initialResumePositionRef.current = initialResumePosition;
    requestedResumePositionRef.current = initialResumePosition;
    const shouldOfferResume =
      isResumeEligible(item) &&
      initialResumePosition >= 30;

    setShowResumePrompt(shouldOfferResume);
    resumePromptRef.current = shouldOfferResume;
    pendingResumeRef.current = 0;
    lastSavedSecondRef.current = -1;
  }, [item.id]);

  useEffect(() => {
    autoAdvanceTriggeredRef.current = false;
    if (streamRequestAbortRef.current) {
      streamRequestAbortRef.current.abort();
      streamRequestAbortRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (stallWatchdogRef.current) {
      window.clearInterval(stallWatchdogRef.current);
      stallWatchdogRef.current = null;
    }
    if (startupPlayTimeoutRef.current) {
      window.clearTimeout(startupPlayTimeoutRef.current);
      startupPlayTimeoutRef.current = null;
    }
    setNextEpisode(null);
    setPreviousEpisode(null);
    setSeriesDetails(null);
    setEpisodesSidebarOpen(false);
    setSelectedSidebarSeason('');
    setIsMaximized(false);
    setMaximizedBounds(null);
    setNextEpisodeCountdown(0);
    setNextEpisodeCancelled(false);
    setIdlePromptVisible(false);
    setIdlePromptTimedOut(false);
    setIdleCountdown(120);
    setStreamCandidates([]);
    setActiveStreamIndex(0);
    activeStreamIndexRef.current = 0;
    setStreamUrl('');
    setStreamInfoVersion(0);
    setStreamSessionVersion(0);
    setReconnectMessage('');
    setIsRecovering(false);
    setShowRetryAction(false);
    setError('');
    setLoading(true);
    recoveryStateRef.current = { total: 0, candidateAttempts: 0 };
    stallStartedAtRef.current = 0;
    lastPlaybackSnapshotRef.current = { time: 0, clock: 0 };
    hlsMediaRecoveryRef.current = false;
    playbackStartedRef.current = false;
    setSubtitleTracks([]);
    setActiveSubtitleIndex(-1);
    setAudioTracks([]);
    setActiveAudioGroupId('');
    setSubtitlesMenuOpen(false);
    setAudioMenuOpen(false);
    subtitleTracksRef.current = [];
    audioTracksRef.current = [];
  }, [item.id]);

  useEffect(() => {
    nextEpisodeRef.current = nextEpisode;
  }, [nextEpisode]);

  useEffect(() => {
    previousEpisodeRef.current = previousEpisode;
  }, [previousEpisode]);

  useEffect(() => {
    nextEpisodeCancelledRef.current = nextEpisodeCancelled;
  }, [nextEpisodeCancelled]);

  useEffect(() => {
    idlePromptVisibleRef.current = idlePromptVisible;
  }, [idlePromptVisible]);

  useEffect(() => {
    if (!seriesDetails?.seasons?.length) {
      setSelectedSidebarSeason('');
      return;
    }
    const seasons = seriesDetails.seasons;
    const currentSeasonNumber = item.seasonNumber;
    const match = seasons.find((s) => Number(s.seasonNumber) === Number(currentSeasonNumber));
    if (match) {
      setSelectedSidebarSeason(String(match.seasonNumber));
    } else {
      setSelectedSidebarSeason(String(seasons[0].seasonNumber));
    }
  }, [seriesDetails, item.seasonNumber]);

  useEffect(() => {
    let cancelled = false;

    async function loadSeriesNavigation() {
      if (item.contentType !== 'series' || !item.seriesKey) {
        setNextEpisode(null);
        setPreviousEpisode(null);
        setSeriesDetails(null);
        return;
      }

      try {
        const ageParam = profileAgeLimit == null ? '' : `?maxAgeRating=${encodeURIComponent(profileAgeLimit)}`;
        const catalogParam = catalogId ? `&catalogId=${encodeURIComponent(catalogId)}` : '';
        const payload = await requestJson(`/api/series/${encodeURIComponent(item.seriesKey)}${ageParam}${catalogParam}`);
        if (!cancelled) {
          setSeriesDetails(payload);
          setNextEpisode(getNextEpisodeFromDetails(payload, item));
          setPreviousEpisode(getPreviousEpisodeFromDetails(payload, item));
        }
      } catch {
        if (!cancelled) {
          setNextEpisode(null);
          setPreviousEpisode(null);
          setSeriesDetails(null);
        }
      }
    }

    loadSeriesNavigation();

    return () => {
      cancelled = true;
    };
  }, [item, profileAgeLimit, catalogId]);

  const clearIdleTimers = useCallback(() => {
    if (idleWarningTimeoutRef.current) {
      window.clearTimeout(idleWarningTimeoutRef.current);
      idleWarningTimeoutRef.current = null;
    }
    if (idlePauseTimeoutRef.current) {
      window.clearTimeout(idlePauseTimeoutRef.current);
      idlePauseTimeoutRef.current = null;
    }
    if (idleCountdownIntervalRef.current) {
      window.clearInterval(idleCountdownIntervalRef.current);
      idleCountdownIntervalRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const clearWatchdog = useCallback(() => {
    if (stallWatchdogRef.current) {
      window.clearInterval(stallWatchdogRef.current);
      stallWatchdogRef.current = null;
    }
    stallStartedAtRef.current = 0;
  }, []);

  const clearStartupPlayTimer = useCallback(() => {
    if (startupPlayTimeoutRef.current) {
      window.clearTimeout(startupPlayTimeoutRef.current);
      startupPlayTimeoutRef.current = null;
    }
  }, []);

  const activateStreamCandidate = useCallback((candidateIndex, resumeAt = 0, message = '') => {
    const candidate = streamCandidates[candidateIndex];
    if (!candidate?.url) {
      return false;
    }

    pendingResumeRef.current = Math.max(0, Number(resumeAt || 0));
    requestedResumePositionRef.current = Math.max(0, Number(resumeAt || 0));
    setActiveStreamIndex(candidateIndex);
    activeStreamIndexRef.current = candidateIndex;
    setStreamUrl(candidate.url);
    setStreamSessionVersion((current) => current + 1);
    setReconnectMessage(message);
    setIsRecovering(Boolean(message));
    setShowRetryAction(false);
    setError('');
    setLoading(true);
    return true;
  }, [streamCandidates]);

  const scheduleRecovery = useCallback((reason, options = {}) => {
    const video = videoRef.current;
    const resumeAt = Math.max(
      0,
      Number(options.resumeAt ?? video?.currentTime ?? requestedResumePositionRef.current ?? 0),
    );

    clearReconnectTimer();
    clearWatchdog();

    recoveryStateRef.current.total += 1;
    if (recoveryStateRef.current.total > 10) {
      setReconnectMessage('');
      setIsRecovering(false);
      setShowRetryAction(true);
      setLoading(false);
      setError('Nao foi possivel estabilizar a transmissao. Tente novamente em alguns instantes.');
      return;
    }

    setReconnectMessage(reason || 'Reconectando...');
    setIsRecovering(true);
    setShowRetryAction(false);
    setError('');
    setLoading(true);

    const currentAttempts = recoveryStateRef.current.candidateAttempts + 1;
    const currentCandidateIndex = activeStreamIndexRef.current;
    const nextCandidateIndex = currentCandidateIndex + 1;
    const hasNextCandidate = nextCandidateIndex < streamCandidates.length;
    const shouldRotateCandidate = hasNextCandidate && (Boolean(options.preferNextCandidate) || currentAttempts > 2);
    const shouldRefreshSources = options.refreshSources || (currentAttempts > 2 && !hasNextCandidate);

    const performRecovery = () => {
      if (shouldRefreshSources) {
        recoveryStateRef.current.candidateAttempts = 0;
        pendingResumeRef.current = resumeAt;
        requestedResumePositionRef.current = resumeAt;
        setStreamInfoVersion((current) => current + 1);
        return;
      }

      if (shouldRotateCandidate) {
        recoveryStateRef.current.candidateAttempts = 0;
        if (activateStreamCandidate(nextCandidateIndex, resumeAt, 'Reconectando...')) {
          return;
        }
      }

      recoveryStateRef.current.candidateAttempts = currentAttempts;
      activateStreamCandidate(currentCandidateIndex, resumeAt, 'Reconectando...');
    };

    if (options.immediate) {
      performRecovery();
      return;
    }

    reconnectTimeoutRef.current = window.setTimeout(performRecovery, Number(options.delayMs || 1500));
  }, [activateStreamCandidate, clearReconnectTimer, clearWatchdog, streamCandidates.length]);

  const scheduleIdlePrompt = useCallback(() => {
    clearIdleTimers();
    if (playerPreferences?.disableIdlePrompt) {
      return;
    }

    idleWarningTimeoutRef.current = window.setTimeout(() => {
      setIdlePromptVisible(true);
      setIdlePromptTimedOut(false);
      setIdleCountdown(120);

      idleCountdownIntervalRef.current = window.setInterval(() => {
        setIdleCountdown((current) => (current > 0 ? current - 1 : 0));
      }, 1000);

      idlePauseTimeoutRef.current = window.setTimeout(() => {
        const video = videoRef.current;
        if (video) {
          video.pause();
        }
        setIdlePromptTimedOut(true);
        setIdleCountdown(0);
      }, 120000);
    }, 60 * 60 * 1000);
  }, [clearIdleTimers, playerPreferences?.disableIdlePrompt]);

  const handleIdleConfirmed = useCallback((disableFuturePrompt = false) => {
    if (disableFuturePrompt) {
      onUpdatePlayerPreferences({ disableIdlePrompt: true });
    }

    clearIdleTimers();
    setIdlePromptVisible(false);
    setIdlePromptTimedOut(false);
    setIdleCountdown(120);

    const video = videoRef.current;
    if (video?.paused) {
      video.play().catch(() => {});
    }

    if (!disableFuturePrompt) {
      scheduleIdlePrompt();
    }
  }, [clearIdleTimers, onUpdatePlayerPreferences, scheduleIdlePrompt]);

  const triggerNextEpisode = useCallback(() => {
    const upcomingEpisode = nextEpisodeRef.current;
    if (!upcomingEpisode || autoAdvanceTriggeredRef.current) {
      return;
    }

    autoAdvanceTriggeredRef.current = true;
    onPlayNextEpisode(upcomingEpisode);
  }, [onPlayNextEpisode]);

  const triggerPreviousEpisode = useCallback(() => {
    const pastEpisode = previousEpisodeRef.current;
    if (!pastEpisode || autoAdvanceTriggeredRef.current) {
      return;
    }

    autoAdvanceTriggeredRef.current = true;
    onPlayNextEpisode(pastEpisode);
  }, [onPlayNextEpisode]);

  const retryPlayback = useCallback(() => {
    const currentPosition = Math.max(0, Number(videoRef.current?.currentTime || requestedResumePositionRef.current || 0));
    recoveryStateRef.current = { total: 0, candidateAttempts: 0 };
    setShowRetryAction(false);
    setError('');
    if (!activateStreamCandidate(activeStreamIndexRef.current, currentPosition, 'Reconectando...')) {
      setStreamInfoVersion((current) => current + 1);
    }
  }, [activateStreamCandidate]);

  const seekToTime = useCallback((targetTime) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const safeTarget = Math.max(
      0,
      Math.min(Number(targetTime || 0), Number.isFinite(video.duration) && video.duration > 5 ? video.duration - 5 : Number(targetTime || 0)),
    );

    try {
      if (typeof video.fastSeek === 'function') {
        video.fastSeek(safeTarget);
      } else {
        video.currentTime = safeTarget;
      }
      requestedResumePositionRef.current = safeTarget;
      pendingResumeRef.current = 0;
      stallStartedAtRef.current = 0;
      lastPlaybackSnapshotRef.current = { time: safeTarget, clock: Date.now() };
      setReconnectMessage('');
    } catch {
      scheduleRecovery('Reposicionando transmissao...', {
        immediate: true,
        resumeAt: safeTarget,
      });
    }
  }, [scheduleRecovery]);

  useEffect(() => {
    if (idlePromptVisible) {
      return undefined;
    }

    scheduleIdlePrompt();
    const markActive = () => {
      scheduleIdlePrompt();
    };

    window.addEventListener('pointerdown', markActive);
    window.addEventListener('keydown', markActive);
    window.addEventListener('touchstart', markActive);

    return () => {
      window.removeEventListener('pointerdown', markActive);
      window.removeEventListener('keydown', markActive);
      window.removeEventListener('touchstart', markActive);
      clearIdleTimers();
    };
  }, [clearIdleTimers, idlePromptVisible, scheduleIdlePrompt]);

  useEffect(() => {
    const controller = new AbortController();
    streamRequestAbortRef.current = controller;

    async function loadStream() {
      setLoading(true);
      setShowRetryAction(false);
      if (!isRecovering) {
        setError('');
      }

      try {
        const payload = await requestJson('/api/stream-url', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...settings,
            itemId: item.id,
          }),
        });

        if (controller.signal.aborted) {
          return;
        }

        const nextCandidates = Array.isArray(payload.candidates) && payload.candidates.length
          ? payload.candidates
          : [{
            url: payload.url,
            label: 'Direto',
            mode: 'direct',
            format: String(payload.url || '').includes('.m3u8') ? 'm3u8' : 'ts',
          }];
        const preferredIndex = Math.min(activeStreamIndexRef.current, Math.max(nextCandidates.length - 1, 0));

        setStreamCandidates(nextCandidates);
        setActiveStreamIndex(preferredIndex);
        activeStreamIndexRef.current = preferredIndex;
        setStreamUrl(nextCandidates[preferredIndex]?.url || '');
        setStreamSessionVersion((current) => current + 1);
      } catch (requestError) {
        if (!controller.signal.aborted) {
          setError(requestError.message);
          setShowRetryAction(true);
          setLoading(false);
        }
      }
    }

    loadStream();

    return () => {
      controller.abort();
      if (streamRequestAbortRef.current === controller) {
        streamRequestAbortRef.current = null;
      }
    };
  }, [item.id, settings, streamInfoVersion]);

  useEffect(() => {
    const video = videoRef.current;
    const activeCandidate = streamCandidates[activeStreamIndex];

    if (!video || !streamUrl || !activeCandidate?.url) {
      return undefined;
    }

    clearReconnectTimer();
    clearWatchdog();
    clearStartupPlayTimer();

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    video.pause();
    video.preload = 'auto';
    video.removeAttribute('src');
    video.load();
    setLoading(true);
    playbackStartedRef.current = false;

    const mimeType = inferMimeType(streamUrl);
    const isNativeVideo = !(activeCandidate.format === 'm3u8' || streamUrl.includes('.m3u8'));
    const isDirectFileStream = isNativeVideo && (activeCandidate.mode === 'direct' || /\.mp4(\?.*)?$/i.test(streamUrl));
    const getBufferedAhead = () => {
      const currentTime = Number(video.currentTime || 0);
      const ranges = video.buffered;
      if (!ranges || !ranges.length) {
        return 0;
      }

      for (let index = 0; index < ranges.length; index += 1) {
        const start = ranges.start(index);
        const end = ranges.end(index);
        if (currentTime >= start - 0.25 && currentTime <= end + 0.25) {
          return Math.max(0, end - currentTime);
        }
      }

      return 0;
    };
    const queueAutoplay = () => {
      if (resumePromptRef.current || playbackStartedRef.current) {
        return;
      }

      clearStartupPlayTimer();
      const delayMs = isRecovering ? 400 : isNativeVideo ? 1600 : 250;
      startupPlayTimeoutRef.current = window.setTimeout(() => {
        startupPlayTimeoutRef.current = null;
        if (!resumePromptRef.current && !playbackStartedRef.current) {
          video.play().catch(() => {});
        }
      }, delayMs);
    };
    const persistCurrentProgress = () => {
      if (!isResumeEligible(item)) {
        return;
      }

      const duration = Number(video.duration || 0);
      const position = Number(video.currentTime || 0);
      if (!Number.isFinite(duration) || duration <= 0 || position < 5) {
        return;
      }

      if (duration - position <= 60 || position / duration >= 0.95) {
        onProgressClear(item.id);
        onWatched(item);
        return;
      }

      onProgressSave(item, position, duration);
    };

    const markPlaybackHealthy = () => {
      setLoading(false);
      setReconnectMessage('');
      setIsRecovering(false);
      setShowRetryAction(false);
      recoveryStateRef.current = { total: 0, candidateAttempts: 0 };
      stallStartedAtRef.current = 0;
      hlsMediaRecoveryRef.current = false;
      lastPlaybackSnapshotRef.current = {
        time: Number(video.currentTime || 0),
        clock: Date.now(),
      };
    };

    const applyPendingResume = () => {
      if (pendingResumeRef.current > 0) {
        const safeTarget = Math.min(
          pendingResumeRef.current,
          Number.isFinite(video.duration) && video.duration > 5 ? video.duration - 5 : pendingResumeRef.current,
        );
        seekToTime(Math.max(0, safeTarget));
        pendingResumeRef.current = 0;
      }
    };

    const onLoadedMetadata = () => {
      syncTracksFromPlayer();
      applyPendingResume();
    };

    const onCanPlay = () => {
      queueAutoplay();
      markPlaybackHealthy();
    };

    const onPlaying = () => {
      playbackStartedRef.current = true;
      clearStartupPlayTimer();
      markPlaybackHealthy();
    };

    const onWaitingLike = () => {
      if (!video.paused && !video.ended) {
        setReconnectMessage('Carregando buffer...');
      }
    };

    const onTimeUpdate = () => {
      if (!isResumeEligible(item)) {
        return;
      }

      const duration = Number(video.duration || 0);
      const position = Number(video.currentTime || 0);
      requestedResumePositionRef.current = position;
      const remaining = Number.isFinite(duration) && duration > 0 ? Math.max(0, Math.ceil(duration - position)) : 0;
      if (nextEpisodeRef.current && !nextEpisodeCancelledRef.current && !idlePromptVisibleRef.current && remaining > 0 && remaining <= 10) {
        setNextEpisodeCountdown(remaining);
      } else {
        setNextEpisodeCountdown(0);
      }

      const second = Math.floor(video.currentTime || 0);
      if (second < 5 || second === lastSavedSecondRef.current || second % 5 !== 0) {
        return;
      }

      lastSavedSecondRef.current = second;
      persistCurrentProgress();
    };

    if ((activeCandidate.format === 'm3u8' || streamUrl.includes('.m3u8')) && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startFragPrefetch: true,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
        fragLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 1000,
        levelLoadingRetryDelay: 1000,
        fragLoadingRetryDelay: 1000,
      });

      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setTimeout(syncTracksFromPlayer, 150);
        setLoading(false);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) {
          return;
        }

        const details = String(data?.details || '');
        const reasonLooksExpired = /403|401|expired|token/i.test(details);

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !hlsMediaRecoveryRef.current) {
          hlsMediaRecoveryRef.current = true;
          setReconnectMessage('Recuperando player...');
          hls.recoverMediaError();
          return;
        }

        scheduleRecovery(
          reasonLooksExpired ? 'Atualizando acesso ao stream...' : 'Reconectando...',
          {
            immediate: true,
            refreshSources: reasonLooksExpired || data.type === Hls.ErrorTypes.NETWORK_ERROR,
            resumeAt: video.currentTime,
          },
        );
      });
    } else {
      video.src = streamUrl;
      video.type = mimeType;
      video.load();
    }

    const onVideoError = () => {
      const currentPosition = Number(video.currentTime || 0);
      const bufferedAhead = getBufferedAhead();
      const hasStartedPlayback = playbackStartedRef.current || currentPosition > 1;
      const mediaErrorCode = Number(video.error?.code || 0);
      const isNetworkLikeError = mediaErrorCode === 2 || mediaErrorCode === 4;

      if (hasStartedPlayback && bufferedAhead >= 4) {
        setLoading(false);
        setReconnectMessage('Instabilidade detectada. Aguardando buffer...');
        return;
      }

      if (isDirectFileStream) {
        scheduleRecovery('Tentando rota alternativa...', {
          immediate: false,
          preferNextCandidate: true,
          delayMs: hasStartedPlayback ? 3500 : 2000,
          resumeAt: currentPosition,
        });
        return;
      }

      scheduleRecovery('Reconectando...', {
        immediate: false,
        refreshSources: !hasStartedPlayback && isNetworkLikeError,
        delayMs: hasStartedPlayback ? 3500 : 2000,
        resumeAt: currentPosition,
      });
    };
    const onEnded = () => {
      persistCurrentProgress();
      if (nextEpisodeRef.current && !nextEpisodeCancelledRef.current && !idlePromptVisibleRef.current) {
        triggerNextEpisode();
      }
    };
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('waiting', onWaitingLike);
    video.addEventListener('stalled', onWaitingLike);
    video.addEventListener('pause', persistCurrentProgress);
    video.addEventListener('error', onVideoError);
    video.addEventListener('ended', onEnded);

    stallWatchdogRef.current = window.setInterval(() => {
      if (!video || video.paused || video.ended || idlePromptVisibleRef.current) {
        stallStartedAtRef.current = 0;
        return;
      }

      const now = Date.now();
      const currentTime = Number(video.currentTime || 0);
      const hasAdvanced = Math.abs(currentTime - lastPlaybackSnapshotRef.current.time) > 0.35;
      if (hasAdvanced || video.readyState >= 3) {
        lastPlaybackSnapshotRef.current = { time: currentTime, clock: now };
        stallStartedAtRef.current = 0;
        return;
      }

      if (!stallStartedAtRef.current) {
        stallStartedAtRef.current = now;
        return;
      }

      if (now - stallStartedAtRef.current >= 12000) {
        scheduleRecovery('Reconectando...', {
          immediate: true,
          refreshSources: activeCandidate.mode === 'direct',
          resumeAt: currentTime,
        });
      }
    }, 3000);

    return () => {
      clearWatchdog();
      clearStartupPlayTimer();
      persistCurrentProgress();
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('waiting', onWaitingLike);
      video.removeEventListener('stalled', onWaitingLike);
      video.removeEventListener('pause', persistCurrentProgress);
      video.removeEventListener('error', onVideoError);
      video.removeEventListener('ended', onEnded);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.pause();
    };
  }, [
    activeStreamIndex,
    clearReconnectTimer,
    clearStartupPlayTimer,
    clearWatchdog,
    item,
    onProgressClear,
    onProgressSave,
    onWatched,
    scheduleRecovery,
    seekToTime,
    streamCandidates,
    streamSessionVersion,
    streamUrl,
    triggerNextEpisode,
  ]);

  useEffect(() => () => {
    clearIdleTimers();
    clearReconnectTimer();
    clearWatchdog();
  }, [clearIdleTimers, clearReconnectTimer, clearWatchdog]);

  function handleResumeFromLastPosition() {
    pendingResumeRef.current = Number(resumeEntry?.position || 0);
    resumePromptRef.current = false;
    setShowResumePrompt(false);

    const video = videoRef.current;
    if (video?.readyState >= 1) {
      const safeTarget = Math.min(
        pendingResumeRef.current,
        Number.isFinite(video.duration) && video.duration > 5 ? video.duration - 5 : pendingResumeRef.current,
      );
      video.currentTime = Math.max(0, safeTarget);
      pendingResumeRef.current = 0;
      video.play().catch(() => {});
    }
  }

  function handleRestartFromBeginning() {
    resumePromptRef.current = false;
    setShowResumePrompt(false);
    pendingResumeRef.current = 0;
    requestedResumePositionRef.current = 0;
    onProgressClear(item.id);

    const video = videoRef.current;
    if (video?.readyState >= 1) {
      seekToTime(0);
      video.play().catch(() => {});
    }
  }

  function handleSkipIntro() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const nextTime = Math.min(Number(video.currentTime || 0) + 10, Math.max(Number(video.duration || 0) - 5, 0));
    seekToTime(nextTime);
  }

  function handleRewind10() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const targetTime = Math.max(Number(video.currentTime || 0) - 10, 0);
    seekToTime(targetTime);
  }

  function toggleMaximize() {
    setIsMaximized((current) => {
      const next = !current;
      if (next) {
        setMaximizedBounds(null);
      }
      return next;
    });
  }

  function handleResizeStart(e) {
    if (!isMaximized) {
      return;
    }
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = window.innerWidth - 32;
    const startHeight = window.innerHeight - 32;
    const modalEl = e.currentTarget.closest('.player-modal');
    const rect = modalEl ? modalEl.getBoundingClientRect() : null;
    resizeDragRef.current = {
      startX,
      startY,
      startWidth: rect ? rect.width : startWidth,
      startHeight: rect ? rect.height : startHeight,
    };

    function onMove(moveEvent) {
      const drag = resizeDragRef.current;
      if (!drag) {
        return;
      }
      const deltaX = moveEvent.clientX - drag.startX;
      const deltaY = moveEvent.clientY - drag.startY;
      const minW = 640;
      const minH = 420;
      const maxW = window.innerWidth - 16;
      const maxH = window.innerHeight - 16;
      const nextWidth = Math.min(maxW, Math.max(minW, drag.startWidth + deltaX));
      const nextHeight = Math.min(maxH, Math.max(minH, drag.startHeight + deltaY));
      setMaximizedBounds({ width: nextWidth, height: nextHeight });
    }

    function onUp() {
      resizeDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function syncTracksFromPlayer() {
    const video = videoRef.current;
    if (!video) return;

    const subList = video.textTracks || [];
    const parsedSubs = [];
    for (let i = 0; i < subList.length; i++) {
      const t = subList[i];
      const lang = String(t.language || t.id || '').trim();
      const label = String(t.label || t.kind || t.id || 'Legenda').trim();
      parsedSubs.push({
        index: i,
        lang,
        label: label || (lang ? `Legenda ${lang.toUpperCase()}` : 'Legenda'),
        kind: t.kind,
      });
    }
    subtitleTracksRef.current = parsedSubs;
    setSubtitleTracks(parsedSubs);

    const activeIdx = parsedSubs.findIndex((t) => {
      const tt = subList[t.index];
      return tt && tt.mode === 'showing';
    });
    setActiveSubtitleIndex(activeIdx);

    const hls = hlsRef.current;
    const parsedAudio = [];
    if (hls && hls.audioTracks && hls.audioTracks.length) {
      for (let i = 0; i < hls.audioTracks.length; i++) {
        const a = hls.audioTracks[i];
        const lang = String(a.lang || a.id || '').trim();
        const groupId = String(a.groupId || a.id || 'audio-group').trim();
        const name = String(a.name || a.label || a.lang || '').trim();
        parsedAudio.push({
          index: i,
          groupId,
          lang,
          label: name || (lang ? `Audio ${lang.toUpperCase()}` : `Audio ${i + 1}`),
        });
      }
      audioTracksRef.current = parsedAudio;
      setAudioTracks(parsedAudio);
      setActiveAudioGroupId(String(hls.audioTrack || ''));
    } else if (video.audioTracks && video.audioTracks.length) {
      const nativeList = video.audioTracks;
      for (let i = 0; i < nativeList.length; i++) {
        const a = nativeList[i];
        const id = String(a.id || `native-${i}`).trim();
        parsedAudio.push({
          index: i,
          groupId: id,
          lang: String(a.language || '').trim(),
          label: a.label || a.language || `Audio ${i + 1}`,
          native: true,
        });
      }
      audioTracksRef.current = parsedAudio;
      setAudioTracks(parsedAudio);
      const activeIdx = Array.prototype.findIndex.call(nativeList, (a) => a.enabled);
      setActiveAudioGroupId(activeIdx >= 0 ? String(nativeList[activeIdx].id) : '');
    } else {
      audioTracksRef.current = parsedAudio;
      setAudioTracks(parsedAudio);
      setActiveAudioGroupId('');
    }
  }

  function handleSubtitleSelect(index) {
    const video = videoRef.current;
    if (!video || !video.textTracks) return;
    const list = video.textTracks;
    for (let i = 0; i < list.length; i++) {
      const tt = list[i];
      if (!tt) continue;
      if (index === -1) {
        tt.mode = 'hidden';
      } else if (i === index) {
        tt.mode = 'showing';
      } else {
        tt.mode = 'disabled';
      }
    }
    setActiveSubtitleIndex(index);
    if (onUpdatePlayerPreferences) {
      onUpdatePlayerPreferences({
        subtitleIndex: index,
        subtitleLang: index >= 0 ? String(list[index]?.language || '') : '',
      });
    }
  }

  function handleAudioSelect({ groupId, index, native }) {
    const video = videoRef.current;
    if (!video) return;
    if (native) {
      const list = video.audioTracks;
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        list[i].enabled = i === Number(index);
      }
    } else {
      const hls = hlsRef.current;
      if (hls && hls.audioTracks && typeof hls.audioTrack === 'number') {
        hls.audioTrack = Number(index);
      }
    }
    setActiveAudioGroupId(String(groupId || ''));
    if (onUpdatePlayerPreferences) {
      onUpdatePlayerPreferences({
        audioGroupId: String(groupId || ''),
        audioIndex: Number(index) || 0,
      });
    }
  }

  const activeCandidate = streamCandidates[activeStreamIndex];
  const activeSeason =
    seriesDetails?.seasons?.find((s) => String(s.seasonNumber) === String(selectedSidebarSeason)) || null;

  return (
    <div className="player-overlay" role="dialog" aria-modal="true">
      <div
        className={`player-modal${episodesSidebarOpen ? ' has-sidebar' : ''}${isMaximized ? ' is-maximized' : ''}`}
        style={
          isMaximized && maximizedBounds
            ? { width: `${maximizedBounds.width}px`, height: `${maximizedBounds.height}px` }
            : undefined
        }
      >
        {seriesDetails?.seasons?.length && onPlayEpisode && (
          <aside className={`episodes-sidebar${episodesSidebarOpen ? ' is-open' : ''}`} aria-hidden={!episodesSidebarOpen}>
            <div className="episodes-sidebar-header">
              <strong>Episodios</strong>
              <button
                type="button"
                className="icon-pill sidebar-close-btn"
                onClick={() => setEpisodesSidebarOpen(false)}
                aria-label="Fechar lista de episodios"
              >
                ×
              </button>
            </div>

            {seriesDetails.seasons.length > 1 && (
              <div className="episodes-sidebar-season">
                <label htmlFor="player-sidebar-season">Temporada</label>
                <select
                  id="player-sidebar-season"
                  value={selectedSidebarSeason}
                  onChange={(e) => setSelectedSidebarSeason(e.target.value)}
                >
                  {seriesDetails.seasons.map((season) => (
                    <option key={String(season.seasonNumber)} value={String(season.seasonNumber)}>
                      Temporada {season.seasonNumber}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="episodes-sidebar-list">
              {activeSeason?.episodes?.length ? (
                activeSeason.episodes.map((episode) => {
                  const episodeLabel = formatEpisodeLabel(episode);
                  const isCurrent = episode.id === item.id;
                  const watched = Boolean(watchedMap[episode.id]);
                  const episodeResume = playbackProgress[episode.id];
                  return (
                    <button
                      key={episode.id}
                      type="button"
                      className={`player-episode-item${isCurrent ? ' is-current' : ''}`}
                      onClick={() => onPlayEpisode(episode)}
                    >
                      <div className="player-episode-art">
                        {episode.poster ? (
                          <img src={episode.poster} alt="" loading="lazy" />
                        ) : (
                          <div className="episode-art-fallback">{episodeLabel || '?'}</div>
                        )}
                      </div>
                      <div className="player-episode-copy">
                        <strong>{episodeLabel || episode.name}</strong>
                        <span>{episode.episodeTitle || episode.name}</span>
                        {episodeResume?.position > 30 && (
                          <small>Continuar em {formatDuration(episodeResume.position)}</small>
                        )}
                      </div>
                      <div className="player-episode-meta">
                        {watched && <span className="episode-badge watched">Assistido</span>}
                        {episode.ageRating != null && <small>Faixa: {episode.ageRating}+</small>}
                        <button
                          type="button"
                          className="primary-btn player-episode-play"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlayEpisode(episode);
                          }}
                        >
                          Assistir
                        </button>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="player-state">Nenhum episodio encontrado nesta temporada.</div>
              )}
            </div>
          </aside>
        )}

        {isMaximized && (
          <button
            type="button"
            className="player-resize-handle"
            onMouseDown={handleResizeStart}
            title="Arraste para redimensionar"
            aria-label="Redimensionar player"
          />
        )}

        <div className="player-body">
          <div className="player-header">
            <div>
              <h2>{item.name}</h2>
              <p>{item.category}</p>
            </div>
            <div className="player-header-actions">
              {seriesDetails?.seasons?.length && onPlayEpisode && (
                <button
                  type="button"
                  className={`ghost-btn sidebar-inline-toggle${episodesSidebarOpen ? ' is-open' : ''}`}
                  onClick={() => setEpisodesSidebarOpen((open) => !open)}
                  aria-expanded={episodesSidebarOpen}
                >
                  <span className="sidebar-toggle-icon">{episodesSidebarOpen ? '|>' : '<|'}</span>
                  <span className="sidebar-toggle-label">{episodesSidebarOpen ? 'Ocultar episodios' : 'Episodios'}</span>
                </button>
              )}
              {onCastOpen && (
                <button
                  type="button"
                  className="ghost-btn cast-inline-btn"
                  onClick={() => {
                    const seriesName = seriesDetails?.name || item.seriesName || '';
                    const searchTitle = item.contentType === 'series' || item.seriesKey
                      ? seriesName || item.name
                      : item.name;
                    const searchType = item.contentType || (item.seriesKey ? 'series' : 'movie');
                    onCastOpen(searchTitle, searchType);
                  }}
                >
                  <span className="cast-icon" aria-hidden>★</span>
                  <span>Elenco</span>
                </button>
              )}
              {subtitleTracks.length > 0 && (
                <div className={`player-dropdown${subtitlesMenuOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className={`ghost-btn track-btn track-btn--cc${activeSubtitleIndex >= 0 ? ' is-active' : ''}`}
                    onClick={() => {
                      setSubtitlesMenuOpen((current) => !current);
                      setAudioMenuOpen(false);
                    }}
                    aria-haspopup="true"
                    aria-expanded={subtitlesMenuOpen}
                    title={activeSubtitleIndex >= 0 ? 'Legenda ativa' : 'Legendas'}
                  >
                    <span className="track-icon">{activeSubtitleIndex >= 0 ? <NFIconCC /> : <NFIconCCDisabled />}</span>
                    <span className="track-label">Legenda</span>
                  </button>
                  <div className="player-dropdown-menu" role="menu">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={activeSubtitleIndex < 0}
                      className={activeSubtitleIndex < 0 ? 'is-active' : ''}
                      onClick={() => {
                        handleSubtitleSelect(-1);
                        setSubtitlesMenuOpen(false);
                      }}
                    >
                      Desativada
                    </button>
                    {subtitleTracks.map((track) => (
                      <button
                        key={`sub-${track.index}-${track.lang || track.label}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeSubtitleIndex === track.index}
                        className={activeSubtitleIndex === track.index ? 'is-active' : ''}
                        onClick={() => {
                          handleSubtitleSelect(track.index);
                          setSubtitlesMenuOpen(false);
                        }}
                      >
                        {track.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {audioTracks.length > 1 && (
                <div className={`player-dropdown${audioMenuOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="ghost-btn track-btn track-btn--audio"
                    onClick={() => {
                      setAudioMenuOpen((current) => !current);
                      setSubtitlesMenuOpen(false);
                    }}
                    aria-haspopup="true"
                    aria-expanded={audioMenuOpen}
                    title="Trocar idioma do audio"
                  >
                    <span className="track-icon"><NFIconAudioLang /></span>
                    <span className="track-label">Idioma</span>
                  </button>
                  <div className="player-dropdown-menu" role="menu">
                    {audioTracks.map((track) => (
                      <button
                        key={`audio-${track.index}-${track.groupId}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeAudioGroupId === String(track.groupId)}
                        className={activeAudioGroupId === String(track.groupId) ? 'is-active' : ''}
                        onClick={() => {
                          handleAudioSelect({
                            groupId: track.groupId,
                            index: track.index,
                            native: Boolean(track.native),
                          });
                          setAudioMenuOpen(false);
                        }}
                      >
                        {track.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                className="icon-pill max-btn"
                onClick={toggleMaximize}
                title={isMaximized ? 'Restaurar tamanho original' : 'Maximizar player'}
                aria-label={isMaximized ? 'Restaurar tamanho original' : 'Maximizar player'}
              >
                <span className="max-icon"><NFIconMaximize /></span>
                <span className="max-label">{isMaximized ? 'Restaurar' : 'Maximizar'}</span>
              </button>
              {item.seriesKey && onBackToEpisodes && (
                <button type="button" className="ghost-btn" onClick={() => onBackToEpisodes(item.seriesKey)}>
                  Voltar aos episodios
                </button>
              )}
              <button type="button" className="ghost-btn" onClick={onClose}>
                Fechar
              </button>
            </div>
          </div>

          {loading && !reconnectMessage && <div className="player-state">Carregando stream...</div>}
          {reconnectMessage && (
            <div className="player-state">
              {reconnectMessage}
              {activeCandidate?.label ? ` (${activeCandidate.label})` : ''}
            </div>
          )}
          {error && !loading && (
            <div className="player-state is-error">
              <strong>{error}</strong>
              {showRetryAction && (
                <div className="resume-actions">
                  <button type="button" className="primary-btn" onClick={retryPlayback}>
                    Tentar novamente
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="player-stage">
            <video ref={videoRef} className="player-video" controls playsInline autoPlay />

            {nextEpisode && nextEpisodeCountdown > 0 && !idlePromptVisible && (
              <div className="player-overlay-card next-episode-overlay">
                <div className="loading-spinner" aria-hidden="true" />
                <div className="player-overlay-copy">
                  <strong>Iniciando proximo episodio</strong>
                  <span>
                    {formatEpisodeLabel(nextEpisode) || 'Proximo episodio'} em {nextEpisodeCountdown}s
                  </span>
                </div>
                <div className="player-overlay-actions">
                  <button type="button" className="primary-btn" onClick={triggerNextEpisode}>
                    Assistir agora
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => setNextEpisodeCancelled(true)}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {idlePromptVisible && (
              <div className="player-overlay-card idle-overlay">
                <div className="loading-spinner" aria-hidden="true" />
                <div className="player-overlay-copy">
                  <strong>{idlePromptTimedOut ? 'Video pausado por inatividade' : 'Ainda esta ai?'}</strong>
                  <span>
                    {idlePromptTimedOut
                      ? 'Confirme para continuar assistindo.'
                      : `Sem resposta em ${formatDuration(idleCountdown)} o video sera pausado.`}
                  </span>
                </div>
                <div className="resume-actions">
                  <button type="button" className="ghost-btn" onClick={() => handleIdleConfirmed(true)}>
                    Nao perguntar mais
                  </button>
                  <button type="button" className="primary-btn" onClick={() => handleIdleConfirmed(false)}>
                    Sim
                  </button>
                </div>
              </div>
            )}
          </div>

          {showResumePrompt && (
            <div className="resume-prompt">
              <strong>Continuar assistindo?</strong>
              <span>Foi encontrado um ponto salvo em {formatDuration(resumeEntry?.position || 0)}.</span>
              <div className="resume-actions">
                <button type="button" className="ghost-btn" onClick={handleRestartFromBeginning}>
                  Ver do inicio
                </button>
                <button type="button" className="primary-btn" onClick={handleResumeFromLastPosition}>
                  Continuar de onde parou
                </button>
              </div>
            </div>
          )}

          <div className="player-footer">
            <span>Suporte HLS e TS</span>
            <div className="player-footer-actions">
              {previousEpisode && (
                <button
                  type="button"
                  className="icon-pill nav-episode-btn"
                  onClick={triggerPreviousEpisode}
                  title={`Episodio anterior${formatEpisodeLabel(previousEpisode) ? ` (${formatEpisodeLabel(previousEpisode)})` : ''}`}
                >
                  <NFIconPrevEpisode />
                </button>
              )}
              {(item.contentType === 'movie' || item.contentType === 'series') && (
                <button
                  type="button"
                  className="icon-pill seek-btn"
                  onClick={handleRewind10}
                  title="Voltar 10 segundos"
                >
                  <NFIconRewind10 />
                </button>
              )}
              {(item.contentType === 'movie' || item.contentType === 'series') && (
                <button
                  type="button"
                  className="icon-pill seek-btn seek-fwd"
                  onClick={handleSkipIntro}
                  title="Pular 10 segundos"
                >
                  <NFIconForward10 />
                </button>
              )}
              {nextEpisode && (
                <button
                  type="button"
                  className="icon-pill nav-episode-btn nav-next"
                  onClick={triggerNextEpisode}
                  title={`Proximo episodio${formatEpisodeLabel(nextEpisode) ? ` (${formatEpisodeLabel(nextEpisode)})` : ''}`}
                >
                  <NFIconNextEpisode />
                </button>
              )}
              {streamUrl && (
                <a href={streamUrl} target="_blank" rel="noreferrer">
                  Abrir stream direto
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [authProfiles, setAuthProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const activeProfileStorageReady = useRef(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginLoading, setLoginLoading] = useState(false);
  const [suspendedInfo, setSuspendedInfo] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [watchLater, setWatchLater] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [settings] = useState(DEFAULT_SETTINGS);
  const [playerPreferences, setPlayerPreferences] = useState(() => ({
    ...DEFAULT_PLAYER_PREFERENCES,
    ...readJson(STORAGE_KEYS.playerPreferences, {}),
  }));
  const [recentItem, setRecentItem] = useState(null);
  const [playbackProgress, setPlaybackProgress] = useState({});
  const [searchHistory, setSearchHistory] = useState([]);
  const [watchedMap, setWatchedMap] = useState({});
  const [status, setStatus] = useState({
    hasData: false,
    hasSource: true,
    counts: { live: 0, movie: 0, series: 0 },
    updatedAt: '',
  });
  const [detailsRecommendations, setDetailsRecommendations] = useState([]);
  const [detailsRecLoading, setDetailsRecLoading] = useState(false);
  const [seriesDetails, setSeriesDetails] = useState(null);
  const [seriesDetailsLoading, setSeriesDetailsLoading] = useState(false);
  const [seriesDetailsError, setSeriesDetailsError] = useState('');
  const [selectedSeasonDetail, setSelectedSeasonDetail] = useState('');
  const carouselRef = useRef(null);
  const [scrollLeft, setScrollLeft] = useState(0);

  const handleCarouselScroll = useCallback((e) => {
    setScrollLeft(e.currentTarget.scrollLeft);
  }, []);

  const canScrollRight = carouselRef.current
    ? carouselRef.current.scrollLeft + carouselRef.current.clientWidth < carouselRef.current.scrollWidth - 1
    : false;
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeSection, setActiveSection] = useState('home');
  const [previousSection, setPreviousSection] = useState('home');
  const [activeCategory, setActiveCategory] = useState('Todas');
  const [activeYear, setActiveYear] = useState('Todos');
  const [activeGenre, setActiveGenre] = useState('Todos');
  const [categorySidebarOpen, setCategorySidebarOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailsItem, setDetailsItem] = useState(null);
  const [castModalData, setCastModalData] = useState(null);
  const [castModalLoading, setCastModalLoading] = useState(false);
  const [castModalError, setCastModalError] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    pages: 1,
    total: 0,
    pageSize: PAGE_SIZE,
  });
  const [filterOptions, setFilterOptions] = useState({
    categories: [],
    years: [],
    genres: [],
  });
  const [syncLoading, setSyncLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [captchaPrompt, setCaptchaPrompt] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaValue, setCaptchaValue] = useState('');
  const [captchaError, setCaptchaError] = useState('');
  const [selectedSeriesKey, setSelectedSeriesKey] = useState('');
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [catalogManagerOpen, setCatalogManagerOpen] = useState(false);
  const [userManagerOpen, setUserManagerOpen] = useState(false);
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [profileStateReady, setProfileStateReady] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileAddOpen, setProfileAddOpen] = useState(false);
  const [profileEditId, setProfileEditId] = useState(null);
  const [profileForm, setProfileForm] = useState({ name: '', color: '', maxAgeRating: '' });
  const [profileFormError, setProfileFormError] = useState('');
  const [profileFormLoading, setProfileFormLoading] = useState(false);
  const [deleteProfileOpen, setDeleteProfileOpen] = useState(false);
  const [deleteProfileId, setDeleteProfileId] = useState(null);
  const [deleteProfileCaptcha, setDeleteProfileCaptcha] = useState('EXCLUIR');
  const [deleteProfileConfirm, setDeleteProfileConfirm] = useState('');
  const [deleteProfileLoading, setDeleteProfileLoading] = useState(false);
  const [userEditOpen, setUserEditOpen] = useState(false);
  const [userEditForm, setUserEditForm] = useState({ nome: '', foto: '' });
  const [userEditError, setUserEditError] = useState('');
  const [userEditLoading, setUserEditLoading] = useState(false);
  const [passwordChangeOpen, setPasswordChangeOpen] = useState(false);
  const [passwordChangeForm, setPasswordChangeForm] = useState({ currentPassword: '', password: '', confirmPassword: '' });
  const [passwordChangeError, setPasswordChangeError] = useState('');
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [avatarGalleryOpen, setAvatarGalleryOpen] = useState(false);
  const [avatarGalleryTarget, setAvatarGalleryTarget] = useState(null);
  const [avatarGalleryPublic, setAvatarGalleryPublic] = useState([]);
  const [avatarGalleryPrivate, setAvatarGalleryPrivate] = useState([]);
  const [avatarGalleryLoading, setAvatarGalleryLoading] = useState(false);
  const [avatarGalleryUploading, setAvatarGalleryUploading] = useState(false);

  const profiles = authProfiles;
  const isAdmin = authUser?.tipo === 'admin';

  const isListView = VIEW_SECTIONS.has(activeSection);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) || profiles[0] || DEFAULT_PROFILES[0],
    [activeProfileId, profiles],
  );
  const continueWatchingItems = useMemo(
    () =>
      Object.values(playbackProgress)
        .filter((entry) => Number(entry?.position || 0) >= 30 && entry?.itemId)
        .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
        .map((entry) => {
          const snapshot = entry.item || (recentItem?.id === entry.itemId ? createPlaybackItemSnapshot(recentItem) : null);
          if (!snapshot) {
            return null;
          }

          return {
            item: snapshot,
            progressEntry: entry,
          };
        })
        .filter(Boolean)
        .slice(0, 12),
    [playbackProgress, recentItem],
  );
  const sectionTitle = useMemo(() => {
    if (activeSection === 'live') return 'Live TV';
    if (activeSection === 'movie') return 'Filmes';
    if (activeSection === 'series') return 'Series';
    if (activeSection === 'favorites') return 'Favoritos';
    if (activeSection === 'watch-later') return 'Assistir mais tarde';
    return '';
  }, [activeSection]);
  const favoriteCount = favorites.length;
  const watchLaterCount = watchLater.length;
  const [validFavoriteIds, setValidFavoriteIds] = useState(null);
  const [validWatchLaterIds, setValidWatchLaterIds] = useState(null);
  const displayFavoriteCount = validFavoriteIds === null ? favoriteCount : validFavoriteIds.length;
  const displayWatchLaterCount = validWatchLaterIds === null ? watchLaterCount : validWatchLaterIds.length;
  const groupedRecommendations = useMemo(
    () =>
      profiles
        .map((profile) => {
          const stored =
            profile.id === activeProfileId
              ? recommendations
              : readStoredJson(buildProfileStorageKey(STORAGE_KEYS.recommendations, profile.id)) || [];
          const entries = (Array.isArray(stored) ? stored : [])
            .filter((entry) => entry?.item?.id)
            .sort((left, right) => new Date(right.addedAt || 0).getTime() - new Date(left.addedAt || 0).getTime());

          return {
            profile,
            entries,
          };
        })
        .filter((group) => group.entries.length > 0),
    [activeProfileId, profiles, recommendations],
  );
  const totalRecommendationCount = groupedRecommendations.reduce((total, group) => total + group.entries.length, 0);
  const activeSectionIds = useMemo(() => {
    if (activeSection === 'favorites') {
      return favorites;
    }
    if (activeSection === 'watch-later') {
      return watchLater;
    }
    return [];
  }, [activeSection, favorites, watchLater]);

  function handleSearchFocus() {
    setSearchFocused(true);
  }

  function handleSearchBlur(event) {
    if (event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setSearchFocused(false);
  }

  function navigateToSection(section) {
    setActiveSection(section);
    setMobileMenuOpen(false);
  }

  useEffect(() => {
    function clearAuthAndGoLogin() {
      setAuthUser(null);
      setAuthProfiles([]);
      setActiveProfileId('');
      setAuthError('');
      setSuspendedInfo(null);
      setLoginForm({ username: '', password: '' });
    }
    function handleForceLogout() {
      try {
        requestJson('/api/auth/logout', { method: 'POST' }).catch(() => {});
      } catch {}
      clearAuthAndGoLogin();
    }
    window.addEventListener('iptv:force-logout', handleForceLogout);
    return () => window.removeEventListener('iptv:force-logout', handleForceLogout);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAuthLoading(true);
      try {
        const payload = await requestJson('/api/auth/me');
        if (cancelled) return;
        if (payload?.ok && payload.user && Array.isArray(payload.profiles)) {
          setAuthUser(payload.user);
          setAuthProfiles(payload.profiles);
          // O perfil ativo dura apenas a sessao do navegador (sessionStorage):
          // fechar o navegador limpa a escolha (pede o perfil novamente),
          // mas recarregar a pagina mantem o perfil atual.
          let restoredProfileId = '';
          try {
            const saved = sessionStorage.getItem(STORAGE_KEYS.activeProfile);
            if (saved && payload.profiles.some((p) => p.id === saved)) {
              restoredProfileId = saved;
            }
          } catch {
            restoredProfileId = '';
          }
          setActiveProfileId(restoredProfileId);
        }
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) {
          activeProfileStorageReady.current = true;
          setAuthLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!detailsItem?.id) {
      setDetailsRecommendations([]);
      setDetailsRecLoading(false);
      return;
    }

    let cancelled = false;
    setDetailsRecLoading(true);

    async function loadDetailsRecommendations() {
      try {
        const item = detailsItem;
        const payload = await requestJson('/api/catalog/query', {
          method: 'POST',
          body: JSON.stringify({
            section: item.contentType === 'live' ? 'live' : item.contentType === 'movie' ? 'movie' : 'series',
            category: item.category || 'Todas',
            genre: item.genre || 'Todos',
            year: item.year || 'Todos',
            page: 1,
            pageSize: 8,
            catalogId: activeProfile?.catalogId,
            maxAgeRating: activeProfile?.maxAgeRating ?? null,
          }),
        });
        if (!cancelled) {
          const filtered = (payload.items || []).filter((i) => i.id !== item.id).slice(0, 6);
          setDetailsRecommendations(filtered);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to load details recommendations:', err);
          setDetailsRecommendations([]);
        }
      } finally {
        if (!cancelled) {
          setDetailsRecLoading(false);
        }
      }
    }

    loadDetailsRecommendations();

    return () => {
      cancelled = true;
    };
  }, [detailsItem?.id, detailsItem?.contentType, detailsItem?.category, detailsItem?.genre, detailsItem?.year, activeProfile?.catalogId, activeProfile?.maxAgeRating]);

  useEffect(() => {
    const isSeriesGroup = detailsItem?.itemType === 'series_group';
    const seriesKey = detailsItem?.seriesKey;
    if (!isSeriesGroup || !seriesKey) {
      setSeriesDetails(null);
      setSeriesDetailsError('');
      setSelectedSeasonDetail('');
      return;
    }

    let cancelled = false;
    setSeriesDetailsLoading(true);
    setSeriesDetailsError('');
    setSelectedSeasonDetail('');

    async function loadSeriesDetails() {
      try {
        const ageParam = activeProfile?.maxAgeRating == null ? '' : `?maxAgeRating=${encodeURIComponent(activeProfile.maxAgeRating)}`;
        const catalogParam = activeProfile?.catalogId ? `${ageParam ? '&' : '?'}catalogId=${encodeURIComponent(activeProfile.catalogId)}` : '';
        const payload = await requestJson(`/api/series/${encodeURIComponent(seriesKey)}${ageParam}${catalogParam}`);
        if (cancelled) return;
        setSeriesDetails(payload);
        const firstSeason = payload?.seasons?.[0];
        setSelectedSeasonDetail(firstSeason ? String(firstSeason.seasonNumber) : '');
      } catch (err) {
        if (!cancelled) {
          setSeriesDetailsError(err?.message || 'Falha ao carregar episodios.');
          setSeriesDetails(null);
        }
      } finally {
        if (!cancelled) {
          setSeriesDetailsLoading(false);
        }
      }
    }

    loadSeriesDetails();

    return () => {
      cancelled = true;
    };
  }, [detailsItem?.itemType, detailsItem?.seriesKey, activeProfile?.catalogId, activeProfile?.maxAgeRating]);

  useEffect(() => {
    if (!activeProfileStorageReady.current) {
      return;
    }
    if (activeProfileId) {
      sessionStorage.setItem(STORAGE_KEYS.activeProfile, activeProfileId);
    } else {
      sessionStorage.removeItem(STORAGE_KEYS.activeProfile);
    }
  }, [activeProfileId]);

  useEffect(() => {
    localStorage.removeItem(STORAGE_KEYS.settings);
  }, []);

  async function handleLoginSubmit(event) {
    if (event) event.preventDefault();
    const username = String(loginForm.username || '').trim();
    const password = String(loginForm.password || '');
    if (!username || !password) {
      setAuthError('Informe usuario e senha.');
      return;
    }
    setLoginLoading(true);
    setAuthError('');
    try {
      const payload = await requestJson('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (payload?.suspended) {
        setSuspendedInfo({
          reason: payload.reason || 'Sua conta esta suspensa. Entre em contato com o administrador.',
          user: payload.user || null,
        });
        setLoginForm({ username: '', password: '' });
        return;
      }
      if (payload?.ok && payload.user && Array.isArray(payload.profiles)) {
        setAuthUser(payload.user);
        setAuthProfiles(payload.profiles);
        setActiveProfileId('');
        setLoginForm({ username: '', password: '' });
      }
    } catch (err) {
      setAuthError(err?.message || 'Usuario ou senha invalidos.');
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await requestJson('/api/auth/logout', { method: 'POST' });
    } catch {}
    setAuthUser(null);
    setAuthProfiles([]);
    setActiveProfileId('');
    setAuthError('');
    setSuspendedInfo(null);
    setProfileModalOpen(false);
  }

  async function refreshProfilesFromApi() {
    try {
      const payload = await requestJson('/api/profiles');
      if (payload?.ok && Array.isArray(payload.profiles)) {
        setAuthProfiles(payload.profiles);
      }
    } catch (err) {
      setError(err?.message || 'Erro ao atualizar perfis.');
    }
  }

  function openProfileCreate() {
    setProfileEditId(null);
    setProfileForm({
      name: '',
      color: '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'),
      maxAgeRating: '',
      avatar: '',
    });
    setProfileFormError('');
    setProfileAddOpen(true);
  }

  function openProfileEdit(profile) {
    setProfileEditId(profile.id);
    setProfileForm({
      name: String(profile.name || ''),
      color: String(profile.color || ''),
      maxAgeRating: profile.maxAgeRating && profile.maxAgeRating < 999 ? String(profile.maxAgeRating) : '',
      avatar: String(profile.avatar || ''),
    });
    setProfileFormError('');
    setProfileAddOpen(true);
  }

  function closeProfileForm() {
    if (profileFormLoading) return;
    setProfileAddOpen(false);
    setProfileEditId(null);
    setProfileForm({ name: '', color: '', maxAgeRating: '', avatar: '' });
    setProfileFormError('');
  }

  async function submitProfileForm(event) {
    if (event) event.preventDefault();
    const name = String(profileForm.name || '').trim();
    if (!name) {
      setProfileFormError('Nome do perfil obrigatorio.');
      return;
    }
    setProfileFormLoading(true);
    setProfileFormError('');
    try {
      const body = {
        name,
        avatar: String(profileForm.avatar || '') || null,
        color: String(profileForm.color || '') || null,
        maxAgeRating: profileForm.maxAgeRating ? Number(profileForm.maxAgeRating) : null,
      };
      if (profileEditId) {
        await requestJson(`/api/profiles/${encodeURIComponent(profileEditId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await requestJson('/api/profiles', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      await refreshProfilesFromApi();
      closeProfileForm();
    } catch (err) {
      setProfileFormError(err?.message || 'Erro ao salvar perfil.');
    } finally {
      setProfileFormLoading(false);
    }
  }

  function openDeleteProfile(profileId) {
    setDeleteProfileId(profileId);
    setDeleteProfileCaptcha('EXCLUIR');
    setDeleteProfileConfirm('');
    setDeleteProfileLoading(false);
    setDeleteProfileOpen(true);
  }

  function closeDeleteProfile() {
    if (deleteProfileLoading) return;
    setDeleteProfileOpen(false);
    setDeleteProfileId(null);
    setDeleteProfileConfirm('');
    setDeleteProfileLoading(false);
  }

  async function confirmDeleteProfile(event) {
    if (event) event.preventDefault();
    if (!deleteProfileId) return;
    if (String(deleteProfileConfirm || '').trim() !== deleteProfileCaptcha) {
      setError(`Digite "${deleteProfileCaptcha}" para confirmar a exclusao.`);
      return;
    }
    setDeleteProfileLoading(true);
    setError('');
    try {
      await requestJson(`/api/profiles/${encodeURIComponent(deleteProfileId)}`, { method: 'DELETE' });
      if (activeProfileId === deleteProfileId) {
        setActiveProfileId('');
      }
      await refreshProfilesFromApi();
      closeDeleteProfile();
    } catch (err) {
      setError(err?.message || 'Erro ao excluir perfil.');
    } finally {
      setDeleteProfileLoading(false);
    }
  }

  async function handleDeleteProfile(profileId) {
    openDeleteProfile(profileId);
  }

  useEffect(() => {
    persistJson(STORAGE_KEYS.playerPreferences, playerPreferences);
  }, [playerPreferences]);

  useEffect(() => {
    setProfileStateReady(false);
    setFavorites(loadScopedProfileValue(STORAGE_KEYS.favorites, activeProfileId, [], STORAGE_KEYS.favorites));
    setWatchLater(loadScopedProfileValue(STORAGE_KEYS.watchLater, activeProfileId, []));
    setRecommendations(loadScopedProfileValue(STORAGE_KEYS.recommendations, activeProfileId, []));
    setRecentItem(loadScopedProfileValue(STORAGE_KEYS.recent, activeProfileId, null, STORAGE_KEYS.recent));
    setPlaybackProgress(loadScopedProfileValue(STORAGE_KEYS.progress, activeProfileId, {}, STORAGE_KEYS.progress));
    setSearchHistory(loadScopedProfileValue(STORAGE_KEYS.searchHistory, activeProfileId, [], STORAGE_KEYS.searchHistory));
    setWatchedMap(loadScopedProfileValue(STORAGE_KEYS.watched, activeProfileId, {}));
    setValidFavoriteIds(null);
    setValidWatchLaterIds(null);
    setProfileStateReady(true);
    setSelectedItem(null);
    setSelectedSeriesKey('');
  }, [activeProfileId]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(async () => resolveStoredScopedIds(favorites))
      .then((result) => {
        if (cancelled) return;
        setValidFavoriteIds(result.valid);
        if (result.invalid.length > 0) {
          setFavorites((current) => {
            const invalid = new Set(result.invalid);
            return current.filter((id) => !invalid.has(String(id)));
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, profileStateReady, favorites]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(async () => resolveStoredScopedIds(watchLater))
      .then((result) => {
        if (cancelled) return;
        setValidWatchLaterIds(result.valid);
        if (result.invalid.length > 0) {
          setWatchLater((current) => {
            const invalid = new Set(result.invalid);
            return current.filter((id) => !invalid.has(String(id)));
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, profileStateReady, watchLater]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    persistJson(buildProfileStorageKey(STORAGE_KEYS.favorites, activeProfileId), favorites);
  }, [activeProfileId, favorites, profileStateReady]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    persistJson(buildProfileStorageKey(STORAGE_KEYS.watchLater, activeProfileId), watchLater);
  }, [activeProfileId, profileStateReady, watchLater]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    persistJson(buildProfileStorageKey(STORAGE_KEYS.recommendations, activeProfileId), recommendations);
  }, [activeProfileId, profileStateReady, recommendations]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    persistJson(buildProfileStorageKey(STORAGE_KEYS.recent, activeProfileId), recentItem);
  }, [activeProfileId, profileStateReady, recentItem]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    persistJson(buildProfileStorageKey(STORAGE_KEYS.progress, activeProfileId), playbackProgress);
  }, [activeProfileId, playbackProgress, profileStateReady]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    persistJson(buildProfileStorageKey(STORAGE_KEYS.searchHistory, activeProfileId), searchHistory);
  }, [activeProfileId, profileStateReady, searchHistory]);

  useEffect(() => {
    if (!profileStateReady) {
      return;
    }
    persistJson(buildProfileStorageKey(STORAGE_KEYS.watched, activeProfileId), watchedMap);
  }, [activeProfileId, profileStateReady, watchedMap]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 350);

    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [activeSection, debouncedQuery, activeCategory, activeYear, activeGenre, activeProfileId]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [activeSection, activeProfileId]);

  function addSearchToHistory(value) {
    const normalized = String(value || '').trim();
    if (normalized.length < 2) return;
    setSearchHistory((current) => {
      const withoutCurrent = current.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase());
      return [normalized, ...withoutCurrent].slice(0, 10);
    });
  }

  function handleSearchSubmit(event) {
    if (event) event.preventDefault();
    addSearchToHistory(query);
  }

  async function resolveStoredScopedIds(ids) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) {
      return { valid: [], invalid: [] };
    }
    try {
      const payload = await requestJson('/api/catalog/exists-ids', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: list, catalogId: activeProfile?.catalogId }),
      });
      return {
        valid: Array.isArray(payload.valid) ? payload.valid : [],
        invalid: Array.isArray(payload.invalid) ? payload.invalid : [],
      };
    } catch {
      return { valid: list, invalid: [] };
    }
  }

  useEffect(() => {
    setActiveCategory('Todas');
    setActiveYear('Todos');
    setActiveGenre('Todos');
  }, [activeSection]);

  async function fetchStatus() {
    const catalogParam = activeProfile?.catalogId ? `?catalogId=${encodeURIComponent(activeProfile.catalogId)}` : '';
    const payload = await requestJson(`/api/catalog/status${catalogParam}`);
    setStatus({
      hasData: payload.hasData,
      hasSource: payload.hasSource !== false,
      counts: payload.counts,
      updatedAt: payload.updatedAt,
    });
    return payload;
  }

  async function syncCatalog(force = true) {
    setSyncLoading(true);
    setError('');

    try {
      const payload = await requestJson('/api/catalog/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...settings,
          force,
          catalogId: activeProfile?.catalogId,
        }),
      });

      setStatus({
        hasData: payload.hasData,
        hasSource: true,
        counts: payload.counts,
        updatedAt: payload.updatedAt,
      });
      return payload;
    } catch (requestError) {
      setError(requestError.message);
      throw requestError;
    } finally {
      setSyncLoading(false);
    }
  }

  function openSourceModal() {
    setSourceError('');
    setSourceModalOpen(true);
  }

  function closeSourceModal() {
    if (sourceLoading) {
      return;
    }
    setSourceModalOpen(false);
    setSourceError('');
  }

  async function submitSourceUrl(event) {
    if (event) event.preventDefault();
    const url = sourceUrl.trim();
    if (!url) {
      setSourceError('Informe a URL da lista M3U.');
      return;
    }

    setSourceLoading(true);
    setSourceError('');
    try {
      const payload = await requestJson('/api/catalog/source', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, catalogId: activeProfile?.catalogId }),
      });

      setStatus({
        hasData: payload.hasData,
        hasSource: true,
        counts: payload.counts,
        updatedAt: payload.updatedAt,
      });
      setSourceUrl('');
      setSourceModalOpen(false);
      setError('');
    } catch (requestError) {
      setSourceError(requestError.message || 'Nao foi possivel baixar a lista informada.');
    } finally {
      setSourceLoading(false);
    }
  }

  async function loadPage() {
    if (!isListView || !status.hasData) {
      return;
    }

    setPageLoading(true);
    setError('');

    try {
      const payload = await requestJson('/api/catalog/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          section: activeSection,
          page,
          pageSize: PAGE_SIZE,
          query: debouncedQuery,
          category: activeCategory,
          year: activeYear,
          genre: activeGenre,
          maxAgeRating: activeProfile?.maxAgeRating ?? null,
          catalogId: activeProfile?.catalogId,
          ids: activeSectionIds,
        }),
      });

      setItems(payload.items);
      setPagination(payload.pagination);
      setFilterOptions(payload.filters);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPageLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setBootLoading(true);
      setError('');

      try {
        const currentStatus = await fetchStatus();

        if (!currentStatus.hasData && isAdmin) {
          if (currentStatus.hasSource === false) {
            // Sem provedor configurado (sem usuario/senha): pede a URL direta da lista.
            if (!cancelled) {
              setSourceModalOpen(true);
            }
          } else {
            try {
              const synced = await syncCatalog(false);
              if (cancelled) {
                return;
              }
              setStatus({
                hasData: synced.hasData,
                hasSource: true,
                counts: synced.counts,
                updatedAt: synced.updatedAt,
              });
            } catch {
              // Se a sincronizacao falhar, oferece a URL direta como alternativa.
              if (!cancelled) {
                setSourceModalOpen(true);
              }
            }
          }
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message);
        }
      } finally {
        if (!cancelled) {
          setBootLoading(false);
        }
      }
    }

    if (!authUser || !activeProfileId) {
      setBootLoading(false);
      return undefined;
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [authUser, activeProfileId, isAdmin]);

  useEffect(() => {
    loadPage();
  }, [activeSection, page, debouncedQuery, activeCategory, activeYear, activeGenre, status.hasData, activeProfile?.maxAgeRating, activeSectionIds]);

  function toggleFavorite(itemId) {
    setFavorites((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    );
  }

  function toggleWatchLater(itemId) {
    setWatchLater((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    );
  }

  function toggleRecommendation(item) {
    const snapshot = createCatalogItemSnapshot(item);
    if (!snapshot) {
      return;
    }

    setRecommendations((current) =>
      current.some((entry) => entry?.item?.id === snapshot.id)
        ? current.filter((entry) => entry?.item?.id !== snapshot.id)
        : [
            {
              item: snapshot,
              addedAt: new Date().toISOString(),
            },
            ...current,
          ],
    );
  }

  function openSyncConfirm() {
    const challenge = createCaptchaChallenge();
    setCaptchaPrompt(challenge.prompt);
    setCaptchaAnswer(challenge.answer);
    setCaptchaValue('');
    setCaptchaError('');
    setSyncConfirmOpen(true);
  }

  function closeSyncConfirm() {
    if (syncLoading) {
      return;
    }

    setSyncConfirmOpen(false);
    setCaptchaValue('');
    setCaptchaError('');
  }

  async function confirmSync() {
    if (captchaValue.trim() !== captchaAnswer) {
      setCaptchaError('Captcha incorreto. Tente novamente.');
      return;
    }

    setCaptchaError('');
    try {
      await syncCatalog(true);
      setSyncConfirmOpen(false);
      setCaptchaValue('');
    } catch {
      // O erro principal ja aparece no estado global.
    }
  }

  const openDetails = useCallback((item) => {
    if (!isItemAllowedForProfile(item, activeProfile)) {
      setError(`O perfil ${activeProfile.name} nao pode abrir este conteudo pela faixa etaria.`);
      return;
    }

    setRecentItem(item);
    setPreviousSection(activeSection);
    setActiveSection('details');
    setDetailsItem(item);
  }, [activeProfile, activeSection]);

  const openPlayer = useCallback((item) => {
    if (!isItemAllowedForProfile(item, activeProfile)) {
      setError(`O perfil ${activeProfile.name} nao pode abrir este conteudo pela faixa etaria.`);
      return;
    }

    setRecentItem(item);
    setSelectedItem(item);
  }, [activeProfile]);

  const playFromDetails = useCallback((item) => {
    if (!isItemAllowedForProfile(item, activeProfile)) {
      setError(`O perfil ${activeProfile.name} nao pode abrir este conteudo pela faixa etaria.`);
      return;
    }
    setRecentItem(item);
    setSelectedItem(item);
    setDetailsItem(null);
  }, [activeProfile]);

  const closeDetailsModal = useCallback(() => {
    setDetailsItem(null);
  }, []);

  const handleSuggestionClick = useCallback((suggestionItem) => {
    if (!suggestionItem) return;
    setDetailsItem(suggestionItem);
    if (carouselRef.current) {
      carouselRef.current.scrollLeft = 0;
      setScrollLeft(0);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const openCastModal = useCallback(async (baseQuery, contentType) => {
    const safeQuery = String(baseQuery || '').trim();
    if (!safeQuery) {
      return;
    }
    setCastModalData(null);
    setCastModalError('');
    setCastModalLoading(true);
    try {
      const query = new URLSearchParams({ q: safeQuery });
      if (contentType) {
        query.set('type', contentType);
      }
      const payload = await requestJson(`/api/cast-lookup?${query.toString()}`);
      if (!payload?.ok) {
        throw new Error(payload?.message || 'Falha ao buscar elenco.');
      }
      setCastModalData(payload);
    } catch (err) {
      setCastModalError(err?.message || 'Erro ao consultar o Google. Tente novamente.');
    } finally {
      setCastModalLoading(false);
    }
  }, []);

  const savePlaybackProgress = useCallback((item, position, duration) => {
    setPlaybackProgress((current) => ({
      ...current,
      [item.id]: {
        itemId: item.id,
        item: createPlaybackItemSnapshot(item),
        position,
        duration,
        updatedAt: new Date().toISOString(),
      },
    }));
  }, []);

  const clearPlaybackProgress = useCallback((itemId) => {
    setPlaybackProgress((current) => {
      if (!current[itemId]) {
        return current;
      }

      const next = { ...current };
      delete next[itemId];
      return next;
    });
  }, []);

  const markItemAsWatched = useCallback((item) => {
    if (!item?.id) {
      return;
    }

    setWatchedMap((current) => ({
      ...current,
      [item.id]: {
        itemId: item.id,
        watchedAt: new Date().toISOString(),
      },
    }));
  }, []);

  const updatePlayerPreferences = useCallback((patch) => {
    setPlayerPreferences((current) => ({
      ...current,
      ...patch,
    }));
  }, []);

  const removeContinueWatchingItem = useCallback((itemId) => {
    clearPlaybackProgress(itemId);
  }, [clearPlaybackProgress]);

  function handleCatalogAction(item) {
    openDetails(item);
  }

  function handleEpisodePlay(episode) {
    setSelectedSeriesKey('');
    openPlayer(episode);
  }

  function applySearchHistoryEntry(value) {
    setQuery(value);
  }

  function removeSearchHistoryEntry(value) {
    setSearchHistory((current) => current.filter((entry) => entry !== value));
  }

  function clearSearchHistory() {
    setSearchHistory([]);
  }

  async function handleProfileAgeUpdate(profileId, value) {
    try {
      const maxAgeRating = value ? Number(value) : null;
      await requestJson(`/api/profiles/${encodeURIComponent(profileId)}`, {
        method: 'PUT',
        body: JSON.stringify({ maxAgeRating }),
      });
      await refreshProfilesFromApi();
    } catch (err) {
      setError(err?.message || 'Erro ao atualizar faixa etaria.');
    }
  }

  async function handleAddProfile(name, maxAgeRatingValue) {
    if (!name || !String(name).trim()) {
      setError('Nome do perfil obrigatorio.');
      return false;
    }
    try {
      const payload = await requestJson('/api/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: String(name).trim(),
          maxAgeRating: maxAgeRatingValue ? Number(maxAgeRatingValue) : null,
        }),
      });
      await refreshProfilesFromApi();
      if (payload?.profile?.id) {
        setActiveProfileId(payload.profile.id);
      }
      setError('');
      return true;
    } catch (err) {
      setError(err?.message || 'Erro ao criar perfil.');
      return false;
    }
  }

  function openUserEdit() {
    if (!authUser) return;
    setUserEditForm({
      nome: String(authUser.nome || ''),
      foto: String(authUser.foto || ''),
    });
    setUserEditError('');
    setUserEditLoading(false);
    setUserEditOpen(true);
  }

  function closeUserEdit() {
    if (userEditLoading) return;
    setUserEditOpen(false);
    setUserEditError('');
  }

  async function submitUserEdit(event) {
    if (event) event.preventDefault();
    const nome = String(userEditForm.nome || '').trim();
    if (!nome) {
      setUserEditError('Nome obrigatorio.');
      return;
    }
    setUserEditLoading(true);
    setUserEditError('');
    try {
      const body = {
        nome,
        foto: String(userEditForm.foto || ''),
      };
      const payload = await requestJson('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (payload?.ok && payload?.user) {
        setAuthUser(payload.user);
        if (Array.isArray(payload.profiles)) setAuthProfiles(payload.profiles);
        closeUserEdit();
      }
    } catch (err) {
      setUserEditError(err?.message || 'Erro ao salvar dados da conta.');
    } finally {
      setUserEditLoading(false);
    }
  }

  function openPasswordChange() {
    setPasswordChangeForm({ currentPassword: '', password: '', confirmPassword: '' });
    setPasswordChangeError('');
    setPasswordChangeLoading(false);
    setPasswordChangeOpen(true);
  }

  function closePasswordChange() {
    if (passwordChangeLoading) return;
    setPasswordChangeOpen(false);
    setPasswordChangeError('');
  }

  async function submitPasswordChange(event) {
    if (event) event.preventDefault();
    const currentPassword = String(passwordChangeForm.currentPassword || '');
    const password = String(passwordChangeForm.password || '');
    const confirmPassword = String(passwordChangeForm.confirmPassword || '');
    if (!currentPassword) {
      setPasswordChangeError('Informe a sua senha atual.');
      return;
    }
    if (password.length < 6) {
      setPasswordChangeError('A nova senha deve ter pelo menos 6 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setPasswordChangeError('A nova senha e a confirmacao nao coincidem.');
      return;
    }
    setPasswordChangeLoading(true);
    setPasswordChangeError('');
    try {
      const payload = await requestJson('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, password }),
      });
      if (payload?.ok) {
        closePasswordChange();
      }
    } catch (err) {
      setPasswordChangeError(err?.message || 'Erro ao alterar a senha.');
    } finally {
      setPasswordChangeLoading(false);
    }
  }

  function getAvatarGalleryTargetInitial() {
    if (!avatarGalleryTarget) return '';
    if (avatarGalleryTarget.kind === 'user') {
      return String(userEditForm.foto || authUser?.foto || '');
    }
    if (avatarGalleryTarget.kind === 'profile') {
      const profile = authProfiles.find((p) => p.id === avatarGalleryTarget.id);
      return String(profile?.avatar || profileForm.avatar || '');
    }
    return '';
  }

  async function openAvatarGallery(kind, profileId = null) {
    setAvatarGalleryTarget(kind ? { kind, id: profileId || null } : null);
    setAvatarGalleryLoading(true);
    setAvatarGalleryPublic([]);
    setAvatarGalleryPrivate([]);
    setAvatarGalleryUploading(false);
    setAvatarGalleryOpen(true);
    try {
      const payload = await requestJson('/api/avatars');
      if (payload?.ok) {
        setAvatarGalleryPublic(Array.isArray(payload.public) ? payload.public : []);
        setAvatarGalleryPrivate(Array.isArray(payload.private) ? payload.private : []);
      }
    } catch (err) {
      setError(err?.message || 'Erro ao carregar galeria de avatares.');
    } finally {
      setAvatarGalleryLoading(false);
    }
  }

  function closeAvatarGallery() {
    if (avatarGalleryUploading) return;
    setAvatarGalleryOpen(false);
    setAvatarGalleryTarget(null);
    setAvatarGalleryPublic([]);
    setAvatarGalleryPrivate([]);
  }

  async function applyAvatar(url) {
    if (!avatarGalleryTarget) return;
    try {
      const body = {
        target: avatarGalleryTarget.kind,
        url: String(url || ''),
      };
      if (avatarGalleryTarget.kind === 'profile' && avatarGalleryTarget.id) {
        body.profileId = avatarGalleryTarget.id;
      }
      const payload = await requestJson('/api/avatars/apply', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!payload?.ok) throw new Error(payload?.message || 'Erro ao aplicar avatar.');
      if (avatarGalleryTarget.kind === 'user' && payload?.user) {
        setAuthUser(payload.user);
        setUserEditForm((f) => ({ ...f, foto: String(payload.user.foto || '') }));
      }
      if (avatarGalleryTarget.kind === 'profile' && payload?.profile) {
        await refreshProfilesFromApi();
        if (payload.profile.id && profileEditId === payload.profile.id) {
          setProfileForm((f) => ({ ...f, avatar: String(payload.profile.avatar || '') }));
        }
      }
      closeAvatarGallery();
    } catch (err) {
      setError(err?.message || 'Erro ao aplicar avatar.');
    }
  }

  function avatarGalleryPickFile(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    avatarGalleryUploadBlob(file, file.name || 'avatar_upload');
  }

  function avatarGalleryPickCamera() {
    if (!window.navigator?.mediaDevices?.getUserMedia) {
      setError('Seu navegador nao suporta captura pela camera.');
      return;
    }
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;';
    const video = document.createElement('video');
    video.style.cssText = 'max-width:100%;max-height:70vh;border-radius:14px;border:1px solid rgba(148,163,184,0.2);';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;';
    const shoot = document.createElement('button');
    shoot.textContent = 'Capturar foto';
    shoot.className = 'primary-btn';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancelar';
    cancel.className = 'ghost-btn';
    actions.append(shoot, cancel);
    root.append(video, actions);
    document.body.appendChild(root);

    function closeCam(stream) {
      try { stream?.getTracks?.()?.forEach((t) => t.stop()); } catch {}
      try { document.body.removeChild(root); } catch {}
    }

    (async () => {
      let stream;
      try {
        stream = await window.navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
        video.srcObject = stream;
        await video.play();
      } catch (err) {
        closeCam(stream);
        setError('Nao foi possivel acessar a camera: ' + (err?.message || 'erro desconhecido'));
        return;
      }
      cancel.addEventListener('click', () => closeCam(stream));
      shoot.addEventListener('click', () => {
        try {
          const canvas = document.createElement('canvas');
          const width = video.videoWidth || 720;
          const height = video.videoHeight || 720;
          const side = Math.min(width, height);
          canvas.width = side;
          canvas.height = side;
          const ctx = canvas.getContext('2d');
          const sx = (width - side) / 2;
          const sy = (height - side) / 2;
          ctx.drawImage(video, sx, sy, side, side, 0, 0, side, side);
          canvas.toBlob((blob) => {
            closeCam(stream);
            if (!blob) {
              setError('Nao foi possivel gerar a foto.');
              return;
            }
            avatarGalleryUploadBlob(blob, `camera_${Date.now()}.jpg`);
          }, 'image/jpeg', 0.92);
        } catch (err) {
          closeCam(stream);
          setError('Erro ao capturar foto: ' + (err?.message || 'erro'));
        }
      });
    })();
  }

  async function avatarGalleryUploadBlob(blob, filename) {
    if (!blob || !blob.size) {
      setError('Arquivo vazio ou invalido.');
      return;
    }
    if (blob.size > 4 * 1024 * 1024) {
      setError('Arquivo muito grande (maximo 4 MB).');
      return;
    }
    setAvatarGalleryUploading(true);
    setError('');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('Erro ao ler arquivo.'));
        fr.onload = () => resolve(String(fr.result || ''));
        fr.readAsDataURL(blob);
      });
      const payload = await requestJson('/api/avatars/upload', {
        method: 'POST',
        body: JSON.stringify({
          filename: String(filename || 'avatar_upload'),
          dataUrl,
        }),
      });
      if (!payload?.ok || !payload?.avatar?.url) {
        throw new Error(payload?.message || 'Erro ao enviar avatar.');
      }
      setAvatarGalleryPrivate((current) => {
        if (!Array.isArray(current)) return [payload.avatar];
        if (current.some((a) => a?.url === payload.avatar.url)) return current;
        return [payload.avatar, ...current];
      });
      await applyAvatar(payload.avatar.url);
    } catch (err) {
      setError(err?.message || 'Erro ao enviar avatar.');
    } finally {
      setAvatarGalleryUploading(false);
    }
  }

  function renderDeleteProfileModal() {
    if (!deleteProfileOpen) return null;
    const profile = authProfiles.find((item) => item.id === deleteProfileId);
    return (
      <div className="modal-overlay" onClick={closeDeleteProfile} role="dialog" aria-modal="true">
        <div className="modal-panel sync-confirm-panel" onClick={(event) => event.stopPropagation()}>
          <header className="modal-head">
            <div>
              <h2>Excluir perfil</h2>
              <p>Confirme a exclusao do perfil abaixo.</p>
            </div>
            <button type="button" className="ghost-btn" onClick={closeDeleteProfile} aria-label="Fechar" disabled={deleteProfileLoading}>
              Fechar
            </button>
          </header>

          <form className="profile-form" onSubmit={confirmDeleteProfile}>
            <div className="confirm-profile-row">
              {profile?.avatar ? (
                <div className="profile-pick-avatar has-image">
                  <img src={profile.avatar} alt={`Avatar de ${profile.name || 'perfil'}`} />
                </div>
              ) : (
                <div className="profile-pick-avatar" style={{ background: profile?.color || '#7c3aed' }}>
                  <span>{String(profile?.name || '?').slice(0, 2).toUpperCase()}</span>
                </div>
              )}
              <div>
                <strong>{profile?.name || 'Perfil'}</strong>
                <small>{formatProfileAgeLabel(profile?.maxAgeRating >= 999 ? null : profile?.maxAgeRating)}</small>
              </div>
            </div>

            <div className="sync-confirm-warning">
              <strong>Aviso:</strong>
              <span>
                Os favoritos, historico e progresso deste perfil salvos neste navegador nao serao apagados automaticamente.
                A exclusao remove o perfil do servidor e impede novos logins com ele. Nao sera possivel desfazer.
              </span>
            </div>

            <label className="captcha-field">
              <span>Para confirmar, digite <strong>{deleteProfileCaptcha}</strong> abaixo:</span>
              <input
                type="text"
                value={deleteProfileConfirm}
                autoFocus
                autoComplete="off"
                spellCheck="false"
                onChange={(event) => setDeleteProfileConfirm(event.target.value)}
                placeholder={`Digite ${deleteProfileCaptcha}`}
                disabled={deleteProfileLoading}
              />
            </label>

            {error && <div className="inline-alert sync-error">{error}</div>}

            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={closeDeleteProfile} disabled={deleteProfileLoading}>
                Cancelar
              </button>
              <button
                type="submit"
                className="primary-btn is-danger"
                disabled={deleteProfileLoading || String(deleteProfileConfirm || '').trim() !== deleteProfileCaptcha}
              >
                {deleteProfileLoading ? 'Excluindo...' : 'Excluir perfil permanentemente'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  function renderSuspendedScreen() {
    return (
      <section className="auth-screen auth-profiles">
        <div className="auth-bg" />
        <div className="profile-picker-panel">
          <header className="profile-picker-head">
            <div className="picker-head-user">
              <div>
                <span className="picker-hello">Acesso bloqueado</span>
                <h1>{suspendedInfo?.user?.nome || 'Conta suspensa'}</h1>
                <p>{suspendedInfo?.reason || 'Sua conta esta suspensa. Entre em contato com o administrador.'}</p>
              </div>
            </div>
          </header>
          <div className="picker-head-actions">
            <button type="button" className="ghost-btn" onClick={() => setSuspendedInfo(null)}>
              Voltar para o login
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderLoginScreen() {
    return (
      <section className="auth-screen auth-login">
        <div className="auth-bg" />
        <div className="auth-panel">
          <div className="auth-brand">
            <div className="logo-badge is-large">TV</div>
            <div>
              <strong>IPTV Particular</strong>
              <span>Entre com sua conta para continuar.</span>
            </div>
          </div>

          {authError && <div className="inline-alert is-auth">{authError}</div>}

          <form className="auth-form" onSubmit={handleLoginSubmit}>
            <label className="auth-field">
              <span>Usuario</span>
              <input
                type="text"
                autoComplete="username"
                value={loginForm.username}
                onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="Digite seu usuario"
                disabled={loginLoading}
              />
            </label>
            <label className="auth-field">
              <span>Senha</span>
              <input
                type="password"
                autoComplete="current-password"
                value={loginForm.password}
                onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="Digite sua senha"
                disabled={loginLoading}
              />
            </label>
            <button type="submit" className="primary-btn is-large" disabled={loginLoading}>
              {loginLoading ? 'Entrando...' : 'Entrar'}
            </button>
            <small className="auth-hint">
              
            </small>
          </form>
        </div>
      </section>
    );
  }

  function renderProfileFormModal() {
    if (!profileAddOpen) return null;
    const isEdit = Boolean(profileEditId);
    const avatarPreviewUrl = String(profileForm.avatar || '');
    return (
      <div className="modal-overlay" onClick={closeProfileForm}>
        <div className="modal-panel is-profile" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header className="modal-head">
            <h2>{isEdit ? 'Editar perfil' : 'Adicionar perfil'}</h2>
            <button type="button" className="ghost-btn" onClick={closeProfileForm} disabled={profileFormLoading}>
              Fechar
            </button>
          </header>
          <form className="profile-form" onSubmit={submitProfileForm}>
            {profileFormError && <div className="inline-alert">{profileFormError}</div>}
            <div className="avatar-edit-row">
              <button
                type="button"
                className="avatar-preview-btn"
                onClick={() => openAvatarGallery('profile', isEdit ? profileEditId : null)}
                disabled={profileFormLoading}
              >
                {avatarPreviewUrl ? (
                  <img src={avatarPreviewUrl} alt="Avatar do perfil" />
                ) : (
                  <div className="profile-pick-avatar" style={{ background: profileForm.color || '#7c3aed' }}>
                    <span>{String(profileForm.name || '?').slice(0, 2).toUpperCase()}</span>
                  </div>
                )}
                <small>{avatarPreviewUrl ? 'Trocar foto' : 'Escolher foto'}</small>
              </button>
              <div>
                <strong>Foto do perfil</strong>
                <p>Escolha uma foto da biblioteca publica ou envie a sua propria.</p>
              </div>
            </div>
            <label className="auth-field">
              <span>Nome</span>
              <input
                type="text"
                value={profileForm.name}
                onChange={(event) => setProfileForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nome do perfil"
                disabled={profileFormLoading}
                autoFocus
              />
            </label>
            <label className="auth-field">
              <span>Cor</span>
              <input
                type="color"
                value={profileForm.color || '#e11d48'}
                onChange={(event) => setProfileForm((current) => ({ ...current, color: event.target.value }))}
                disabled={profileFormLoading}
              />
            </label>
            <label className="auth-field">
              <span>Faixa etaria maxima</span>
              <select
                value={profileForm.maxAgeRating}
                onChange={(event) => setProfileForm((current) => ({ ...current, maxAgeRating: event.target.value }))}
                disabled={profileFormLoading}
              >
                <option value="">Sem restricao</option>
                {PROFILE_AGE_OPTIONS.filter(Boolean).map((age) => (
                  <option key={age} value={age}>Ate {age} anos</option>
                ))}
              </select>
            </label>
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={closeProfileForm} disabled={profileFormLoading}>
                Cancelar
              </button>
              <button type="submit" className="primary-btn" disabled={profileFormLoading}>
                {profileFormLoading ? 'Salvando...' : (isEdit ? 'Salvar' : 'Criar perfil')}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  function renderUserEditModal() {
    if (!userEditOpen) return null;
    const userPreviewUrl = String(userEditForm.foto || authUser?.foto || '');
    const emailDisplay = String(authUser?.email || '').trim();
    return (
      <div className="modal-overlay" onClick={closeUserEdit}>
        <div className="modal-panel is-profile is-user-edit" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header className="modal-head">
            <div>
              <h2>Editar conta</h2>
              <p>Atualize seu nome ou a foto da sua conta. Para alterar sua senha use a opcao separada.</p>
            </div>
            <button type="button" className="ghost-btn" onClick={closeUserEdit} disabled={userEditLoading}>
              Fechar
            </button>
          </header>
          <form className="profile-form" onSubmit={submitUserEdit}>
            {userEditError && <div className="inline-alert sync-error">{userEditError}</div>}
            <div className="avatar-edit-row">
              <button
                type="button"
                className="avatar-preview-btn"
                onClick={() => openAvatarGallery('user', null)}
                disabled={userEditLoading}
              >
                {userPreviewUrl ? (
                  <img src={userPreviewUrl} alt="Foto do usuario" />
                ) : (
                  <div className="profile-pick-avatar" style={{ background: '#1f2937' }}>
                    <span>{String(userEditForm.nome || authUser?.nome || '?').slice(0, 2).toUpperCase()}</span>
                  </div>
                )}
                <small>{userPreviewUrl ? 'Trocar foto' : 'Escolher foto'}</small>
              </button>
              <div>
                <strong>Sua foto</strong>
                <p>A foto da conta aparece na tela de perfis, menu e configuracoes.</p>
              </div>
            </div>
            <label className="auth-field">
              <span>Nome</span>
              <input
                type="text"
                value={userEditForm.nome}
                onChange={(event) => setUserEditForm((current) => ({ ...current, nome: event.target.value }))}
                placeholder="Como voce quer ser chamado"
                disabled={userEditLoading}
                autoFocus
              />
            </label>
            <div className="auth-field is-readonly">
              <span>Login (nao pode ser alterado)</span>
              <div className="auth-readonly-value">
                <strong>{String(authUser?.usuario || 'Usuario')}</strong>
              </div>
            </div>
            {emailDisplay && (
              <div className="auth-field is-readonly">
                <span>Email (nao pode ser alterado aqui)</span>
                <div className="auth-readonly-value">
                  <strong>{emailDisplay}</strong>
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={closeUserEdit} disabled={userEditLoading}>
                Cancelar
              </button>
              <button type="button" className="ghost-btn" onClick={() => { closeUserEdit(); openPasswordChange(); }} disabled={userEditLoading}>
                Alterar senha
              </button>
              <button type="submit" className="primary-btn" disabled={userEditLoading}>
                {userEditLoading ? 'Salvando...' : 'Salvar dados da conta'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  function renderChangePasswordModal() {
    if (!passwordChangeOpen) return null;
    return (
      <div className="modal-overlay" onClick={closePasswordChange}>
        <div className="modal-panel is-change-password" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header className="modal-head">
            <div>
              <h2>Alterar senha</h2>
              <p>Para sua seguranca, informe a senha atual e depois a nova senha. Esta operacao nao pode ser desfeita automaticamente.</p>
            </div>
            <button type="button" className="ghost-btn" onClick={closePasswordChange} disabled={passwordChangeLoading}>
              Fechar
            </button>
          </header>
          <form className="profile-form" onSubmit={submitPasswordChange}>
            {passwordChangeError && <div className="inline-alert sync-error">{passwordChangeError}</div>}
            <label className="auth-field">
              <span>Senha atual</span>
              <input
                type="password"
                value={passwordChangeForm.currentPassword}
                onChange={(event) => setPasswordChangeForm((current) => ({ ...current, currentPassword: event.target.value }))}
                placeholder="Informe a sua senha atual"
                autoFocus
                disabled={passwordChangeLoading}
                autoComplete="current-password"
              />
            </label>
            <label className="auth-field">
              <span>Nova senha</span>
              <input
                type="password"
                value={passwordChangeForm.password}
                onChange={(event) => setPasswordChangeForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="Pelo menos 6 caracteres"
                disabled={passwordChangeLoading}
                autoComplete="new-password"
              />
            </label>
            <label className="auth-field">
              <span>Confirmar nova senha</span>
              <input
                type="password"
                value={passwordChangeForm.confirmPassword}
                onChange={(event) => setPasswordChangeForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                placeholder="Repita a nova senha"
                disabled={passwordChangeLoading}
                autoComplete="new-password"
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={closePasswordChange} disabled={passwordChangeLoading}>
                Cancelar
              </button>
              <button type="submit" className="primary-btn is-danger" disabled={passwordChangeLoading}>
                {passwordChangeLoading ? 'Alterando...' : 'Confirmar nova senha'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  function renderAvatarGalleryModal() {
    if (!avatarGalleryOpen) return null;
    const publicList = Array.isArray(avatarGalleryPublic) ? avatarGalleryPublic : [];
    const privateList = Array.isArray(avatarGalleryPrivate) ? avatarGalleryPrivate : [];
    const selectedInitial = getAvatarGalleryTargetInitial();
    return (
      <div className="modal-overlay" onClick={closeAvatarGallery}>
        <div className="modal-panel is-avatar-gallery" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header className="modal-head">
            <div>
              <h2>Escolher foto</h2>
              <p>Avatare publicos aparecem para todos os usuarios. Avatares pessoais so voce ve.</p>
            </div>
            <button type="button" className="ghost-btn" onClick={closeAvatarGallery} disabled={avatarGalleryUploading}>
              Fechar
            </button>
          </header>
          <div className="avatar-gallery-body">
            <div className="avatar-gallery-actions">
              <label className="primary-btn" htmlFor="avatar-file-upload" title="Maximo 4 MB">
                <input
                  id="avatar-file-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  style={{ display: 'none' }}
                  onChange={avatarGalleryPickFile}
                  disabled={avatarGalleryUploading}
                />
                Enviar foto do dispositivo
              </label>
              <button type="button" className="ghost-btn" onClick={avatarGalleryPickCamera} disabled={avatarGalleryUploading}>
                Tirar foto com a camera
              </button>
              <button
                type="button"
                className="ghost-btn is-danger"
                onClick={() => applyAvatar('')}
                disabled={avatarGalleryUploading || !selectedInitial}
                title="Remove a foto atual e volta ao padrao (iniciais / cor)"
              >
                Remover foto atual
              </button>
              {avatarGalleryUploading && <span className="inline-warn">Enviando imagem...</span>}
            </div>

            {avatarGalleryLoading ? (
              <div className="empty-state">
                <strong>Carregando biblioteca...</strong>
              </div>
            ) : (
              <>
                {privateList.length > 0 && (
                  <section className="avatar-gallery-group">
                    <header>
                      <h3>Minhas fotos pessoais</h3>
                      <span>So voce pode ver e usar essas imagens.</span>
                    </header>
                    <div className="avatar-gallery-grid">
                      {privateList.map((a) => (
                        <button
                          key={a.url}
                          type="button"
                          className={`avatar-thumb ${selectedInitial === a.url ? 'is-selected' : ''}`}
                          onClick={() => applyAvatar(a.url)}
                          disabled={avatarGalleryUploading}
                        >
                          <img src={a.url} alt={a.label} loading="lazy" />
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <section className="avatar-gallery-group">
                  <header>
                    <h3>Biblioteca publica</h3>
                    <span>Fotos compartilhadas com todos os usuarios do sistema.</span>
                  </header>
                  {publicList.length === 0 ? (
                    <div className="empty-state compact">
                      <strong>Sem avatares publicos ainda</strong>
                      <span>O administrador pode colocar imagens na pasta <code>media/avatar_publico</code> do servidor.</span>
                    </div>
                  ) : (
                    <div className="avatar-gallery-grid">
                      {publicList.map((a) => (
                        <button
                          key={a.url}
                          type="button"
                          className={`avatar-thumb ${selectedInitial === a.url ? 'is-selected' : ''}`}
                          onClick={() => applyAvatar(a.url)}
                          disabled={avatarGalleryUploading}
                        >
                          <img src={a.url} alt={a.label} loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderProfilePickerScreen() {
    return (
      <section className="auth-screen auth-profiles">
        <div className="auth-bg" />
        <div className="profile-picker-panel">
          <header className="profile-picker-head">
            <div className="picker-head-user">
              {authUser?.foto ? (
                <span className="user-chip-avatar is-readonly">
                  <img src={authUser.foto} alt="Foto do usuario" />
                </span>
              ) : (
                <span className="user-chip-avatar is-readonly">
                  <span style={{ background: '#4338ca' }}>
                    {String(authUser?.nome || 'U').slice(0, 2).toUpperCase()}
                  </span>
                </span>
              )}
              <div>
                <span className="picker-hello">Ola,</span>
                <h1>{authUser?.nome || 'Usuario'}</h1>
                <p>Escolha um perfil para continuar ou crie um novo (maximo 5).</p>
              </div>
            </div>
            <div className="picker-head-actions">
              <button type="button" className="ghost-btn is-danger" onClick={handleLogout}>
                Sair da conta
              </button>
            </div>
          </header>

          <div className="profile-picker-grid">
            {authProfiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className="profile-pick-card"
                onClick={() => {
                  setActiveProfileId(profile.id);
                  setActiveSection('home');
                  setProfileModalOpen(false);
                  setSelectedItem(null);
                  setSelectedSeriesKey('');
                  setError('');
                }}
              >
                {profile.avatar ? (
                  <div className="profile-pick-avatar has-image">
                    <img src={profile.avatar} alt={`Avatar de ${profile.name}`} />
                  </div>
                ) : (
                  <div className="profile-pick-avatar" style={{ background: profile.color || '#e11d48' }}>
                    <span>{String(profile.name || '?').slice(0, 2).toUpperCase()}</span>
                  </div>
                )}
                <strong>{profile.name}</strong>
                <small>{formatProfileAgeLabel(profile.maxAgeRating >= 999 ? null : profile.maxAgeRating)}</small>
              </button>
            ))}
            {authProfiles.length < 5 && (
              <button type="button" className="profile-pick-card is-add" onClick={() => {
                setActiveProfileId(authProfiles[0]?.id || '');
                setProfileModalOpen(true);
              }}>
                <div className="profile-pick-avatar is-add">
                  <span>+</span>
                </div>
                <strong>Gerenciar perfis</strong>
                <small>Criar, editar ou excluir</small>
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderMobileHeader() {
    return (
      <header className="mobile-header">
        <button type="button" className="mobile-brand" onClick={() => navigateToSection('home')}>
          <div className="logo-badge">TV</div>
          <div className="mobile-brand-copy">
            <strong>IPTV Particular</strong>
            <span>{activeProfile.name}</span>
          </div>
        </button>
        <button
          type="button"
          className="mobile-menu-btn"
          onClick={() => setMobileMenuOpen((current) => !current)}
          aria-label={mobileMenuOpen ? 'Fechar menu' : 'Abrir menu'}
          aria-expanded={mobileMenuOpen}
        >
          ☰
        </button>
      </header>
    );
  }

  function renderMobileMenu() {
    return (
      <div className={`mobile-menu-overlay ${mobileMenuOpen ? 'is-open' : ''}`} onClick={() => setMobileMenuOpen(false)}>
        <aside
          className="mobile-menu-panel"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="Menu principal"
        >
          <div className="mobile-menu-head">
            <div className="mobile-menu-user">
              {authUser?.foto ? (
                <button type="button" className="user-chip-avatar is-small" onClick={() => { setMobileMenuOpen(false); openUserEdit(); }}>
                  <img src={authUser.foto} alt="Foto do usuario" />
                </button>
              ) : (
                <button type="button" className="user-chip-avatar is-small" onClick={() => { setMobileMenuOpen(false); openUserEdit(); }}>
                  <span style={{ background: '#4338ca' }}>
                    {String(authUser?.nome || 'U').slice(0, 2).toUpperCase()}
                  </span>
                </button>
              )}
              <div>
                <strong>{authUser?.nome || 'Usuario'}</strong>
                <span>Perfil: {activeProfile.name}</span>
              </div>
            </div>
            <button type="button" className="mobile-menu-close" onClick={() => setMobileMenuOpen(false)} aria-label="Fechar menu">
              ×
            </button>
          </div>

          <div className="mobile-menu-section">
            <button type="button" className={activeSection === 'home' ? 'is-active' : ''} onClick={() => navigateToSection('home')}>
              Inicio
            </button>
            <button type="button" className={activeSection === 'live' ? 'is-active' : ''} onClick={() => navigateToSection('live')}>
              Live TV
            </button>
            <button type="button" className={activeSection === 'movie' ? 'is-active' : ''} onClick={() => navigateToSection('movie')}>
              Filmes
            </button>
            <button type="button" className={activeSection === 'series' ? 'is-active' : ''} onClick={() => navigateToSection('series')}>
              Series
            </button>
            <button type="button" className={activeSection === 'favorites' ? 'is-active' : ''} onClick={() => navigateToSection('favorites')}>
              Favoritos ({displayFavoriteCount})
            </button>
            <button type="button" className={activeSection === 'watch-later' ? 'is-active' : ''} onClick={() => navigateToSection('watch-later')}>
              Assistir mais tarde ({displayWatchLaterCount})
            </button>
            <button type="button" className={activeSection === 'recommendations' ? 'is-active' : ''} onClick={() => navigateToSection('recommendations')}>
              Indicados ({totalRecommendationCount})
            </button>
            <button type="button" className={activeSection === 'recent' ? 'is-active' : ''} onClick={() => navigateToSection('recent')}>
              Continuar
            </button>
            <button type="button" className={activeSection === 'settings' ? 'is-active' : ''} onClick={() => navigateToSection('settings')}>
              Configuracoes
            </button>
          </div>

          <div className="mobile-menu-section">
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                openUserEdit();
              }}
            >
              Editar conta
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                openPasswordChange();
              }}
            >
              Alterar senha
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                setActiveProfileId('');
              }}
            >
              Trocar perfil
            </button>
            <button
              type="button"
              onClick={() => {
                setProfileModalOpen(true);
                setMobileMenuOpen(false);
              }}
            >
              Gerenciar perfis
            </button>
            <button type="button" onClick={() => handleLogout()}>
              Sair da conta
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  openSyncConfirm();
                  setMobileMenuOpen(false);
                }}
                disabled={syncLoading}
              >
                {syncLoading ? 'Atualizando...' : 'Atualizar catalogo'}
              </button>
            )}
          </div>
        </aside>
      </div>
    );
  }

  function renderHome() {
    return (
      <section className="hero-page">
        {renderMobileHeader()}
        <header className="topbar">
          <div className="brand-block">
            <div className="logo-badge">TV</div>
            <div className="brand-copy">
              <strong>IPTV Particular</strong>
              <span>Perfil: {activeProfile.name}</span>
            </div>
            {activeProfile.catalogId && (
              <div className="brand-catalog">
                <span className="catalog-indicator">📺</span>
                <span>Catalogo: {activeProfile.catalogName || 'Carregando...'}</span>
              </div>
            )}
            <div className="clock-divider" />
            <div className="clock-copy">
              <strong>{new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</strong>
              <span>{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'short' })}</span>
            </div>
          </div>

          <div className="topbar-actions">
            {activeSection !== 'home' && (
              <div className="search-box" onFocusCapture={handleSearchFocus} onBlurCapture={handleSearchBlur}>
                <form className="search-form" onSubmit={handleSearchSubmit} role="search">
                  <label className="search-shell">
                    <span>⌕</span>
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.preventDefault();
                      }}
                      placeholder="Pesquisar"
                    />
                  </label>
                  <button type="submit" className="search-submit-btn" aria-label="Buscar">
                    <span>Buscar</span>
                  </button>
                </form>
                <SearchHistory
                  items={searchHistory}
                  onSelect={applySearchHistoryEntry}
                  onRemove={removeSearchHistoryEntry}
                  onClear={clearSearchHistory}
                  emptyLabel="Nenhuma busca recente"
                  visible={searchFocused}
                />
              </div>
            )}
            <div className="profile-menu-wrapper">
              <button
                type="button"
                className={`profile-chip is-menu-trigger ${profileMenuOpen ? 'is-open' : ''}`}
                onClick={() => setProfileMenuOpen((current) => !current)}
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
              >
                {activeProfile?.avatar ? (
                  <span className="profile-chip-avatar"><img src={activeProfile.avatar} alt="Avatar perfil" /></span>
                ) : (
                  <span className="profile-chip-avatar" style={{ background: activeProfile?.color || '#7c3aed' }}>
                    {String(activeProfile?.name || '?').slice(0, 2).toUpperCase()}
                  </span>
                )}
                {activeProfile.name}
                <span className="profile-chip-caret" aria-hidden>▾</span>
              </button>
              {profileMenuOpen && (
                <>
                  <div className="profile-menu-backdrop" onClick={() => setProfileMenuOpen(false)} />
                  <div className="profile-menu-panel" role="menu" aria-label="Opcoes do perfil">
                    <div className="profile-menu-head">
                      {authUser?.foto ? (
                        <span className="profile-menu-user-avatar"><img src={authUser.foto} alt="Foto do usuario" /></span>
                      ) : (
                        <span className="profile-menu-user-avatar" style={{ background: '#4338ca' }}>
                          {String(authUser?.nome || 'U').slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <div>
                        <strong>{authUser?.nome || 'Usuario'}</strong>
                        <small>Perfil: {activeProfile.name}</small>
                      </div>
                    </div>
                    <div className="profile-menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        if (activeProfile) openProfileEdit(activeProfile);
                      }}
                    >
                      Editar perfil
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setActiveProfileId('');
                      }}
                    >
                      Trocar perfil
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        openPasswordChange();
                      }}
                    >
                      Alterar senha
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setProfileModalOpen(true);
                      }}
                    >
                      Gerenciar perfis
                    </button>
                    <div className="profile-menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        handleLogout();
                      }}
                    >
                      Sair da conta
                    </button>
                  </div>
                </>
              )}
            </div>
            <button type="button" className="icon-pill has-count" onClick={() => setActiveSection('favorites')}>
              <span>❤</span>
              <strong>{displayFavoriteCount}</strong>
            </button>
            <button type="button" className="icon-pill has-count" onClick={() => setActiveSection('watch-later')}>
              <span>◷</span>
              <strong>{displayWatchLaterCount}</strong>
            </button>
            <button type="button" className="icon-pill has-count" onClick={() => setActiveSection('recommendations')}>
              <span>✦</span>
              <strong>{totalRecommendationCount}</strong>
            </button>
            <button type="button" className="icon-pill" onClick={() => setActiveSection('settings')}>⚙</button>

          </div>
        </header>

        <div className="hero-grid">
          <div className="hero-main">
            <div className="hero-cards">
              {SECTIONS.map((section) => (
                <button key={section.key} type="button" className="hero-card" onClick={() => setActiveSection(section.key)}>
                  <span className="hero-icon">{section.icon}</span>
                  <h2>{section.label}</h2>
                  <p>
                    {section.key === 'live' && statLabel(status.counts.live || 0, 'Canal', 'Canais')}
                    {section.key === 'movie' && statLabel(status.counts.movie || 0, 'Filme', 'Filmes')}
                    {section.key === 'series' && statLabel(status.counts.series || 0, 'Serie', 'Series')}
                  </p>
                </button>
              ))}
            </div>

            <section className="continue-strip">
              <div className="continue-strip-header">
                <div>
                  <h2>Continuar assistindo</h2>
                  <p>Ultimos videos em andamento salvos neste perfil.</p>
                </div>
                <button type="button" className="ghost-btn" onClick={() => setActiveSection('recent')}>
                  Ver lista completa
                </button>
              </div>

              {continueWatchingItems.length ? (
                <div className="continue-grid">
                  {continueWatchingItems.slice(0, 6).map(({ item: progressItem, progressEntry }) => (
                    <ContinueWatchingCard
                      key={progressItem.id}
                      item={progressItem}
                      progressEntry={progressEntry}
                      watched={Boolean(watchedMap[progressItem.id])}
                      onPlay={openPlayer}
                      onRemove={removeContinueWatchingItem}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state continue-empty">
                  <strong>Nada para continuar agora</strong>
                  <span>Quando voce parar um filme ou episodio no meio, ele aparece aqui.</span>
                </div>
              )}
            </section>
          </div>

          <aside className="quick-panel">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.key}
                type="button"
                className="quick-action"
                onClick={() => {
                  if (action.key === 'catalog') setActiveSection('live');
                  if (action.key === 'favorites') setActiveSection('favorites');
                  if (action.key === 'watch-later') setActiveSection('watch-later');
                  if (action.key === 'recommendations') setActiveSection('recommendations');
                  if (action.key === 'settings') setActiveSection('settings');
                  if (action.key === 'recent') setActiveSection('recent');
                }}
              >
                <span>{action.icon}</span>
                <strong>{action.label}</strong>
                {(action.key === 'favorites' || action.key === 'watch-later' || action.key === 'recommendations') && (
                  <small>
                    {action.key === 'favorites'
                      ? displayFavoriteCount
                      : action.key === 'watch-later'
                        ? displayWatchLaterCount
                        : totalRecommendationCount}
                  </small>
                )}
              </button>
            ))}
            
          </aside>
        </div>

        {error && <div className="inline-alert home-alert">{error}</div>}

        <footer className="hero-footer">
          <div>
            <span>Ultima sincronizacao: {formatDate(status.updatedAt)}</span>
          </div>
          <small>{syncLoading ? 'Sincronizando...' : 'Versao: 1.2.0'}</small>
        </footer>
      </section>
    );
  }

  function renderCatalogView() {
    return (
      <section className="catalog-page">
        {renderMobileHeader()}
        <aside className="sidebar">
          <button type="button" className="sidebar-brand" onClick={() => setActiveSection('home')}>
            <div className="logo-badge">TV</div>
            <div>
              <strong>IPTV Particular</strong>
              <span>{activeProfile.name}</span>
            </div>
          </button>

          <nav className="nav-stack">
            <button type="button" className={activeSection === 'live' ? 'is-active' : ''} onClick={() => setActiveSection('live')}>Live TV</button>
            <button type="button" className={activeSection === 'movie' ? 'is-active' : ''} onClick={() => setActiveSection('movie')}>Filmes</button>
            <button type="button" className={activeSection === 'series' ? 'is-active' : ''} onClick={() => setActiveSection('series')}>Series</button>
            <button type="button" className={activeSection === 'favorites' ? 'is-active' : ''} onClick={() => setActiveSection('favorites')}>Favoritos ({displayFavoriteCount})</button>
            <button type="button" className={activeSection === 'watch-later' ? 'is-active' : ''} onClick={() => setActiveSection('watch-later')}>Assistir mais tarde ({displayWatchLaterCount})</button>
            <button type="button" className={activeSection === 'recommendations' ? 'is-active' : ''} onClick={() => setActiveSection('recommendations')}>Indicados ({totalRecommendationCount})</button>
            <button type="button" className={activeSection === 'recent' ? 'is-active' : ''} onClick={() => setActiveSection('recent')}>Continuar</button>
            <button type="button" className={activeSection === 'settings' ? 'is-active' : ''} onClick={() => setActiveSection('settings')}>Configuracoes</button>
          </nav>

          <div className="sync-card">
            <span>Ultima atualizacao</span>
            <strong>{formatDate(status.updatedAt)}</strong>
            <small>{formatProfileAgeLabel(activeProfile.maxAgeRating)}</small>
            <small className="sync-user">Usuario: <strong>{authUser?.nome || '-'}</strong> ({authUser?.tipo === 'admin' ? 'Admin' : 'Usuario'})</small>
            <button type="button" className="ghost-btn" onClick={() => setProfileModalOpen(true)}>
              Trocar perfil
            </button>
            <button type="button" className="ghost-btn" onClick={() => setActiveProfileId('')}>
              Escolher perfil
            </button>
            <button type="button" className="ghost-btn is-danger" onClick={handleLogout}>
              Sair da conta
            </button>
            {isAdmin && (
              <button type="button" className="primary-btn" onClick={openSyncConfirm} disabled={syncLoading}>
                {syncLoading ? 'Atualizando...' : 'Renovar catalogo'}
              </button>
            )}
          </div>
        </aside>

        <div className="catalog-content">
          <header className="catalog-toolbar">
            <div>
              <h1>{sectionTitle}</h1>
              <p>{statLabel(pagination.total, 'resultado', 'resultados')}</p>
            </div>

            <div className="toolbar-actions">
              <div className="search-box" onFocusCapture={handleSearchFocus} onBlurCapture={handleSearchBlur}>
                <form className="search-form" onSubmit={handleSearchSubmit} role="search">
                  <label className="search-field">
                    <span>⌕</span>
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.preventDefault();
                      }}
                      placeholder="Buscar por nome"
                    />
                  </label>
                  <button type="submit" className="search-submit-btn" aria-label="Buscar">
                    <span>Buscar</span>
                  </button>
                </form>
                <SearchHistory
                  items={searchHistory}
                  onSelect={applySearchHistoryEntry}
                  onRemove={removeSearchHistoryEntry}
                  onClear={clearSearchHistory}
                  emptyLabel="Sem historico"
                  visible={searchFocused}
                />
              </div>
            </div>
          </header>

          <div className="filter-row">
            <button
              type="button"
              className="category-toggle-btn"
              onClick={() => setCategorySidebarOpen(true)}
            >
              <span>📁</span>
              <span>{activeCategory === 'Todas' ? 'Todas as categorias' : activeCategory}</span>
              <span className="category-toggle-caret">▾</span>
            </button>

            <select value={activeYear} onChange={(event) => setActiveYear(event.target.value)}>
              <option value="Todos">Todos os anos</option>
              {filterOptions.years.map((yearOption) => (
                <option key={yearOption} value={yearOption}>
                  {yearOption}
                </option>
              ))}
            </select>

            <select value={activeGenre} onChange={(event) => setActiveGenre(event.target.value)}>
              <option value="Todos">Todos os generos</option>
              {filterOptions.genres.map((genreOption) => (
                <option key={genreOption} value={genreOption}>
                  {genreOption}
                </option>
              ))}
            </select>
          </div>

          {categorySidebarOpen && (
            <div className="category-sidebar-overlay" onClick={() => setCategorySidebarOpen(false)}>
              <div className="category-sidebar" onClick={(e) => e.stopPropagation()}>
                <header className="category-sidebar-header">
                  <h3>Categorias</h3>
                  <button type="button" className="ghost-btn" onClick={() => setCategorySidebarOpen(false)}>
                    Fechar
                  </button>
                </header>
                <div className="category-sidebar-list">
                  <button
                    type="button"
                    className={`category-sidebar-item ${activeCategory === 'Todas' ? 'is-active' : ''}`}
                    onClick={() => { setActiveCategory('Todas'); setCategorySidebarOpen(false); }}
                  >
                    Todas as categorias
                  </button>
                  {filterOptions.categories.map((category) => (
                    <button
                      key={category}
                      type="button"
                      className={`category-sidebar-item ${activeCategory === category ? 'is-active' : ''}`}
                      onClick={() => { setActiveCategory(category); setCategorySidebarOpen(false); }}
                    >
                      {category}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {error && <div className="inline-alert">{error}</div>}

          {pageLoading ? (
            <div className="empty-state">
              <strong>Carregando pagina...</strong>
              <span>Buscando somente os itens necessarios no banco local.</span>
            </div>
          ) : (
            <div className="content-grid">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  favorite={favorites.includes(item.id)}
                  watchLater={watchLater.includes(item.id)}
                  recommended={recommendations.some((entry) => entry?.item?.id === item.id)}
                  watched={Boolean(watchedMap[item.id])}
                  onFavorite={toggleFavorite}
                  onWatchLater={toggleWatchLater}
                  onRecommend={toggleRecommendation}
                  onPlay={handleCatalogAction}
                />
              ))}
              {!items.length && (
                <div className="empty-state">
                  <strong>Nenhum conteudo encontrado</strong>
                  <span>Ajuste a busca, filtros ou renove o catalogo.</span>
                </div>
              )}
            </div>
          )}

          <div className="pagination-bar">
            <button type="button" className="ghost-btn" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={pagination.page <= 1}>
              Anterior
            </button>
            <div className="page-indicator">
              <strong>Pagina {pagination.page} de {pagination.pages}</strong>
              <span>{statLabel(pagination.total, 'item', 'itens')} no total</span>
            </div>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setPage((current) => Math.min(pagination.pages, current + 1))}
              disabled={pagination.page >= pagination.pages}
            >
              Proxima
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderSettings() {
    return (
      <section className="settings-page">
        <div className="settings-card">
          {renderMobileHeader()}
          <div className="settings-header">
            <div>
              <h1>Configuracoes</h1>
              <p>Para uso pessoal, o backend agora serve principalmente como cache, banco SQLite e camada de sincronizacao leve.</p>
            </div>
            <div className="settings-header-actions">
              <button type="button" className="ghost-btn" onClick={() => setActiveSection('home')}>
                Voltar
              </button>
            </div>
          </div>

          <div className="profile-summary">
            <strong>Credenciais protegidas</strong>
            <span>Base URL, usuario e senha agora ficam somente no backend via arquivo `.env`.</span>
            <small>A interface nao exibe nem persiste mais essas informacoes no navegador.</small>
          </div>

          <div className="profile-summary">
            <strong>Perfil ativo</strong>
            <div className="profile-summary-row">
              {activeProfile?.avatar ? (
                <div className="profile-pick-avatar small has-image">
                  <img src={activeProfile.avatar} alt="Avatar perfil" />
                </div>
              ) : (
                <div className="profile-pick-avatar small" style={{ background: activeProfile?.color || '#7c3aed' }}>
                  <span>{String(activeProfile?.name || '?').slice(0, 2).toUpperCase()}</span>
                </div>
              )}
              <div>
                <span>{activeProfile.name}</span>
                <small>{formatProfileAgeLabel(activeProfile.maxAgeRating)}</small>
              </div>
            </div>
            {activeProfile?.catalogId && (
              <div className="active-catalog-info">
                <strong>Catalogo ativo:</strong> {activeProfile.catalogId}
                <button type="button" className="ghost-btn" onClick={() => setCatalogManagerOpen(true)} style={{ marginLeft: '8px', padding: '4px 10px', fontSize: '12px' }}>
                  Trocar catalogo
                </button>
              </div>
            )}
            {!activeProfile?.catalogId && (
              <div className="active-catalog-info" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)', color: '#fecaca' }}>
                <strong>Nenhum catalogo selecionado</strong>
                <button type="button" className="ghost-btn" onClick={() => setCatalogManagerOpen(true)} style={{ marginLeft: '8px', padding: '4px 10px', fontSize: '12px' }}>
                  Selecionar catalogo
                </button>
              </div>
            )}
          </div>

          {error && <div className="inline-alert">{error}</div>}

          <div className="settings-actions">
            {isAdmin && (
              <>
                <button type="button" className="ghost-btn" onClick={() => setUserManagerOpen(true)}>
                  Gerenciar clientes
                </button>
                <button type="button" className="ghost-btn" onClick={() => setCatalogManagerOpen(true)}>
                  Meus catalogos
                </button>
              </>
            )}
            <button type="button" className="ghost-btn" onClick={() => setProfileModalOpen(true)}>
              Gerenciar perfis
            </button>
            <button type="button" className="ghost-btn is-danger" onClick={handleLogout}>
              Sair da conta ({authUser?.nome || '-'})
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderSourceModal() {
    if (!sourceModalOpen) {
      return null;
    }

    return (
      <div className="modal-overlay" onClick={closeSourceModal}>
        <div className="modal-panel is-catalog-manager" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header className="modal-head">
            <div>
              <h2>Informe a lista (M3U)</h2>
              <p>Nenhum provedor com usuario/senha esta configurado. Cole a URL direta da lista M3U para baixar e usar como catalogo do sistema.</p>
            </div>
            <button type="button" className="ghost-btn" onClick={closeSourceModal} disabled={sourceLoading}>
              Fechar
            </button>
          </header>

          <form className="catalog-add-form" onSubmit={submitSourceUrl}>
            <label className="auth-field">
              <span>URL da lista M3U</span>
              <input
                type="text"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder="https://algum-endereco-publico/playlist.m3u8"
                disabled={sourceLoading}
              />
            </label>
            {sourceError && <div className="inline-alert">{sourceError}</div>}
            <div className="modal-actions">
              <button type="submit" className="primary-btn" disabled={sourceLoading || !sourceUrl.trim()}>
                {sourceLoading ? 'Baixando lista...' : 'Baixar e usar como catalogo'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  function renderRecent() {
    return (
      <section className="settings-page">
        <div className="settings-card">
          {renderMobileHeader()}
          <div className="settings-header">
            <div>
              <h1>Continuar assistindo</h1>
              <p>O player continua usando apenas um stream por vez, mas o catalogo fica em banco local para navegar sem peso.</p>
            </div>
            <div className="settings-header-actions">
              <button type="button" className="profile-chip" onClick={() => setProfileModalOpen(true)}>
                {activeProfile.name}
              </button>
              <button type="button" className="ghost-btn" onClick={() => setActiveSection('home')}>
                Voltar
              </button>
            </div>
          </div>

          {continueWatchingItems.length ? (
            <div className="continue-grid">
              {continueWatchingItems.map(({ item: progressItem, progressEntry }) => (
                <ContinueWatchingCard
                  key={progressItem.id}
                  item={progressItem}
                  progressEntry={progressEntry}
                  watched={Boolean(watchedMap[progressItem.id])}
                  onPlay={openPlayer}
                  onRemove={removeContinueWatchingItem}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>Nada reproduzido ainda</strong>
              <span>Abra um filme ou episodio e pare no meio para aparecer aqui.</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderRecommendations() {
    return (
      <section className="settings-page">
        <div className="settings-card">
          {renderMobileHeader()}
          <div className="settings-header">
            <div>
              <h1>Indicados</h1>
              <p>Lista compartilhada das recomendacoes feitas por cada perfil.</p>
            </div>
            <div className="settings-header-actions">
              <button type="button" className="profile-chip" onClick={() => setProfileModalOpen(true)}>
                {activeProfile.name}
              </button>
              <button type="button" className="ghost-btn" onClick={() => setActiveSection('home')}>
                Voltar
              </button>
            </div>
          </div>

          {groupedRecommendations.length ? (
            <div className="recommendation-groups">
              {groupedRecommendations.map((group) => (
                <section key={group.profile.id} className="recommendation-group">
                  <div className="continue-strip-header">
                    <div>
                      <h2>Indicados por {group.profile.name}</h2>
                      <p>{statLabel(group.entries.length, 'item indicado', 'itens indicados')}</p>
                    </div>
                  </div>
                  <div className="content-grid">
                    {group.entries.map((entry) => (
                      <ItemCard
                        key={`${group.profile.id}-${entry.item.id}`}
                        item={entry.item}
                        favorite={favorites.includes(entry.item.id)}
                        watchLater={watchLater.includes(entry.item.id)}
                        recommended={recommendations.some((current) => current?.item?.id === entry.item.id)}
                        watched={Boolean(watchedMap[entry.item.id])}
                        onFavorite={toggleFavorite}
                        onWatchLater={toggleWatchLater}
                        onRecommend={toggleRecommendation}
                        onPlay={handleCatalogAction}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>Nenhuma indicacao ainda</strong>
              <span>Use o icone ✦ nos encartes para montar a lista de indicados por perfil.</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderMediaDetails() {
    const item = detailsItem;
    if (!item) return <></>;

    const isLive = item.contentType === 'live';
    const isMovie = item.contentType === 'movie';
    const isSeriesGroup = item.itemType === 'series_group';
    const isSeries = item.contentType === 'series' || isSeriesGroup;
    const isFavorite = favorites.includes(item.id);
    const isWatchLater = watchLater.includes(item.id);

    const seriesInfo = isSeriesGroup ? (seriesDetails?.series || null) : null;
    const seasons = isSeriesGroup ? (seriesDetails?.seasons || []) : [];
    const activeSeason = seasons.find((season) => String(season.seasonNumber) === selectedSeasonDetail) || seasons[0] || null;

    const posterSrc = item.poster || seriesInfo?.poster || '';
    const displayYear = item.year || seriesInfo?.year || null;
    const displayGenre = item.genre || seriesInfo?.genre || '';
    const displayCategory = (item.category && item.category !== 'Sem categoria')
      ? item.category
      : (seriesInfo?.category || '');
    const displayPlot = item.plot || seriesInfo?.plot || '';
    const firstEpisode = activeSeason?.episodes?.[0] || seasons[0]?.episodes?.[0] || null;

    const handleWatch = () => {
      if (isSeriesGroup) {
        if (firstEpisode) {
          setDetailsItem(null);
          setActiveSection(previousSection);
          openPlayer(firstEpisode);
        }
        return;
      }
      playFromDetails(item);
    };

    const watchDisabled = isSeriesGroup && !firstEpisode && !seriesDetailsLoading;
    const episodeLabelOf = (episode) => formatEpisodeLabel(episode) || episode.name;

    return (
      <section className="media-details-page">
        <div
          className="media-details-bg"
          style={{ backgroundImage: item.poster ? `url(${item.poster})` : 'none' }}
          aria-hidden="true"
        />
        <div className="media-details-overlay">
          <header className="media-details-header">
            <button
              type="button"
              className="back-btn"
              onClick={() => {
                setDetailsItem(null);
                setActiveSection(previousSection);
              }}
              aria-label="Voltar"
            >
              <span>←</span> Voltar
            </button>
          </header>

          <div className="media-details-body">
            <div className="media-details-content">
              <div className="media-details-poster-section">
                {posterSrc ? (
                  <img src={posterSrc} alt={item.name} className="media-details-poster" />
                ) : (
                  <div className="media-details-poster media-details-poster-fallback">{item.name.slice(0, 2).toUpperCase()}</div>
                )}
              </div>

              <div className="media-details-info-section">
                <div className="media-details-meta-top">
                  <span className="type-badge">{isLive ? 'Ao vivo' : isMovie ? 'Filme' : 'Serie'}</span>
                  {displayYear && <span className="year-badge">{displayYear}</span>}
                  {displayGenre && <span className="genre-badge">{displayGenre}</span>}
                  {displayCategory && <span className="category-badge">{displayCategory}</span>}
                </div>
                <h1 className="media-details-title">{item.name}</h1>
                {displayPlot && <p className="media-details-plot">{displayPlot}</p>}
                {isSeriesGroup && seriesInfo && (
                  <p className="media-details-submeta">
                    {[seriesInfo.seasonCount ? `${seriesInfo.seasonCount} temporadas` : '', seriesInfo.episodeCount ? `${seriesInfo.episodeCount} episodios` : '']
                      .filter(Boolean)
                      .join(' • ')}
                  </p>
                )}

                <div className="media-details-status">
                  <button
                    type="button"
                    className={`status-btn ${isFavorite ? 'active' : ''}`}
                    onClick={toggleFavorite}
                    aria-label={isFavorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
                  >
                    <span>{isFavorite ? '♥' : '♡'}</span> Favorito
                  </button>
                  <button
                    type="button"
                    className={`status-btn ${isWatchLater ? 'active' : ''}`}
                    onClick={toggleWatchLater}
                    aria-label={isWatchLater ? 'Remover da lista depois' : 'Adicionar para assistir depois'}
                  >
                    <span>{isWatchLater ? '✓' : '⌚'}</span> Assistir depois
                  </button>
                  {recommendations.some((r) => r.item?.id === item.id) && (
                    <button
                      type="button"
                      className="status-btn active"
                      onClick={() => toggleRecommendation(item)}
                      aria-label="Remover das recomendacoes"
                    >
                      <span>✦</span> Recomendado
                    </button>
                  )}
                  {Boolean(watchedMap[item.id]) && (
                    <span className="status-btn watched">
                      <span>✓</span> Assistido
                    </span>
                  )}
                </div>

                <div className="media-details-actions">
                  <button
                    type="button"
                    className="primary-btn is-large"
                    onClick={handleWatch}
                    disabled={watchDisabled}
                  >
                    <span>▶</span> {isSeriesGroup ? 'Assistir primeiro episodio' : isLive ? 'Assistir agora' : 'Assistir'}
                  </button>
                  {!isLive && (
                    <button type="button" className="ghost-btn is-large" onClick={() => {
                      const query = encodeURIComponent(`${item.name} ${displayYear || ''} trailer`);
                      window.open(`https://www.youtube.com/results?search_query=${query}`, '_blank');
                    }}>
                      <span>🎬</span> Trailer
                    </button>
                  )}
                  {openCastModal && item.name && (
                    <button type="button" className="ghost-btn is-large" onClick={() => openCastModal(item.name, isMovie ? 'movie' : 'series')}>
                      <span>★</span> Elenco
                    </button>
                  )}
                </div>
              </div>
            </div>

            {isSeriesGroup && (
              <section className="media-details-episodes">
                <div className="episodes-header">
                  <h3>Episodios</h3>
                  {seasons.length > 0 && (
                    <label className="season-select">
                      <span>Temporada</span>
                      <select value={selectedSeasonDetail} onChange={(event) => setSelectedSeasonDetail(event.target.value)}>
                        {seasons.map((season) => (
                          <option key={season.seasonNumber} value={season.seasonNumber}>
                            {season.label || `Temporada ${season.seasonNumber}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                {seriesDetailsLoading && <div className="player-state">Carregando episodios...</div>}
                {seriesDetailsError && !seriesDetailsLoading && <div className="player-state is-error">{seriesDetailsError}</div>}

                {!seriesDetailsLoading && !seriesDetailsError && activeSeason && (
                  <div className="episode-list">
                    {activeSeason.episodes.map((episode) => {
                      const episodeLabel = episodeLabelOf(episode);
                      const watched = Boolean(watchedMap[episode.id]);
                      return (
                        <button
                          key={episode.id}
                          type="button"
                          className="episode-item"
                          onClick={() => { openPlayer(episode); }}
                        >
                          <div className="episode-art">
                            {episode.poster ? (
                              <img src={episode.poster} alt={episode.episodeTitle || episode.name} />
                            ) : (
                              <div className="episode-art-fallback">{(episodeLabel || episode.name).slice(0, 2).toUpperCase()}</div>
                            )}
                          </div>
                          <div className="episode-copy">
                            <strong>{episodeLabel}</strong>
                            {episode.episodeTitle && <span>{episode.episodeTitle}</span>}
                            <small>{episode.category}</small>
                          </div>
                          <div className="episode-meta">
                            {watched && <span className="episode-badge watched">Assistido</span>}
                            {playbackProgress[episode.id]?.position > 30 && (
                              <span>Continuar em {formatDuration(playbackProgress[episode.id].position)}</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {isLive && (
              <section className="media-details-epg">
                <h3>Grade de programacao</h3>
                {item.epg && item.epg.length > 0 ? (
                  <div className="epg-list">
                    {item.epg.map((program) => (
                      <div key={program.start} className="epg-item">
                        <span className="epg-time">{program.start} - {program.end}</span>
                        <span className="epg-title">{program.title}</span>
                        {program.description && <span className="epg-desc">{program.description}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <strong>Grade indisponivel</strong>
                    <span>Este provedor nao enviou a grade de programacao para este canal.</span>
                  </div>
                )}
              </section>
            )}

            {(detailsRecommendations.length > 0 || detailsRecLoading) && (
              <section className="media-details-recommendations">
                <h3>Sugeridos</h3>
                {detailsRecLoading ? (
                  <div className="rec-skeleton">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="rec-skeleton-card">
                        <div className="rec-skeleton-img" />
                        <div className="rec-skeleton-text" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rec-carousel-wrapper">
                    <button
                      type="button"
                      className="rec-carousel-btn"
                      onClick={() => carouselRef.current?.scrollBy({ left: -300, behavior: 'smooth' })}
                      aria-label="Sugeridos anteriores"
                      disabled={scrollLeft === 0}
                    >
                      ‹
                    </button>
                    <div className="rec-carousel" ref={carouselRef} onScroll={handleCarouselScroll}>
                      {detailsRecommendations.map((rec) => (
                        <ItemCard
                          key={rec.id}
                          item={rec}
                          favorite={false}
                          watchLater={false}
                          recommended={false}
                          watched={false}
                          onFavorite={() => {}}
                          onWatchLater={() => {}}
                          onRecommend={() => {}}
                          onPlay={() => handleSuggestionClick(rec)}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      className="rec-carousel-btn"
                      onClick={() => carouselRef.current?.scrollBy({ left: 300, behavior: 'smooth' })}
                      aria-label="Proximos sugeridos"
                      disabled={!canScrollRight}
                    >
                      ›
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (authLoading) {
    return (
      <div className="settings-page">
        <div className="settings-card">
          <div className="empty-state">
            <strong>Carregando sessao...</strong>
            <span>Verificando credenciais salvas no navegador.</span>
          </div>
        </div>
      </div>
    );
  }

  if (suspendedInfo) {
    return (
      <>
        {renderSuspendedScreen()}
      </>
    );
  }

  if (!authUser) {
    return (
      <>
        {renderLoginScreen()}
        {renderProfileFormModal()}
        {renderUserEditModal()}
        {renderChangePasswordModal()}
        {renderAvatarGalleryModal()}
        {renderDeleteProfileModal()}
      </>
    );
  }

  if (!activeProfileId) {
    return (
      <>
        {renderProfilePickerScreen()}
        {renderProfileFormModal()}
        {renderUserEditModal()}
        {renderChangePasswordModal()}
        {renderAvatarGalleryModal()}
        {renderDeleteProfileModal()}
      </>
    );
  }

  if (bootLoading) {
    return (
      <>
        <div className="settings-page">
          <div className="settings-card">
            <div className="empty-state">
              <strong>Preparando catalogo local...</strong>
              <span>Se for o primeiro acesso, a lista sera baixada uma unica vez e gravada em SQLite.</span>
            </div>
          </div>
        </div>
        {renderSourceModal()}
      </>
    );
  }

  return (
    <div className="app-shell">
      {renderMobileMenu()}
      {activeSection === 'home' && renderHome()}
      {activeSection === 'settings' && renderSettings()}
      {activeSection === 'recent' && renderRecent()}
      {activeSection === 'recommendations' && renderRecommendations()}
      {activeSection === 'details' && renderMediaDetails()}
      {isListView && renderCatalogView()}

      {selectedItem && (
        <PlayerModal
          item={selectedItem}
          settings={settings}
          resumeEntry={playbackProgress[selectedItem.id]}
          playbackProgress={playbackProgress}
          watchedMap={watchedMap}
          onProgressSave={savePlaybackProgress}
          onProgressClear={clearPlaybackProgress}
          onWatched={markItemAsWatched}
          onPlayNextEpisode={openPlayer}
          onPlayEpisode={openPlayer}
          onCastOpen={openCastModal}
          profileAgeLimit={activeProfile?.maxAgeRating ?? null}
          catalogId={activeProfile?.catalogId}
          playerPreferences={playerPreferences}
          onUpdatePlayerPreferences={updatePlayerPreferences}
          onClose={() => setSelectedItem(null)}
                    onBackToEpisodes={(seriesKey) => {
            const playing = selectedItem;
            setSelectedItem(null);
            setDetailsItem({
              id: `series:${seriesKey}`,
              itemType: 'series_group',
              contentType: 'series',
              seriesKey,
              name: playing?.seriesTitle || playing?.name || 'Serie',
              poster: playing?.poster || '',
              category: playing?.category && playing.category !== 'Sem categoria' ? playing.category : '',
              year: playing?.year || null,
              genre: playing?.genre || '',
            });
            setPreviousSection(activeSection === 'details' ? previousSection : activeSection);
            setActiveSection('details');
          }}
        />
      )}

      {(castModalLoading || castModalData || castModalError) && (
        <CastModal
          loading={castModalLoading}
          error={castModalError}
          data={castModalData}
          onClose={() => {
            setCastModalData(null);
            setCastModalError('');
            setCastModalLoading(false);
          }}
        />
      )}

      {profileModalOpen && (
        <ProfileManagerModal
          profiles={profiles}
          activeProfileId={activeProfileId}
          onClose={() => setProfileModalOpen(false)}
          onSelectProfile={(profileId) => {
            setActiveProfileId(profileId);
            setProfileModalOpen(false);
            setError('');
          }}
          onAddProfile={handleAddProfile}
          onUpdateProfileAge={handleProfileAgeUpdate}
          onEditProfile={openProfileEdit}
          onDeleteProfile={handleDeleteProfile}
          onEditUser={() => {
            setProfileModalOpen(false);
            openUserEdit();
          }}
          authUser={authUser}
          profileCountMax={5}
        />
      )}

      {syncConfirmOpen && (
        <SyncConfirmModal
          onClose={closeSyncConfirm}
          onConfirm={confirmSync}
          captchaPrompt={captchaPrompt}
          captchaValue={captchaValue}
          onCaptchaChange={setCaptchaValue}
          syncLoading={syncLoading}
          captchaError={captchaError}
        />
      )}

      {catalogManagerOpen && (
        <CatalogManagerModal
          onClose={() => setCatalogManagerOpen(false)}
          activeProfileId={activeProfileId}
          profiles={profiles}
          userCatalogLimit={authUser?.catalogLimit}
        />
      )}
      {userManagerOpen && (
        <UserManagerModal
          onClose={() => setUserManagerOpen(false)}
        />
      )}
      {renderSourceModal()}

      {renderProfileFormModal()}
      {renderUserEditModal()}
      {renderChangePasswordModal()}
      {renderAvatarGalleryModal()}
      {renderDeleteProfileModal()}
    </div>
  );
}
