/**
 * Backend do BI Gerencial Seu Justino — Google Apps Script + Google Sheets.
 * Substitui o claude.use('db') / claude.use('user') do Artifact para o BI
 * rodar em qualquer navegador comum, fora do claude.ai.
 *
 * SETUP (uma vez só):
 * 1. Crie uma planilha Google Sheets nova (pode ficar em branco — as abas
 *    e cabeçalhos são criados sozinhos na primeira chamada).
 * 2. Extensões → Apps Script, apague o conteúdo padrão e cole este arquivo.
 * 3. Na barra de funções do editor, selecione "setupAdmin", clique em
 *    "Executar" uma vez para criar o primeiro administrador (edite o
 *    e-mail/senha nos parâmetros da função abaixo antes de rodar, ou rode
 *    pelo console: setupAdmin("seu@email.com","suaSenha")).
 * 4. Implantar → Nova implantação → tipo "App da Web".
 *    Executar como: Eu. Quem pode acessar: Qualquer pessoa.
 * 5. Copie a URL do App da Web (termina em /exec) e cole em
 *    APPS_SCRIPT_URL no BI_Gerencial_Seu_Justino_v2.html.
 *
 * LEITURA DE MEDIDORES POR FOTO (OCR) — setup adicional, uma vez só:
 * 6. No editor do Apps Script: Configurações do projeto (ícone de engrenagem) →
 *    marque "Mostrar arquivo de manifesto appsscript.json na barra lateral".
 *    Cole o conteúdo de apps-script/appsscript.json no arquivo que aparecer.
 * 7. Anote o "Número do projeto Google Cloud" que aparece nessa mesma tela de
 *    Configurações → abra console.cloud.google.com, selecione esse projeto e
 *    em "APIs e serviços" ative a "Cloud Vision API" (tem cota gratuita mensal,
 *    3 fotos/dia fica bem dentro dela).
 * 8. Rode o script de novo uma vez (qualquer função) pra ele pedir autorização
 *    dos novos escopos (Drive + Cloud Vision) — aceite quando o Google perguntar.
 *    Não precisa guardar nenhuma chave de API: o OCR usa a própria identidade
 *    do script (ScriptApp.getOAuthToken()).
 *
 * ROBÔ DE FATURAMENTO (ZigPay) — setup adicional, uma vez só:
 * 9. Crie uma conta só pro robô (não é a sua conta pessoal): pelo console de
 *    execução do Apps Script, rode addAccount_("robo-zigpay@seujustino.local",
 *    "SENHA-GERADA-PARA-O-ROBO") — essa senha (dessa conta do BI, diferente da
 *    senha da ZigPay) vai pro arquivo local do robô, nunca pro vault.
 *
 * MANUAL OPERACIONAL (aba "Manual") — setup adicional, uma vez só:
 * 10. No Drive, na mesma pasta desta planilha, crie (ou deixe o script criar
 *     sozinho na primeira abertura da aba Manual) uma pasta chamada
 *     "Manual Operacional — Seu Justino BI" e arraste o PDF do manual pra
 *     dentro dela. Essa pasta não precisa — e não deve — ser compartilhada
 *     com ninguém: o app lê o arquivo com a identidade de quem implantou o
 *     script e só entrega os bytes pra quem já está logado no BI.
 * 11. Pra dúvidas enviadas pela aba Manual chegarem por e-mail a quem
 *     responde, rode uma vez no console do Apps Script, por área (ver
 *     comentário de setManualDestinatarios_ mais abaixo):
 *       setManualDestinatarios_('rh', 'email@dominio.com')
 *       setManualDestinatarios_('gestores', 'email1@dominio.com,email2@dominio.com')
 *       setManualDestinatarios_('diretoria', 'email@dominio.com')
 *
 * ALERTA DE SAÚDE DO ROBÔ ZIGPAY (avisa por e-mail se o faturamento de ontem não
 * foi gravado até as 10h) — setup adicional, uma vez só:
 * 12. Rode uma vez no console do Apps Script, com o e-mail que deve receber o
 *     alerta: setupDailyHealthCheckTrigger_('voce@dominio.com'). Aceite a
 *     autorização de envio de e-mail quando o Google perguntar.
 */

const AREAS = ['marketing','financeiro','rh','operacao','cmv'];
const ENTRIES_HEADERS  = ['area','date','valuesJson','notesJson','submittedByName','submittedAt'];
const MKPLANS_HEADERS  = ['date','trafficPlan','otherPlan','attractionsPlan','publicPlan','ticketPlan','revenuePlan','note','updatedAt','updatedBy'];
const SALARIES_HEADERS = ['role','name','admissionDate','baseSalary'];
const USERS_HEADERS    = ['email','salt','passwordHash','createdAt','role','areas'];
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// 03/10 — ordem de quadros arrastada por cada usuário (preferência pessoal de
// visualização, ligada ao login — não afeta outros usuários). Linha por (email,area),
// mesmo padrão de upsert-por-chave-composta já usado em MkPlans/Entries/MonthClosures —
// evita que salvar uma área sobrescreva, por write desatualizado, a ordem de outra área
// do mesmo usuário. 'area' aqui é o valor de data-sortable-grid do HTML, não data-tab —
// algumas abas (marketing, rh) têm mais de uma zona reordenável (sub-views por sub-nav).
const USER_LAYOUTS_HEADERS = ['email', 'area', 'cardOrderJson', 'updatedAt'];
// Lista mantida à mão — se um data-sortable-grid novo for criado no HTML, precisa
// entrar aqui também, senão saveCardOrder_/resetCardOrder_ falham com invalid_area.
const LAYOUT_GRID_IDS = [
  'master', 'marketing', 'marketing-daily', 'marketing-plan', 'marketing-demandas', 'marketing-graficos', 'marketing-insights', 'marketing-instagram', 'financeiro', 'rh', 'rh-daily', 'rh-colab',
  'operacao', 'operacao-registro', 'operacao-indicadores', 'operacao-escala', 'operacao-medidores', 'operacao-fechamento', 'cmv', 'reservas', 'eventos', 'documentos', 'auditoria', 'auditoriaop', 'manual', 'contatos'
];

// Abas restringíveis por usuário. 'master' (Diretoria) enxerga tudo, mesmo sem
// as outras áreas marcadas — faz sentido pra quem tem visão geral do negócio.
// zigrevenue/cmvteorico (dados alimentados pelo robô) não são restritos por
// área de propósito, pra não quebrar a automação.
const TAB_AREAS = ['master', 'marketing', 'financeiro', 'rh', 'operacao', 'cmv', 'reservas', 'eventos', 'documentos', 'auditoria', 'auditoriaop'];

// Reservas — lançamento POR RESERVA (não mais um total digitado por dia). O quadro
// geral da semana (pax + contagem por tipo) é somado sozinho a partir daqui, e
// alimenta a sugestão automática de freelancer por setor no Gerente Operador. Fica
// fora de AREAS de propósito: não tem meta de custo/bônus, é insumo de outro cálculo.
const RESERVATION_ENTRY_HEADERS = ['id', 'date', 'pax', 'tipo', 'nomeCliente', 'telefone', 'email', 'observacao', 'submittedByName', 'submittedAt', 'convidados', 'clientRequestId', 'origem', 'ativacaoId', 'hora'];
// 23/10: horário previsto de chegada (opcional), pra o BI saber quantas pessoas estão reservadas em cada hora (escala dos freelancers).
function normHora_(v) { const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})/); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '' }
// 21/10: de onde veio a reserva (pra medir o retorno do Instagram). Vazio = não informado.
const RESERVATION_ORIGENS = ['instagram', 'whatsapp', 'indicacao', 'google', 'porta', 'outro'];
function normOrigem_(v) { v = String(v || '').trim(); return RESERVATION_ORIGENS.indexOf(v) >= 0 ? v : '' }
const RESERVATION_TIPOS = ['normal', 'happyHour', 'despedida', 'aniversario'];

// Fechamento mensal (Financeiro/RH) — só registra QUEM fechou e QUANDO. Não apaga
// nem move nenhum envio: "fechar o mês" só limpa o formulário de digitação pro mês
// novo (isso acontece no navegador, client-side); os envios já feitos continuam
// intactos e visíveis pelo filtro de mês do histórico.
const MONTH_CLOSURE_HEADERS = ['id', 'area', 'monthKey', 'closedByEmail', 'closedAt'];
// 'reservas' não está em AREAS (não usa a aba Entries genérica — tem sheet própria),
// por isso essa lista é separada, não um subconjunto de AREAS. 'eventos'/'auditoriaop'
// adicionadas 03/10 (auditoria de estrutura) — mesma trava nas respectivas save_/delete_.
const MONTH_CLOSURE_AREAS = ['financeiro', 'rh', 'marketing', 'operacao', 'reservas', 'eventos', 'auditoriaop'];

// Base de cálculo da escala (planilha "SJM - Escala"), usada pra sugerir quantos
// freelancers cada setor precisa. Validado contra os números reais da planilha:
// necessário = ceil(pax / atendimento por pessoa)
// mínimo = max(necessário, brigada padrão)  — brigada padrão garante gente mesmo
//          em dia fraco, é por isso que setor lotado de CLT ainda pede extra às
//          vezes: o mínimo de operação não é zero só porque o movimento é baixo.
// sugestão = max(0, mínimo - CLT presente no dia)  — CLT presente = CLT total menos
//          quem estiver de folga/férias/falta, informado manualmente por dia.
// Valores de partida só pra semear a planilha na primeira vez — depois disso quem
// manda é a aba "SectorBase" (editável pelo RH na tela, seção "Quadro mínimo por
// setor"). Fica fora de AREAS: não é lançamento diário, é parâmetro de cálculo.
const SECTOR_BASE_DEFAULTS = [
  { sector: 'salao', atendimentoPorPessoa: 45, clt: 4, brigadaPadrao: 4 },
  { sector: 'cumim', atendimentoPorPessoa: 90, clt: 2, brigadaPadrao: 1 },
  { sector: 'bar', atendimentoPorPessoa: 80, clt: 2, brigadaPadrao: 4 },
  { sector: 'cozinha', atendimentoPorPessoa: 60, clt: 4, brigadaPadrao: 4 },
  { sector: 'limpeza', atendimentoPorPessoa: 250, clt: 0, brigadaPadrao: 1 },
  { sector: 'seguranca', atendimentoPorPessoa: 75, clt: 0, brigadaPadrao: 1 },
  { sector: 'caixa', atendimentoPorPessoa: 110, clt: 2, brigadaPadrao: 2 },
  { sector: 'runner', atendimentoPorPessoa: 300, clt: 0, brigadaPadrao: 1 },
  { sector: 'manutencao', atendimentoPorPessoa: 400, clt: 0, brigadaPadrao: 1 },
  { sector: 'estoquista', atendimentoPorPessoa: 400, clt: 0, brigadaPadrao: 1 }
];
const SECTOR_BASE_HEADERS = ['sector', 'atendimentoPorPessoa', 'clt', 'brigadaPadrao', 'limiteBrigada']; // 23/10: limiteBrigada = máx. de pessoas do setor ao mesmo tempo (0 = sem limite)

// Quadro de colaboradores (RH) — o "CLT" do quadro mínimo por setor deixa de ser
// digitado à mão e passa a ser CONTADO daqui: colaborador ativo + contratação CLT +
// cargo == esse setor. Cargo fora dos 7 setores rastreados (ex.: Manutenção, Aux
// Mkt Jr) fica salvo como 'outro' com o título livre em cargoOutro, e não conta pra
// nenhum setor — só fica registrado pra folha de pagamento.
const EMPLOYEE_HEADERS = [
  'id', 'nome', 'cargo', 'cargoOutro', 'nivel', 'contratacao', 'mesReferencia',
  'salario', 'adSalarial', 'horasExtras', 'adicionalNoturno', 'fgts', 'inss', 'irrf',
  'salarioFamilia', 'quebra', 'vt', 'vr', 'ferias', 'decimoTerceiro', 'beneficios', 'valorTotal',
  'ativo', 'horarioSemanalJson', 'feriasInicio', 'feriasFim',
  // adicionadas no FINAL de propósito (mesma regra do freelancerNames) — não reordena
  // as colunas já existentes, pra não repetir o bug de coluna trocada já visto antes.
  'dataAdmissao', 'dataDesligamento', 'tipoDesligamento', 'desligamentoObs', 'valorRescisao',
  // 29/09: título/função específica (Chefe de Bar, Maitre etc.) — só rótulo, não mexe
  // no `cargo` (que continua sendo o setor de verdade, usado na contagem automática do
  // Quadro mínimo por setor). Validado contra FUNCAO_CARGO_VALORES no cliente antes de
  // enviar; aqui só guarda o que vier, sem setor nenhum atrelado — decisão do Renato,
  // 29/09: essas funções continuam contando pro setor de sempre (Bar/Cozinha/Caixa/
  // Salão), "Gerente" fica de fora de qualquer setor (mesmo tratamento de "Outro").
  'funcaoCargo'
];
// Valores aceitos em funcaoCargo — cada um já nasce ligado ao setor certo no cliente
// (buildEmployeeFuncaoCargoSelect), aqui é só documentação/referência.
const FUNCAO_CARGO_VALORES = ['chefeBar', 'subchefeBar', 'auxiliarBar', 'chefeCozinha', 'subchefeCozinha', 'auxiliarCozinha', 'chefeCaixa', 'maitre', 'chefeFila', 'gerente'];
// '' = ativo/não se aplica. Os outros 4 cobrem os motivos de desligamento pedidos.
const TIPO_DESLIGAMENTO = ['', 'pedidoDemissao', 'demissaoSemJustaCausa', 'demissaoJustaCausa', 'acordo'];

// Documentos de colaborador (rescisão, exame demissional, aviso prévio, acordo
// assinado etc.) — sheet própria (1 linha por arquivo), não uma coluna JSON no
// Employees, pra listar/apagar arquivo por arquivo sem reescrever a linha toda.
const EMPLOYEE_DOC_HEADERS = ['id', 'employeeId', 'fileName', 'url', 'uploadedByName', 'uploadedAt'];

// Leitura de medidores por foto (Gerente Operador) — OCR + alerta de variação.
const METER_TYPES = ['energia', 'agua', 'gas'];
const METER_HEADERS = ['date', 'meterType', 'value', 'deltaPct', 'alertFlag', 'photoUrl', 'ocrRaw', 'submittedByName', 'submittedAt'];
const METER_ALERT_THRESHOLD_PCT = 15;

// Faturamento diário capturado pelo robô da ZigPay — fica fora da área 'financeiro'
// de propósito: o Financeiro não digita mais esse número, só lê.
// 'publico' = clientes atendidos no dia, capturado à parte pelo robô (tela "Eventos"
// da ZigPay) — alimenta a sugestão de escala por histórico real de movimento, não só
// pelas reservas lançadas na mão (que não contam quem chega sem reserva).
const ZIGREVENUE_HEADERS = ['date', 'revenue', 'publico', 'source', 'capturedAt', 'servico'];

// CMV teórico PARCIAL capturado pelo robô da ZigPay, cruzando venda por item
// com o custo da ficha técnica do Everest — parcial porque só ~15% do
// faturamento tem ficha cadastrada (o resto o Márcio ainda lança na mão em
// cmvFoodTheo/cmvBevTheo, que continuam sendo a fonte oficial por enquanto).
const CMVTEORICO_HEADERS = [
  'date',
  'custoFoodTeorico', 'valorCobertoFood', 'valorTotalFood',
  'custoBevTeorico', 'valorCobertoBev', 'valorTotalBev',
  'valorTotalMisto', 'itensComFicha', 'itensSemFicha',
  'source', 'capturedAt'
];

// Manual Operacional (PDF protegido) + dúvidas roteadas por área.
const DUVIDA_AREAS = ['rh', 'gestores', 'diretoria'];
const DUVIDAS_HEADERS = ['id', 'createdAt', 'askedByEmail', 'area', 'question', 'status', 'answer', 'answeredByEmail', 'answeredAt'];

// Contatos de emergência (prestadores/fornecedores de confiança — elétrica,
// eletrodomésticos, chaveiro etc.) — não fica só dentro do PDF do manual (estático,
// difícil de atualizar); vira lista editável, visível pra qualquer um logado, sem
// restrição de área (mesmo padrão do Manual).
const CONTATO_EMERGENCIA_HEADERS = ['id', 'nome', 'categoria', 'telefone', 'observacao', 'ativo', 'createdByEmail', 'createdAt'];

// Log de auditoria de exclusões — todo delete (envio diário, projeção de
// marketing, acesso de usuário) fica registrado aqui: quem apagou, quando, e o
// que era, pra dado sensível apagado continuar rastreável.
const DELETIONS_HEADERS = ['id', 'deletedAt', 'deletedByEmail', 'kind', 'refDate', 'area', 'summary', 'payloadJson'];

// Auditoria geral (29/09, pedido do Renato: "trilha completa — criar + editar +
// apagar") — complementa o "Deletions" acima, que já cobria só apagar. logAudit_ é
// chamado do ROTEAMENTO (doPost), logo depois de cada ação mutável confirmar
// sucesso — nenhuma função de ação precisa saber de auditoria pra funcionar, e a
// lista do que é auditado fica visível num lugar só (o próprio doPost). Aba nova
// "Eventos/Documentações/Auditoria" só Diretoria enxerga (hasAreaAccess_ 'master').
const AUDIT_HEADERS = ['id', 'at', 'byEmail', 'action', 'area', 'kind', 'refId', 'summary', 'beforeJson', 'afterJson'];

// Evento privado/corporativo (festa fechada, casamento, corporativo — diferente
// da Reserva de mesa do dia a dia, que não tem contrato/valor/sinal).
const EVENTO_TIPOS = ['aniversario', 'casamento', 'formatura', 'corporativo', 'confraternizacao', 'outro'];
const EVENTO_STATUS = ['orcamento', 'confirmado', 'realizado', 'cancelado'];
// 02/10 — pedido do Renato: controle de follow-up comercial/gestão por evento,
// baseado nas colunas reais do CONTROLE EVENTOS.xlsx (planilha COW ME, só os
// eventos SJM). Texto livre curto (não enum fechado) porque a equipe comercial
// já escreve esses status do jeito dela ("ENVIADA", "AG INFO", "OK", "PAGO"...)
// — forçar dropdown engessaria o fluxo deles. Todos opcionais, no FINAL do
// array (convenção do projeto) pra não quebrar os eventos já cadastrados.
const EVENTO_FOLLOWUP_FIELDS = [
  // Negociação/contrato
  'responsavel', 'agente', 'promotor', 'ambiente', 'origemLead',
  'statusAdm', 'statusFormalizacao', 'statusDocInfo', 'statusContrato', 'statusAgenda',
  // Operacional
  'statusPagamento', 'statusTemposMovimentos', 'statusOs', 'statusEmailCompras',
  'statusLista', 'statusZig', 'statusExcedentes', 'atracao', 'producao',
  // Pós-evento / financeiro
  'paxPresente', 'statusNotaFiscal', 'feedback',
  'valorExcedente', 'valorProducao', 'valorTotal',
  'comissaoCowMe', 'comissaoTimeComercial', 'comissaoPorAnalista'
];
// 05/10, pedido do Renato: campo novo "Pagamento pendente" (checkbox simples, SÓ
// organizacional — não liga com o cálculo de faturamento, que continua usando só
// o campo de texto livre "Pagamento"/statusPagamento do follow-up). Adicionado no
// FINAL da lista de propósito: ensureSheet_ reescreve a linha de cabeçalho quando
// ela não bate com EVENTO_HEADERS, e como sheetToObjects_ casa coluna por POSIÇÃO
// com o texto do cabeçalho (não por nome fixo), inserir um campo novo no MEIO
// deslocaria o rótulo de toda coluna depois dele sem mover o dado — cada célula
// ficaria com o nome errado. No final, as colunas existentes não mudam de posição.
const EVENTO_HEADERS = [
  'id', 'data', 'nomeCliente', 'documento', 'telefone', 'email', 'tipoEvento', 'pax',
  'valorContrato', 'valorSinal', 'dataSinal', 'observacao', 'status',
  'createdByEmail', 'createdAt', 'updatedByEmail', 'updatedAt'
].concat(EVENTO_FOLLOWUP_FIELDS).concat(['contratoAnexoUrl', 'contratoAnexoNome', 'pagamentoPendente']);

// Documento legal da casa (alvará, licença sanitária/bombeiros, seguro, contrato
// de aluguel etc.) — validade + alerta de vencimento. Anexo reaproveita o mesmo
// mecanismo do EmployeeDocs (base64 → Drive, pasta própria, link só-visualização),
// mas 1 arquivo por registro (não 1 linha por arquivo): documento legal normalmente
// é 1 PDF só, reenviar substitui o anterior.
const DOCUMENTACAO_TIPOS = ['alvara', 'licencaSanitaria', 'licencaBombeiros', 'seguro', 'contratoAluguel', 'outro'];
const DOCUMENTACAO_HEADERS = [
  'id', 'tipo', 'tipoOutro', 'nome', 'numero', 'orgaoEmissor', 'dataEmissao', 'dataValidade',
  'observacao', 'arquivoUrl', 'arquivoNome', 'createdByEmail', 'createdAt', 'updatedByEmail', 'updatedAt'
];
const DOCUMENTACAO_ALERTA_DIAS = 30; // avisa quando faltar <=30 dias pro vencimento

// Presença diária de CLT/INT/PJ (01/10, pedido do Renato — antes era só um checkbox
// de SESSÃO na Escala do dia, nunca gravado em lugar nenhum, só pra recalcular a
// sugestão de freelancer na hora; perguntei antes de mexer, ele confirmou que queria
// virar registro de verdade). 1 linha por colaborador+dia — marcar de novo no mesmo
// dia substitui a marcação anterior (upsert por employeeId+date), não duplica linha.
// Observação pode ser salva sozinha, sem mexer no status (ex.: só anotar algo sem
// trocar compareceu/faltou) — ver setDailyAttendance_.
const DAILY_ATTENDANCE_HEADERS = ['id', 'employeeId', 'date', 'status', 'observacao', 'markedByEmail', 'markedAt'];
const DAILY_ATTENDANCE_STATUS = ['compareceu', 'faltou'];

// Auditoria Operacional (29/09, pedido do Renato — baseado na "Planilha Auditoria
// FoodService.xlsx", um modelo real de auditoria de manutenção/estrutura física com
// 116 itens já lançados). É um plano de ação de correção: item de manutenção/limpeza/
// organização/obra encontrado numa vistoria, com responsável, custo, prazo e status —
// igual ao "Manutenção solicitada" que já existe no envio diário da Operação, só que
// item por item em vez de 1 valor agregado. MVP a partir da planilha real: só entraram
// as 3 abas com uso comprovado (Plano de Ação, Dashboard, Evidências) — "Checklist
// Estrutural", "Equipamentos" e "Controle Financeiro" existiam na planilha original mas
// vazias (nunca usadas), ficam pra pedir depois se fizer falta. Visível pra quem vê
// Operação OU Diretoria (hasAreaAccess_ 'operacao') — é o Gerente Operador quem regista
// no dia a dia, a Diretoria só acompanha.
// AUDITORIA_OP_SETORES fica declarada mais abaixo, logo depois de FREELANCER_SECTORS
// (29/09: bug real — const no topo do arquivo não pode referenciar outra const que só
// é declarada mais tarde no mesmo escopo top-level; "Cannot access 'FREELANCER_SECTORS'
// before initialization" ao rodar direto no Apps Script, achado pelo Renato ao testar).
const AUDITORIA_OP_SETOR_EXTRA_LABEL = { areaExterna: 'Área Externa' };
const AUDITORIA_OP_TIPO_SERVICO = ['manutencao', 'organizacao', 'obra', 'limpeza', 'aquisicao', 'outros'];
const AUDITORIA_OP_PRIORIDADE = ['alta', 'media', 'baixa'];
// 13/10: 'negado' acrescentado — quadro de Aprovações da Diretoria pode negar um
// item, não só aprovar (pedido do Renato). 'aprovado' acrescentado na mesma tarde —
// item aprovado ganha status PRÓPRIO (badge destacado), não volta pra 'aberto'
// genérico como fazia antes — pedido do Renato pra dar pra ver na tabela quem já
// passou pela Diretoria. Segue fluxo normal depois (aprovado → andamento → concluído).
const AUDITORIA_OP_STATUS = ['aberto', 'andamento', 'aguardandoAprovacao', 'concluido', 'negado', 'aprovado'];
const AUDITORIA_OP_HEADERS = [
  'id', 'dataIdentificacao', 'setor', 'tipoServico', 'descricaoProblema', 'impactoOperacional',
  'responsavelInterno', 'empresaExecutora', 'necessitaAprovacao', 'valorEstimado', 'prioridade',
  'prazo', 'dataInicio', 'dataConclusao', 'status', 'observacao',
  'createdByEmail', 'createdAt', 'updatedByEmail', 'updatedAt',
  'observacaoAprovacao' // 13/10, acrescentado no FIM de propósito (sheetToObjects_ casa
  // por posição) — mensagem que o diretor deixa ao aprovar/negar, pra quem abriu o item
  // ver o motivo sem precisar perguntar. Nome com "Aprovacao" cobre os dois casos
  // (aprovado ou negado), não é só pra aprovação positiva.
];
// Evidência (foto antes/depois) — mesmo padrão 1-linha-por-arquivo do EmployeeDocs,
// vinculada ao item pelo itemId.
const AUDITORIA_EVIDENCIA_HEADERS = ['id', 'itemId', 'antesDepois', 'descricao', 'url', 'fileName', 'uploadedByEmail', 'uploadedAt'];

// Solicitação de freelancers (Gerente Operador → aprovação do RH → confirmação de
// presença). Valor por pessoa depende só da duração do turno, igual em qualquer setor
// (decisão do Renato, 2026-09-25) — tabela abaixo bate com a escala usada até hoje.
const FREELANCER_SECTORS = ['salao', 'cumim', 'bar', 'cozinha', 'limpeza', 'seguranca', 'caixa', 'runner', 'manutencao', 'estoquista'];
// Reaproveita a mesma taxonomia de setor do resto do BI (cruza com escala/RH), mais
// 'areaExterna' — a planilha original (62 itens reais de SJM) tem 11 de 62 marcados
// "Área Externa" (jardim, estacionamento, fachada), sem equivalente nos 10 setores de
// staffing; não fazia sentido forçar num setor de escala que não é esse.
const AUDITORIA_OP_SETORES = FREELANCER_SECTORS.concat(['areaExterna']);
const FREELANCER_SECTOR_LABEL ={ salao: 'Garçom', cumim: 'Cumim', bar: 'Bar', cozinha: 'Cozinha', limpeza: 'Limpeza', seguranca: 'Segurança', caixa: 'Caixa/Hostess', runner: 'Runner/RP', manutencao: 'Manutenção' };
const FREELANCER_PAY_TABLE = { 8: 125, 9: 135, 10: 145, 11: 155, 12: 165 };
// Motivo é preenchido manualmente pelo Gerente Operador — sem escala de folgas
// integrada, não dá pra calcular isso sozinho (decisão do Renato, 2026-09-25):
// 'demanda' = mais gente por causa de movimento; os outros são cobertura de alguém
// específico que não vai trabalhar naquele dia.
const FREELANCER_REASONS = ['demanda', 'folga', 'ferias', 'falta', 'compensacao', 'outro'];
const FREELANCER_REASON_LABEL = { demanda: 'Aumento de movimento', folga: 'Cobertura de folga', ferias: 'Cobertura de férias', falta: 'Cobertura de falta', compensacao: 'Compensação de horas', outro: 'Outro motivo' };
const FREELANCER_HEADERS = [
  'id', 'date', 'sector', 'reason', 'shiftHours', 'qty', 'payPerPerson', 'totalCost', 'note',
  'requestedByEmail', 'requestedAt', 'status', 'decidedByEmail', 'decidedAt', 'decisionNote',
  'attendance', 'attendanceByEmail', 'attendanceAt', 'attendanceNote', 'freelancerNames',
  // Horário CONFIRMADO pelo gerente na Escala do dia (unificada, 28/09) — nasce com a
  // sugestão calculada (mapa de calor), mas o gerente pode ajustar e salvar por cima.
  // No final de propósito, mesma regra de sempre.
  'horaEntrada', 'horaSaida', 'horaPausa'
];

// ---------- HTTP entry points ----------

// Único endpoint público: só confirma que o backend está no ar, sem devolver dado nenhum.
function doGet(e) {
  return jsonOut_({ ok: true, time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === 'login') return jsonOut_(login_(body.email, body.password));
    if (action === 'requestPasswordReset') return jsonOut_(requestPasswordReset_(body.email));
    if (action === 'confirmPasswordReset') return jsonOut_(confirmPasswordReset_(body.email, body.code, body.newPassword));

    const auth = verifyToken_(body.token);
    if (!auth.ok) return jsonOut_({ ok: false, code: 'unauthorized' });

    // 23/10 (desempenho, cache de borda): passe assinado (7 dias) que o painel mostra ao Worker "bi-edge" pra ler o retrato das leituras da abertura.
    // Só Diretoria/dono (o retrato é feito com a conta do robô, que tem acesso de Diretoria). Assinado com EDGE_SECRET (propriedade do script),
    // um segredo à parte do que assina o login. Sem a propriedade, devolve edge_nao_configurado e o painel segue pelo caminho de sempre.
    if (action === 'getEdgePass') {
      const segredo = PropertiesService.getScriptProperties().getProperty('EDGE_SECRET');
      if (!segredo) return jsonOut_({ ok: false, error: 'edge_nao_configurado' });
      if (!(auth.role === 'owner' || hasAreaAccess_(auth, 'master'))) return jsonOut_({ ok: false, code: 'forbidden' });
      const exp = Date.now() + 7 * 86400000;
      const parte = Utilities.base64EncodeWebSafe(JSON.stringify({ e: String(auth.email || '').toLowerCase(), x: exp })).replace(/=+$/, '');
      const assinatura = bytesToHex_(Utilities.computeHmacSha256Signature(parte, segredo));
      return jsonOut_({ ok: true, pass: parte + '.' + assinatura, exp: exp });
    }

    // 23/10 (desempenho): cada chamada ao Apps Script custa 3–5 s só de ida e volta. O painel pede aqui, de uma vez, todas as leituras da
    // abertura; cada uma passa pelo MESMO caminho (e pelas mesmas permissões) de uma chamada normal. Só aceita ações get*, nunca escrita.
    if (action === 'bootstrap') {
      const calls = Array.isArray(body.calls) ? body.calls.slice(0, 50) : [];
      const t0 = Date.now(), results = [];
      __memoLeitura = {};
      let parcial = false;
      try {
        for (let i = 0; i < calls.length; i++) {
          if (Date.now() - t0 > 90000) { parcial = true; break } // não estoura o limite do Apps Script; o painel busca o resto sozinho
          const c = calls[i] || {};
          if (!/^get[A-Za-z]+$/.test(String(c.action || ''))) continue;
          const t1 = Date.now();
          let r;
          try {
            const out = doPost({ postData: { contents: JSON.stringify(Object.assign({}, c.payload || {}, { action: c.action, token: body.token })) } });
            r = JSON.parse(out.getContent());
          } catch (e) { r = { ok: false, error: 'bootstrap_item' } }
          results.push({ action: c.action, payload: c.payload || {}, r: r, ms: Date.now() - t1 });
        }
      } finally { __memoLeitura = null }
      return jsonOut_({ ok: true, results: results, parcial: parcial, ms: Date.now() - t0 });
    }

    if (action === 'getEntries') {
      if (!hasAreaAccess_(auth, body.area)) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getEntries_(body.area, Number(body.limit) || 30));
    }
    if (action === 'submitEntry') {
      if (!hasAreaAccess_(auth, body.area)) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = submitEntry_(auth, body);
      if (r.ok) logAudit_(auth, 'save', body.area, 'entry', body.date, 'Envio do dia — ' + body.area + ', ' + body.date, null, body.values);
      return jsonOut_(r);
    }
    if (action === 'deleteEntry') {
      if (!hasAreaAccess_(auth, body.area)) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(deleteEntry_(auth, body.area, body.date)); // já audita via logDeletion_
    }
    if (action === 'getMkPlans' || action === 'submitMkPlan' || action === 'deleteMkPlan') {
      if (!hasAreaAccess_(auth, 'marketing')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getMkPlans') return jsonOut_(getMkPlans_());
      if (action === 'deleteMkPlan') return jsonOut_(deleteMkPlan_(auth, body.date)); // já audita via logDeletion_
      const r = submitMkPlan_(body);
      if (r.ok) logAudit_(auth, 'save', 'marketing', 'mkplan', body.date, 'Projeção de marketing — ' + body.date, null, body);
      return jsonOut_(r);
    }
    if (action === 'submitMeterReading' || action === 'correctMeterReading' || action === 'getMeterReadings') {
      if (!hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'submitMeterReading') {
        const r = submitMeterReading_(body);
        if (r.ok) logAudit_(auth, 'create', 'operacao', 'meter', body.meterType, 'Leitura de medidor — ' + body.meterType + ', ' + body.date, null, body);
        return jsonOut_(r);
      }
      if (action === 'correctMeterReading') {
        const r = correctMeterReading_(body);
        if (r.ok) logAudit_(auth, 'update', 'operacao', 'meter', body.meterType, 'Correção de leitura — ' + body.meterType + ', ' + body.date, null, body);
        return jsonOut_(r);
      }
      return jsonOut_(getMeterReadings_(Number(body.limit) || 30));
    }
    // 03/10 — achado da auditoria de regras de negócio: essas 13 ações (robô ZigPay +
    // CMV + ranking de bandas) só passavam por verifyToken_ (qualquer login válido),
    // sem checar área — qualquer colaborador autenticado em QUALQUER área conseguia ler
    // faturamento/CMV completo ou injetar dado falso via chamada direta, sem rastro.
    // Travado em 'financeiro' (hasAreaAccess_ já libera 'master'/owner automaticamente).
    // O robô (robo-zigpay/robo_zigpay.ps1) loga com conta de usuário de verdade e usa o
    // token de sessão normal — funciona desde que essa conta tenha a área financeiro/
    // master liberada (Renato vai conferir isso na aba de usuários antes de implantar).
    // Dionísio CRM (23/10): o robô (robo-dionisio, 10h/15h/18h) manda as reservas SEM dados pessoais e o funil do relatório; o painel (aba Reservas) lê.
    if (action === 'submitCrmReservas' || action === 'submitCrmFunil' || action === 'submitCrmConfig') {
      if (!hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(action === 'submitCrmReservas' ? submitCrmReservas_(body) : (action === 'submitCrmFunil' ? submitCrmFunil_(body) : submitCrmConfig_(body)));
    }
    if (action === 'getZigDelivery') {
      if (!(hasAreaAccess_(auth, 'marketing') || hasAreaAccess_(auth, 'financeiro') || hasAreaAccess_(auth, 'operacao'))) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getZigDelivery_(Math.min(Number(body.days) || 150, 400)));
    }
    if (action === 'getCrmReservas' || action === 'getCrmFunil' || action === 'getCrmConfig') {
      if (!(hasAreaAccess_(auth, 'reservas') || hasAreaAccess_(auth, 'marketing') || hasAreaAccess_(auth, 'operacao') || hasAreaAccess_(auth, 'financeiro'))) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(action === 'getCrmReservas' ? getCrmReservas_() : (action === 'getCrmFunil' ? getCrmFunil_() : getCrmConfig_()));
    }
    // IA do BI (23/10, pedido do Renato): botão "IA" da aba Marketing. O painel manda a pergunta e um resumo dos dados que já carregou
    // (sem nome/telefone/e-mail de clientes); aqui só repassa à API da Anthropic. Chave na propriedade do script ANTHROPIC_API_KEY.
    if (action === 'getIaResposta') {
      if (!hasAreaAccess_(auth, 'marketing')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(responderIa_(auth, body));
    }
    // Ranking de bandas (22/10): lê a agenda artística direto da planilha e recalcula; quem vê Marketing (ou Financeiro) lê e atualiza.
    if (action === 'getBandRanking' || action === 'atualizarBandRanking') {
      if (!hasAreaAccess_(auth, 'marketing') && !hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getBandRanking') { garantirGatilhoBandRanking_(); return jsonOut_(getBandRanking_()); }
      try {
        const r = atualizarBandRanking_();
        if (r.ok) logAudit_(auth, 'save', 'marketing', 'bandRanking', '', 'Ranking de bandas recalculado da agenda artística — ' + r.count + ' atrações', null, null);
        return jsonOut_(r);
      } catch (e) { return jsonOut_({ ok: false, error: igRedigir_(e) }); }
    }
    if (action === 'submitZigRevenue' || action === 'submitZigPublico' || action === 'submitZigHourly' ||
        action === 'getZigHourly' || action === 'submitZigHourlyDetail' || action === 'getZigHourlyDetail' ||
        action === 'getZigRevenue' || action === 'getRevenueOverview' || action === 'submitCmvTeoricoParcial' ||
        action === 'getCmvTeoricoParcial' || action === 'submitZigItemSales' || action === 'getZigItemSalesRanking' ||
        action === 'getBandRanking' || action === 'saveBandRanking') {
      if (!hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'submitZigRevenue') { const r = submitZigRevenue_(body); if (r.ok) logAudit_(auth, 'save', 'financeiro', 'zigRevenue', body.date, 'Receita ZigPay — ' + body.date, null, body); return jsonOut_(r); }
      if (action === 'submitZigPublico') { const r = submitZigPublico_(body); if (r.ok) logAudit_(auth, 'save', 'financeiro', 'zigPublico', body.date, 'Público ZigPay — ' + body.date, null, body); return jsonOut_(r); }
      if (action === 'submitZigHourly') { const r = submitZigHourly_(body); if (r.ok) logAudit_(auth, 'save', 'financeiro', 'zigHourly', body.date, 'Faturamento por hora — ' + body.date, null, body); return jsonOut_(r); }
      if (action === 'getZigHourly') return jsonOut_(getZigHourly_(Number(body.days) || 60));
      if (action === 'submitZigHourlyDetail') { const r = submitZigHourlyDetail_(body); if (r.ok) logAudit_(auth, 'save', 'financeiro', 'zigHourlyDetail', body.date, 'Detalhe horário ZigPay — ' + body.date, null, body); return jsonOut_(r); }
      if (action === 'getZigHourlyDetail') return jsonOut_(getZigHourlyDetail_(Number(body.days) || 120));
      if (action === 'getZigRevenue') return jsonOut_(getZigRevenue_(Number(body.limit) || 30));
      if (action === 'getRevenueOverview') return jsonOut_(getRevenueOverview_());
      if (action === 'submitCmvTeoricoParcial') { const r = submitCmvTeoricoParcial_(body); if (r.ok) logAudit_(auth, 'save', 'financeiro', 'cmvParcial', body.date, 'CMV parcial — ' + body.date, null, body); return jsonOut_(r); }
      if (action === 'getCmvTeoricoParcial') return jsonOut_(getCmvTeoricoParcial_(Number(body.limit) || 30));
      if (action === 'submitZigItemSales') { const r = submitZigItemSales_(body); if (r.ok) logAudit_(auth, 'save', 'financeiro', 'zigItemSales', body.date, 'Itens vendidos ZigPay — ' + body.date, null, body); return jsonOut_(r); }
      if (action === 'getZigItemSalesRanking') return jsonOut_(getZigItemSalesRanking_(Number(body.days) || 30));
      if (action === 'getBandRanking') return jsonOut_(getBandRanking_());
      if (action === 'saveBandRanking') { const r = saveBandRanking_(body.rows); if (r.ok) logAudit_(auth, 'save', 'financeiro', 'bandRanking', '', 'Ranking de bandas atualizado', null, body.rows); return jsonOut_(r); }
    }

    if (action === 'getDreBase') {
      if (!hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getDreBase_());
    }
    if (action === 'getDreParaMes') {
      if (!hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getDreParaMes_(body.mes));
    }
    if (action === 'getDreFaturamentoHistorico') {
      if (!hasAreaAccess_(auth, 'marketing') && !hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getFaturamentoHistoricoDre_(!!body.force));
    }
    if (action === 'submitZigBilheteria' || action === 'getZigBilheteria') {
      if (!hasAreaAccess_(auth, 'marketing') && !hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'submitZigBilheteria') { const r = submitZigBilheteria_(body); if (r.ok) logAudit_(auth, 'save', 'marketing', 'zigBilheteria', body.mes, 'Bilheteria — ' + body.mes, null, body); return jsonOut_(r); }
      return jsonOut_(getZigBilheteria_(Number(body.limit) || 13));
    }
    // DIAGNÓSTICO TEMPORÁRIO 10/10 — "(+) Faturamento" bate a linha certa mas o
    // valor sempre vem 0 (confirmado via getDreParaMes_ também, não é bug só do
    // getFaturamentoHistoricoDre_). Suspeita: linha 2 (onde o termo bateu) é a
    // MESMA linha usada como headerRow pros meses — provável colisão. Dumpa
    // linhas 1-6 (rótulo + valor na coluna do mês pedido) pra confirmar antes de
    // decidir o fix certo. Apagar essa ação depois de resolvido.
    if (action === 'debugDreLinhas') {
      if (!hasAreaAccess_(auth, 'marketing') && !hasAreaAccess_(auth, 'financeiro')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(debugDreLinhas_(body.mes || '2026-09'));
    }

    if (action === 'changeMyPassword') return jsonOut_(changeMyPassword_(auth, body.currentPassword, body.newPassword));

    if (action === 'submitFreelancerRequest') {
      if (!hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = submitFreelancerRequest_(auth, body);
      if (r.ok) logAudit_(auth, 'create', 'operacao', 'freelancer', r.id, 'Solicitação de freelancer — ' + body.sector + ', ' + body.date, null, body);
      return jsonOut_(r);
    }
    if (action === 'submitFreelancerRequestsBatch') {
      if (!hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = submitFreelancerRequestsBatch_(auth, body.items);
      if (r.ok) logAudit_(auth, 'create', 'operacao', 'freelancer', '', 'Solicitação semanal de freelancers enviada — ' + (r.count || 0) + ' item(ns)', null, body.items);
      return jsonOut_(r);
    }
    if (action === 'getFreelancerRequests') {
      if (!hasAreaAccess_(auth, 'operacao') && !hasAreaAccess_(auth, 'rh')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getFreelancerRequests_());
    }
    if (action === 'decideFreelancerRequest') {
      if (!hasAreaAccess_(auth, 'rh')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = decideFreelancerRequest_(auth, body.id, !!body.approve, body.note);
      if (r.ok) logAudit_(auth, 'update', 'rh', 'freelancer', body.id, (body.approve ? 'Freelancer aprovado' : 'Freelancer recusado') + (body.note ? ' — ' + body.note : ''), null, body);
      return jsonOut_(r);
    }
    if (action === 'decideFreelancerRequestsBatch') {
      if (!hasAreaAccess_(auth, 'rh')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = decideFreelancerRequestsBatch_(auth, body.ids, !!body.approve, body.note);
      if (r.ok) logAudit_(auth, 'update', 'rh', 'freelancer', '', (body.approve ? 'Freelancers aprovados em lote' : 'Freelancers recusados em lote') + ' — ' + r.count + ' pedido(s)', null, { ids: body.ids });
      return jsonOut_(r);
    }
    if (action === 'splitFreelancerRequest') {
      if (!hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = splitFreelancerRequest_(auth, body.id);
      if (r.ok && r.count) logAudit_(auth, 'update', 'operacao', 'freelancer', body.id, 'Pedido de freelancer separado em ' + (r.count + 1) + ' linhas individuais', null, body);
      return jsonOut_(r);
    }
    if (action === 'markFreelancerAttendance') {
      if (!hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = markFreelancerAttendance_(auth, body.id, body.attended, body.note);
      const msgPresenca = typeof body.attended === 'boolean' ? ('Presença de freelancer — ' + (body.attended ? 'compareceu' : 'faltou')) : ('Observação de freelancer atualizada' + (body.note ? ' — ' + body.note : ''));
      if (r.ok) logAudit_(auth, 'update', 'operacao', 'freelancer', body.id, msgPresenca, null, body);
      return jsonOut_(r);
    }
    if (action === 'setFreelancerNames') {
      if (!hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = setFreelancerNames_(auth, body.id, body.names, body.horaEntrada, body.horaSaida, body.horaPausa);
      if (r.ok) logAudit_(auth, 'update', 'operacao', 'freelancer', body.id, 'Nome/horário de freelancer salvo — ' + (body.names || ''), null, body);
      return jsonOut_(r);
    }
    if (action === 'deleteFreelancerRequest') {
      if (!hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(deleteFreelancerRequest_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'getEmployees' || action === 'saveEmployee' || action === 'deleteEmployee' || action === 'getEmployeeMonth' || action === 'getEmployeesMonth') {
      if (!hasAreaAccess_(auth, 'rh')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getEmployees') return jsonOut_(getEmployees_());
      if (action === 'getEmployeeMonth') return jsonOut_(getEmployeeMonth_(body.employeeId, body.mes));
      if (action === 'getEmployeesMonth') return jsonOut_(getEmployeesMonth_(body.mes));
      if (action === 'saveEmployee') {
        const wasNew = !body.id;
        const r = saveEmployee_(body, auth);
        if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'rh', 'employee', r.id, (wasNew ? 'Colaborador criado — ' : 'Colaborador editado — ') + (body.nome || ''), null, body);
        return jsonOut_(r);
      }
      return jsonOut_(deleteEmployee_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'uploadEmployeeDoc' || action === 'getEmployeeDocs' || action === 'deleteEmployeeDoc') {
      if (!hasAreaAccess_(auth, 'rh')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'uploadEmployeeDoc') {
        const r = uploadEmployeeDoc_(auth, body);
        if (r.ok) logAudit_(auth, 'create', 'rh', 'employeeDoc', body.employeeId, 'Documento de colaborador anexado — ' + (r.fileName || ''), null, { fileName: r.fileName });
        return jsonOut_(r);
      }
      if (action === 'getEmployeeDocs') return jsonOut_(getEmployeeDocs_(body.employeeId));
      return jsonOut_(deleteEmployeeDoc_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'getSectorBase') {
      if (!hasAreaAccess_(auth, 'operacao') && !hasAreaAccess_(auth, 'rh')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getSectorBase_());
    }
    if (action === 'saveSectorBase') {
      if (!hasAreaAccess_(auth, 'rh')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = saveSectorBase_(body.rows);
      if (r.ok) logAudit_(auth, 'update', 'rh', 'sectorBase', '', 'Quadro mínimo por setor editado', null, body.rows);
      return jsonOut_(r);
    }
    if (action === 'submitReservationEntry') {
      if (!hasAreaAccess_(auth, 'reservas')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = submitReservationEntry_(auth, body);
      if (r.ok) logAudit_(auth, 'create', 'reservas', 'reservation', r.id, 'Reserva — ' + (body.nomeCliente || body.pax + ' pax') + ', ' + body.date, null, body);
      return jsonOut_(r);
    }
    if (action === 'submitReservationEntriesBatch') {
      if (!hasAreaAccess_(auth, 'reservas')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = submitReservationEntriesBatch_(auth, body.items);
      if (r.ok && r.count) logAudit_(auth, 'create', 'reservas', 'reservation', '', 'Lote de reservas enviado — ' + r.count + ' item(ns)', null, body.items);
      return jsonOut_(r);
    }
    if (action === 'getReservationEntries') {
      if (!hasAreaAccess_(auth, 'reservas')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getReservationEntriesList_(Number(body.limit) || 200));
    }
    if (action === 'deleteReservationEntry') {
      if (!hasAreaAccess_(auth, 'reservas')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(deleteReservationEntry_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'updateReservationEntry') {
      if (!hasAreaAccess_(auth, 'reservas')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = updateReservationEntry_(auth, body);
      if (r.ok) logAudit_(auth, 'update', 'reservas', 'reservation', body.id, 'Reserva editada — ' + (body.nomeCliente || body.pax + ' pax') + ', ' + body.date, null, body);
      return jsonOut_(r);
    }
    if (action === 'getReservations') {
      if (!hasAreaAccess_(auth, 'reservas') && !hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getReservations_(Number(body.limit) || 60));
    }
    if (action === 'closeMonth') {
      if (!hasAreaAccess_(auth, body.area)) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = closeMonth_(auth, body.area, body.monthKey);
      if (r.ok) logAudit_(auth, 'update', body.area, 'monthClosure', body.monthKey, 'Mês fechado — ' + body.area + ', ' + body.monthKey, null, body);
      return jsonOut_(r);
    }
    if (action === 'getMonthClosures') {
      // Sem body.area: lista de TODAS as áreas de uma vez, pra montar a trava do lado
      // do cliente sem 5 chamadas — é só metadado (mês fechado, quem, quando), não dado
      // sensível, então não precisa checar acesso de área nenhuma pra essa forma.
      if (body.area && !hasAreaAccess_(auth, body.area)) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getMonthClosures_(body.area));
    }
    if (action === 'reopenMonth') {
      if (auth.role !== 'owner') return jsonOut_({ ok: false, code: 'forbidden' });
      const r = reopenMonth_(auth, body.area, body.monthKey);
      if (r.ok) logAudit_(auth, 'update', body.area, 'monthClosure', body.monthKey, 'Mês reaberto — ' + body.area + ', ' + body.monthKey, null, body);
      return jsonOut_(r);
    }

    // Sem hasAreaAccess_ de propósito: ordem de quadros é preferência pessoal, não dado
    // sensível, isolada por e-mail de qualquer forma (mesmo espírito de getManualPdfInfo/
    // getContatosEmergencia, que também não checam área).
    if (action === 'saveCardOrder') return jsonOut_(saveCardOrder_(auth, body.area, body.cardOrder));
    if (action === 'resetCardOrder') return jsonOut_(resetCardOrder_(auth, body.area));

    if (action === 'getManualPdfInfo') return jsonOut_(getManualPdfInfo_());
    if (action === 'getManualPdfChunk') return jsonOut_(getManualPdfChunk_(body.offset, body.length));
    if (action === 'submitDuvida') return jsonOut_(submitDuvida_(body, auth));
    if (action === 'getDuvidas') return jsonOut_(getDuvidas_());
    if (action === 'responderDuvida') return jsonOut_(responderDuvida_(body, auth)); // já audita via logAudit_
    if (action === 'getContatosEmergencia') return jsonOut_(getContatosEmergencia_());
    // 23/10, pedido do Renato: quem NÃO é Diretoria só consegue SOLICITAR criar/editar/apagar contato; a Diretoria (dono ou área Diretoria) aprova.
    if (action === 'getContatoSolicitacoes') return jsonOut_({ ok: true, items: getContatoSolicitacoes_(auth), diretoria: isDiretoria_(auth) });
    if (action === 'decideContatoSolicitacao') {
      const r = decidirSolicitacaoContato_(auth, body.id, !!body.approve, body.nota);
      if (r.ok) logAudit_(auth, 'update', 'geral', 'contatoSolicitacao', body.id, 'Solicitação de contato ' + (body.approve ? 'aprovada' : 'recusada') + (r.resumo ? ' — ' + r.resumo : ''), null, body);
      return jsonOut_(r);
    }
    if (action === 'saveContatoEmergencia' && !isDiretoria_(auth)) {
      const r = criarSolicitacaoContato_(auth, body.id ? 'editar' : 'criar', body);
      if (r.ok) logAudit_(auth, 'create', 'geral', 'contatoSolicitacao', r.id, 'Solicitação de contato (' + (body.id ? 'editar' : 'criar') + ') — ' + (body.nome || ''), null, body);
      return jsonOut_(r);
    }
    if (action === 'deleteContatoEmergencia' && !isDiretoria_(auth)) {
      const r = criarSolicitacaoContato_(auth, 'apagar', { id: body.id });
      if (r.ok) logAudit_(auth, 'create', 'geral', 'contatoSolicitacao', r.id, 'Solicitação de contato (apagar)', null, body);
      return jsonOut_(r);
    }
    if (action === 'saveContatoEmergencia') {
      const wasNew = !body.id;
      const r = saveContatoEmergencia_(body, auth);
      if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'geral', 'contatoEmergencia', r.id, (wasNew ? 'Contato criado — ' : 'Contato editado — ') + (body.nome || ''), null, body);
      return jsonOut_(r);
    }
    if (action === 'deleteContatoEmergencia') return jsonOut_(deleteContatoEmergencia_(auth, body.id)); // já audita via logDeletion_

    // Eventos privados/corporativos e documentação legal da casa (29/09) — Diretoria
    // sempre enxerga (hasAreaAccess_ já trata 'master' como "vê tudo"); a partir de
    // 29/09 também dá pra conceder a área 'eventos' avulsa pra alguém que não é
    // Diretoria, pelo checkbox de "Criar ou redefinir acesso ao BI".
    if (action === 'getEventos' || action === 'saveEvento' || action === 'deleteEvento') {
      if (!hasAreaAccess_(auth, 'eventos')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getEventos') return jsonOut_(getEventos_());
      if (action === 'saveEvento') {
        const wasNew = !body.id;
        const r = saveEvento_(auth, body);
        if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'master', 'evento', r.id, (wasNew ? 'Evento criado — ' : 'Evento editado — ') + (body.nomeCliente || '') + ' (' + (body.data || '') + ')', null, body);
        return jsonOut_(r);
      }
      return jsonOut_(deleteEvento_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'uploadEventoContratoFile') {
      if (!hasAreaAccess_(auth, 'eventos')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = uploadEventoContratoFile_(auth, body);
      if (r.ok) logAudit_(auth, 'update', 'eventos', 'evento', body.eventoId, 'Contrato anexado — ' + (r.fileName || ''), null, { eventoId: body.eventoId, fileName: body.fileName });
      return jsonOut_(r);
    }
    if (action === 'getEventoPacotesPdfInfo' || action === 'getEventoPacotesPdfChunk') {
      if (!hasAreaAccess_(auth, 'eventos')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getEventoPacotesPdfInfo') return jsonOut_(getEventoPacotesPdfInfo_());
      return jsonOut_(getEventoPacotesPdfChunk_(body.offset, body.length));
    }
    if (action === 'getEventoCotacoes' || action === 'saveEventoCotacao' || action === 'submitEventoCotacaoForApproval') {
      if (!hasAreaAccess_(auth, 'eventos')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getEventoCotacoes') return jsonOut_(getEventoCotacoes_());
      if (action === 'saveEventoCotacao') {
        const wasNew = !body.id;
        const r = saveEventoCotacao_(auth, body);
        if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'eventos', 'cotacao', r.id, (wasNew ? 'Cotação criada — ' : 'Cotação editada — ') + (body.nomeEmpresaCliente || ''), null, body);
        return jsonOut_(r);
      }
      const r = submitEventoCotacaoForApproval_(auth, body.id);
      if (r.ok) logAudit_(auth, 'update', 'eventos', 'cotacao', body.id, 'Cotação enviada pra aprovação', null, body);
      return jsonOut_(r);
    }
    // Aprovar/recusar e enviar contrato — só Diretoria (área 'master'), mesmo
    // texto de gate que o resto do Eventos/Documentações já usa pra isso.
    if (action === 'decideEventoCotacao') {
      if (!hasAreaAccess_(auth, 'master')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = decideEventoCotacao_(auth, body.id, !!body.approve, body.note);
      if (r.ok) logAudit_(auth, 'update', 'eventos', 'cotacao', body.id, (body.approve ? 'Cotação aprovada, contrato gerado' : 'Cotação recusada') + (body.note ? ' — ' + body.note : ''), null, body);
      return jsonOut_(r);
    }
    if (action === 'enviarContratoEventoCotacao') {
      if (!hasAreaAccess_(auth, 'master')) return jsonOut_({ ok: false, code: 'forbidden' });
      const r = enviarContratoEventoCotacao_(auth, body.id, body.assunto, body.corpo);
      if (r.ok) logAudit_(auth, 'update', 'eventos', 'cotacao', body.id, 'Contrato enviado pro cliente', null, body);
      return jsonOut_(r);
    }
    if (action === 'getEventoInteracoes' || action === 'saveEventoInteracao' || action === 'deleteEventoInteracao') {
      if (!hasAreaAccess_(auth, 'eventos')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getEventoInteracoes') return jsonOut_(getEventoInteracoes_(body.eventoId));
      if (action === 'saveEventoInteracao') {
        const r = saveEventoInteracao_(auth, body);
        if (r.ok) logAudit_(auth, 'create', 'eventos', 'eventoInteracao', r.id, 'Interação registrada — ' + (body.texto || ''), null, body);
        return jsonOut_(r);
      }
      return jsonOut_(deleteEventoInteracao_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'getEventoTarefas' || action === 'saveEventoTarefa' || action === 'concluirEventoTarefa' || action === 'deleteEventoTarefa') {
      if (!hasAreaAccess_(auth, 'eventos')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getEventoTarefas') return jsonOut_(getEventoTarefas_());
      if (action === 'saveEventoTarefa') {
        const wasNew = !body.id;
        const r = saveEventoTarefa_(auth, body);
        if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'eventos', 'eventoTarefa', r.id, (wasNew ? 'Tarefa criada — ' : 'Tarefa editada — ') + (body.titulo || ''), null, body);
        return jsonOut_(r);
      }
      if (action === 'concluirEventoTarefa') {
        const r = concluirEventoTarefa_(auth, body.id, body.concluida !== false);
        if (r.ok) logAudit_(auth, 'update', 'eventos', 'eventoTarefa', body.id, body.concluida !== false ? 'Tarefa concluída' : 'Tarefa reaberta', null, body);
        return jsonOut_(r);
      }
      return jsonOut_(deleteEventoTarefa_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'getDocumentacoes' || action === 'saveDocumentacao' || action === 'uploadDocumentacaoFile' || action === 'deleteDocumentacao') {
      if (!hasAreaAccess_(auth, 'documentos')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getDocumentacoes') return jsonOut_(getDocumentacoes_());
      if (action === 'saveDocumentacao') {
        const wasNew = !body.id;
        const r = saveDocumentacao_(auth, body);
        if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'master', 'documentacao', r.id, (wasNew ? 'Documento criado — ' : 'Documento editado — ') + (body.nome || ''), null, body);
        return jsonOut_(r);
      }
      if (action === 'uploadDocumentacaoFile') {
        const r = uploadDocumentacaoFile_(auth, body);
        if (r.ok) logAudit_(auth, 'update', 'master', 'documentacao', body.id, 'Anexo de documento enviado — ' + (r.fileName || ''), null, { fileName: r.fileName });
        return jsonOut_(r);
      }
      return jsonOut_(deleteDocumentacao_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'getAuditLog') {
      if (!hasAreaAccess_(auth, 'auditoria')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getAuditLog_(Number(body.limit) || 300));
    }

    // Presença diária de CLT/INT/PJ (01/10) — mesma regra de acesso da Escala do dia
    // (RH cadastra o colaborador, Operação marca a presença no dia a dia).
    if (action === 'getDailyAttendance' || action === 'setDailyAttendance') {
      if (!hasAreaAccess_(auth, 'rh') && !hasAreaAccess_(auth, 'operacao')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getDailyAttendance') return jsonOut_(getDailyAttendance_(body.date));
      const r = setDailyAttendance_(auth, body);
      if (r.ok) logAudit_(auth, 'update', 'rh', 'dailyAttendance', body.employeeId, 'Presença diária — ' + body.date + (body.status ? ' — ' + body.status : '') + (body.observacao ? ' — ' + body.observacao : ''), null, body);
      return jsonOut_(r);
    }

    // Marketing • Reuniões e demandas (16/10) — controle de demandas, pautas e atas por
    // responsável/prazo. Mesma trava da aba Marketing (hasAreaAccess_ 'marketing').
    if (action === 'getMkReunioes' || action === 'saveMkReuniao' || action === 'deleteMkReuniao') {
      if (!hasAreaAccess_(auth, 'marketing')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getMkReunioes') return jsonOut_(getMkReunioes_());
      if (action === 'saveMkReuniao') {
        const wasNew = !body.id;
        const r = saveMkReuniao_(auth, body);
        if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'marketing', 'mkReuniao', r.id, (wasNew ? 'Marketing — item criado: ' : 'Marketing — item editado: ') + (body.tipo || '') + ' — ' + (body.titulo || ''), null, body);
        return jsonOut_(r);
      }
      return jsonOut_(deleteMkReuniao_(auth, body.id)); // já audita via logDeletion_
    }

    // Faturamento por semana (23/10) — só os TOTAIS semanais da ZigPay (sem dia a dia nem público), pra quem monta a escala (Operação) ver o teto de
    // 8% do CMO de freelancers; também Financeiro/Marketing. Não abre o resto da receita (getZigRevenue continua só Financeiro).
    if (action === 'getFaturamentoSemanas') {
      if (!(hasAreaAccess_(auth, 'operacao') || hasAreaAccess_(auth, 'financeiro') || hasAreaAccess_(auth, 'marketing'))) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_({ ok: true, semanas: getFaturamentoSemanas_() });
    }
    // Budget de atrações (22/10) — só totais de pax por data de reserva (sem dados de cliente), pra quem vê Marketing.
    if (action === 'getBudgetAtracoesBase') {
      if (!hasAreaAccess_(auth, 'marketing')) return jsonOut_({ ok: false, code: 'forbidden' });
      return jsonOut_(getBudgetAtracoesBase_());
    }
    // Instagram (21/10) — ativações (ações) e retorno em reservas. Ver ativações: Marketing ou Reservas (pra escolher a ativação ao lançar a reserva).
    if (action === 'getIgAtivacoes' || action === 'saveIgAtivacao' || action === 'deleteIgAtivacao' || action === 'getIgRetorno') {
      const pode = hasAreaAccess_(auth, 'marketing') || (action === 'getIgAtivacoes' && hasAreaAccess_(auth, 'reservas'));
      if (!pode) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getIgAtivacoes') return jsonOut_(getIgAtivacoes_());
      if (action === 'getIgRetorno') return jsonOut_(getIgRetorno_());
      if (action === 'saveIgAtivacao') {
        const r = saveIgAtivacao_(auth, body);
        if (r.ok) logAudit_(auth, body.id ? 'update' : 'create', 'marketing', 'igAtivacao', r.id, 'Instagram — ativação: ' + body.titulo + ' (' + body.data + ')', null, body);
        return jsonOut_(r);
      }
      return jsonOut_(deleteIgAtivacao_(auth, body.id)); // já audita via logDeletion_
    }
    // Instagram (19/10) — indicadores reais via API oficial (Graph API). Leitura: quem vê Marketing; atualizar agora: só o dono.
    if (action === 'getInstagram' || action === 'atualizarInstagram') {
      if (!hasAreaAccess_(auth, 'marketing')) return jsonOut_({ ok: false, code: 'forbidden' });
      garantirGatilhoInstagram_();
      if (action === 'atualizarInstagram') {
        if (auth.role !== 'owner') return jsonOut_({ ok: false, code: 'forbidden' });
        try { return jsonOut_(Object.assign({ ok: true }, atualizarInstagram_())); } catch (e) { return jsonOut_({ ok: false, error: String(e) }); }
      }
      return jsonOut_(getInstagram_());
    }

    // Auditoria Operacional (29/09) — plano de ação de manutenção/limpeza/organização/
    // obra, a partir da "Planilha Auditoria FoodService.xlsx". Continua vendo quem já via
    // Operação antes (hasAreaAccess_ 'operacao', comportamento de sempre — sem isso quem
    // já tinha só Operação marcado perderia acesso sem avisar) OU quem ganhar a área
    // 'auditoriaop' avulsa, pra dar acesso só a isso sem abrir a aba inteira de Operação.
    if (action === 'getAuditoriaOpItens' || action === 'saveAuditoriaOpItem' || action === 'deleteAuditoriaOpItem' || action === 'aprovarAuditoriaOpItem' || action === 'negarAuditoriaOpItem') {
      if (!hasAreaAccess_(auth, 'operacao') && !hasAreaAccess_(auth, 'auditoriaop')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getAuditoriaOpItens') return jsonOut_(getAuditoriaOpItens_());
      if (action === 'saveAuditoriaOpItem') {
        const wasNew = !body.id;
        const r = saveAuditoriaOpItem_(auth, body);
        if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'operacao', 'auditoriaOpItem', r.id, (wasNew ? 'Item de auditoria criado — ' : 'Item de auditoria editado — ') + (body.descricaoProblema || ''), null, body);
        return jsonOut_(r);
      }
      if (action === 'aprovarAuditoriaOpItem') {
        const r = aprovarAuditoriaOpItem_(auth, body.id, body.observacao);
        if (r.ok) logAudit_(auth, 'update', 'operacao', 'auditoriaOpItem', body.id, 'Item de auditoria aprovado pelo diretor', null, { status: 'aberto', observacao: body.observacao });
        return jsonOut_(r);
      }
      if (action === 'negarAuditoriaOpItem') {
        const r = negarAuditoriaOpItem_(auth, body.id, body.observacao);
        if (r.ok) logAudit_(auth, 'update', 'operacao', 'auditoriaOpItem', body.id, 'Item de auditoria negado pelo diretor', null, { status: 'negado', observacao: body.observacao });
        return jsonOut_(r);
      }
      return jsonOut_(deleteAuditoriaOpItem_(auth, body.id)); // já audita via logDeletion_
    }
    if (action === 'uploadAuditoriaOpEvidencia' || action === 'getAuditoriaOpEvidencias' || action === 'deleteAuditoriaOpEvidencia') {
      if (!hasAreaAccess_(auth, 'operacao') && !hasAreaAccess_(auth, 'auditoriaop')) return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'uploadAuditoriaOpEvidencia') {
        const r = uploadAuditoriaOpEvidencia_(auth, body);
        if (r.ok) logAudit_(auth, 'create', 'operacao', 'auditoriaOpEvidencia', body.itemId, 'Evidência anexada — ' + (r.fileName || ''), null, { fileName: r.fileName, antesDepois: body.antesDepois });
        return jsonOut_(r);
      }
      if (action === 'getAuditoriaOpEvidencias') return jsonOut_(getAuditoriaOpEvidencias_(body.itemId));
      return jsonOut_(deleteAuditoriaOpEvidencia_(auth, body.id)); // já audita via logDeletion_
    }

    if (action === 'getSalaries' || action === 'saveSalaries' || action === 'addAccount' || action === 'getUsersList' || action === 'setUserAreas' || action === 'deleteUser' || action === 'getDeletionsLog') {
      if (auth.role !== 'owner') return jsonOut_({ ok: false, code: 'forbidden' });
      if (action === 'getSalaries') return jsonOut_(getSalaries_());
      if (action === 'saveSalaries') {
        const r = saveSalaries_(body.rows);
        if (r.ok) logAudit_(auth, 'update', 'master', 'salaries', '', 'Elegibilidade de bônus/salário editada', null, null); // não guarda salário no corpo do log — dado sensível
        return jsonOut_(r);
      }
      if (action === 'getUsersList') return jsonOut_(getUsersList_());
      if (action === 'setUserAreas') {
        const r = setUserAreas_(body.email, body.areas);
        if (r.ok) logAudit_(auth, 'update', 'master', 'userAccount', body.email, 'Abas de acesso alteradas — ' + body.email, null, { areas: body.areas });
        return jsonOut_(r);
      }
      // deleteUser_: corrigido bug real (29/09) — recebia (auth, email) do roteamento mas
      // só tinha o parâmetro `email` na assinatura, então `email` dentro da função vinha
      // com o objeto `auth` por engano e nunca achava o usuário certo pra apagar (sempre
      // 'not_found', não importa quem). Já audita via logDeletion_ agora também.
      if (action === 'deleteUser') return jsonOut_(deleteUser_(auth, body.email));
      if (action === 'getDeletionsLog') return jsonOut_(getDeletionsLog_());
      const wasNew = !sheetToObjects_(getUsersSheet_()).some(u => String(u.email).toLowerCase() === String(body.email || '').trim().toLowerCase());
      const r = addAccount_(body.email, body.password, body.areas);
      if (r.ok) logAudit_(auth, wasNew ? 'create' : 'update', 'master', 'userAccount', body.email, (wasNew ? 'Acesso criado — ' : 'Senha/abas redefinidas — ') + body.email, null, { email: body.email, areas: body.areas }); // nunca loga senha
      return jsonOut_(r);
    }
    return jsonOut_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- ações ----------

function getEntries_(area, limit) {
  if (AREAS.indexOf(area) < 0) return { ok: false, error: 'invalid_area' };
  const rows = sheetToObjects_(getEntriesSheet_()).filter(r => r.area === area);
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  // RH: soma o custo de freelancer aprovado (e não marcado como falta) como campo à
  // parte — não mexe no rhExtras gravado, senão editar e reenviar o dia duplicava a
  // conta (o valor gravado ficaria com o freelancer embutido pra sempre).
  const freelancerByDate = area === 'rh' ? getApprovedFreelancerCostByDate_() : null;
  const docs = rows.slice(0, limit).map(r => {
    const values = safeParse_(r.valuesJson, {});
    if (freelancerByDate) values.freelancerApprovedCost = freelancerByDate[r.date] || 0;
    return {
      area: r.area,
      date: r.date,
      values: values,
      notes: safeParse_(r.notesJson, {}),
      submittedByName: r.submittedByName || '',
      submittedAt: r.submittedAt || ''
    };
  });
  return { ok: true, docs };
}

function submitEntry_(auth, body) {
  if (AREAS.indexOf(body.area) < 0) return { ok: false, error: 'invalid_area' };
  if (!body.date) return { ok: false, error: 'missing_date' };
  if (auth.role !== 'owner' && isMonthClosed_(body.area, body.date.slice(0, 7))) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  upsertByKeys_(getEntriesSheet_(), ENTRIES_HEADERS, ['area', 'date'], {
    area: body.area,
    date: body.date,
    valuesJson: JSON.stringify(body.values || {}),
    notesJson: JSON.stringify(body.notes || {}),
    submittedByName: body.submittedByName || '',
    submittedAt: new Date().toISOString()
  });
  return { ok: true };
}

// ---------- Quadro mínimo por setor (RH edita, Gerente Operador usa pra sugerir freelancer) ----------

function getSectorBaseSheet_() {
  const sh = ensureSheet_('SectorBase', SECTOR_BASE_HEADERS);
  if (sh.getDataRange().getNumRows() < 2) {
    SECTOR_BASE_DEFAULTS.forEach(r => sh.appendRow([r.sector, r.atendimentoPorPessoa, r.clt, r.brigadaPadrao]));
  } else {
    // Setor novo adicionado depois (ex.: estoquista, 28/09) não aparece sozinho numa
    // planilha que já existia — completa só o que falta, sem tocar no que já está lá
    // (RH pode ter ajustado os números).
    const jaTem = sheetToObjects_(sh).map(r => r.sector);
    const faltando = SECTOR_BASE_DEFAULTS.filter(r => jaTem.indexOf(r.sector) < 0);
    faltando.forEach(r => sh.appendRow([r.sector, r.atendimentoPorPessoa, r.clt, r.brigadaPadrao]));
  }
  return sh;
}

function getSectorBase_() {
  const rows = sheetToObjects_(getSectorBaseSheet_());
  const cltCount = getActiveCltCountBySector_();
  const intCount = getActiveCountBySector_('INT');
  const pjCount = getActiveCountBySector_('PJ');
  const bySector = {};
  rows.forEach(r => { bySector[r.sector] = { atendimentoPorPessoa: Number(r.atendimentoPorPessoa) || 1, clt: cltCount[r.sector] || 0, int: intCount[r.sector] || 0, pj: pjCount[r.sector] || 0, brigadaPadrao: Number(r.brigadaPadrao) || 0, limiteBrigada: Number(r.limiteBrigada) || 0 } });
  // Setor novo (adicionado depois da planilha já semeada) ainda sem linha: usa o padrão até o RH salvar.
  SECTOR_BASE_DEFAULTS.forEach(d => {
    if (!bySector[d.sector]) bySector[d.sector] = { atendimentoPorPessoa: d.atendimentoPorPessoa, clt: cltCount[d.sector] || 0, int: intCount[d.sector] || 0, pj: pjCount[d.sector] || 0, brigadaPadrao: d.brigadaPadrao, limiteBrigada: 0 };
  });
  return { ok: true, bySector: bySector };
}

function getEmployeesSheet_() { return ensureSheet_('Employees', EMPLOYEE_HEADERS) }

function getEmployees_() {
  const rows = sheetToObjects_(getEmployeesSheet_());
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, nome: r.nome || '', cargo: r.cargo || 'outro', cargoOutro: r.cargoOutro || '',
      nivel: r.nivel || 'pleno', contratacao: r.contratacao || 'CLT', mesReferencia: r.mesReferencia || '',
      salario: Number(r.salario) || 0, adSalarial: Number(r.adSalarial) || 0, horasExtras: Number(r.horasExtras) || 0,
      adicionalNoturno: Number(r.adicionalNoturno) || 0, fgts: Number(r.fgts) || 0, inss: Number(r.inss) || 0,
      irrf: Number(r.irrf) || 0, salarioFamilia: Number(r.salarioFamilia) || 0, quebra: Number(r.quebra) || 0,
      vt: Number(r.vt) || 0, vr: Number(r.vr) || 0, ferias: Number(r.ferias) || 0, decimoTerceiro: Number(r.decimoTerceiro) || 0,
      beneficios: Number(r.beneficios) || 0, valorTotal: Number(r.valorTotal) || 0,
      ativo: r.ativo === false || r.ativo === 'false' ? false : true,
      horarioSemanal: parseHorarioSemanal_(r.horarioSemanalJson),
      feriasInicio: r.feriasInicio || '', feriasFim: r.feriasFim || '',
      dataAdmissao: r.dataAdmissao || '', dataDesligamento: r.dataDesligamento || '',
      tipoDesligamento: r.tipoDesligamento || '', desligamentoObs: r.desligamentoObs || '',
      valorRescisao: Number(r.valorRescisao) || 0,
      funcaoCargo: r.funcaoCargo || ''
    }))
  };
}

// Padrão semanal de trabalho de cada CLT (entrada/saída/pausas por dia da semana) —
// pré-requisito da escala sugerida completa. Guardado como JSON numa coluna só
// porque o Sheets não lida bem com array aninhado em colunas separadas.
function parseHorarioSemanal_(json) {
  try {
    const parsed = json ? JSON.parse(json) : null;
    if (Array.isArray(parsed) && parsed.length === 7) return parsed;
  } catch (e) { /* dado antigo/ausente cai no padrão abaixo */ }
  return [0, 1, 2, 3, 4, 5, 6].map(function () { return { trabalha: false, entrada: '', saida: '', almoco: '', jantar: '' } });
}

// ---------- Ficha do colaborador MÊS A MÊS (20/10, pedido do Renato) ----------
// A aba Employees guarda a ficha ATUAL; esta aba guarda uma foto da ficha de cada mês (valores + cargo/nível/contratação/status).
// Grava sozinha a cada salvamento (no mês de referência da ficha) e congela as fichas quando o RH daquele mês é fechado.
// Mês fechado = somente leitura pra todos, menos o dono (mesma regra do resto do BI).
const EMPLOYEE_MONTH_HEADERS = ['employeeId', 'mes', 'dataJson', 'updatedByEmail', 'updatedAt'];
const EMP_SNAP_NUM = ['salario', 'adSalarial', 'horasExtras', 'adicionalNoturno', 'fgts', 'inss', 'irrf', 'salarioFamilia', 'quebra', 'vt', 'vr', 'ferias', 'decimoTerceiro', 'beneficios', 'valorTotal'];
function getEmployeeMonthSheet_() { return ensureSheet_('EmployeeMonthly', EMPLOYEE_MONTH_HEADERS) }
function snapFichaMes_(src) {
  const o = {
    cargo: src.cargo || 'outro', cargoOutro: src.cargoOutro || '', funcaoCargo: src.funcaoCargo || '',
    nivel: src.nivel || 'pleno', contratacao: src.contratacao || 'CLT',
    ativo: !(src.ativo === false || src.ativo === 'false')
  };
  EMP_SNAP_NUM.forEach(function (k) { o[k] = Number(src[k]) || 0 });
  return o;
}
function salvarFichaMes_(auth, employeeId, mes, snap) {
  upsertByKeys_(getEmployeeMonthSheet_(), EMPLOYEE_MONTH_HEADERS, ['employeeId', 'mes'], {
    employeeId: employeeId, mes: mes, dataJson: JSON.stringify(snap),
    updatedByEmail: auth ? auth.email : '', updatedAt: new Date().toISOString()
  });
}
function getEmployeeMonth_(employeeId, mes) {
  if (!employeeId || !/^\d{4}-\d{2}$/.test(mes || '')) return { ok: false, error: 'invalid_args' };
  const row = sheetToObjects_(getEmployeeMonthSheet_()).find(function (r) { return r.employeeId === employeeId && r.mes === mes });
  let snapshot = null;
  if (row) { try { snapshot = JSON.parse(row.dataJson) } catch (e) { snapshot = null } }
  return { ok: true, snapshot: snapshot, closed: isMonthClosed_('rh', mes) };
}
// todas as fichas gravadas de UM mês (pra lista de Colaboradores ler o mês inteiro numa chamada só)
function getEmployeesMonth_(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes || '')) return { ok: false, error: 'invalid_month' };
  const items = [];
  sheetToObjects_(getEmployeeMonthSheet_()).forEach(function (r) {
    if (r.mes !== mes) return;
    let snap = null;
    try { snap = JSON.parse(r.dataJson) } catch (e) { snap = null }
    if (snap) items.push({ employeeId: r.employeeId, snapshot: snap });
  });
  return { ok: true, items: items, closed: isMonthClosed_('rh', mes) };
}
// fecha o RH de um mês: congela a ficha de quem tem ficha NAQUELE mês e ainda não tem foto
function congelarFichasRh_(auth, mes) {
  const jaTem = {};
  sheetToObjects_(getEmployeeMonthSheet_()).forEach(function (r) { if (r.mes === mes) jaTem[r.employeeId] = true });
  getEmployees_().items.forEach(function (e) {
    if (jaTem[e.id]) return;
    if (String(e.mesReferencia || '').slice(0, 7) !== mes) return;
    salvarFichaMes_(auth, e.id, mes, snapFichaMes_(e));
  });
}

function saveEmployee_(body, auth) {
  const mes = String(body.mesReferencia || '').slice(0, 7);
  const mesValido = /^\d{4}-\d{2}$/.test(mes);
  // mês de RH fechado: só o dono altera
  if (mesValido && auth && auth.role !== 'owner' && isMonthClosed_('rh', mes)) {
    return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  }
  const id = body.id || Utilities.getUuid();
  const existente = body.id ? sheetToObjects_(getEmployeesSheet_()).find(function (r) { return r.id === body.id }) : null;
  const mesAtualFicha = existente ? String(existente.mesReferencia || '').slice(0, 7) : '';
  // edição de um mês ANTERIOR ao da ficha atual: só a foto daquele mês é gravada (a ficha atual não é sobrescrita)
  const soHistorico = !!(mesValido && mesAtualFicha && mes < mesAtualFicha);
  if (!soHistorico) {
    upsertByKeys_(getEmployeesSheet_(), EMPLOYEE_HEADERS, ['id'], {
      id: id,
      nome: body.nome || '',
      cargo: FREELANCER_SECTORS.indexOf(body.cargo) >= 0 ? body.cargo : 'outro',
      cargoOutro: body.cargoOutro || '',
      nivel: ['junior', 'pleno', 'senior'].indexOf(body.nivel) >= 0 ? body.nivel : 'pleno',
      contratacao: body.contratacao || 'CLT',
      mesReferencia: body.mesReferencia || '',
      salario: Number(body.salario) || 0, adSalarial: Number(body.adSalarial) || 0, horasExtras: Number(body.horasExtras) || 0,
      adicionalNoturno: Number(body.adicionalNoturno) || 0, fgts: Number(body.fgts) || 0, inss: Number(body.inss) || 0,
      irrf: Number(body.irrf) || 0, salarioFamilia: Number(body.salarioFamilia) || 0, quebra: Number(body.quebra) || 0,
      vt: Number(body.vt) || 0, vr: Number(body.vr) || 0, ferias: Number(body.ferias) || 0, decimoTerceiro: Number(body.decimoTerceiro) || 0,
      beneficios: Number(body.beneficios) || 0, valorTotal: Number(body.valorTotal) || 0,
      ativo: body.ativo !== false,
      horarioSemanalJson: Array.isArray(body.horarioSemanal) ? JSON.stringify(body.horarioSemanal) : '',
      feriasInicio: body.feriasInicio || '', feriasFim: body.feriasFim || '',
      dataAdmissao: body.dataAdmissao || '', dataDesligamento: body.dataDesligamento || '',
      tipoDesligamento: TIPO_DESLIGAMENTO.indexOf(body.tipoDesligamento) >= 0 ? body.tipoDesligamento : '',
      desligamentoObs: body.desligamentoObs || '', valorRescisao: Number(body.valorRescisao) || 0,
      funcaoCargo: FUNCAO_CARGO_VALORES.indexOf(body.funcaoCargo) >= 0 ? body.funcaoCargo : ''
    });
  }
  if (mesValido) salvarFichaMes_(auth, id, mes, snapFichaMes_(body));
  return { ok: true, id: id, soHistorico: soHistorico };
}

function getEmployeeDocsSheet_() { return ensureSheet_('EmployeeDocs', EMPLOYEE_DOC_HEADERS) }

// Mesma pasta-por-propriedade-de-script que getMeterFolder_() já usa, só apontando
// pra outro nome/pasta — documento de colaborador é sensível (RH), pasta separada
// das fotos de medidor de propósito.
function getEmployeeDocsFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('EMPLOYEE_DOCS_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId) } catch (e) { /* pasta apagada — recria abaixo */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const root = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = 'Documentos de colaboradores — Seu Justino BI';
  const existing = root.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(name);
  props.setProperty('EMPLOYEE_DOCS_FOLDER_ID', folder.getId());
  return folder;
}

function uploadEmployeeDoc_(auth, body) {
  if (!body.employeeId) return { ok: false, error: 'missing_employee' };
  if (!body.fileBase64) return { ok: false, error: 'missing_file' };
  const employee = sheetToObjects_(getEmployeesSheet_()).find(function (r) { return r.id === body.employeeId });
  if (!employee) return { ok: false, error: 'employee_not_found' };
  const bytes = Utilities.base64Decode(body.fileBase64);
  const safeName = String(body.fileName || 'arquivo').replace(/[\\/]/g, '-');
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const prefix = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') + '_' + String(employee.nome || 'colaborador').replace(/[\\/]/g, '-') + '_';
  const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', prefix + safeName);
  const file = getEmployeeDocsFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const id = Utilities.getUuid();
  getEmployeeDocsSheet_().appendRow([id, body.employeeId, safeName, file.getUrl(), body.uploadedByName || '', new Date().toISOString()]);
  return { ok: true, id: id, url: file.getUrl(), fileName: safeName };
}

function getEmployeeDocs_(employeeId) {
  const rows = sheetToObjects_(getEmployeeDocsSheet_()).filter(function (r) { return !employeeId || r.employeeId === employeeId });
  rows.sort(function (a, b) { return (a.uploadedAt < b.uploadedAt ? 1 : -1) });
  return {
    ok: true,
    items: rows.map(function (r) {
      return { id: r.id, employeeId: r.employeeId, fileName: r.fileName, url: r.url, uploadedByName: r.uploadedByName, uploadedAt: r.uploadedAt };
    })
  };
}

function deleteEmployeeDoc_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEmployeeDocsSheet_();
  const existing = sheetToObjects_(sh).find(function (r) { return r.id === id });
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed && existing && existing.url) {
    try {
      const m = existing.url.match(/[-\w]{25,}/);
      if (m) DriveApp.getFileById(m[0]).setTrashed(true);
    } catch (e) { /* arquivo já sumiu do Drive por fora — segue o apagar do registro mesmo assim */ }
  }
  if (removed) logDeletion_(auth, 'employeeDoc', existing ? existing.fileName : '', 'rh', 'Documento de colaborador apagado — ' + (existing ? existing.fileName : id), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

function deleteEmployee_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEmployeesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'employee', '', 'rh', 'Colaborador apagado — ' + (existing ? existing.nome : ''), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

function getActiveCltCountBySector_() { return getActiveCountBySector_('CLT') }

// 08/10, pedido do Renato: INT e PJ passaram a entrar na sugestão de freelancer
// (antes só CLT contava como "mão de obra própria" — sugestão ficava inflada
// ignorando quem já estava escalado como INT/PJ). Comentário antigo ("só
// informativo, não entra na sugestão") não vale mais — ver freelancerSuggestion no
// HTML, que agora soma clt+int+pj antes de descontar ausência/férias.
function getActiveCountBySector_(tipo) {
  const rows = sheetToObjects_(getEmployeesSheet_());
  const count = {};
  FREELANCER_SECTORS.forEach(s => { count[s] = 0 });
  rows.forEach(r => {
    const ativo = !(r.ativo === false || r.ativo === 'false');
    const isTipo = (r.contratacao || 'CLT') === tipo;
    if (ativo && isTipo && FREELANCER_SECTORS.indexOf(r.cargo) >= 0) count[r.cargo]++;
  });
  return count;
}

// Lê a planilha uma vez só e grava tudo numa chamada só (era uma leitura + uma
// gravação POR SETOR — 14 idas ao Google Sheets — e isso passava dos 20s de tempo
// limite do app, aparecendo como "falha ao conectar" mesmo sem travar de verdade).
function saveSectorBase_(rows) {
  if (!Array.isArray(rows)) return { ok: false, error: 'invalid_rows' };
  const sh = getSectorBaseSheet_();
  const bySector = {};
  sheetToObjects_(sh).forEach(r => { bySector[r.sector] = r });
  rows.forEach(r => {
    if (FREELANCER_SECTORS.indexOf(r.sector) < 0) return;
    bySector[r.sector] = {
      sector: r.sector,
      atendimentoPorPessoa: Math.max(1, Number(r.atendimentoPorPessoa) || 1),
      clt: Math.max(0, Number(r.clt) || 0),
      brigadaPadrao: Math.max(0, Number(r.brigadaPadrao) || 0),
      limiteBrigada: Math.max(0, Math.round(Number(r.limiteBrigada) || 0))
    };
  });
  const values = FREELANCER_SECTORS.map(s => {
    const r = bySector[s] || { sector: s, atendimentoPorPessoa: 1, clt: 0, brigadaPadrao: 0, limiteBrigada: 0 };
    return SECTOR_BASE_HEADERS.map(h => r[h]);
  });
  sh.getRange(2, 1, values.length, SECTOR_BASE_HEADERS.length).setValues(values);
  return { ok: true };
}

// ---------- Reservas do dia (alimenta sugestão de freelancer) ----------

function getReservationEntriesSheet_() { return ensureSheet_('ReservationEntries', RESERVATION_ENTRY_HEADERS) }

// Lista de convidados vem como texto (um nome por linha) do front — limpa linhas
// vazias e ordena alfabeticamente aqui pra garantir que fica sempre assim gravado,
// não importa por onde a reserva entrou (única, lote ou edição).
function normalizeConvidados_(raw) {
  if (!raw) return '';
  return String(raw).split('\n').map(function (s) { return s.trim() }).filter(Boolean)
    .sort(function (a, b) { return a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }) }).join('\n');
}

// Idempotência: o front manda um clientRequestId gerado uma vez só por tentativa de
// envio (reaproveitado em qualquer reenvio automático, ex. botão "Enviar novamente"
// do overlay). Se a mesma tentativa chegar de novo — porque o servidor processou mas
// a resposta se perdeu no meio do caminho (o "Página não encontrada" intermitente do
// Apps Script) — devolve a reserva já gravada em vez de criar uma segunda.
function submitReservationEntry_(auth, body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  if (auth.role !== 'owner' && isMonthClosed_('reservas', body.date.slice(0, 7))) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  const sh = getReservationEntriesSheet_();
  if (body.clientRequestId) {
    const dup = sheetToObjects_(sh).find(r => r.clientRequestId && r.clientRequestId === body.clientRequestId);
    if (dup) return { ok: true, id: dup.id };
  }
  const pax = Math.max(1, Math.round(Number(body.pax) || 0));
  const tipo = RESERVATION_TIPOS.indexOf(body.tipo) >= 0 ? body.tipo : 'normal';
  const id = Utilities.getUuid();
  sh.appendRow([
    id, body.date, pax, tipo, body.nomeCliente || '', body.telefone || '', body.email || '', body.observacao || '',
    body.submittedByName || '', new Date().toISOString(), normalizeConvidados_(body.convidados), body.clientRequestId || '',
    normOrigem_(body.origem), normOrigem_(body.origem) === 'instagram' ? String(body.ativacaoId || '') : '', normHora_(body.hora)
  ]);
  return { ok: true, id: id };
}

// Envia várias reservas de uma vez (lista montada na tela antes de enviar) — uma
// gravação só, em vez de uma chamada por reserva. Mesma idempotência por item.
function submitReservationEntriesBatch_(auth, items) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'empty' };
  const sh = getReservationEntriesSheet_();
  const existing = sheetToObjects_(sh);
  const now = new Date().toISOString();
  const rows = [];
  let jaGravadas = 0, bloqueadas = 0;
  items.forEach(it => {
    if (!it.date) return;
    if (auth.role !== 'owner' && isMonthClosed_('reservas', it.date.slice(0, 7))) { bloqueadas++; return; }
    if (it.clientRequestId && existing.some(r => r.clientRequestId && r.clientRequestId === it.clientRequestId)) { jaGravadas++; return; }
    const pax = Math.max(1, Math.round(Number(it.pax) || 0));
    const tipo = RESERVATION_TIPOS.indexOf(it.tipo) >= 0 ? it.tipo : 'normal';
    rows.push([
      Utilities.getUuid(), it.date, pax, tipo, it.nomeCliente || '', it.telefone || '', it.email || '', it.observacao || '',
      it.submittedByName || '', now, normalizeConvidados_(it.convidados), it.clientRequestId || '',
      normOrigem_(it.origem), normOrigem_(it.origem) === 'instagram' ? String(it.ativacaoId || '') : '', normHora_(it.hora)
    ]);
  });
  if (!rows.length) return (jaGravadas || bloqueadas) ? { ok: true, count: 0, bloqueadas: bloqueadas } : { ok: false, error: 'nothing_to_submit' };
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, RESERVATION_ENTRY_HEADERS.length).setValues(rows);
  return { ok: true, count: rows.length, bloqueadas: bloqueadas };
}

function getReservationEntriesList_(limit) {
  const rows = sheetToObjects_(getReservationEntriesSheet_());
  // 03/10 — achado da auditoria: submitReservationEntriesBatch_ grava o MESMO
  // submittedAt pra todo o lote (calculado 1x fora do forEach), então reservas
  // enviadas juntas pela Grade semanal empatam sempre — e o comparador antigo nem
  // tratava empate (nunca retornava 0), o que deixa Array.sort livre pra reordenar de
  // um jeito instável. __row (ordem física = ordem real de inserção) resolve os dois.
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.submittedAt !== b.submittedAt) return (a.submittedAt || '') < (b.submittedAt || '') ? 1 : -1;
    return b.__row - a.__row;
  });
  return {
    ok: true,
    items: rows.slice(0, limit).map(r => ({
      id: r.id, date: r.date, pax: Number(r.pax) || 0, tipo: r.tipo || 'normal',
      nomeCliente: r.nomeCliente || '', telefone: r.telefone || '', email: r.email || '', observacao: r.observacao || '',
      submittedByName: r.submittedByName || '', submittedAt: r.submittedAt || '', convidados: r.convidados || '',
      origem: normOrigem_(r.origem), ativacaoId: r.ativacaoId || '', hora: normHora_(r.hora)
    }))
  };
}

function updateReservationEntry_(auth, body) {
  if (!body.id) return { ok: false, error: 'missing_id' };
  if (!body.date) return { ok: false, error: 'missing_date' };
  const sh = getReservationEntriesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === body.id);
  if (!existing) return { ok: false, error: 'not_found' };
  // trava tanto o mês de origem quanto o de destino - não dá pra "tirar" uma reserva
  // de um mês fechado mudando a data, nem lançar direto num mês já fechado.
  if (auth.role !== 'owner' && (isMonthClosed_('reservas', existing.date.slice(0, 7)) || isMonthClosed_('reservas', body.date.slice(0, 7)))) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  const pax = Math.max(1, Math.round(Number(body.pax) || 0));
  const tipo = RESERVATION_TIPOS.indexOf(body.tipo) >= 0 ? body.tipo : 'normal';
  upsertByKeys_(sh, RESERVATION_ENTRY_HEADERS, ['id'], {
    id: body.id, date: body.date, pax: pax, tipo: tipo,
    nomeCliente: body.nomeCliente || '', telefone: body.telefone || '', email: body.email || '',
    observacao: body.observacao || '', submittedByName: body.submittedByName || existing.submittedByName || '',
    submittedAt: existing.submittedAt, convidados: normalizeConvidados_(body.convidados),
    clientRequestId: existing.clientRequestId || '',
    origem: normOrigem_(body.origem), ativacaoId: normOrigem_(body.origem) === 'instagram' ? String(body.ativacaoId || '') : '', hora: normHora_(body.hora)
  });
  return { ok: true };
}

function deleteReservationEntry_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getReservationEntriesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  if (existing && auth.role !== 'owner' && isMonthClosed_('reservas', existing.date.slice(0, 7))) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'reservation', existing ? existing.date : '', 'reservas', 'Reserva apagada — ' + (existing ? (existing.nomeCliente || existing.pax + ' pax') : ''), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

// Quadro geral por dia — soma sozinho a partir de cada reserva lançada. Mantém o
// mesmo formato de resposta de antes (date/pax/happyHour/despedida/aniversario) pra
// não precisar mexer em quem já consome isso (sugestão de freelancer, grade semanal).
function getReservations_(limit) {
  const rows = sheetToObjects_(getReservationEntriesSheet_());
  const byDate = {};
  rows.forEach(r => {
    const d = r.date;
    if (!d) return;
    if (!byDate[d]) byDate[d] = { date: d, pax: 0, happyHour: 0, despedida: 0, aniversario: 0, submittedAt: '', porHora: {} };
    byDate[d].pax += Number(r.pax) || 0;
    const hh = normHora_(r.hora);
    if (hh) byDate[d].porHora[hh] = (byDate[d].porHora[hh] || 0) + (Number(r.pax) || 0);
    if (r.tipo === 'happyHour') byDate[d].happyHour++;
    else if (r.tipo === 'despedida') byDate[d].despedida++;
    else if (r.tipo === 'aniversario') byDate[d].aniversario++;
    if ((r.submittedAt || '') > byDate[d].submittedAt) byDate[d].submittedAt = r.submittedAt || '';
  });
  const docs = Object.keys(byDate).map(d => byDate[d]).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { ok: true, docs: docs.slice(0, limit) };
}

function getMonthClosuresSheet_() { return ensureSheet_('MonthClosures', MONTH_CLOSURE_HEADERS) }

function closeMonth_(auth, area, monthKey) {
  if (MONTH_CLOSURE_AREAS.indexOf(area) < 0) return { ok: false, error: 'invalid_area' };
  if (!/^\d{4}-\d{2}$/.test(monthKey || '')) return { ok: false, error: 'invalid_month' };
  const id = Utilities.getUuid();
  getMonthClosuresSheet_().appendRow([id, area, monthKey, auth.email, new Date().toISOString()]);
  if (area === 'rh') { try { congelarFichasRh_(auth, monthKey) } catch (e) { /* o fechamento já foi gravado; congelar é complementar */ } }
  return { ok: true, id: id };
}

function getMonthClosures_(area) {
  const rows = sheetToObjects_(getMonthClosuresSheet_()).filter(r => !area || r.area === area);
  rows.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
  return { ok: true, items: rows.map(r => ({ id: r.id, area: r.area, monthKey: r.monthKey, closedByEmail: r.closedByEmail, closedAt: r.closedAt })) };
}

// Mês fechado trava edição pra todo mundo, MENOS o dono (diretor) — mudança dele em
// mês fechado já É a aprovação/solicitação atendida na hora, não precisa de fluxo
// separado. Pra destravar pra equipe normal, o dono reabre o mês (reopenMonth_).
function isMonthClosed_(area, monthKey) {
  return sheetToObjects_(getMonthClosuresSheet_()).some(r => r.area === area && r.monthKey === monthKey);
}

// Só o dono chama isso (checado no roteamento) — reabre o mês pra equipe voltar a
// editar normalmente. Reabertura em si já fica registrada (MonthClosures perde a
// linha, mas o "quem fechou quando" de antes só existe no log de execução do Apps
// Script - aceitável pro que é: destravar, não um histórico de auditoria à parte).
function reopenMonth_(auth, area, monthKey) {
  const sh = getMonthClosuresSheet_();
  const rows = sheetToObjects_(sh).filter(r => r.area === area && r.monthKey === monthKey);
  if (!rows.length) return { ok: false, error: 'not_closed' };
  rows.map(r => r.__row).sort((a, b) => b - a).forEach(rowNum => sh.deleteRow(rowNum));
  return { ok: true };
}

// ---------- Freelancers (solicitação → aprovação RH → confirmação de presença) ----------

function getFreelancerSheet_() { return ensureSheet_('FreelancerRequests', FREELANCER_HEADERS) }

function submitFreelancerRequest_(auth, body) {
  if (FREELANCER_SECTORS.indexOf(body.sector) < 0) return { ok: false, error: 'invalid_sector' };
  if (!body.date) return { ok: false, error: 'missing_date' };
  const reason = FREELANCER_REASONS.indexOf(body.reason) >= 0 ? body.reason : 'demanda';
  const shiftHours = Number(body.shiftHours);
  const payPerPerson = FREELANCER_PAY_TABLE[shiftHours];
  if (!payPerPerson) return { ok: false, error: 'invalid_shift' };
  const qty = Math.max(1, Math.round(Number(body.qty) || 0));
  const totalCost = qty * payPerPerson;
  const id = Utilities.getUuid();
  getFreelancerSheet_().appendRow([
    id, body.date, body.sector, reason, shiftHours, qty, payPerPerson, totalCost, body.note || '',
    auth.email, new Date().toISOString(), 'pendente', '', '', '',
    '', '', '', '', '', '', '', ''
  ]);
  return { ok: true, id: id };
}

// Envia a semana inteira (grade dia × setor) numa gravação só — evita 40+ chamadas
// separadas (uma por célula preenchida) e o risco de estourar o tempo limite.
function submitFreelancerRequestsBatch_(auth, items) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'empty' };
  const now = new Date().toISOString();
  const rows = [];
  items.forEach(it => {
    if (FREELANCER_SECTORS.indexOf(it.sector) < 0) return;
    if (!it.date) return;
    const shiftHours = Number(it.shiftHours);
    const payPerPerson = FREELANCER_PAY_TABLE[shiftHours];
    if (!payPerPerson) return;
    const qty = Math.max(0, Math.round(Number(it.qty) || 0));
    if (qty <= 0) return;
    const reason = FREELANCER_REASONS.indexOf(it.reason) >= 0 ? it.reason : 'demanda';
    rows.push([
      // 29/09: bug real corrigido — faltavam as 3 colunas do final (horaEntrada/
      // horaSaida/horaPausa, adicionadas mais cedo hoje) aqui. sh.getRange(...).setValues()
      // exige array do MESMO tamanho da largura pedida (diferente de appendRow, que é
      // tolerante) — 20 valores contra um range de 23 colunas (FREELANCER_HEADERS.length)
      // estourava exceção, o doPost engolia em {ok:false,...} e a tela só mostrava
      // "Não consegui enviar" sem detalhe (reportado pelo Renato: grade de sábado, 10
      // itens, "Enviar semana" falhando). Mesma classe de bug já vista e documentada em
      // 26/09 (attendanceNote faltando) — aconteceu de novo com as colunas novas.
      Utilities.getUuid(), it.date, it.sector, reason, shiftHours, qty, payPerPerson, qty * payPerPerson, it.note || '',
      // 23/10: 1 freelancer por linha — a solicitação semanal manda qty 1 com o horário sugerido de cada um
      auth.email, now, 'pendente', '', '', '', '', '', '', '',
      String(it.freelancerNames || '').trim(), String(it.horaEntrada || ''), String(it.horaSaida || ''), String(it.horaPausa || '')
    ]);
  });
  if (!rows.length) return { ok: false, error: 'nothing_to_submit' };
  const sh = getFreelancerSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, FREELANCER_HEADERS.length).setValues(rows);
  return { ok: true, count: rows.length };
}

function getFreelancerRequests_() {
  const rows = sheetToObjects_(getFreelancerSheet_());
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, date: r.date, sector: r.sector, reason: r.reason || 'demanda', shiftHours: Number(r.shiftHours), qty: Number(r.qty),
      payPerPerson: Number(r.payPerPerson), totalCost: Number(r.totalCost), note: r.note || '',
      requestedByEmail: r.requestedByEmail, requestedAt: r.requestedAt, status: r.status || 'pendente',
      decidedByEmail: r.decidedByEmail || '', decidedAt: r.decidedAt || '', decisionNote: r.decisionNote || '',
      attendance: r.attendance || '', attendanceByEmail: r.attendanceByEmail || '',
      attendanceAt: r.attendanceAt || '', attendanceNote: r.attendanceNote || '',
      freelancerNames: r.freelancerNames || '',
      horaEntrada: r.horaEntrada || '', horaSaida: r.horaSaida || '', horaPausa: r.horaPausa || ''
    }))
  };
}

// 23/10: a aprovação do RH travava. Causas tratadas aqui: (a) regravava a LINHA INTEIRA (23 colunas) por pedido, podendo sobrescrever
// uma edição simultânea do gerente (nome/horário) e disputando a planilha quando várias aprovações disparavam juntas; (b) cada aprovação em
// lote relia a planilha inteira. Agora grava só as 4 colunas da decisão (status, quem, quando, nota), sob trava, e há uma ação em lote.
function decideFreelancerRequest_(auth, id, approve, note) {
  if (!id) return { ok: false, error: 'missing_id' };
  const r = decideFreelancerRequestsBatch_(auth, [id], approve, note);
  if (!r.ok) return r;
  return r.count ? { ok: true } : { ok: false, error: 'not_found' };
}
function decideFreelancerRequestsBatch_(auth, ids, approve, note) {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'empty' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000) } catch (e) { return { ok: false, error: 'busy', detail: 'Planilha ocupada, tente de novo em alguns segundos.' } }
  try {
    const sh = getFreelancerSheet_();
    const porId = {};
    sheetToObjects_(sh).forEach(function (r) { porId[r.id] = r });
    const agora = new Date().toISOString();
    let count = 0, notFound = 0;
    ids.forEach(function (id) {
      const row = porId[id];
      if (!row) { notFound++; return }
      sh.getRange(row.__row, 12, 1, 4).setValues([[approve ? 'aprovado' : 'recusado', auth.email, agora, note || '']]); // colunas 12–15
      count++;
    });
    return { ok: true, count: count, notFound: notFound };
  } finally { lock.releaseLock() }
}
// Separa um pedido com qty > 1 em N pedidos de 1 pessoa (um freelancer por linha, cada um com nome/horário próprios).
function splitFreelancerRequest_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000) } catch (e) { return { ok: false, error: 'busy' } }
  try {
    const sh = getFreelancerSheet_();
    const row = sheetToObjects_(sh).find(function (r) { return r.id === id });
    if (!row) return { ok: false, error: 'not_found' };
    const qty = Math.max(1, Math.round(Number(row.qty) || 1));
    if (qty <= 1) return { ok: true, count: 0 };
    const pay = Number(row.payPerPerson) || 0;
    const nomes = String(row.freelancerNames || '').split(/\n|,/).map(function (t) { return t.trim() }).filter(Boolean);
    sh.getRange(row.__row, 6, 1, 3).setValues([[1, pay, pay]]);          // qty, payPerPerson, totalCost
    sh.getRange(row.__row, 20, 1, 1).setValues([[nomes[0] || '']]);      // freelancerNames
    const novas = [];
    for (let i = 1; i < qty; i++) {
      novas.push(FREELANCER_HEADERS.map(function (h) {
        if (h === 'id') return Utilities.getUuid();
        if (h === 'qty') return 1;
        if (h === 'totalCost') return pay;
        if (h === 'freelancerNames') return nomes[i] || '';
        if (h === 'attendance' || h === 'attendanceByEmail' || h === 'attendanceAt' || h === 'attendanceNote') return row[h] || '';
        return row[h] !== undefined && row[h] !== null ? row[h] : '';
      }));
    }
    sh.getRange(sh.getLastRow() + 1, 1, novas.length, FREELANCER_HEADERS.length).setValues(novas);
    return { ok: true, count: novas.length };
  } finally { lock.releaseLock() }
}

// Só pode marcar presença de pedido já aprovado — evita confirmar presença de algo
// que o RH nunca liberou.
function markFreelancerAttendance_(auth, id, attended, note) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getFreelancerSheet_();
  const row = sheetToObjects_(sh).find(r => r.id === id);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'aprovado') return { ok: false, error: 'not_approved' };
  // attended pode vir ausente (só salvando observação a meio do turno, antes de
  // confirmar presença) — nesse caso preserva o status de presença já gravado em vez
  // de forçar "faltou" (que era o que `attended ? ... : 'faltou'` fazia antes, um bug
  // que marcaria falta sozinho só por salvar uma observação).
  const novoAttendance = typeof attended === 'boolean' ? (attended ? 'compareceu' : 'faltou') : (row.attendance || '');
  const novaNote = note !== undefined ? note : (row.attendanceNote || '');
  sh.getRange(row.__row, 1, 1, FREELANCER_HEADERS.length).setValues([[
    row.id, row.date, row.sector, row.reason, row.shiftHours, row.qty, row.payPerPerson, row.totalCost, row.note,
    row.requestedByEmail, row.requestedAt, row.status, row.decidedByEmail, row.decidedAt, row.decisionNote,
    novoAttendance, auth.email, new Date().toISOString(), novaNote, row.freelancerNames || '',
    row.horaEntrada || '', row.horaSaida || '', row.horaPausa || ''
  ]]);
  return { ok: true };
}

// Nomes dos freelancers que vão cobrir esse pedido (o pedido em si é só
// setor+quantidade, sem identidade — o Gerente Operador preenche o nome de cada
// um aqui, na Escala completa do dia, quando já souber quem vai vir). Texto
// livre (o gerente escreve "João, Maria" ou um nome por linha, como preferir) -
// não tenta validar contra nenhum cadastro porque freelancer não tem cadastro
// de colaborador (só CLT tem).
// body pode trazer só o nome (compatível com o uso antigo) ou nome + horário
// confirmado (Escala do dia unificada, 28/09) — o que não vier mantém o que já
// estava salvo (nunca apaga um horário confirmado só porque só o nome foi reenviado).
function setFreelancerNames_(auth, id, names, horaEntrada, horaSaida, horaPausa) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getFreelancerSheet_();
  const row = sheetToObjects_(sh).find(r => r.id === id);
  if (!row) return { ok: false, error: 'not_found' };
  sh.getRange(row.__row, 1, 1, FREELANCER_HEADERS.length).setValues([[
    row.id, row.date, row.sector, row.reason, row.shiftHours, row.qty, row.payPerPerson, row.totalCost, row.note,
    row.requestedByEmail, row.requestedAt, row.status, row.decidedByEmail || '', row.decidedAt || '', row.decisionNote || '',
    row.attendance || '', row.attendanceByEmail || '', row.attendanceAt || '', row.attendanceNote || '', String(names || '').trim(),
    horaEntrada !== undefined ? String(horaEntrada || '') : (row.horaEntrada || ''),
    horaSaida !== undefined ? String(horaSaida || '') : (row.horaSaida || ''),
    horaPausa !== undefined ? String(horaPausa || '') : (row.horaPausa || '')
  ]]);
  return { ok: true };
}

function deleteFreelancerRequest_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getFreelancerSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) {
    const label = existing ? (FREELANCER_SECTOR_LABEL[existing.sector] || existing.sector) + ' — ' + existing.date : '';
    logDeletion_(auth, 'freelancer', existing ? existing.date : '', 'operacao', 'Solicitação de freelancer apagada — ' + label, existing);
  }
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

// Conta como custo do dia: aprovado e não marcado como falta (pendente de
// confirmação ainda entra — só sai da conta se alguém confirmar que faltou).
function getApprovedFreelancerCostByDate_() {
  const rows = sheetToObjects_(getFreelancerSheet_()).filter(r => r.status === 'aprovado' && r.attendance !== 'faltou');
  const byDate = {};
  rows.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + (Number(r.totalCost) || 0) });
  return byDate;
}

function getDeletionsSheet_() { return ensureSheet_('Deletions', DELETIONS_HEADERS) }

function logDeletion_(auth, kind, refDate, area, summary, payload) {
  getDeletionsSheet_().appendRow([
    Utilities.getUuid(), new Date().toISOString(), auth.email, kind, refDate || '', area || '', summary || '', JSON.stringify(payload || {})
  ]);
  // 29/09: todo apagar também entra na trilha de auditoria unificada — "Histórico de
  // exclusões" (Diretoria) continua existindo do jeito que sempre foi (lê só daqui,
  // sem mudança), a aba nova de Auditoria é que passa a enxergar isso também, junto
  // com criar/editar.
  logAudit_(auth, 'delete', area, kind, refDate || '', summary, payload, null);
}

function getDeletionsLog_() {
  const rows = sheetToObjects_(getDeletionsSheet_());
  rows.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  return {
    ok: true,
    items: rows.slice(0, 300).map(r => ({
      deletedAt: r.deletedAt, deletedByEmail: r.deletedByEmail, kind: r.kind,
      refDate: r.refDate, area: r.area, summary: r.summary, payload: safeParse_(r.payloadJson, {})
    }))
  };
}

function getAuditSheet_() { return ensureSheet_('Audit', AUDIT_HEADERS) }

// Chamado do roteamento (doPost), sempre DEPOIS de confirmar que a ação deu certo —
// nunca registra tentativa que falhou. before/after ficam como vieram (objeto ou
// null) e viram JSON; alguns chamadores passam null de propósito pra dado sensível
// (ex.: salário) não duplicar em texto puro fora da aba que já é restrita.
function logAudit_(auth, action, area, kind, refId, summary, before, after) {
  getAuditSheet_().appendRow([
    Utilities.getUuid(), new Date().toISOString(), (auth && auth.email) || '', action, area || '', kind || '',
    String(refId || ''), summary || '', JSON.stringify(before === undefined ? null : before), JSON.stringify(after === undefined ? null : after)
  ]);
}

function getAuditLog_(limit) {
  const rows = sheetToObjects_(getAuditSheet_());
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {
    ok: true,
    items: rows.slice(0, limit || 300).map(r => ({
      at: r.at, byEmail: r.byEmail, action: r.action, area: r.area, kind: r.kind, refId: r.refId,
      summary: r.summary, before: safeParse_(r.beforeJson, null), after: safeParse_(r.afterJson, null)
    }))
  };
}

// ---------- Eventos privados/corporativos (29/09 — só Diretoria) ----------

function getEventosSheet_() { return ensureSheet_('Eventos', EVENTO_HEADERS) }

// Campos numéricos do follow-up (resto do EVENTO_FOLLOWUP_FIELDS é texto livre curto).
const EVENTO_FOLLOWUP_NUM_FIELDS = ['paxPresente', 'valorExcedente', 'valorProducao', 'valorTotal', 'comissaoCowMe', 'comissaoTimeComercial', 'comissaoPorAnalista'];

function getEventos_() {
  const rows = sheetToObjects_(getEventosSheet_());
  rows.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  return {
    ok: true,
    items: rows.map(r => {
      const item = {
        id: r.id, data: r.data || '', nomeCliente: r.nomeCliente || '', documento: r.documento || '',
        telefone: r.telefone || '', email: r.email || '',
        tipoEvento: EVENTO_TIPOS.indexOf(r.tipoEvento) >= 0 ? r.tipoEvento : 'outro',
        pax: Number(r.pax) || 0, valorContrato: Number(r.valorContrato) || 0, valorSinal: Number(r.valorSinal) || 0,
        dataSinal: r.dataSinal || '', observacao: r.observacao || '',
        status: EVENTO_STATUS.indexOf(r.status) >= 0 ? r.status : 'orcamento',
        createdByEmail: r.createdByEmail || '', createdAt: r.createdAt || '',
        updatedByEmail: r.updatedByEmail || '', updatedAt: r.updatedAt || '',
        contratoAnexoUrl: r.contratoAnexoUrl || '', contratoAnexoNome: r.contratoAnexoNome || '',
        pagamentoPendente: !!r.pagamentoPendente
      };
      EVENTO_FOLLOWUP_FIELDS.forEach(f => { item[f] = EVENTO_FOLLOWUP_NUM_FIELDS.indexOf(f) >= 0 ? (Number(r[f]) || 0) : (r[f] || '') });
      return item;
    })
  };
}

function saveEvento_(auth, body) {
  if (!body.data) return { ok: false, error: 'missing_date' };
  if (!String(body.nomeCliente || '').trim()) return { ok: false, error: 'missing_client' };
  const sh = getEventosSheet_();
  const id = body.id || Utilities.getUuid();
  const existing = body.id ? sheetToObjects_(sh).find(r => r.id === body.id) : null;
  // 03/10 — achado da auditoria: Eventos/Cotações movimentam valor de contrato mas
  // ficavam editáveis pra sempre, sem a mesma trava de mês fechado que Marketing/
  // Financeiro/RH/Operação/Reservas já têm. Checa tanto o mês de destino quanto o mês
  // original do evento (se mudar a data pra fora/dentro de um mês fechado, também trava).
  if (auth.role !== 'owner') {
    const meses = new Set([body.data.slice(0, 7)]);
    if (existing && existing.data) meses.add(existing.data.slice(0, 7));
    for (const mk of meses) {
      if (isMonthClosed_('eventos', mk)) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
    }
  }
  const row = {
    id: id, data: body.data, nomeCliente: String(body.nomeCliente || '').trim(),
    documento: String(body.documento || '').trim(), telefone: String(body.telefone || '').trim(), email: String(body.email || '').trim(),
    tipoEvento: EVENTO_TIPOS.indexOf(body.tipoEvento) >= 0 ? body.tipoEvento : 'outro',
    pax: Math.max(0, Math.round(Number(body.pax) || 0)),
    valorContrato: Number(body.valorContrato) || 0, valorSinal: Number(body.valorSinal) || 0,
    dataSinal: body.dataSinal || '', observacao: String(body.observacao || '').trim(),
    status: EVENTO_STATUS.indexOf(body.status) >= 0 ? body.status : 'orcamento',
    pagamentoPendente: !!body.pagamentoPendente,
    createdByEmail: existing ? existing.createdByEmail : auth.email,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedByEmail: auth.email, updatedAt: new Date().toISOString()
  };
  // body[f] ausente (undefined) preserva o que já tava gravado — só sobrescreve
  // quando o campo vem explicitamente no payload (mesmo se for '' ou 0, pra dar
  // pra limpar de propósito). Vale pros dois tipos, texto e numérico — um POST
  // parcial (tela antiga, ou import que só manda alguns campos) não pode apagar
  // follow-up já preenchido só por omissão.
  EVENTO_FOLLOWUP_FIELDS.forEach(f => {
    const existingVal = existing ? existing[f] : (EVENTO_FOLLOWUP_NUM_FIELDS.indexOf(f) >= 0 ? 0 : '');
    if (body[f] === undefined) { row[f] = existingVal; return }
    row[f] = EVENTO_FOLLOWUP_NUM_FIELDS.indexOf(f) >= 0 ? (Number(body[f]) || 0) : String(body[f]).trim();
  });
  // Anexo de contrato é gerido só pela ação uploadEventoContratoFile — salvar o
  // formulário normal do evento nunca mexe nisso (preserva sempre).
  row.contratoAnexoUrl = existing ? existing.contratoAnexoUrl : '';
  row.contratoAnexoNome = existing ? existing.contratoAnexoNome : '';
  upsertByKeys_(sh, EVENTO_HEADERS, ['id'], row);
  return { ok: true, id: id };
}

// Contrato anexado manualmente a um Evento (ex.: contrato antigo assinado fora
// do fluxo de Cotação/geração automática, ou eventos importados do histórico
// SJM que já têm um PDF assinado em outro lugar). Mesmo padrão de upload de
// arquivo pequeno já usado em uploadDocumentacaoFile_ — base64 direto (sem
// chunk, é só um contrato, não um PDF de 36MB) — pasta dedicada dentro da
// mesma estrutura de Contratos já usada pelos gerados automaticamente.
function getContratosAnexadosFolder_() {
  const base = getContratosFolder_();
  const name = 'Anexados';
  const existing = base.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : base.createFolder(name);
}
function uploadEventoContratoFile_(auth, body) {
  if (!body.eventoId) return { ok: false, error: 'missing_evento' };
  if (!body.fileBase64 || !body.fileName) return { ok: false, error: 'missing_file' };
  const sh = getEventosSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === body.eventoId);
  if (!existing) return { ok: false, error: 'not_found' };
  const bytes = Utilities.base64Decode(body.fileBase64);
  const safeName = String(body.fileName).replace(/[\\/]/g, '-');
  const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', safeName);
  const file = getContratosAnexadosFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  upsertByKeys_(sh, EVENTO_HEADERS, ['id'], Object.assign({}, existing, {
    contratoAnexoUrl: file.getUrl(), contratoAnexoNome: safeName,
    updatedByEmail: auth.email, updatedAt: new Date().toISOString()
  }));
  return { ok: true, url: file.getUrl(), fileName: safeName };
}

function deleteEvento_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEventosSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  if (existing && auth.role !== 'owner' && isMonthClosed_('eventos', existing.data.slice(0, 7))) {
    return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  }
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'evento', existing ? existing.data : '', 'master', 'Evento apagado — ' + (existing ? existing.nomeCliente : ''), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---------- Cotação de evento -> aprovação (só Diretoria) -> contrato gerado ----------
//
// 02/10, pedido do Renato: comercial monta a cotação (rascunho, pode editar à
// vontade), manda pra aprovação; só quem tem área 'master' (Diretoria) aprova
// ou recusa — aprovar já GERA o contrato preenchido (token no modelo em
// Drive), mas o ENVIO pro cliente é sempre um clique humano separado
// (enviarContratoEventoCotacao_), nunca automático — confirmado explicitamente
// com ele. Fluxo de status:
//   rascunho (editável) --submeter--> aguardando_aprovacao (travado)
//     --aprovar--> aprovado (contrato já gerado) --enviar--> enviado
//     --recusar--> recusado (editável de novo, pode corrigir e resubmeter)
const COTACAO_STATUS = ['rascunho', 'aguardando_aprovacao', 'aprovado', 'recusado', 'enviado'];
const COTACAO_EDITAVEL_STATUS = ['rascunho', 'recusado'];
const COTACAO_HEADERS = [
  'id', 'eventoId',
  'nomeEmpresaCliente', 'apelidoCliente', 'cnpjCliente', 'enderecoCliente', 'dataAberturaEmpresaCliente',
  'nomeResponsavel', 'emailCliente', 'telefoneCliente',
  'nomeEvento', 'dataEvento', 'horaInicio', 'horaFim', 'duracaoExtenso',
  'pax', 'paxExtenso', 'ambiente', 'atracaoContratada', 'menuDescricao',
  'valorTotal', 'valorTotalExtenso', 'formaPagamento',
  'status', 'createdByEmail', 'createdAt', 'updatedByEmail', 'updatedAt',
  'decidedByEmail', 'decidedAt', 'decisionNote',
  'contratoDocUrl', 'sentByEmail', 'sentAt'
];
const COTACAO_NUM_FIELDS = ['pax', 'valorTotal'];

function getEventoCotacoesSheet_() { return ensureSheet_('EventoCotacoes', COTACAO_HEADERS) }

function getEventoCotacoes_() {
  const rows = sheetToObjects_(getEventoCotacoesSheet_());
  rows.sort((a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : b.__row - a.__row));
  return {
    ok: true,
    items: rows.map(r => {
      const item = { status: COTACAO_STATUS.indexOf(r.status) >= 0 ? r.status : 'rascunho' };
      COTACAO_HEADERS.forEach(f => {
        if (f === 'status') return;
        item[f] = COTACAO_NUM_FIELDS.indexOf(f) >= 0 ? (Number(r[f]) || 0) : (r[f] || '');
      });
      return item;
    })
  };
}

function saveEventoCotacao_(auth, body) {
  if (!String(body.nomeEmpresaCliente || '').trim()) return { ok: false, error: 'missing_client' };
  if (!body.dataEvento) return { ok: false, error: 'missing_date' };
  const sh = getEventoCotacoesSheet_();
  const existing = body.id ? sheetToObjects_(sh).find(r => r.id === body.id) : null;
  // 03/10 — mesma trava de mês fechado aplicada em saveEvento_ (ver comentário lá).
  if (auth.role !== 'owner') {
    const meses = new Set([body.dataEvento.slice(0, 7)]);
    if (existing && existing.dataEvento) meses.add(existing.dataEvento.slice(0, 7));
    for (const mk of meses) {
      if (isMonthClosed_('eventos', mk)) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
    }
  }
  if (existing && COTACAO_EDITAVEL_STATUS.indexOf(existing.status) < 0) {
    return { ok: false, error: 'nao_editavel', status: existing.status };
  }
  const id = body.id || Utilities.getUuid();

  // Cria/atualiza o Evento correspondente (pipeline da Fase A já mostra desde
  // a fase de cotação, sem duplicar cadastro) — mantém só os campos básicos
  // em sincronia, o resto do follow-up continua editável direto na aba Eventos.
  const eventosSh = getEventosSheet_();
  const eventoId = (existing && existing.eventoId) || body.eventoId || Utilities.getUuid();
  const eventoExistente = sheetToObjects_(eventosSh).find(r => r.id === eventoId);
  const eventoRow = {
    id: eventoId, data: body.dataEvento, nomeCliente: String(body.nomeEmpresaCliente || '').trim(),
    documento: eventoExistente ? eventoExistente.documento : String(body.cnpjCliente || '').trim(),
    telefone: eventoExistente ? eventoExistente.telefone : String(body.telefoneCliente || '').trim(),
    email: eventoExistente ? eventoExistente.email : String(body.emailCliente || '').trim(),
    tipoEvento: eventoExistente ? eventoExistente.tipoEvento : 'corporativo',
    pax: Math.max(0, Math.round(Number(body.pax) || 0)),
    valorContrato: Number(body.valorTotal) || 0,
    valorSinal: eventoExistente ? eventoExistente.valorSinal : 0,
    dataSinal: eventoExistente ? eventoExistente.dataSinal : '',
    observacao: eventoExistente ? eventoExistente.observacao : '',
    status: eventoExistente ? eventoExistente.status : 'orcamento',
    createdByEmail: eventoExistente ? eventoExistente.createdByEmail : auth.email,
    createdAt: eventoExistente ? eventoExistente.createdAt : new Date().toISOString(),
    updatedByEmail: auth.email, updatedAt: new Date().toISOString()
  };
  EVENTO_FOLLOWUP_FIELDS.forEach(f => { eventoRow[f] = eventoExistente ? eventoExistente[f] : (EVENTO_FOLLOWUP_NUM_FIELDS.indexOf(f) >= 0 ? 0 : '') });
  upsertByKeys_(eventosSh, EVENTO_HEADERS, ['id'], eventoRow);

  const row = { id: id, eventoId: eventoId, status: 'rascunho' };
  ['nomeEmpresaCliente', 'apelidoCliente', 'cnpjCliente', 'enderecoCliente', 'dataAberturaEmpresaCliente',
    'nomeResponsavel', 'emailCliente', 'telefoneCliente',
    'nomeEvento', 'dataEvento', 'horaInicio', 'horaFim', 'duracaoExtenso',
    'paxExtenso', 'ambiente', 'atracaoContratada', 'menuDescricao',
    'valorTotalExtenso', 'formaPagamento'
  ].forEach(f => { row[f] = String(body[f] !== undefined ? body[f] : (existing ? existing[f] : '')).trim() });
  COTACAO_NUM_FIELDS.forEach(f => { row[f] = body[f] !== undefined ? (Number(body[f]) || 0) : (existing ? (Number(existing[f]) || 0) : 0) });
  row.createdByEmail = existing ? existing.createdByEmail : auth.email;
  row.createdAt = existing ? existing.createdAt : new Date().toISOString();
  row.updatedByEmail = auth.email;
  row.updatedAt = new Date().toISOString();
  row.decidedByEmail = existing ? existing.decidedByEmail : '';
  row.decidedAt = existing ? existing.decidedAt : '';
  row.decisionNote = existing ? existing.decisionNote : '';
  row.contratoDocUrl = existing ? existing.contratoDocUrl : '';
  row.sentByEmail = existing ? existing.sentByEmail : '';
  row.sentAt = existing ? existing.sentAt : '';
  upsertByKeys_(sh, COTACAO_HEADERS, ['id'], row);
  return { ok: true, id: id, eventoId: eventoId };
}

function submitEventoCotacaoForApproval_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEventoCotacoesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  if (!existing) return { ok: false, error: 'not_found' };
  if (COTACAO_EDITAVEL_STATUS.indexOf(existing.status) < 0) return { ok: false, error: 'nao_editavel', status: existing.status };
  upsertByKeys_(sh, COTACAO_HEADERS, ['id'], Object.assign({}, existing, {
    status: 'aguardando_aprovacao', updatedByEmail: auth.email, updatedAt: new Date().toISOString()
  }));
  return { ok: true };
}

const MESES_PT_ = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function formatarDataPorExtenso_(date) {
  return date.getDate() + ' de ' + MESES_PT_[date.getMonth()] + ' de ' + date.getFullYear();
}
function formatarDataBr_(isoDate) {
  if (!isoDate) return '';
  const p = isoDate.split('-');
  return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : isoDate;
}
function formatarMoedaBr_(n) {
  const v = Number(n) || 0;
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function xmlEscape_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// SETUP (uma vez só): crie uma pasta chamada exatamente
// "Contratos — Seu Justino BI" na mesma pasta do Drive onde está esta
// planilha e coloque dentro: (1) o modelo com token, arquivo .docx chamado
// "CONTRATO JUSTINO X CLIENTE (MODELO TOKEN).docx"; (2) uma subpasta chamada
// "Gerados" (o script cria sozinha se não existir) onde cada contrato
// preenchido é salvo.
function getContratosFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('CONTRATOS_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId) } catch (e) { /* pasta apagada — recria abaixo */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const root = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = 'Contratos — Seu Justino BI';
  const existing = root.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(name);
  props.setProperty('CONTRATOS_FOLDER_ID', folder.getId());
  return folder;
}
function getContratosGeradosFolder_() {
  const base = getContratosFolder_();
  const name = 'Gerados';
  const existing = base.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : base.createFolder(name);
}
function getContratoModeloFile_() {
  const folder = getContratosFolder_();
  const files = folder.getFilesByName('CONTRATO JUSTINO X CLIENTE (MODELO TOKEN).docx');
  return files.hasNext() ? files.next() : null;
}

// Preenche o modelo token (.docx) com os dados da cotação aprovada — troca
// {{TOKEN}} por valor direto no XML do documento (word/document.xml dentro do
// zip do .docx), sem abrir no Word/Docs. Datas por extenso e valores "por
// extenso" (duração, pax, valor total) são responsabilidade de quem preenche
// a cotação — ESTE texto vai direto pro contrato, então precisa estar certo
// antes de aprovar (a tela de aprovação mostra tudo pra conferir).
function gerarContratoDocx_(cotacao) {
  const modelo = getContratoModeloFile_();
  if (!modelo) return { ok: false, error: 'modelo_nao_encontrado' };
  const hoje = new Date();
  const tokens = {
    NOME_EMPRESA_CLIENTE: cotacao.nomeEmpresaCliente, APELIDO_CLIENTE: cotacao.apelidoCliente,
    CNPJ_CLIENTE: cotacao.cnpjCliente, ENDERECO_CLIENTE: cotacao.enderecoCliente,
    DATA_ABERTURA_EMPRESA_CLIENTE: cotacao.dataAberturaEmpresaCliente,
    NOME_RESPONSAVEL_CLIENTE: cotacao.nomeResponsavel, EMAIL_CLIENTE: cotacao.emailCliente,
    TELEFONE_CLIENTE: cotacao.telefoneCliente,
    NOME_EVENTO: cotacao.nomeEvento, DATA_EVENTO_FORMATADA: formatarDataBr_(cotacao.dataEvento),
    HORA_INICIO: cotacao.horaInicio, HORA_FIM: cotacao.horaFim, DURACAO_EXTENSO: cotacao.duracaoExtenso,
    PAX_EXTENSO: cotacao.paxExtenso, AMBIENTE_LOCADO: cotacao.ambiente,
    ATRACAO_CONTRATADA: cotacao.atracaoContratada, MENU: cotacao.menuDescricao,
    VALOR_TOTAL_FORMATADO: formatarMoedaBr_(cotacao.valorTotal), VALOR_TOTAL_EXTENSO: cotacao.valorTotalExtenso,
    DATA_ASSINATURA_EXTENSO: formatarDataPorExtenso_(hoje)
  };
  const zipBlob = modelo.getBlob();
  const files = Utilities.unzip(zipBlob);
  const novosArquivos = files.map(f => {
    if (f.getName() !== 'word/document.xml') return f;
    let xml = f.getDataAsString('UTF-8');
    Object.keys(tokens).forEach(k => {
      xml = xml.split('{{' + k + '}}').join(xmlEscape_(tokens[k]));
    });
    return Utilities.newBlob(xml, 'application/xml', 'word/document.xml');
  });
  const novoZip = Utilities.zip(novosArquivos, 'contrato.docx');
  const nomeArquivo = 'Contrato - ' + cotacao.nomeEmpresaCliente + ' - ' + cotacao.dataEvento + '.docx';
  const arquivo = getContratosGeradosFolder_().createFile(novoZip.setName(nomeArquivo));
  // Sem isso, o arquivo só é visível pra própria conta do script — qualquer
  // outro usuário clicando em "Ver contrato" batia numa tela de acesso negado
  // do Drive. Mesmo padrão já usado em uploadDocumentacaoFile_ (link só é
  // mostrado dentro do BI autenticado pra quem já tem a área certa, nunca
  // publicado por fora).
  arquivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, url: arquivo.getUrl() };
}

function decideEventoCotacao_(auth, id, approve, note) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEventoCotacoesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.status !== 'aguardando_aprovacao') return { ok: false, error: 'nao_aguardando_aprovacao', status: existing.status };
  const updated = Object.assign({}, existing, {
    status: approve ? 'aprovado' : 'recusado',
    decidedByEmail: auth.email, decidedAt: new Date().toISOString(), decisionNote: String(note || '').trim()
  });
  if (approve) {
    const gerado = gerarContratoDocx_(existing);
    if (!gerado.ok) return gerado; // modelo não encontrado — não aprova sem conseguir gerar o contrato
    updated.contratoDocUrl = gerado.url;
  }
  upsertByKeys_(sh, COTACAO_HEADERS, ['id'], updated);
  return { ok: true, contratoDocUrl: updated.contratoDocUrl };
}

// Envio NUNCA acontece sozinho — só este clique explícito manda de verdade.
// replyTo fica com o e-mail de quem clicou (o BI não tem Gmail pessoal de
// cada um, só a conta própria do app — ver nota de limitação no memory.md).
function enviarContratoEventoCotacao_(auth, id, assunto, corpo) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEventoCotacoesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.status !== 'aprovado') return { ok: false, error: 'nao_aprovado', status: existing.status };
  if (!existing.contratoDocUrl) return { ok: false, error: 'sem_contrato_gerado' };
  if (!existing.emailCliente) return { ok: false, error: 'sem_email_cliente' };
  const fileId = existing.contratoDocUrl.match(/[-\w]{25,}/);
  if (!fileId) return { ok: false, error: 'url_contrato_invalida' };
  const arquivo = DriveApp.getFileById(fileId[0]);
  MailApp.sendEmail({
    to: existing.emailCliente,
    replyTo: auth.email,
    name: 'Seu Justino — Eventos',
    subject: assunto || ('Contrato — ' + existing.nomeEvento),
    body: corpo || ('Olá, segue em anexo o contrato para o evento "' + existing.nomeEvento + '".'),
    attachments: [arquivo.getBlob()]
  });
  upsertByKeys_(sh, COTACAO_HEADERS, ['id'], Object.assign({}, existing, {
    status: 'enviado', sentByEmail: auth.email, sentAt: new Date().toISOString()
  }));
  return { ok: true };
}

// ---------- Linha do tempo de interações (02/10 — mecanismo tipo RD Station) ----------
//
// Boa parte da linha do tempo já existe nos próprios registros de Eventos/
// Cotações (createdAt, decidedAt, sentAt...) — o frontend sintetiza isso na
// hora, sem chamada nova. O que faltava de verdade era anotar uma interação
// MANUAL ("liguei pro cliente", "mandei WhatsApp") — só isso vira sheet nova.
// Histórico, por natureza: só cria e apaga (admin, por engano), não edita.
const INTERACAO_TIPOS = ['nota', 'ligacao', 'reuniao', 'email', 'whatsapp'];
const INTERACAO_HEADERS = ['id', 'eventoId', 'tipo', 'texto', 'createdByEmail', 'createdAt'];

function getEventoInteracoesSheet_() { return ensureSheet_('EventoInteracoes', INTERACAO_HEADERS) }

function getEventoInteracoes_(eventoId) {
  const rows = sheetToObjects_(getEventoInteracoesSheet_()).filter(r => !eventoId || r.eventoId === eventoId);
  // Desempate por __row (ordem física na planilha = ordem de inserção) quando
  // createdAt bate igual — achado real via teste: 2 interações criadas no
  // mesmo milissegundo (loop rápido) voltavam na ordem errada, a mais nova
  // não aparecia primeiro.
  rows.sort((a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : b.__row - a.__row));
  return { ok: true, items: rows.map(r => ({ id: r.id, eventoId: r.eventoId, tipo: r.tipo, texto: r.texto, createdByEmail: r.createdByEmail, createdAt: r.createdAt })) };
}

function saveEventoInteracao_(auth, body) {
  if (!body.eventoId) return { ok: false, error: 'missing_evento' };
  if (!String(body.texto || '').trim()) return { ok: false, error: 'missing_texto' };
  const sh = getEventoInteracoesSheet_();
  const id = Utilities.getUuid();
  upsertByKeys_(sh, INTERACAO_HEADERS, ['id'], {
    id: id, eventoId: body.eventoId,
    tipo: INTERACAO_TIPOS.indexOf(body.tipo) >= 0 ? body.tipo : 'nota',
    texto: String(body.texto).trim(), createdByEmail: auth.email, createdAt: new Date().toISOString()
  });
  return { ok: true, id: id };
}

function deleteEventoInteracao_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEventoInteracoesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'eventoInteracao', existing ? existing.eventoId : '', 'eventos', 'Interação apagada — ' + (existing ? existing.texto : ''), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---------- Tarefas/lembretes de evento (02/10 — mecanismo tipo RD Station) ----------
const TAREFA_STATUS = ['pendente', 'concluida'];
const TAREFA_HEADERS = ['id', 'eventoId', 'titulo', 'dataVencimento', 'responsavelEmail', 'status', 'createdByEmail', 'createdAt', 'concluidaEm'];

function getEventoTarefasSheet_() { return ensureSheet_('EventoTarefas', TAREFA_HEADERS) }

// Sempre devolve TODAS (não só por evento) — o widget "Hoje e atrasadas" no
// topo da aba Eventos precisa ver tudo de uma vez, cruzando todos os eventos.
function getEventoTarefas_() {
  const rows = sheetToObjects_(getEventoTarefasSheet_());
  rows.sort((a, b) => (a.dataVencimento < b.dataVencimento ? -1 : a.dataVencimento > b.dataVencimento ? 1 : 0));
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, eventoId: r.eventoId, titulo: r.titulo, dataVencimento: r.dataVencimento || '',
      responsavelEmail: r.responsavelEmail || '', status: TAREFA_STATUS.indexOf(r.status) >= 0 ? r.status : 'pendente',
      createdByEmail: r.createdByEmail, createdAt: r.createdAt, concluidaEm: r.concluidaEm || ''
    }))
  };
}

function saveEventoTarefa_(auth, body) {
  if (!body.eventoId) return { ok: false, error: 'missing_evento' };
  if (!String(body.titulo || '').trim()) return { ok: false, error: 'missing_titulo' };
  if (!body.dataVencimento) return { ok: false, error: 'missing_data' };
  const sh = getEventoTarefasSheet_();
  const existing = body.id ? sheetToObjects_(sh).find(r => r.id === body.id) : null;
  const id = body.id || Utilities.getUuid();
  upsertByKeys_(sh, TAREFA_HEADERS, ['id'], {
    id: id, eventoId: body.eventoId, titulo: String(body.titulo).trim(),
    dataVencimento: body.dataVencimento, responsavelEmail: String(body.responsavelEmail || '').trim(),
    status: existing ? existing.status : 'pendente',
    createdByEmail: existing ? existing.createdByEmail : auth.email,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    concluidaEm: existing ? existing.concluidaEm : ''
  });
  return { ok: true, id: id };
}

function concluirEventoTarefa_(auth, id, concluida) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEventoTarefasSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  if (!existing) return { ok: false, error: 'not_found' };
  upsertByKeys_(sh, TAREFA_HEADERS, ['id'], Object.assign({}, existing, {
    status: concluida ? 'concluida' : 'pendente', concluidaEm: concluida ? new Date().toISOString() : ''
  }));
  return { ok: true };
}

function deleteEventoTarefa_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getEventoTarefasSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'eventoTarefa', existing ? existing.eventoId : '', 'eventos', 'Tarefa apagada — ' + (existing ? existing.titulo : ''), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---------- Documentação legal da casa (29/09 — só Diretoria) ----------

function getDocumentacoesSheet_() { return ensureSheet_('Documentacoes', DOCUMENTACAO_HEADERS) }

// Mesmo padrão de pasta-por-propriedade-de-script que getEmployeeDocsFolder_() já usa.
function getDocumentacoesFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('DOCUMENTACOES_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId) } catch (e) { /* pasta apagada — recria abaixo */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const root = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = 'Documentações legais — Seu Justino BI';
  const existing = root.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(name);
  props.setProperty('DOCUMENTACOES_FOLDER_ID', folder.getId());
  return folder;
}

function getDocumentacoes_() {
  const rows = sheetToObjects_(getDocumentacoesSheet_());
  // Vence primeiro em cima — quem não tem validade cadastrada (ex.: contrato sem
  // vencimento) fica no fim, não misturado com o que precisa de atenção.
  rows.sort((a, b) => (a.dataValidade || '9999-99') < (b.dataValidade || '9999-99') ? -1 : 1);
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, tipo: DOCUMENTACAO_TIPOS.indexOf(r.tipo) >= 0 ? r.tipo : 'outro', tipoOutro: r.tipoOutro || '',
      nome: r.nome || '', numero: r.numero || '', orgaoEmissor: r.orgaoEmissor || '',
      dataEmissao: r.dataEmissao || '', dataValidade: r.dataValidade || '', observacao: r.observacao || '',
      arquivoUrl: r.arquivoUrl || '', arquivoNome: r.arquivoNome || '',
      createdByEmail: r.createdByEmail || '', createdAt: r.createdAt || '',
      updatedByEmail: r.updatedByEmail || '', updatedAt: r.updatedAt || ''
    }))
  };
}

function saveDocumentacao_(auth, body) {
  if (!String(body.nome || '').trim()) return { ok: false, error: 'missing_name' };
  const sh = getDocumentacoesSheet_();
  const id = body.id || Utilities.getUuid();
  const existing = body.id ? sheetToObjects_(sh).find(r => r.id === body.id) : null;
  upsertByKeys_(sh, DOCUMENTACAO_HEADERS, ['id'], {
    id: id, tipo: DOCUMENTACAO_TIPOS.indexOf(body.tipo) >= 0 ? body.tipo : 'outro', tipoOutro: String(body.tipoOutro || '').trim(),
    nome: String(body.nome || '').trim(), numero: String(body.numero || '').trim(), orgaoEmissor: String(body.orgaoEmissor || '').trim(),
    dataEmissao: body.dataEmissao || '', dataValidade: body.dataValidade || '', observacao: String(body.observacao || '').trim(),
    // arquivoUrl/arquivoNome só mudam por uploadDocumentacaoFile_ — salvar o formulário
    // de novo nunca apaga o anexo que já estava lá.
    arquivoUrl: existing ? existing.arquivoUrl : '', arquivoNome: existing ? existing.arquivoNome : '',
    createdByEmail: existing ? existing.createdByEmail : auth.email,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedByEmail: auth.email, updatedAt: new Date().toISOString()
  });
  return { ok: true, id: id };
}

function uploadDocumentacaoFile_(auth, body) {
  if (!body.id) return { ok: false, error: 'missing_id' };
  if (!body.fileBase64) return { ok: false, error: 'missing_file' };
  const sh = getDocumentacoesSheet_();
  const row = sheetToObjects_(sh).find(r => r.id === body.id);
  if (!row) return { ok: false, error: 'not_found' };
  const bytes = Utilities.base64Decode(body.fileBase64);
  const safeName = String(body.fileName || 'arquivo').replace(/[\\/]/g, '-');
  const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', safeName);
  const file = getDocumentacoesFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  sh.getRange(row.__row, 1, 1, DOCUMENTACAO_HEADERS.length).setValues([[
    row.id, row.tipo, row.tipoOutro, row.nome, row.numero, row.orgaoEmissor, row.dataEmissao, row.dataValidade,
    row.observacao, file.getUrl(), safeName, row.createdByEmail, row.createdAt, auth.email, new Date().toISOString()
  ]]);
  return { ok: true, url: file.getUrl(), fileName: safeName };
}

function deleteDocumentacao_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getDocumentacoesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) {
    if (existing && existing.arquivoUrl) {
      try { const m = existing.arquivoUrl.match(/[-\w]{25,}/); if (m) DriveApp.getFileById(m[0]).setTrashed(true) } catch (e) { /* arquivo já sumiu do Drive por fora — segue o apagar do registro mesmo assim */ }
    }
    logDeletion_(auth, 'documentacao', '', 'master', 'Documento apagado — ' + (existing ? existing.nome : ''), existing);
  }
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---------- Presença diária de CLT/INT/PJ (01/10 — RH ou Operação) ----------

function getDailyAttendanceSheet_() { return ensureSheet_('DailyAttendance', DAILY_ATTENDANCE_HEADERS) }

function getDailyAttendance_(date) {
  const rows = sheetToObjects_(getDailyAttendanceSheet_()).filter(r => !date || r.date === date);
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, employeeId: r.employeeId, date: r.date,
      status: DAILY_ATTENDANCE_STATUS.indexOf(r.status) >= 0 ? r.status : '',
      observacao: r.observacao || '', markedByEmail: r.markedByEmail || '', markedAt: r.markedAt || ''
    }))
  };
}

// `status` é opcional — chamada só com observacao (sem status) PRESERVA o status já
// salvo, pra dar pra anotar algo sem precisar remarcar presença/falta.
function setDailyAttendance_(auth, body) {
  if (!body.employeeId) return { ok: false, error: 'missing_employee' };
  if (!body.date) return { ok: false, error: 'missing_date' };
  const sh = getDailyAttendanceSheet_();
  const rows = sheetToObjects_(sh);
  const existing = rows.find(r => r.employeeId === body.employeeId && r.date === body.date);
  const id = existing ? existing.id : Utilities.getUuid();
  const statusValido = DAILY_ATTENDANCE_STATUS.indexOf(body.status) >= 0;
  upsertByKeys_(sh, DAILY_ATTENDANCE_HEADERS, ['id'], {
    id: id, employeeId: body.employeeId, date: body.date,
    status: statusValido ? body.status : (existing ? existing.status : ''),
    observacao: body.observacao !== undefined ? String(body.observacao).trim() : (existing ? existing.observacao : ''),
    markedByEmail: auth.email, markedAt: new Date().toISOString()
  });
  return { ok: true, id: id };
}

// ---------- Instagram • API oficial (Graph API) — 19/10 ----------
// Pedido do Renato: avaliar a conta por dentro, sem ele digitar números. Fluxo (uma vez, feito por quem administra a conta):
//  1) Conta do Instagram profissional (Business/Criador) ligada a uma Página do Facebook.
//  2) Meta for Developers: app tipo "Business" com as permissões instagram_basic, instagram_manage_insights,
//     pages_show_list e pages_read_engagement; gerar um token (de preferência de Usuário do Sistema no Business Manager,
//     que não expira; token comum dura ~60 dias).
//  3) Script Properties: IG_ACCESS_TOKEN = token. Rodar descobrirInstagramUserId_() uma vez (lista as Páginas e o id da
//     conta do Instagram) e gravar IG_USER_ID = id da conta do Instagram.
//  4) Rodar configurarGatilhoDiarioInstagram_() uma vez (atualiza todo dia às 6h) e atualizarInstagram_() pra testar.
// Métricas da Graph API mudam de nome com o tempo: cada métrica é pedida separado e, se falhar, o erro fica registrado em
// "avisos" (o resto continua). Código escrito pela documentação — ainda NÃO testado com token real.
// v26.0 = a versão que o Explorador da Graph API mostra como atual em 19/10/2026 (a v21.0 usada na 1ª versão é de out/2024 e está perto do fim do suporte)
const IG_API = 'https://graph.facebook.com/v26.0';
const IG_RESUMO_HEADERS = ['date', 'followers', 'following', 'mediaCount', 'reach30', 'views30', 'profileViews30', 'websiteClicks30', 'accountsEngaged30', 'interactions30', 'avisos', 'capturedAt'];
const IG_POSTS_HEADERS = ['id', 'date', 'tipo', 'permalink', 'likes', 'comments', 'reach', 'saved', 'shares', 'interactions', 'views', 'legenda', 'updatedAt', 'hora'];
// 21/10: série MENSAL (pedido do Renato: comparar 1 ano com o outro). Cada mês = janela de 1 a 30 (ou até o fim do mês, se menor);
// a API limita o intervalo a 30 dias e "alcance" não se soma entre janelas. O mês corrente é parcial (1º até hoje).
const IG_MENSAL_HEADERS = ['mes', 'reach', 'views', 'profileViews', 'websiteClicks', 'accountsEngaged', 'interactions', 'avisos', 'capturedAt'];
function getIgMensalSheet_() {
  const sh = ensureSheet_('InstagramMensal', IG_MENSAL_HEADERS);
  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat('@'); // "2026-10" não virar data
  return sh;
}
function igAtualizarMensal_(maxNovos, meses) {
  const props = PropertiesService.getScriptProperties();
  const uid = props.getProperty('IG_USER_ID');
  if (!props.getProperty('IG_ACCESS_TOKEN') || !uid) return { gravados: 0 };
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const agora = new Date();
  const hojeMes = Utilities.formatDate(agora, tz, 'yyyy-MM');
  const y0 = Number(hojeMes.slice(0, 4)), m0 = Number(hojeMes.slice(5, 7));
  const sh = getIgMensalSheet_();
  const tem = {};
  sheetToObjects_(sh).forEach(function (r) { tem[String(r.mes)] = true });
  const lista = [];
  for (let i = 0; i < (meses || 24); i++) {
    const t = new Date(y0, m0 - 1 - i, 1);
    lista.push(Utilities.formatDate(t, tz, 'yyyy-MM'));
  }
  let novos = 0, gravados = 0;
  lista.forEach(function (mk, i) {
    const recente = i <= 1; // mês corrente e anterior: sempre refaz
    if (!recente && (tem[mk] || novos >= (maxNovos == null ? 3 : maxNovos))) return;
    const y = Number(mk.slice(0, 4)), m = Number(mk.slice(5, 7));
    const ult = Math.min(new Date(y, m, 0).getDate(), 30);
    const since = Math.floor(Utilities.parseDate(mk + '-01 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss').getTime() / 1000);
    let until = Math.floor(Utilities.parseDate(mk + '-' + ('0' + ult).slice(-2) + ' 23:59:59', tz, 'yyyy-MM-dd HH:mm:ss').getTime() / 1000);
    const agoraS = Math.floor(agora.getTime() / 1000);
    if (until > agoraS) until = agoraS;
    if (until <= since) return;
    const avisos = [];
    const v = {};
    [['reach', 'reach'], ['views', 'views'], ['profileViews', 'profile_views'], ['websiteClicks', 'website_clicks'], ['accountsEngaged', 'accounts_engaged'], ['interactions', 'total_interactions']].forEach(function (p) {
      v[p[0]] = igSomaTotal_(uid, p[1], since, until, avisos);
    });
    const alg = Object.keys(v).some(function (k) { return v[k] != null });
    upsertByKeys_(sh, IG_MENSAL_HEADERS, ['mes'], {
      mes: mk, reach: v.reach == null ? '' : v.reach, views: v.views == null ? '' : v.views, profileViews: v.profileViews == null ? '' : v.profileViews,
      websiteClicks: v.websiteClicks == null ? '' : v.websiteClicks, accountsEngaged: v.accountsEngaged == null ? '' : v.accountsEngaged,
      interactions: v.interactions == null ? '' : v.interactions, avisos: avisos.join(' | ').slice(0, 300), capturedAt: new Date().toISOString()
    });
    if (!recente) novos++;
    if (alg) gravados++;
  });
  return { gravados: gravados };
}
function getIgResumoSheet_() { return ensureSheet_('InstagramResumo', IG_RESUMO_HEADERS) }
function getIgPostsSheet_() { return ensureSheet_('InstagramPosts', IG_POSTS_HEADERS) }
// 19/10: o UrlFetchApp coloca a URL inteira (com access_token) na mensagem de erro — vazou um token no registro de execução.
// Este helper esconde token/segredo em qualquer erro e devolve o JSON já convertido.
function igRedigir_(txt) {
  return String(txt).replace(/(access_token|client_secret|fb_exchange_token)=[^&\s"']+/g, '$1=***');
}
function igGetJson_(url) {
  try {
    return JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
  } catch (e) {
    throw new Error(igRedigir_(e));
  }
}
function igFetch_(path, params) {
  const token = PropertiesService.getScriptProperties().getProperty('IG_ACCESS_TOKEN');
  if (!token) throw new Error('config_faltando: IG_ACCESS_TOKEN');
  const q = Object.keys(params || {}).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]) }).join('&');
  const json = igGetJson_(IG_API + path + '?' + q + (q ? '&' : '') + 'access_token=' + encodeURIComponent(token));
  if (json.error) throw new Error((json.error.message || 'erro Graph API') + ' (code ' + json.error.code + ')');
  return json;
}
// roda 1x no editor: mostra as Páginas e o id da conta do Instagram ligada a cada uma
function descobrirInstagramUserId_() {
  const r = igFetch_('/me/accounts', { fields: 'name,instagram_business_account{id,username}' });
  const linhas = (r.data || []).map(function (p) { return p.name + ' → ' + (p.instagram_business_account ? p.instagram_business_account.username + ' (id ' + p.instagram_business_account.id + ')' : 'sem Instagram ligado') });
  Logger.log(linhas.join('\n') || 'Nenhuma Página encontrada para este token.');
  return linhas;
}
function configurarGatilhoDiarioInstagram_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'atualizarInstagram_') ScriptApp.deleteTrigger(t) });
  ScriptApp.newTrigger('atualizarInstagram_').timeBased().everyDays(1).atHour(6).create();
  return { ok: true };
}
// Garante o gatilho diário sem ninguém rodar nada à mão: chamada pelo BI ao ler/atualizar o Instagram. Só cria se ainda não existir.
function garantirGatilhoInstagram_() {
  try {
    const existe = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'atualizarInstagram_' });
    if (!existe) configurarGatilhoDiarioInstagram_();
  } catch (e) { Logger.log('Gatilho do Instagram não criado automaticamente: ' + String(e)) }
}
// Funções COM "_" no fim não aparecem na lista "Executar" do editor do Apps Script — estas 3 são as que você roda à mão:
// CAMINHO RÁPIDO (sem Business Settings): com IG_APP_ID, IG_APP_SECRET e IG_TOKEN_CURTO (token de usuário gerado no Explorador da
// Graph API, vale ~1h) nas Propriedades do script, esta função (a) troca o token curto por um de ~60 dias, (b) pega dele o token da
// PÁGINA ligada ao Instagram — token de Página vindo de token de longa duração não expira — e (c) grava IG_ACCESS_TOKEN e IG_USER_ID
// sozinha, apagando o token curto. Se houver mais de uma Página com Instagram, usa a do usuário IG_USERNAME (padrão "seujustino").
function instagramConectar() {
  const p = PropertiesService.getScriptProperties();
  const lim = function (v) { return v == null ? v : String(v).replace(/[\s\u200b\ufeff]+/g, '') }; // tira espaço/quebra de linha que sobra ao colar
  const appId = lim(p.getProperty('IG_APP_ID')), segredo = lim(p.getProperty('IG_APP_SECRET')), curto = lim(p.getProperty('IG_TOKEN_CURTO'));
  if (!appId || !segredo || !curto) throw new Error('Faltam IG_APP_ID, IG_APP_SECRET e IG_TOKEN_CURTO nas Propriedades do script.');
  const get = igGetJson_;
  const enc = encodeURIComponent;
  const longo = get(IG_API + '/oauth/access_token?grant_type=fb_exchange_token&client_id=' + enc(appId) + '&client_secret=' + enc(segredo) + '&fb_exchange_token=' + enc(curto));
  if (!longo.access_token) throw new Error('Troca do token falhou: ' + JSON.stringify(longo.error || longo));
  const pag = get(IG_API + '/me/accounts?fields=' + enc('name,access_token,instagram_business_account{id,username}') + '&limit=100&access_token=' + enc(longo.access_token));
  if (pag.error) throw new Error('Não consegui listar as Páginas: ' + JSON.stringify(pag.error));
  const comIg = (pag.data || []).filter(function (x) { return x.instagram_business_account });
  Logger.log('Páginas com Instagram: ' + (comIg.map(function (x) { return x.name + ' → @' + x.instagram_business_account.username }).join(' | ') || 'nenhuma'));
  if (!comIg.length) throw new Error('Nenhuma Página com Instagram ligado foi autorizada. Refaça o token marcando a Página e a conta do Instagram na janela de permissões.');
  const alvo = (p.getProperty('IG_USERNAME') || 'seujustino').toLowerCase();
  const escolhida = comIg.find(function (x) { return String(x.instagram_business_account.username || '').toLowerCase() === alvo }) || comIg[0];
  p.setProperty('IG_ACCESS_TOKEN', escolhida.access_token);
  p.setProperty('IG_USER_ID', escolhida.instagram_business_account.id);
  p.deleteProperty('IG_TOKEN_CURTO');
  Logger.log('Conectado: Página "' + escolhida.name + '" • Instagram @' + escolhida.instagram_business_account.username + '. Token curto apagado.');
  return { pagina: escolhida.name, instagram: escolhida.instagram_business_account.username };
}
function instagramDescobrirId() { return descobrirInstagramUserId_(); }        // 1) mostra a Página e o id da conta do Instagram (ver "Registro de execução")
function instagramConfigurarGatilho() { return configurarGatilhoDiarioInstagram_(); } // 2) liga a atualização diária às 6h
function instagramAtualizar() {                                         // 3) primeira leitura (ou leitura manual)
  const r = atualizarInstagram_();
  Logger.log('Instagram atualizado em ' + r.dia + ': ' + r.posts + ' posts lidos. Avisos: ' + (r.avisos.length ? r.avisos.join(' | ') : 'nenhum'));
  return r;
}
function igSomaTotal_(uid, metric, since, until, avisos) {
  try {
    const r = igFetch_('/' + uid + '/insights', { metric: metric, period: 'day', metric_type: 'total_value', since: since, until: until });
    const d = (r.data || [])[0];
    return d && d.total_value ? Number(d.total_value.value) || 0 : null;
  } catch (e) { avisos.push(metric + ': ' + String(e).slice(0, 140)); return null; }
}
function atualizarInstagram_() {
  const props = PropertiesService.getScriptProperties();
  const uid = props.getProperty('IG_USER_ID');
  if (!props.getProperty('IG_ACCESS_TOKEN') || !uid) throw new Error('config_faltando: IG_ACCESS_TOKEN / IG_USER_ID');
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const avisos = [];
  const perfil = igFetch_('/' + uid, { fields: 'username,followers_count,follows_count,media_count' });
  const fim = Math.floor(Date.now() / 1000), ini = fim - 30 * 86400;
  const reach = igSomaTotal_(uid, 'reach', ini, fim, avisos);
  const views = igSomaTotal_(uid, 'views', ini, fim, avisos);
  const visitas = igSomaTotal_(uid, 'profile_views', ini, fim, avisos);
  const cliques = igSomaTotal_(uid, 'website_clicks', ini, fim, avisos);
  const engajadas = igSomaTotal_(uid, 'accounts_engaged', ini, fim, avisos);
  const interacoes = igSomaTotal_(uid, 'total_interactions', ini, fim, avisos);
  upsertByKeys_(getIgResumoSheet_(), IG_RESUMO_HEADERS, ['date'], {
    date: hoje, followers: perfil.followers_count || 0, following: perfil.follows_count || 0, mediaCount: perfil.media_count || 0,
    reach30: reach == null ? '' : reach, views30: views == null ? '' : views, profileViews30: visitas == null ? '' : visitas,
    websiteClicks30: cliques == null ? '' : cliques, accountsEngaged30: engajadas == null ? '' : engajadas,
    interactions30: interacoes == null ? '' : interacoes, avisos: avisos.join(' | '), capturedAt: new Date().toISOString()
  });
  // publicações dos últimos 60 dias, com métricas por post
  const midia = igFetch_('/' + uid + '/media', { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count', limit: 60 });
  const corte = Utilities.formatDate(new Date(Date.now() - 60 * 86400000), tz, 'yyyy-MM-dd');
  let gravados = 0;
  (midia.data || []).forEach(function (m) {
    // a API manda o horário em UTC; data e hora precisam ser as de Brasília (post das 22h aparecia no dia seguinte)
    const dtPost = new Date(m.timestamp);
    const okDt = !isNaN(dtPost.getTime());
    const data = okDt ? Utilities.formatDate(dtPost, tz, 'yyyy-MM-dd') : String(m.timestamp || '').slice(0, 10);
    const hora = okDt ? Utilities.formatDate(dtPost, tz, 'HH:mm') : '';
    if (data < corte) return;
    const met = {};
    ['reach', 'saved', 'shares', 'total_interactions', 'views'].forEach(function (k) {
      try {
        const r = igFetch_('/' + m.id + '/insights', { metric: k });
        const d = (r.data || [])[0];
        if (d && d.values && d.values.length) met[k] = Number(d.values[0].value) || 0;
      } catch (e) { /* métrica não suportada para esse tipo de post — segue */ }
    });
    const tipo = m.media_product_type === 'REELS' ? 'REEL' : (m.media_type === 'CAROUSEL_ALBUM' ? 'CARROSSEL' : (m.media_type === 'VIDEO' ? 'VIDEO' : 'FOTO'));
    upsertByKeys_(getIgPostsSheet_(), IG_POSTS_HEADERS, ['id'], {
      id: m.id, date: data, tipo: tipo, permalink: m.permalink || '', likes: m.like_count || 0, comments: m.comments_count || 0,
      reach: met.reach == null ? '' : met.reach, saved: met.saved == null ? '' : met.saved, shares: met.shares == null ? '' : met.shares,
      interactions: met.total_interactions == null ? '' : met.total_interactions, views: met.views == null ? '' : met.views,
      legenda: String(m.caption || '').slice(0, 140), updatedAt: new Date().toISOString(), hora: hora
    });
    gravados++;
  });
  try { igAtualizarMensal_(3, 24) } catch (e) { avisos.push('mensal: ' + igRedigir_(e).slice(0, 140)) }
  return { dia: hoje, posts: gravados, avisos: avisos };
}
// roda à mão 1x: preenche os 24 meses de uma vez (o diário preenche 3 por dia sozinho)
function instagramHistorico() {
  const r = igAtualizarMensal_(24, 24);
  Logger.log('Meses gravados: ' + r.gravados);
  return r;
}
function getInstagram_() {
  const props = PropertiesService.getScriptProperties();
  const configurado = !!(props.getProperty('IG_ACCESS_TOKEN') && props.getProperty('IG_USER_ID'));
  const resumo = sheetToObjects_(getIgResumoSheet_()).sort(function (a, b) { return a.date < b.date ? 1 : -1 });
  const posts = sheetToObjects_(getIgPostsSheet_()).sort(function (a, b) { return a.date < b.date ? 1 : -1 });
  const num = function (v) { return (v === '' || v == null) ? null : Number(v) };
  return {
    ok: true, configurado: configurado,
    atual: resumo[0] || null,
    historico: resumo.slice(0, 90).map(function (r) { return { date: r.date, followers: num(r.followers), reach30: num(r.reach30) } }),
    mensal: sheetToObjects_(getIgMensalSheet_()).map(function (r) { return { mes: String(r.mes).slice(0, 7), reach: num(r.reach), views: num(r.views), profileViews: num(r.profileViews), websiteClicks: num(r.websiteClicks), accountsEngaged: num(r.accountsEngaged), interactions: num(r.interactions) } }).sort(function (a, b) { return a.mes < b.mes ? -1 : 1 }),
    seguidoresMes: (function () { const m = {}; resumo.slice().reverse().forEach(function (r) { m[String(r.date).slice(0, 7)] = num(r.followers) }); return m })(),
    posts: posts.slice(0, 60).map(function (p) { return { id: p.id, date: p.date, tipo: p.tipo, permalink: p.permalink, likes: num(p.likes), comments: num(p.comments), reach: num(p.reach), saved: num(p.saved), shares: num(p.shares), interactions: num(p.interactions), views: num(p.views), legenda: p.legenda, hora: p.hora || '' } })
  };
}


// Totais de faturamento por semana (segunda a domingo), só dias já encerrados e com receita > 0; a última captura de cada data vence (há datas duplicadas).
function getFaturamentoSemanas_() {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const porData = {};
  sheetToObjects_(getZigRevenueSheet_()).forEach(function (r) {
    const d = String(r.date || '').slice(0, 10);
    const v = Number(r.revenue) || 0;
    if (d && d < hoje && v > 0) porData[d] = v;
  });
  const porSem = {};
  Object.keys(porData).forEach(function (d) {
    const seg = igMonday_(d);
    const o = porSem[seg] || (porSem[seg] = { semana: seg, total: 0, dias: 0 });
    o.total += porData[d]; o.dias++;
  });
  return Object.keys(porSem).sort().slice(-14).map(function (k) { return { semana: k, total: Math.round(porSem[k].total * 100) / 100, dias: porSem[k].dias } });
}
// Pax reservado por data da visita, de 120 dias atrás a 60 dias à frente (alimenta o card "Budget de atrações" do Marketing).
function getBudgetAtracoesBase_() {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const ini = igAddDays_(hoje, -120), fim = igAddDays_(hoje, 60);
  const pax = {};
  sheetToObjects_(getReservationEntriesSheet_()).forEach(function (r) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < ini || d > fim) return;
    pax[d] = (pax[d] || 0) + (Number(r.pax) || 0);
  });
  return { ok: true, hoje: hoje, paxPorData: pax };
}
// ---------- Instagram • Ativações e retorno em reservas (21/10, pedido do Renato) ----------
// Ativação = uma ação planejada/executada (Reel de convite, Story de aniversário, promoção do dia...). O retorno é medido de 2 jeitos:
//  (a) DIRETO: reservas lançadas com origem "instagram" e vinculadas à ativação (campo da tela de Reservas) — é a medida confiável;
//  (b) JANELA: reservas LANÇADAS no dia da ativação e nos 3 seguintes, contra a média das mesmas janelas das 4 semanas anteriores
//      (janelas que contêm outra ativação ficam de fora). É correlação, não prova de causa. Reservas lançadas em lote (grade
//      semanal) não entram na janela, porque o lote carimba o mesmo horário em várias reservas.
const IG_ATIV_TIPOS = ['reel', 'story', 'carrossel', 'foto', 'promocao', 'evento', 'parceria', 'outro'];
const IG_ATIV_HEADERS = ['id', 'data', 'tipo', 'titulo', 'oferta', 'postId', 'observacao', 'createdByEmail', 'createdAt', 'updatedByEmail', 'updatedAt'];
function getIgAtivacoesSheet_() { return ensureSheet_('InstagramAtivacoes', IG_ATIV_HEADERS) }
function igAtivNorm_(r) {
  return { id: r.id, data: String(r.data || '').slice(0, 10), tipo: IG_ATIV_TIPOS.indexOf(r.tipo) >= 0 ? r.tipo : 'outro', titulo: r.titulo || '', oferta: r.oferta || '', postId: r.postId ? String(r.postId) : '', observacao: r.observacao || '', createdByEmail: r.createdByEmail || '', updatedAt: r.updatedAt || '' };
}
function getIgAtivacoes_() {
  const itens = sheetToObjects_(getIgAtivacoesSheet_()).map(igAtivNorm_).sort(function (a, b) { return a.data < b.data ? 1 : a.data > b.data ? -1 : 0 });
  return { ok: true, items: itens };
}
function saveIgAtivacao_(auth, body) {
  if (!body.data || !/^\d{4}-\d{2}-\d{2}$/.test(body.data)) return { ok: false, error: 'missing_date' };
  if (!body.titulo || !String(body.titulo).trim()) return { ok: false, error: 'missing_title' };
  const sh = getIgAtivacoesSheet_();
  const id = body.id || Utilities.getUuid();
  const existing = body.id ? sheetToObjects_(sh).find(function (r) { return r.id === body.id }) : null;
  upsertByKeys_(sh, IG_ATIV_HEADERS, ['id'], {
    id: id, data: body.data, tipo: IG_ATIV_TIPOS.indexOf(body.tipo) >= 0 ? body.tipo : 'outro',
    titulo: String(body.titulo).trim(), oferta: String(body.oferta || '').trim(), postId: String(body.postId || '').trim(),
    observacao: String(body.observacao || '').trim(),
    createdByEmail: existing ? existing.createdByEmail : auth.email, createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedByEmail: auth.email, updatedAt: new Date().toISOString()
  });
  return { ok: true, id: id };
}
function deleteIgAtivacao_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getIgAtivacoesSheet_();
  const existing = sheetToObjects_(sh).find(function (r) { return r.id === id });
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'igAtivacao', existing ? existing.data : '', 'marketing', 'Instagram — ativação apagada: ' + (existing ? existing.titulo : id), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}
function igAddDays_(ds, n) { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
function igMonday_(ds) { const d = new Date(ds + 'T12:00:00Z'); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w); return d.toISOString().slice(0, 10) }
function getIgRetorno_() {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const ativs = sheetToObjects_(getIgAtivacoesSheet_()).map(igAtivNorm_).filter(function (a) { return a.data }).sort(function (a, b) { return a.data < b.data ? -1 : 1 });
  const rawRes = sheetToObjects_(getReservationEntriesSheet_());
  const porLote = {};
  rawRes.forEach(function (r) { if (r.submittedAt) porLote[r.submittedAt] = (porLote[r.submittedAt] || 0) + 1 });
  const res = rawRes.map(function (r) {
    let lanc = '';
    try { const d = new Date(r.submittedAt); if (!isNaN(d.getTime())) lanc = Utilities.formatDate(d, tz, 'yyyy-MM-dd') } catch (e) { }
    return { pax: Number(r.pax) || 0, origem: normOrigem_(r.origem), ativacaoId: r.ativacaoId ? String(r.ativacaoId) : '', lanc: lanc, emLote: (porLote[r.submittedAt] || 0) >= 3 };
  });
  const posts = {};
  sheetToObjects_(getIgPostsSheet_()).forEach(function (p) { posts[String(p.id)] = p });
  const contaJanela = function (ini, fim) {
    let n = 0, pax = 0;
    res.forEach(function (r) { if (!r.lanc || r.lanc < ini || r.lanc > fim) return; if (r.emLote && r.origem !== 'instagram') return; n++; pax += r.pax });
    return { n: n, pax: pax };
  };
  const items = ativs.map(function (a) {
    const fim = igAddDays_(a.data, 3);
    const diretas = { n: 0, pax: 0 };
    res.forEach(function (r) { if (r.ativacaoId === a.id) { diretas.n++; diretas.pax += r.pax } });
    const janela = contaJanela(a.data, fim);
    const bases = [];
    for (let k = 1; k <= 4; k++) {
      const ini = igAddDays_(a.data, -7 * k), f = igAddDays_(ini, 3);
      if (ativs.some(function (o) { return o.id !== a.id && o.data >= ini && o.data <= f })) continue;
      bases.push(contaJanela(ini, f));
    }
    const base = bases.length ? { n: bases.reduce(function (t, x) { return t + x.n }, 0) / bases.length, pax: bases.reduce(function (t, x) { return t + x.pax }, 0) / bases.length, semanas: bases.length } : null;
    const p = a.postId ? posts[a.postId] : null;
    return {
      id: a.id, data: a.data, tipo: a.tipo, titulo: a.titulo, oferta: a.oferta, postId: a.postId,
      post: p ? { tipo: p.tipo, permalink: p.permalink || '', reach: p.reach === '' ? null : Number(p.reach), hora: p.hora || '' } : null,
      diretas: diretas, janela: janela, base: base, emAndamento: fim >= hoje
    };
  }).sort(function (a, b) { return a.data < b.data ? 1 : -1 });
  const porTipo = {};
  items.forEach(function (i) {
    const o = porTipo[i.tipo] || (porTipo[i.tipo] = { tipo: i.tipo, acoes: 0, diretas: 0, janela: 0, ganhoSoma: 0, ganhoN: 0 });
    o.acoes++; o.diretas += i.diretas.n; o.janela += i.janela.n;
    if (i.base && !i.emAndamento) { o.ganhoSoma += i.janela.n - i.base.n; o.ganhoN++ }
  });
  // reservas lançadas por semana (8 semanas): total e com origem Instagram
  const semanas = [];
  const seg0 = igMonday_(hoje);
  for (let w = 7; w >= 0; w--) {
    const ini = igAddDays_(seg0, -7 * w), fim = igAddDays_(ini, 6);
    let tot = 0, ig = 0, infor = 0;
    res.forEach(function (r) { if (!r.lanc || r.lanc < ini || r.lanc > fim) return; tot++; if (r.origem) infor++; if (r.origem === 'instagram') ig++ });
    semanas.push({ semana: ini, total: tot, informadas: infor, instagram: ig });
  }
  const ini30 = igAddDays_(hoje, -29);
  let t30 = 0, i30 = 0;
  res.forEach(function (r) { if (r.lanc >= ini30) { t30++; if (r.origem) i30++ } });
  return { ok: true, hoje: hoje, items: items, porTipo: Object.keys(porTipo).map(function (k) { return porTipo[k] }), semanas: semanas, cobertura30: { total: t30, comOrigem: i30 } };
}
// Teste (rodar 1x no editor): mostra o que a API entrega de público (idade/gênero/cidade), horas online dos seguidores e Stories,
// pra decidir quais telas valem a pena. Só leitura; não grava nada.
function instagramTestarDados() {
  const uid = PropertiesService.getScriptProperties().getProperty('IG_USER_ID');
  if (!uid) throw new Error('config_faltando: IG_USER_ID');
  const out = {};
  const tenta = function (nome, fn) {
    try { const r = fn(); out[nome] = 'OK: ' + JSON.stringify(r).slice(0, 600) } catch (e) { out[nome] = 'ERRO: ' + igRedigir_(e).slice(0, 300) }
  };
  ['city', 'age', 'gender', 'country'].forEach(function (b) {
    tenta('seguidores_por_' + b, function () { return igFetch_('/' + uid + '/insights', { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: b }) });
  });
  tenta('engajados_por_cidade', function () { return igFetch_('/' + uid + '/insights', { metric: 'engaged_audience_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: 'city', timeframe: 'last_30_days' }) });
  tenta('online_followers', function () { return igFetch_('/' + uid + '/insights', { metric: 'online_followers', period: 'lifetime' }) });
  tenta('stories_24h', function () {
    const s = igFetch_('/' + uid + '/stories', { fields: 'id,timestamp,media_type' });
    const primeiro = (s.data || [])[0];
    if (!primeiro) return { stories: 0 };
    return { stories: (s.data || []).length, amostra: igFetch_('/' + primeiro.id + '/insights', { metric: 'reach,replies,navigation' }) };
  });
  Object.keys(out).forEach(function (k) { Logger.log(k + ' → ' + out[k]) });
  return out;
}

// ---------- Marketing • Reuniões e demandas (16/10) ----------
// Um item = uma demanda, uma pauta de reunião ou uma ata. 'reuniaoId' liga uma demanda
// à pauta/ata de onde ela saiu. 'decisoes' é o texto de deliberações/encaminhamentos da
// ata. Prazo + responsável são o que alimenta o acompanhamento (atrasados, por pessoa).
const MK_REUNIAO_TIPOS = ['demanda', 'pauta', 'ata'];
const MK_REUNIAO_STATUS = ['aberto', 'andamento', 'concluido', 'cancelado'];
const MK_REUNIAO_PRIORIDADE = ['alta', 'media', 'baixa'];
const MK_REUNIAO_HEADERS = [
  'id', 'tipo', 'titulo', 'descricao', 'dataReuniao', 'participantes', 'responsavel', 'prazo',
  'prioridade', 'status', 'decisoes', 'reuniaoId', 'dataConclusao', 'observacao',
  'createdByEmail', 'createdAt', 'updatedByEmail', 'updatedAt'
];
function getMkReunioesSheet_() { return ensureSheet_('MarketingReunioes', MK_REUNIAO_HEADERS) }

function getMkReunioes_() {
  const rows = sheetToObjects_(getMkReunioesSheet_());
  rows.sort((a, b) => (a.dataReuniao < b.dataReuniao ? 1 : a.dataReuniao > b.dataReuniao ? -1 : 0));
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id,
      tipo: MK_REUNIAO_TIPOS.indexOf(r.tipo) >= 0 ? r.tipo : 'demanda',
      titulo: r.titulo || '', descricao: r.descricao || '', dataReuniao: r.dataReuniao || '',
      participantes: r.participantes || '', responsavel: r.responsavel || '', prazo: r.prazo || '',
      prioridade: MK_REUNIAO_PRIORIDADE.indexOf(r.prioridade) >= 0 ? r.prioridade : 'media',
      status: MK_REUNIAO_STATUS.indexOf(r.status) >= 0 ? r.status : 'aberto',
      decisoes: r.decisoes || '', reuniaoId: r.reuniaoId || '', dataConclusao: r.dataConclusao || '',
      observacao: r.observacao || '',
      createdByEmail: r.createdByEmail || '', createdAt: r.createdAt || '',
      updatedByEmail: r.updatedByEmail || '', updatedAt: r.updatedAt || ''
    }))
  };
}

function saveMkReuniao_(auth, body) {
  if (!body.titulo || !String(body.titulo).trim()) return { ok: false, error: 'missing_title' };
  const sh = getMkReunioesSheet_();
  const id = body.id || Utilities.getUuid();
  const existing = body.id ? sheetToObjects_(sh).find(r => r.id === body.id) : null;
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const status = MK_REUNIAO_STATUS.indexOf(body.status) >= 0 ? body.status : 'aberto';
  // concluir sem informar a data grava hoje; reabrir limpa a data de conclusão
  let dataConclusao = body.dataConclusao || '';
  if (status === 'concluido' && !dataConclusao) dataConclusao = hoje;
  if (status !== 'concluido') dataConclusao = '';
  upsertByKeys_(sh, MK_REUNIAO_HEADERS, ['id'], {
    id: id,
    tipo: MK_REUNIAO_TIPOS.indexOf(body.tipo) >= 0 ? body.tipo : 'demanda',
    titulo: String(body.titulo).trim(), descricao: String(body.descricao || '').trim(),
    dataReuniao: body.dataReuniao || (existing ? existing.dataReuniao : hoje),
    participantes: String(body.participantes || '').trim(), responsavel: String(body.responsavel || '').trim(),
    prazo: body.prazo || '',
    prioridade: MK_REUNIAO_PRIORIDADE.indexOf(body.prioridade) >= 0 ? body.prioridade : 'media',
    status: status, decisoes: String(body.decisoes || '').trim(),
    reuniaoId: String(body.reuniaoId || '').trim(), dataConclusao: dataConclusao,
    observacao: String(body.observacao || '').trim(),
    createdByEmail: existing ? existing.createdByEmail : auth.email,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedByEmail: auth.email, updatedAt: new Date().toISOString()
  });
  return { ok: true, id: id };
}

function deleteMkReuniao_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getMkReunioesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'mkReuniao', existing ? existing.dataReuniao : '', 'marketing', 'Marketing — item apagado: ' + (existing ? existing.tipo + ' — ' + existing.titulo : id), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---------- Auditoria Operacional (29/09 — quem vê Operação ou Diretoria) ----------

function getAuditoriaOpSheet_() { return ensureSheet_('AuditoriaOperacional', AUDITORIA_OP_HEADERS) }

function getAuditoriaOpItens_() {
  const rows = sheetToObjects_(getAuditoriaOpSheet_());
  rows.sort((a, b) => (a.dataIdentificacao < b.dataIdentificacao ? 1 : a.dataIdentificacao > b.dataIdentificacao ? -1 : 0));
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, dataIdentificacao: r.dataIdentificacao || '',
      setor: AUDITORIA_OP_SETORES.indexOf(r.setor) >= 0 ? r.setor : 'manutencao',
      tipoServico: AUDITORIA_OP_TIPO_SERVICO.indexOf(r.tipoServico) >= 0 ? r.tipoServico : 'outros',
      descricaoProblema: r.descricaoProblema || '', impactoOperacional: r.impactoOperacional || '',
      responsavelInterno: r.responsavelInterno || '', empresaExecutora: r.empresaExecutora || '',
      necessitaAprovacao: r.necessitaAprovacao === true || r.necessitaAprovacao === 'true',
      valorEstimado: Number(r.valorEstimado) || 0,
      prioridade: AUDITORIA_OP_PRIORIDADE.indexOf(r.prioridade) >= 0 ? r.prioridade : 'media',
      prazo: r.prazo || '', dataInicio: r.dataInicio || '', dataConclusao: r.dataConclusao || '',
      status: AUDITORIA_OP_STATUS.indexOf(r.status) >= 0 ? r.status : 'aberto',
      observacao: r.observacao || '',
      createdByEmail: r.createdByEmail || '', createdAt: r.createdAt || '',
      updatedByEmail: r.updatedByEmail || '', updatedAt: r.updatedAt || '',
      observacaoAprovacao: r.observacaoAprovacao || ''
    }))
  };
}

function saveAuditoriaOpItem_(auth, body) {
  if (!body.descricaoProblema || !String(body.descricaoProblema).trim()) return { ok: false, error: 'missing_description' };
  const sh = getAuditoriaOpSheet_();
  const id = body.id || Utilities.getUuid();
  const existing = body.id ? sheetToObjects_(sh).find(r => r.id === body.id) : null;
  // 03/10 — mesmo bug de fuso já corrigido em outros pontos do arquivo: toISOString()
  // calcula em UTC, não em Brasília (UTC-3) — à noite isso grava com a data de amanhã.
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const dataIdentificacao = body.dataIdentificacao || (existing ? existing.dataIdentificacao : Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
  // 03/10 — achado da auditoria: Auditoria Operacional movimenta valor estimado de
  // manutenção/obra mas ficava editável pra sempre, mesma trava das outras áreas.
  if (auth.role !== 'owner') {
    const meses = new Set([dataIdentificacao.slice(0, 7)]);
    if (existing && existing.dataIdentificacao) meses.add(existing.dataIdentificacao.slice(0, 7));
    for (const mk of meses) {
      if (isMonthClosed_('auditoriaop', mk)) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
    }
  }
  const necessitaAprovacao = !!body.necessitaAprovacao;
  let status = AUDITORIA_OP_STATUS.indexOf(body.status) >= 0 ? body.status : 'aberto';
  // 13/10, achado do Renato: item marcado "Necessita aprovação" ficava com status
  // "Aberto" (o default do formulário) porque os 2 campos eram independentes — o
  // botão Aprovar só aparece com status==='aguardandoAprovacao', então o item nunca
  // surgia pra aprovação de ninguém. Reforço aqui (servidor, não só o onchange do
  // form): item NOVO com necessitaAprovacao=true sempre nasce 'aguardandoAprovacao',
  // não importa o que veio no campo Status. Só vale pra item novo (!existing) — não
  // mexe no status de um item que já passou da aprovação antes (ex.: 'andamento').
  if (!existing && necessitaAprovacao) status = 'aguardandoAprovacao';
  upsertByKeys_(sh, AUDITORIA_OP_HEADERS, ['id'], {
    id: id, dataIdentificacao: dataIdentificacao,
    setor: AUDITORIA_OP_SETORES.indexOf(body.setor) >= 0 ? body.setor : 'manutencao',
    tipoServico: AUDITORIA_OP_TIPO_SERVICO.indexOf(body.tipoServico) >= 0 ? body.tipoServico : 'outros',
    descricaoProblema: String(body.descricaoProblema).trim(), impactoOperacional: String(body.impactoOperacional || '').trim(),
    responsavelInterno: String(body.responsavelInterno || '').trim(), empresaExecutora: String(body.empresaExecutora || '').trim(),
    necessitaAprovacao: necessitaAprovacao, valorEstimado: Number(body.valorEstimado) || 0,
    prioridade: AUDITORIA_OP_PRIORIDADE.indexOf(body.prioridade) >= 0 ? body.prioridade : 'media',
    prazo: body.prazo || '', dataInicio: body.dataInicio || '', dataConclusao: body.dataConclusao || '',
    status: status,
    observacao: String(body.observacao || '').trim(),
    createdByEmail: existing ? existing.createdByEmail : auth.email,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedByEmail: auth.email, updatedAt: new Date().toISOString(),
    observacaoAprovacao: body.observacaoAprovacao !== undefined ? String(body.observacaoAprovacao || '').trim() : (existing ? existing.observacaoAprovacao : '')
  });
  return { ok: true, id: id };
}

// 07/10, pedido do Renato: botão de aprovação só pro diretor, pros itens com valor
// que precisam de aprovação. Reaproveita saveAuditoriaOpItem_ inteiro (mesma trava de
// mês fechado, mesmo rastro de updatedByEmail/updatedAt).
// 13/10: ganhou "observacao" opcional (mensagem do diretor pro item, aparece de volta
// no quadro de Auditoria Operacional) — ver negarAuditoriaOpItem_ logo abaixo, mesmo
// padrão espelhado pro caminho de negar. MESMO DIA, 2ª mudança: status pós-aprovação
// deixou de voltar pra 'aberto' genérico — vira 'aprovado' (badge próprio), pra dar
// pra ver na tabela quem já passou pela Diretoria. Segue o fluxo normal depois
// (quem edita o item pode mudar manualmente pra 'andamento'/'concluído' quando quiser).
function aprovarAuditoriaOpItem_(auth, id, observacao) {
  if (auth.role !== 'owner') return { ok: false, code: 'forbidden' };
  const sh = getAuditoriaOpSheet_();
  const item = sheetToObjects_(sh).find(r => r.id === id);
  if (!item) return { ok: false, error: 'not_found' };
  if (item.status !== 'aguardandoAprovacao') return { ok: false, error: 'not_pending' };
  return saveAuditoriaOpItem_(auth, Object.assign({}, item, { status: 'aprovado', observacaoAprovacao: String(observacao || '').trim() }));
}

// 13/10, pedido do Renato: diretor tinha só "Aprovar" — precisa poder negar também,
// com mensagem explicando o motivo (mesma trava de só o dono aprovar/negar). Status
// 'negado' é final — não aparece mais no quadro de Aprovações pendentes (só
// 'aguardandoAprovacao' aparece lá), mas continua visível na tabela normal de
// Auditoria Operacional com a observação da Diretoria junto, pra quem criou o item
// entender o que aconteceu sem precisar perguntar.
function negarAuditoriaOpItem_(auth, id, observacao) {
  if (auth.role !== 'owner') return { ok: false, code: 'forbidden' };
  const sh = getAuditoriaOpSheet_();
  const item = sheetToObjects_(sh).find(r => r.id === id);
  if (!item) return { ok: false, error: 'not_found' };
  if (item.status !== 'aguardandoAprovacao') return { ok: false, error: 'not_pending' };
  return saveAuditoriaOpItem_(auth, Object.assign({}, item, { status: 'negado', observacaoAprovacao: String(observacao || '').trim() }));
}

function deleteAuditoriaOpItem_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getAuditoriaOpSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  if (existing && existing.dataIdentificacao && auth.role !== 'owner' && isMonthClosed_('auditoriaop', existing.dataIdentificacao.slice(0, 7))) {
    return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  }
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed) logDeletion_(auth, 'auditoriaOpItem', existing ? existing.dataIdentificacao : '', 'operacao', 'Item de auditoria operacional apagado — ' + (existing ? existing.descricaoProblema : ''), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

function getAuditoriaOpEvidenciasSheet_() { return ensureSheet_('AuditoriaOperacionalEvidencias', AUDITORIA_EVIDENCIA_HEADERS) }

// Mesmo padrão de pasta-por-propriedade-de-script do getEmployeeDocsFolder_()/getDocumentacoesFolder_().
function getAuditoriaOpEvidenciasFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('AUDITORIAOP_EVIDENCIAS_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId) } catch (e) { /* pasta apagada — recria abaixo */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const root = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = 'Evidências de auditoria operacional — Seu Justino BI';
  const existing = root.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(name);
  props.setProperty('AUDITORIAOP_EVIDENCIAS_FOLDER_ID', folder.getId());
  return folder;
}

function uploadAuditoriaOpEvidencia_(auth, body) {
  if (!body.itemId) return { ok: false, error: 'missing_item' };
  if (!body.fileBase64) return { ok: false, error: 'missing_file' };
  const item = sheetToObjects_(getAuditoriaOpSheet_()).find(r => r.id === body.itemId);
  if (!item) return { ok: false, error: 'item_not_found' };
  const bytes = Utilities.base64Decode(body.fileBase64);
  const safeName = String(body.fileName || 'foto').replace(/[\\/]/g, '-');
  const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', safeName);
  const file = getAuditoriaOpEvidenciasFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const id = Utilities.getUuid();
  getAuditoriaOpEvidenciasSheet_().appendRow([
    id, body.itemId, (body.antesDepois === 'depois' ? 'depois' : 'antes'), String(body.descricao || '').trim(),
    file.getUrl(), safeName, auth.email, new Date().toISOString()
  ]);
  return { ok: true, id: id, url: file.getUrl(), fileName: safeName };
}

function getAuditoriaOpEvidencias_(itemId) {
  const rows = sheetToObjects_(getAuditoriaOpEvidenciasSheet_()).filter(r => !itemId || r.itemId === itemId);
  rows.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, itemId: r.itemId, antesDepois: r.antesDepois || 'antes', descricao: r.descricao || '',
      url: r.url || '', fileName: r.fileName || '', uploadedByEmail: r.uploadedByEmail || '', uploadedAt: r.uploadedAt || ''
    }))
  };
}

function deleteAuditoriaOpEvidencia_(auth, id) {
  if (!id) return { ok: false, error: 'missing_id' };
  const sh = getAuditoriaOpEvidenciasSheet_();
  const existing = sheetToObjects_(sh).find(r => r.id === id);
  const removed = deleteByKeys_(sh, ['id'], { id: id });
  if (removed && existing && existing.url) {
    try { const m = existing.url.match(/[-\w]{25,}/); if (m) DriveApp.getFileById(m[0]).setTrashed(true) } catch (e) { /* arquivo já sumiu do Drive por fora */ }
  }
  if (removed) logDeletion_(auth, 'auditoriaOpEvidencia', '', 'operacao', 'Evidência apagada — ' + (existing ? existing.fileName : id), existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

function deleteEntry_(auth, area, date) {
  if (AREAS.indexOf(area) < 0) return { ok: false, error: 'invalid_area' };
  if (!date) return { ok: false, error: 'missing_date' };
  if (auth.role !== 'owner' && isMonthClosed_(area, date.slice(0, 7))) return { ok: false, code: 'month_closed', error: 'Mês fechado — peça pro diretor reabrir.' };
  const sh = getEntriesSheet_();
  const existing = sheetToObjects_(sh).find(r => r.area === area && r.date === date);
  const removed = deleteByKeys_(sh, ['area', 'date'], { area: area, date: date });
  if (removed) logDeletion_(auth, 'entry', date, area, 'Envio diário apagado — área ' + area + ', ' + date, existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

function deleteMkPlan_(auth, date) {
  if (!date) return { ok: false, error: 'missing_date' };
  const sh = getMkPlansSheet_();
  const existing = sheetToObjects_(sh).find(r => r.date === date);
  const removed = deleteByKeys_(sh, ['date'], { date: date });
  if (removed) logDeletion_(auth, 'mkplan', date, 'marketing', 'Projeção de marketing apagada — ' + date, existing);
  return removed ? { ok: true } : { ok: false, error: 'not_found' };
}

function getMkPlans_() {
  const rows = sheetToObjects_(getMkPlansSheet_());
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const docs = rows.slice(0, 60).map(r => ({
    date: r.date,
    trafficPlan: Number(r.trafficPlan) || 0,
    otherPlan: Number(r.otherPlan) || 0,
    attractionsPlan: Number(r.attractionsPlan) || 0,
    publicPlan: Number(r.publicPlan) || 0,
    ticketPlan: Number(r.ticketPlan) || 0,
    revenuePlan: Number(r.revenuePlan) || 0,
    note: r.note || '',
    updatedAt: r.updatedAt || '',
    updatedBy: r.updatedBy || ''
  }));
  return { ok: true, docs };
}

function submitMkPlan_(body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  const publicPlan = Number(body.publicPlan) || 0;
  const ticketPlan = Number(body.ticketPlan) || 0;
  upsertByKeys_(getMkPlansSheet_(), MKPLANS_HEADERS, ['date'], {
    date: body.date,
    trafficPlan: Number(body.trafficPlan) || 0,
    otherPlan: Number(body.otherPlan) || 0,
    attractionsPlan: Number(body.attractionsPlan) || 0,
    publicPlan,
    ticketPlan,
    revenuePlan: publicPlan * ticketPlan,
    note: body.note || '',
    updatedAt: new Date().toISOString(),
    updatedBy: body.updatedBy || ''
  });
  return { ok: true };
}

function login_(email, password) {
  if (!email || !password) return { ok: false };
  const users = sheetToObjects_(getUsersSheet_());
  const user = users.find(a => String(a.email).toLowerCase() === String(email).toLowerCase());
  if (!user) return { ok: false };
  const hash = hashPassword_(password, user.salt);
  if (hash !== user.passwordHash) return { ok: false };
  // 'owner' = dono (único que vê salários/bônus e cria acessos). Linha antiga sem papel = o administrador original = dono.
  const role = (user.role === 'owner' || user.role === '' || user.role === undefined) ? 'owner' : 'user';
  const areasCsv = user.areas || '';
  const { token, expiresAt } = makeToken_(user.email, role, areasCsv);
  const layouts = getUserLayouts_(user.email);
  return { ok: true, token, expiresAt, role, areas: parseAreasCsv_(areasCsv), layouts };
}

// 'all' = enxerga todas as abas. CSV ('marketing,rh') = só essas. '' = nenhuma
// área extra (só Manual/Dúvidas) — é o padrão pra conta nova até o admin marcar
// as áreas dela na aba Diretoria.
function parseAreasCsv_(csv) {
  if (csv === 'all') return 'all';
  return csv ? String(csv).split(',').map(s => s.trim()).filter(Boolean) : [];
}

// Confere a área direto na planilha (não confia só no token) — assim, quando o
// admin muda o acesso de alguém na tabela "Acessos cadastrados", já vale no
// próximo envio dessa pessoa, sem precisar esperar ela sair e entrar de novo.
// 23/10 (desempenho): antes, TODA verificação de permissão de quem não é dono relia a planilha Users inteira. Agora guarda só e-mail + áreas por 60 s
// (cache do Google); mudança de áreas de um usuário passa a valer em até 1 minuto. Login e telas de administração continuam lendo a planilha direto.
let __usersMemo = null;
function usersAreasCached_() {
  if (__usersMemo) return __usersMemo;
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('usersAreas_v1'); if (hit) { __usersMemo = JSON.parse(hit); return __usersMemo } } catch (e) { }
  const rows = sheetToObjects_(getUsersSheet_()).map(function (u) { return { email: String(u.email || '').toLowerCase(), areas: u.areas || '' } });
  try { cache.put('usersAreas_v1', JSON.stringify(rows), 60) } catch (e) { }
  __usersMemo = rows;
  return rows;
}
function hasAreaAccess_(auth, area) {
  if (auth.role === 'owner') return true;
  const user = usersAreasCached_().find(function (u) { return u.email === String(auth.email).toLowerCase() });
  if (!user) return false;
  const areas = parseAreasCsv_(user.areas || '');
  if (areas === 'all') return true;
  if (areas.indexOf('master') >= 0) return true; // Diretoria enxerga tudo
  return areas.indexOf(area) >= 0;
}

function normalizeAreas_(areas, fallbackCsv) {
  if (areas === undefined || areas === null) return fallbackCsv || '';
  if (areas === 'all') return 'all';
  if (Array.isArray(areas)) return areas.filter(a => TAB_AREAS.indexOf(a) >= 0).join(',');
  return String(areas);
}

function getUsersList_() {
  const rows = sheetToObjects_(getUsersSheet_());
  return {
    ok: true,
    users: rows.map(r => ({
      email: r.email,
      role: (r.role === 'owner' || r.role === '' || r.role === undefined) ? 'owner' : 'user',
      areas: r.areas || ''
    }))
  };
}

// Qualquer pessoa logada pode trocar a própria senha, desde que informe a atual.
function changeMyPassword_(auth, currentPassword, newPassword) {
  if (!newPassword || String(newPassword).length < 6) return { ok: false, error: 'invalid_password' };
  const sh = getUsersSheet_();
  const user = sheetToObjects_(sh).find(u => String(u.email).toLowerCase() === String(auth.email).toLowerCase());
  if (!user) return { ok: false, error: 'not_found' };
  const hash = hashPassword_(currentPassword || '', user.salt);
  if (hash !== user.passwordHash) return { ok: false, error: 'wrong_password' };
  const salt = Utilities.getUuid();
  const passwordHash = hashPassword_(newPassword, salt);
  upsertByKeys_(sh, USERS_HEADERS, ['email'], {
    email: user.email, salt, passwordHash, createdAt: user.createdAt, role: user.role, areas: user.areas
  });
  return { ok: true };
}

// ---------- Esqueci minha senha (redefinição por e-mail cadastrado, tela de login) ----------
const PASSWORD_RESETS_HEADERS = ['email', 'code', 'expiresAt', 'used'];
function getPasswordResetsSheet_() { return ensureSheet_('PasswordResets', PASSWORD_RESETS_HEADERS) }

// Sempre responde ok:true (exista ou não a conta) — não dá pra descobrir por
// tentativa quais e-mails têm acesso ao BI só de pedir redefinição.
function requestPasswordReset_(email) {
  if (!email) return { ok: false, error: 'missing_email' };
  const key = String(email).trim().toLowerCase();
  const user = sheetToObjects_(getUsersSheet_()).find(u => String(u.email).toLowerCase() === key);
  if (user) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    upsertByKeys_(getPasswordResetsSheet_(), PASSWORD_RESETS_HEADERS, ['email'], {
      email: user.email, code: code, expiresAt: expiresAt, used: false
    });
    try {
      MailApp.sendEmail({
        to: user.email,
        subject: 'Código para redefinir sua senha — BI Seu Justino',
        body: 'Seu código de redefinição de senha é: ' + code + '\n\nVale por 15 minutos. Se você não pediu isso, ignore este e-mail.'
      });
    } catch (e) {
      // 30/09: bug real — essa falha nunca aparecia em lugar nenhum (de propósito, pra
      // não revelar ao requisitante se a conta existe — resposta continua {ok:true}
      // igual). Mas isso também escondia um problema de VERDADE (cota do MailApp,
      // escopo revogado etc.) do próprio Renato, que só saberia por reclamação de
      // usuário sem e-mail chegando (exatamente o que ele reportou). Agora fica
      // registrado na trilha de Auditoria (só a Diretoria vê) — não muda a resposta.
      try { logAudit_({ email: 'sistema' }, 'update', 'geral', 'passwordResetEmailFailed', user.email, 'Falha ao enviar e-mail de redefinição de senha — ' + String(e), null, { error: String(e) }); } catch (e2) { /* nunca deixa a auditoria derrubar o fluxo de senha */ }
    }
  }
  return { ok: true };
}

function confirmPasswordReset_(email, code, newPassword) {
  if (!newPassword || String(newPassword).length < 6) return { ok: false, error: 'invalid_password' };
  const key = String(email || '').trim().toLowerCase();
  const sh = getPasswordResetsSheet_();
  const reset = sheetToObjects_(sh).find(r => String(r.email).toLowerCase() === key);
  if (!reset || reset.used === true || reset.used === 'true') return { ok: false, error: 'invalid_code' };
  if (String(reset.code) !== String(code || '')) return { ok: false, error: 'invalid_code' };
  if (new Date(reset.expiresAt).getTime() < Date.now()) return { ok: false, error: 'expired' };
  const usersSh = getUsersSheet_();
  const user = sheetToObjects_(usersSh).find(u => String(u.email).toLowerCase() === key);
  if (!user) return { ok: false, error: 'invalid_code' };
  const salt = Utilities.getUuid();
  const passwordHash = hashPassword_(newPassword, salt);
  upsertByKeys_(usersSh, USERS_HEADERS, ['email'], {
    email: user.email, salt, passwordHash, createdAt: user.createdAt, role: user.role, areas: user.areas
  });
  upsertByKeys_(sh, PASSWORD_RESETS_HEADERS, ['email'], { email: reset.email, code: reset.code, expiresAt: reset.expiresAt, used: true });
  return { ok: true };
}

// Não deixa apagar conta de administrador por aqui — evita trancar o próprio
// acesso por engano. Pra isso, mude o papel direto na planilha (aba Users).
// 29/09: bug real corrigido — o roteamento sempre chamou deleteUser_(auth, email),
// mas a assinatura só tinha `email` (1 parâmetro); `email` dentro da função recebia
// o OBJETO auth por engano (e o e-mail de verdade, body.email, nunca chegava a ser
// usado) — String(auth).toLowerCase() nunca bate com nenhum e-mail real da planilha,
// então o botão "Apagar" de "Acessos cadastrados" (Diretoria) sempre voltava
// 'not_found', não importa qual usuário. Corrigido: assinatura ganhou `auth` de
// verdade, e agora também audita a exclusão (não logava nada antes).
function deleteUser_(auth, email) {
  if (!email) return { ok: false, error: 'missing_email' };
  const key = String(email).trim().toLowerCase();
  const sh = getUsersSheet_();
  const user = sheetToObjects_(sh).find(u => String(u.email).toLowerCase() === key);
  if (!user) return { ok: false, error: 'not_found' };
  const isOwner = user.role === 'owner' || user.role === '' || user.role === undefined;
  if (isOwner) return { ok: false, error: 'cannot_delete_owner' };
  sh.deleteRow(user.__row);
  logDeletion_(auth, 'userAccount', '', 'master', 'Acesso apagado — ' + user.email, { email: user.email, areas: user.areas });
  return { ok: true };
}

function setUserAreas_(email, areas) {
  if (!email) return { ok: false, error: 'missing_email' };
  const key = String(email).trim().toLowerCase();
  const sh = getUsersSheet_();
  const existing = sheetToObjects_(sh).find(u => String(u.email).toLowerCase() === key);
  if (!existing) return { ok: false, error: 'not_found' };
  upsertByKeys_(sh, USERS_HEADERS, ['email'], {
    email: existing.email,
    salt: existing.salt,
    passwordHash: existing.passwordHash,
    createdAt: existing.createdAt,
    role: existing.role,
    areas: normalizeAreas_(areas, '')
  });
  return { ok: true };
}

function getSalaries_() {
  const rows = sheetToObjects_(getSalariesSheet_());
  return {
    ok: true,
    rows: rows.map(r => ({
      role: r.role,
      name: r.name || '',
      admissionDate: r.admissionDate || '',
      baseSalary: Number(r.baseSalary) || 0
    }))
  };
}

// Mesma correção do quadro mínimo: lê uma vez, grava uma vez, em vez de uma
// leitura+gravação por área (evitava passar do tempo limite do app).
function saveSalaries_(rows) {
  if (!Array.isArray(rows)) return { ok: false, error: 'invalid_rows' };
  const sh = getSalariesSheet_();
  const byRole = {};
  sheetToObjects_(sh).forEach(r => { byRole[r.role] = r });
  rows.forEach(r => {
    if (AREAS.indexOf(r.role) < 0) return;
    byRole[r.role] = {
      role: r.role,
      name: r.name || '',
      admissionDate: r.admissionDate || '',
      baseSalary: Number(r.baseSalary) || 0
    };
  });
  const values = AREAS.map(role => {
    const r = byRole[role] || { role: role, name: '', admissionDate: '', baseSalary: 0 };
    return SALARIES_HEADERS.map(h => r[h]);
  });
  sh.getRange(2, 1, values.length, SALARIES_HEADERS.length).setValues(values);
  return { ok: true };
}

function addAccount_(email, password, areas) {
  if (!email || !password || password.length < 6) return { ok: false, error: 'invalid_input' };
  const key = String(email).trim().toLowerCase();
  const existing = sheetToObjects_(getUsersSheet_()).find(u => String(u.email).toLowerCase() === key);
  const keepOwner = existing && (existing.role === 'owner' || existing.role === '' || existing.role === undefined);
  const salt = Utilities.getUuid();
  const passwordHash = hashPassword_(password, salt);
  upsertByKeys_(getUsersSheet_(), USERS_HEADERS, ['email'], {
    email: key,
    salt,
    passwordHash,
    createdAt: new Date().toISOString(),
    role: keepOwner ? 'owner' : 'user',
    areas: normalizeAreas_(areas, existing ? existing.areas : '')
  });
  return { ok: true };
}

/** Rode manualmente pelo editor do Apps Script (Executar → setupAdmin)
 *  para criar o primeiro administrador. Troque o e-mail/senha abaixo,
 *  ou rode pelo console de execução passando os parâmetros. */
function setupAdmin(email, password) {
  email = email || 'renato@ideia.com.br';
  password = password || 'TROQUE-ESTA-SENHA';
  const salt = Utilities.getUuid();
  const passwordHash = hashPassword_(password, salt);
  upsertByKeys_(getUsersSheet_(), USERS_HEADERS, ['email'], {
    email: String(email).toLowerCase(),
    salt,
    passwordHash,
    createdAt: new Date().toISOString(),
    role: 'owner'
  });
  Logger.log('Administrador criado/atualizado: ' + email);
}

// ---------- leitura de medidores por foto ----------

function getMeterReadingsSheet_() { return ensureSheet_('MeterReadings', METER_HEADERS) }

function getMeterReadings_(limit) {
  const rows = sheetToObjects_(getMeterReadingsSheet_());
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const docs = rows.slice(0, limit).map(mapMeterRow_);
  const latestByType = {};
  METER_TYPES.forEach(t => {
    const found = docs.find(d => d.meterType === t);
    if (found) latestByType[t] = found;
  });
  return { ok: true, docs, latestByType };
}

function mapMeterRow_(r) {
  return {
    date: r.date,
    meterType: r.meterType,
    value: Number(r.value),
    deltaPct: r.deltaPct === '' || r.deltaPct === undefined ? null : Number(r.deltaPct),
    alertFlag: r.alertFlag === true || r.alertFlag === 'true',
    photoUrl: r.photoUrl || '',
    submittedByName: r.submittedByName || '',
    submittedAt: r.submittedAt || ''
  };
}

function previousMeterValue_(meterType, beforeDate) {
  const rows = sheetToObjects_(getMeterReadingsSheet_())
    .filter(r => r.meterType === meterType && r.date < beforeDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows.length ? Number(rows[0].value) : null;
}

// Recebe a foto (base64), guarda no Drive, roda OCR e já calcula a variação vs. a leitura anterior.
// Se o OCR não conseguir ler um número, a leitura fica sem valor — o gerente confere/digita e usa
// correctMeterReading_ pra corrigir sem precisar reenviar a foto.
function submitMeterReading_(body) {
  if (METER_TYPES.indexOf(body.meterType) < 0) return { ok: false, error: 'invalid_meter_type' };
  if (!body.date) return { ok: false, error: 'missing_date' };
  if (!body.photoBase64) return { ok: false, error: 'missing_photo' };

  const photoUrl = savePhotoToDrive_(body.photoBase64, body.mimeType || 'image/jpeg', body.meterType, body.date);
  const ocr = ocrReadNumber_(body.photoBase64);
  return finalizeMeterReading_(body, ocr.value, photoUrl, ocr.rawText);
}

function correctMeterReading_(body) {
  if (METER_TYPES.indexOf(body.meterType) < 0) return { ok: false, error: 'invalid_meter_type' };
  if (!body.date) return { ok: false, error: 'missing_date' };
  const value = Number(body.value);
  if (isNaN(value)) return { ok: false, error: 'invalid_value' };
  const existing = sheetToObjects_(getMeterReadingsSheet_()).find(r => r.meterType === body.meterType && r.date === body.date);
  return finalizeMeterReading_(body, value, existing ? existing.photoUrl : '', existing ? existing.ocrRaw : '(corrigido manualmente)');
}

function finalizeMeterReading_(body, value, photoUrl, ocrRaw) {
  const prev = previousMeterValue_(body.meterType, body.date);
  const deltaPct = (value != null && prev !== null && prev !== 0) ? ((value - prev) / prev) * 100 : null;
  const alertFlag = deltaPct !== null && Math.abs(deltaPct) >= METER_ALERT_THRESHOLD_PCT;

  upsertByKeys_(getMeterReadingsSheet_(), METER_HEADERS, ['date', 'meterType'], {
    date: body.date,
    meterType: body.meterType,
    value: value == null ? '' : value,
    deltaPct: deltaPct === null ? '' : deltaPct,
    alertFlag: alertFlag,
    photoUrl: photoUrl || '',
    ocrRaw: ocrRaw || '',
    submittedByName: body.submittedByName || '',
    submittedAt: new Date().toISOString()
  });
  return { ok: true, value, deltaPct, alertFlag, photoUrl, prevValue: prev };
}

function getMeterFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('METER_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId) } catch (e) { /* pasta apagada — recria abaixo */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const root = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = 'Leituras de medidores — Seu Justino BI';
  const existing = root.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(name);
  props.setProperty('METER_FOLDER_ID', folder.getId());
  return folder;
}

function savePhotoToDrive_(base64, mimeType, meterType, date) {
  const bytes = Utilities.base64Decode(base64);
  const ext = mimeType.indexOf('png') >= 0 ? 'png' : 'jpg';
  const blob = Utilities.newBlob(bytes, mimeType, date + '_' + meterType + '.' + ext);
  const file = getMeterFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ---------- Manual Operacional (PDF protegido) ----------
//
// SETUP (uma vez só): crie uma pasta chamada exatamente
// "Manual Operacional — Seu Justino BI" na mesma pasta do Drive onde está
// esta planilha (ou deixe o script criar sozinho na primeira chamada) e
// arraste o PDF do manual para dentro dela. Essa pasta NÃO é compartilhada
// com ninguém — o Apps Script lê o arquivo com a identidade de quem
// implantou o app (USER_DEPLOYING) e só devolve os bytes pra quem já tem
// um token válido de login no BI. Não existe link público pro PDF em
// nenhum momento.
function getManualFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('MANUAL_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId) } catch (e) { /* pasta apagada — recria abaixo */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const root = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = 'Manual Operacional — Seu Justino BI';
  const existing = root.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(name);
  props.setProperty('MANUAL_FOLDER_ID', folder.getId());
  return folder;
}

function getManualPdfFile_() {
  const folder = getManualFolder_();
  const files = folder.getFilesByType(MimeType.PDF);
  return files.hasNext() ? files.next() : null;
}

// Baixa só o intervalo de bytes pedido via API do Drive (cabeçalho HTTP Range),
// nunca o arquivo inteiro — usada tanto pelo Manual quanto pelos Pacotes de evento.
// getOAuthToken() já carrega o escopo de Drive que o script usa em DriveApp.
function getDrivePdfRangeBytes_(fileId, offset, length) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media';
  const res = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      Range: 'bytes=' + offset + '-' + (offset + length - 1)
    },
    muteHttpExceptions: true
  });
  return res.getContent();
}

// O PDF é transferido em pedaços (não tudo numa resposta só) porque o manual
// pesa vários MB e a resposta única em base64 estourava o limite de tamanho
// de resposta do Apps Script (o navegador recebia o JSON cortado no meio).
//
// 07/10: achado o motivo real da demora — `file.getBlob().getBytes()` lê o ARQUIVO
// INTEIRO do Drive pra memória do Apps Script, mesmo pra recortar um pedaço pequeno.
// Com N pedaços, o arquivo inteiro era lido do zero N+1 vezes (1 do getInfo + 1 por
// pedaço) — nenhum cache do navegador resolve isso, o desperdício é antes de chegar
// lá. Trocado por `getDrivePdfRangeBytes_`, que usa a API do Drive direto com cabeçalho
// Range (HTTP), baixando só o pedaço pedido — nunca carrega o arquivo inteiro.
function getManualPdfInfo_() {
  const file = getManualPdfFile_();
  if (!file) return { ok: false, error: 'manual_nao_encontrado' };
  return { ok: true, totalBytes: file.getSize(), updatedAt: file.getLastUpdated().toISOString() };
}

function getManualPdfChunk_(offset, length) {
  const file = getManualPdfFile_();
  if (!file) return { ok: false, error: 'manual_nao_encontrado' };
  offset = Math.max(0, Number(offset) || 0);
  length = Math.max(0, Number(length) || 0);
  const bytes = getDrivePdfRangeBytes_(file.getId(), offset, length);
  return { ok: true, base64: Utilities.base64Encode(bytes), offset: offset, length: bytes.length, totalBytes: file.getSize() };
}

// ---------- Pacotes de evento (PDF de referência pra equipe comercial) ----------
//
// Mesmo padrão do Manual Operacional acima (pasta privada + chunk de 3MB) —
// 02/10, pedido do Renato: catálogo de pacotes do Seu Justino (36MB, imagem
// única exportada do Photoshop, não tem texto pra extrair) disponível pra
// consulta dentro da aba Eventos, pra equipe montar cotação olhando preço/
// pacote. Sem marca d'água (diferente do Manual): é material comercial de
// consulta, não confidencial operacional.
//
// SETUP (uma vez só): crie uma pasta chamada exatamente
// "Pacotes Eventos — Seu Justino BI" na mesma pasta do Drive onde está esta
// planilha (ou deixe o script criar sozinho na primeira chamada) e arraste o
// PDF dos pacotes pra dentro dela.
function getEventoPacotesFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('EVENTO_PACOTES_FOLDER_ID');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId) } catch (e) { /* pasta apagada — recria abaixo */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const root = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = 'Pacotes Eventos — Seu Justino BI';
  const existing = root.getFoldersByName(name);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(name);
  props.setProperty('EVENTO_PACOTES_FOLDER_ID', folder.getId());
  return folder;
}

function getEventoPacotesPdfFile_() {
  const folder = getEventoPacotesFolder_();
  const files = folder.getFilesByType(MimeType.PDF);
  return files.hasNext() ? files.next() : null;
}

function getEventoPacotesPdfInfo_() {
  const file = getEventoPacotesPdfFile_();
  if (!file) return { ok: false, error: 'pacotes_nao_encontrado' };
  return { ok: true, totalBytes: file.getSize(), updatedAt: file.getLastUpdated().toISOString() };
}

function getEventoPacotesPdfChunk_(offset, length) {
  const file = getEventoPacotesPdfFile_();
  if (!file) return { ok: false, error: 'pacotes_nao_encontrado' };
  offset = Math.max(0, Number(offset) || 0);
  length = Math.max(0, Number(length) || 0);
  const bytes = getDrivePdfRangeBytes_(file.getId(), offset, length);
  return { ok: true, base64: Utilities.base64Encode(bytes), offset: offset, length: bytes.length, totalBytes: file.getSize() };
}

// 05/10 — DIAGNÓSTICO temporário (catálogo de pacotes "não encontrado" mesmo
// depois do Renato subir o PDF). Rodar manualmente no editor do Apps Script:
// seleciona "diagnosticarPastaPacotes" no dropdown ao lado do botão Executar,
// clica Executar (autoriza se pedir), depois Ver → Registros de execução.
// Usa a MESMA getEventoPacotesFolder_() que a função real usa (respeita o ID
// já guardado em Script Properties) — não é um teste à parte, é literalmente
// o que o sistema está checando. Apagar depois de resolver.
function diagnosticarPastaPacotes() {
  const folder = getEventoPacotesFolder_();
  Logger.log('Pasta checada: "' + folder.getName() + '"');
  Logger.log('URL da pasta: ' + folder.getUrl());
  const files = folder.getFiles();
  let count = 0;
  while (files.hasNext()) {
    const f = files.next();
    Logger.log('Arquivo encontrado: "' + f.getName() + '" | tipo: ' + f.getMimeType());
    count++;
  }
  Logger.log('Total de arquivos nessa pasta: ' + count);
  if (count === 0) Logger.log('A pasta está VAZIA — o PDF não está aqui dentro, mesmo que pareça estar "no Drive".');
  // 10/10 — TEMPORÁRIO: dropdown "Selecionar função" do editor voltou a não mostrar
  // função nova (mesmo bug de 07/10). Rodando diagnosticarZigPayRobo_ daqui, de
  // dentro de função que já aparece no dropdown, até confirmar que a captura da
  // ZigPay está funcionando. Apagar esta chamada depois de confirmado — backfill e
  // gatilho diário entram numa 2ª rodada, só depois do diagnóstico vir OK.
  Logger.log('--- diagnosticarZigPayRobo_ ---');
  Logger.log(diagnosticarZigPayRobo_());
}

// ---------- Dúvidas do manual (roteadas para RH / Gestores / Diretoria) ----------
//
// SETUP (uma vez só, opcional): pra receber e-mail quando alguém manda uma
// dúvida, rode uma vez no console do Apps Script, por área:
//   setManualDestinatarios_('rh', 'rh@seujustino.com.br')
//   setManualDestinatarios_('gestores', 'gestor1@seujustino.com.br,gestor2@seujustino.com.br')
//   setManualDestinatarios_('diretoria', 'renato@seujustino.com.br')
// Sem isso configurado, a dúvida é gravada e aparece normalmente na aba de
// quem for responsável — só o e-mail de aviso não sai.
function setManualDestinatarios_(area, emailsCsv) {
  if (DUVIDA_AREAS.indexOf(area) < 0) throw new Error('área inválida: ' + area);
  PropertiesService.getScriptProperties().setProperty('MANUAL_DEST_' + area.toUpperCase(), String(emailsCsv || '').trim());
  return { ok: true };
}

// ---------- alerta de saúde do robô ZigPay ----------
//
// Sem isso, uma falha silenciosa do robô (PC desligado/deslogado na hora certa,
// sessão da ZigPay morta, bug novo) só é percebida quando alguém repara um número
// faltando ou errado no BI — às vezes dias depois (foi exatamente assim que o bug
// do "R$96.561,02 sem evento nenhum" de 26/09 apareceu: por acaso, não por alerta).
// Confere às 10h (2h de folga depois do robô rodar às 8h) se o faturamento de
// ONTEM já foi gravado; se não, manda um e-mail avisando.
function checkDailyRoboHealth_() {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const ontem = Utilities.formatDate(new Date(Date.now() - 86400000), tz, 'yyyy-MM-dd');
  const jaGravado = sheetToObjects_(getZigRevenueSheet_()).some(r => r.date === ontem);
  if (jaGravado) return;
  const destinatario = PropertiesService.getScriptProperties().getProperty('ROBO_HEALTH_ALERT_EMAIL');
  if (!destinatario) return; // ninguém configurado ainda (ver setupDailyHealthCheckTrigger_) - roda mas não manda nada
  const agora = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm");
  MailApp.sendEmail({
    to: destinatario,
    subject: 'BI Seu Justino: faturamento de ' + ontem + ' ainda não foi gravado',
    body: 'O robô da ZigPay não gravou o faturamento de ' + ontem + ' até agora (' + agora + ', horário de Brasília).\n\n' +
      'Causas mais prováveis: o PC do robô estava desligado/deslogado na hora agendada, a sessão da ZigPay falhou, ou apareceu um erro novo no robô.\n\n' +
      'Confira o arquivo robo_zigpay.log na pasta do robô, ou rode manualmente pra preencher o dia que faltou:\n' +
      'powershell -File robo_zigpay.ps1 -BackfillFrom ' + ontem + ' -BackfillTo ' + ontem
  });
}

// Roda 1x no console do Apps Script (selecione esta função, clique Executar) pra
// ligar o alerta diário — troque o e-mail antes de rodar, ex.:
// setupDailyHealthCheckTrigger_('renato@seudominio.com')
function setupDailyHealthCheckTrigger_(email) {
  if (!email) throw new Error('Passe o e-mail que deve receber o alerta, ex.: setupDailyHealthCheckTrigger_("voce@dominio.com")');
  PropertiesService.getScriptProperties().setProperty('ROBO_HEALTH_ALERT_EMAIL', String(email).trim());
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkDailyRoboHealth_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkDailyRoboHealth_').timeBased().everyDays(1).atHour(10).create();
  return { ok: true };
}

// ---- DRE via Microsoft Graph (SharePoint/OneDrive) — alimenta "Média DRE" de Financeiro ----
// 06/10, pedido do Renato: os valores "Média DRE" (impostos, taxa de cartão, aluguel,
// administrativo fixo) eram fixos no HTML (BASE={...}), digitados uma vez só. A DRE de
// verdade mora numa planilha do SharePoint da empresa (OneDrive for Business) — fora do
// Google Drive, que é tudo que o Apps Script enxerga nativamente — por isso a integração
// usa a API do Microsoft Graph com um app próprio cadastrado no Azure AD da empresa
// (fluxo client credentials, sem usuário logado, permissão de aplicativo Files.Read.All
// com consentimento do admin). Credenciais ficam só no Script Properties
// (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET), nunca no código.
// A planilha real ("DRE Acumulado") não tem 1 coluna fixa pro mês atual — cada mês
// fechado ganha um NOVO trio de colunas à direita (valor/AV%/AH%), com o nome do mês
// ("Agosto/26" etc.) escrito na linha de cabeçalho só na coluna de valor. Por isso
// NÃO guardamos letra de coluna fixa (quebraria todo mês) — a cada execução, o código
// varre a linha de cabeçalho procurando o rótulo do mês-alvo e descobre a coluna
// sozinho. 06/10, pedido do Renato: o mesmo vale pra LINHA — em vez de número fixo
// (que quebraria se o contador inserir/remover uma linha na planilha), cada campo
// é achado pelo TEXTO do rótulo (coluna B), busca por "contém" sem acento/maiúscula,
// igual uma pessoa lendo acharia. O que fica fixo no Script Properties é só o link
// do arquivo (MS_DRE_SHARE_URL) e o termo de busca de cada campo (MS_DRE_CELL_MAP,
// JSON tipo {"sheet":"DRE Acumulado","headerRow":2,"labelColumn":"B","fields":
// {"tax":"Impostos sobre faturamento","card":"Taxas de cartão","rent":"Aluguel + IPTU",
// "adminFixed":"Despesas administrativas","energy":"Energia","water":"Água",
// "gas":"Gás","security":"Segurança"}} — confirmado com o Renato em 06/10) — pra
// adicionar um campo novo no futuro, só acrescenta uma entrada em "fields", não
// precisa mexer no código. Campo cujo texto não é achado fica de fora silenciosamente
// (não derruba os outros) e manda um alerta por e-mail listando o que faltou.
const MESES_PT_BR = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
// Rótulo do mês-alvo pro dia em que o gatilho roda: a DRE fecha com atraso, então no
// dia 10 ainda procuramos o mês ANTERIOR (ex.: gatilho de 10/out procura "Setembro/26",
// não "Outubro/26" — outubro provavelmente nem foi fechado pelo contador ainda).
function mesAlvoDreLabel_() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return MESES_PT_BR[d.getMonth()] + '/' + String(d.getFullYear()).slice(-2);
}
function numeroParaColunaExcel_(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function colunaExcelParaNumero_(letra) {
  let n = 0;
  for (let i = 0; i < letra.length; i++) { n = n * 26 + (letra.charCodeAt(i) - 64); }
  return n;
}
const DRE_SHEET = 'DreBase';
const DRE_HEADERS = ['campo', 'valor', 'mes', 'atualizadoEm'];
function getDreSheet_() { return ensureSheet_(DRE_SHEET, DRE_HEADERS); }

function getMsGraphAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const tenantId = props.getProperty('MS_TENANT_ID');
  const clientId = props.getProperty('MS_CLIENT_ID');
  const clientSecret = props.getProperty('MS_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) throw new Error('Faltam MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET no Script Properties.');
  const cache = CacheService.getScriptCache();
  const cached = cache.get('msGraphToken');
  if (cached) return cached;
  const res = UrlFetchApp.fetch('https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/token', {
    method: 'post',
    payload: {
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    },
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.access_token) throw new Error('Login Microsoft Graph falhou: ' + res.getContentText());
  cache.put('msGraphToken', json.access_token, Math.max(60, (json.expires_in || 3600) - 120));
  return json.access_token;
}

// Converte um link de compartilhamento do SharePoint/OneDrive no formato que o Graph
// aceita em /shares/{id}/driveItem — ver https://learn.microsoft.com/graph/api/shares-get
function encodeMsShareUrl_(url) {
  const b64 = Utilities.base64Encode(url).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return 'u!' + b64;
}

function resolveMsShareUrl_(shareUrl, token) {
  const shareId = encodeMsShareUrl_(shareUrl);
  const res = UrlFetchApp.fetch('https://graph.microsoft.com/v1.0/shares/' + shareId + '/driveItem?$select=id,parentReference,name', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.id) throw new Error('Não consegui resolver o link do SharePoint: ' + res.getContentText());
  return { driveId: json.parentReference.driveId, itemId: json.id, name: json.name };
}

function readMsWorkbookRange_(driveId, itemId, sheetName, rangeAddress, token) {
  const url = 'https://graph.microsoft.com/v1.0/drives/' + driveId + '/items/' + itemId +
    "/workbook/worksheets('" + encodeURIComponent(sheetName) + "')/range(address='" + rangeAddress + "')?$select=values";
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  const json = JSON.parse(res.getContentText());
  if (!json.values) throw new Error('Não consegui ler ' + sheetName + '!' + rangeAddress + ': ' + res.getContentText());
  return json.values;
}
function readMsWorkbookCell_(driveId, itemId, sheetName, cellAddress, token) {
  return readMsWorkbookRange_(driveId, itemId, sheetName, cellAddress, token)[0][0];
}

// Varre a linha de cabeçalho (ex.: linha 2) procurando o rótulo do mês-alvo ("Agosto/26")
// — ele só aparece na coluna de VALOR de cada trio mês (valor/AV%/AH%), nunca nas outras
// duas. Lê até a coluna ZZ (700), bem mais que suficiente pra décadas de meses futuros.
function encontrarColunaDoMesDre_(driveId, itemId, sheetName, headerRow, mesLabel, token) {
  const linha = readMsWorkbookRange_(driveId, itemId, sheetName, 'A' + headerRow + ':ZZ' + headerRow, token)[0];
  const idx = linha.findIndex(function (v) { return String(v || '').trim() === mesLabel; });
  if (idx < 0) throw new Error('Não achei a coluna do mês "' + mesLabel + '" na linha ' + headerRow + ' de "' + sheetName + '".');
  return numeroParaColunaExcel_(idx + 1);
}

function normalizarTextoDre_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
// Lê a coluna de rótulos inteira (até a linha 500, bem mais que a DRE deve ter) 1x só
// — depois cada campo busca em memória, sem bater na API de novo por campo.
function lerRotulosDre_(driveId, itemId, sheetName, labelColumn, token) {
  const vals = readMsWorkbookRange_(driveId, itemId, sheetName, labelColumn + '1:' + labelColumn + '500', token);
  return vals.map(function (r) { return String(r[0] || ''); });
}
// "Contém" normalizado (sem acento/maiúscula) — acha a 1ª linha cujo rótulo contém o
// termo de busca. Ex.: termo "Energia" acha "Energia Elétrica" sem precisar bater
// com o texto inteiro.
function encontrarLinhaPorTermo_(rotulos, termo) {
  const alvo = normalizarTextoDre_(termo);
  const idx = rotulos.findIndex(function (r) { return normalizarTextoDre_(r).indexOf(alvo) >= 0; });
  return idx < 0 ? null : idx + 1;
}

// Lê os valores da DRE pro mês indicado (rótulo tipo "Setembro/26") — usada tanto
// pelo gatilho mensal (atualizarDreFinanceiro_, grava em DreBase) quanto pela busca
// ao vivo de um mês escolhido na tela (getDreParaMes_, não grava nada, só devolve).
// 07/10, achado real (Renato reportou "Impostos: 13743,12%"): cada mês da DRE tem
// 3 colunas (valor em R$ / AV% / AH%) — campo que é % na tela do BI (tax/card/fee/
// incomeTax) precisa ler a coluna DE AO LADO (AV%), não a de valor, senão lê o valor
// em reais e exibe como se fosse porcentagem. cfg.percentuais (lista de chaves de
// campo) marca quais são %; os demais continuam lendo a coluna de valor (R$) direto.
// AV% no Excel guarda a FRAÇÃO (0,0386), não 3,86 — por isso ×100 só nesses campos.
function mesLabelAnteriorDre_(mesLabel, k) {
  const p = String(mesLabel).split('/');
  const idx = MESES_PT_BR.findIndex(function (n) { return normalizarTextoDre_(n) === normalizarTextoDre_(p[0]); });
  if (idx < 0) return null;
  const d = new Date(2000 + Number(p[1]), idx - k, 1);
  return MESES_PT_BR[d.getMonth()] + '/' + String(d.getFullYear()).slice(-2);
}
// 16/10, achados do Renato (campos de Financeiro zerados), 3 causas reais confirmadas lendo a DRE ao vivo:
// (1) MS_DRE_CELL_MAP.percentuais ainda listava os 4 campos de % (tax/card/fee/incomeTax): o servidor devolvia
//     o % da DRE (ex.: 3,65) enquanto o BI, desde 08/10, espera o VALOR EM R$ e divide pelo faturamento —
//     3,65 ÷ 420 mil virava 0,00%. Agora o servidor ignora "percentuais" e SEMPRE lê a coluna de valor (R$).
// (2) Agosto/26 em diante estão sem lançamento em vários campos (Taxas de cartões e Água/Esgoto = 0; os demais
//     repetem o mês anterior). Campo zerado no mês pedido agora usa o último mês anterior COM valor (até 12
//     meses atrás) e informa qual mês foi usado em "fallbacks".
// (3) "(+) Faturamento" é a linha de cabeçalho (valor 0); o faturamento vem das linhas "Receita…" abaixo dela.
// Leitura por COLUNA inteira (1 chamada por mês) em vez de 1 chamada por célula.
function lerValoresDre_(mesLabel) {
  const props = PropertiesService.getScriptProperties();
  const shareUrl = props.getProperty('MS_DRE_SHARE_URL');
  const mapJson = props.getProperty('MS_DRE_CELL_MAP');
  if (!shareUrl || !mapJson) throw new Error('Faltam MS_DRE_SHARE_URL / MS_DRE_CELL_MAP no Script Properties.');
  const cfg = JSON.parse(mapJson);
  const token = getMsGraphAccessToken_();
  const file = resolveMsShareUrl_(shareUrl, token);
  const headerRow = readMsWorkbookRange_(file.driveId, file.itemId, cfg.sheet, 'A' + cfg.headerRow + ':ZZ' + cfg.headerRow, token)[0];
  const rotulos = lerRotulosDre_(file.driveId, file.itemId, cfg.sheet, cfg.labelColumn || 'B', token);
  const cacheCol = {};
  function colunaDoMes(label) {
    const idx = headerRow.findIndex(function (v) { return String(v || '').trim() === label; });
    return idx < 0 ? null : numeroParaColunaExcel_(idx + 1);
  }
  function valoresDaColuna(label) {
    if (!(label in cacheCol)) {
      const col = colunaDoMes(label);
      cacheCol[label] = col ? readMsWorkbookRange_(file.driveId, file.itemId, cfg.sheet, col + '1:' + col + '500', token).map(function (r) { return Number(r[0]) || 0; }) : null;
    }
    return cacheCol[label];
  }
  const colAlvo = valoresDaColuna(mesLabel);
  if (!colAlvo) throw new Error('Não achei a coluna do mês "' + mesLabel + '" na linha ' + cfg.headerRow + ' de "' + cfg.sheet + '".');
  // faturamento = soma das linhas "Receita…" logo abaixo de "(+) Faturamento" (ou a linha de total, se existir)
  function linhasReceita(termo) {
    const base = encontrarLinhaPorTermo_(rotulos, termo);
    if (!base) return [];
    const comp = [];
    for (let i = base; i < rotulos.length && comp.length < 60; i++) {
      const nome = normalizarTextoDre_(rotulos[i]);
      if (nome.charAt(0) === '(') break;
      if (nome.indexOf('receita') === 0) comp.push({ linha: i + 1, nome: nome });
    }
    const tot = comp.filter(function (c) { return /total|bruta/.test(c.nome); });
    return (tot.length ? [tot[0]] : comp).map(function (c) { return c.linha; });
  }
  function valorCampo(campo, termos, col) {
    let v = 0, achou = false;
    if (campo === 'revenue') {
      termos.forEach(function (termo) { linhasReceita(termo).forEach(function (l) { achou = true; v += col[l - 1] || 0; }); });
      return { v: v, achou: achou };
    }
    termos.forEach(function (termo) {
      const linha = encontrarLinhaPorTermo_(rotulos, termo);
      if (!linha) return;
      achou = true;
      v += col[linha - 1] || 0;
    });
    return { v: v, achou: achou };
  }
  const values = {}, naoAchados = [], fallbacks = {}, pctFallback = {};
  const PCT_CAMPOS = ['tax', 'card', 'fee', 'incomeTax'];
  const termosRec = cfg.fields && cfg.fields.revenue ? (Array.isArray(cfg.fields.revenue) ? cfg.fields.revenue : [cfg.fields.revenue]) : ['(+) Faturamento'];
  Object.keys(cfg.fields || {}).forEach(function (campo) {
    const termos = Array.isArray(cfg.fields[campo]) ? cfg.fields[campo] : [cfg.fields[campo]];
    const r = valorCampo(campo, termos, colAlvo);
    if (!r.achou) { naoAchados.push(campo); return; }
    let valor = r.v;
    if (valor === 0) {
      for (let k = 1; k <= 12; k++) {
        const lbl = mesLabelAnteriorDre_(mesLabel, k);
        const col = lbl && valoresDaColuna(lbl);
        if (!col) break;
        const rk = valorCampo(campo, termos, col);
        if (rk.achou && rk.v !== 0) {
          valor = rk.v; fallbacks[campo] = lbl;
          // campo de %: R$ de outro mês ÷ faturamento do mês ATUAL não faz sentido — guarda o % do próprio mês de origem
          if (PCT_CAMPOS.indexOf(campo) >= 0) { const rec = valorCampo('revenue', termosRec, col).v; if (rec > 0) pctFallback[campo] = valor / rec * 100; }
          break;
        }
      }
    }
    values[campo] = valor;
  });
  return { mes: mesLabel, values: values, naoAchados: naoAchados, fallbacks: fallbacks, pctFallback: pctFallback };
}

function atualizarDreFinanceiro_() {
  const mesLabel = mesAlvoDreLabel_();
  try {
    const r = lerValoresDre_(mesLabel);
    const sh = getDreSheet_();
    const agora = new Date().toISOString();
    let gravados = 0;
    Object.keys(r.values).forEach(function (campo) {
      upsertByKeys_(sh, DRE_HEADERS, ['campo'], { campo: campo, valor: r.values[campo], mes: (r.fallbacks && r.fallbacks[campo]) || mesLabel, atualizadoEm: agora });
      gravados++;
    });
    if (r.naoAchados.length) {
      const destinatario = PropertiesService.getScriptProperties().getProperty('ROBO_HEALTH_ALERT_EMAIL');
      if (destinatario) {
        try { MailApp.sendEmail({ to: destinatario, subject: 'BI Seu Justino — alguns campos da DRE não foram achados', body: 'Não achei linha na planilha pra: ' + r.naoAchados.join(', ') + ' (mês ' + mesLabel + '). Confira o texto de busca em MS_DRE_CELL_MAP — os demais campos foram atualizados normalmente.' }); } catch (e2) { /* e-mail falhou, segue o run normalmente */ }
      }
    }
    ['tax', 'card', 'fee', 'incomeTax'].forEach(function (c) { upsertByKeys_(sh, DRE_HEADERS, ['campo'], { campo: 'pct:' + c, valor: (r.pctFallback && r.pctFallback[c] != null) ? r.pctFallback[c] : '', mes: mesLabel, atualizadoEm: agora }); });
    upsertByKeys_(sh, DRE_HEADERS, ['campo'], { campo: '_versao', valor: DRE_VERSAO_VALORES, mes: mesLabel, atualizadoEm: agora });
    return { ok: true, mes: mesLabel, gravados: gravados, naoAchados: r.naoAchados, fallbacks: r.fallbacks };
  } catch (e) {
    const destinatario = PropertiesService.getScriptProperties().getProperty('ROBO_HEALTH_ALERT_EMAIL');
    if (destinatario) {
      try { MailApp.sendEmail({ to: destinatario, subject: 'BI Seu Justino — falha ao atualizar DRE do SharePoint', body: String(e) }); } catch (e2) { /* e-mail falhou, erro original já será relançado abaixo */ }
    }
    throw e;
  }
}

// 07/10, pedido do Renato: "Mês de referência" em Financeiro busca a DRE AO VIVO pro
// mês escolhido (não só o mês mais recente fechado) — não grava em DreBase (esse
// cache é só pro mês "atual" do gatilho mensal), só devolve pra tela mostrar na hora.
function getDreParaMes_(mesKey) {
  if (!mesKey || mesKey.length < 7) return { ok: false, error: 'mes_invalido' };
  const d = new Date(Number(mesKey.slice(0, 4)), Number(mesKey.slice(5, 7)) - 1, 1);
  const mesLabel = MESES_PT_BR[d.getMonth()] + '/' + String(d.getFullYear()).slice(-2);
  try {
    const r = lerValoresDre_(mesLabel);
    return { ok: true, mes: r.mes, values: r.values, naoAchados: r.naoAchados, fallbacks: r.fallbacks, pctFallback: r.pctFallback };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// DIAGNÓSTICO — rodar manualmente no editor do Apps Script (selecionar
// "diagnosticarDre_" no dropdown ao lado de Executar) quando o BI não estiver
// puxando os valores da DRE. Mostra cada etapa da configuração e tenta rodar de
// verdade, pra achar em qual passo está travando sem precisar adivinhar.
function diagnosticarDre_() {
  const props = PropertiesService.getScriptProperties();
  const linhas = [];
  ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_DRE_SHARE_URL', 'MS_DRE_CELL_MAP'].forEach(function (k) {
    const v = props.getProperty(k);
    linhas.push(k + ': ' + (v ? 'configurado (' + v.length + ' caractere(s))' : 'FALTANDO'));
  });
  const dreRows = sheetToObjects_(getDreSheet_());
  linhas.push('Aba DreBase: ' + dreRows.length + ' linha(s) gravada(s)' + (dreRows.length ? ' — última atualização: ' + dreRows.map(function (r) { return r.atualizadoEm }).sort().pop() : ''));
  linhas.push('');
  linhas.push('--- Tentando rodar atualizarDreFinanceiro_() agora ---');
  try {
    const r = atualizarDreFinanceiro_();
    linhas.push('OK: ' + JSON.stringify(r));
    // 08/10: valor por campo, não só o resumo — Renato reportou "Água/esgoto" vindo
    // R$0, suspeito. Com isso dá pra conferir campo a campo contra a planilha real,
    // sem precisar adivinhar qual deles está errado.
    linhas.push('--- Valor gravado por campo ---');
    sheetToObjects_(getDreSheet_()).forEach(function (row) {
      linhas.push(row.campo + ': ' + row.valor);
    });
  } catch (e) {
    linhas.push('FALHOU: ' + String(e));
  }
  const texto = linhas.join('\n');
  Logger.log(texto);
  return texto;
}

// versão do formato gravado em DreBase: v2 = campos de % guardados em R$ (o BI divide pelo faturamento)
const DRE_VERSAO_VALORES = 'v2-reais';
function getDreBase_() {
  let rows = sheetToObjects_(getDreSheet_());
  const ver = rows.find(function (r) { return r.campo === '_versao'; });
  if (!ver || ver.valor !== DRE_VERSAO_VALORES) {
    // base antiga (gravada com % em vez de R$): reatualiza uma vez, direto da DRE
    try { atualizarDreFinanceiro_(); rows = sheetToObjects_(getDreSheet_()); } catch (e) { /* mantém o que existe */ }
  }
  const out = {}, mesPorCampo = {}, pctFallback = {};
  rows.forEach(function (r) {
    if (r.campo === '_versao') return;
    if (String(r.campo).indexOf('pct:') === 0) { if (r.valor !== '' && r.valor != null) pctFallback[String(r.campo).slice(4)] = Number(r.valor); return; }
    out[r.campo] = r.valor; mesPorCampo[r.campo] = r.mes || '';
  });
  return { ok: true, values: out, mesPorCampo: mesPorCampo, pctFallback: pctFallback };
}

// Histórico de faturamento mês a mês direto da DRE (SharePoint) — pro gráfico de
// Marketing "Faturamento histórico". Pedido do Renato 10/10: diferente de
// getDreParaMes_ (1 mês por vez, genérico pra qualquer campo de MS_DRE_CELL_MAP),
// esta função varre a planilha INTEIRA de uma vez — lê a linha de cabeçalho (todos
// os meses existentes) e a linha de "(+) Faturamento" cada uma 1x só (não 1x por
// mês, senão seriam dezenas de chamadas ao Graph pra montar o histórico desde 2024).
// Descobre sozinha até onde a DRE realmente tem dado (não assume que começa em
// janeiro/2024 nem força parar numa data fixa) — meses sem coluna na planilha
// simplesmente não entram na série. Cache de 6h (CacheService): o dado só muda
// quando o contador fecha um mês novo, não precisa bater no SharePoint a cada clique.
// 16/10: chave nova (v2) — a anterior guardou por 6h uma série toda zerada (bug abaixo).
const DRE_HISTORICO_CACHE_KEY = 'dreFaturamentoHistorico_v2';
function getFaturamentoHistoricoDre_(force) {
  const cache = CacheService.getScriptCache();
  const cached = force ? null : cache.get(DRE_HISTORICO_CACHE_KEY); // 16/10: botão Atualizar força releitura da planilha
  if (cached) return JSON.parse(cached);
  const resultado = (function () {
    const props = PropertiesService.getScriptProperties();
    const shareUrl = props.getProperty('MS_DRE_SHARE_URL');
    const mapJson = props.getProperty('MS_DRE_CELL_MAP');
    if (!shareUrl || !mapJson) return { ok: false, error: 'config_faltando' };
    const cfg = JSON.parse(mapJson);
    // 10/10: "Faturamento Bruto" não existe na DRE de verdade — confirmado via
    // diagnóstico (rotulosDisponiveis) que o nome real da linha é "(+) Faturamento"
    // (1ª linha da DRE, antes de qualquer dedução — existe também "(=) Receita
    // Bruta", já líquida de cortesia/desconto, e várias "Receita <categoria>"
    // soltas incluindo "Receita Entradas" — mas o card quer o total bruto mesmo,
    // mesmo conceito que alimenta "Faturamento do mês" hoje).
    const termoFaturamento = (cfg.fields && cfg.fields.revenue) || '(+) Faturamento';
    try {
      const token = getMsGraphAccessToken_();
      const file = resolveMsShareUrl_(shareUrl, token);
      const headerRow = readMsWorkbookRange_(file.driveId, file.itemId, cfg.sheet, 'A' + cfg.headerRow + ':ZZ' + cfg.headerRow, token)[0];
      const rotulos = lerRotulosDre_(file.driveId, file.itemId, cfg.sheet, cfg.labelColumn || 'B', token);
      const linha = encontrarLinhaPorTermo_(rotulos, termoFaturamento);
      if (!linha) {
        // 10/10, achado do Renato: termo "Faturamento Bruto" não bateu com
        // nenhuma linha de verdade — devolve as linhas não-vazias da DRE pra
        // diagnosticar o nome real sem precisar abrir a planilha manualmente.
        const rotulosNaoVazios = rotulos.map(function (r) { return String(r || '').trim() }).filter(function (r) { return r }).slice(0, 80);
        return { ok: false, error: 'linha_nao_achada', termo: termoFaturamento, rotulosDisponiveis: rotulosNaoVazios };
      }
      // 16/10, CAUSA RAIZ do gráfico zerado (confirmado lendo a DRE ao vivo): "(+) Faturamento"
      // é a linha 2, que é TAMBÉM a linha de cabeçalho dos meses — ali cada coluna de mês tem
      // o texto "Setembro/26", não número (Number("Setembro/26") = NaN → 0). O faturamento de
      // verdade são as linhas de baixo ("Receita Entradas", "Receita Alimentos", "Receita
      // Bebidas"…), até a próxima linha de grupo que começa com "(". Então soma essas linhas;
      // se existir uma linha de total entre elas, usa só ela pra não contar em dobro.
      const comp = [];
      for (let i = linha; i < rotulos.length && comp.length < 60; i++) {
        const nome = normalizarTextoDre_(rotulos[i]);
        if (nome.charAt(0) === '(') break;
        if (nome.indexOf('receita') === 0) comp.push({ linha: i + 1, rotulo: String(rotulos[i]).trim() });
      }
      if (!comp.length) return { ok: false, error: 'linha_nao_achada', termo: termoFaturamento + ' (nenhuma linha "Receita…" abaixo dela)', rotulosDisponiveis: rotulos.map(function (r) { return String(r || '').trim() }).filter(function (r) { return r }).slice(0, 80) };
      const totais = comp.filter(function (c) { return /total|bruta/.test(normalizarTextoDre_(c.rotulo)) });
      const usadas = totais.length ? [totais[0]] : comp;
      const ultima = usadas[usadas.length - 1].linha, primeira = usadas[0].linha;
      const bloco = readMsWorkbookRange_(file.driveId, file.itemId, cfg.sheet, 'A' + primeira + ':ZZ' + ultima, token);
      const dadosLinha = [];
      usadas.forEach(function (c) {
        const linhaVals = bloco[c.linha - primeira] || [];
        linhaVals.forEach(function (v, idx) { dadosLinha[idx] = (dadosLinha[idx] || 0) + (typeof v === 'number' ? v : 0); });
      });
      // Cada mês só aparece na coluna de VALOR do trio (valor/AV%/AH%), nunca nas
      // outras duas — mesmo padrão de encontrarColunaDoMesDre_, só que descobrindo
      // TODOS os meses de uma vez (regex "<texto>/NN") em vez de 1 rótulo específico.
      const regexMes = /^(.+)\/(\d{2})$/;
      const serie = [];
      headerRow.forEach(function (v, idx) {
        const m = regexMes.exec(String(v || '').trim());
        if (!m) return;
        const mesIdx = MESES_PT_BR.findIndex(function (nome) { return normalizarTextoDre_(nome) === normalizarTextoDre_(m[1]); });
        if (mesIdx < 0) return;
        const ano = 2000 + Number(m[2]);
        const valor = Number(dadosLinha[idx]) || 0;
        serie.push({ mes: ano + '-' + String(mesIdx + 1).padStart(2, '0'), label: String(v).trim(), valor: valor });
      });
      serie.sort(function (a, b) { return a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : 0; });
      return { ok: true, termo: termoFaturamento, linha: linha, componentes: usadas.map(function (c) { return c.rotulo }), serie: serie, atualizadoEm: new Date().toISOString() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();
  if (resultado.ok) cache.put(DRE_HISTORICO_CACHE_KEY, JSON.stringify(resultado), 21600);
  return resultado;
}

// DIAGNÓSTICO TEMPORÁRIO 10/10 — dumpa as linhas 1-6 da DRE (rótulo na
// labelColumn + valor na coluna do mês pedido, achada do mesmo jeito que o
// resto do código já faz) pra entender por que "(+) Faturamento" bate a linha
// 2 mas devolve 0. Apagar junto com a ação 'debugDreLinhas' no router quando
// resolvido.
function debugDreLinhas_(mesKey) {
  const props = PropertiesService.getScriptProperties();
  const shareUrl = props.getProperty('MS_DRE_SHARE_URL');
  const mapJson = props.getProperty('MS_DRE_CELL_MAP');
  if (!shareUrl || !mapJson) return { ok: false, error: 'config_faltando' };
  const cfg = JSON.parse(mapJson);
  const d = new Date(Number(mesKey.slice(0, 4)), Number(mesKey.slice(5, 7)) - 1, 1);
  const mesLabel = MESES_PT_BR[d.getMonth()] + '/' + String(d.getFullYear()).slice(-2);
  try {
    const token = getMsGraphAccessToken_();
    const file = resolveMsShareUrl_(shareUrl, token);
    const coluna = encontrarColunaDoMesDre_(file.driveId, file.itemId, cfg.sheet, cfg.headerRow, mesLabel, token);
    const linhas = [];
    for (let i = 1; i <= 6; i++) {
      const rotulo = readMsWorkbookCell_(file.driveId, file.itemId, cfg.sheet, (cfg.labelColumn || 'B') + i, token);
      const valor = readMsWorkbookCell_(file.driveId, file.itemId, cfg.sheet, coluna + i, token);
      linhas.push({ linha: i, rotulo: rotulo, valorNaColunaDoMes: valor });
    }
    return { ok: true, mesLabel: mesLabel, coluna: coluna, headerRow: cfg.headerRow, linhas: linhas };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Rodar 1x manualmente no editor (selecionar esta função → Executar) depois de
// configurar MS_DRE_SHARE_URL e MS_DRE_CELL_MAP no Script Properties — liga o gatilho
// mensal (todo dia 10, 6h da manhã). Idempotente: pode rodar de novo sem duplicar.
function configurarGatilhoMensalDre_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'atualizarDreFinanceiro_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('atualizarDreFinanceiro_').timeBased().onMonthDay(10).atHour(6).create();
  return { ok: true };
}

function getDuvidasSheet_() { return ensureSheet_('Duvidas', DUVIDAS_HEADERS) }

function submitDuvida_(body, auth) {
  const area = body.area;
  if (DUVIDA_AREAS.indexOf(area) < 0) return { ok: false, error: 'invalid_area' };
  const question = String(body.question || '').trim();
  if (!question) return { ok: false, error: 'missing_question' };
  const id = Utilities.getUuid();
  getDuvidasSheet_().appendRow([id, new Date().toISOString(), auth.email, area, question, 'pendente', '', '', '']);
  notifyNovaDuvida_(area, auth.email, question);
  return { ok: true, id: id };
}

function getDuvidas_() {
  const rows = sheetToObjects_(getDuvidasSheet_());
  // 03/10 — mesmo desempate já usado em getEventoInteracoes_/getEventoCotacoes_: só
  // createdAt falha quando duas dúvidas nascem no mesmo milissegundo (duas áreas
  // perguntando ao mesmo tempo), __row (ordem física = ordem real de inserção) resolve.
  rows.sort((a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : b.__row - a.__row));
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, createdAt: r.createdAt, askedByEmail: r.askedByEmail, area: r.area,
      question: r.question, status: r.status || 'pendente', answer: r.answer || '',
      answeredByEmail: r.answeredByEmail || '', answeredAt: r.answeredAt || ''
    }))
  };
}

function responderDuvida_(body, auth) {
  const id = body.id;
  const answer = String(body.answer || '').trim();
  if (!id || !answer) return { ok: false, error: 'missing_fields' };
  const sh = getDuvidasSheet_();
  const rows = sheetToObjects_(sh);
  const row = rows.find(r => r.id === id);
  if (!row) return { ok: false, error: 'not_found' };
  // 03/10 — achado da auditoria: faltava checar se quem responde tem acesso à área da
  // dúvida (hasAreaAccess_ já libera master/owner automaticamente pra Diretoria).
  if (!hasAreaAccess_(auth, row.area)) return { ok: false, code: 'forbidden' };
  sh.getRange(row.__row, 1, 1, DUVIDAS_HEADERS.length).setValues([[
    row.id, row.createdAt, row.askedByEmail, row.area, row.question,
    'respondida', answer, auth.email, new Date().toISOString()
  ]]);
  logAudit_(auth, 'update', row.area, 'duvida', row.id, 'Dúvida respondida — ' + row.area + ': ' + row.question, null, { answer: answer });
  notifyDuvidaRespondida_(row.askedByEmail, row.question, answer);
  return { ok: true };
}

// ---------- Contatos de emergência (prestadores de confiança) ----------

// ---- solicitações de alteração de contatos (a Diretoria aprova) ----
const CONTATO_SOLIC_HEADERS = ['id', 'tipo', 'contatoId', 'contatoNome', 'dataJson', 'solicitadoPorEmail', 'solicitadoEm', 'status', 'decididoPorEmail', 'decididoEm', 'nota'];
function getContatoSolicSheet_() { return ensureSheet_('ContatosSolicitacoes', CONTATO_SOLIC_HEADERS) }
function isDiretoria_(auth) { return auth.role === 'owner' || hasAreaAccess_(auth, 'master') }
function criarSolicitacaoContato_(auth, tipo, body) {
  const sh = getContatoSolicSheet_();
  const rows = sheetToObjects_(sh);
  let nome = String(body.nome || '').trim(), dados;
  if (tipo === 'apagar') {
    const c = sheetToObjects_(getContatosEmergenciaSheet_()).find(function (r) { return r.id === body.id });
    if (!c) return { ok: false, error: 'not_found' };
    nome = c.nome; dados = { id: body.id };
  } else {
    if (!nome || !String(body.telefone || '').trim()) return { ok: false, error: 'missing_fields' };
    dados = { id: body.id || '', nome: nome, categoria: String(body.categoria || '').trim(), telefone: String(body.telefone || '').trim(), observacao: String(body.observacao || '').trim(), ativo: body.ativo !== false };
  }
  // já existe pedido igual esperando a Diretoria? devolve o mesmo (evita fila duplicada)
  const dup = rows.find(function (r) { return r.status === 'pendente' && r.tipo === tipo && String(r.solicitadoPorEmail).toLowerCase() === String(auth.email).toLowerCase() && (tipo === 'criar' ? String(r.contatoNome).toLowerCase() === nome.toLowerCase() : r.contatoId === (body.id || '')) });
  if (dup) return { ok: true, solicitacao: true, id: dup.id, repetida: true };
  const id = Utilities.getUuid();
  sh.appendRow([id, tipo, body.id || '', nome, JSON.stringify(dados), String(auth.email || '').toLowerCase(), new Date().toISOString(), 'pendente', '', '', '']);
  return { ok: true, solicitacao: true, id: id };
}
function getContatoSolicitacoes_(auth) {
  const dir = isDiretoria_(auth);
  return sheetToObjects_(getContatoSolicSheet_())
    .filter(function (r) { return dir || String(r.solicitadoPorEmail).toLowerCase() === String(auth.email || '').toLowerCase() })
    .sort(function (a, b) { return a.solicitadoEm < b.solicitadoEm ? 1 : -1 })
    .slice(0, 80)
    .map(function (r) {
      return { id: r.id, tipo: r.tipo, contatoId: r.contatoId || '', contatoNome: r.contatoNome || '', dados: safeParse_(r.dataJson, {}), solicitadoPorEmail: r.solicitadoPorEmail, solicitadoEm: r.solicitadoEm, status: r.status, decididoPorEmail: r.decididoPorEmail || '', decididoEm: r.decididoEm || '', nota: r.nota || '' };
    });
}
function decidirSolicitacaoContato_(auth, id, approve, nota) {
  if (!isDiretoria_(auth)) return { ok: false, code: 'forbidden' };
  if (!id) return { ok: false, error: 'missing_id' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000) } catch (e) { return { ok: false, error: 'busy' } }
  try {
    const sh = getContatoSolicSheet_();
    const row = sheetToObjects_(sh).find(function (r) { return r.id === id });
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== 'pendente') return { ok: false, error: 'ja_decidida' };
    const d = safeParse_(row.dataJson, {});
    let resumo = row.tipo + ' — ' + (row.contatoNome || '');
    if (approve) {
      let r;
      if (row.tipo === 'apagar') { r = deleteContatoEmergencia_(auth, d.id); if (!r.ok && r.error === 'not_found') r = { ok: true } }
      else r = saveContatoEmergencia_(d, { email: row.solicitadoPorEmail });
      if (!r.ok) return r;
    }
    sh.getRange(row.__row, 8, 1, 4).setValues([[approve ? 'aprovado' : 'recusado', auth.email, new Date().toISOString(), String(nota || '')]]);
    return { ok: true, resumo: resumo };
  } finally { lock.releaseLock() }
}
function getContatosEmergenciaSheet_() { return ensureSheet_('ContatosEmergencia', CONTATO_EMERGENCIA_HEADERS) }

function getContatosEmergencia_() {
  const rows = sheetToObjects_(getContatosEmergenciaSheet_());
  rows.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id, nome: r.nome, categoria: r.categoria || '', telefone: r.telefone || '',
      observacao: r.observacao || '', ativo: r.ativo !== 'nao',
      createdByEmail: r.createdByEmail || '', createdAt: r.createdAt || ''
    }))
  };
}

function saveContatoEmergencia_(body, auth) {
  const nome = String(body.nome || '').trim();
  const telefone = String(body.telefone || '').trim();
  if (!nome || !telefone) return { ok: false, error: 'missing_fields' };
  const sh = getContatosEmergenciaSheet_();
  const id = body.id || Utilities.getUuid();
  const rows = sheetToObjects_(sh);
  const existing = rows.find(r => r.id === id);
  const rowValues = [
    id, nome, String(body.categoria || '').trim(), telefone,
    String(body.observacao || '').trim(), body.ativo === false ? 'nao' : 'sim',
    existing ? existing.createdByEmail : auth.email,
    existing ? existing.createdAt : new Date().toISOString()
  ];
  let linhaGravada;
  if (existing) {
    sh.getRange(existing.__row, 1, 1, CONTATO_EMERGENCIA_HEADERS.length).setValues([rowValues]);
    linhaGravada = existing.__row;
  } else {
    sh.appendRow(rowValues);
    linhaGravada = sh.getLastRow();
  }
  // 20/10: telefone começando com '+' (ex.: +55 11 …) era lido pela planilha como FÓRMULA e virava #ERROR! — grava a célula como texto puro
  sh.getRange(linhaGravada, 4).setNumberFormat('@').setValue(telefone);
  return { ok: true, id: id };
}

function deleteContatoEmergencia_(auth, id) {
  const sh = getContatosEmergenciaSheet_();
  const rows = sheetToObjects_(sh);
  const row = rows.find(r => r.id === id);
  if (!row) return { ok: false, error: 'not_found' };
  logDeletion_(auth, 'contatoEmergencia', '', 'geral', row.nome + ' (' + row.telefone + ')', row);
  sh.deleteRow(row.__row);
  return { ok: true };
}

function notifyNovaDuvida_(area, askedByEmail, question) {
  try {
    const csv = PropertiesService.getScriptProperties().getProperty('MANUAL_DEST_' + area.toUpperCase());
    if (!csv) return;
    const to = csv.split(',').map(s => s.trim()).filter(Boolean).join(',');
    if (!to) return;
    MailApp.sendEmail({
      to: to,
      subject: 'Nova dúvida do Manual Operacional — Seu Justino',
      body: 'Pergunta de ' + askedByEmail + ':\n\n' + question + '\n\nResponda pela aba correspondente no BI Gerencial.'
    });
  } catch (e) { /* configuração de destinatário ausente ou envio falhou — dúvida já está gravada mesmo assim */ }
}

function notifyDuvidaRespondida_(askedByEmail, question, answer) {
  try {
    MailApp.sendEmail({
      to: askedByEmail,
      subject: 'Sua dúvida no Manual Operacional foi respondida',
      body: 'Sua pergunta:\n' + question + '\n\nResposta:\n' + answer
    });
  } catch (e) { /* e-mail do solicitante pode não aceitar envio — resposta já está gravada mesmo assim */ }
}

// Usa a Cloud Vision API com a identidade do próprio script (sem chave separada pra guardar).
// Exige: Vision API habilitada no projeto do Google Cloud associado a este Apps Script, e o
// escopo 'cloud-platform' declarado no appsscript.json (ver README de setup).
function ocrReadNumber_(base64) {
  try {
    const payload = { requests: [{ image: { content: base64 }, features: [{ type: 'TEXT_DETECTION' }] }] };
    const res = UrlFetchApp.fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const json = JSON.parse(res.getContentText());
    const rawText = (json.responses && json.responses[0] && json.responses[0].fullTextAnnotation
      ? json.responses[0].fullTextAnnotation.text : '') || '';
    return { value: extractMeterNumber_(rawText), rawText };
  } catch (e) {
    return { value: null, rawText: 'erro_ocr: ' + String(e) };
  }
}

// Medidores costumam mostrar 5-6 dígitos inteiros (às vezes 1 casa decimal em vermelho).
// Pega a maior sequência de dígitos (com ou sem separador decimal) achada no texto lido.
function extractMeterNumber_(text) {
  const matches = text.match(/\d[\d.,]{3,}\d|\d{4,}/g);
  if (!matches || !matches.length) return null;
  matches.sort((a, b) => b.replace(/\D/g, '').length - a.replace(/\D/g, '').length);
  const num = parseFloat(matches[0].replace(',', '.'));
  return isNaN(num) ? null : num;
}

// ---------- faturamento ZigPay (robô) ----------

function getZigRevenueSheet_() { return ensureSheet_('ZigRevenue', ZIGREVENUE_HEADERS) }

// ---------- ZigPay — captura embutida no Apps Script (sem navegador, sem precisar
// do computador do Renato ligado) ----------
// Pedido do Renato 10/10: o robô local (robo_zigpay.ps1, Agendador de Tarefas do
// Windows) não rodou nos dias 05-10/10, zerando os cards de "semana atual" na
// Diretoria. Achado no próprio robo_zigpay.ps1 (investigação de 26/09 documentada
// lá): login/faturamento/público/horário por bloco de 30min são pura API HTTP
// (JSON-RPC "sdkgen" da ZigPay) — SEM navegador nenhum, só a venda por item (CMV
// teórico parcial) ainda usa Selenium (API não devolve SKU/categoria por item).
// Isso tornaria a parte quebrada hoje 100% portável pro Apps Script, rodando no
// servidor do Google via gatilho diário — não dependeria de nada ligado localmente.
// CMV teórico parcial CONTINUA só no robô local (robo_zigpay.ps1, -SkipCmv tira só
// essa parte se um dia quiser rodar os dois em paralelo sem duplicar faturamento).
//
// ATUALIZAÇÃO 10/10, MESMO DIA: achado que muda a conclusão acima — a ZigPay
// colocou a API (logIn incluso) atrás de proteção anti-bot da Cloudflare (403
// "Attention Required!"), confirmado bloqueando TANTO daqui (Apps Script) QUANTO
// do próprio computador do Renato, local, desde 06/10 — não é bloqueio de IP de
// datacenter do Google como pareceu no 1º teste, é a técnica de login via API pura
// que a ZigPay fechou pra todo mundo. As funções abaixo (invokeZigSdkgen_ e por
// diante) ficam no código, mas estão DORMENTES — vão continuar tomando 403
// enquanto esse bloqueio durar, não têm como contornar daqui (não dá pra resolver
// desafio JavaScript da Cloudflare sem navegador de verdade). O FIX de verdade pro
// problema original (cards de "semana atual" zerados) está no robô local
// (robo_zigpay.ps1) — ganhou um fallback automático via navegador (Selenium, que
// AINDA passa pela Cloudflare) pra faturamento quando a API falhar; só público e
// horário por bloco ficam sem captura enquanto durar (não têm equivalente fora da
// API). Deixei esse bloco aqui pro caso de a Cloudflare liberar de novo no futuro.
const ZIGPAY_API_BASE = 'https://api.zigcore.com.br/enterprise-postgres';
const ZIGPAY_PLACE_ID = 'baa37552-df9e-42a7-9010-d108ee1a3710'; // Seu Justino Madalena, fixo (não muda entre sessões)

function zigRandomHex_(len) {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * 16));
  return s;
}

// Chamada sdkgen genérica — mesmo formato de payload que o robô local usa
// (Invoke-ZigSdkgen), só trocando Invoke-WebRequest por UrlFetchApp.
function invokeZigSdkgen_(name, sdkArgs, deviceId, maxTentativas) {
  maxTentativas = maxTentativas || 3;
  const body = {
    args: sdkArgs,
    deviceInfo: { id: deviceId, language: 'pt-BR', platform: { browserUserAgent: 'bi-seu-justino-apps-script' }, timezone: 'America/Sao_Paulo', type: 'web', version: '' },
    extra: { tz: 'America/Sao_Paulo', lng: 'pt-BR' },
    name: name,
    requestId: zigRandomHex_(32),
    version: 3
  };
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      const res = UrlFetchApp.fetch(ZIGPAY_API_BASE + '/' + name, {
        method: 'post',
        contentType: 'application/sdkgen',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      const texto = res.getContentText();
      let parsed;
      try {
        parsed = JSON.parse(texto);
      } catch (eParse) {
        // 10/10 — achado do Renato: 1ª tentativa real devolveu HTML (<!DOCTYPE) em vez
        // de JSON, suspeita de bloqueio anti-bot contra IP de datacenter do Google.
        // Erro agora mostra código HTTP + início do corpo de verdade, pra confirmar
        // (em vez de só "SyntaxError: Unexpected token" sem contexto nenhum).
        throw new Error('ZigPay API devolveu resposta não-JSON em "' + name + '" (HTTP ' + res.getResponseCode() + '): ' + texto.slice(0, 300));
      }
      if (parsed.error) throw new Error('ZigPay API recusou "' + name + '": ' + parsed.error.message);
      return parsed.result;
    } catch (e) {
      if (tentativa === maxTentativas) throw e;
      Utilities.sleep(3000);
    }
  }
}

// Login por HTTP puro — deviceId novo a cada execução (login de novo é barato,
// evita depender de um deviceId antigo que a ZigPay possa ter revogado).
function zigPayLogin_() {
  const props = PropertiesService.getScriptProperties();
  const username = props.getProperty('ZIGPAY_USERNAME');
  const password = props.getProperty('ZIGPAY_PASSWORD');
  const organization = props.getProperty('ZIGPAY_ORGANIZATION');
  if (!username || !password || !organization) throw new Error('Faltam ZIGPAY_USERNAME/ZIGPAY_PASSWORD/ZIGPAY_ORGANIZATION no Script Properties.');
  const deviceId = zigRandomHex_(40);
  invokeZigSdkgen_('logIn', { username: username, password: password, organizationUsername: organization }, deviceId);
  return deviceId;
}

// Mês inteiro (faturamento + público por evento) numa chamada só — month aqui é
// 1-12 (convertido pro 0-indexado que a API espera por dentro).
function zigGetEventsForMonth_(deviceId, year, month1a12) {
  return invokeZigSdkgen_('getEvents', { placeId: ZIGPAY_PLACE_ID, month: month1a12 - 1, year: year }, deviceId);
}

// Soma income/totalPublic por data de calendário (data de início do evento) — um
// dia pode ter mais de um evento, soma os dois. Mesma regra do robô local.
function zigGroupEventsByDate_(eventsResult) {
  const porData = {};
  (eventsResult.events || []).forEach(function (ev) {
    const data = String(ev.begin).slice(0, 10);
    if (!porData[data]) porData[data] = { revenue: 0, publico: 0, servico: 0, eventIds: [] };
    porData[data].revenue += (ev.income || 0) / 100;
    porData[data].servico += ((ev.sales && ev.sales.service) || 0) / 100;
    porData[data].publico += ev.totalPublic || 0;
    porData[data].eventIds.push(ev.id);
  });
  return porData;
}

function zigGetConsumptionTimeline_(deviceId, eventId) {
  return invokeZigSdkgen_('getConsumptionTimeline', { eventId: eventId }, deviceId);
}

// Captura faturamento + público + horário de UM dia e já grava direto nas abas do
// BI (chama as mesmas funções internas que o router usa pra 'submitZigRevenue'/
// 'submitZigPublico'/'submitZigHourly' — sem round-trip de HTTP, já estamos dentro
// do Apps Script). Dia sem evento = R$0/0 clientes (loja fechada), mantém 1 linha
// por dia, igual o robô local sempre fez.
function zigCapturarParaData_(deviceId, isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  const eventsResult = zigGetEventsForMonth_(deviceId, d.getFullYear(), d.getMonth() + 1);
  const porData = zigGroupEventsByDate_(eventsResult);
  const info = porData[isoDate] || { revenue: 0, publico: 0, servico: 0, eventIds: [] };
  submitZigRevenue_({ date: isoDate, revenue: info.revenue, servico: info.servico, source: 'robo-zigpay-apps-script' });
  submitZigPublico_({ date: isoDate, publico: info.publico, source: 'robo-zigpay-apps-script' });
  const buckets = {};
  info.eventIds.forEach(function (eventId) {
    try {
      (zigGetConsumptionTimeline_(deviceId, eventId) || []).forEach(function (b) {
        if (!buckets[b.start]) buckets[b.start] = { start: b.start, intervalInMinutes: b.intervalInMinutes, value: 0 };
        buckets[b.start].value += b.value;
      });
    } catch (e) {
      Logger.log('AVISO: falha ao ler horário do evento ' + eventId + ' (' + isoDate + '): ' + e);
    }
  });
  const bucketsList = Object.keys(buckets).map(function (k) { return buckets[k] });
  if (bucketsList.length) submitZigHourly_({ date: isoDate, buckets: bucketsList, source: 'robo-zigpay-apps-script' });
  return { date: isoDate, revenue: info.revenue, publico: info.publico, servico: info.servico, horarioBuckets: bucketsList.length };
}

// Roda via gatilho diário (ver configurarGatilhoDiarioZigPay_) — sempre o dia de
// ONTEM (hoje ainda não fechou, dado viria parcial) — mesmo padrão do robô local.
function capturarZigPayDiario_() {
  try {
    const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const isoDate = Utilities.formatDate(ontem, tz, 'yyyy-MM-dd');
    const deviceId = zigPayLogin_();
    const r = zigCapturarParaData_(deviceId, isoDate);
    return { ok: true, resultado: r };
  } catch (e) {
    const destinatario = PropertiesService.getScriptProperties().getProperty('ROBO_HEALTH_ALERT_EMAIL');
    if (destinatario) {
      try { MailApp.sendEmail({ to: destinatario, subject: 'BI Seu Justino — falha na captura diária da ZigPay', body: String(e) }); } catch (e2) { /* e-mail falhou, erro original já será relançado abaixo */ }
    }
    throw e;
  }
}

// Preenche retroativo um intervalo de datas (ex.: dias que o robô local deixou de
// rodar, como 05-10/10/26) — rodar manualmente no editor (mudar as 2 datas na
// chamada de exemplo no fim do arquivo, ou chamar direto com os parâmetros certos
// via "Executar função" não dá — só funções sem parâmetro aparecem lá; mais fácil
// editar temporariamente as 2 linhas abaixo e rodar). Agrupa por mês sozinho (não
// repete chamada à API pra dias do mesmo mês, getEvents já traz o mês inteiro).
function capturarZigPayBackfill_(dataInicio, dataFim) {
  const deviceId = zigPayLogin_();
  const datas = [];
  let d = new Date(dataInicio + 'T12:00:00');
  const fim = new Date(dataFim + 'T12:00:00');
  while (d <= fim) {
    datas.push(Utilities.formatDate(d, 'America/Sao_Paulo', 'yyyy-MM-dd'));
    d.setDate(d.getDate() + 1);
  }
  const resultados = datas.map(function (isoDate) {
    try { return zigCapturarParaData_(deviceId, isoDate); }
    catch (e) { return { date: isoDate, erro: String(e) }; }
  });
  Logger.log(JSON.stringify(resultados, null, 2));
  return resultados;
}
// Backfill dos dias que o robô local deixou de rodar (05-10/10/26) — rodar 1x
// manualmente (selecionar esta função no dropdown → Executar) depois de configurar
// ZIGPAY_USERNAME/ZIGPAY_PASSWORD/ZIGPAY_ORGANIZATION no Script Properties.
function backfillZigPayOutubro2026_() {
  return capturarZigPayBackfill_('2026-10-05', '2026-10-10');
}

// Rodar 1x manualmente no editor depois de configurar ZIGPAY_USERNAME/
// ZIGPAY_PASSWORD/ZIGPAY_ORGANIZATION no Script Properties — liga o gatilho diário
// (8h, mesmo horário que o Agendador de Tarefas do Windows usava localmente).
function configurarGatilhoDiarioZigPay_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'capturarZigPayDiario_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('capturarZigPayDiario_').timeBased().everyDays(1).atHour(8).create();
  return { ok: true };
}

// DIAGNÓSTICO — rodar manualmente no editor quando a captura da ZigPay não
// estiver funcionando. Confere config + tenta logar + tenta capturar o dia de
// ontem, sem precisar adivinhar em qual passo está travando.
function diagnosticarZigPayRobo_() {
  const props = PropertiesService.getScriptProperties();
  const linhas = [];
  ['ZIGPAY_USERNAME', 'ZIGPAY_PASSWORD', 'ZIGPAY_ORGANIZATION'].forEach(function (k) {
    const v = props.getProperty(k);
    linhas.push(k + ': ' + (v ? 'configurado (' + v.length + ' caractere(s))' : 'FALTANDO'));
  });
  linhas.push('');
  linhas.push('--- Tentando logar + capturar o dia de ontem agora ---');
  try {
    const r = capturarZigPayDiario_();
    linhas.push('OK: ' + JSON.stringify(r));
  } catch (e) {
    linhas.push('FALHOU: ' + String(e));
  }
  const texto = linhas.join('\n');
  Logger.log(texto);
  return texto;
}

function submitZigRevenue_(body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  const revenue = Number(body.revenue);
  if (isNaN(revenue) || revenue < 0) return { ok: false, error: 'invalid_revenue' };
  const sh = getZigRevenueSheet_();
  const existing = sheetToObjects_(sh).find(r => r.date === body.date) || {};
  upsertByKeys_(sh, ZIGREVENUE_HEADERS, ['date'], {
    date: body.date,
    revenue: revenue,
    publico: existing.publico !== undefined ? existing.publico : '',
    source: body.source || 'robo-zigpay',
    capturedAt: new Date().toISOString(),
    // taxa de serviço do dia (sales.service do getEvents, em reais) — só sobrescreve
    // se o robô mandou; senão preserva o que já estava gravado.
    servico: (body.servico !== undefined && body.servico !== null && !isNaN(Number(body.servico)))
      ? Number(body.servico)
      : (existing.servico !== undefined ? existing.servico : '')
  });
  return { ok: true };
}

// Gravado à parte de submitZigRevenue_ (fonte diferente: tela "Eventos", não
// "Relatório geral") — faz merge em vez de sobrescrever a linha inteira, pra não
// apagar o faturamento já gravado daquele dia (upsertByKeys_ grava a linha toda).
function submitZigPublico_(body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  const publico = Number(body.publico);
  if (isNaN(publico) || publico < 0) return { ok: false, error: 'invalid_publico' };
  const sh = getZigRevenueSheet_();
  const existing = sheetToObjects_(sh).find(r => r.date === body.date) || {};
  upsertByKeys_(sh, ZIGREVENUE_HEADERS, ['date'], {
    date: body.date,
    revenue: existing.revenue !== undefined ? existing.revenue : '',
    publico: publico,
    source: existing.source || body.source || 'robo-zigpay-publico',
    capturedAt: new Date().toISOString(),
    servico: existing.servico !== undefined ? existing.servico : ''
  });
  return { ok: true };
}

// Faturamento por bloco de 30min dentro do dia (endpoint sdkgen getConsumptionTimeline
// do ZigPay) — proxy de "calor de atendimento" ao longo do dia, usado pela escala
// sugerida completa (Gerente Operador). Grava o dia inteiro de uma vez (substitui).
const ZIGHOURLY_HEADERS = ['date', 'start', 'intervalInMinutes', 'value', 'source', 'capturedAt'];
function getZigHourlySheet_() { return ensureSheet_('ZigHourly', ZIGHOURLY_HEADERS) }

function submitZigHourly_(body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  if (!Array.isArray(body.buckets)) return { ok: false, error: 'missing_buckets' };
  const sh = getZigHourlySheet_();
  const rows = sheetToObjects_(sh);
  rows.filter(function (r) { return r.date === body.date })
    .map(function (r) { return r.__row })
    .sort(function (a, b) { return b - a })
    .forEach(function (rowNum) { sh.deleteRow(rowNum) });
  const capturedAt = new Date().toISOString();
  const out = body.buckets.map(function (b) {
    return [body.date, b.start || '', Number(b.intervalInMinutes) || 30, Number(b.value) || 0, body.source || 'robo-zigpay', capturedAt];
  });
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, ZIGHOURLY_HEADERS.length).setValues(out);
  return { ok: true, count: out.length };
}

function getZigHourly_(days) {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const desde = Utilities.formatDate(new Date(Date.now() - (days || 60) * 86400000), tz, 'yyyy-MM-dd');
  const rows = sheetToObjects_(getZigHourlySheet_()).filter(function (r) { return r.date >= desde });
  return {
    ok: true,
    items: rows.map(function (r) {
      return { date: r.date, start: r.start, intervalInMinutes: Number(r.intervalInMinutes) || 30, value: Number(r.value) || 0 };
    })
  };
}

// Detalhe por bloco de 30min: itens de comida/bebida vendidos e pessoas que entraram
// (getProductsSoldAtEventInPeriodV2 + getEntrancesSoldAtEventInPeriod do ZigPay, pelo
// robo_zigpay_detalhe.ps1). Alimenta a escala sugerida POR SETOR (Gerente Operador):
// cozinha segue a curva de comida, bar a de bebida, portaria a de entradas.
// `start` guarda o horario exatamente como a ZigPay devolve (UTC) — mesma convencao da
// aba ZigHourly; o BI converte pra Brasilia (UTC-3) ao ler. Valores em CENTAVOS.
const ZIGHOURLYDETAIL_HEADERS = ['date', 'start', 'foodValue', 'foodCount', 'bevValue', 'bevCount', 'otherValue', 'otherCount', 'entries', 'source', 'capturedAt'];
function getZigHourlyDetailSheet_() { return ensureSheet_('ZigHourlyDetail', ZIGHOURLYDETAIL_HEADERS) }

function submitZigHourlyDetail_(body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  if (!Array.isArray(body.buckets)) return { ok: false, error: 'missing_buckets' };
  const sh = getZigHourlyDetailSheet_();
  const rows = sheetToObjects_(sh);
  rows.filter(function (r) { return r.date === body.date })
    .map(function (r) { return r.__row })
    .sort(function (a, b) { return b - a })
    .forEach(function (rowNum) { sh.deleteRow(rowNum) });
  const capturedAt = new Date().toISOString();
  const n = function (v) { return Number(v) || 0 };
  const out = body.buckets.map(function (b) {
    return [body.date, b.start || '', n(b.foodValue), n(b.foodCount), n(b.bevValue), n(b.bevCount), n(b.otherValue), n(b.otherCount), n(b.entries), body.source || 'robo-zigpay-detalhe', capturedAt];
  });
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, ZIGHOURLYDETAIL_HEADERS.length).setValues(out);
  return { ok: true, count: out.length };
}

function getZigHourlyDetail_(days) {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const desde = Utilities.formatDate(new Date(Date.now() - (days || 120) * 86400000), tz, 'yyyy-MM-dd');
  const n = function (v) { return Number(v) || 0 };
  const rows = sheetToObjects_(getZigHourlyDetailSheet_()).filter(function (r) { return r.date >= desde });
  return {
    ok: true,
    items: rows.map(function (r) {
      return { date: r.date, start: r.start, foodValue: n(r.foodValue), foodCount: n(r.foodCount), bevValue: n(r.bevValue), bevCount: n(r.bevCount), otherValue: n(r.otherValue), otherCount: n(r.otherCount), entries: n(r.entries) };
    })
  };
}

function getZigRevenue_(limit) {
  const rows = sheetToObjects_(getZigRevenueSheet_());
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const docs = rows.slice(0, limit).map(r => ({
    date: r.date,
    revenue: Number(r.revenue) || 0,
    publico: (r.publico !== '' && r.publico != null) ? Number(r.publico) : null,
    source: r.source || '',
    capturedAt: r.capturedAt || '',
    servico: (r.servico !== '' && r.servico != null) ? Number(r.servico) : null
  }));
  return { ok: true, docs, latest: docs[0] || null };
}

// ---------- Bilheteria (receita de entrada) — pedido do Renato 10/10 ----------
// Fonte: tela "Relatórios de Bilheteria" do dashboard ZigPay (entrance-reports),
// só por navegador (Selenium) — SEM equivalente na API sdkgen (nem a versão
// bloqueada tinha isso; nunca existiu endpoint pra bilheteria). Granularidade
// MENSAL de propósito (não diária) — "Bilheteria do período" já é uma soma do
// range inteiro, não precisa acumular dia a dia como faturamento/público.
const ZIGBILHETERIA_HEADERS = ['mes', 'receita', 'entradasQtd', 'capturedAt', 'source'];
// 10/10, achado real: o Sheets converte sozinho um texto tipo "2026-10" pra DATA
// (vira "2026-10-01" ao ler de volta) — sem isso, o cruzamento com público do mês
// falhava (chaves "2026-10" vs "2026-10-01" nunca batiam) e cada captura nova do
// mesmo mês virava linha duplicada (upsertByKeys_ também compara por igualdade de
// string). setNumberFormat('@') força a coluna A ("mes") a ficar sempre texto puro.
function getZigBilheteriaSheet_() {
  const sh = ensureSheet_('ZigBilheteria', ZIGBILHETERIA_HEADERS);
  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat('@');
  return sh;
}

// Normaliza "mes" pros 7 primeiros caracteres (yyyy-MM) - defensivo contra o
// Sheets ter convertido um valor antigo em data de verdade (ex.: "2026-10-01"
// em vez de "2026-10", achado 10/10 — ver comentário em getZigBilheteriaSheet_).
// Cobre tanto registros já corrompidos quanto qualquer futuro deslize.
function normalizarMesKey_(mes) {
  return String(mes || '').slice(0, 7);
}

function submitZigBilheteria_(body) {
  if (!body.mes || !/^\d{4}-\d{2}$/.test(body.mes)) return { ok: false, error: 'invalid_mes' };
  const receita = Number(body.receita);
  const entradasQtd = Number(body.entradasQtd);
  if (isNaN(receita) || receita < 0) return { ok: false, error: 'invalid_receita' };
  if (isNaN(entradasQtd) || entradasQtd < 0) return { ok: false, error: 'invalid_entradasQtd' };
  const sh = getZigBilheteriaSheet_();
  // upsert manual (em vez de upsertByKeys_ genérico) comparando por
  // normalizarMesKey_ dos dois lados - um registro antigo gravado como data real
  // (ex.: "2026-10-01") ainda precisa ser RECONHECIDO e sobrescrito, não duplicado.
  const rows = sheetToObjects_(sh);
  const match = rows.find(function (r) { return normalizarMesKey_(r.mes) === body.mes });
  const rowValues = ZIGBILHETERIA_HEADERS.map(function (h) {
    const vals = { mes: body.mes, receita: receita, entradasQtd: entradasQtd, capturedAt: new Date().toISOString(), source: body.source || 'robo-zigpay' };
    return vals[h] !== undefined ? vals[h] : '';
  });
  if (match) sh.getRange(match.__row, 1, 1, ZIGBILHETERIA_HEADERS.length).setValues([rowValues]);
  else sh.appendRow(rowValues);
  return { ok: true };
}

// Devolve os últimos N meses de bilheteria + o público do MESMO mês (soma de
// ZigRevenue.publico nos dias daquele mês) já calculado — pra tela não precisar
// cruzar duas fontes sozinha. pctClientesEntradas = entradasQtd ÷ público do mês
// × 100 (confirmado com o Renato 10/10: é essa a conta, não outra).
function getZigBilheteria_(limit) {
  const rows = sheetToObjects_(getZigBilheteriaSheet_());
  rows.forEach(function (r) { r.mes = normalizarMesKey_(r.mes) });
  rows.sort(function (a, b) { return a.mes < b.mes ? 1 : a.mes > b.mes ? -1 : 0 });
  const recortados = rows.slice(0, limit || 13);
  const publicoPorMes = {};
  sheetToObjects_(getZigRevenueSheet_()).forEach(function (r) {
    if (r.publico === '' || r.publico == null) return;
    const mk = String(r.date).slice(0, 7);
    publicoPorMes[mk] = (publicoPorMes[mk] || 0) + (Number(r.publico) || 0);
  });
  const docs = recortados.map(function (r) {
    const publicoMes = publicoPorMes[r.mes] || 0;
    const entradasQtd = Number(r.entradasQtd) || 0;
    return {
      mes: r.mes,
      receita: Number(r.receita) || 0,
      entradasQtd: entradasQtd,
      publicoMes: publicoMes,
      pctClientesEntradas: publicoMes > 0 ? (entradasQtd / publicoMes * 100) : null,
      capturedAt: r.capturedAt || ''
    };
  });
  return { ok: true, docs };
}

// Visão Geral > card "Faturamento do mês": fonte única é a ZigRevenue (robô ZigPay).
// Não usa o histórico manual do Financeiro em Entries — por decisão do Renato, esses
// números (mês, média do ano, ano anterior, semana) só valem o que a ZigPay capturou.
// Como o robô só entrou no ar em 2026-09-22, média do ano e ano anterior ficam "dados
// insuficientes" até acumular histórico suficiente na própria ZigRevenue.
// refDateStr (opcional, 'yyyy-mm-dd'): âncora do período mostrado — cada card de
// faturamento/ticket no cliente navega o PRÓPRIO período independente (seta ◀▶,
// pedido do Renato), então cada um chama essa função com sua própria âncora. Sem
// refDateStr (ou com data no futuro), cai em hoje — mesmo comportamento de sempre.
// A semana só corta no dia de hoje quando a âncora cai na semana CORRENTE; uma
// semana inteira no passado sempre mostra os 7 dias (já aconteceu por completo).
function getRevenueOverview_(refDateStr) {
  const byDate = {};
  const publicoByDate = {};
  sheetToObjects_(getZigRevenueSheet_()).forEach(function (r) {
    byDate[r.date] = Number(r.revenue) || 0;
    if (r.publico !== '' && r.publico != null) publicoByDate[r.date] = Number(r.publico) || 0;
  });
  // Ticket médio = faturamento ÷ público, só somando os DOIS do MESMO dia — dia
  // com faturamento mas sem público registrado (comum em capturas antigas, antes
  // do robô puxar público) fica de fora dos dois lados, não só do público. Somar
  // o faturamento desse dia sem o público correspondente inflava a conta (mais
  // dinheiro contado sem a pessoa correspondente do lado de baixo da divisão) -
  // era a causa real do "ticket do ano" saindo destoante do de semana/mês.
  const ticketMedio = function (dates) {
    let rev = 0, pub = 0, temPublico = false;
    dates.forEach(function (d) {
      if (publicoByDate[d] == null) return;
      rev += byDate[d] || 0;
      pub += publicoByDate[d];
      temPublico = true;
    });
    return (temPublico && pub > 0) ? (rev / pub) : null;
  };

  // Só conta a projeção de um dia se existir um envio real de Marketing pra esse
  // mesmo dia em "Últimos envios" — projeção órfã (dia apagado/nunca lançado) não
  // entra na soma do quadro.
  const marketingEntryDates = {};
  sheetToObjects_(getEntriesSheet_()).forEach(function (r) {
    if (r.area === 'marketing') marketingEntryDates[r.date] = true;
  });
  const planByDate = {};
  sheetToObjects_(getMkPlansSheet_()).forEach(function (r) {
    if (marketingEntryDates[r.date]) planByDate[r.date] = Number(r.revenuePlan) || 0;
  });

  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const now = new Date();
  const todayKey = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const refKey = (refDateStr && /^\d{4}-\d{2}-\d{2}$/.test(refDateStr) && refDateStr <= todayKey) ? refDateStr : todayKey;
  const refDate = new Date(refKey + 'T12:00:00');
  const monthKey = refKey.slice(0, 7);
  const yearKey = refKey.slice(0, 4);

  const sumByMonthZig = {};
  Object.keys(byDate).forEach(function (d) {
    const mk = d.slice(0, 7);
    sumByMonthZig[mk] = (sumByMonthZig[mk] || 0) + byDate[d];
  });

  // 02/10, pedido do Renato: faturamento de Evento REALIZADO entra na conta
  // do mês, no mês de EXECUÇÃO (data do evento, não data de criação/envio do
  // contrato) — separado do ZigPay pra mostrar os dois de onde vieram, e
  // depois somado pro total do mês. 04/10: valor = contrato + excedente PRIMEIRO
  // (pedido do Renato — valorTotal sozinho tinha um dado errado, R$4,1 milhões
  // num evento de dezembro/2025). Mas valorTotal volta como ALTERNATIVA quando
  // contrato+excedente dá zero — evento antigo (antes de contrato/excedente virar
  // prática) só tem esse campo preenchido; tirar ele de vez zerava esses eventos
  // (achado pelo Renato: 36 eventos "realizado" nov/25-jul/26, total quase zerado).
  // 04/10, pedido do Renato: só conta faturamento de evento com contrato ASSINADO
  // (statusContrato contém "assinado") OU pagamento validado (statusPagamento com
  // "pago"/"confirmado"/"quitado"/"recebido"/"liquidado"/"ok", desde que não negado
  // por "não"/"pendente"/"aguardando"/"falta"/"parcial" — "parcial" fica de fora de
  // propósito, vira caso duvidoso alertado no cliente, não some sozinho aqui) —
  // MESMA regra do cliente (html/eventoContratoAssinado + eventoPagamentoValidado),
  // mantidas em sincronia manualmente nos dois arquivos.
  const eventoRevenueByMonth = {};
  const eventoRevenueByDate = {};
  sheetToObjects_(getEventosSheet_()).forEach(function (r) {
    if (r.status !== 'realizado' || !r.data) return;
    const assinado = /assinado/i.test(r.statusContrato || '');
    const pagTxt = String(r.statusPagamento || '').toLowerCase();
    const pagamentoValidado = pagTxt && !/n[ãa]o|pendente|aguardando|falta|parcial/.test(pagTxt) && /pago|confirmado|quitado|recebid|liquidad|\bok\b/.test(pagTxt);
    if (!assinado && !pagamentoValidado) return;
    const viaContrato = (Number(r.valorContrato) || 0) + (Number(r.valorExcedente) || 0);
    const valor = viaContrato > 0 ? viaContrato : (Number(r.valorTotal) || 0);
    const mk = r.data.slice(0, 7);
    eventoRevenueByMonth[mk] = (eventoRevenueByMonth[mk] || 0) + valor;
    eventoRevenueByDate[r.data] = (eventoRevenueByDate[r.data] || 0) + valor;
  });

  // Combinado (ZigPay + Eventos) — essa é a base usada daqui pra baixo pra
  // monthRevenue/média anual/mesmo mês ano anterior, pra tudo que já é
  // mensal ficar consistente com o faturamento de evento incluído também
  // (senão o card do mês bate um valor e a média anual outro, sem bater).
  const sumByMonth = {};
  Object.keys(sumByMonthZig).forEach(function (mk) { sumByMonth[mk] = sumByMonthZig[mk] });
  Object.keys(eventoRevenueByMonth).forEach(function (mk) { sumByMonth[mk] = (sumByMonth[mk] || 0) + eventoRevenueByMonth[mk] });

  const monthRevenueZig = sumByMonthZig[monthKey] || 0;
  const monthRevenueEventos = eventoRevenueByMonth[monthKey] || 0;
  const monthRevenue = sumByMonth[monthKey] || 0;
  const monthProjected = Object.keys(planByDate)
    .filter(function (d) { return d.slice(0, 7) === monthKey })
    .reduce(function (s, d) { return s + planByDate[d] }, 0);
  // 19/10: projetado do mês SÓ ATÉ HOJE (dias já passados) — é a base justa pra comparar com o realizado parcial
  const monthProjectedToDate = Object.keys(planByDate)
    .filter(function (d) { return d.slice(0, 7) === monthKey && d <= refKey })
    .reduce(function (s, d) { return s + planByDate[d] }, 0);

  // Média do ano: só meses completos do ano corrente, exclui o mês em curso.
  const yearMonths = Object.keys(sumByMonth).filter(function (mk) { return mk.slice(0, 4) === yearKey && mk !== monthKey });
  const yearAvgMonthly = yearMonths.length
    ? yearMonths.reduce(function (s, mk) { return s + sumByMonth[mk] }, 0) / yearMonths.length
    : null;

  // 10/10, achado do Renato (print: "-71,1%" no card "Mesmo mês, ano anterior" logo
  // no início do mês, parecendo queda de faturamento que não existia) — bug real:
  // isso somava o mês anterior-ano INTEIRO (ex.: out/25 completo, 31 dias) contra o
  // mês corrente só até hoje (ex.: out/26, só 10 dias) — comparação injusta, sempre
  // dá "queda" grande nos primeiros dias do mês, mesmo com o ritmo de vendas igual.
  // Corrigido pra cortar o ano anterior no MESMO dia do mês (ex.: até 10/out/25) —
  // mesma técnica (recorte de calendário igual nos dois anos) já usada logo abaixo
  // pra ano-até-hoje; agora os dois seguem a mesma regra de verdade, não só no
  // comentário. ZigPay + Eventos, igual monthRevenue (eventoRevenueByDate novo,
  // só pra permitir esse corte por dia — antes só existia por mês).
  const lastYearMonthKey = (Number(yearKey) - 1) + monthKey.slice(4);
  const lastYearCutoffKey = lastYearMonthKey + '-' + refKey.slice(8, 10);
  const lastYearMonthToDateDates = Object.keys(byDate).filter(function (d) { return d.slice(0, 7) === lastYearMonthKey && d <= lastYearCutoffKey; });
  const temDiaAnoAnteriorNoMes = lastYearMonthToDateDates.length > 0 || Object.keys(eventoRevenueByDate).some(function (d) { return d.slice(0, 7) === lastYearMonthKey && d <= lastYearCutoffKey });
  const lastYearSameMonth = temDiaAnoAnteriorNoMes
    ? lastYearMonthToDateDates.reduce(function (s, d) { return s + byDate[d] }, 0)
      + Object.keys(eventoRevenueByDate).filter(function (d) { return d.slice(0, 7) === lastYearMonthKey && d <= lastYearCutoffKey }).reduce(function (s, d) { return s + eventoRevenueByDate[d] }, 0)
    : null;

  // Semana corrente (segunda a domingo), só dias já passados/hoje.
  const dow = now.getDay(); // 0 = domingo
  const diffToMonday = (dow + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  let weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    if (d > now) break;
    weekDates.push(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
  }
  // 19/10, achado do Renato (card "Semana: projetado × faturado" mostrava "R$ 0 (19/10 até 19/10)" na
  // segunda-feira): a casa fecha na segunda e o robô só captura o dia ANTERIOR, então no início da semana
  // a semana corrente ainda não tem nenhum dia com faturamento — o card (e as comparações de semana e
  // ticket da semana) ficavam vazios até quarta. Enquanto a semana corrente não tiver faturamento,
  // usa a ÚLTIMA SEMANA COMPLETA (segunda a domingo) e avisa isso em weekIsPrevious.
  let weekIsPrevious = false;
  if (!weekDates.some(function (d) { return (byDate[d] || 0) > 0 })) {
    weekDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() - 7 + i);
      weekDates.push(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
    }
    weekIsPrevious = true;
  }
  const weekActual = weekDates.reduce(function (s, d) { return s + (byDate[d] || 0) }, 0);
  // Só existe "projetado" de verdade se o Marketing lançou plano pra ALGUM dia dessa
  // semana — sem isso, weekProjected ficava 0 por padrão e o card mostrava o
  // faturamento inteiro como se fosse "acima da projeção", quando na real não tinha
  // projeção nenhuma lançada ainda.
  const hasWeekProjection = weekDates.some(function (d) { return planByDate[d] !== undefined });
  const weekProjected = hasWeekProjection
    ? weekDates.reduce(function (s, d) { return s + (planByDate[d] || 0) }, 0)
    : null;

  // Mesma semana do ano anterior: cada dia da semana corrente deslocado 364 dias (52
  // semanas exatas) pra manter o dia da semana alinhado - deslocar 365 (ou 366) dias
  // jogaria a segunda-feira pra terça, por exemplo, comparando dias diferentes da
  // semana sem querer.
  const weekDatesLastYear = weekDates.map(function (d) {
    const dt = new Date(d + 'T12:00:00');
    dt.setDate(dt.getDate() - 364);
    return Utilities.formatDate(dt, tz, 'yyyy-MM-dd');
  });
  const temAlgumDiaAnoAnterior = weekDatesLastYear.some(function (d) { return byDate[d] !== undefined });
  const weekActualLastYear = temAlgumDiaAnoAnterior
    ? weekDatesLastYear.reduce(function (s, d) { return s + (byDate[d] || 0) }, 0)
    : null;

  // ---------- Ticket médio: semana, mês e ano corrente vs mesmo período do ano
  // anterior (pedido do Renato) - mesma técnica de deslocar data já usada acima
  // pro card de faturamento, só que aplicada em cima do público também.
  const monthDates = Object.keys(byDate).filter(function (d) { return d.slice(0, 7) === monthKey });
  const lastYearMonthDates = Object.keys(byDate).filter(function (d) { return d.slice(0, 7) === lastYearMonthKey });

  // Ano corrente "até hoje" (não o ano inteiro, que ainda nem aconteceu) vs mesmo
  // intervalo (01/jan até o mesmo dia/mês) do ano anterior - comparação justa,
  // mesmo método usado pro mês (mesmo recorte de calendário nos dois anos).
  const yearToDateDates = Object.keys(byDate).filter(function (d) { return d.slice(0, 4) === yearKey && d <= todayKey });
  const lastYearCutoff = (Number(yearKey) - 1) + todayKey.slice(4);
  const yearToDateDatesLastYear = Object.keys(byDate).filter(function (d) { return d.slice(0, 4) === String(Number(yearKey) - 1) && d <= lastYearCutoff });

  return {
    ok: true,
    monthKey: monthKey,
    monthRevenue: monthRevenue,
    monthRevenueZig: monthRevenueZig,
    monthRevenueEventos: monthRevenueEventos,
    monthProjected: monthProjected,
    monthProjectedToDate: monthProjectedToDate,
    yearAvgMonthly: yearAvgMonthly,
    monthsInAverage: yearMonths.length,
    lastYearSameMonth: lastYearSameMonth,
    weekActual: weekActual,
    weekStart: weekDates[0], weekEnd: weekDates[weekDates.length - 1], weekIsPrevious: weekIsPrevious,
    weekProjected: weekProjected,
    weekDiff: hasWeekProjection ? (weekActual - weekProjected) : null,
    weekActualLastYear: weekActualLastYear,
    ticketSemana: ticketMedio(weekDates),
    ticketSemanaAnoAnterior: ticketMedio(weekDatesLastYear),
    ticketMes: ticketMedio(monthDates),
    ticketMesAnoAnterior: ticketMedio(lastYearMonthDates),
    ticketAno: ticketMedio(yearToDateDates),
    ticketAnoAnterior: ticketMedio(yearToDateDatesLastYear)
  };
}

// ---------- CMV teórico parcial (robô ZigPay x ficha técnica Everest) ----------

function getCmvTeoricoSheet_() { return ensureSheet_('CmvTeoricoParcial', CMVTEORICO_HEADERS) }

// 19/10 (revisão do CMV): o relatório de produtos da ZigPay às vezes devolve, pra um dia, a venda de OUTRO
// período — confirmado pelo Renato: 02/09/2026 na ZigPay = vendas R$ 420,23 / recebimentos R$ 1.851,86, mas o
// relatório de produtos trouxe R$ 106.910 (idêntico em 4 leituras; o período mostrado na tela estava certo).
// Regra de consistência: venda por item (comida+bebida) acima de 2× o faturamento do dia — ou acima de R$ 1.000
// num dia de faturamento zero — é dado inconsistente. Não é gravado (submit) e, se já estiver gravado, fica de fora
// dos rankings (leitura), sem apagar nada.
function cmvTotalInconsistente_(total, receita) {
  if (!(total > 0)) return false;
  return receita > 0 ? (total / receita > 2) : (total > 1000);
}
function receitaPorDataZig_() {
  const rev = {};
  sheetToObjects_(getZigRevenueSheet_()).forEach(function (r) { rev[r.date] = Math.max(rev[r.date] || 0, Number(r.revenue) || 0); });
  return rev;
}
function getCmvDatasSuspeitas_() {
  const rev = receitaPorDataZig_();
  const out = {};
  sheetToObjects_(getCmvTeoricoSheet_()).forEach(function (r) {
    const t = (Number(r.valorTotalFood) || 0) + (Number(r.valorTotalBev) || 0);
    if (r.date in rev && cmvTotalInconsistente_(t, rev[r.date])) out[r.date] = true;
  });
  return out;
}
// 23/10: conferir=true (robô, depois de uma recusa por inconsistência) GRAVA o dia mesmo assim, para o Renato conferir; na leitura ele segue
// marcado como suspeito (fora dos cálculos e dos rankings) pela mesma regra de cmvTotalInconsistente_.
function submitCmvTeoricoParcial_(body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n };
  { const rev = receitaPorDataZig_(); const t = num(body.valorTotalFood) + num(body.valorTotalBev);
    if (body.conferir !== true && body.date in rev && cmvTotalInconsistente_(t, rev[body.date])) return { ok: false, error: 'inconsistente_com_faturamento: venda por item R$ ' + Math.round(t) + ' x faturamento R$ ' + Math.round(rev[body.date]) }; }
  upsertByKeys_(getCmvTeoricoSheet_(), CMVTEORICO_HEADERS, ['date'], {
    date: body.date,
    custoFoodTeorico: num(body.custoFoodTeorico),
    valorCobertoFood: num(body.valorCobertoFood),
    valorTotalFood: num(body.valorTotalFood),
    custoBevTeorico: num(body.custoBevTeorico),
    valorCobertoBev: num(body.valorCobertoBev),
    valorTotalBev: num(body.valorTotalBev),
    valorTotalMisto: num(body.valorTotalMisto),
    itensComFicha: num(body.itensComFicha),
    itensSemFicha: num(body.itensSemFicha),
    source: body.source || 'robo-zigpay-cmv',
    capturedAt: new Date().toISOString()
  });
  return { ok: true };
}

function getCmvTeoricoParcial_(limit) {
  const suspeitasCmv = getCmvDatasSuspeitas_();
  const rows = sheetToObjects_(getCmvTeoricoSheet_());
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const pct = (num, den) => den > 0 ? (num / den * 100) : null;
  const docs = rows.slice(0, limit).map(r => {
    const custoFoodTeorico = Number(r.custoFoodTeorico) || 0;
    const valorCobertoFood = Number(r.valorCobertoFood) || 0;
    const valorTotalFood = Number(r.valorTotalFood) || 0;
    const custoBevTeorico = Number(r.custoBevTeorico) || 0;
    const valorCobertoBev = Number(r.valorCobertoBev) || 0;
    const valorTotalBev = Number(r.valorTotalBev) || 0;
    return {
      date: r.date,
      custoFoodTeorico, valorCobertoFood, valorTotalFood,
      custoBevTeorico, valorCobertoBev, valorTotalBev,
      valorTotalMisto: Number(r.valorTotalMisto) || 0,
      itensComFicha: Number(r.itensComFicha) || 0,
      itensSemFicha: Number(r.itensSemFicha) || 0,
      cmvFoodPctSobreCobertura: pct(custoFoodTeorico, valorCobertoFood),
      cmvBevPctSobreCobertura: pct(custoBevTeorico, valorCobertoBev),
      coberturaFoodPct: pct(valorCobertoFood, valorTotalFood),
      coberturaBevPct: pct(valorCobertoBev, valorTotalBev),
      // cobertura combinada (comida+bebida) - o numero que responde "quanto % do
      // que foi vendido esta vinculado a uma ficha tecnica", pra mostrar em
      // destaque no BI. Fica de fora o valorTotalMisto (combos/promocoes/outros/
      // delivery), que nao entra no calculo por categoria de proposito.
      coberturaTotalPct: pct(valorCobertoFood + valorCobertoBev, valorTotalFood + valorTotalBev),
      suspeito: !!suspeitasCmv[r.date],
      source: r.source || '',
      capturedAt: r.capturedAt || ''
    };
  });
  return { ok: true, docs, latest: docs[0] || null };
}

// ---------- Venda por item (robô ZigPay x ficha técnica Everest) ----------
// Detalhe por SKU do dia — o robô já lê isso pro CMV teórico parcial, só nunca
// tinha sido salvo aqui. Alimenta top 6 mais vendidos, top 6 melhor CMV e curva
// ABC (Márcio/CMV) — não tem histórico antes de 2026-09-25 (dia que passou a
// gravar), só daqui pra frente.
const ZIGITEMSALES_HEADERS = ['date', 'sku', 'nome', 'categoria', 'tipo', 'quantidade', 'valorTotal', 'custoUnit', 'source', 'capturedAt'];

function getZigItemSalesSheet_() { return ensureSheet_('ZigItemSales', ZIGITEMSALES_HEADERS) }

function submitZigItemSales_(body) {
  if (!body.date) return { ok: false, error: 'missing_date' };
  const items = Array.isArray(body.items) ? body.items : [];
  { const rev = receitaPorDataZig_(); const t = items.filter(function (i) { return i.tipo === 'comida' || i.tipo === 'bebida' }).reduce(function (s, i) { return s + (Number(i.valorTotal) || 0) }, 0);
    if (body.conferir !== true && body.date in rev && cmvTotalInconsistente_(t, rev[body.date])) return { ok: false, error: 'inconsistente_com_faturamento: venda por item R$ ' + Math.round(t) + ' x faturamento R$ ' + Math.round(rev[body.date]) }; }
  const sh = getZigItemSalesSheet_();
  // Reenviar o mesmo dia substitui (apaga as linhas antigas dessa data antes de
  // gravar) em vez de duplicar — o robô sempre manda o dia inteiro de uma vez.
  const rows = sheetToObjects_(sh);
  rows.filter(r => r.date === body.date).map(r => r.__row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  if (!items.length) return { ok: true, count: 0 };
  const now = new Date().toISOString();
  const out = items.map(function (it) {
    return [
      body.date, it.sku || '', it.nome || '', it.categoria || '', it.tipo || '',
      Number(it.quantidade) || 0, Number(it.valorTotal) || 0,
      it.custoUnit != null ? Number(it.custoUnit) : '',
      body.source || 'robo-zigpay', now
    ];
  });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, ZIGITEMSALES_HEADERS.length).setValues(out);
  return { ok: true, count: out.length };
}

// Agrega os últimos N dias por item (mesmo nome = mesmo item, junta as datas):
// quantidade e valor total somados, CMV% médio ponderado quando tem custo
// conhecido. Devolve top 6 comida/bebida por venda, top 6 por melhor CMV (menor
// %), e a curva ABC de todos os itens por valor vendido.
function getZigItemSalesRanking_(days) {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const desde = Utilities.formatDate(new Date(Date.now() - (days || 30) * 86400000), tz, 'yyyy-MM-dd');
  const suspeitas = getCmvDatasSuspeitas_();
  const rows = sheetToObjects_(getZigItemSalesSheet_()).filter(function (r) { return r.date >= desde && !suspeitas[r.date] });
  const byItem = {};
  rows.forEach(function (r) {
    const key = (r.nome || r.sku || '').trim().toUpperCase();
    if (!key) return;
    if (!byItem[key]) byItem[key] = { nome: r.nome || r.sku, categoria: r.categoria || '', tipo: r.tipo || '', quantidade: 0, valorTotal: 0, custoTotal: 0, temCusto: false };
    const it = byItem[key];
    it.quantidade += Number(r.quantidade) || 0;
    it.valorTotal += Number(r.valorTotal) || 0;
    if (r.custoUnit !== '' && r.custoUnit != null) {
      it.custoTotal += Number(r.custoUnit) * (Number(r.quantidade) || 0);
      it.temCusto = true;
    }
  });
  const itens = Object.keys(byItem).map(function (k) {
    const it = byItem[k];
    const cmvPct = it.temCusto && it.valorTotal > 0 ? (it.custoTotal / it.valorTotal * 100) : null;
    return { nome: it.nome, categoria: it.categoria, tipo: it.tipo, quantidade: it.quantidade, valorTotal: it.valorTotal, cmvPct: cmvPct };
  });
  const porTipo = function (tipo) { return itens.filter(function (i) { return i.tipo === tipo }) };
  const top6Venda = function (lista) { return lista.slice().sort(function (a, b) { return b.valorTotal - a.valorTotal }).slice(0, 6) };
  const top6Cmv = function (lista) {
    return lista.filter(function (i) { return i.cmvPct != null }).sort(function (a, b) { return a.cmvPct - b.cmvPct }).slice(0, 6);
  };
  // Curva ABC: todos os itens (comida+bebida+outros) ordenados por valor vendido,
  // A = até 80% acumulado, B = até 95%, C = resto — corte clássico de curva ABC.
  const todosOrdenados = itens.slice().sort(function (a, b) { return b.valorTotal - a.valorTotal });
  const totalGeral = todosOrdenados.reduce(function (s, i) { return s + i.valorTotal }, 0);
  let acumulado = 0;
  const curvaAbc = todosOrdenados.map(function (i) {
    acumulado += i.valorTotal;
    const pctAcumulado = totalGeral > 0 ? (acumulado / totalGeral * 100) : 0;
    const classe = pctAcumulado <= 80 ? 'A' : pctAcumulado <= 95 ? 'B' : 'C';
    return { nome: i.nome, valorTotal: i.valorTotal, pctAcumulado: pctAcumulado, classe: classe };
  });
  // Itens sem ficha técnica no Everest, ordenados por valor vendido no período -
  // lista pro Márcio priorizar o que cadastrar primeiro (maior valor = maior
  // impacto na cobertura). Separado de "combo" (sub-preparo interno, sem solução
  // automática) porque a maioria desses itens é cadastro simples faltando, não o
  // problema mais difícil do sub-preparo.
  const semFicha = itens
    .filter(function (i) { return !byItem[i.nome.trim().toUpperCase()].temCusto })
    .sort(function (a, b) { return b.valorTotal - a.valorTotal })
    .slice(0, 30)
    .map(function (i) { return { nome: i.nome, categoria: i.categoria, tipo: i.tipo, valorTotal: i.valorTotal, quantidade: i.quantidade } });

  return {
    ok: true,
    days: days || 30,
    top6BebidaVenda: top6Venda(porTipo('bebida')),
    top6ComidaVenda: top6Venda(porTipo('comida')),
    top6BebidaCmv: top6Cmv(porTipo('bebida')),
    top6ComidaCmv: top6Cmv(porTipo('comida')),
    curvaAbc: curvaAbc,
    totalGeral: totalGeral,
    semFicha: semFicha
  };
}

// ---------- Ranking de bandas (agenda artística × faturamento/público ZigPay) ----------
// Não é recalculado automaticamente pelo Apps Script — a planilha da agenda
// artística é externa (Google Sheets separado) e o robô não tem acesso a ela.
// O snapshot é montado por fora (cruzando a agenda com ZigRevenue) e gravado
// aqui via saveBandRanking; o card da aba Marketing só lê o que está salvo.

const BAND_RANKING_HEADERS = ['banda', 'aparicoesTotal', 'diasComDadoReal', 'faturamentoMedio', 'publicoMedio', 'calculadoEm', 'grupo'];

function getBandRankingSheet_() { return ensureSheet_('BandRanking', BAND_RANKING_HEADERS) }

function saveBandRanking_(rows) {
  if (!Array.isArray(rows) || !rows.length) return { ok: false, error: 'empty' };
  const sh = getBandRankingSheet_();
  const calculadoEm = new Date().toISOString();
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, BAND_RANKING_HEADERS.length).clearContent();
  const out = rows.map(function (r) {
    return [r.banda || '', Number(r.aparicoesTotal) || 0, Number(r.diasComDadoReal) || 0, Number(r.faturamentoMedio) || 0, Number(r.publicoMedio) || 0, calculadoEm, r.grupo || 'banda'];
  });
  sh.getRange(2, 1, out.length, BAND_RANKING_HEADERS.length).setValues(out);
  return { ok: true, count: out.length };
}

function getBandRanking_() {
  const rows = sheetToObjects_(getBandRankingSheet_());
  rows.sort(function (a, b) { return (Number(b.faturamentoMedio) || 0) - (Number(a.faturamentoMedio) || 0) });
  return {
    ok: true,
    calculadoEm: rows.length ? rows[0].calculadoEm : null,
    items: rows.map(function (r) {
      return {
        banda: r.banda, aparicoesTotal: Number(r.aparicoesTotal) || 0, diasComDadoReal: Number(r.diasComDadoReal) || 0,
        faturamentoMedio: Number(r.faturamentoMedio) || 0, publicoMedio: Number(r.publicoMedio) || 0, grupo: r.grupo || 'banda'
      };
    })
  };
}

// 22/10 (pedido do Renato): o ranking agora é recalculado sozinho, lendo a planilha "ARTÍSTICO (SEU JUSTINO + PRACINHA + High Line) - 2026"
// (aba "Justino": A data, B dia, C horário, D atração, E estilo) e cruzando com ZigRevenue. Roda todo dia às 7h e quando alguém clica
// em Atualizar. Quem executa o Apps Script precisa ter acesso a essa planilha. O ID pode ser trocado na propriedade AGENDA_ARTISTICA_ID.
const AGENDA_ARTISTICA_ID = '1crRIfD6nXMsRlwpaOPLY38NPDezGn1EcZ8VoZC2Bn_E';
const AGENDA_ARTISTICA_ABA = 'Justino';
function bandaSemAcento_(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '') }
function bandaChave_(nome) { return bandaSemAcento_(String(nome || '').replace(/\([^)]*\)/g, ' ')).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() }
function bandaRotulo_(nome) { return String(nome || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() }
function bandaGrupo_(estilo) {
  const e = bandaSemAcento_(estilo).toLowerCase();
  if (/\bdj\b/.test(e)) return 'dj';
  if (e.indexOf('voz') >= 0) return 'voz';
  return 'banda';
}
function bandaData_(v, tz) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}
function atualizarBandRanking_() {
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const id = PropertiesService.getScriptProperties().getProperty('AGENDA_ARTISTICA_ID') || AGENDA_ARTISTICA_ID;
  let sh;
  try {
    const ss = SpreadsheetApp.openById(id);
    sh = ss.getSheetByName(AGENDA_ARTISTICA_ABA);
    if (!sh) return { ok: false, error: 'Não achei a aba "' + AGENDA_ARTISTICA_ABA + '" na planilha da agenda artística.' };
  } catch (e) {
    return { ok: false, error: 'Não consegui abrir a planilha da agenda artística (a conta que roda o BI precisa ter acesso a ela): ' + igRedigir_(e).slice(0, 160) };
  }
  // receita real por dia (ZigRevenue; último registro de cada data vence; só dias já encerrados)
  const rec = {};
  sheetToObjects_(getZigRevenueSheet_()).forEach(function (r) {
    const d = String(r.date || '').slice(0, 10);
    const v = Number(r.revenue) || 0;
    if (d && d < hoje && v > 0) rec[d] = { rev: v, pub: Number(r.publico) || 0 };
  });
  const vals = sh.getDataRange().getValues();
  const por = {};
  let linhas = 0;
  vals.forEach(function (row) {
    const data = bandaData_(row[0], tz);
    const nome = bandaRotulo_(row[3]);
    if (!data || !nome || data >= hoje) return; // só apresentações já realizadas
    const chave = bandaChave_(nome);
    if (!chave) return;
    linhas++;
    const o = por[chave] || (por[chave] = { nomes: {}, grupos: {}, datas: {} });
    o.nomes[nome] = (o.nomes[nome] || 0) + 1;
    const gr = bandaGrupo_(row[4]);
    o.grupos[gr] = (o.grupos[gr] || 0) + 1;
    o.datas[data] = true;
  });
  const topo = function (m) { return Object.keys(m).sort(function (a, b) { return m[b] - m[a] })[0] };
  const out = [];
  Object.keys(por).forEach(function (k) {
    const o = por[k];
    const datas = Object.keys(o.datas);
    const reais = datas.filter(function (d) { return rec[d] });
    if (reais.length < 2) return; // mesma regra de antes: só entra com 2+ dias de faturamento real
    const fat = reais.reduce(function (t, d) { return t + rec[d].rev }, 0) / reais.length;
    const comPub = reais.filter(function (d) { return rec[d].pub > 0 });
    const pub = comPub.length ? comPub.reduce(function (t, d) { return t + rec[d].pub }, 0) / comPub.length : 0;
    out.push({ banda: topo(o.nomes), aparicoesTotal: datas.length, diasComDadoReal: reais.length, faturamentoMedio: Math.round(fat), publicoMedio: Math.round(pub), grupo: topo(o.grupos) });
  });
  if (!out.length) return { ok: false, error: 'Nenhuma atração com 2 ou mais dias de faturamento real na agenda.' };
  const r = saveBandRanking_(out);
  return { ok: r.ok, count: out.length, apresentacoes: linhas, diasComReceita: Object.keys(rec).length };
}
function configurarGatilhoBandRanking_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'atualizarBandRankingDiario_') ScriptApp.deleteTrigger(t) });
  ScriptApp.newTrigger('atualizarBandRankingDiario_').timeBased().everyDays(1).atHour(7).create();
}
function atualizarBandRankingDiario_() { try { atualizarBandRanking_() } catch (e) { Logger.log('Ranking de bandas: ' + igRedigir_(e)) } }
function garantirGatilhoBandRanking_() {
  try {
    if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'atualizarBandRankingDiario_' })) configurarGatilhoBandRanking_();
  } catch (e) { Logger.log('Gatilho do ranking de bandas não criado: ' + String(e)) }
}
function bandRankingAtualizar() { const r = atualizarBandRanking_(); Logger.log(JSON.stringify(r)); return r } // roda à mão, se quiser testar no editor

// ---------- planilha ----------

function getEntriesSheet_()  { return ensureSheet_('Entries', ENTRIES_HEADERS) }
function getMkPlansSheet_()  { return ensureSheet_('MkPlans', MKPLANS_HEADERS) }
function getSalariesSheet_() { return ensureSheet_('Salaries', SALARIES_HEADERS) }
function getUsersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const legacy = ss.getSheetByName('Admins');
  if (legacy && !ss.getSheetByName('Users')) legacy.setName('Users');
  return ensureSheet_('Users', USERS_HEADERS);
}
function getUserLayoutsSheet_() { return ensureSheet_('UserLayouts', USER_LAYOUTS_HEADERS) }

function saveCardOrder_(auth, area, cardOrder) {
  if (LAYOUT_GRID_IDS.indexOf(area) < 0) return { ok: false, error: 'invalid_area' };
  if (!Array.isArray(cardOrder)) return { ok: false, error: 'invalid_order' };
  const clean = cardOrder.map(String).filter(Boolean).slice(0, 80);
  upsertByKeys_(getUserLayoutsSheet_(), USER_LAYOUTS_HEADERS, ['email', 'area'], {
    email: auth.email, area: area, cardOrderJson: JSON.stringify(clean), updatedAt: new Date().toISOString()
  });
  return { ok: true };
}
function resetCardOrder_(auth, area) {
  if (LAYOUT_GRID_IDS.indexOf(area) < 0) return { ok: false, error: 'invalid_area' };
  deleteByKeys_(getUserLayoutsSheet_(), ['email', 'area'], { email: auth.email, area: area });
  return { ok: true };
}
// Usado só dentro de login_ — monta {area:[cardId,...]} pra todas as áreas do usuário
// de uma vez (sem round-trip extra depois do login).
function getUserLayouts_(email) {
  const rows = sheetToObjects_(getUserLayoutsSheet_()).filter(r => String(r.email).toLowerCase() === String(email).toLowerCase());
  const out = {};
  rows.forEach(r => { try { out[r.area] = JSON.parse(r.cardOrderJson || '[]') } catch (e) { out[r.area] = [] } });
  return out;
}

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else {
    // Confere a linha INTEIRA de cabeçalho, não só a última célula — checagem antiga
    // deixava passar cabeçalho com colunas fora de ordem no meio (ex.: sobra de uma
    // versão anterior do schema), fazendo sheetToObjects_ casar cada coluna com o
    // rótulo errado mesmo a gravação estando certa (achado real: "Freelancers" com
    // status/turno lendo trocado apesar da gravação já corrigida).
    const atual = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    const bate = headers.every((h, i) => atual[i] === h);
    if (!bate) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

// 23/10 (desempenho): dentro de uma chamada 'bootstrap' (várias leituras numa execução só) a mesma aba costumava ser relida por cada ação
// (ZigRevenue, Reservas, Colaboradores, Entries…). Aqui ela é lida uma vez e as próximas leituras recebem cópias. Fora do bootstrap nada muda.
let __memoLeitura = null;
function sheetToObjects_(sh) {
  const memoKey = __memoLeitura ? sh.getName() : null;
  if (memoKey && __memoLeitura[memoKey]) return __memoLeitura[memoKey].map(function (o) { return Object.assign({}, o) });
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = [];
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === '' || c === null)) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      let v = row[idx];
      // O Sheets converte sozinho um texto "2026-09-18" escrito via API pra célula de
      // data de verdade. Sem isso, a leitura volta um objeto Date do Apps Script — quebra
      // toda comparação/agrupamento por string de data (upsert por data, soma por mês,
      // exibição no front) que o resto do código assume ser sempre "AAAA-MM-DD".
      // 30/09: achado bug real (print do Renato — freelancer "teste" mostrando horário
      // "1899-12-30 – 1899-12-30"). O MESMO auto-conversão do Sheets também pega um texto
      // "14:00" (campo type="time" do formulário) e vira célula de HORA — internamente
      // também é um Date, só que com a data zerada em 30/12/1899 (época zero do Sheets,
      // herança do Lotus 1-2-3) e só hora:minuto valendo. Formatando isso como
      // 'yyyy-MM-dd' (regra de cima, pensada pra DATA) devolvia literalmente
      // "1899-12-30" pro campo, perdendo a hora de vez. Corrigido: ano < 1900 nunca é
      // data de verdade neste BI (não tem lançamento de antes de 2020) — é sempre hora
      // pura disfarçada de Date, formata como 'HH:mm' em vez de 'yyyy-MM-dd'.
      if (v instanceof Date) v = v.getFullYear() < 1900 ? Utilities.formatDate(v, tz, 'HH:mm') : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      obj[h] = v;
    });
    obj.__row = i + 1; // linha real na planilha (1-based)
    rows.push(obj);
  }
  if (memoKey) __memoLeitura[memoKey] = rows.map(function (o) { return Object.assign({}, o) });
  return rows;
}

function upsertByKeys_(sh, headers, keyFields, rowObj) {
  const rows = sheetToObjects_(sh);
  const match = rows.find(r => keyFields.every(k => String(r[k]) === String(rowObj[k])));
  const rowValues = headers.map(h => (rowObj[h] !== undefined ? rowObj[h] : ''));
  if (match) {
    sh.getRange(match.__row, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sh.appendRow(rowValues);
  }
}

function deleteByKeys_(sh, keyFields, keyValues) {
  const rows = sheetToObjects_(sh);
  const match = rows.find(r => keyFields.every(k => String(r[k]) === String(keyValues[k])));
  if (!match) return false;
  sh.deleteRow(match.__row);
  return true;
}

// ---------- senha e token ----------

function hashPassword_(password, salt) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + ':' + salt, Utilities.Charset.UTF_8);
  return bytesToHex_(raw);
}

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('HMAC_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('HMAC_SECRET', secret);
  }
  return secret;
}

function hmacHex_(payload) {
  const raw = Utilities.computeHmacSha256Signature(payload, getSecret_());
  return bytesToHex_(raw);
}

function makeToken_(email, role, areasCsv) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = email.toLowerCase() + '|' + role + '|' + expiresAt + '|' + (areasCsv || '');
  const sig = hmacHex_(payload);
  const token = Utilities.base64EncodeWebSafe(payload) + '.' + sig;
  return { token, expiresAt };
}

function verifyToken_(token) {
  if (!token || token.indexOf('.') < 0) return { ok: false };
  const parts = token.split('.');
  const payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  const expectedSig = hmacHex_(payload);
  if (expectedSig !== parts[1]) return { ok: false };
  const [email, role, expiresAtStr, areasCsv] = payload.split('|');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return { ok: false };
  return { ok: true, email, role, areas: parseAreasCsv_(areasCsv || '') };
}

// ---------- Dionísio CRM (atendimento por IA) → BI ----------
// Só campos sem dado pessoal (sem nome, telefone, e-mail, CPF, observação). Datas em yyyy-MM-dd; hora e hora de criação como número (19:30 → 1930, 17 h → 17)
// para a planilha não converter em data/hora. Upsert por id: o robô reenvia o ano inteiro a cada rodada e o status (concluída, cancelada…) vai sendo atualizado.
const CRMRES_HEADERS = ['id', 'data', 'hora', 'status', 'area', 'pessoas', 'motivo', 'origem', 'criadoData', 'criadoHora', 'atendidoIA', 'criadoIA', 'capturedAt'];
const CRMFUNIL_HEADERS = ['capturedAt', 'periodo', 'conversas', 'duvida', 'inicio', 'finalizaram', 'reservasFunil', 'reservasVar', 'sessoes', 'sessoesVar',
  'resolucaoPct', 'atendimentosIA', 'handoff', 'handoffPct', 'metaAds', 'whatsapp', 'instagram', 'comparecimentoPct', 'totalReservas', 'noShows', 'canceladas', 'receita', 'porIAPct'];
function submitCrmReservas_(body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, error: 'sem_linhas' };
  const sh = ensureSheet_('CrmReservas', CRMRES_HEADERS);
  const H = CRMRES_HEADERS.length, last = sh.getLastRow();
  const data = last > 1 ? sh.getRange(2, 1, last - 1, H).getValues() : [];
  const idx = {};
  data.forEach(function (r, i) { idx[String(r[0])] = i; });
  const now = Date.now();   // número (ms): a planilha não converte em data e o BI calcula "atualizado há X h"
  let novos = 0, atualizados = 0;
  rows.forEach(function (r) {
    if (!r || !r.id) return;
    const linha = CRMRES_HEADERS.map(function (h) { return h === 'capturedAt' ? now : (r[h] === undefined || r[h] === null ? '' : r[h]); });
    const at = idx[String(r.id)];
    if (at !== undefined) { data[at] = linha; atualizados++; } else { idx[String(r.id)] = data.length; data.push(linha); novos++; }
  });
  sh.getRange(2, 1, data.length, H).setValues(data);
  try { CacheService.getScriptCache().remove('crmRes'); } catch (e) {}
  return { ok: true, novos: novos, atualizados: atualizados, total: data.length };
}
// Leitura rápida (23/10): sheetToObjects_ formata cada data célula a célula e levava ~37 s com 663 linhas (o Google cortava a resposta).
// Aqui lê tudo de uma vez, formata cada data distinta UMA vez, devolve linhas compactas (colunas + arrays) e guarda 2 min em cache.
function getCrmReservas_() {
  const cache = CacheService.getScriptCache();
  try { const c = cache.get('crmRes'); if (c) return JSON.parse(c); } catch (e) {}
  const sh = ensureSheet_('CrmReservas', CRMRES_HEADERS);
  const cols = CRMRES_HEADERS.filter(function (h) { return h !== 'capturedAt'; });
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, cols: cols, rows: [], atualizadoEm: '' };
  const tz = Session.getScriptTimeZone() || 'America/Sao_Paulo';
  const memo = {};
  const fmt = function (d) { const k = d.getTime(); return memo[k] || (memo[k] = Utilities.formatDate(d, tz, 'yyyy-MM-dd')); };
  const vals = sh.getRange(2, 1, last - 1, CRMRES_HEADERS.length).getValues();
  const ic = CRMRES_HEADERS.indexOf('capturedAt');
  let ultima = 0;
  const rows = [];
  vals.forEach(function (r) {
    if (!r[0]) return;
    const cap = r[ic];
    const t = cap instanceof Date ? cap.getTime() : (typeof cap === 'number' ? cap : (Date.parse(String(cap)) || 0));
    if (t > ultima) ultima = t;
    const o = [];
    for (let i = 0; i < r.length; i++) { if (i === ic) continue; const c = r[i]; o.push(c instanceof Date ? fmt(c) : c); }
    rows.push(o);
  });
  const res = { ok: true, cols: cols, rows: rows, atualizadoEm: ultima ? new Date(ultima).toISOString() : '' };
  try { const j = JSON.stringify(res); if (j.length < 95000) cache.put('crmRes', j, 120); } catch (e) {}
  return res;
}
function submitCrmFunil_(body) {
  const sh = ensureSheet_('CrmFunil', CRMFUNIL_HEADERS);
  const f = body.funil || {};
  const linha = CRMFUNIL_HEADERS.map(function (h) { return h === 'capturedAt' ? new Date().toISOString() : (f[h] === undefined || f[h] === null ? '' : f[h]); });
  sh.appendRow(linha);
  return { ok: true };
}
function getCrmFunil_() {
  const rows = sheetToObjects_(ensureSheet_('CrmFunil', CRMFUNIL_HEADERS));
  rows.sort(function (a, b) { return String(a.capturedAt) < String(b.capturedAt) ? 1 : -1; });
  return { ok: true, rows: rows.slice(0, 90) };
}

// Saúde da configuração do atendimento (23/10): o robô lê as telas de configuração da IA do Dionísio e o SAC e manda só estados e números (nada de conversa nem dado de cliente).
// Uma linha por leitura (capturedAt em ms + JSON); guarda as últimas 200.
function submitCrmConfig_(body) {
  const sh = ensureSheet_('CrmConfig', ['capturedAt', 'json']);
  const j = JSON.stringify(body.config || {});
  if (j.length > 45000) return { ok: false, error: 'grande_demais' };
  sh.appendRow([Date.now(), j]);
  const last = sh.getLastRow();
  if (last > 201) sh.deleteRows(2, last - 201);
  return { ok: true };
}
function getCrmConfig_() {
  const sh = ensureSheet_('CrmConfig', ['capturedAt', 'json']);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  const n = Math.min(40, last - 1);
  const vals = sh.getRange(last - n + 1, 1, n, 2).getValues();
  const rows = [];
  vals.forEach(function (r) { try { rows.push({ capturedAt: Number(r[0]) || String(r[0]), cfg: JSON.parse(String(r[1])) }); } catch (e) {} });
  rows.reverse();
  return { ok: true, rows: rows };
}

// IA do BI: responde só com o resumo de dados que o painel enviou. Limite de 40 perguntas por hora por usuário (controle de custo).
const IA_MODELO = 'claude-sonnet-5-5';
const IA_LIMITE_HORA = 40;
function responderIa_(auth, body) {
  const chave = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!chave) return { ok: false, error: 'ia_nao_configurada' };
  const pergunta = String(body.pergunta || '').trim().slice(0, 800);
  if (!pergunta) return { ok: false, error: 'pergunta_vazia' };
  const cache = CacheService.getScriptCache();
  const k = 'ia:' + String(auth.email || '').toLowerCase() + ':' + Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyyMMddHH');
  const usadas = Number(cache.get(k)) || 0;
  if (usadas >= IA_LIMITE_HORA) return { ok: false, error: 'limite_ia' };
  cache.put(k, String(usadas + 1), 3700);
  const contexto = String(body.contexto || '').slice(0, 60000);
  const msgs = [];
  (Array.isArray(body.historico) ? body.historico : []).slice(-6).forEach(function (m) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.content) msgs.push({ role: m.role, content: String(m.content).slice(0, 3000) });
  });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  msgs.push({ role: 'user', content: 'DADOS DO BI (JSON, atualizados agora):\n' + contexto + '\n\nPERGUNTA: ' + pergunta });
  const sistema = 'Você é o assistente de dados do BI do Seu Justino Vila Madalena (bar/restaurante com música ao vivo, Grupo Ideia). ' +
    'Responda em português do Brasil, direto: conclusão primeiro, depois os números que sustentam. ' +
    'Use SOMENTE os dados fornecidos na mensagem. Se a resposta não estiver neles, diga claramente que o BI não tem esse dado e diga onde ele poderia ser lançado; nunca invente número, data ou nome. ' +
    'Cite datas e valores (R$ com vírgula decimal). Se os dados forem poucos ou parciais, avise. Respostas curtas (até uns 10 linhas), sem enrolação.';
  let resp;
  try {
    resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({ model: IA_MODELO, max_tokens: 1200, system: sistema, messages: msgs })
    });
  } catch (e) { return { ok: false, error: 'ia_indisponivel' }; }
  const code = resp.getResponseCode();
  let j = {};
  try { j = JSON.parse(resp.getContentText()); } catch (e) {}
  if (code !== 200) return { ok: false, error: code === 401 ? 'ia_chave_invalida' : (code === 429 ? 'limite_ia' : 'ia_indisponivel') };
  const texto = (j.content || []).map(function (b) { return b && b.type === 'text' ? b.text : ''; }).join('').trim();
  try { logAudit_(auth, 'ask', 'marketing', 'iaPergunta', '', 'Pergunta à IA: ' + pergunta.slice(0, 120), null, null); } catch (e) {}
  return { ok: true, resposta: texto || '(sem resposta)' };
}

function bytesToHex_(bytes) {
  return bytes.map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('');
}

function safeParse_(str, fallback) {
  try { return str ? JSON.parse(str) : fallback } catch (e) { return fallback }
}

// ZigPay API de integração (23/10): teste de conexão. Rodar manualmente no editor (Executar > zigTeste) e ver o "Registro de execução".
// Usa as propriedades do script ZIG_TOKEN e ZIG_REDE; mostra só id e nome das lojas, nunca o token.
function zigTeste() {
  const props = PropertiesService.getScriptProperties();
  const token = (props.getProperty('ZIG_TOKEN') || '').trim();
  const rede = (props.getProperty('ZIG_REDE') || '').trim();
  if (!token) { Logger.log('FALTA a propriedade ZIG_TOKEN (ou o Valor está vazio).'); return; }
  if (!rede) { Logger.log('FALTA a propriedade ZIG_REDE (ou o Valor está vazio).'); return; }
  // diagnóstico do formato (sem revelar o token): tamanho, pontos (JWT tem 2), aspas/espaços/quebras dentro, prefixo
  Logger.log('Token: ' + token.length + ' caracteres | pontos: ' + (token.split('.').length - 1) + ' | tem aspas: ' + /["']/.test(token) + ' | tem espaço/quebra: ' + /\s/.test(token) + ' | começa com Bearer: ' + /^bearer\s/i.test(token));
  Logger.log('Rede: ' + rede.length + ' caracteres');
  const url = 'https://api.zigcore.com.br/integration/erp/lojas?rede=' + encodeURIComponent(rede);
  const tk = token.replace(/^bearer\s+/i, '');
  let resp = UrlFetchApp.fetch(url, { method: 'get', headers: { Authorization: tk }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) { Logger.log('Sem prefixo: HTTP ' + resp.getResponseCode() + '. Tentando com Bearer...'); const r2 = UrlFetchApp.fetch(url, { method: 'get', headers: { Authorization: 'Bearer ' + tk }, muteHttpExceptions: true }); if (r2.getResponseCode() === 200) resp = r2; else Logger.log('Com Bearer: HTTP ' + r2.getResponseCode()); }
  const code = resp.getResponseCode();
  const txt = resp.getContentText() || '';
  Logger.log('HTTP ' + code);
  if (code !== 200) { Logger.log('Resposta (início): ' + txt.slice(0, 300)); return; }
  let lojas;
  try { lojas = JSON.parse(txt); } catch (e) { Logger.log('Resposta não é JSON: ' + txt.slice(0, 300)); return; }
  Logger.log('Lojas encontradas: ' + lojas.length);
  lojas.forEach(function (l) { Logger.log('id=' + l.id + ' | nome=' + l.name); });
}

// ---------------- ZigPay API de integração: faturamento diário (23/10) ----------------
// Valida: soma de /erp/faturamento SEM a forma "BÔNUS" bate com o faturamento que o robô gravava (17, 18, 20, 21 e 22/10 conferidos).
// Propriedades do script: ZIG_TOKEN, ZIG_LOJA. Só preenche "revenue"; taxa de serviço e público ficam como estão.
function zigGet_(caminho, params) {
  const props = PropertiesService.getScriptProperties();
  const token = (props.getProperty('ZIG_TOKEN') || '').trim();
  if (!token) throw new Error('ZIG_TOKEN vazio');
  const q = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  const resp = UrlFetchApp.fetch('https://api.zigcore.com.br/integration' + caminho + '?' + q, { method: 'get', headers: { Authorization: token }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('ZigPay HTTP ' + resp.getResponseCode() + ' em ' + caminho);
  return JSON.parse(resp.getContentText() || '[]');
}

function zigFaturamentoLinhas_(iso) {
  const loja = (PropertiesService.getScriptProperties().getProperty('ZIG_LOJA') || '').trim();
  if (!loja) throw new Error('ZIG_LOJA vazio');
  return zigGet_('/erp/faturamento', { dtinicio: iso, dtfim: iso, loja: loja });
}

function zigFaturamentoDia_(iso, linhasProntas) {
  const linhas = linhasProntas || zigFaturamentoLinhas_(iso);
  let centavos = 0;
  linhas.forEach(function (l) { if (String(l.paymentName || '').toUpperCase().indexOf('BÔNUS') === -1 && String(l.paymentName || '').toUpperCase().indexOf('BONUS') === -1) centavos += Number(l.value) || 0; });
  return centavos / 100;
}

// gravar=false só mostra no registro (teste). Padrão: últimos 3 dias, incluindo hoje.
function zigSyncFaturamento_(dias, gravar) {
  const tz = 'America/Sao_Paulo';
  const sh = getZigRevenueSheet_();
  const existentes = {};
  sheetToObjects_(sh).forEach(function (r) { existentes[r.date] = Number(r.revenue) || 0; });
  const out = [];
  for (let i = 0; i < dias; i++) {
    const iso = Utilities.formatDate(new Date(Date.now() - i * 86400000), tz, 'yyyy-MM-dd');
    const linhasDia = zigFaturamentoLinhas_(iso);
    const v = zigFaturamentoDia_(iso, linhasDia);
    if (gravar) zigGravarDelivery_(iso, linhasDia);
    const antes = existentes[iso];
    // não troca um valor real por zero (a ZigPay só consolida o dia depois do fechamento)
    const grava = gravar && !(v === 0 && antes > 0);
    if (grava) submitZigRevenue_({ date: iso, revenue: v, source: 'zig-api' });
    out.push(iso + ': API R$ ' + v.toFixed(2) + ' | BI antes ' + (antes === undefined ? '—' : 'R$ ' + antes.toFixed(2)) + (grava ? ' | GRAVADO' : ' | sem gravar'));
  }
  return out;
}

// Teste: rode no editor (Executar > zigTesteFaturamento). Não grava nada.
function zigTesteFaturamento() {
  zigSyncFaturamento_(6, false).forEach(function (l) { Logger.log(l); });
}

// Rotina automática (gatilho): grava os últimos 3 dias.
function zigSyncFaturamento() {
  zigSyncFaturamento_(3, true).forEach(function (l) { Logger.log(l); });
}

// ---------------- ZigPay API de integração: venda por item + CMV teórico parcial (23/10) ----------------
// /erp/saida-produtos (só type "Normal", sem estorno; bruto = unitValue x count). Conferido: bebida de 22/10 bate ao centavo com o robô
// (R$ 3.255,00); a comida vem R$ 168,50 maior porque a API inclui o Brunch vendido pelo iFood, que o relatório do robô não trazia.
// O custo unitário (ficha técnica) vem da própria planilha de itens: reaproveita o último custoUnit já gravado de cada SKU.
const ZIG_CAT_COMIDA = ['PORÇÕES', 'LANCHE', 'LANCHES', 'CAFE', 'SOBREMESAS', 'ACOMPANHAMENTOS', 'CHAPAS', 'PRATOS', 'BRUNCH', 'BUFFET', 'SALADAS', 'ENTRADAS', 'CARNES'];
const ZIG_CAT_BEBIDA = ['TEQUILAS', 'GTS', 'LONG NECKS', 'APERITIVOS', 'CLASSICOS', 'AUTORAIS', 'ENERGETICOS', 'CAIPIS', 'LICORES', 'CHOPPS', 'VINHOS TINTOS', 'SUCOS', 'GINS', 'Cerveja', 'WHISKIES', 'AGUAS', 'DRINKS SEM ALCOOL', 'LATAS', 'REFRIGERANTES', 'RUMS', 'VODKAS', 'VINHOS ESPUMANTES'];

function zigCustosConhecidos_() {
  const custos = {};
  sheetToObjects_(getZigItemSalesSheet_()).forEach(function (r) {
    if (r.sku && r.custoUnit !== '' && r.custoUnit !== null && !isNaN(Number(r.custoUnit))) custos[String(r.sku)] = Number(r.custoUnit);
  });
  return custos;
}

function zigItensDia_(iso, custos) {
  const loja = (PropertiesService.getScriptProperties().getProperty('ZIG_LOJA') || '').trim();
  const linhas = zigGet_('/erp/saida-produtos', { dtinicio: iso, dtfim: iso, loja: loja });
  const porSku = {};
  linhas.forEach(function (l) {
    if (l.type !== 'Normal' || l.isRefunded) return;
    const sku = String(l.productSku || l.productId || '');
    if (!sku) return;
    const cat = String(l.productCategory || '');
    const tipo = ZIG_CAT_COMIDA.indexOf(cat) >= 0 ? 'comida' : (ZIG_CAT_BEBIDA.indexOf(cat) >= 0 ? 'bebida' : 'outro');
    if (!porSku[sku]) porSku[sku] = { sku: sku, nome: l.productName || '', categoria: cat, tipo: tipo, quantidade: 0, valorTotal: 0, custoUnit: custos[sku] !== undefined ? custos[sku] : null };
    porSku[sku].quantidade += Number(l.count) || 0;
    const bruto = (Number(l.unitValue) || 0) * (Number(l.count) || 0) / 100;
    // comida/bebida: valor bruto (igual ao relatório do robô, mantém o histórico). Outros (ex.: OPEN CHOPP em PROMOÇÕES, vendidos com 100% de desconto
    // e cobrados na entrada): valor líquido, senão o "outros" de 21/10 mostraria R$ 7 mil que nunca entraram no caixa.
    porSku[sku].valorTotal += tipo === 'outro' ? Math.max(bruto - (Number(l.discountValue) || 0) / 100, 0) : bruto;
  });
  return Object.keys(porSku).map(function (k) { return porSku[k]; });
}

function zigAgregarCmv_(itens) {
  const a = { custoFoodTeorico: 0, valorCobertoFood: 0, valorTotalFood: 0, custoBevTeorico: 0, valorCobertoBev: 0, valorTotalBev: 0, valorTotalMisto: 0, itensComFicha: 0, itensSemFicha: 0 };
  itens.forEach(function (i) {
    const tem = i.custoUnit !== null && i.custoUnit !== undefined;
    if (i.tipo === 'comida') { a.valorTotalFood += i.valorTotal; if (tem) { a.custoFoodTeorico += i.custoUnit * i.quantidade; a.valorCobertoFood += i.valorTotal; } }
    else if (i.tipo === 'bebida') { a.valorTotalBev += i.valorTotal; if (tem) { a.custoBevTeorico += i.custoUnit * i.quantidade; a.valorCobertoBev += i.valorTotal; } }
    else a.valorTotalMisto += i.valorTotal;
    if (tem) a.itensComFicha++; else a.itensSemFicha++;
  });
  return a;
}

function zigSyncItens_(dias, gravar) {
  const tz = 'America/Sao_Paulo';
  const custos = zigCustosConhecidos_();
  const out = [];
  for (let i = 0; i < dias; i++) {
    const iso = Utilities.formatDate(new Date(Date.now() - i * 86400000), tz, 'yyyy-MM-dd');
    const itens = zigItensDia_(iso, custos);
    const agg = zigAgregarCmv_(itens);
    let msg = iso + ': ' + itens.length + ' itens | comida R$ ' + agg.valorTotalFood.toFixed(2) + ' | bebida R$ ' + agg.valorTotalBev.toFixed(2) + ' | outros R$ ' + agg.valorTotalMisto.toFixed(2) + ' | com ficha ' + agg.itensComFicha + ', sem ' + agg.itensSemFicha;
    if (gravar && itens.length) {
      let r = submitZigItemSales_({ date: iso, items: itens, source: 'zig-api' });
      if (!r.ok && String(r.error).indexOf('inconsistente_com_faturamento') === 0) r = submitZigItemSales_({ date: iso, items: itens, source: 'zig-api', conferir: true });
      const corpo = { date: iso, source: 'zig-api' }; Object.keys(agg).forEach(function (k) { corpo[k] = agg[k]; });
      let c = submitCmvTeoricoParcial_(corpo);
      if (!c.ok && String(c.error).indexOf('inconsistente_com_faturamento') === 0) { corpo.conferir = true; c = submitCmvTeoricoParcial_(corpo); }
      msg += ' | itens ' + (r.ok ? 'GRAVADO' : 'recusado: ' + r.error) + ' | CMV ' + (c.ok ? 'GRAVADO' : 'recusado: ' + c.error);
    }
    out.push(msg);
  }
  return out;
}

// Teste (não grava): Executar > zigTesteItens
function zigTesteItens() {
  zigSyncItens_(4, false).forEach(function (l) { Logger.log(l); });
}

// Rotina completa (gatilho): faturamento primeiro, depois itens e CMV dos últimos 3 dias.
function zigSyncTudo() {
  zigSyncFaturamento_(3, true).forEach(function (l) { Logger.log(l); });
  zigSyncItens_(3, true).forEach(function (l) { Logger.log(l); });
}

// Rode UMA vez no editor (substitui o gatilho anterior): zigSyncTudo a cada 1 hora.
function zigInstalarGatilho() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'zigSyncFaturamento' || t.getHandlerFunction() === 'zigSyncTudo') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('zigSyncTudo').timeBased().everyHours(1).create();
  Logger.log('Gatilho criado: zigSyncTudo (faturamento + itens + CMV) a cada 1 hora.');
}

// Lista as propriedades do script para montar um checklist (ex.: passar o que falta para outra pessoa configurar).
// Segredos (SECRET, TOKEN, KEY, SENHA) saem só como "definido, N caracteres"; o resto (IDs de pasta, e-mails) sai por extenso.
// Rodar no editor: Executar > propriedadesResumo.
function propriedadesResumo() {
  const todas = PropertiesService.getScriptProperties().getProperties();
  Object.keys(todas).sort().forEach(function (k) {
    const v = String(todas[k] || '');
    const segredo = /SECRET|TOKEN|KEY|SENHA|PASSWORD/i.test(k);
    Logger.log(k + ' = ' + (!v ? '(vazio)' : (segredo ? 'definido, ' + v.length + ' caracteres' : (v.length > 120 ? v.slice(0, 120) + '… (' + v.length + ' caracteres)' : v))));
  });
}

// ---------------- Delivery por plataforma (23/10, pedido do Renato: aba Marketing > Delivery) ----------------
// Fonte: forma de pagamento de /erp/faturamento por dia. Uma linha por dia e plataforma (inclusive zero, que marca o dia como lido).
// "APP" = venda pelo aplicativo da ZigPay (não é, necessariamente, delivery de terceiros).
const ZIGDELIVERY_HEADERS = ['date', 'plataforma', 'valor', 'capturedAt'];
const ZIGDELIVERY_PLATAFORMAS = ['IFOOD', 'RAPPI', 'UBER', 'DELIVERY ONLINE', 'APP'];
function getZigDeliverySheet_() { return ensureSheet_('ZigDelivery', ZIGDELIVERY_HEADERS) }

function zigGravarDelivery_(iso, linhas, anexar) {
  const por = {};
  ZIGDELIVERY_PLATAFORMAS.forEach(function (p) { por[p] = 0; });
  linhas.forEach(function (l) {
    const nome = String(l.paymentName || '').toUpperCase().trim();
    if (por[nome] !== undefined) por[nome] += (Number(l.value) || 0) / 100;
  });
  const sh = getZigDeliverySheet_();
  const agora = new Date().toISOString();
  if (anexar) { // dia ainda não gravado: uma escrita só
    const novas = ZIGDELIVERY_PLATAFORMAS.map(function (p) { return [iso, p, Math.round(por[p] * 100) / 100, agora]; });
    sh.getRange(sh.getLastRow() + 1, 1, novas.length, ZIGDELIVERY_HEADERS.length).setValues(novas);
    return;
  }
  ZIGDELIVERY_PLATAFORMAS.forEach(function (p) {
    upsertByKeys_(sh, ZIGDELIVERY_HEADERS, ['date', 'plataforma'], { date: iso, plataforma: p, valor: Math.round(por[p] * 100) / 100, capturedAt: agora });
  });
}

// Histórico: rode no editor (Executar > zigDeliveryHistorico). Lê do mais novo para o mais antigo, pula dias já gravados
// e para sozinho em ~4 min; basta rodar de novo para continuar. Padrão: 150 dias.
function zigDeliveryHistorico() {
  const tz = 'America/Sao_Paulo';
  const inicio = Date.now();
  const ja = {};
  sheetToObjects_(getZigDeliverySheet_()).forEach(function (r) { ja[r.date] = true; });
  let feitos = 0;
  for (let i = 3; i < 150; i++) {
    if (Date.now() - inicio > 240000) { Logger.log('Parou por tempo; rode de novo para continuar. Dias gravados agora: ' + feitos); return; }
    const iso = Utilities.formatDate(new Date(Date.now() - i * 86400000), tz, 'yyyy-MM-dd');
    if (ja[iso]) continue;
    zigGravarDelivery_(iso, zigFaturamentoLinhas_(iso), true);
    feitos++;
  }
  Logger.log('Histórico completo. Dias gravados agora: ' + feitos);
}

function getZigDelivery_(dias) {
  const corte = Utilities.formatDate(new Date(Date.now() - dias * 86400000), 'America/Sao_Paulo', 'yyyy-MM-dd');
  const rows = sheetToObjects_(getZigDeliverySheet_()).filter(function (r) { return String(r.date) >= corte; })
    .map(function (r) { return [String(r.date), String(r.plataforma), Number(r.valor) || 0]; });
  return { ok: true, cols: ['date', 'plataforma', 'valor'], rows: rows, plataformas: ZIGDELIVERY_PLATAFORMAS };
}
