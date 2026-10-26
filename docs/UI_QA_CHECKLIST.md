# Checklist de QA de interface — BI Gerencial Seu Justino

Use antes de publicar mudanças visuais. Marque só o que foi realmente testado e diga o que não foi.

## Antes
- [ ] `git pull origin main --no-rebase --no-edit`.
- [ ] Guardar uma cópia do arquivo atual para comparar (antes e depois).

## Técnico
- [ ] Todos os `<script>` do HTML passam em `new Function(...)` (sintaxe).
- [ ] `publicar/index.html` idêntico a `BI_Gerencial_Seu_Justino_v2.html` (`cmp`).
- [ ] Varredura que clica em todos os botões, com servidor simulado: **0 exceções** (antes e depois).
- [ ] Posição de uma amostra de elementos (cartões, botões, tabelas) igual antes/depois quando a mudança não deveria alterar layout.
- [ ] Altura das abas: variação explicada (mudança de fonte ou doctype mudam a altura).
- [ ] Largura da página = largura da tela (sem rolagem horizontal) em 1440 px.

## Visual
- [ ] Capturas das abas alteradas (topo da página) comparadas com a versão anterior.
- [ ] Texto mínimo de 12 px; nada cortado ou sobreposto em tabelas e quadros.
- [ ] Contraste de qualquer cor nova calculado (≥ 4,5:1 para texto normal, ≥ 3:1 para texto grande e bordas de controles).
- [ ] Sem cor, tamanho ou raio novos fora das escalas do `DESIGN_SYSTEM.md`.

## Responsivo
- [ ] 1440, 1050, 900, 720 e 390 px. **Não testado até 26/10** (somente 1440 px).

## Teclado e acessibilidade
- [ ] Tab percorre botões e itens clicáveis, com foco visível; Enter e Espaço ativam.
- [ ] Popups: abrem com foco dentro, Esc fecha, foco volta ao botão de origem.
- [ ] Dicas aparecem também por foco.
- [ ] Botões só com ícone têm `aria-label`; tabelas novas têm `<thead>` (recebem `scope`).
- [ ] Leitor de tela real (NVDA/VoiceOver): **não testado**.

## Estados
- [ ] Vazio, carregando, erro e sucesso do quadro novo (sem dados do servidor, com leitura vazia, com dado "não lido").
- [ ] Botões com `loading`/`erro` quando chamam o servidor.

## Dados
- [ ] Nenhum dado pessoal de cliente na tela nem no código.
- [ ] Todo número mostra origem e data da leitura quando vem de robô ou API.

## Critério de aceite
Todos os itens aplicáveis marcados, limitações listadas na entrega, `git push origin main` (sem `--force`) e o Renato avisado do que publicar (`publicar` no Cloudflare, `Code.gs` no Apps Script e nova versão).
