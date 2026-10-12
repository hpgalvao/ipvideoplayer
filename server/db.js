import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import initSqlJs from 'sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const defaultDataDir = path.resolve(projectRoot, 'data');
const dataDir = path.resolve(process.env.IPTV_DB_PATH || defaultDataDir);
const dbFile = path.resolve(dataDir, 'catalog.sqlite');
const wasmDir = path.resolve(projectRoot, 'node_modules', 'sql.js', 'dist');

const mediaDir = path.resolve(projectRoot, 'media');
const publicAvatarsDir = path.resolve(mediaDir, 'avatar_publico');
const privateAvatarsDir = path.resolve(mediaDir, 'avatar_privado');

const ALLOWED_AVATAR_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

export async function ensureAvatarDirectories() {
  await fs.mkdir(publicAvatarsDir, { recursive: true });
  await fs.mkdir(privateAvatarsDir, { recursive: true });
}

export const AVATAR_PATHS = {
  mediaDir,
  publicAvatarsDir,
  privateAvatarsDir,
  allowedExt: ALLOWED_AVATAR_EXT,
  maxBytes: MAX_AVATAR_BYTES,
};

function isAllowedAvatarFilename(name) {
  const base = path.basename(String(name || ''));
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_AVATAR_EXT.has(ext)) return false;
  if (!base || base === '.' || base === '..') return false;
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return false;
  return true;
}

export function sanitizeAvatarUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^data:image\//i.test(value)) {
    return value;
  }
  // Aceita apenas URLs internas de avatar (publico, ou privado do usuario no padrao
  // /media/avatar_privado/avatar_<id>/<arquivo>). O nome pode conter parenteses
  // (ex.: "avatar(1).png"), entao validamos decodificando o ultimo segmento.
  const clean = value.split('#')[0].split('?')[0];
  const match = /^\/(media\/avatar_publico|media\/avatar_privado\/avatar_[^/]+)\/([^/]+)$/.exec(clean);
  if (!match) {
    return '';
  }
  let name = '';
  try {
    name = decodeURIComponent(match[2]);
  } catch {
    return '';
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return '';
  }
  if (!isAllowedAvatarFilename(name)) {
    return '';
  }
  return value;
}

export function userPrivateAvatarDir(userId) {
  return path.resolve(privateAvatarsDir, `avatar_${String(userId || '').replace(/[^A-Za-z0-9_-]/g, '_')}`);
}

export async function listPublicAvatars() {
  await ensureAvatarDirectories();
  try {
    const names = await fs.readdir(publicAvatarsDir);
    const results = [];
    for (const name of names) {
      if (!isAllowedAvatarFilename(name)) continue;
      const full = path.join(publicAvatarsDir, name);
      let stat;
      try { stat = await fs.stat(full); } catch { continue; }
      if (!stat.isFile()) continue;
      results.push({
        type: 'public',
        label: name,
        url: `/media/avatar_publico/${encodeURIComponent(name)}`,
        size: stat.size,
      });
    }
    return results.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  } catch {
    return [];
  }
}

export async function listUserPrivateAvatars(userId) {
  if (!userId) return [];
  await ensureAvatarDirectories();
  const userDir = userPrivateAvatarDir(userId);
  await fs.mkdir(userDir, { recursive: true });
  try {
    const names = await fs.readdir(userDir);
    const results = [];
    for (const name of names) {
      if (!isAllowedAvatarFilename(name)) continue;
      const full = path.join(userDir, name);
      let stat;
      try { stat = await fs.stat(full); } catch { continue; }
      if (!stat.isFile()) continue;
      results.push({
        type: 'private',
        label: name,
        url: `/media/avatar_privado/avatar_${encodeURIComponent(userId)}/${encodeURIComponent(name)}`,
        size: stat.size,
      });
    }
    return results.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  } catch {
    return [];
  }
}

export async function savePrivateAvatar(userId, originalFilename, fileBuffer) {
  if (!userId) throw new Error('Usuario necessario.');
  const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer || '');
  if (buf.length === 0) throw new Error('Arquivo vazio.');
  if (buf.length > MAX_AVATAR_BYTES) throw new Error(`Arquivo muito grande (maximo ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB).`);
  const originalBase = path.basename(String(originalFilename || 'upload'));
  const originalExt = path.extname(originalBase).toLowerCase() || '.png';
  if (!ALLOWED_AVATAR_EXT.has(originalExt)) throw new Error('Formato de imagem nao permitido.');
  const random = `${crypto.randomBytes(8).toString('hex')}${Date.now().toString(36)}`;
  const safeName = `${random}${originalExt}`;
  const userDir = userPrivateAvatarDir(userId);
  await ensureAvatarDirectories();
  await fs.mkdir(userDir, { recursive: true });
  const target = path.join(userDir, safeName);
  await fs.writeFile(target, buf);
  return {
    type: 'private',
    label: safeName,
    url: `/media/avatar_privado/avatar_${encodeURIComponent(userId)}/${encodeURIComponent(safeName)}`,
    size: buf.length,
  };
}

let databasePromise;

function runStatement(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.run(params);
  statement.free();
}

function readAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];

  while (statement.step()) {
    rows.push(statement.getAsObject());
  }

  statement.free();
  return rows;
}

function readOne(db, sql, params = []) {
  return readAll(db, sql, params)[0] || null;
}

function hasColumn(db, tableName, columnName) {
  const columns = readAll(db, `PRAGMA table_info(${tableName})`);
  return columns.some((column) => column.name === columnName);
}

function ensureColumn(db, tableName, columnName, definition) {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      stream_type TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_url TEXT,
      extension TEXT,
      container_extension TEXT,
      poster TEXT,
      category TEXT,
      category_id TEXT,
      year INTEGER,
      genre TEXT,
      genres_json TEXT,
      genres_index TEXT,
      series_title TEXT,
      normalized_series_title TEXT,
      series_key TEXT,
      season_number INTEGER,
      episode_number INTEGER,
      episode_title TEXT,
      cast_text TEXT,
      normalized_cast TEXT,
      director TEXT,
      normalized_director TEXT,
      rating TEXT,
      age_rating INTEGER,
      added TEXT,
      plot TEXT,
      normalized_plot TEXT,
      tmdb_id TEXT,
      catalog_id TEXT
    );
  `);

  ensureColumn(db, 'items', 'series_title', 'TEXT');
  ensureColumn(db, 'items', 'normalized_series_title', 'TEXT');
  ensureColumn(db, 'items', 'series_key', 'TEXT');
  ensureColumn(db, 'items', 'season_number', 'INTEGER');
  ensureColumn(db, 'items', 'episode_number', 'INTEGER');
  ensureColumn(db, 'items', 'episode_title', 'TEXT');
  ensureColumn(db, 'items', 'cast_text', 'TEXT');
  ensureColumn(db, 'items', 'normalized_cast', 'TEXT');
  ensureColumn(db, 'items', 'director', 'TEXT');
  ensureColumn(db, 'items', 'normalized_director', 'TEXT');
  ensureColumn(db, 'items', 'age_rating', 'INTEGER');
  ensureColumn(db, 'items', 'normalized_plot', 'TEXT');
  ensureColumn(db, 'items', 'catalog_id', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_content_type ON items(content_type);
    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
    CREATE INDEX IF NOT EXISTS idx_items_year ON items(year);
    CREATE INDEX IF NOT EXISTS idx_items_sort_name ON items(sort_name);
    CREATE INDEX IF NOT EXISTS idx_items_series_key ON items(series_key);
    CREATE INDEX IF NOT EXISTS idx_items_series_title ON items(series_title);
    CREATE INDEX IF NOT EXISTS idx_items_catalog_id ON items(catalog_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      base_url TEXT,
      username TEXT,
      password TEXT,
      output TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      total_count INTEGER NOT NULL DEFAULT 0,
      live_count INTEGER NOT NULL DEFAULT 0,
      movie_count INTEGER NOT NULL DEFAULT 0,
      series_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sync_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tipo TEXT NOT NULL DEFAULT 'usuario',
      nome TEXT NOT NULL,
      foto TEXT,
      email TEXT,
      contato TEXT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      plano TEXT,
      dt_assinatura TEXT,
      dt_validade TEXT,
      profile_limit INTEGER,
      catalog_limit INTEGER,
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Add missing columns to existing tables BEFORE creating indexes that depend on them
  ensureColumn(db, 'catalogs', 'base_url', 'TEXT');
  ensureColumn(db, 'catalogs', 'username', 'TEXT');
  ensureColumn(db, 'catalogs', 'password', 'TEXT');
  ensureColumn(db, 'catalogs', 'output', 'TEXT');
  ensureColumn(db, 'catalogs', 'user_id', 'TEXT');
  ensureColumn(db, 'catalogs', 'is_public', 'INTEGER NOT NULL DEFAULT 0');

  ensureColumn(db, 'users', 'foto', 'TEXT');
  ensureColumn(db, 'users', 'email', 'TEXT');
  ensureColumn(db, 'users', 'contato', 'TEXT');
  ensureColumn(db, 'users', 'profile_limit', 'INTEGER');
  ensureColumn(db, 'users', 'catalog_limit', 'INTEGER');

  ensureColumn(db, 'profiles', 'avatar', 'TEXT');
  ensureColumn(db, 'profiles', 'color', 'TEXT');
  ensureColumn(db, 'profiles', 'max_age_rating', 'INTEGER DEFAULT 999');
  ensureColumn(db, 'profiles', 'catalog_id', 'TEXT');

  ensureColumn(db, 'items', 'series_title', 'TEXT');
  ensureColumn(db, 'items', 'normalized_series_title', 'TEXT');
  ensureColumn(db, 'items', 'series_key', 'TEXT');
  ensureColumn(db, 'items', 'season_number', 'INTEGER');
  ensureColumn(db, 'items', 'episode_number', 'INTEGER');
  ensureColumn(db, 'items', 'episode_title', 'TEXT');
  ensureColumn(db, 'items', 'cast_text', 'TEXT');
  ensureColumn(db, 'items', 'normalized_cast', 'TEXT');
  ensureColumn(db, 'items', 'director', 'TEXT');
  ensureColumn(db, 'items', 'normalized_director', 'TEXT');
  ensureColumn(db, 'items', 'age_rating', 'INTEGER');
  ensureColumn(db, 'items', 'normalized_plot', 'TEXT');
  ensureColumn(db, 'items', 'catalog_id', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_catalogs_created_at ON catalogs(created_at);
    CREATE INDEX IF NOT EXISTS idx_catalogs_user_id ON catalogs(user_id);

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      color TEXT,
      max_age_rating INTEGER NOT NULL DEFAULT 999,
      catalog_id TEXT,
      pin TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_name ON profiles(user_id, name);

    CREATE INDEX IF NOT EXISTS idx_items_content_type ON items(content_type);
    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
    CREATE INDEX IF NOT EXISTS idx_items_year ON items(year);
    CREATE INDEX IF NOT EXISTS idx_items_sort_name ON items(sort_name);
    CREATE INDEX IF NOT EXISTS idx_items_series_key ON items(series_key);
    CREATE INDEX IF NOT EXISTS idx_items_series_title ON items(series_title);
    CREATE INDEX IF NOT EXISTS idx_items_catalog_id ON items(catalog_id);
  `);
}

export function hashPassword(password, salt) {
  const usedSalt = salt || crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password || ''), usedSalt, 64);
  const hash = key.toString('hex');
  return { hash, salt: usedSalt };
}

export function verifyPassword(password, hash, salt) {
  try {
    const { hash: expected } = hashPassword(password, salt);
    if (expected.length !== String(hash || '').length) return false;
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(hash || ''), 'hex');
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function uid(prefix) {
  return `${prefix || 'id'}_${crypto.randomBytes(8).toString('hex')}${Date.now().toString(36)}`;
}

export function isoNow() {
  return new Date().toISOString();
}

export function computeValidityDates(plan) {
  const now = new Date();
  const signature = now.toISOString();
  switch (String(plan || '').toLowerCase()) {
    case 'free':
      return { signature, validity: null, active: 1 };
    case '7dias':
    case '7d':
    case '7': {
      const v = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      return { signature, validity: v.toISOString(), active: 1 };
    }
    case '30dias':
    case '30d':
    case '30':
    case 'mensal': {
      const v = new Date(now);
      v.setMonth(v.getMonth() + 1);
      return { signature, validity: v.toISOString(), active: 1 };
    }
    case '1ano':
    case 'anual':
    case '365':
    case '365dias': {
      const v = new Date(now);
      v.setFullYear(v.getFullYear() + 1);
      return { signature, validity: v.toISOString(), active: 1 };
    }
    default:
      return { signature, validity: null, active: 0 };
  }
}

async function seedInitialAdminIfEmpty(db) {
  const existing = readOne(db, 'SELECT COUNT(*) AS total FROM users');
  if (existing && Number(existing.total) > 0) {
    return;
  }

  const adminPlan = 'free';
  const validity = computeValidityDates(adminPlan);
  const { hash, salt } = hashPassword('pwd01734');
  const adminId = uid('usr');

  runStatement(
    db,
    `INSERT INTO users (id, tipo, nome, foto, email, contato, username, password_hash, password_salt, plano, dt_assinatura, dt_validade, ativo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      adminId,
      'admin',
      'Admin',
      '',
      'admin@iptv.local',
      'Contato do administrador',
      'admin@iptv',
      hash,
      salt,
      adminPlan,
      validity.signature,
      validity.validity,
      1,
      isoNow(),
      isoNow(),
    ],
  );

  const defaultProfiles = [
    { id: uid('prf'), name: 'Helio', maxAge: 999, color: '#e11d48', sort: 0 },
    { id: uid('prf'), name: 'Familia', maxAge: 16, color: '#7c3aed', sort: 1 },
    { id: uid('prf'), name: 'Crianca', maxAge: 10, color: '#059669', sort: 2 },
    { id: uid('prf'), name: 'Visitante', maxAge: 14, color: '#d97706', sort: 3 },    
  ];
  for (const p of defaultProfiles) {
    runStatement(
      db,
      `INSERT INTO profiles (id, user_id, name, avatar, color, max_age_rating, pin, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, adminId, p.name, '', p.color, p.maxAge, '', p.sort, isoNow(), isoNow()],
    );
  }
}

async function persistDb(db) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dbFile, Buffer.from(db.export()));
}

async function createDatabase() {
  await fs.mkdir(dataDir, { recursive: true });

  const SQL = await initSqlJs({
    locateFile: (file) => pathToFileURL(path.join(wasmDir, file)).href,
  });

  let db;
  try {
    const fileContents = await fs.readFile(dbFile);
    db = new SQL.Database(fileContents);
  } catch {
    db = new SQL.Database();
  }

  initializeSchema(db);
  await seedInitialAdminIfEmpty(db);
  await persistDb(db);

  return { db };
}

export async function getDatabase() {
  if (!databasePromise) {
    databasePromise = createDatabase();
  }

  return databasePromise;
}

export async function queryAll(sql, params = []) {
  const { db } = await getDatabase();
  return readAll(db, sql, params);
}

export async function queryOne(sql, params = []) {
  const { db } = await getDatabase();
  return readOne(db, sql, params);
}

export async function execute(sql, params = []) {
  const { db } = await getDatabase();
  runStatement(db, sql, params);
}

export async function transaction(callback) {
  const { db } = await getDatabase();
  db.exec('BEGIN TRANSACTION');

  try {
    const result = await callback({
      run: (sql, params = []) => runStatement(db, sql, params),
      all: (sql, params = []) => readAll(db, sql, params),
      one: (sql, params = []) => readOne(db, sql, params),
    });

    db.exec('COMMIT');
    await persistDb(db);
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
