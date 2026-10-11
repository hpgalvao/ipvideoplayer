# Politica de Seguranca

## Dados sensiveis

Este projeto lida com credenciais do provedor de IPTV e com um token de sessao (`JWT_SECRET`).

- **Nunca** commite o arquivo `.env` nem variacoes (`/.env*`), exceto os arquivos de exemplo
  (`.env.example`, `.env.production.example`).
- **Nunca** commite o banco `data/catalog.sqlite` (conteudo do catalogo e possivelmente grande).
- Se voce publicar um repositorio por engano com o `.env`, **considere todas as credenciais
  vazadas** e troque-as imediatamente no provedor e no `JWT_SECRET`.

O `.gitignore` deste repositorio ja cobre esses casos. Confira antes de fazer `git push`:

```bash
git status --ignored
git ls-files | findstr /I ".env"   # Windows
git ls-files | grep -i "\.env"     # Linux/macOS
```

## Boas praticas recomendadas

- Defina um `JWT_SECRET` longo, aleatorio e exclusivo de producao.
- Troque a senha do administrador inicial (`admin@iptv` / `pwd01734`) apos o primeiro login.
- Restrinja o acesso a instancia em producao (HTTPS, firewall, proxy reverso).
- Mantenha Node.js e dependencias atualizados.

## Reportar uma vulnerabilidade

Se encontrar uma falha de seguranca, **nao** abra uma issue publica. Descreva o problema de forma
privada para o mantenedor:

- Repositorio: https://github.com/hpgalvao/ipvideoplayer
- Descreva: impacto, passos para reproduzir e possivel correcao.

Voce recebera retorno o mais breve possivel.

## Escopo

Este software e fornecido "como esta", sem garantias (ver [LICENSE](./LICENSE)) e destinado a uso
pessoal. O usuario e responsavel pelo conteudo acessado e pelo cumprimento das leis aplicaveis.
