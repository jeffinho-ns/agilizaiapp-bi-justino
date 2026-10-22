# Cache de borda do BI (Cloudflare Worker + KV)

Entrega as leituras da abertura do painel em centenas de milissegundos, em vez de esperar o Apps Script (3 a 20 s).
**Só leitura**: login, envios e qualquer gravação continuam passando pelo Apps Script. O site em si continua sendo publicado como sempre
(este Worker é um projeto separado, `bi-edge`).

## Como funciona
1. A cada 3 minutos o Worker entra no Apps Script com a conta de serviço do robô, roda o `bootstrap` (as ~33 leituras) e guarda o resultado no KV.
2. O painel, depois do login, pede um **passe** ao Apps Script (`getEdgePass`; só Diretoria/dono) e guarda por 7 dias.
3. Com o passe, o painel pede o retrato ao Worker, desenha na hora e, em seguida, busca o dado novo no Apps Script como já fazia.

Segurança: sem passe válido o Worker não entrega nada; o passe é assinado com o `EDGE_SECRET` (que só o Apps Script e o Worker conhecem); só os
endereços de `ALLOWED_ORIGINS` conseguem ler pelo navegador. Os dados ficam no KV da sua conta Cloudflare.

## Passo a passo (pelo painel do Cloudflare, sem linha de comando)
1. **Armazenamento e bancos de dados › KV › Create** → nome `bi-snapshot`.
2. **Workers e Pages › Create › Workers › Hello World** → nome **`bi-edge`** → Deploy → **Edit code** → apague tudo, cole o conteúdo de `worker.js` → Deploy.
3. No Worker `bi-edge` › **Settings › Bindings › Add › KV namespace**: variável **`SNAP`**, namespace `bi-snapshot`.
4. **Settings › Variables and Secrets**:
   - texto: `APPS_SCRIPT_URL` = o endereço do seu Apps Script (o mesmo do painel);
   - texto: `ALLOWED_ORIGINS` = `https://solitary-feather-1fde.grupoideiaum1.workers.dev` (vários, separados por vírgula);
   - segredo: `EDGE_SECRET` = o texto do arquivo `C:\Users\renap\.seujustino\edge_secret.txt`;
   - segredo: `ROBOT_EMAIL` e `ROBOT_PASSWORD` = os campos `bi.email` e `bi.password` de `C:\Users\renap\.seujustino\zigpay_credentials.json`.
5. **Settings › Triggers › Cron Triggers › Add** → `*/3 * * * *`.
6. No **Apps Script › Configurações do projeto › Propriedades do script**: crie `EDGE_SECRET` com **o mesmo texto**. Cole o `Code.gs` novo e faça nova implantação.
7. Publique a pasta `publicar` como sempre.
8. Teste: abra `https://bi-edge.grupoideiaum1.workers.dev/status` — deve mostrar `temRetrato: true` em até 3 minutos.

Se o Worker tiver outro nome/endereço, ajuste `EDGE_URL` no `publicar/index.html` (busque por `EDGE_URL`).

## Limites e cuidados
- Plano gratuito do KV: 1.000 gravações/dia. Este Worker grava ~480 por dia (uma a cada 3 min). Se passar disso, aumente o intervalo do cron.
- O retrato é feito com a conta do robô (acesso de Diretoria); por isso só é entregue a quem tem passe de dono/Diretoria. Os demais usuários seguem pelo caminho de sempre.
- Para trocar o `EDGE_SECRET`: mude nos dois lugares (Worker e Apps Script); os passes antigos deixam de valer e o painel pede outro sozinho.
