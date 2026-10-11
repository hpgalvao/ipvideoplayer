import 'dotenv/config';
import dns from 'dns';
import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// DNS custom via .env (evita ENOTFOUND no provedor IPTV quando DNS do sistema/operadora falha).
// Formato .env: IPTV_DNS_SERVERS=185.49.71.100,46.165.236.165
// Separadores aceitos: virgula, espaco ou ponto-e-virgula.
// Se o .env nao tiver a variavel, usa os DNS sugeridos; se ambos vazios, usa DNS padrao do sistema.
function applyCustomDns() {
  const servers = getDnsServers();
  if (servers.length === 0) return;
  try {
    dns.setServers(servers);
    console.log(`[IPTV-DNS] Resolvedores custom ativos: ${servers.join(', ')}`);
  } catch (error) {
    console.warn('[IPTV-DNS] Nao foi possivel aplicar DNS custom (continuando com DNS padrao):', error?.message || error);
  }
}
applyCustomDns();
import { fetchAgent, getDnsServers, isPrivateHostname } from './net.js';
import {
  DEFAULT_SETTINGS,
  buildStreamCandidates,
  buildStreamUrl,
  downloadM3UCatalog,
  getAllowedProviderHosts,
  getCatalogStatus,
  getSeriesGroupDetails,
  getStoredItem,
  logServerError,
  mergeSettings,
  normalizeCatalogSource,
  queryCatalogPage,
  resolveExistingIds,
  safeError,
  safePublicError,
  scrubMessage,
  syncCatalogToDatabase,
} from './iptv-service.js';
import {
  AVATAR_PATHS,
  computeValidityDates,
  ensureAvatarDirectories,
  execute,
  hashPassword,
  isoNow,
  listPublicAvatars,
  listUserPrivateAvatars,
  queryAll,
  queryOne,
  sanitizeAvatarUrl,
  savePrivateAvatar,
  transaction,
  uid,
  verifyPassword,
} from './db.js';

const app = express();
const port = process.env.PORT || 8787;
const STREAM_PROXY_TIMEOUT_MS = 20000;
const JWT_SECRET = process.env.JWT_SECRET || (crypto.randomBytes(32).toString('hex'));
const JWT_TTL = process.env.JWT_TTL || '7d';
const AUTH_COOKIE = 'iptv_session';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.resolve(__dirname, '../frontend/dist');

if (String(process.env.TRUST_PROXY || '').trim()) {
  const trustProxyValue = String(process.env.TRUST_PROXY).trim();
  app.set('trust proxy', /^\d+$/.test(trustProxyValue) ? Number(trustProxyValue) : trustProxyValue);
}

app.disable('x-powered-by');

function isSecureRequest(req) {
  if (!req) return false;
  if (req.secure) return true;
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwardedProto === 'https';
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const CORS_ORIGINS = new Set(
  [...DEFAULT_CORS_ORIGINS, ...String(process.env.CORS_ORIGINS || '').split(',')]
    .map((item) => item.trim())
    .filter(Boolean),
);

// Cabecalhos de seguranca essenciais (equivalente ao helmet).
const SECURITY_HEADERS_DISABLED = process.env.SECURITY_HEADERS_DISABLED === '1';
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob: http: https:",
  "connect-src 'self' blob: http: https: ws: wss:",
  "worker-src 'self' blob:",
].join('; ');

app.use((req, res, next) => {
  if (!SECURITY_HEADERS_DISABLED) {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (isSecureRequest(req)) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
  }
  next();
});

// Rate limiting em memoria (sem dependencias externas).
const rateLimiterBuckets = [];

function createRateLimiter({ windowMs, max, keyFn, message }) {
  const buckets = new Map();
  rateLimiterBuckets.push(buckets);
  return (req, res, next) => {
    const key = keyFn(req);
    if (key == null || key === '') {
      return next();
    }
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.max(Math.ceil((entry.resetAt - now) / 1000), 1);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, message: message || 'Muitas tentativas. Tente novamente mais tarde.' });
    }
    return next();
  };
}

const rateLimiterCleanup = setInterval(() => {
  const now = Date.now();
  for (const buckets of rateLimiterBuckets) {
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }
}, 60000);
if (rateLimiterCleanup && typeof rateLimiterCleanup.unref === 'function') {
  rateLimiterCleanup.unref();
}

const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => String(req.body?.username || '').trim().toLowerCase() || null,
  message: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.',
});

const sensitiveActionRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 20,
  keyFn: (req) => String(req.user?.id || '') || null,
  message: 'Muitas acoes em pouco tempo. Aguarde alguns instantes.',
});


app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => {
      if (!origin || CORS_ORIGINS.has(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
  }),
);
app.use(cookieParser());
const jsonParserSmall = express.json({ limit: '256kb' });
const jsonParserUpload = express.json({ limit: '6mb' });
const formParserSmall = express.urlencoded({ limit: '256kb', extended: true });
app.use((req, res, next) => {
  const jsonParser = req.path === '/api/avatars/upload' ? jsonParserUpload : jsonParserSmall;
  jsonParser(req, res, (jsonError) => {
    if (jsonError) {
      return next(jsonError);
    }
    return formParserSmall(req, res, next);
  });
});

(async function bootstrapAvatarStorage() {
  try {
    await ensureAvatarDirectories();
  } catch (error) {
    logServerError('bootstrapAvatarStorage', error);
  }
})();

function publicUserRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tipo: String(row.tipo || 'usuario'),
    nome: String(row.nome || ''),
    foto: String(row.foto || ''),
    email: String(row.email || ''),
    contato: String(row.contato || ''),
    username: String(row.username || ''),
    plano: String(row.plano || ''),
    dt_assinatura: row.dt_assinatura ? String(row.dt_assinatura) : null,
    dt_validade: row.dt_validade ? String(row.dt_validade) : null,
    ativo: Number(row.ativo) === 1,
    created_at: row.created_at ? String(row.created_at) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  };
}

function publicProfileRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name || ''),
    avatar: String(row.avatar || ''),
    color: String(row.color || ''),
    maxAgeRating: Number(row.max_age_rating || 999),
    pin: String(row.pin || ''),
    sortOrder: Number(row.sort_order || 0),
    created_at: row.created_at ? String(row.created_at) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  };
}

function maskCatalogUrl(url, password) {
  let masked = String(url || '').replace(/password=[^&\s]+/gi, 'password=***');
  const secret = String(password || '').trim();
  if (secret && secret.length >= 3) {
    masked = masked.split(secret).join('***');
  }
  return masked;
}

function publicCatalogRow(row) {
  if (!row) return null;
  const password = String(row.password || '');
  return {
    id: String(row.id),
    name: String(row.name || ''),
    url: maskCatalogUrl(row.url, password),
    baseUrl: String(row.base_url || ''),
    username: String(row.username || ''),
    output: String(row.output || 'm3u8'),
    status: String(row.status || 'pending'),
    error: row.error_message ? String(row.error_message) : '',
    totalCount: Number(row.total_count || 0),
    liveCount: Number(row.live_count || 0),
    movieCount: Number(row.movie_count || 0),
    seriesCount: Number(row.series_count || 0),
    isActive: Number(row.is_active) === 1,
    createdAt: row.created_at ? String(row.created_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
  };
}

function deriveCatalogName(url, username) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.at(-1) || '';
    const base = last.replace(/\.[a-z0-9]+$/i, '');
    if (base && !/^get$/i.test(base)) {
      return `${parsed.hostname} - ${base}`;
    }
    return username ? `${parsed.hostname} - ${username}` : parsed.hostname;
  } catch {
    return 'Lista M3U';
  }
}

async function runPersistent(sql, params = []) {
  // `execute` mantem a alteracao apenas em memoria (sql.js); `transaction` grava no arquivo.
  await transaction(async (tx) => {
    tx.run(sql, params);
  });
}

async function runCatalogDownload(catalogId) {
  const row = await queryOne('SELECT * FROM catalogs WHERE id = ?', [catalogId]);
  if (!row) {
    return null;
  }

  try {
    const result = await downloadM3UCatalog({
      url: row.url,
      baseUrl: row.base_url,
      username: row.username,
      password: row.password,
      output: row.output,
    });

    let usedOutput = String(row.output || 'm3u8');
    try {
      const used = new URL(result.usedUrl);
      const outputParam = used.searchParams.get('output');
      if (outputParam === 'ts' || outputParam === 'm3u8') {
        usedOutput = outputParam;
      }
    } catch {
      // Mantem a saida atual se a URL usada nao for analisavel.
    }

    const now = isoNow();
    await runPersistent(
      `UPDATE catalogs
         SET status = 'ok', error_message = '', total_count = ?, live_count = ?, movie_count = ?, series_count = ?,
             url = ?, output = ?, updated_at = ?, last_sync_at = ?
       WHERE id = ?`,
      [result.total, result.live, result.movie, result.series, result.usedUrl || row.url, usedOutput, now, now, catalogId],
    );
  } catch (error) {
    const raw = String(error?.message || '').trim();
    const message = raw
      ? scrubMessage(raw)
      : 'Nao foi possivel baixar esta lista. Verifique a URL e tente novamente.';
    await runPersistent(
      `UPDATE catalogs SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?`,
      [message, isoNow(), catalogId],
    );
  }

  return queryOne('SELECT * FROM catalogs WHERE id = ?', [catalogId]);
}

function isUserStillValid(userRow) {
  if (!userRow) return false;
  if (String(userRow.tipo || '').toLowerCase() === 'admin') return true;
  if (Number(userRow.ativo) !== 1) return false;
  const validity = userRow.dt_validade ? String(userRow.dt_validade).trim() : '';
  if (!validity) return true;
  const ts = Date.parse(validity);
  if (!Number.isFinite(ts)) return true;
  return Date.now() <= ts;
}

function signAuthCookie(req, res, user) {
  const payload = {
    sub: String(user.id),
    tipo: String(user.tipo || 'usuario'),
    username: String(user.username || ''),
  };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_TTL });
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/',
  });
  return token;
}

async function requireAuth(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE] || null;
  if (!token) {
    return res.status(401).json({ ok: false, message: 'Sessao nao encontrada. Faca login novamente.' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return res.status(401).json({ ok: false, message: 'Sessao expirada. Faca login novamente.' });
  }
  const userId = String(payload?.sub || '');
  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Sessao invalida.' });
  }
  const row = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return res.status(401).json({ ok: false, message: 'Usuario nao existe mais. Faca login novamente.' });
  }
  if (!isUserStillValid(row)) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return res.status(403).json({ ok: false, message: 'Conta bloqueada ou expirada. Contate o administrador.' });
  }
  req.user = publicUserRow(row);
  req.rawUser = row;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, message: 'Sessao nao encontrada.' });
  }
  if (String(req.user.tipo || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ ok: false, message: 'Acesso permitido somente para administrador.' });
  }
  next();
}

app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ ok: false, message: 'Informe usuario e senha.' });
    }
    const row = await queryOne('SELECT * FROM users WHERE username = ?', [username]);
    // Mensagem uniforme para evitar enumeracao de contas (usuario inexistente,
    // senha errada, conta desativada ou expirada respondem igual).
    const invalidCredentials = () => res.status(401).json({ ok: false, message: 'Usuario ou senha invalidos.' });
    if (!row) {
      return invalidCredentials();
    }
    const hash = String(row.password_hash || '');
    const salt = String(row.password_salt || '');
    if (!hash || !salt || !verifyPassword(password, hash, salt)) {
      return invalidCredentials();
    }
    if (!isUserStillValid(row)) {
      return invalidCredentials();
    }
    signAuthCookie(req, res, row);
    const profiles = await queryAll('SELECT * FROM profiles WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC', [row.id]);
    res.json({
      ok: true,
      user: publicUserRow(row),
      profiles: profiles.map(publicProfileRow),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: safePublicError('auth_login', error, 'Usuario ou senha invalidos.') });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const profiles = await queryAll(
      'SELECT * FROM profiles WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC',
      [req.user.id],
    );
    res.json({
      ok: true,
      user: req.user,
      profiles: profiles.map(publicProfileRow),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: safePublicError('auth_me', error, 'Sessao invalida. Faca login novamente.') });
  }
});

app.patch('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const id = req.user.id;
    const body = req.body || {};
    const current = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ ok: false, message: 'Usuario nao encontrado.' });
    const nome = body.nome != null ? String(body.nome).trim() : String(current.nome || '');
    if (!nome) return res.status(400).json({ ok: false, message: 'Nome invalido.' });
    const foto = body.foto != null ? sanitizeAvatarUrl(body.foto) : String(current.foto || '');
    const email = body.email != null ? String(body.email) : String(current.email || '');
    const contato = body.contato != null ? String(body.contato) : String(current.contato || '');
    if (body.password != null && String(body.password).trim()) {
      if (body.currentPassword == null || String(body.currentPassword || '').trim() === '') {
        return res.status(400).json({ ok: false, message: 'Senha atual obrigatoria para alterar a senha.' });
      }
      if (!verifyPassword(String(body.currentPassword), String(current.password_hash), String(current.password_salt))) {
        return res.status(400).json({ ok: false, message: 'Senha atual invalida.' });
      }
      const newPassword = String(body.password).trim();
      if (newPassword.length < 6) {
        return res.status(400).json({ ok: false, message: 'Nova senha deve ter pelo menos 6 caracteres.' });
      }
      const { hash, salt } = hashPassword(newPassword);
      await transaction(async (tx) => {
        tx.run(
          `UPDATE users SET nome = ?, foto = ?, email = ?, contato = ?, password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?`,
          [nome, foto, email, contato, hash, salt, isoNow(), id],
        );
      });
    } else {
      await execute(
        `UPDATE users SET nome = ?, foto = ?, email = ?, contato = ?, updated_at = ? WHERE id = ?`,
        [nome, foto, email, contato, isoNow(), id],
      );
    }
    const updated = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    const profiles = await queryAll(
      'SELECT * FROM profiles WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC',
      [id],
    );
    res.json({
      ok: true,
      user: publicUserRow(updated),
      profiles: profiles.map(publicProfileRow),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM users ORDER BY tipo DESC, nome COLLATE NOCASE ASC');
    res.json({ ok: true, users: rows.map(publicUserRow) });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const tipo = String(body.tipo || 'usuario').toLowerCase();
    if (!['admin', 'usuario'].includes(tipo)) {
      return res.status(400).json({ ok: false, message: 'Tipo deve ser admin ou usuario.' });
    }
    const nome = String(body.nome || '').trim();
    if (!nome) return res.status(400).json({ ok: false, message: 'Nome obrigatorio.' });
    const username = String(body.username || '').trim();
    if (!username) return res.status(400).json({ ok: false, message: 'Usuario obrigatorio.' });
    const password = String(body.password || '');
    if (!password) return res.status(400).json({ ok: false, message: 'Senha obrigatoria.' });
    const plano = String(body.plano || '').trim() || null;
    const existing = await queryOne('SELECT COUNT(*) AS total FROM users WHERE username = ?', [username]);
    if (existing && Number(existing.total) > 0) {
      return res.status(400).json({ ok: false, message: 'Usuario ja existe.' });
    }
    const validity = computeValidityDates(plano);
    const { hash, salt } = hashPassword(password);
    const userId = uid('usr');
    await transaction(async (tx) => {
      tx.run(
        `INSERT INTO users (id, tipo, nome, foto, email, contato, username, password_hash, password_salt, plano, dt_assinatura, dt_validade, ativo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          tipo,
          nome,
          String(body.foto || ''),
          String(body.email || ''),
          String(body.contato || ''),
          username,
          hash,
          salt,
          plano,
          validity.signature,
          validity.validity,
          tipo === 'admin' ? 1 : Number(validity.active),
          isoNow(),
          isoNow(),
        ],
      );
      const defaultProfiles = [
        { id: uid('prf'), name: 'Principal', maxAge: 999, color: '#e11d48', sort: 0 },
        { id: uid('prf'), name: 'Familia', maxAge: 16, color: '#7c3aed', sort: 1 },
        { id: uid('prf'), name: 'Crianca', maxAge: 10, color: '#059669', sort: 2 },
      ];
      for (const p of defaultProfiles) {
        tx.run(
          `INSERT INTO profiles (id, user_id, name, avatar, color, max_age_rating, pin, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.id, userId, p.name, '', p.color, p.maxAge, '', p.sort, isoNow(), isoNow()],
        );
      }
    });
    const created = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
    const profiles = await queryAll('SELECT * FROM profiles WHERE user_id = ? ORDER BY sort_order ASC', [userId]);
    res.json({
      ok: true,
      user: publicUserRow(created),
      profiles: profiles.map(publicProfileRow),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params?.id || '');
    const body = req.body || {};
    const current = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ ok: false, message: 'Usuario nao encontrado.' });
    const isAdminCurrent = String(current.tipo || '').toLowerCase() === 'admin';
    const countAdmins = await queryOne(
      "SELECT COUNT(*) AS total FROM users WHERE tipo = 'admin'",
    );
    const tipo = body.tipo != null ? String(body.tipo).toLowerCase() : String(current.tipo || 'usuario');
    if (!['admin', 'usuario'].includes(tipo)) {
      return res.status(400).json({ ok: false, message: 'Tipo invalido.' });
    }
    if (isAdminCurrent && tipo !== 'admin' && Number(countAdmins?.total || 0) <= 1) {
      return res.status(400).json({ ok: false, message: 'Nao e permitido remover o unico administrador.' });
    }
    const nome = body.nome != null ? String(body.nome).trim() : String(current.nome || '');
    if (!nome) return res.status(400).json({ ok: false, message: 'Nome invalido.' });
    const foto = body.foto != null ? String(body.foto) : String(current.foto || '');
    const email = body.email != null ? String(body.email) : String(current.email || '');
    const contato = body.contato != null ? String(body.contato) : String(current.contato || '');
    const username = body.username != null ? String(body.username).trim() : String(current.username || '');
    if (!username) return res.status(400).json({ ok: false, message: 'Usuario invalido.' });
    const plano = body.plano != null ? (String(body.plano).trim() || null) : (current.plano || null);
    const ativoRaw = body.ativo != null ? body.ativo : (Number(current.ativo) === 1 ? true : false);
    const ativo = isAdminCurrent && tipo === 'admin'
      ? 1
      : (ativoRaw === true || ativoRaw === 1 || ativoRaw === '1' ? 1 : 0);
    let { dt_assinatura, dt_validade } = current;
    if (body.plano != null) {
      const computed = computeValidityDates(String(body.plano || ''));
      dt_assinatura = computed.signature;
      dt_validade = computed.validity;
    } else {
      if (body.dt_assinatura != null) dt_assinatura = String(body.dt_assinatura);
      if (body.dt_validade != null) dt_validade = String(body.dt_validade);
    }
    if (username !== String(current.username)) {
      const conflict = await queryOne('SELECT COUNT(*) AS total FROM users WHERE username = ? AND id <> ?', [username, id]);
      if (conflict && Number(conflict.total) > 0) {
        return res.status(400).json({ ok: false, message: 'Usuario ja existe.' });
      }
    }
    await transaction(async (tx) => {
      tx.run(
        `UPDATE users SET tipo = ?, nome = ?, foto = ?, email = ?, contato = ?, username = ?, plano = ?, dt_assinatura = ?, dt_validade = ?, ativo = ?, updated_at = ? WHERE id = ?`,
        [
          tipo,
          nome,
          foto,
          email,
          contato,
          username,
          plano,
          dt_assinatura || null,
          dt_validade || null,
          ativo,
          isoNow(),
          id,
        ],
      );
      if (body.password && String(body.password).trim()) {
        const { hash, salt } = hashPassword(String(body.password));
        tx.run(
          'UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?',
          [hash, salt, isoNow(), id],
        );
      }
    });
    const updated = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    res.json({ ok: true, user: publicUserRow(updated) });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params?.id || '');
    const current = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ ok: false, message: 'Usuario nao encontrado.' });
    if (String(current.tipo || '').toLowerCase() === 'admin') {
      const countAdmins = await queryOne("SELECT COUNT(*) AS total FROM users WHERE tipo = 'admin'");
      if (Number(countAdmins?.total || 0) <= 1) {
        return res.status(400).json({ ok: false, message: 'O unico administrador nao pode ser excluido.' });
      }
    }
    await execute('DELETE FROM profiles WHERE user_id = ?', [id]);
    await execute('DELETE FROM users WHERE id = ?', [id]);
    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.post('/api/users/:id/toggle-active', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params?.id || '');
    const current = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ ok: false, message: 'Usuario nao encontrado.' });
    if (String(current.tipo || '').toLowerCase() === 'admin') {
      return res.status(400).json({ ok: false, message: 'Administrador nao pode ser desativado.' });
    }
    const nextAtivo = Number(current.ativo) === 1 ? 0 : 1;
    await execute('UPDATE users SET ativo = ?, updated_at = ? WHERE id = ?', [nextAtivo, isoNow(), id]);
    const row = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    res.json({ ok: true, user: publicUserRow(row) });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.get('/api/profiles', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(
      'SELECT * FROM profiles WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC',
      [req.user.id],
    );
    res.json({ ok: true, profiles: rows.map(publicProfileRow) });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.post('/api/profiles', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const total = await queryOne('SELECT COUNT(*) AS total FROM profiles WHERE user_id = ?', [req.user.id]);
    if (Number(total?.total || 0) >= 5) {
      return res.status(400).json({ ok: false, message: 'Limite maximo de 5 perfis por usuario.' });
    }
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, message: 'Nome do perfil obrigatorio.' });
    const conflict = await queryOne(
      'SELECT COUNT(*) AS total FROM profiles WHERE user_id = ? AND name COLLATE NOCASE = ?',
      [req.user.id, name],
    );
    if (Number(conflict?.total || 0) > 0) {
      return res.status(400).json({ ok: false, message: 'Ja existe um perfil com esse nome.' });
    }
    const avatar = String(body.avatar || '');
    const color = String(body.color || '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'));
    const maxAgeRating = body.maxAgeRating != null
      ? Number(body.maxAgeRating)
      : 999;
    const pin = body.pin != null ? String(body.pin) : '';
    const sortOrder = body.sortOrder != null ? Number(body.sortOrder) : Number(total?.total || 0);
    const id = uid('prf');
    await execute(
      `INSERT INTO profiles (id, user_id, name, avatar, color, max_age_rating, pin, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, name, avatar, color, maxAgeRating, pin, sortOrder, isoNow(), isoNow()],
    );
    const row = await queryOne('SELECT * FROM profiles WHERE id = ?', [id]);
    res.json({ ok: true, profile: publicProfileRow(row) });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.put('/api/profiles/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params?.id || '');
    const current = await queryOne('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!current) return res.status(404).json({ ok: false, message: 'Perfil nao encontrado.' });
    const body = req.body || {};
    const name = body.name != null ? String(body.name).trim() : String(current.name || '');
    if (!name) return res.status(400).json({ ok: false, message: 'Nome invalido.' });
    if (name !== String(current.name)) {
      const conflict = await queryOne(
        'SELECT COUNT(*) AS total FROM profiles WHERE user_id = ? AND name COLLATE NOCASE = ? AND id <> ?',
        [req.user.id, name, id],
      );
      if (Number(conflict?.total || 0) > 0) {
        return res.status(400).json({ ok: false, message: 'Ja existe um perfil com esse nome.' });
      }
    }
    const avatar = body.avatar != null ? String(body.avatar) : String(current.avatar || '');
    const color = body.color != null ? String(body.color) : String(current.color || '');
    const maxAgeRating = body.maxAgeRating != null
      ? Number(body.maxAgeRating)
      : Number(current.max_age_rating || 999);
    const pin = body.pin != null ? String(body.pin) : String(current.pin || '');
    const sortOrder = body.sortOrder != null ? Number(body.sortOrder) : Number(current.sort_order || 0);
    await execute(
      `UPDATE profiles SET name = ?, avatar = ?, color = ?, max_age_rating = ?, pin = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
      [name, avatar, color, maxAgeRating, pin, sortOrder, isoNow(), id],
    );
    const updated = await queryOne('SELECT * FROM profiles WHERE id = ?', [id]);
    res.json({ ok: true, profile: publicProfileRow(updated) });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.delete('/api/profiles/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params?.id || '');
    const current = await queryOne('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!current) return res.status(404).json({ ok: false, message: 'Perfil nao encontrado.' });
    const total = await queryOne('SELECT COUNT(*) AS total FROM profiles WHERE user_id = ?', [req.user.id]);
    if (Number(total?.total || 0) <= 1) {
      return res.status(400).json({ ok: false, message: 'Nao e permitido remover o ultimo perfil.' });
    }
    await execute('DELETE FROM profiles WHERE id = ?', [id]);
    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    auth: true,
    port: process.env.PORT || port,
    env: process.env.NODE_ENV || 'development',
    ts: new Date().toISOString(),
  });
});

async function safePrivateAvatarAccess(req, res, next) {
  const rawUrl = decodeURIComponent(req.path);
  const match = /^\/avatar_privado\/avatar_([^/]+)\//.exec(rawUrl);
  if (!match) {
    return next();
  }
  const folderUserId = String(match[1] || '');
  const token = req.cookies?.[AUTH_COOKIE] || null;
  if (!token) {
    return res.status(403).json({ ok: false, message: 'Acesso nao autorizado a este avatar.' });
  }
  let userIdFromToken = null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    userIdFromToken = decoded?.sub ? String(decoded.sub) : null;
  } catch {
    userIdFromToken = null;
  }
  if (!userIdFromToken || folderUserId !== String(userIdFromToken).replace(/[^A-Za-z0-9_-]/g, '_')) {
    return res.status(403).json({ ok: false, message: 'Acesso nao autorizado a este avatar.' });
  }
  next();
}

function mediaStaticRootMiddleware(req, res, next) {
  let requested = '';
  try {
    requested = decodeURIComponent(req.path || '');
  } catch {
    return res.status(400).json({ ok: false, message: 'Caminho invalido.' });
  }
  // req.path usa '/' como separador; nao usar path.normalize (no Windows viraria "\",
  // o que rejeitaria todos os arquivos). Bloqueia apenas tentativas de traversal.
  if (requested.includes('..') || requested.includes('\\') || requested.includes('\0')) {
    return res.status(400).json({ ok: false, message: 'Caminho invalido.' });
  }
  next();
}

app.use(
  '/media',
  mediaStaticRootMiddleware,
  (req, res, next) => safePrivateAvatarAccess(req, res, next),
  express.static(AVATAR_PATHS.mediaDir, {
    maxAge: '7d',
    etag: true,
    fallthrough: true,
  }),
);

app.get('/api/avatars', requireAuth, async (req, res) => {
  try {
    const [publicList, privateList] = await Promise.all([
      listPublicAvatars(),
      listUserPrivateAvatars(req.user?.id),
    ]);
    return res.json({
      ok: true,
      public: publicList,
      private: privateList,
      userPhoto: String(req.user?.foto || ''),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.post('/api/avatars/upload', requireAuth, async (req, res) => {
  try {
    const filename = String(req.body?.filename || req.body?.name || 'avatar_upload');
    let buffer;
    const maybeBase64 = String(req.body?.dataBase64 || req.body?.base64 || '').trim();
    if (maybeBase64) {
      const clean = maybeBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      if (!clean) {
        return res.status(400).json({ ok: false, message: 'Imagem vazia.' });
      }
      try {
        buffer = Buffer.from(clean, 'base64');
      } catch {
        return res.status(400).json({ ok: false, message: 'Base64 invalido.' });
      }
    } else if (typeof req.body?.dataUrl && /^data:image\//i.test(String(req.body.dataUrl))) {
      const dataUrl = String(req.body.dataUrl);
      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex < 0) return res.status(400).json({ ok: false, message: 'Data URL invalida.' });
      try {
        buffer = Buffer.from(dataUrl.slice(commaIndex + 1), 'base64');
      } catch {
        return res.status(400).json({ ok: false, message: 'Data URL invalida.' });
      }
    } else {
      return res.status(400).json({ ok: false, message: 'Informe uma imagem (dataBase64 ou dataUrl).' });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ ok: false, message: 'Arquivo vazio.' });
    }
    const saved = await savePrivateAvatar(req.user.id, filename, buffer);
    return res.json({ ok: true, avatar: saved });
  } catch (error) {
    return res.status(400).json({ ok: false, message: safeError(error) });
  }
});

app.post('/api/avatars/apply', requireAuth, async (req, res) => {
  try {
    const target = String(req.body?.target || '').toLowerCase();
    const url = sanitizeAvatarUrl(req.body?.url);
    if (!target || !url) {
      return res.status(400).json({ ok: false, message: 'Informe target (user ou profile) e url do avatar.' });
    }
    if (target === 'user') {
      await execute(
        'UPDATE users SET foto = ?, updated_at = ? WHERE id = ?',
        [url, isoNow(), req.user.id],
      );
      const row = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
      return res.json({ ok: true, user: publicUserRow(row) });
    }
    if (target === 'profile') {
      const profileId = String(req.body?.profileId || '').trim();
      if (!profileId) return res.status(400).json({ ok: false, message: 'Informe profileId.' });
      const existing = await queryOne('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [profileId, req.user.id]);
      if (!existing) {
        return res.status(404).json({ ok: false, message: 'Perfil nao encontrado.' });
      }
      await execute(
        'UPDATE profiles SET avatar = ?, updated_at = ? WHERE id = ?',
        [url, isoNow(), profileId],
      );
      const row = await queryOne('SELECT * FROM profiles WHERE id = ?', [profileId]);
      return res.json({ ok: true, profile: publicProfileRow(row) });
    }
    return res.status(400).json({ ok: false, message: 'Target invalido. Use user ou profile.' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: safeError(error) });
  }
});

app.get('/api/catalog/status', requireAuth, async (_req, res) => {
  try {
    const status = await getCatalogStatus();
    res.json({
      ok: true,
      ...status,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: safePublicError('catalog_status', error, 'Nao foi possivel verificar status.'),
    });
  }
});

app.post('/api/catalog/sync', requireAuth, requireAdmin, sensitiveActionRateLimiter, async (req, res) => {
  const settings = mergeSettings(req.body || {});
  const force = Boolean(req.body?.force);

  try {
    const status = await syncCatalogToDatabase(settings, { force });
    res.json({
      ok: true,
      ...status,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: safePublicError('catalog_sync', error, 'Nao foi possivel atualizar o catalogo no momento. Verifique a conexao com o provedor e tente novamente.'),
    });
  }
});

app.post('/api/catalog', requireAuth, requireAdmin, sensitiveActionRateLimiter, async (req, res) => {
  const settings = mergeSettings(req.body || {});

  try {
    const status = await syncCatalogToDatabase(settings, {
      force: !req.body?.skipSync,
    });
    res.json({
      ok: true,
      ...status,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: safePublicError('catalog_import', error, 'Nao foi possivel processar o catalogo no momento.'),
    });
  }
});

app.post('/api/catalog/query', requireAuth, async (req, res) => {
  try {
    const result = await queryCatalogPage(req.body || {});
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: safeError(error),
    });
  }
});

app.post('/api/catalog/exists-ids', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const result = await resolveExistingIds(ids);
    res.json({
      ok: true,
      valid: result.valid,
      invalid: result.invalid,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: safeError(error),
      valid: [],
      invalid: Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [],
    });
  }
});

app.get('/api/catalogs', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM catalogs ORDER BY created_at DESC');
    res.json({
      ok: true,
      catalogs: rows.map(publicCatalogRow),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: safePublicError('catalog_list', error, 'Nao foi possivel carregar as listas salvas.'),
    });
  }
});

app.get('/api/catalogs/provider', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    provider: {
      baseUrl: DEFAULT_SETTINGS.baseUrl || '',
      username: DEFAULT_SETTINGS.username || '',
      hasPassword: Boolean(DEFAULT_SETTINGS.password),
    },
  });
});

app.post('/api/catalogs', requireAuth, requireAdmin, sensitiveActionRateLimiter, async (req, res) => {
  const name = String(req.body?.name || '').trim();

  const source = normalizeCatalogSource({
    url: req.body?.url,
    baseUrl: req.body?.baseUrl,
    username: req.body?.username,
    password: req.body?.password,
    output: req.body?.output,
  });

  if (source.error) {
    return res.status(400).json({ ok: false, message: source.error });
  }

  if (!/^https?:\/\//i.test(source.url || '')) {
    return res.status(400).json({
      ok: false,
      message: 'Nao foi possivel montar a URL da lista a partir desses dados.',
    });
  }

  try {
    const id = uid('cat');
    const now = isoNow();
    await runPersistent(
      `INSERT INTO catalogs (id, name, url, base_url, username, password, output, status, error_message, total_count, live_count, movie_count, series_count, is_active, created_at, updated_at, last_sync_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', 0, 0, 0, 0, 0, ?, ?, '')`,
      [
        id,
        name || deriveCatalogName(source.url, source.username),
        source.url,
        source.baseUrl || '',
        source.username || '',
        source.password || '',
        source.output || 'm3u8',
        now,
        now,
      ],
    );

    const row = await runCatalogDownload(id);
    res.json({ ok: true, catalog: publicCatalogRow(row) });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: safePublicError('catalog_create', error, 'Nao foi possivel adicionar a lista.'),
    });
  }
});

app.post('/api/catalogs/:id/retry', requireAuth, requireAdmin, sensitiveActionRateLimiter, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const existing = await queryOne('SELECT id FROM catalogs WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ ok: false, message: 'Lista nao encontrada.' });
    }

    const row = await runCatalogDownload(id);
    res.json({ ok: true, catalog: publicCatalogRow(row) });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: safePublicError('catalog_retry', error, 'Nao foi possivel tentar novamente agora.'),
    });
  }
});

app.delete('/api/catalogs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    await runPersistent('DELETE FROM catalogs WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: safePublicError('catalog_delete', error, 'Nao foi possivel remover a lista.'),
    });
  }
});

app.get('/api/series/:seriesKey', requireAuth, async (req, res) => {
  try {
    const details = await getSeriesGroupDetails(req.params.seriesKey || '', {
      maxAgeRating: req.query.maxAgeRating,
    });
    if (!details) {
      return res.status(404).json({
        ok: false,
        message: 'Serie nao encontrada.',
      });
    }

    return res.json({
      ok: true,
      ...details,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: safeError(error),
    });
  }
});

app.get('/api/cast-lookup', requireAuth, async (req, res) => {
  const rawQuery = String(req.query.q || '').trim();
  const contentType = String(req.query.type || '').trim();
  if (!rawQuery) {
    return res.status(400).json({
      ok: false,
      message: 'Query invalida.',
    });
  }

  const suffix = contentType === 'movie'
    ? ' elenco completo filme'
    : contentType === 'series'
      ? ' elenco serie completa'
      : ' elenco';
  const query = `${rawQuery}${suffix}`;

  const searchParams = new URLSearchParams({
    q: query,
    hl: 'pt-BR',
    gl: 'br',
    ie: 'utf-8',
  });

  const endpoints = [
    `https://www.google.com.br/search?${searchParams.toString()}`,
    `https://www.google.com/search?${searchParams.toString()}`,
  ];

  const defaultHeaders = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    DNT: '1',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
  };

  const userAgents = [
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ];

  let lastError = null;
  let html = '';
  let queryUsed = query;

  for (let i = 0; i < endpoints.length; i++) {
    const googleUrl = endpoints[i];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const upstream = await fetch(googleUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        agent: fetchAgent,
        headers: {
          'User-Agent': userAgents[i % userAgents.length],
          ...defaultHeaders,
        },
      });
      clearTimeout(timeoutId);

      if (upstream.status === 429 || upstream.status === 403) {
        lastError = new Error(`Google bloqueou a consulta (HTTP ${upstream.status}). Tente novamente em alguns minutos.`);
        continue;
      }

      if (!upstream.ok) {
        lastError = new Error(`Google retornou erro ${upstream.status}.`);
        continue;
      }

      const contentTypeHeader = (upstream.headers.get('content-type') || '').toLowerCase();
      if (contentTypeHeader && !contentTypeHeader.includes('text/html')) {
        lastError = new Error(`Google retornou conteudo invalido (${contentTypeHeader}).`);
        continue;
      }

      const rawText = await upstream.text();
      if (/\/sorry\/index|captcha|consent.google|before you continue/i.test(rawText)) {
        lastError = new Error('Google pediu verificacao CAPTCHA. Tente novamente mais tarde.');
        continue;
      }

      if (rawText.length < 5000) {
        lastError = new Error('Google retornou pagina vazia.');
        continue;
      }

      html = rawText;
      break;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      continue;
    }
  }

  if (!html) {
    return res.status(502).json({
      ok: false,
      message: lastError?.name === 'AbortError'
        ? 'Timeout ao consultar Google.'
        : (lastError?.message || 'Nao foi possivel consultar o Google.'),
    });
  }

  try {
    const payload = parseCastFromGoogleHtml(html, rawQuery);
    return res.json({
      ok: true,
      query: rawQuery,
      queryUsed,
      title: payload.title || rawQuery,
      summary: payload.summary || '',
      cast: payload.cast,
      directors: payload.directors,
      writers: payload.writers,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'Nao foi possivel extrair o elenco da resposta do Google.',
    });
  }
});

function parseCastFromGoogleHtml(html, fallbackTitle) {
  function stripTags(value) {
    return String(value || '')
      .replace(/<br\s*\/?>/gi, ', ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pickUnique(list) {
    const seen = new Set();
    const clean = [];
    for (const entry of list) {
      const key = entry.name.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      clean.push(entry);
    }
    return clean;
  }

  const titleMatch = html.match(/<div class="kno-ecr-pt[^"]*"[^>]*>(.*?)<\/div>/is)
    || html.match(/<span class="kno-fv"[^>]*>(.*?)<\/span>/is)
    || html.match(/<title>(.*?)<\/title>/is);
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s*-\s*Pesquisa Google.*$/i, '') : fallbackTitle;

  const summaryMatch = html.match(/<div class="kno-rdesc"[^>]*>.*?<span>(.*?)<\/span>.*?<\/div>/is)
    || html.match(/<div data-attrid="kc:\/[^"]*description[^"]*"[^>]*><span[^>]*>(.*?)<\/span><\/div>/is);
  const summary = summaryMatch ? stripTags(summaryMatch[1]) : '';

  const cast = [];
  const directors = [];
  const writers = [];

  const kpBlocks = [
    ...html.matchAll(/<div class="rVusze"[^>]*>(.*?)<\/div>\s*<\/div>\s*<\/div>/gis),
    ...html.matchAll(/<div data-attrid="kc:[^"]*(cast|starring|director|creator|writer)[^"]*"[^>]*>(.*?)<\/div>\s*<\/div>/gis),
    ...html.matchAll(/<span class="w8qArf"[^>]*>(.*?)<\/span>\s*<span class="kno-fv"[^>]*>(.*?)<\/span>/gis),
  ];

  for (const block of kpBlocks) {
    const raw = block[1] || block[2] || '';
    const labelMatch = raw.match(/(Elenco|Estrelando|Cast|Starring|Diretor|Directors|Direção|Criador|Creators|Roteirista|Writers)/i);
    const label = labelMatch ? labelMatch[1].toLowerCase() : '';

    if (/elenco|estrelando|cast|starring/i.test(label)) {
      const names = raw
        .replace(/<span class="w8qArf"[^>]*>.*?<\/span>/gis, '')
        .match(/<a[^>]*>(.*?)<\/a>/gis)
        ?.map((anchor) => {
          const name = stripTags(anchor);
          const roleMatch = anchor.match(/<span[^>]*role="tooltip"[^>]*>(.*?)<\/span>/is);
          const role = roleMatch ? stripTags(roleMatch[1]) : '';
          return { name, role: role || '' };
        }) || [];
      cast.push(...names);
    } else if (/diretor|director|direção/i.test(label)) {
      const names = raw
        .replace(/<span class="w8qArf"[^>]*>.*?<\/span>/gis, '')
        .match(/<a[^>]*>(.*?)<\/a>/gis)
        ?.map((anchor) => ({ name: stripTags(anchor), role: 'Direção' })) || [];
      directors.push(...names);
    } else if (/criador|creator|roteirista|writer/i.test(label)) {
      const names = raw
        .replace(/<span class="w8qArf"[^>]*>.*?<\/span>/gis, '')
        .match(/<a[^>]*>(.*?)<\/a>/gis)
        ?.map((anchor) => ({ name: stripTags(anchor), role: /criador|creator/i.test(label) ? 'Criação' : 'Roteiro' })) || [];
      writers.push(...names);
    }
  }

  if (!cast.length) {
    const fallbackCastMatches = html.matchAll(/<a[^>]*aria-label="(.*?)"[^>]*>.*?<div class="Fb0B9"[^>]*>(.*?)<\/div>/gis);
    for (const match of fallbackCastMatches) {
      const name = stripTags(match[1]);
      const role = stripTags(match[2]);
      if (name) {
        cast.push({ name, role });
      }
    }
  }

  if (!cast.length) {
    const secondary = html.matchAll(/<div class="ct5Ked"[^>]*>.*?<a[^>]*>(.*?)<\/a>.*?<span class="wsqIpb"[^>]*>(.*?)<\/span>/gis);
    for (const match of secondary) {
      cast.push({ name: stripTags(match[1]), role: stripTags(match[2]) });
    }
  }

  return {
    title,
    summary,
    cast: pickUnique(cast).slice(0, 24),
    directors: pickUnique(directors).slice(0, 8),
    writers: pickUnique(writers).slice(0, 8),
  };
}

app.post('/api/stream-url', requireAuth, async (req, res) => {
  const settings = mergeSettings({});
  const { itemId = '' } = req.body || {};
  const item = await getStoredItem(itemId);

  if (!item?.streamType || !item?.streamId) {
    return res.status(400).json({
      ok: false,
      message: 'Item de stream invalido.',
    });
  }

  const candidates = buildStreamCandidates(settings, item).flatMap((candidate) => {
    const proxyUrl = `/api/stream-proxy?url=${encodeURIComponent(candidate.url)}`;
    return [
      {
        ...candidate,
        mode: 'direct',
      },
      {
        ...candidate,
        url: proxyUrl,
        mode: 'proxy',
        label: `${candidate.label} via proxy`,
      },
    ];
  });

  return res.json({
    ok: true,
    url: buildStreamUrl(settings, item),
    candidates,
  });
});

app.get('/api/stream-proxy', requireAuth, async (req, res) => {
  const upstreamUrl = String(req.query.url || '').trim();
  if (!/^https?:\/\//i.test(upstreamUrl)) {
    return res.status(400).json({
      ok: false,
      message: 'URL de stream invalida.',
    });
  }

  // Anti-SSRF: so permite hosts do provedor configurado e bloqueia rede interna/loopback.
  let targetUrl;
  try {
    targetUrl = new URL(upstreamUrl);
  } catch {
    return res.status(400).json({ ok: false, message: 'URL de stream invalida.' });
  }
  const targetHost = targetUrl.hostname.toLowerCase();
  if (isPrivateHostname(targetHost)) {
    return res.status(403).json({ ok: false, message: 'Destino de stream nao permitido.' });
  }
  const allowedHosts = await getAllowedProviderHosts();
  if (!allowedHosts.has(targetHost)) {
    return res.status(403).json({ ok: false, message: 'Destino de stream nao permitido.' });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, STREAM_PROXY_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timeoutId);
  };
  req.on('close', () => {
    controller.abort();
    cleanup();
  });
  res.on('close', cleanup);

  try {
    const headers = {};
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }
    if (req.headers['user-agent']) {
      headers['User-Agent'] = req.headers['user-agent'];
    }
    headers.Accept = '*/*';
    headers['Accept-Encoding'] = 'identity';
    headers.Connection = 'keep-alive';

    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      agent: fetchAgent,
    });

    const allowedHeaders = [
      'content-type',
      'accept-ranges',
      'content-range',
      'cache-control',
      'content-disposition',
      'etag',
      'last-modified',
    ];

    allowedHeaders.forEach((headerName) => {
      const value = upstream.headers.get(headerName);
      if (value) {
        res.setHeader(headerName, value);
      }
    });
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'no-store');
    res.status(upstream.status);

    if (!upstream.body) {
      cleanup();
      return res.end();
    }

    const stream = upstream.body;
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.destroy();
      }
    });
    stream.on('close', cleanup);
    stream.pipe(res);
    return undefined;
  } catch (error) {
    cleanup();
    if (controller.signal.aborted && req.destroyed) {
      return undefined;
    }

    return res.status(timedOut ? 504 : 502).json({
      ok: false,
      message: timedOut
        ? 'Timeout ao buscar stream no proxy.'
        : safePublicError('stream_proxy', error, 'Nao foi possivel reproduzir este stream no momento.'),
    });
  }
});

app.use(express.static(frontendDist));

app.all('/api/*', (_req, res) => {
  return res.status(404).json({
    ok: false,
    message: 'Endpoint da API nao encontrado.',
  });
});

app.get('*', (req, res) => {
  return res.sendFile(path.join(frontendDist, 'index.html'));
});

// Error handler global: GARANTE que nenhum stack trace, erro de SQL, URL com credenciais ou detalhe tecnico
// seja enviado para o frontend. Tudo e logado no servidor com a funcao logServerError().
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, _next) => {
  if (error && (error.type === 'entity.too.large' || error.status === 413)) {
    return res.status(413).json({ ok: false, message: 'Corpo da requisicao muito grande.' });
  }
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: 'Corpo da requisicao invalido.' });
  }
  logServerError(`global_err_${req.method}_${req.path}`, error);
  if (res.headersSent) return undefined;
  return res.status(500).json({
    ok: false,
    message: 'Falha interna no servidor. Tente novamente em instantes.',
  });
});

app.listen(port, () => {
  console.log('='.repeat(60));
  console.log('[IPTV-AUTH] Servidor IPTV + autenticacao multiusuario ATIVO');
  console.log(`[IPTV-AUTH] Porta.......: ${port}`);
  console.log(`[IPTV-AUTH] NODE_ENV....: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[IPTV-AUTH] JWT_SECRET..: ${process.env.JWT_SECRET ? 'CONFIGURADO (OK)' : 'AVISO - ausente, sessao expira por restart'}`);
  console.log(`[IPTV-AUTH] Acesso......: http://localhost:${port}`);
  console.log('[IPTV-AUTH] Credencial inicial criada (troque a senha apos o primeiro login)');
  console.log('='.repeat(60));
});
