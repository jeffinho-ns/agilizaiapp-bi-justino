# Roadmap de experiência do produto — BI Gerencial Seu Justino

Estado em 26/10/2026. Prioridade: P0 crítico, P1 alto, P2 médio, P3 baixo.

## Concluído
- Acessibilidade passo 1 (teclado, popups, aria-label, scope, dicas por foco, reduzir movimento) — 25/10.
- Contraste dos botões IA e em erro; texto mínimo de 12 px; escalas de fonte e raio — 25/10.
- `nav`/`main`/regiões, link "Pular para o conteúdo", níveis de título; `doctype` e `lang` — 25/10.
- Largura da página igual à da tela (dica oculta dos KPIs cortada) — 26/10.
- Nota de atendimento geral 0–100% na Saúde do atendimento por IA — 26/10.
- Delivery por plataforma e sugestões da 99Food em Marketing — 24/10.

## Em aberto
| Prioridade | Item | Dependência / risco | Medida de sucesso |
|---|---|---|---|
| P1 | Testar o BI em celular (390–720 px) e com leitor de tela | precisa de dados reais e dispositivo | tarefas principais concluídas sem rolagem horizontal; leitor lê áreas e botões |
| P2 | Consolidar o legado: 146 cores soltas, 17 tamanhos de fonte, 10 raios, ~479 estilos inline | mudanças visuais pequenas; fazer por aba, com comparação antes/depois | contagem desses valores cai; nenhum novo fora das escalas |
| P2 | Decidir tabelas em 14 px ou 16 px | preferência do Renato; muda a densidade | decisão registrada em `DESIGN_DECISIONS.md` |
| P2 | Reposicionar a dica dos KPIs da última coluna para dentro da tela | só CSS/JS de posição | dica sempre visível por inteiro |
| P2 | Observar o uso real (quais abas, quanto tempo, onde erram) | exige coletar dados de uso ou entrevistar 3–5 usuários | lista de tarefas com taxa de sucesso e tempo |
| P3 | Tema claro opcional | exige revisar contraste de todas as cores | `prefers-color-scheme` ou botão de tema, com contraste conferido |
| P3 | Marcação do plano da 99Food compartilhada pela equipe | gravar no servidor | todos veem o mesmo andamento |
| P3 | Buscar função/quadro em todo o BI | 13 abas e 110 quadros recolhíveis podem dificultar achar algo (hipótese, não medida) | tempo para achar um quadro |

## Hipóteses a validar (não são fatos)
- 110 quadros recolhíveis e 13 abas aumentam o esforço de descoberta.
- O uso principal é em computador.
- A nota de atendimento ajuda a coordenadora a priorizar; medir se o plano de ação anda mais rápido depois dela.

## Próximas etapas sugeridas
1. Capturas e teste responsivo das 13 abas.
2. Consolidar tokens aba a aba, começando por Reservas e Marketing (as mais recentes).
3. Entrevista curta com 3 usuários (Renato, coordenadora de reservas, gestor de área) sobre as 3 tarefas mais frequentes.
