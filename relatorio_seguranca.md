# Relatorio de Seguranca — IPTV Particular

| | |
| --- | --- |
| **Projeto** | IPTV Particular (`server/` Express + `frontend/` React/Vite) |
| **Data da analise** | 11/10/2026 |
| **Escopo** | Codigo-fonte do backend (`server/`), frontend (`frontend/src/`), configuracao (`.env*`, `Dockerfile`, `docker-compose`), dependencias |
| **Tipo** | Revisao estatica (leitura de codigo) orientada a falhas comuns em projetos gerados por "vibe code" |
| **Alteracoes no projeto** | Nenhuma. Este documento e o unico arquivo criado |

> Este relatorio e um diagnostico. Nada no codigo foi alterado.

---

## 1. Resumo executivo

O projeto esta **estruturalmente bem organizado** para um app pessoal e ja aplica varias boas
praticas importantes (SQL parametrizado, senhas com `scrypt`+salt, cookie `httpOnly`, erros
genericos para o cliente, escopo de dados por usuario, segredos fora do Git).

Porem, **nao pode ser considerado seguro para exposicao publica na internet** sem ajustes. Os
principais riscos sao:

1. **SSRF** no proxy de stream (`/api/stream-proxy`): qualquer usuario autenticado faz o servidor
   buscar qualquer URL, inclusive enderecos internos.
2. **Vazamento de credenciais em logs** do servidor (a URL do provedor, com `password=...`, vai para
   o log sem limpeza).
3. **Ausencia de rate limiting no login** (forca bruta/credential stuffing).
4. **Configuracoes web inseguras**: CORS refletindo qualquer origem, cookie sem `Secure`, ausencia
   de cabecalhos de seguranca (Helmet/CSP).
5. **Credencial de administrador padrao** (`admin@iptv` / `pwd01734`) e logada no boot.

**Nivel de risco geral:** Medio-Alto para uso exposto; Baixo-Medio para uso estritamente local/pessoal.

---

## 2. Metodologia

Foram revisados os seguintes pontos, tipicos de falhas em codigo gerado rapidamente:

- Segredos e credenciais (hardcoded, `.env`, exemplos, logs)
- Autenticacao / autorizacao / sessoes (JWT, cookies, escopo por usuario)
- Injecao (SQL, comando, template)
- SSRF / requisicoes de saida controladas pelo usuario
- Validacao de entrada e tratamento de erro
- Exposicao de dados (path traversal, arquivos estaticos, headers)
- Frontend (XSS, armazenamento no navegador)
- Configuracao de servidor, CORS, rate limiting, headers
- Dependencias e empacotamento (Docker)

---

## 3. Achados (detalhado)

### 3.1 Criticidade **Alta**

#### A1 — SSRF no `/api/stream-proxy`
- **Local**: `server/index.js:1327` (rota) e `server/index.js:1363` (fetch de `req.query.url`).
- **O que e**: o servidor busca qualquer URL `http(s)` informada pelo cliente e devolve o conteudo.
- **Impacto**: acesso a servicos internos, metadata de nuvem (`169.254.169.254`), paineis locais;
  portas abertas na rede interna; pode servir de ponte para ataques internos.
- **Correcao**: validar o destino (allowlist dos hosts do provedor), bloquear faixas privadas
  (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`), nao seguir redirects para elas,
  e limitar o endpoint a administradores.

#### A2 — Credenciais/segredo em risco de publicacao (`.env`)
- **Local**: `.env`, `.env.development`, `.env.production` (contem usuario/senha do provedor e `JWT_SECRET`).
- **Situacao**: os arquivos estao no `.gitignore` (bom), mas existem no disco com segredos reais e o
  usuario pretendia publicar o repositorio. Um `git add -f` ou um `.gitignore` mal ajustado vaza tudo.
- **Correcao**: manter `.env*` fora do Git (ja garantido), **rotacionar** a senha do provedor e o
  `JWT_SECRET` antes de publicar e nunca commitar esses arquivos.

### 3.2 Criticidade **Media**

#### M1 — Vazamento de credenciais nos logs do servidor
- **Local**: `server/iptv-service.js:46` (`logServerError`) e usos em `fetchText`/`fetchJson`.
- **O que e**: erros de rede sao logados crus; a mensagem do `node-fetch` inclui a URL completa, com
  `username=...&password=...`. Evidencia real observada em execucao:
  `.../get.php?username=heliogalvao&password=47476599` impresso no console.
- **Impacto**: credenciais do provedor ficam em arquivos de log, stdout do Docker/PM2, agregadores.
- **Correcao**: aplicar `scrubMessage()` **antes** de logar (ou logar apenas o host e o label), e
  nunca logar a querystring.

#### M2 — Sem rate limiting no login
- **Local**: `server/index.js:298` (`POST /api/auth/login`).
- **O que e**: nao ha limite de tentativas, atraso progressivo nem bloqueio por conta/IP.
- **Impacto**: forca bruta / credential stuffing ilimitados; a senha padrao `pwd01734` e trivial de testar.
- **Correcao**: adicionar `express-rate-limit` (por IP e por usuario) no login e nas rotas sensiveis;
  considerar backoff e bloqueio temporario.

#### M3 — CORS permissivo com credenciais
- **Local**: `server/index.js:76-81` — `credentials: true` e `origin: (_origin, cb) => cb(null, true)`.
- **O que e**: reflete qualquer origem. Com `SameSite=Lax` o risco pratico e reduzido, mas a
  configuracao e insegura e depende apenas do cookie para conter o ataque.
- **Correcao**: lista de origens permitidas (dominio(s) da aplicacao) e remover o reflexo generico.

#### M4 — Cookie de sessao sem `Secure` e sem `trust proxy`
- **Local**: `server/index.js:249-252` (`secure: false`) e ausencia de `app.set('trust proxy', ...)`.
- **O que e**: em producao HTTPS o cookie ainda pode trafegar em HTTP; atras de proxy reverso o
  `Secure`/IP real nao funcionam corretamente.
- **Correcao**: `secure: process.env.NODE_ENV === 'production'`, configurar `trust proxy` e usar HTTPS.

#### M5 — Ausencia de cabecalhos de seguranca
- **Local**: nenhum uso de `helmet`/CSP em `server/index.js`.
- **O que e**: faltam `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`,
  `Strict-Transport-Security`, `Referrer-Policy`.
- **Impacto**: clickjacking, MIME sniffing, ausencia de HSTS.
- **Correcao**: usar `helmet` com uma CSP adequada (o frontend e SPA + player HLS).

#### M6 — Credencial de administrador padrao + log no boot
- **Local**: `server/db.js` (`seedInitialAdminIfEmpty`, senha `pwd01734`) e `server/index.js:1453`
  (imprime a credencial no console a cada inicializacao).
- **Impacto**: conta de admin conhecida; se nao trocada, toma conta do sistema; log expoe isso.
- **Correcao**: exigir troca no primeiro acesso, gerar senha aleatoria inicial ou ler de variavel de
  ambiente, e nao imprimir credenciais no log.

#### M7 — Corpo de requisicao ate 16 MB em todas as rotas
- **Local**: `server/index.js:84` (`express.json({ limit: '16mb' })`).
- **Impacto**: consumo de memoria / DoS trivial; aplica inclusive ao login.
- **Correcao**: reduzir o limite global (ex.: `100kb`) e usar limite maior apenas nas rotas de upload.

#### M8 — Upload de avatar aceita SVG (XSS latente)
- **Local**: `server/db.js:18` (`ALLOWED_AVATAR_EXT` inclui `.svg`) e `savePrivateAvatar`.
- **O que e**: SVG pode conter `<script>`. Servido do mesmo dominio em `/media/...`; em `<img>` nao
  executa, mas se aberto diretamente na URL o script roda no contexto do site.
- **Correcao**: remover `svg` das extensoes aceitas ou sanitizar/forcar `Content-Disposition:
  attachment` + `Content-Security-Policy` para `/media`.

### 3.3 Criticidade **Baixa**

#### B1 — `IPTV_SOURCE`/`mergeSettings` permite escolher o host de saida no `/api/stream-url`
- **Local**: `server/index.js:1292-1293`. Qualquer usuario pode enviar `baseUrl` no corpo.
- **Impacto**: combinado com o proxy, amplia o SSRF (vide A1).
- **Correcao**: ignorar `baseUrl/usuario/senha` vindos do cliente para usuarios nao-admin.

#### B2 — Enumeracao de contas no login
- **Local**: `server/index.js:314-320`. Retorna mensagens distintas (conta desativada/expirada) contra
  usuario inexistente.
- **Correcao**: mensagem generica uniforme ("usuario ou senha invalidos").

#### B3 — `JWT_SECRET` com fallback aleatorio por processo
- **Local**: `server/index.js:68` (`process.env.JWT_SECRET || crypto.randomBytes(32)...`).
- **Impacto**: sem segredo persistente, toda sessao cai no restart; mascara configuracao ausente.
- **Correcao**: falhar a inicializacao se `JWT_SECRET` nao estiver definido em producao.

#### B4 — `jwt.verify` sem `algorithms` explicito
- **Local**: `server/index.js:265` e `:717`.
- **Correcao**: passar `{ algorithms: ['HS256'] }`.

#### B5 — Middleware de midia com logica confusa
- **Local**: `server/index.js:728-734` — `requested.startsWith('/..').startsWith(requested)` e sem
  efeito. O `express.static` ja mitiga path traversal, mas o codigo e fragil.
- **Correcao**: simplificar para uma verificacao clara de `..`/separadores e confiar no `static` com
  `root` fixo.

#### B6 — `.env.example` com `JWT_SECRET` fixo
- **Local**: `.env.example:6` (`JWT_SECRET=zf83tdfdnDbgh85tsd8s73tt7Ku54n95`).
- **Risco**: induz a reutilizar o mesmo segredo em varios ambientes.
- **Correcao**: trocar por placeholder (`JWT_SECRET=troque-por-um-valor-longo-e-aleatorio`), como em
  `.env.production.example`.

#### B7 — Docker roda como root, sem healthcheck
- **Local**: `Dockerfile` (usuario padrao root; sem `HEALTHCHECK`).
- **Correcao**: criar/usar usuario `node` (`USER node`) e adicionar healthcheck.

#### B8 — `docker-compose.traefik.example.yml` com caminho inconsistente
- **Local**: `docker-compose.traefik.example.yml:4` (`context: ./IPTV` vs raiz do repo).
- **Correcao**: ajustar `context`/`env_file` para a raiz do projeto.

### 3.4 Criticidade **Informativa / Confiabilidade**

#### I1 — `execute()` nao persiste no arquivo (sql.js)
- **Local**: `server/db.js:434-437`. `execute` altera apenas a copia em memoria; so `transaction()`
  grava em `data/catalog.sqlite`.
- **Impacto**: perda de alteracoes (perfis, usuarios, flags) que dependam de `execute` se nao houver
  uma `transaction` posterior. Nao e falha de seguranca, mas afeta integridade dos dados.
- **Correcao**: padronizar as escritas em `transaction()` (ja feito nos endpoints de catalogo).

#### I2 — Codigo residual do template Vite
- **Local**: `frontend/src/main.js` (`innerHTML` com template estatico). Nao referenciado por
  `index.html` (que usa `main.jsx`). Codigo morto; sem conteudo de usuario, sem XSS real.
- **Correcao**: remover arquivos nao usados.

#### I3 — `/api/health` expoe `env` e `port`
- **Local**: `server/index.js:694-702`. Exposicao minima; evitar detalhes em producao.

---

## 4. O que esta correto (boas praticas ja aplicadas)

- **SQL parametrizado** em todas as consultas (filtros, busca, ordenacao com fragmentos fixos,
  `IN (...)` gerado por `?`). **Nao foi encontrada injecao de SQL.**
- **Sem execucao de comandos**: ausencia de `eval`, `new Function`, `child_process`, `spawn`. Os
  `exec(` encontrados sao `RegExp.prototype.exec` (nao execucao de shell).
- **Senhas**: `scryptSync` com salt aleatorio de 16 bytes e comparacao `timingSafeEqual`
  (`server/db.js` `hashPassword`/`verifyPassword`).
- **Sessao**: `req.user` e recarregado do banco a cada requisicao (revogacao de conta funciona);
  verificacao de admin feita no servidor (`requireAdmin`).
- **Escopo por usuario**: perfis e avatares privados filtrados por `user_id` (sem IDOR nas rotas de perfil).
- **Sem vazamento em respostas**: `publicUserRow` nao expoe `password_hash`; `publicCatalogRow`
  mascara a senha do provedor (`password=***`).
- **Erros genericos para o cliente** (`safeError`/`safePublicError`); stack/SQL nao vao para o frontend.
- **Cookie `httpOnly: true` e `SameSite=Lax`**.
- **Frontend nao guarda credenciais/token** em `localStorage` (auth via cookie httpOnly) e nao usa
  `dangerouslySetInnerHTML`.
- **`.gitignore`** ignora `.env*` (exceto os `*.example`) e `data/*.sqlite`.
- **Limites**: upload de avatar com tamanho maximo (4 MB) e extensoes; nomes de arquivo sanitizados
  (`path.basename`).
- **Timeouts** no proxy de stream, no fetch do catalogo e no DNS customizado.

---

## 5. Acoes prioritarias (ordem sugerida)

1. Corrigir o **SSRF** do `/api/stream-proxy` (allowlist + bloqueio de IP privado). *(A1)*
2. **Limpar credenciais dos logs** (`scrubMessage` antes de logar). *(M1)*
3. Adicionar **rate limiting** no login e rotas sensiveis. *(M2)*
4. Restringir **CORS** a origens conhecidas; ajustar **cookie `Secure`** + `trust proxy`. *(M3, M4)*
5. Incluir **`helmet`** e cabecalhos de seguranca. *(M5)*
6. Forcar/trocar a **senha do admin** e remover a impressao de credenciais no boot. *(M6)*
7. Reduzir o **limite de corpo JSON** e tratar **SVG** de avatar. *(M7, M8)*
8. Rotacionar **senha do provedor** e **`JWT_SECRET`** antes de publicar o repositorio. *(A2)*
9. Ajustes menores: `algorithms` no `verify`, mensagem de login uniforme, Docker nao-root, exemplos
   sem segredo. *(B2–B8)*

---

## 6. Checklist final

### Segredos e configuracoes

- [ ] **A2** `.env`/`.env.development`/`.env.production` fora do Git (ja no `.gitignore`) — confirmar
      com `git ls-files | grep -i "\.env"`
- [ ] **A2** Rotacionar a senha do provedor e o `JWT_SECRET` antes de publicar
- [ ] **B6** Trocar o `JWT_SECRET` fixo do `.env.example` por um placeholder
- [ ] **B3** Falhar o boot em producao se `JWT_SECRET` estiver ausente

### Autenticacao e sessao

- [x] Senhas com `scrypt` + salt e comparacao timing-safe
- [x] Cookie `httpOnly` e `SameSite=Lax`
- [ ] **M2** Rate limiting no login (e rotas sensiveis)
- [ ] **M4** Cookie `Secure` em producao + `app.set('trust proxy', ...)`
- [ ] **B2** Mensagem de login uniforme (sem enumeracao de contas)
- [ ] **B4** `jwt.verify(..., { algorithms: ['HS256'] })`
- [ ] **M6** Trocar a senha do admin padrao e nao logar credenciais no boot

### Rede e exposicao

- [ ] **A1** Bloquear SSRF no `/api/stream-proxy` (allowlist + IPs privados)
- [ ] **B1** Ignorar `baseUrl/usuario/senha` do cliente no `/api/stream-url` (para nao-admin)
- [ ] **M3** CORS com lista de origens permitidas
- [ ] **M5** Adicionar `helmet` (CSP, X-Frame-Options, HSTS, nosniff)
- [ ] **M7** Reduzir o limite de `express.json` (ex.: `100kb`) e liberar maior so no upload
- [ ] **M8** Remover `svg` dos avatares ou forcar download/CSP para `/media`

### Dados e entrada

- [x] SQL parametrizado (sem injecao encontrada)
- [x] Sem `eval`/`child_process`/execucao de shell
- [x] Respostas sem hash de senha nem senha do provedor
- [x] Erros genericos ao cliente (sem stack/SQL)
- [ ] **M1** Mascarar credenciais antes de logar (`scrubMessage` nos logs)
- [ ] **B1** Nao confiar em `baseUrl` do cliente para montar URLs de saida

### Infra e codigo

- [ ] **B7** Docker com usuario nao-root + healthcheck
- [ ] **B8** Corrigir `context`/`env_file` do `docker-compose.traefik.example.yml`
- [ ] **I2** Remover `frontend/src/main.js` (codigo morto)
- [ ] **B5** Simplificar a verificacao de caminho no middleware de `/media`
- [ ] **I1** Padronizar escritas com `transaction()` (persistencia real)
- [ ] Rodar `npm audit` e `npm audit --prefix frontend` e corrigir vulnerabilidades de dependencias

### Validacoes ja OK

- [x] Frontend sem `dangerouslySetInnerHTML` e sem credenciais em `localStorage`
- [x] Perfis/avatares escopados por usuario (sem IDOR nas rotas de perfil)
- [x] Admin verificado no servidor em todas as rotas administrativas
- [x] `.gitignore` protege `.env*` e o banco `data/*.sqlite`
- [x] Timeouts em proxy de stream, fetch do catalogo e DNS

---

## 7. Conclusao

O codigo **nao apresenta falhas grosseiras** de vibe code como SQL injection, execucao de comandos,
segredos hardcoded no fonte de negocio ou vazamento de hash de senha. Porem, para **publicar e/ou
expor na internet**, os itens de criticidade **Alta e Media** (SSRF, log de credenciais, rate
limiting, CORS/cookie/headers e credencial padrao) precisam ser corrigidos. Para **uso estritamente
local e pessoal**, o risco e baixo — desde que o `.env` nunca va para o Git e a senha de admin seja
trocada.
