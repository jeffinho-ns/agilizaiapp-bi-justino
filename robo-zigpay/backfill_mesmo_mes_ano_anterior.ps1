<#
  Preenche automaticamente, todo mes, o "mesmo mes do ano anterior" no ZigRevenue
  do BI. Sem isso, o card "Mesmo mes, ano anterior" da Visao Geral fica "Sem
  historico" toda vez que o mes vira — o backfill historico original (22-23/09)
  so cobriu o mes que era relevante naquele momento (setembro/2025), e o robo
  diario so le o dia de ontem, nunca historico de anos passados.

  Chama o robo_zigpay.ps1 em modo -BackfillFrom/-BackfillTo pro mes
  correspondente do ano anterior, com -SkipCmv (essa parte so alimenta o card
  de faturamento comparativo, nao precisa do CMV teorico, e fica muito mais
  rapido sem abrir Chrome/Selenium). O proprio robo_zigpay.ps1 ja pula sozinho
  todo dia que ja estiver gravado (Get-ExistingZigRevenueDates), entao rodar
  isso de novo em cima de um mes que ja foi preenchido e rapido e inofensivo
  (idempotente) — nao ha problema em rodar todo mes pra sempre.

  Pensado pra rodar via Agendador de Tarefas, 1x por mes, perto do dia 2 (nao
  dia 1, pra nao brigar de horario com nada que rode na virada do mes) e antes
  das 8h do robo diario.
#>
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$LogPath = "$ScriptDir\robo_zigpay.log"

$hoje = Get-Date
$anoPassado = $hoje.Year - 1
$mes = $hoje.Month
$primeiroDia = [datetime]::new($anoPassado, $mes, 1)
$ultimoDia = $primeiroDia.AddMonths(1).AddDays(-1)
$de = $primeiroDia.ToString('yyyy-MM-dd')
$ate = $ultimoDia.ToString('yyyy-MM-dd')

$linha = "[{0}] Backfill mensal automatico (mesmo mes ano anterior): {1} a {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $de, $ate
Write-Host $linha
try { Add-Content -Path $LogPath -Value $linha -Encoding utf8 -ErrorAction Stop } catch {}

& "$ScriptDir\robo_zigpay.ps1" -BackfillFrom $de -BackfillTo $ate -SkipCmv
