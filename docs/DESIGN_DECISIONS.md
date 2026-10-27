# Registro de decisões de design — BI Gerencial Seu Justino

Formato: data • decisão • motivo • alternativa considerada • status. Mais recente primeiro.

| Data | Decisão | Motivo | Alternativas | Status |
|---|---|---|---|---|
| 27/10 | O formulário "Criar ou redefinir acesso ao BI" passa do quadro de elegibilidade do bônus para **dentro do quadro "Acessos cadastrados"** (formulário no topo, lista abaixo) | Pedido do Renato: criar e ver os acessos no mesmo lugar | Manter separado | Implementado; mesmos ids e regras, só muda a posição |
| 26/10 | **Nota de atendimento geral (0–100%)** no quadro Saúde do atendimento por IA. Verde 1, amarelo 0,5, vermelho 0; pesos: IA no WhatsApp 3; regras, follow-up, chamar humano e atendimentos travados 2; demais 1. Itens "não lido" fora da conta; abaixo de 10 itens lidos a nota é "provisória". Também aparece no botão do quadro | Pedido do Renato; resumir 14 itens em um número acompanhável | Peso igual para todos (esconderia o risco da IA desligada) | **Aprovado e implementado**. Os pesos são critério do BI, ajustáveis em `CRM_NOTA_PESOS` |
| 26/10 | `body{overflow-x:clip}` | Dica escondida dos KPIs (`.kpiTip`, 280 px) alargava a página em 34 px em Diretoria, Marketing e Financeiro | Reposicionar a dica na borda direita | Implementado; reposicionar dica é melhoria futura |
| 26/10 | Leitura vazia do Dionísio é ignorada no BI, recusada no servidor e não enviada pelo robô | Uma leitura sem conexão zerava o quadro de saúde | — | Implementado |
| 25/10 | `doctype` + `lang="pt-BR"`; `table{font-size:16px}` | Sair do modo de compatibilidade sem mudar o visual (tabelas iriam de 16 para 14 px) | Aceitar 14 px nas tabelas (mais compacto) | Implementado; **tabelas em 16 px mantidas**. Decisão de reduzir a 14 px fica em aberto |
| 25/10 | `nav`, `main`, regiões por aba, link "Pular para o conteúdo", `aria-level` nos títulos | Auditoria UX: sem áreas de página e títulos pulando de 1 para 3 | Trocar as tags (mudaria o layout) | Implementado só por atributos |
| 25/10 | Texto mínimo de 12 px (89 trocas); escalas `--fs-*` e `--radius-*` | Legibilidade; evitar novos valores soltos | Consolidar tudo já (risco visual) | Implementado; consolidação do legado pendente |
| 25/10 | Texto escuro nos botões IA e em erro | Contraste medido 3,83/2,72/2,81:1 | Escurecer o fundo (quebraria o texto laranja) | Implementado |
| 25/10 | Camada de acessibilidade por script (teclado, popups, aria-label, scope) | Auditoria UX; zero mudança visual | Reescrever o HTML | Implementado e testado em Chrome com dados simulados |
| 24/10 | Sub-aba "🛵 Delivery" em Marketing, com quadro de sugestões da 99Food e plano marcável | Pedido do Renato | Card solto na aba | Implementado |
| 23/10 | Saúde do atendimento e Plano de ação viram **botões dentro de "Conversão e perdas"** | Pedido do Renato | Cartões separados | Implementado |
| 23/10 | Legendas didáticas ao passar o mouse em cada quadro de Conversão e perdas | Pedido do Renato | Texto fixo | Implementado |

## Pendências de decisão
- Tabelas em 14 px ou 16 px (hoje 16 px).
- Reposicionar a dica dos KPIs da última coluna para dentro da tela.
- Tema claro opcional.
- Marcação do plano da 99Food: manter local ou gravar no servidor para a equipe toda.
