import dns from 'dns';
import http from 'http';
import https from 'https';

// Motivo: `dns.setServers` so afeta o resolver c-ares (`dns.resolve*`), enquanto
// `fetch`/`http` usam `dns.lookup` -> getaddrinfo do sistema (DNS da operadora).
// Quando esse DNS falha (ENOTFOUND), as requisicoes quebram. Para contornar,
// fornecemos um `lookup` customizado que resolve pelos servidores configurados
// via `dns.Resolver`. Se o resolver custom nao responder dentro do timeout (ou
// falhar), cai de volta para o resolvedor do sistema.
const FALLBACK_DNS_SERVERS = ['185.49.71.100', '46.165.236.165'];
const DEFAULT_LOOKUP_TIMEOUT_MS = 5000;

// Muitos provedores IPTV entregam IPv6 quebrado; prioriza IPv4 tambem no
// resolvedor do sistema (fallback), evitando timeouts de conexao.
if (typeof dns.setDefaultResultOrder === 'function') {
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // Ignora: algumas versoes de Node nao suportam a opcao.
  }
}

export function getDnsServers() {
  const raw = String(process.env.IPTV_DNS_SERVERS || '').trim();
  const source = raw || FALLBACK_DNS_SERVERS.join(',');
  return [...new Set(source.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function getLookupTimeoutMs() {
  const parsed = Number(process.env.IPTV_DNS_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOOKUP_TIMEOUT_MS;
}

let cachedResolver;

function getResolver() {
  if (cachedResolver !== undefined) {
    return cachedResolver;
  }

  const servers = getDnsServers();
  if (!servers.length) {
    cachedResolver = null;
    return cachedResolver;
  }

  try {
    const resolver = new dns.Resolver();
    resolver.setServers(servers);
    cachedResolver = resolver;
  } catch {
    cachedResolver = null;
  }

  return cachedResolver;
}

function normalizeLookupOptions(options) {
  if (typeof options === 'number') {
    return { family: options, all: false };
  }
  const opts = options || {};
  return { family: opts.family || 0, all: Boolean(opts.all) };
}

function familyOf(address) {
  return String(address).includes(':') ? 6 : 4;
}

function systemLookup(hostname, options, callback) {
  dns.lookup(hostname, options, callback);
}

export function dnsResilientLookup(hostname, options, callback) {
  const opts = normalizeLookupOptions(options);
  const resolver = getResolver();

  if (!resolver) {
    systemLookup(hostname, options, callback);
    return;
  }

  let settled = false;
  const timeoutMs = getLookupTimeoutMs();

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    // Resolver custom nao respondeu a tempo; usa o resolvedor do sistema.
    systemLookup(hostname, options, callback);
  }, timeoutMs);

  const rrtype = opts.family === 6 ? 'AAAA' : 'A';

  resolver.resolve(hostname, rrtype, (error, addresses) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);

    if (error || !Array.isArray(addresses) || addresses.length === 0) {
      systemLookup(hostname, options, callback);
      return;
    }

    const pool = addresses.map(String);
    if (opts.all) {
      callback(null, pool.map((address) => ({ address, family: familyOf(address) })));
      return;
    }

    const chosen = pool[0];
    callback(null, chosen, familyOf(chosen));
  });
}

let agents;

export function getFetchAgents() {
  if (!agents) {
    agents = {
      http: new http.Agent({ keepAlive: true, lookup: dnsResilientLookup }),
      https: new https.Agent({ keepAlive: true, lookup: dnsResilientLookup }),
    };
  }

  return agents;
}

// node-fetch aceita `agent` como funcao que recebe a URL e retorna o agent.
export function fetchAgent(parsedURL) {
  const { http: httpAgent, https: httpsAgent } = getFetchAgents();
  return parsedURL && parsedURL.protocol === 'https:' ? httpsAgent : httpAgent;
}

// Detecta hostnames que apontam para a propria maquina / rede interna.
// Usado para bloquear SSRF (ex.: proxy de stream apontando para localhost ou metadata de nuvem).
export function isPrivateHostname(rawHostname) {
  const host = String(rawHostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  if (!host) {
    return true;
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true;
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local (metadata de nuvem)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast/reservado
    return false;
  }

  if (host === '::1' || host === '::') return true;
  if (host.startsWith('::ffff:')) return isPrivateHostname(host.slice('::ffff:'.length));
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true; // link-local fe80::/10

  return false;
}
