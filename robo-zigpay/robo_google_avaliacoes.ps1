<#
  Robo Avaliacoes do Google -> BI (leitura do Perfil da Empresa, SOMENTE LEITURA)
  Roda 1x ao dia pelo Agendador de Tarefas do Windows (ver agendar_robo_google_avaliacoes.ps1).

  O que faz:
    1. Abre a pagina de avaliacoes do Perfil da Empresa (https://business.google.com/reviews, ou o link guardado em
       ~\.seujustino\google_avaliacoes_url.txt) em Chrome SEM janela, com o perfil proprio do robo
       (~\.seujustino\chrome-profile-google), onde o Renato entrou UMA vez a mao (login_manual_google.ps1).
    2. Le nota, "quando", texto e se ja tem resposta do dono. NAO le nem envia o nome do cliente: a chave de cada avaliacao e um
       hash (SHA-1) calculado aqui e o nome nunca sai do computador.
    3. Manda ao BI -> acao submitGoogleAvaliacoes (aba Marketing > Avaliacoes Google). A IA sugere a resposta la.
    4. Se a sessao vencer, cria o arquivo "GOOGLE AVALIACOES - ROBO PRECISA DE LOGIN.txt" na Area de Trabalho.
  NAO responde, NAO clica em Responder e NAO altera nada no Google. Quem publica a resposta e uma pessoa.
  Senha do Google: nunca fica neste script nem em arquivo. O login e manual.
  USO:  powershell -File robo_google_avaliacoes.ps1            (normal)
        powershell -File robo_google_avaliacoes.ps1 -DryRun    (le, mostra o que leu e NAO envia ao BI)
        powershell -File robo_google_avaliacoes.ps1 -DryRun -Url "https://..."   (testa outro link)
#>
param([switch]$DryRun, [string]$Url = '')
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$CredPath = "$env:USERPROFILE\.seujustino\zigpay_credentials.json"   # so o campo "bi" (login do robo no BI)
$LogPath = "$ScriptDir\robo_google_avaliacoes.log"
$DriverCacheDir = "$ScriptDir\chromedriver-cache"
$ProfileDir = "$env:USERPROFILE\.seujustino\chrome-profile-google"
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'
$UrlPath = "$env:USERPROFILE\.seujustino\google_avaliacoes_url.txt"   # opcional: 1 linha com o link da pagina de avaliacoes do Perfil da Empresa
$UrlPadrao = 'https://business.google.com/reviews'
$AvisoLoginPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'GOOGLE AVALIACOES - ROBO PRECISA DE LOGIN.txt'

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
      $msg = "O robo de avaliacoes do Google nao conseguiu entrar em " + (Get-Date -Format 'dd/MM/yyyy HH:mm') + ".`r`nA sessao do Google venceu. A aba Marketing > Avaliacoes Google fica sem atualizar ate resolver.`r`n`r`nComo resolver: rode login_manual_google.ps1 (pasta robo-zigpay), entre no Google, espere abrir as avaliacoes e FECHE a janela."
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

# ---------------- leitura da pagina de avaliacoes ----------------
function Get-PageText($drv) { return [string]$drv.ExecuteScript("return document.body.innerText||''") }
function Get-Sha1([string]$s) {
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $b = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Test-Logado([string]$texto, [string]$urlAtual) {
  if ($urlAtual -match 'accounts\.google\.com|ServiceLogin|signin') { return $false }
  return ($texto -match 'Avalia..es|Reviews|avalia..o|Perfil da Empresa|Business Profile')
}
# Blocos de avaliacao: acha elementos com aria-label de estrelas ("5 estrelas", "Avaliado com 4 de 5 estrelas") e sobe ate o
# contentor que tem texto suficiente; devolve o texto cru e a nota. O nome e removido no PowerShell (linhas antes de "quando").
$JsBlocos = @'
var out=[],vistos=new Set();
var ests=[...document.querySelectorAll('[aria-label]')].filter(function(e){return /(\d)(?:[,.]\d)?\s*(?:de\s*5\s*)?(estrela|star)/i.test(e.getAttribute('aria-label')||'')});
ests.forEach(function(e){
  var m=(e.getAttribute('aria-label')||'').match(/(\d)(?:[,.]\d)?\s*(?:de\s*5\s*)?(estrela|star)/i);if(!m)return;
  var c=e;for(var i=0;i<8&&c.parentElement;i++){c=c.parentElement;var t=(c.innerText||'').trim();
    var outras=c.querySelectorAll('[aria-label*="estrela"],[aria-label*="star"]').length;
    if(t.length>25&&outras<=2)break}
  var t2=(c.innerText||'').trim();if(!t2||vistos.has(t2))return;vistos.add(t2);
  out.push({nota:parseInt(m[1],10),bruto:t2.slice(0,3000)});
});
return JSON.stringify(out);
'@
$RxQuando = '^(h. (\d+|um|uma) .+|.+ atr.s|ontem|hoje|Editad[oa].*|\d{1,2} de [a-z\u00e7]+\.? de \d{4}|\d+ (minutos?|horas?|dias?|semanas?|meses|m.s|anos?)( atr.s)?)$'
$RxUi = '^([\u2605\u2606 ]+|Responder|Editar resposta|Curtir|Mais|Denunciar|Compartilhar|Ver original|Traduzir.*|Ler mais|Mostrar mais|Util|.til|\d+|Local Guide.*|\d+ avalia..es?.*|\d+ fotos?.*)$'
function Parse-Bloco($b) {
  $linhas = @($b.bruto -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  $iq = -1
  for ($k = 0; $k -lt $linhas.Count -and $k -lt 8; $k++) { if ($linhas[$k] -match $RxQuando) { $iq = $k; break } }
  if ($iq -lt 0) { return $null }   # sem "quando" nao da pra separar o nome do cliente com seguranca: descarta
  $quando = $linhas[$iq]
  $resto = @(); if ($iq + 1 -lt $linhas.Count) { $resto = @($linhas[($iq + 1)..($linhas.Count - 1)]) }
  $respondida = $false; $corpo = @()
  foreach ($l in $resto) {
    if ($l -match '^(Resposta d[oa] (propriet|dono|empresa)|Sua resposta|Response from the owner|Resposta do estabelecimento)') { $respondida = $true; break }
    if ($l -match $RxUi) { continue }
    $corpo += $l
  }
  $texto = ($corpo -join ' ').Trim()
  if ($texto.Length -gt 1500) { $texto = $texto.Substring(0, 1500) }
  # nome do cliente = tudo antes de "quando" (nunca sai daqui); a chave usa ele so como sal do hash
  $sal = ($linhas[0..([Math]::Max(0, $iq - 1))] -join '|')
  $chave = Get-Sha1 ("$sal|$($b.nota)|$texto")
  return [ordered]@{ chave = $chave; nota = [int]$b.nota; texto = $texto; quando = $quando; respondida = $respondida }
}

function Read-Avaliacoes($drv, [string]$alvo) {
  Enter-SeUrl -Driver $drv -Url $alvo | Out-Null
  Start-Sleep -Seconds 12
  $txt = Get-PageText $drv
  if (-not (Test-Logado $txt ([string]$drv.Url))) { return $null }
  # rola para carregar mais avaliacoes (ate ~6 vezes)
  for ($r = 0; $r -lt 6; $r++) {
    [void]$drv.ExecuteScript("var els=[...document.querySelectorAll('*')].filter(function(e){return e.scrollHeight>e.clientHeight+200&&getComputedStyle(e).overflowY.match(/auto|scroll/)});(els.length?els[els.length-1]:document.scrollingElement).scrollTop+=100000;window.scrollTo(0,document.body.scrollHeight)")
    Start-Sleep -Seconds 3
  }
  $json = [string]$drv.ExecuteScript($JsBlocos)
  $blocos = @($json | ConvertFrom-Json)
  $lista = @(); $descartadas = 0
  foreach ($b in $blocos) {
    $p = Parse-Bloco $b
    if ($p) { $lista += $p } else { $descartadas++ }
  }
  Log ("Blocos achados: {0} | lidos: {1} | descartados (sem 'quando' reconhecivel): {2}" -f $blocos.Count, $lista.Count, $descartadas)
  if ($lista.Count -eq 0) {
    $dump = Join-Path ([Environment]::GetFolderPath('Desktop')) 'GOOGLE AVALIACOES - PAGINA LIDA (conferir).txt'
    Set-Content -Path $dump -Value ("URL: " + $drv.Url + "`r`n`r`n" + $txt.Substring(0, [Math]::Min(6000, $txt.Length))) -Encoding UTF8
    Log "Nenhuma avaliacao reconhecida. Texto da pagina salvo em: $dump (contem nomes; confira antes de mostrar a alguem)."
  }
  return ,$lista
}

# ---------------- principal ----------------
Log "Iniciando robo Avaliacoes Google$(if ($DryRun) { ' (DryRun)' })"
$alvo = $Url
if (-not $alvo -and (Test-Path $UrlPath)) { $alvo = (Get-Content $UrlPath -Raw).Trim() }
if (-not $alvo) { $alvo = $UrlPadrao }
Log "Pagina: $alvo"
$cred = Get-Credentials
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Import-Module Selenium
$pidsAntes = @((Get-Process chrome, chromedriver -ErrorAction SilentlyContinue).Id)
$driverDir = Get-MatchingChromeDriver
$drv = Start-SeChrome -Headless -Quiet -BinaryPath "C:\Program Files\Google\Chrome\Application\chrome.exe" -WebDriverDirectory $driverDir -Arguments @('--window-size=1500,2400', "--user-data-dir=$ProfileDir")
$lista = $null
try { $lista = Read-Avaliacoes $drv $alvo } catch { Log ("ERRO leitura: " + $_.Exception.Message) }
finally {
  try { Stop-SeDriver -Driver $drv } catch {}
  Get-Process chrome, chromedriver -ErrorAction SilentlyContinue | Where-Object { $pidsAntes -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
}
if ($null -eq $lista) { Set-AvisoLogin $true; Log "AVISO: nao entrou nas avaliacoes (sessao vencida ou leitura falhou). Rode login_manual_google.ps1."; exit 2 }
Set-AvisoLogin $false
if ($lista.Count -eq 0) { Log "AVISO: pagina abriu, mas nenhuma avaliacao foi reconhecida (veja o arquivo na Area de Trabalho)."; exit 4 }
$naoResp = @($lista | Where-Object { -not $_.respondida }).Count
Log ("Lidas {0} avaliacoes ({1} sem resposta)." -f $lista.Count, $naoResp)
if ($DryRun) { $lista | ForEach-Object { Log ("  {0} estrela(s) | {1} | respondida={2} | {3}" -f $_.nota, $_.quando, $_.respondida, $_.texto.Substring(0, [Math]::Min(90, $_.texto.Length))) }; exit 0 }
$token = Get-BiToken $cred
$res = Invoke-AppsScript @{ action = 'submitGoogleAvaliacoes'; token = $token; avaliacoes = @($lista) }
if (-not $res.ok) { Log ("AVISO: BI recusou as avaliacoes: $($res.error) $($res.code)"); exit 3 }
Log ("Enviado ao BI: {0} novas, {1} com sugestao." -f $res.novas, $res.comSugestao)
Log "Concluido."
