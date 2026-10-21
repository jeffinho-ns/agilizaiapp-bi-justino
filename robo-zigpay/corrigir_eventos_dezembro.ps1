<#
  Corrige o campo "Valor do contrato" dos eventos de dezembro/2025 (SJM) que
  entraram errados por causa do bug de type="number" comendo a virgula
  digitada (ver 00-sistema/memory.md, 04-05/10/2026, "causa raiz de verdade
  do bug de faturamento de Eventos").

  NAO usa nenhuma credencial salva (nem a de zigpay_credentials.json, que e
  de outro sistema) - pede seu e-mail e senha do proprio BI na hora, direto
  no console. Nada fica gravado em disco nem e visto pelo Claude.

  Reenvia o evento INTEIRO pra cada correcao (nao so o valor), porque
  saveEvento_ no Code.gs substitui a linha inteira pros campos principais
  (so os campos de follow-up sao preservados quando omitidos) - por isso o
  script busca o evento existente primeiro e muda só valorContrato,
  mantendo todo o resto (cliente, status, tipo, pax, etc.) exatamente igual.

  USO:
    powershell -File corrigir_eventos_dezembro.ps1              # so mostra o que mudaria (seguro, nao grava nada)
    powershell -File corrigir_eventos_dezembro.ps1 -Aplicar      # aplica de verdade
#>
param(
  [switch]$Aplicar
)

$ErrorActionPreference = 'Stop'
# 05/10: arquivo sem BOM fazia o PowerShell 5.1 ler "ã"/"ç" como CP1252/850 em vez
# de UTF-8 (apareciam como "Ã§Ã£o" no console) - corrigido salvando o arquivo COM
# BOM (ver fim do script). Isso aqui só ajusta a EXIBIÇÃO no console, não o parse.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'

# Lista de referencia: 27 eventos SJM de dezembro/2025, conferidos contra
# CONTROLE EVENTOS.xlsx (aba "COW ME - 2025", filtrada por CASA=SJM) - soma
# bate exatamente com a conta manual do Renato (R$ 367.878,52).
$Correcoes = @(
  @{ data='2025-12-19'; cliente='Engravida';               valorCorreto=17901.00 }
  @{ data='2025-12-19'; cliente='Agencia VUFT';             valorCorreto=12274.99 }
  @{ data='2025-12-19'; cliente='Medicos sem Fronteiras';   valorCorreto=7160.40 }
  @{ data='2025-12-18'; cliente='Hoffmann';                 valorCorreto=11840.40 }
  @{ data='2025-12-18'; cliente='HakaM Comunicação';        valorCorreto=6500.00 }
  @{ data='2025-12-18'; cliente='Construtora Tenda';        valorCorreto=15400.00 }
  @{ data='2025-12-17'; cliente='Octa';                     valorCorreto=2281.50 }
  @{ data='2025-12-17'; cliente='ROCCA';                    valorCorreto=10420.05 }
  @{ data='2025-12-17'; cliente='Escola Arte Criança';      valorCorreto=17500.00 }
  @{ data='2025-12-16'; cliente='StreetWise';                valorCorreto=25500.00 }
  @{ data='2025-12-13'; cliente='HB11';                     valorCorreto=9000.00 }
  @{ data='2025-12-13'; cliente='Qualita Sistemas';         valorCorreto=5920.20 }
  @{ data='2025-12-12'; cliente='Transccema';               valorCorreto=4176.90 }
  @{ data='2025-12-12'; cliente='Mackel';                   valorCorreto=1750.00 }
  @{ data='2025-12-12'; cliente='Ideale';                   valorCorreto=14022.45 }
  @{ data='2025-12-12'; cliente='Ster Engenharia';          valorCorreto=35000.00 }
  @{ data='2025-12-11'; cliente='Arla Foods';               valorCorreto=4475.00 }
  @{ data='2025-12-11'; cliente='RF Comunicação / FINAMOR'; valorCorreto=3281.85 }
  @{ data='2025-12-11'; cliente='Loreal';                   valorCorreto=6315.13 }
  @{ data='2025-12-11'; cliente='Suprema Produções';        valorCorreto=78800.00 }
  @{ data='2025-12-05'; cliente='Surf Telecom';             valorCorreto=4300.00 }
  @{ data='2025-12-05'; cliente='Erbon';                    valorCorreto=5241.60 }
  @{ data='2025-12-05'; cliente='Compec Galasso';           valorCorreto=12155.00 }
  @{ data='2025-12-05'; cliente='M3Corp';                   valorCorreto=12800.00 }
  @{ data='2025-12-05'; cliente='Koening & Bauer';          valorCorreto=11491.75 }
  @{ data='2025-12-04'; cliente='Grupo Roncador';           valorCorreto=27000.00 }
  @{ data='2025-12-04'; cliente='Nuvei';                    valorCorreto=5370.30 }
)

function Normalizar($s) {
  if (-not $s) { return '' }
  $s = $s.ToString().Trim().ToLower()
  $s = $s -replace '\s+', ' '
  return $s
}
# 05/10: tolera data vindo com hora/timezone junto (ex. "2025-12-19T00:00:00.000Z")
# em vez de so "2025-12-19" - pega só os 10 primeiros caracteres (YYYY-MM-DD).
function NormalizarData($s) {
  if (-not $s) { return '' }
  $s = $s.ToString().Trim()
  if ($s.Length -ge 10) { return $s.Substring(0, 10) }
  return $s
}

function Invoke-AppsScriptOnce($payload) {
  $tmpBody = [System.IO.Path]::GetTempFileName()
  $tmpHeaders = [System.IO.Path]::GetTempFileName()
  try {
    $body = $payload | ConvertTo-Json -Compress -Depth 10
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpBody, $body, $utf8NoBom)
    & curl.exe -sS -X POST -H "Content-Type: text/plain" --data-binary "@$tmpBody" -D $tmpHeaders "$AppsScriptUrl" | Out-Null
    $locLine = (Get-Content $tmpHeaders) | Where-Object { $_ -match '^Location:' } | Select-Object -First 1
    $location = $locLine -replace '^Location:\s*', ''
    if (-not $location) { throw "Sem redirect do Apps Script ao chamar a acao '$($payload.action)'." }
    $final = & curl.exe -sS -L "$location"
    if ($final -notmatch '^\s*[{[]') { throw "Resposta inesperada do Apps Script pra acao '$($payload.action)': [$final]" }
    return ($final | ConvertFrom-Json)
  } finally {
    if (Test-Path $tmpBody) { Remove-Item $tmpBody -Force -ErrorAction SilentlyContinue }
    if (Test-Path $tmpHeaders) { Remove-Item $tmpHeaders -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-AppsScript($payload, [int]$MaxTentativas = 3) {
  for ($tentativa = 1; $tentativa -le $MaxTentativas; $tentativa++) {
    try {
      return Invoke-AppsScriptOnce $payload
    } catch {
      if ($tentativa -eq $MaxTentativas) { throw }
      Write-Host "Falha (tentativa $tentativa/$MaxTentativas): $($_.Exception.Message) - tentando de novo em 3s." -ForegroundColor Yellow
      Start-Sleep -Seconds 3
    }
  }
}

Write-Host "=== Correcao de eventos de dezembro/2025 (SJM) ===" -ForegroundColor Cyan
if (-not $Aplicar) {
  Write-Host "MODO SIMULACAO - nada vai ser gravado. Rode com -Aplicar quando conferir que esta certo." -ForegroundColor Yellow
}
Write-Host ""

$email = Read-Host "E-mail do BI (sua conta, com acesso a Eventos)"
$senhaSegura = Read-Host "Senha do BI" -AsSecureString
$senhaPtr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaSegura)
$senha = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($senhaPtr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($senhaPtr)

Write-Host "`nLogando no BI..."
$loginRes = Invoke-AppsScript @{ action = 'login'; email = $email; password = $senha }
$senha = $null
if (-not $loginRes.ok) {
  Write-Host "Resposta crua do login: $($loginRes | ConvertTo-Json -Compress)" -ForegroundColor Red
  throw "Login falhou - confira e-mail/senha."
}
$token = $loginRes.token
Write-Host ("Login ok. role=[{0}] areas=[{1}]" -f $loginRes.role, ($loginRes.areas -join ',')) -ForegroundColor Green

Write-Host "Buscando eventos existentes..."
$eventosRes = Invoke-AppsScript @{ action = 'getEventos'; token = $token }
if (-not $eventosRes.ok) {
  Write-Host "Resposta crua do getEventos: $($eventosRes | ConvertTo-Json -Compress)" -ForegroundColor Red
  throw "Nao consegui buscar os eventos - ver resposta crua acima pra saber o motivo exato."
}
$eventos = $eventosRes.items
Write-Host "$($eventos.Count) evento(s) carregado(s)." -ForegroundColor Green

# 05/10: diagnostico - se 0/27 bater nos dois testes anteriores (um com nomes
# acentuados, outro sem), o problema real pode ser o FORMATO da data vinda da
# API (ex.: "2025-12-19T00:00:00.000Z" em vez de "2025-12-19" puro). Mostra os
# 3 primeiros eventos de dezembro/2025 crus pra comparar visualmente.
Write-Host ""
Write-Host "--- Diagnostico: 5 primeiros eventos da lista, CRUS (qualquer data) ---" -ForegroundColor DarkCyan
if ($eventos.Count -eq 0) {
  Write-Host "  A lista veio VAZIA (0 eventos) - o getEventos funcionou mas nao retornou nada." -ForegroundColor Red
} else {
  $eventos | Select-Object -First 5 | ForEach-Object {
    Write-Host ("  data=[{0}]  status=[{1}]  nomeCliente=[{2}]  valorContrato=[{3}]" -f $_.data, $_.status, $_.nomeCliente, $_.valorContrato) -ForegroundColor DarkCyan
  }
  $anos = $eventos | ForEach-Object { if ($_.data) { ([string]$_.data).Substring(0,[Math]::Min(4,([string]$_.data).Length)) } } | Group-Object | Sort-Object Name
  Write-Host "  Distribuicao por ano (4 primeiros chars do campo data):" -ForegroundColor DarkCyan
  $anos | ForEach-Object { Write-Host ("    {0}: {1} evento(s)" -f $_.Name, $_.Count) -ForegroundColor DarkCyan }
}
Write-Host ""
Write-Host "--- Diagnostico: amostra de eventos de dezembro/2025 na planilha ---" -ForegroundColor DarkCyan
$amostra = $eventos | Where-Object { $_.data -like '2025-12*' } | Select-Object -First 3
if ($amostra) {
  $amostra | ForEach-Object { Write-Host ("  data=[{0}]  nomeCliente=[{1}]  valorContrato=[{2}]" -f $_.data, $_.nomeCliente, $_.valorContrato) -ForegroundColor DarkCyan }
} else {
  Write-Host "  NENHUM evento com data comecando em '2025-12' foi encontrado na lista carregada." -ForegroundColor Red
  Write-Host "  (veja a distribuicao por ano acima pra entender onde os dados realmente estao)" -ForegroundColor Red
}
Write-Host ""

$achados = 0
$naoAchados = @()
$jaCertos = 0
$aplicados = 0
$falharam = 0

foreach ($c in $Correcoes) {
  $alvoNome = Normalizar $c.cliente
  $match = $eventos | Where-Object { (NormalizarData $_.data) -eq $c.data -and (Normalizar $_.nomeCliente) -eq $alvoNome }
  if (-not $match -or $match.Count -eq 0) {
    # Fallback: so pela data, pra mostrar o que TEM nessa data (ajuda a ver se o
    # nome bateu diferente por causa de acentuacao/espaco/etc.).
    $candidatosData = $eventos | Where-Object { (NormalizarData $_.data) -eq $c.data }
    if ($candidatosData) {
      $nomesNaData = ($candidatosData | ForEach-Object { $_.nomeCliente }) -join ' | '
      $naoAchados += "$($c.data) - $($c.cliente)  (nessa data a planilha tem: $nomesNaData)"
    } else {
      $naoAchados += "$($c.data) - $($c.cliente)  (NENHUM evento nessa data na planilha)"
    }
    continue
  }
  if ($match -is [array]) {
    Write-Host "AMBIGUO (mais de 1 evento igual): $($c.data) - $($c.cliente) - pulando, corrija manualmente." -ForegroundColor Yellow
    continue
  }
  $achados++
  $valorAtual = [double]($match.valorContrato)
  if ([math]::Abs($valorAtual - $c.valorCorreto) -lt 0.01) {
    Write-Host ("JA CERTO   {0}  {1,-28} R$ {2:N2}" -f $c.data, $c.cliente, $c.valorCorreto) -ForegroundColor DarkGray
    $jaCertos++
    continue
  }
  Write-Host ("CORRIGIR   {0}  {1,-28} R$ {2:N2}  ->  R$ {3:N2}" -f $c.data, $c.cliente, $valorAtual, $c.valorCorreto) -ForegroundColor Cyan

  if ($Aplicar) {
    $payload = @{
      action        = 'saveEvento'
      token         = $token
      id            = $match.id
      data          = $match.data
      nomeCliente   = $match.nomeCliente
      documento     = $match.documento
      telefone      = $match.telefone
      email         = $match.email
      tipoEvento    = $match.tipoEvento
      pax           = $match.pax
      valorContrato = $c.valorCorreto
      valorSinal    = $match.valorSinal
      dataSinal     = $match.dataSinal
      status        = $match.status
      observacao    = $match.observacao
    }
    try {
      $r = Invoke-AppsScript $payload
      if ($r.ok) { Write-Host "  -> salvo." -ForegroundColor Green; $aplicados++ }
      else { Write-Host "  -> FALHOU: $($r.error)" -ForegroundColor Red; $falharam++ }
    } catch {
      Write-Host "  -> FALHOU: $($_.Exception.Message)" -ForegroundColor Red
      $falharam++
    }
  }
}

Write-Host ""
Write-Host "=== Resumo ===" -ForegroundColor Cyan
Write-Host "Encontrados na planilha: $achados / $($Correcoes.Count)"
Write-Host "Ja estavam certos: $jaCertos"
if ($Aplicar) {
  Write-Host "Corrigidos agora: $aplicados" -ForegroundColor Green
  if ($falharam -gt 0) { Write-Host "Falharam: $falharam" -ForegroundColor Red }
} else {
  Write-Host "(simulacao - rode com -Aplicar pra gravar de verdade)" -ForegroundColor Yellow
}
if ($naoAchados.Count -gt 0) {
  Write-Host "NAO encontrados (confira data/nome na planilha, pode ter digitado diferente):" -ForegroundColor Yellow
  $naoAchados | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}
