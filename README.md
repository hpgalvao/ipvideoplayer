# IPTV Particular

Aplicacao web para uso pessoal que baixa uma playlist **M3U / Xtream Codes (XUI)** uma unica vez,
grava em um banco local **SQLite** e oferece uma interface de navegacao leve (canais ao vivo,
filmes e series) com player integrado (HLS/TS).

> Este projeto foi feito para uso pessoal. Voce e o unico responsavel pelo conteudo acessado e
> pelo cumprimento das leis da sua regiao.

---

## Sumario

- [Funcionalidades](#funcionalidades)
- [Stack](#stack)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Requisitos](#requisitos)
- [Instalacao](#instalacao)
- [Configuracao (.env)](#configuracao-env)
- [Como rodar](#como-rodar)
- [Docker](#docker)
- [Gestao de catalogos (Meus catalogos)](#gestao-de-catalogos-meus-catalogos)
- [Resiliencia de DNS e fallback de download](#resiliencia-de-dns-e-fallback-de-download)
- [API](#api)
- [Seguranca](#seguranca)
- [Contribuicao](#contribuicao)
- [Licenca](#licenca)

---

## Funcionalidades

- Sincronizacao unica da fonte (Xtream/XUI) para SQLite local, evitando reprocessar a M3U a cada acesso.
- Parser de M3U/`m3u_plus` para **TV ao vivo**, **filmes** e **series** (temporadas/episodios).
- Consulta paginada com busca e filtros (categoria, ano, genero) direto no banco local.
- Player integrado com suporte a **HLS (`.m3u8`)** e **TS**, com retomada de reproducao.
- Multi-usuario e multi-perfil com controle de faixa etaria.
- Favoritos, "assistir mais tarde", recomendações e historico por perfil.
- Biblioteca de avatares (publicos e privados por usuario).
- **Gestao de catalogos**: baixe e guarde varias listas M3U e use-as como fonte do sistema.
- **Fallback de download**: se uma forma de baixar a lista falhar, tenta automaticamente outras.
- **DNS resiliente**: contorna falhas de resolucao de nomes (comum em provedores IPTV).

## Stack

- **Frontend**: React 18 + Vite 5 + `hls.js` (`frontend/`)
- **Backend**: Node.js + Express (`server/`)
- **Banco**: SQLite via `sql.js`, arquivo em `data/catalog.sqlite`
- **Rede**: `node-fetch` com resolvedor DNS customizado
- **Persistencia no navegador**: favoritos, progresso, perfis e preferencias

## Estrutura do projeto

```
IPTV3/
├── server/                          # Backend Express
│   ├── index.js                     # Rotas da API, autenticacao, proxy de stream
│   ├── iptv-service.js              # Sync, parser M3U, consultas, fallback de download
│   ├── db.js                        # sql.js, schema e helpers
│   └── net.js                       # Resolucao DNS customizada / agentes HTTP
├── frontend/                        # App React + Vite
│   ├── src/App.jsx                  # Interface (telas, modais, player)
│   ├── src/style.css                # Tema
│   ├── index.html
│   └── vite.config.js
├── data/                            # Banco SQLite local (NAO versionado)
├── media/                           # Avatares (publicos e privados)
├── Dockerfile
├── docker-compose.traefik.example.yml
├── iniciar.cmd                      # Atalho de inicializacao no Windows
└── .env.example                     # Modelo de configuracao
```

## Requisitos

- **Node.js 18+** (recomendado 20 LTS) e npm
- Sistema operacional: Windows, Linux ou macOS
- Acesso de rede ao provedor da lista M3U

## Instalacao

Passo a passo detalhado (Windows, Linux/macOS e Docker) em **[INSTALL.md](./INSTALL.md)**.

Resumo:

```bash
git clone https://github.com/hpgalvao/ipvideoplayer.git
cd ipvideoplayer

# 1) dependencias
npm install
npm install --prefix frontend

# 2) configura ambiente
cp .env.example .env      # Windows: copy .env.example .env
# edite o .env com base URL, usuario e senha do provedor

# 3) desenvolvimento (backend + frontend)
npm run dev
```

No Windows, tambem da para dar duplo clique em **`iniciar.cmd`**, que instala as dependencias
(se necessario), cria o `.env` e sobe a aplicacao.

## Configuracao (.env)

Crie um arquivo `.env` na raiz (use `.env.example` como base):

| Variavel | Descricao | Exemplo |
| --- | --- | --- |
| `PORT` | Porta do backend | `8787` |
| `NODE_ENV` | Ambiente | `production` |
| `JWT_SECRET` | Segredo para assinar a sessao. **Troque em producao** | `troque-por-um-valor-longo-e-aleatorio` |
| `IPTV_BASE_URL` | URL base do provedor (sem barra final) | `http://seu-servidor-iptv` |
| `IPTV_USERNAME` | Usuario do provedor | `seu-usuario` |
| `IPTV_PASSWORD` | Senha do provedor | `sua-senha` |
| `IPTV_SOURCE` | *(opcional)* Fonte alternativa, tentada antes das demais. Aceita `xc://`, `get.php`, `xmltv.php` ou URL M3U | `xc://usuario:senha@host/streaming=ts` |
| `IPTV_DNS_SERVERS` | *(opcional)* Servidores DNS usados pelo resolvedor resiliente (separados por virgula/espaco/ponto-e-virgula) | `185.49.71.100,46.165.236.165` |
| `IPTV_DNS_TIMEOUT_MS` | *(opcional)* Timeout do DNS custom antes de cair para o DNS do sistema | `5000` |
| `IPTV_FETCH_TIMEOUT_MS` | *(opcional)* Timeout padrao das requisicoes do catalogo | `180000` |
| `IPTV_CATALOG_TIMEOUT_MS` | *(opcional)* Timeout por tentativa no download de lista | `90000` |
| `IPTV_CATALOG_TOTAL_TIMEOUT_MS` | *(opcional)* Limite total de tentativas no download de lista | `360000` |
| `CORS_ORIGINS` | *(opcional)* Origens permitidas no CORS, separadas por virgula. Por padrao so origens locais de dev e same-origin | `https://iptv.seudominio.com` |
| `TRUST_PROXY` | *(opcional)* Habilite atras de proxy reverso confiavel (Traefik/Nginx) para IP/HTTPS corretos | `1` |
| `SECURITY_HEADERS_DISABLED` | *(opcional)* Desativa CSP/HSTS/etc. em caso de emergencia | `1` |

### Credencial inicial

Na primeira execucao (banco vazio) o sistema cria um administrador:

- **Usuario**: `admin@iptv`
- **Senha**: `pwd01734`

> Troque essa senha apos o primeiro login.

## Como rodar

### Desenvolvimento

```bash
npm run dev
```

- Frontend (Vite): http://localhost:5173
- Backend/API: http://localhost:8787

Durante o desenvolvimento o Vite faz proxy de `/api` para o backend.

### Producao

```bash
npm run build   # gera frontend/dist
npm start       # backend serve a API e o frontend compilado
```

Acesse http://localhost:8787.

### Scripts disponiveis

| Script | O que faz |
| --- | --- |
| `npm run dev` | Sobe backend e frontend em paralelo |
| `npm run server` | Sobe apenas o backend |
| `npm run client` | Sobe apenas o frontend (Vite) |
| `npm run build` | Compila o frontend para `frontend/dist` |
| `npm start` | Sobe o backend em modo producao |

## Docker

```bash
docker build -t iptv-app .
docker run -d \
  --name iptv-app \
  -p 8787:8787 \
  --env-file .env \
  -v iptv_data:/app/data \
  iptv-app
```

Exemplo de stack com Traefik em [`docker-compose.traefik.example.yml`](./docker-compose.traefik.example.yml)
(junto de `.env.production.example`).

> O banco fica em `data/catalog.sqlite`. Monte esse diretorio como volume para manter o catalogo
> entre reinicios.

## Gestao de catalogos (Meus catalogos)

Em **Configuracoes → Meus catalogos** (somente administrador) e possivel:

- Baixar e guardar **varias listas M3U**;
- Informar **Base URL + usuario + senha** (as mesmas do sistema por padrao) **ou** colar um link:
  - `xc://usuario:senha@host/streaming=ts` (convertido para `get.php`);
  - `http://host/xmltv.php?username=..&password=..` (EPG -> derivado para a lista);
  - `http://host/get.php?...` ou uma URL `.m3u`/`.m3u8`;
- Ver o status de cada lista (pronta / baixando / falha) e usar **Tentar novamente** / **Remover**.

O botao **Ressincronizar catalogo** (Configuracoes) monta uma fila de fontes e tenta na ordem:
`IPTV_SOURCE` -> provedor do `.env` -> listas salvas em Meus catalogos. A primeira que responder
com itens vence.

## Resiliencia de DNS e fallback de download

- **DNS**: `dns.setServers()` afeta apenas o resolvedor `c-ares`, enquanto `fetch`/`http` usam
  `dns.lookup` (DNS do sistema). Por isso o projeto injeta um `lookup` customizado nos agents que
  resolve pelos servidores de `IPTV_DNS_SERVERS`, com **timeout** e **fallback** para o DNS do
  sistema. Tambem prioriza IPv4 (`ipv4first`), comum em provedores com IPv6 quebrado.
- **Download**: cada lista e tentada em varias formas (`output=ts`/`m3u8`, `type=m3u_plus`/`m3u`,
  `http`/`https`) e com dois User-Agents (app e navegador). A que funcionar fica salva para o
  proximo uso.

## API

Todas as rotas (exceto `login` e `health`) exigem sessao autenticada (cookie `iptv_auth`). Rotas
marcadas como *admin* exigem usuario do tipo administrador.

**Autenticacao**

- `POST /api/auth/login` — login
- `POST /api/auth/logout` | `GET /api/auth/me`

**Catalogo**

| Metodo | Rota | Descricao |
| --- | --- | --- |
| GET | `/api/catalog/status` | Status e contagens do catalogo |
| POST | `/api/catalog/sync` | (admin) Ressincroniza o catalogo |
| POST `/api/catalog` | *admin* | Importa/sincroniza o catalogo |
| POST | `/api/catalog/query` | Consulta paginada com filtros |
| POST | `/api/catalog/exists-ids` | Valida IDs favoritos/marcados |
| GET | `/api/catalogs` | Lista as listas salvas (admin) |
| GET | `/api/catalogs/provider` | Provedor configurado (admin) |
| POST | `/api/catalogs` | Baixa/adiciona uma lista (admin) |
| POST | `/api/catalogs/:id/retry` | Tenta baixar novamente (admin) |
| DELETE | `/api/catalogs/:id` | Remove uma lista (admin) |

Outras rotas: `GET /api/series/:seriesKey`, `POST /api/stream-url`, `GET /api/stream-proxy`,
`GET /api/cast-lookup`, perfis (`/api/profiles`), usuarios (`/api/users`, admin),
avatares (`/api/avatars`), `GET /api/health`.

## Seguranca

- **Nunca** versione o arquivo `.env`: ele contem usuario/senha do provedor e o `JWT_SECRET`.
  O `.gitignore` do projeto ja ignora `.env` e `.env.*` (exceto os `*.example`).
- O banco `data/catalog.sqlite` e gerado localmente e **nao** deve ser versionado (pode ser grande).
- Troque a senha do administrador inicial e defina um `JWT_SECRET` proprio em producao.

Consulte [SECURITY.md](./SECURITY.md).

## Contribuicao

Sugestoes e correcoes sao bem-vindas. Veja [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licenca

Distribuido sob a licenca **MIT**. Veja [LICENSE](./LICENSE).
