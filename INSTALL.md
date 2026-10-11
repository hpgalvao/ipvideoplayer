# Manual de Instalacao

Guia passo a passo para rodar o **IPTV Particular** em desenvolvimento e producao.

## Sumario

- [Pre-requisitos](#pre-requisitos)
- [1. Obter o codigo](#1-obter-o-codigo)
- [2. Instalar dependencias](#2-instalar-dependencias)
- [3. Configurar o ambiente (.env)](#3-configurar-o-ambiente-env)
- [4. Rodar em desenvolvimento](#4-rodar-em-desenvolvimento)
- [5. Rodar em producao](#5-rodar-em-producao)
- [6. Windows: usar o iniciar.cmd](#6-windows-usar-o-iniciarcmd)
- [7. Docker](#7-docker)
- [8. Primeiro acesso](#8-primeiro-acesso)
- [Solucao de problemas](#solucao-de-problemas)

---

## Pre-requisitos

- **Node.js 18+** (recomendado 20 LTS) — https://nodejs.org
- **npm** (vem com o Node)
- **Git** (para clonar o repositorio)
- Acesso de rede ao provedor da lista M3U (URL, usuario e senha)

Verifique a instalacao:

```bash
node -v
npm -v
```

## 1. Obter o codigo

```bash
git clone https://github.com/hpgalvao/ipvideoplayer.git
cd ipvideoplayer
```

Ou baixe o ZIP pelo GitHub e extraia.

## 2. Instalar dependencias

Instale as dependencias do backend (raiz) e do frontend:

```bash
npm install
npm install --prefix frontend
```

> O frontend tem um `package.json` proprio dentro de `frontend/`.

## 3. Configurar o ambiente (.env)

Copie o arquivo de exemplo e edite com seus dados:

**Linux/macOS**

```bash
cp .env.example .env
```

**Windows (PowerShell)**

```powershell
Copy-Item .env.example .env
```

**Windows (CMD)**

```bat
copy .env.example .env
```

Abra o `.env` e preencha:

```env
NODE_ENV=production
PORT=8787
JWT_SECRET=troque-por-um-valor-longo-e-aleatorio

# Provedor (Xtream/XUI)
IPTV_BASE_URL=http://seu-servidor-iptv
IPTV_USERNAME=seu-usuario
IPTV_PASSWORD=sua-senha

# Opcional: fonte alternativa (tentada antes das demais).
# Aceita xc://, get.php, xmltv.php ou URL M3U.
# IPTV_SOURCE=xc://usuario:senha@host/streaming=ts

# Opcional: DNS customizado (ajuda quando o DNS da operadora falha).
IPTV_DNS_SERVERS=185.49.71.100,46.165.236.165
```

Observacoes:

- `IPTV_BASE_URL` **sem** barra no final.
- Gere um `JWT_SECRET` proprio, por exemplo:
  - Linux/macOS: `openssl rand -hex 32`
  - PowerShell: `-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })`

## 4. Rodar em desenvolvimento

```bash
npm run dev
```

- Frontend (Vite): http://localhost:5173
- Backend/API: http://localhost:8787

O backend e o frontend sobem juntos (via `concurrently`). Na primeira vez, o catalogo e baixado
e gravado em `data/catalog.sqlite` (pode demorar; as proximas aberturas ficam leves).

## 5. Rodar em producao

```bash
npm run build   # compila o frontend em frontend/dist
npm start       # backend serve a API + o frontend compilado na porta 8787
```

Acesse http://localhost:8787.

## 6. Windows: usar o iniciar.cmd

Na raiz do projeto, de duplo clique em **`iniciar.cmd`**. O script:

1. Verifica se o Node esta instalado;
2. Cria o `.env` (a partir de `.env.development` ou `.env.example`) se ainda nao existir;
3. Instala as dependencias que faltarem;
4. Sobe a aplicacao com `npm run dev`.

Para encerrar, pressione `CTRL+C` na janela.

## 7. Docker

Build e execucao:

```bash
docker build -t iptv-app .
docker run -d \
  --name iptv-app \
  -p 8787:8787 \
  --env-file .env \
  -v iptv_data:/app/data \
  iptv-app
```

- `--env-file .env` injeta as variaveis de ambiente.
- `-v iptv_data:/app/data` persiste o banco SQLite entre reinicios.

Com `docker compose` (Traefik), use como base
[`docker-compose.traefik.example.yml`](./docker-compose.traefik.example.yml):

```bash
docker compose -f docker-compose.traefik.example.yml --profile PROD up -d --build
```

## 8. Primeiro acesso

- Acesse http://localhost:8787 (producao) ou http://localhost:5173 (desenvolvimento).
- Na primeira execucao e criado um administrador:
  - **Usuario**: `admin@iptv`
  - **Senha**: `pwd01734`
- **Troque a senha** logo no primeiro acesso e crie seus perfis.
- Se o catalogo estiver vazio, use **Configuracoes → Ressincronizar catalogo** (administrador).

## Solucao de problemas

**Erro de DNS / `ENOTFOUND` ao sincronizar**
- O DNS da operadora pode falhar para o host do provedor. Defina `IPTV_DNS_SERVERS` no `.env`
  (separados por virgula). O app tenta esses servidores e, se nao responderem, cai para o DNS do
  sistema automaticamente.
- Se o dominio do provedor nao existir mais (removido/suspenso), nenhum DNS resolve. Peca a URL
  nova ao provedor e atualize `IPTV_BASE_URL` (ou use `IPTV_SOURCE` / **Meus catalogos**).

**A sincronizacao falha mas o link funciona no navegador**
- Use **Configuracoes → Meus catalogos** e cole o link (`xc://`, `get.php`, `xmltv.php` ou `.m3u`).
  O download tenta varias formas automaticamente.
- Em ultimo caso, defina `IPTV_SOURCE` no `.env` com esse mesmo link.

**Porta 8787 ja esta em uso**
- Altere `PORT` no `.env` (ex.: `PORT=8790`). Em desenvolvimento, ajuste tambem o `proxy` em
  `frontend/vite.config.js`.

**Banco muito grande / quer recomecar**
- Pare o servidor e remova `data/catalog.sqlite`; na proxima abertura o catalogo e baixado de novo.
  (Isso apaga o cache local; nada no provedor e alterado.)

**"O servidor nao esta respondendo como API"**
- Verifique se o backend esta rodando na porta 8787 antes de acessar o frontend.
