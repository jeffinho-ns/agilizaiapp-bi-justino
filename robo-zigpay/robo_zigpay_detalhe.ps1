<#
  Robo ZigPay - DETALHE POR HORARIO (alimento, bebida, entrada de clientes).

  Alimenta a "escala sugerida por setor" do BI: pra cada bloco de 30 min de
  cada evento, grava
    - foodValue/foodCount   : itens "Alimentos" vendidos no bloco (centavos / qtd)
    - bevValue/bevCount     : itens "Bebidas"
    - otherValue/otherCount : itens "Outros"
    - entries               : pessoas que entraram na casa (ingressos/couvert vendidos, qtd)
  Fonte (API sdkgen, sem navegador, igual ao robo principal):
    getProductsSoldAtEventInPeriodV2 {eventId, since, until}  -> kind.masterKind = Alimentos|Bebidas|Outros
    getEntrancesSoldAtEventInPeriod  {eventId, since, until}  -> count por tipo de entrada
  ATENCAO: todo horario da ZigPay vem em UTC (BRT = UTC-3). Aqui grava-se o
  `start` exatamente como a ZigPay devolve (mesma convencao da aba ZigHourly);
  quem le (BI) converte pra horario de Brasilia.

  USO:
    powershell -File robo_zigpay_detalhe.ps1                        # so o dia de ontem
    powershell -File robo_zigpay_detalhe.ps1 -From 2026-07-01 -To 2026-09-27 -OnlyMissing
    powershell -File robo_zigpay_detalhe.ps1 -From 2026-09-19 -To 2026-09-19 -DryRun   # so mostra, nao envia
#>
param(
  [string]$From,
  [string]$To,
  [switch]$DryRun,
  [switch]$OnlyMissing
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$CredPath = "$env:USERPROFILE\.seujustino\zigpay_credentials.json"
$LogPath = "$ScriptDir\robo_zigpay_detalhe.log"
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'
$ZigApiBase = 'https://api.zigcore.com.br/enterprise-postgres'
$PlaceId = 'baa37552-df9e-42a7-9010-d108ee1a3710'

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  for ($t = 1; $t -le 5; $t++) {
    try { Add-Content -Path $LogPath -Value $line -Encoding utf8 -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 200 }
  }
}

function New-RandomHex([int]$len) { -join ((1..$len) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] }) }

function Invoke-ZigSdkgen($name, $sdkArgs, $deviceId, [int]$MaxTentativas = 3) {
  $body = @{
    args = $sdkArgs
    deviceInfo = @{ id = $deviceId; language = "pt-BR"; platform = @{ browserUserAgent = "robo-zigpay-detalhe" }; timezone = "America/Sao_Paulo"; type = "web"; version = "" }
    extra = @{ tz = "America/Sao_Paulo"; lng = "pt-BR" }
    name = $name
    requestId = New-RandomHex 32
    version = 3
  } | ConvertTo-Json -Depth 8
  for ($t = 1; $t -le $MaxTentativas; $t++) {
    try {
      $resp = Invoke-WebRequest -Uri "$ZigApiBase/$name" -Method POST -Body $body -ContentType "application/sdkgen; charset=utf-8" -UseBasicParsing -TimeoutSec 60
      $parsed = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray()) | ConvertFrom-Json
      if ($parsed.error) { throw "ZigPay recusou '$name': $($parsed.error.message)" }
      return $parsed.result
    } catch {
      if ($t -eq $MaxTentativas) { throw }
      Start-Sleep -Seconds 3
    }
  }
}

# Duas etapas, igual ao robo_zigpay.ps1 (Invoke-AppsScriptOnce): POST sem seguir redirect,
# pega o Location do 302 e faz um GET nele. Descoberto de novo aqui: curl -L direto no POST
# devolve "411 Length Required" do Google (o redirect vira GET e o Content-Length do POST
# original não bate mais) - por isso o robo principal já fazia em duas chamadas.
function Invoke-AppsScriptOnce_($payload) {
  $tmpBody = [System.IO.Path]::GetTempFileName()
  $tmpHeaders = [System.IO.Path]::GetTempFileName()
  try {
    $body = $payload | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($tmpBody, $body, (New-Object System.Text.UTF8Encoding $false))
    & curl.exe -sS -X POST -H "Content-Type: text/plain" --data-binary "@$tmpBody" -D $tmpHeaders --max-time 90 "$AppsScriptUrl" | Out-Null
    $locLine = (Get-Content $tmpHeaders) | Where-Object { $_ -match '^Location:' } | Select-Object -First 1
    $location = $locLine -replace '^Location:\s*', ''
    if (-not $location) { throw "Sem redirect do Apps Script ao chamar a acao '$($payload.action)'." }
    $final = & curl.exe -sS -L --max-time 90 "$location"
    if ($final -notmatch '^\s*[{[]') { throw "Resposta inesperada do Apps Script pra acao '$($payload.action)': [$final]" }
    return ($final | ConvertFrom-Json)
  } finally {
    Remove-Item $tmpBody, $tmpHeaders -Force -ErrorAction SilentlyContinue
  }
}
function Invoke-AppsScript($payload, [int]$MaxTentativas = 4) {
  for ($t = 1; $t -le $MaxTentativas; $t++) {
    try {
      $res = Invoke-AppsScriptOnce_ $payload
      if ($res.error -eq 'unknown_action') { throw "Apps Script sem a acao '$($payload.action)' - cole o Code.gs novo e implante nova versao." }
      if ($res.ok -eq $true -and $res.time -and -not $res.docs -and -not $res.items -and -not $res.token -and $payload.action -like 'get*') { throw "resposta generica do Apps Script" }
      return $res
    } catch {
      if ($t -eq $MaxTentativas -or $_.Exception.Message -like '*sem a acao*') { throw }
      Start-Sleep -Seconds 3
    }
  }
}

function Get-BlocoIso([datetime]$dt) { return $dt.ToString("yyyy-MM-ddTHH:mm:ss.000") }

# Detalhe por bloco de 30 min de UM evento. Janela: do bloco de abertura ate o
# ultimo bloco com consumo (timeline) - fora disso nao ha o que escalar.
function Get-DetalheEvento($deviceId, $ev) {
  $timeline = Invoke-ZigSdkgen "getConsumptionTimeline" @{ eventId = $ev.id } $deviceId
  $comValor = @($timeline | Where-Object { $_.value -gt 0 })
  if (-not $comValor.Count) { return @() }
  $ini = [datetime]::Parse($ev.begin)
  $ini = $ini.Date.AddMinutes([math]::Floor($ini.TimeOfDay.TotalMinutes / 30) * 30)
  $primeiroConsumo = ($comValor | ForEach-Object { [datetime]::Parse($_.start) } | Sort-Object | Select-Object -First 1)
  $ultimoConsumo = ($comValor | ForEach-Object { [datetime]::Parse($_.start) } | Sort-Object | Select-Object -Last 1)
  # o "begin" do evento pode ser a abertura tecnica (horas antes do 1o consumo) - usa o que vier depois
  if ($primeiroConsumo -gt $ini) { $ini = $primeiroConsumo.AddMinutes(-60) }
  $fim = $ultimoConsumo.AddMinutes(30)
  $out = @()
  for ($s = $ini; $s -lt $fim; $s = $s.AddMinutes(30)) {
    $since = Get-BlocoIso $s
    $until = Get-BlocoIso $s.AddMinutes(30)
    $prods = @(Invoke-ZigSdkgen "getProductsSoldAtEventInPeriodV2" @{ eventId = $ev.id; since = $since; until = $until } $deviceId)
    $ents = @(Invoke-ZigSdkgen "getEntrancesSoldAtEventInPeriod" @{ eventId = $ev.id; since = $since; until = $until } $deviceId)
    $b = @{ start = $since; foodValue = 0; foodCount = 0; bevValue = 0; bevCount = 0; otherValue = 0; otherCount = 0; entries = 0 }
    foreach ($p in $prods) {
      $mk = "$($p.kind.masterKind)"
      $v = [double]($p.totalValue - $p.totalDiscount)
      if ($mk -eq 'Alimentos') { $b.foodValue += $v; $b.foodCount += $p.count }
      elseif ($mk -eq 'Bebidas') { $b.bevValue += $v; $b.bevCount += $p.count }
      else { $b.otherValue += $v; $b.otherCount += $p.count }
    }
    foreach ($e in $ents) { $b.entries += $e.count }
    if (($b.foodCount + $b.bevCount + $b.otherCount + $b.entries) -gt 0) { $out += $b }
  }
  return $out
}

try {
  if (-not $From) { $From = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd') }
  if (-not $To) { $To = $From }
  $d0 = [datetime]::ParseExact($From, 'yyyy-MM-dd', $null)
  $d1 = [datetime]::ParseExact($To, 'yyyy-MM-dd', $null)
  if ($d0 -gt $d1) { throw "-From precisa ser <= -To." }
  Log ("Detalhe por horario de {0} ate {1}{2}{3}" -f $From, $To, $(if ($DryRun) { ' (dry-run)' }), $(if ($OnlyMissing) { ' (so faltantes)' }))

  $cred = Get-Content $CredPath -Raw | ConvertFrom-Json
  $deviceId = New-RandomHex 40
  $null = Invoke-ZigSdkgen "logIn" @{ username = $cred.zigpay.username; password = $cred.zigpay.password; organizationUsername = $cred.zigpay.organization } $deviceId
  Log "Login ZigPay (API) ok."

  $token = $null; $jaTem = @{}
  if (-not $DryRun) {
    $login = Invoke-AppsScript @{ action = 'login'; email = $cred.bi.email; password = $cred.bi.password }
    if (-not $login.ok) { throw "Login no BI falhou." }
    $token = $login.token
    if ($OnlyMissing) {
      $r = Invoke-AppsScript @{ action = 'getZigHourlyDetail'; token = $token; days = 400 }
      if ($r.ok) { foreach ($it in $r.items) { $jaTem[$it.date] = $true } }
      Log ("{0} dia(s) ja com detalhe no BI - pulados." -f $jaTem.Count)
    }
  }

  $eventosPorMes = @{}
  $ok = 0; $falhou = 0; $vazio = 0
  for ($dia = $d0; $dia -le $d1; $dia = $dia.AddDays(1)) {
    $iso = $dia.ToString('yyyy-MM-dd')
    if ($jaTem.ContainsKey($iso)) { continue }
    $mes = $dia.ToString('yyyy-MM')
    if (-not $eventosPorMes.ContainsKey($mes)) {
      $eventosPorMes[$mes] = Invoke-ZigSdkgen "getEvents" @{ placeId = $PlaceId; month = $dia.Month - 1; year = $dia.Year } $deviceId
    }
    $evs = @($eventosPorMes[$mes].events | Where-Object { $_.begin.Substring(0, 10) -eq $iso })
    if (-not $evs.Count) { $vazio++; continue }
    try {
      $porBloco = @{}
      foreach ($ev in $evs) {
        foreach ($b in (Get-DetalheEvento -deviceId $deviceId -ev $ev)) {
          if (-not $porBloco.ContainsKey($b.start)) { $porBloco[$b.start] = $b }
          else { foreach ($k in 'foodValue','foodCount','bevValue','bevCount','otherValue','otherCount','entries') { $porBloco[$b.start][$k] += $b[$k] } }
        }
      }
      $buckets = @($porBloco.GetEnumerator() | Sort-Object Name | ForEach-Object { $_.Value })
      $tot = @{ f = 0; b = 0; e = 0 }
      foreach ($b in $buckets) { $tot.f += $b.foodCount; $tot.b += $b.bevCount; $tot.e += $b.entries }
      $publico = ($evs | Measure-Object totalPublic -Sum).Sum
      Log ("{0}: {1} bloco(s); itens comida={2} bebida={3}; entradas={4} (publico ZigPay={5})" -f $iso, $buckets.Count, $tot.f, $tot.b, $tot.e, $publico)
      if (-not $DryRun -and $buckets.Count) {
        $res = Invoke-AppsScript @{ action = 'submitZigHourlyDetail'; token = $token; date = $iso; buckets = $buckets; source = 'robo-zigpay-detalhe' }
        if (-not $res.ok) { throw "BI recusou o detalhe de ${iso}: $($res.error)" }
      }
      $ok++
    } catch {
      $falhou++
      Log ("ERRO em {0}: {1} - seguindo pro proximo dia." -f $iso, $_.Exception.Message)
    }
  }
  Log ("Concluido: {0} dia(s) ok, {1} sem evento, {2} falharam." -f $ok, $vazio, $falhou)
  if ($falhou -gt 0) { exit 1 }
} catch {
  Log ("ERRO: " + $_.Exception.Message)
  exit 1
}
