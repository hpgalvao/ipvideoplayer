# Changelog

Todas as mudancas relevantes deste projeto sao documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o projeto adere ao [Versionamento Semantico](https://semver.org/lang/pt-BR/).

## [0.1.0] - 2026-10-11

### Adicionado

- Sincronizacao de fonte Xtream/XUI (`m3u_plus`) para SQLite local com consulta paginada e filtros.
- Player integrado com suporte a HLS (`.m3u8`) e TS, com retomada de reproducao.
- Autenticacao multiusuario, multiplos perfis e controle de faixa etaria.
- Favoritos, "assistir mais tarde", recomendacoes e historico por perfil.
- Biblioteca de avatares (publicos e privados por usuario).
- Tela **Meus catalogos**: baixar/gerenciar varias listas M3U e escolher a fonte do sistema.
- Fallback de download (varias URLs e User-Agents) e resiliencia de DNS com timeout/fallback.
- Suporte a links `xc://`, `get.php`, `xmltv.php` e URLs M3U/M3U8.
- Suporte a Docker e stack de exemplo com Traefik.
- Documentacao: README, manual de instalacao, contribuicao e seguranca.
