# Diretrizes de UX — BI Gerencial Seu Justino

Estado em 26/10/2026. Baseado no que foi pedido e observado no projeto; não há pesquisa formal com usuários (ver "Evidências").

## Quem usa (conhecido)
- **Renato** (sócio administrador, Grupo Ideia): visão geral, decisões, pede novos quadros e explicações.
- **Gestores e coordenadores de área** (reservas, marketing, operação, financeiro, RH): lançam o registro do dia e acompanham indicadores. O acesso é por área.
- **Equipe de salão e cozinha**: indiretamente (escala, reservas).
Não há perfil de usuário medido (frequência, dispositivo). Hipótese a validar: uso principal em computador, no escritório e no horário da operação.

## Jornada principal
1. Entrar (login) → aba da área (menu lateral, grupos recolhíveis).
2. **Registro do dia** (formulário) e/ou **indicadores** (cartões, quadros, tabelas).
3. Quadros recolhíveis para reduzir o ruído; sub-abas dentro de Marketing e Operação.

## Princípios aplicados
- **Dado honesto:** todo número mostra de onde vem e quando foi lido (ex.: "lido 25/10, 20:49"). Dado não lido aparece como "não lido" e fica fora de cálculos. Nunca estimar para preencher.
- **Explicar sem sair da tela:** legendas didáticas ao passar o mouse (e ao focar) em cabeçalhos e indicadores. Pedido do Renato; manter em tom simples ("o que é", "o que fazer").
- **Conclusão primeiro:** quadros trazem a nota ou o resumo no topo e o detalhe abaixo (ex.: nota de atendimento geral, depois os 14 itens).
- **Ação clara:** cada alerta indica a meta e o que fazer.
- **Progressive disclosure:** painéis secundários viram botões dentro do quadro (ex.: Saúde do atendimento e Plano de ação dentro de "Conversão e perdas").

## Padrões de interação
- Atualização: botão "↻ Atualizar tela" nos quadros que leem de robô ou API; o tempo de leitura aparece no selo do quadro.
- Envio de formulários: overlay de envio com estado (carregando, sucesso, erro) e botão com estado `loading`/`erro`.
- Popups: fecham com Esc ou clicando fora; foco volta ao botão de origem.
- Marcações pessoais (ex.: plano da 99Food) ficam no navegador de quem marcou; para marcação compartilhada, gravar no servidor.

## Prevenção e recuperação de erros
- O servidor recusa dados inconsistentes (ex.: venda por item muito diferente do faturamento) ou vazios (leitura do Dionísio sem dados) e mantém a última leitura boa.
- Dados suspeitos entram marcados "para conferir" e ficam fora dos cálculos.
- Falha de robô: arquivo de aviso na Área de Trabalho e mensagem no quadro explicando o que fazer.

## Critérios de usabilidade (a medir)
Tarefa concluída sem ajuda, tempo para lançar o registro do dia, erros por lançamento, uso do teclado nas ações principais. **Nenhum foi medido até agora.**

## Evidências disponíveis
Pedidos e dúvidas do Renato durante o desenvolvimento (ex.: dúvida sobre o termo "Visitas" levou a nova legenda). Sem testes de usabilidade, sem análise de uso. Recomendações de UX são heurísticas, não resultados de pesquisa.
