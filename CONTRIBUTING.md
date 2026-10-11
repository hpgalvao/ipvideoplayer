# Contribuindo

Obrigado pelo interesse em contribuir! Este e um projeto pessoal, mas sugestoes e correcoes sao
muito bem-vindas.

## Como contribuir

1. Faca um **fork** do repositorio.
2. Crie uma branch descritiva: `git checkout -b feat/minha-feature` ou `fix/meu-bug`.
3. Faca suas alteracoes e teste localmente.
4. Mantenha os commits pequenos e com mensagens claras.
5. Abra um **Pull Request** explicando o que mudou e o por que.

## Padroes do projeto

- **Idioma**: textos de interface e documentacao em portugues (pt-BR).
- **Estilo de codigo**: siga o padrao existente (sem ponto e virgula obrigatorio, 2 espacos de
  indentacao, nomes em ingles para variaveis/funcoes no backend).
- **Nao adicione comentarios** desnecessarios ao codigo.
- Preserve o comportamento atual das telas e do banco.

## Antes de abrir o PR

- Rode a aplicacao em desenvolvimento: `npm run dev`.
- Garanta que o build do frontend passa:

  ```bash
  npm run build
  ```

- Nao commite segredos: `.env`, `.env.*` (exceto os `*.example`) e `data/*.sqlite` ja estao no
  `.gitignore`. Nunca force o commit desses arquivos.

## Reportar problemas

Ao abrir uma issue, inclua:

- Passos para reproduzir;
- Comportamento esperado x observado;
- Versao do Node (`node -v`) e sistema operacional;
- Trechos de log relevantes **sem** dados sensiveis (usuario, senha, URLs privadas).

Para vulnerabilidades, veja [SECURITY.md](./SECURITY.md).
