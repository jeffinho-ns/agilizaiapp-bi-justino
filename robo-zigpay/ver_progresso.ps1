<#
  Mostra o progresso real do backfill de faturamento (ZigRevenue) - quantos dias ja
  estao gravados na planilha e quais ainda faltam, pro ano corrente e pro mesmo mes
  do ano anterior. So leitura, nao mexe em nada. Roda a qualquer momento, mesmo com
  o robo trabalhando ao mesmo tempo.

  USO:
    powershell -File ver_progresso.ps1
#>
$ErrorActionPreference = 'Stop'
$CredPath = "$env:USERPROFILE\.seujustino\zigpay_credentials.json"
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'

function Invoke-AppsScriptOnce($payload) {
  $tmpBody = [System.IO.Path]::GetTempFileName()
  $tmpHeaders = [System.IO.Path]::GetTempFileName()
  try {
    $body = $payload | ConvertTo-Json -Compress
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpBody, $body, $utf8NoBom)
    & curl.exe -sS -X POST -H "Content-Type: text/plain" --data-binary "@$tmpBody" -D $tmpHeaders "$AppsScriptUrl" | Out-Null
    $locLine = (Get-Content $tmpHeaders) | Where-Object { $_ -match '^Location:' } | Select-Object -First 1
    $location = $locLine -replace '^Location:\s*', ''
    if (-not $location) { return $null }
    $final = & curl.exe -sS -L "$location"
    return ($final | ConvertFrom-Json)
  } finally {
    Remove-Item $tmpBody, $tmpHeaders -Force -ErrorAction SilentlyContinue
  }
}

function Get-ComRetry([scriptblock]$Chamada, [string]$Descricao) {
  for ($i = 1; $i -le 4; $i++) {
    $r = & $Chamada
    if ($r -and $r.ok) { return $r }
    Start-Sleep -Seconds 2
  }
  throw "Nao consegui completar '$Descricao' apos 4 tentativas."
}

function Show-Cobertura([string]$Titulo, [string]$Inicio, [string]$Fim, $diasGravados) {
  $inicioData = [datetime]$Inicio
  $fimData = [datetime]$Fim
  $todasDatas = @()
  $d = $inicioData
  while ($d -le $fimData) { $todasDatas += $d.ToString('yyyy-MM-dd'); $d = $d.AddDays(1) }
  $faltando = $todasDatas | Where-Object { $diasGravados -notcontains $_ }
  $pct = if ($todasDatas.Count -gt 0) { [math]::Round(($todasDatas.Count - $faltando.Count) / $todasDatas.Count * 100, 1) } else { 0 }
  Write-Host ""
  Write-Host "=== $Titulo ($Inicio a $Fim) ===" -ForegroundColor Cyan
  Write-Host "Gravados: $($todasDatas.Count - $faltando.Count) de $($todasDatas.Count) dias ($pct%)"
  Write-Host "Faltando: $($faltando.Count) dias"
  if ($faltando.Count -gt 0 -and $faltando.Count -le 40) {
    Write-Host "Datas faltando: $($faltando -join ', ')"
  } elseif ($faltando.Count -gt 40) {
    Write-Host "Primeiras datas faltando: $(($faltando | Select-Object -First 15) -join ', ') ... (+$($faltando.Count - 15) outras)"
  }
}

$cred = Get-Content $CredPath -Raw | ConvertFrom-Json
$loginRes = Get-ComRetry { Invoke-AppsScriptOnce @{ action = 'login'; email = $cred.bi.email; password = $cred.bi.password } } 'login'
$token = $loginRes.token

$dadosRes = Get-ComRetry { Invoke-AppsScriptOnce @{ action = 'getZigRevenue'; token = $token; limit = 2000 } } 'getZigRevenue'
$diasGravados = $dadosRes.docs | Select-Object -ExpandProperty date -Unique

Show-Cobertura -Titulo 'Ano corrente' -Inicio '2026-01-01' -Fim '2026-09-22' -diasGravados $diasGravados
Show-Cobertura -Titulo 'Mesmo mes, ano anterior' -Inicio '2025-09-01' -Fim '2025-09-30' -diasGravados $diasGravados
Write-Host ""

