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
param([switch]$DryRun, [switch]$Diag, [string]$Url = '')
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$CredPath = "$env:USERPROFILE\.seujustino\zigpay_credentials.json"   # so o campo "bi" (login do robo no BI)
$LogPath = "$ScriptDir\robo_google_avaliacoes.log"
$DriverCacheDir = "$ScriptDir\chromedriver-cache"
$ProfileDir = "$env:USERPROFILE\.seujustino\chrome-profile-google"
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'
$UrlPath = "$env:USERPROFILE\.seujustino\google_avaliacoes_url.txt"   # opcional: 1 linha com o link da pagina de avaliacoes do Perfil da Empresa
$UrlPadrao = 'https://business.google.com/reviews'
$LocalPath = "$env:USERPROFILE\.seujustino\google_avaliacoes_local.txt"   # opcional: parte do nome do local no Google (padrao: Seu Justino Vila Madalena)
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
# Cartoes de avaliacao do gerenciador (classes vistas no diagnostico mascarado de 27/10; o Google pode renomear: se parar de ler, rode -Diag):
#   .DsOcnf cartao | .rRqL5e nome do local | .LH5kS autor (so entra no hash, nunca sai) | .Xl7c2c .DPvwYc estrelas (nota = quantas tem a mesma classe da 1a)
#   .zWmYWd.NhZJzb data | .oiQd1c texto completo | .Rhj72c resposta do dono (existe = ja respondida)
$JsCartoes = @'
var out=[];
document.querySelectorAll('.DsOcnf').forEach(function(c){
  function tx(sel){var e=c.querySelector(sel);return e?(e.textContent||'').trim():''}
  var est=c.querySelectorAll('.Xl7c2c .DPvwYc');var nota=0;
  if(est.length){var cls=est[0].className;for(var i=0;i<est.length;i++){if(est[i].className===cls)nota++}}
  var full=c.querySelector('.oiQd1c');var texto=full?(full.textContent||''):'';
  if(!texto){var q=c.querySelector('blockquote');texto=q?(q.textContent||'').replace(/Mais\s*$/,''):''}
  out.push({local:tx('.rRqL5e'),autor:tx('.LH5kS'),nota:nota,quando:tx('.zWmYWd.NhZJzb'),texto:texto.replace(/\s+/g,' ').trim().slice(0,1500),respondida:!!c.querySelector('.Rhj72c')});
});
return JSON.stringify(out);
'@
function Norm-Txt([string]$s) {
  $d = $s.Normalize([System.Text.NormalizationForm]::FormD)
  return ((($d.ToCharArray() | Where-Object { [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne 'NonSpacingMark' }) -join '').ToLower() -replace '\s+', ' ').Trim()
}
$JsEstrutura = @'
function mk(t){return (t||'').replace(/[A-Za-z\u00c0-\u00ff]/g,'x')}
function keep(t){return /^(Responder|Editar|Excluir|Mais|Original|Traduzido)/i.test(t)}
var out=[];
function desc(e,d){
  if(out.length>320||d>16)return;
  var a=[e.tagName.toLowerCase()];
  var cl=(e.getAttribute('class')||'').split(' ').filter(String).slice(0,3).join('.');if(cl)a.push('.'+cl);
  var ro=e.getAttribute('role');if(ro)a.push('role='+ro);
  var al=e.getAttribute('aria-label');if(al)a.push('aria-label='+((/estrela|star/i.test(al)&&al.length<40)?al:mk(al)));
  ['fill','aria-hidden','aria-valuenow','data-star-rating','data-rating'].forEach(function(n){var v=e.getAttribute(n);if(v!==null&&v.length<30)a.push(n+'='+v)});
  var st=e.getAttribute('style');if(st)a.push('style='+st.slice(0,70));
  if(e.tagName==='IMG'){a.push('alt='+mk(e.getAttribute('alt')))}
  if(e.children.length===0){var t=(e.textContent||'').trim();if(t)a.push('txt='+(keep(t)?t:mk(t).slice(0,60)))}
  out.push(new Array(d+1).join('  ')+a.join(' '));
  for(var i=0;i<e.children.length;i++)desc(e.children[i],d+1);
}
function achaCartao(ancora){
  var els=[...document.querySelectorAll('button,div,span,a')].filter(function(e){return (e.innerText||'').trim()===ancora&&e.children.length<=3});
  if(!els.length)return null;
  var c=els[0];
  for(var i=0;i<16&&c.parentElement;i++){
    var p=c.parentElement;var n=((p.innerText||'').split(ancora).length-1);
    if(n>1)break;c=p}
  return c;
}
['Responder','Excluir'].forEach(function(an){
  out.push('===== CARTAO ancorado em '+an+' =====');
  var c=achaCartao(an);if(c)desc(c,0);else out.push('(nao achei)');
});
return out.join('\n');
'@
$RxQuando = '^(h. (\d+|um|uma) .+|.+ atr.s|ontem|hoje|Editad[oa].*|\d{1,2} de [a-z\u00e7]+\.? de \d{4}|\d+ (minutos?|horas?|dias?|semanas?|meses|m.s|anos?)( atr.s)?)$'
$RxUi = '^([\u2605\u2606 ]+|Responder|Editar resposta|Curtir|Mais|Denunciar|Compartilhar|Ver original|Traduzir.*|Ler mais|Mostrar mais|Util|.til|\d+|Local Guide.*|\d+ avalia..es?.*|\d+ fotos?.*)$'
function Mask-Linha([string]$l) {
  if ($l -match $RxQuando -or $l -match $RxUi -or $l -match '^(Responder|Resposta|Avalia|Todas|Filtrar|Ordenar|Estrelas|Mais recentes|Reviews|Perfil|Business)') { return $l }
  return ($l -creplace '[A-Za-z\u00c0-\u00ff]', 'x')
}
function Read-Avaliacoes($drv, [string]$alvo) {
  Enter-SeUrl -Driver $drv -Url $alvo | Out-Null
  Start-Sleep -Seconds 12
  $txt = Get-PageText $drv
  if (-not (Test-Logado $txt ([string]$drv.Url))) { return $null }
  # rola ate parar de aparecer avaliacao nova (2 vezes seguidas sem novidade), no maximo 30 rolagens
  $antes = -1; $iguais = 0
  for ($r = 0; $r -lt 30; $r++) {
    [void]$drv.ExecuteScript("var els=[...document.querySelectorAll('*')].filter(function(e){return e.scrollHeight>e.clientHeight+200&&getComputedStyle(e).overflowY.match(/auto|scroll/)});(els.length?els[els.length-1]:document.scrollingElement).scrollTop+=100000;window.scrollTo(0,document.body.scrollHeight)")
    Start-Sleep -Seconds 3
    $n = [int]$drv.ExecuteScript("return document.querySelectorAll('.DsOcnf').length")
    if ($n -eq $antes) { $iguais++; if ($iguais -ge 2) { break } } else { $iguais = 0 }
    $antes = $n
  }
  Log "Rolagens feitas: $($r + 1) | cartoes carregados: $antes"
  if ($Diag) {
    $est = [string]$drv.ExecuteScript($JsEstrutura)
    $arq = Join-Path ([Environment]::GetFolderPath('Desktop')) 'GOOGLE AVALIACOES - ESTRUTURA MASCARADA.txt'
    Set-Content -Path $arq -Value $est -Encoding UTF8
    Log "Estrutura mascarada (sem nomes) salva em: $arq"
    return ,@()
  }
  $json = [string]$drv.ExecuteScript($JsCartoes)
  $cartoes = @((ConvertFrom-Json $json) | ForEach-Object { $_ })   # PS 5.1 devolve o array JSON como 1 objeto: desenrola
  $localAlvo = 'Seu Justino Vila Madalena'
  if (Test-Path $LocalPath) { $l1 = (Get-Content $LocalPath -Raw -Encoding UTF8).Trim(); if ($l1) { $localAlvo = $l1 } }
  $alvoNorm = Norm-Txt $localAlvo
  $locais = @($cartoes | ForEach-Object { $_.local } | Where-Object { $_ } | Sort-Object -Unique)
  Log ("Cartoes de avaliacao na pagina: {0}. Locais vistos: {1}" -f $cartoes.Count, ($locais -join ' | '))
  $lista = @(); $outrosLocais = 0; $semNota = 0
  foreach ($c in $cartoes) {
    if (-not ((Norm-Txt ([string]$c.local)).Contains($alvoNorm))) { $outrosLocais++; continue }
    if ([int]$c.nota -lt 1 -or [int]$c.nota -gt 5) { $semNota++; continue }
    $chave = Get-Sha1 ("$($c.autor)|$($c.nota)|$($c.texto)|$($c.local)")   # autor so serve de sal do hash; nao e enviado
    $lista += [ordered]@{ chave = $chave; nota = [int]$c.nota; texto = [string]$c.texto; quando = [string]$c.quando; respondida = [bool]$c.respondida }
  }
  Log ("Local '{0}': lidas {1} | de outros locais (ignoradas): {2} | sem nota reconhecida: {3}" -f $localAlvo, $lista.Count, $outrosLocais, $semNota)
  if ($lista.Count -eq 0) {
    Log "Nenhuma avaliacao do local '$localAlvo'. Se o nome do local no Google for outro, escreva-o numa linha de $LocalPath (parte do nome basta). Se a pagina mudou, rode com -Diag."
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
if ($Diag) { if ($null -eq $lista) { Log "Sem login: rode login_manual_google.ps1." } else { Log "Diagnostico de estrutura concluido." }; exit 0 }
if ($null -eq $lista) { Set-AvisoLogin $true; Log "AVISO: nao entrou nas avaliacoes (sessao vencida ou leitura falhou). Rode login_manual_google.ps1."; exit 2 }
Set-AvisoLogin $false
if ($lista.Count -eq 0) { Log "AVISO: pagina abriu, mas nenhuma avaliacao foi reconhecida (veja o arquivo na Area de Trabalho)."; exit 4 }
$naoResp = @($lista | Where-Object { -not $_.respondida }).Count
Log ("Lidas {0} avaliacoes ({1} sem resposta)." -f $lista.Count, $naoResp)
Log ("Por nota: " + ((5..1 | ForEach-Object { $k = $_; "{0} estrela(s): {1}" -f $k, @($lista | Where-Object { $_.nota -eq $k }).Count }) -join ' | ') + " | respondidas: " + @($lista | Where-Object { $_.respondida }).Count)
if ($DryRun) { $lista | ForEach-Object { Log ("  {0} estrela(s) | {1} | respondida={2} | {3}" -f $_.nota, $_.quando, $_.respondida, $_.texto.Substring(0, [Math]::Min(90, $_.texto.Length))) }; exit 0 }
$token = Get-BiToken $cred
$res = Invoke-AppsScript @{ action = 'submitGoogleAvaliacoes'; token = $token; avaliacoes = @($lista) }
if (-not $res.ok) { Log ("AVISO: BI recusou as avaliacoes: $($res.error) $($res.code)"); exit 3 }
Log ("Enviado ao BI: {0} novas, {1} com sugestao." -f $res.novas, $res.comSugestao)
Log "Concluido."
