<#
  Robo 99Food -> BI (leitura do painel do lojista, SOMENTE LEITURA)
  Roda 1x ao dia, as 11:00, pelo Agendador de Tarefas do Windows (ver agendar_robo_99food.ps1).

  O que faz:
    1. Abre o painel do lojista (https://merchant.99app.com) em Chrome SEM janela, com o perfil proprio do robo
       (~\.seujustino\chrome-profile-99food), onde o Renato entrou UMA vez a mao (login_manual_99food.ps1).
    2. Le a Visao geral e a pagina Desempenho (ranking, itens, pedido online/horario) da loja SEU JUSTINO MADALENA.
    3. Manda pro BI so numeros da loja (sem dado de cliente) -> acao submit99Food (aba Marketing > Delivery).
    4. Se a sessao vencer, cria o arquivo "99FOOD - ROBO PRECISA DE LOGIN.txt" na Area de Trabalho.
  Nao clica em nada que altere cardapio, preco, oferta ou horario.
  USO:  powershell -File robo_99food.ps1            (normal)
        powershell -File robo_99food.ps1 -DryRun    (le tudo, mostra os numeros e NAO envia pro BI)
#>
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$CredPath = "$env:USERPROFILE\.seujustino\zigpay_credentials.json"   # so o campo "bi" (login do robo no BI)
$LogPath = "$ScriptDir\robo_99food.log"
$DriverCacheDir = "$ScriptDir\chromedriver-cache"
$ProfileDir = "$env:USERPROFILE\.seujustino\chrome-profile-99food"
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'
$Base = 'https://merchant.99app.com/pt-BR/manager'
$AvisoLoginPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '99FOOD - ROBO PRECISA DE LOGIN.txt'

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  for ($t = 1; $t -le 5; $t++) {
    try { Add-Content -Path $LogPath -Value $line -Encoding utf8 -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 200 }
  }
}

function Get-Credentials {
  if (-not (Test-Path $CredPath)) { throw "Arquivo de credenciais nao encontrado: $CredPath" }
  $cred = Get-Content $CredPath -Raw | ConvertFrom-Json
  if (-not $cred.bi.email -or -not $cred.bi.password) { throw "Campo 'bi' (email/senha do robo no BI) ausente em $CredPath" }
  return $cred
}

function Set-AvisoLogin([bool]$precisa) {
  try {
    if ($precisa) {
      $msg = "O robo da 99Food nao conseguiu entrar em " + (Get-Date -Format 'dd/MM/yyyy HH:mm') + ".`r`nA sessao do painel venceu. O quadro 99Food (Marketing > Delivery) fica sem atualizar ate resolver.`r`n`r`nComo resolver: rode login_manual_99food.ps1 (pasta robo-zigpay), entre na 99Food, espere a Visao geral abrir e FECHE a janela."
      Set-Content -Path $AvisoLoginPath -Value $msg -Encoding UTF8
    } elseif (Test-Path $AvisoLoginPath) { Remove-Item $AvisoLoginPath -Force }
  } catch {}
}

# --- funcoes copiadas do robo_dionisio.ps1 (Get-MatchingChromeDriver / Invoke-AppsScript / Get-BiToken) ---
function Get-MatchingChromeDriver {
  $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
  if (-not (Test-Path $chromePath)) { $chromePath = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
  $chromeVer = (Get-Item $chromePath).VersionInfo.ProductVersion
  $cached = Join-Path $DriverCacheDir "$chromeVer\chromedriver-win64\chromedriver.exe"
  if (Test-Path $cached) {
    Log "Chromedriver ja em cache para Chrome $chromeVer"
    return (Split-Path $cached -Parent)
  }
  Log "Baixando chromedriver para Chrome $chromeVer..."
  $json = Invoke-RestMethod -Uri "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json"
  $match = $json.versions | Where-Object { $_.version -eq $chromeVer } | Select-Object -Last 1
  if (-not $match) {
    $major = $chromeVer.Split('.')[0]
    $match = $json.versions | Where-Object { $_.version -like "$major.*" } | Select-Object -Last 1
  }
  if (-not $match) { throw "Nao achei chromedriver compativel com Chrome $chromeVer" }
  $url = ($match.downloads.chromedriver | Where-Object { $_.platform -eq 'win64' }).url
  $destDir = Join-Path $DriverCacheDir $chromeVer
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $zip = Join-Path $destDir 'chromedriver.zip'
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $destDir -Force
  Remove-Item $zip
  return (Join-Path $destDir 'chromedriver-win64')
}

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
      Log ("Falha ao chamar '$($payload.action)' (tentativa $tentativa/$MaxTentativas): $($_.Exception.Message) - tentando de novo em 3s.")
      Start-Sleep -Seconds 3
    }
  }
}

function Get-BiToken($cred) {
  $res = Invoke-AppsScript @{ action = 'login'; email = $cred.bi.email; password = $cred.bi.password }
  if (-not $res.ok) { throw "Login no BI falhou - confira se a conta robo-zigpay foi criada (addAccount_) e se a senha em $CredPath bate." }
  return $res.token
}

# ---------------- leitura da planilha .xlsx (sem Excel instalado) ----------------
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------------- leitura do painel ----------------
function Get-Num([string]$s) {   # "1.234,56" / "35,26" / "50,00" -> double
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $t = ($s -replace '[^\d,\.\-]', '')
  if ($t -match ',') { $t = ($t -replace '\.', '') -replace ',', '.' }
  $v = 0.0
  if ([double]::TryParse($t, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$v)) { return $v }
  return $null
}
function Find-Val([string]$texto, [string]$padrao) { $m = [regex]::Match($texto, $padrao); if ($m.Success) { return $m.Groups[1].Value } else { return $null } }
function Get-PageText($drv) { return [string]$drv.ExecuteScript("return document.body.innerText||''") }
function Open-Page($drv, [string]$path, [int]$espera = 10) {
  Enter-SeUrl -Driver $drv -Url "$Base/$path" | Out-Null
  Start-Sleep -Seconds $espera
}
function Click-Tab($drv, [string]$nome) {   # texto igual ao nome; se houver varios, clica o 2o (o 1o costuma ser o menu)
  return [string]$drv.ExecuteScript("var n=arguments[0];var els=[...document.querySelectorAll('a,li,div,span,button')].filter(function(e){return (e.innerText||'').trim()===n&&e.children.length<3});if(els.length){els[els.length>1?1:0].click();return 'ok'}return 'nao'", $nome)
}
function Test-Logado([string]$texto) { return ($texto -match 'SEU JUSTINO MADALENA' -and $texto -match 'Superadministrador|Vis.o geral') }

function Read-Itens([string]$t) {
  $r = @{ vendidos = @(); conversao = @() }
  $i1 = $t.IndexOf('Itens mais vendidos'); $i2 = $t.IndexOf('Itens com maior convers')
  $m3 = [regex]::Match($t, 'An.lise de item')
  $i3 = if ($m3.Success) { $m3.Index } else { -1 }
  if ($i1 -ge 0 -and $i2 -gt $i1) {
    $seg = $t.Substring($i1, $i2 - $i1)
    $nums = [regex]::Matches($seg, '(?m)^\s*(\d+)\s*\r?\n\s*R\$\s*([\d\.,]+)\s*\r?\n\s*R\$\s*([\d\.,]+)')
    $ini = $seg.LastIndexOf("`nItens"); $nomes = @()
    if ($ini -ge 0) { $nomes = @($seg.Substring($ini + 6) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }) }
    for ($k = 0; $k -lt $nums.Count -and $k -lt $nomes.Count; $k++) {
      $r.vendidos += [ordered]@{ nome = $nomes[$k]; volume = [int]$nums[$k].Groups[1].Value; receita = (Get-Num $nums[$k].Groups[2].Value); precoMedio = (Get-Num $nums[$k].Groups[3].Value) }
    }
  }
  if ($i2 -ge 0) {
    $fim = if ($i3 -gt $i2) { $i3 } else { $t.Length }
    $seg = $t.Substring($i2, $fim - $i2)
    $nums = [regex]::Matches($seg, '(?m)^\s*([\d\.,]+)%\s*\r?\n\s*(\d+)\s*\r?\n\s*(\d+)\s*$')
    $ini = $seg.LastIndexOf("`nItens"); $nomes = @()
    if ($ini -ge 0) { $nomes = @($seg.Substring($ini + 6) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }) }
    for ($k = 0; $k -lt $nums.Count -and $k -lt $nomes.Count; $k++) {
      $r.conversao += [ordered]@{ nome = $nomes[$k]; taxaCarrinhoPct = (Get-Num $nums[$k].Groups[1].Value); impressoes = [int]$nums[$k].Groups[2].Value; carrinho = [int]$nums[$k].Groups[3].Value }
    }
  }
  return $r
}

function To-Int($s) { if ($null -eq $s -or $s -eq '') { return $null } else { return [int]$s } }

function Read-Painel($drv) {
  $snap = [ordered]@{ lidoEm = (Get-Date).ToString('yyyy-MM-dd HH:mm'); loja = 'Seu Justino Madalena' }
  Open-Page $drv 'overview' 11
  $ov = Get-PageText $drv
  if (-not (Test-Logado $ov)) { return $null }
  $snap.naoPreparadosNoPrazoPct = Get-Num (Find-Val $ov 'Taxa de pedidos n.o preparados no prazo\s*([\d\.,]+)\s*%')
  $snap.tempoPreparoMin = Get-Num (Find-Val $ov 'Tempo m.dio de prepara..o de pedidos\s*([\d\.,]+)\s*min')
  $snap.cancelamentosLojaPct = Get-Num (Find-Val $ov 'Taxa de cancelamentos por parte da loja\s*([\d\.,]+)\s*%')
  $snap.itensIncorretosPct = Get-Num (Find-Val $ov 'Taxa de pedidos com itens incorretos/faltando\s*([\d\.,]+)\s*%')
  $snap.clientesTotal = To-Int (Find-Val $ov 'Total de clientes:\s*(\d+)')
  $snap.semAvaliacoes = ($ov -match 'Nenhuma avalia')
  Open-Page $drv 'insights/v2' 11
  $de = Get-PageText $drv
  # o ranking carrega depois do resto (aparece como "#0 / 0" nos primeiros segundos): espera ate ~45 s
  for ($w = 0; $w -lt 9 -and $de -notmatch '#[1-9]d*s*/s*[1-9]d*s*Ranking de ganhos'; $w++) { Start-Sleep -Seconds 5; $de = Get-PageText $drv }
  $snap.rankGanhos = To-Int (Find-Val $de '#(\d+)\s*/\s*\d+\s*Ranking de ganhos')
  $snap.lojasNoRaio = To-Int (Find-Val $de '#\d+\s*/\s*(\d+)\s*Ranking de ganhos')
  $snap.rendaVendas = Get-Num (Find-Val $de 'Ranking de ganhos\s*R\$\s*([\d\.,]+)')
  $snap.pedidosConcluidos = To-Int (Find-Val $de 'Total de vendas realizadas\s*(\d+)')
  $snap.rankTicketMedio = To-Int (Find-Val $de 'Ranking do valor m.dio dos pedidos\s*#(\d+)')
  $snap.ticketMedio = Get-Num (Find-Val $de 'Valor m.dio dos pedidos\s*R\$\s*([\d\.,]+)')
  [void](Click-Tab $drv 'Itens'); Start-Sleep -Seconds 7
  $snap.itens = Read-Itens (Get-PageText $drv)
  [void](Click-Tab $drv 'Pedido online'); Start-Sleep -Seconds 7
  $po = Get-PageText $drv
  $snap.horasConectadoDia = Get-Num (Find-Val $po 'Hor.rio de funcionamento di.rio\s*([\d\.,]+)\s*h')
  $snap.tempoConectadoPicoPct = Get-Num (Find-Val $po 'Taxa de tempo conectado nos hor.rios de pico\s*([\d\.,]+)\s*%')
  $snap.statusConectadoMedioPct = Get-Num (Find-Val $po 'Taxa m.dia de status conectado\s*([\d\.,]+)\s*%')
  $mp = [regex]::Match($po, 'alta demanda para esta loja:\s*(\d\d:\d\d)(?::\d\d)?\s*~\s*(\d\d:\d\d)')
  if ($mp.Success) { $snap.picoInicio = $mp.Groups[1].Value; $snap.picoFim = $mp.Groups[2].Value }
  return $snap
}

# ---------------- principal ----------------
Log "Iniciando robo 99Food$(if ($DryRun) { ' (DryRun)' })"
$cred = Get-Credentials
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Import-Module Selenium
$pidsAntes = @((Get-Process chrome, chromedriver -ErrorAction SilentlyContinue).Id)
$driverDir = Get-MatchingChromeDriver
$drv = Start-SeChrome -Headless -Quiet -BinaryPath "C:\Program Files\Google\Chrome\Application\chrome.exe" -WebDriverDirectory $driverDir -Arguments @('--window-size=1500,2400', "--user-data-dir=$ProfileDir")
$snap = $null
try { $snap = Read-Painel $drv } catch { Log ("ERRO leitura: " + $_.Exception.Message) }
finally {
  try { Stop-SeDriver -Driver $drv } catch {}
  Get-Process chrome, chromedriver -ErrorAction SilentlyContinue | Where-Object { $pidsAntes -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
}
if (-not $snap) { Set-AvisoLogin $true; Log "AVISO: nao entrou no painel (sessao vencida ou leitura falhou). Rode login_manual_99food.ps1."; exit 2 }
Set-AvisoLogin $false
Log ("Lido: pedidos {0} | ticket R$ {1} | horas conectado/dia {2} | pico conectado {3}% | itens vendidos {4} | itens com impressao {5}" -f $snap.pedidosConcluidos, $snap.ticketMedio, $snap.horasConectadoDia, $snap.tempoConectadoPicoPct, $snap.itens.vendidos.Count, $snap.itens.conversao.Count)
if ($DryRun) { Log ("JSON: " + ($snap | ConvertTo-Json -Depth 6 -Compress)); exit 0 }
$token = Get-BiToken $cred
$res = Invoke-AppsScript @{ action = 'submit99Food'; token = $token; snapshot = $snap }
if (-not $res.ok) { Log ("AVISO: BI recusou a leitura da 99Food: $($res.error) $($res.code)"); exit 3 }
Log "Leitura da 99Food enviada pro BI."
Log "Concluido."
