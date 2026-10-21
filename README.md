# BI do Seu Justino

Painel do Seu Justino. O site continua em HTML, CSS e JavaScript. Os dados vão passar a sair do banco no Render, no lugar do Google Sheets, para o painel abrir rápido.

Quem edita o visual continua fazendo isso na própria máquina e enviando por aqui.

## O que copiar na primeira vez

Copie a **pasta inteira** do BI que hoje sobe no Cloudflare. Não escolha arquivo por arquivo.

Inclua:

- todos os `.html`
- todos os `.css`
- todos os `.js`
- imagens, fontes e ícones
- `_headers`, `_redirects` ou `wrangler.toml`, se existirem

Se o seu `index.html` já existir, ele substitui o desta pasta.

O Google Apps Script **não está** nessa pasta. Ele fica no Google e é o código que lê a planilha. Sem ele a gente vê o endereço da chamada, mas não vê como a planilha está organizada.

Para enviar o Apps Script:

1. Abra [script.google.com](https://script.google.com) e entre no projeto do BI.
2. Em cada arquivo `.gs`, copie o conteúdo.
3. Cole em arquivos dentro da pasta `apps-script/` deste repositório, com o mesmo nome.

## Como enviar uma alteração pelo VSCode

1. Abra esta pasta no VSCode: **Arquivo → Abrir pasta**.
2. Edite o HTML, o CSS ou o JavaScript como já faz hoje.
3. Clique no ícone de ramificação na barra esquerda (**Controle do Código-Fonte**).
4. Em **Mensagem**, escreva uma frase curta. Exemplo: `ajuste no gráfico de WhatsApp`.
5. Clique em **Commit**.
6. Clique em **Sincronizar alterações** (ou **Push**).

O Cloudflare publica sozinho depois do push. Não apague este `README.md` nem o `.gitignore`. Não envie arquivo `.env` nem senha.
