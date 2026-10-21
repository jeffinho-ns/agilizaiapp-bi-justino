<#
  Corrige o campo "Valor do contrato" de eventos SJM que entraram errados por
  causa do bug de type="number" comendo a virgula digitada (ver
  00-sistema/memory.md, 04-05/10/2026, "causa raiz de verdade do bug de
  faturamento de Eventos"). Versao ampliada do corrigir_eventos_dezembro.ps1 -
  cobre TODOS os meses/anos que tem na planilha de referencia
  (referencia_eventos_sjm.csv, nesta mesma pasta), nao so dezembro/2025.

  NAO usa nenhuma credencial salva (nem a de zigpay_credentials.json, que e
  de outro sistema) - pede seu e-mail e senha do proprio BI na hora, direto
  no console. Nada fica gravado em disco nem e visto pelo Claude.

  Reenvia o evento INTEIRO pra cada correcao (nao so o valor), porque
  saveEvento_ no Code.gs substitui a linha inteira pros campos principais
  (so os campos de follow-up sao preservados quando omitidos) - por isso o
  script busca o evento existente primeiro e muda só valorContrato,
  mantendo todo o resto (cliente, status, tipo, pax, etc.) exatamente igual.

  USO:
    powershell -File corrigir_eventos_sjm.ps1              # so mostra o que mudaria (seguro, nao grava nada)
    powershell -File corrigir_eventos_sjm.ps1 -Aplicar      # aplica de verdade
#>
param(
  [switch]$Aplicar
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'
$ScriptDir = $PSScriptRoot
$CsvPath = Join-Path $ScriptDir 'referencia_eventos_sjm.csv'

if (-not (Test-Path $CsvPath)) { throw "Nao achei o arquivo de referencia: $CsvPath" }
$linhasCsv = Import-Csv -Path $CsvPath
$Correcoes = $linhasCsv | ForEach-Object {
  [PSCustomObject]@{
    data = $_.data
    cliente = $_.cliente
    valorCorreto = [double]::Parse($_.valorCorreto, [System.Globalization.CultureInfo]::InvariantCulture)
  }
}
Write-Host "Referencia carregada: $($Correcoes.Count) evento(s) de $($CsvPath | Split-Path -Leaf)" -ForegroundColor Cyan

function Normalizar($s) {
  if (-not $s) { return '' }
  $s = $s.ToString().Trim().ToLower()
  $s = $s -replace '\s+', ' '
  return $s
}
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

Write-Host "=== Correcao de eventos SJM (todos os meses/anos da referencia) ===" -ForegroundColor Cyan
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
