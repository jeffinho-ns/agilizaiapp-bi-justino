# Design System — BI Gerencial Seu Justino

Estado em 26/10/2026. Fonte da verdade: o bloco `<style>` e o `:root` de `BI_Gerencial_Seu_Justino_v2.html`. Este documento descreve o que existe; não inventa padrões novos.

## Identidade
- Paleta derivada da logo do Seu Justino (couro `#5A331A`, verde do chapéu `#428540`), com o `--accent` laranja-couro clareado para fundo escuro. O verde fica **reservado para status saudável**: nunca usar como cor de ação.
- Tema: **somente escuro** (sem `prefers-color-scheme`). Tema claro é uma opção futura, não existe hoje.

## Tokens (`:root`)
| Grupo | Variáveis |
|---|---|
| Superfícies | `--bg #0d0b0a`, `--panel #1a1613`, `--panel2 #211c18`, `--line #332b24` |
| Texto | `--txt #f7f4f1`, `--muted #a39686` |
| Ação e status | `--accent #c96736` (= `--blue`), `--green #34d399`, `--yellow #f5b942`, `--red #f76e7c`, `--purple #a78bfa` |
| Tipografia (escala) | `--fs-xs 12`, `--fs-sm 13`, `--fs-md 14`, `--fs-lg 16`, `--fs-xl 20`, `--fs-2xl 26` (px) |
| Raios | `--radius-sm 6`, `--radius-md 10`, `--radius-lg 14`, `--radius-pill 999` (px) |
| Fontes | `--font-display` Space Grotesk, `--font-body` Plus Jakarta Sans |

Regra: código novo usa as escalas acima. Ainda existem valores soltos antigos (146 cores hex no CSS, 17 tamanhos de fonte, 10 raios, ~479 estilos inline); consolidar aos poucos, sem mudar o visual de uma vez.

## Tipografia
- Corpo 14 px. **Tamanho mínimo de texto: 12 px** (aprovado em 25/10; 89 textos de 9–11,5 px foram elevados).
- Células de tabela: 16 px, regra explícita `table{font-size:16px}`. O 16 px vinha do modo de compatibilidade do navegador e foi mantido ao adicionar o `doctype` para não mudar o visual. Cabeçalhos de tabela: 12 px.

## Contraste (calculado, WCAG)
Texto/painel 16,4:1 • apoio (`--muted`)/painel 6,2:1 • `--accent`/painel 4,69:1 (ok como texto) • verde 9,4 • amarelo 10,2 • vermelho 6,4 • roxo 6,6.
Texto branco sobre `--accent` (3,83:1) e sobre `--red` (2,81:1) **não passa**: botões de fundo colorido usam texto escuro (`#1f140c` sobre accent; `#2a0a0e` sobre vermelho). O botão comum (`.btn`) é escuro com texto branco.

## Componentes existentes (reutilizar antes de criar)
| Componente | Classe/estrutura | Observações |
|---|---|---|
| Cartão | `.card`, `.card.full`, `.kpi` | `data-card-id` + `data-sortable-grid` para reordenar |
| Quadro recolhível | `details.cardCollapse` | 110 no BI; `summary.cardCollapseHead` com `.chev` e `.chHint` |
| Botão | `.btn`, `.nav button` | estados: `.btn-loading` (amarelo, pulsa), `.btn-error-flash` (vermelho) |
| Aviso | `.alert` (+ `y`/`r`/`g`) | borda esquerda de 4 px na cor do status |
| Mini KPI | `.miniKpiGrid` / `.miniKpi` | |
| Tabela | `.tablewrap` (rolagem horizontal) | cabeçalhos ganham `scope="col"` por script |
| Selo | `.badge` | |
| Dicas | `.hasTip` + `.kpiTip` (KPI); `data-crmtip` + `#crmTipBox` (legendas didáticas) | também por foco de teclado |
| Popup | `.dicaOverlay` | vira `role="dialog"`, Esc fecha, foco entra e volta |
| Sub-abas | `.nav` dentro da aba | ex.: Marketing, Operação |

## Estados
Default, hover, foco (`:focus-visible`, contorno de 2 px na cor de ação, aplicado globalmente), disabled, loading (`.btn-loading`), erro (`.btn-error-flash`), vazio (`.alert y` com orientação do que fazer). Success: verde de status.

## Responsividade
Pontos de quebra existentes: **720, 900 e 1050 px**. Abaixo de 900 px a barra lateral vira coluna. Não testado em celular real (pendência no roadmap).

## Movimento
Uma animação (`btnPulse`). `prefers-reduced-motion` reduz animações e transições a quase zero.

## Acessibilidade (camada de script no fim do arquivo)
Ver `UI_QA_CHECKLIST.md`. Resumo: elementos clicáveis não nativos ganham `tabindex`/`role="button"` e ativam com Enter/Espaço; botões só com símbolo ganham `aria-label`; `nav`, `main` e 13 regiões nomeadas; títulos `h3`→nível 2 e `h4`→nível 3; link "Pular para o conteúdo".
