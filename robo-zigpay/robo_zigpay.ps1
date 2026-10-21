<#
  Robo de faturamento ZigPay -> BI Gerencial Seu Justino.
  Roda 1x por dia (Agendador de Tarefas do Windows, 8h) e faz:
    1. Login na API da ZigPay via HTTP puro (sem navegador - ver nota abaixo).
    2. Le faturamento, publico e horario por bloco de 30min direto da API
       (getEvents/getConsumptionTimeline), sem raspar tela nenhuma.
    3. Abre Chrome/Selenium SO pra ler venda por item (CMV teorico parcial) -
       unica parte que a API nao cobre ainda (ver nota "SOBRE A API" abaixo).
    4. Faz login no proprio BI (conta de servico "robo-zigpay") e grava tudo
       la, pela mesma API que o resto do BI usa.

  SOBRE A API (descoberta em 2026-09-26, ver 00-sistema/memory.md do vault
  pra historico completo da investigacao):
    A ZigPay roda sobre uma API JSON-RPC ("sdkgen") em
    api.zigcore.com.br/enterprise-postgres/<nome>. Autenticacao e so um
    "deviceId" (qualquer string, o cliente inventa) que vira credencial
    valida no instante em que "logIn" da certo com ele - sem cookie, sem
    token separado. Login por HTTP puro CONFIRMADO funcionando (testado
    ponta a ponta, sem abrir navegador nenhuma vez).
    "getEvents" ({placeId,month,year}, month 0-indexed) devolve o MES
    INTEIRO numa chamada so: por evento, income (faturamento, em centavos),
    totalPublic e id (pra puxar o horario via getConsumptionTimeline).
    VALIDADO contra 232 dias ja lidos pelo Selenium (robo_zigpay.log,
    set/2025 a set/2026): 200 bateram centavo a centavo, as outras 31 sao
    dia de loja fechada (Selenium leu R$0, API simplesmente nao tem evento -
    mesma coisa). So NAO da pra puxar assim: venda por item com SKU e
    categoria (pro CMV teorico cruzar com a ficha tecnica do Everest) -
    "getSelledProducts" existe mas só devolve {name,count,totalValue}, sem
    SKU/categoria (testado e confirmado insuficiente). Por isso essa parte
    especifica continua no Selenium, raspando "Relatorio geral > Produtos"
    como sempre foi. Candidato pra fechar isso via API tambem mais pra
    frente: "runProductsSoldReport" (achado na doc embutida do JS do
    dashboard, argumentos ainda nao testados).

  ACHADO 10/10: a ZigPay colocou a API ("logIn" incluso) atras de protecao
  anti-bot da Cloudflare - toda chamada "pura" (sem navegador) toma 403
  "Attention Required! | Cloudflare" desde 06/10, local e na nuvem (testado
  os dois). O login VIA NAVEGADOR (Selenium) continua passando normal -
  so a chamada direta a api.zigcore.com.br que esta barrada, mesmo de
  dentro de uma pagina ja logada (testado: fetch() da pagina tambem falha,
  provavel preflight CORS tambem bloqueado pela Cloudflare). Enquanto durar
  esse bloqueio, o robo cai sozinho pro FALLBACK via navegador pra
  faturamento (Get-RevenueFromDate, le "Relatorio geral" igual a versao
  anterior a 26/09) E publico (Get-PublicoFromDate, achado do Renato 10/10:
  tela separada "Business Intelligence (BETA)",
  /place/<id>/business-intelligence, aba Clientes - "Publico medio" com
  periodo = 1 dia vira o publico REAL daquele dia). Ticket medio NAO precisa
  fallback proprio - e so revenue/publico, recalculado sozinho assim que os
  dois estao gravados (ver ticketMedio() em getRevenueOverview_ no Code.gs).
  Unico que fica mesmo sem captura: horario por bloco de 30min (a tela
  "Business Intelligence" tem uma secao "Total de venda por horario" que
  pode ter esse dado tambem - nao investigado ainda, candidato pra fechar
  esse ultimo buraco se precisar). Primeira coisa a
  tentar se isso aparecer de novo no log depois de ter voltado a funcionar:
  rodar -Discover e ver se o login via API voltou a passar.

  SETUP (uma vez so, ver instrucoes que o Claude te passou):
    - Preencha C:\Users\renap\.seujustino\zigpay_credentials.json com o usuario e
      senha reais da ZigPay (campo "zigpay"). O campo "bi" ja vem pronto - so
      precisa rodar addAccount_() uma vez no Apps Script com esse mesmo email/senha.

  USO:
    powershell -File robo_zigpay.ps1                 # execucao normal (agendada) - so o dia de ontem
    powershell -File robo_zigpay.ps1 -Discover        # so loga e mostra o usuario logado, nao envia nada
    powershell -File robo_zigpay.ps1 -DryRun          # faz tudo, mas nao envia o valor pro BI (so mostra no console)
    powershell -File robo_zigpay.ps1 -BackfillFrom 2026-09-01 -BackfillTo 2026-09-22
      # preenche retroativo um intervalo de datas. Faturamento/publico/horario saem
      # da API (rapido, so 1 chamada por mes cobrindo o intervalo inteiro). Pula
      # sozinho datas que ja estao gravadas no BI (getZigRevenue), entao rodar o
      # mesmo intervalo de novo so ataca o que ainda falta. Combina com -DryRun
      # pra so testar sem gravar, ou -SkipCmv pra pular Selenium inteiro (CMV) e
      # ir MUITO mais rapido quando so faturamento/publico importam.
#>
param(
  [switch]$Discover,
  [switch]$DryRun,
  [string]$BackfillFrom,
  [string]$BackfillTo,
  [switch]$SkipCmv,
  [switch]$SkipBilheteria
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$CredPath = "$env:USERPROFILE\.seujustino\zigpay_credentials.json"
$LogPath = "$ScriptDir\robo_zigpay.log"
$DebugDir = "$ScriptDir\.debug"
$DriverCacheDir = "$ScriptDir\chromedriver-cache"
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'
$ZigPayLoginUrl = 'https://dashboard.zigpay.com.br/login'
$ZigApiBase = 'https://api.zigcore.com.br/enterprise-postgres'
# ID do local (Seu Justino Madalena) - fixo, confirmado navegando manualmente, nao muda entre sessoes.
$PlaceId = 'baa37552-df9e-42a7-9010-d108ee1a3710'

# CMV teorico PARCIAL: cruza venda por item (ZigPay, via Selenium) com custo de
# ficha tecnica (Everest). So ~85% do faturamento tem ficha cadastrada hoje
# (cobertura hibrida, ver memoria de 22/09) - por isso e so um card informativo
# no BI, nao substitui o lancamento manual do Marcio.
$EverestCatalogPath = "$ScriptDir\cmv-teorico\everest_catalogo.csv"

# categoria (como aparece no relatorio 'Produtos vendidos por local') -> tipo.
$CategoriaTipo = @{
  'PORÇÕES'='comida'; 'LANCHE'='comida'; 'LANCHES'='comida'; 'CAFE'='comida'
  'SOBREMESAS'='comida'; 'ACOMPANHAMENTOS'='comida'; 'CHAPAS'='comida'; 'PRATOS'='comida'
  'BRUNCH'='comida'; 'BUFFET'='comida'; 'SALADAS'='comida'; 'ENTRADAS'='comida'; 'CARNES'='comida'
  'TEQUILAS'='bebida'; 'GTS'='bebida'; 'LONG NECKS'='bebida'; 'APERITIVOS'='bebida'
  'CLASSICOS'='bebida'; 'AUTORAIS'='bebida'; 'ENERGETICOS'='bebida'; 'CAIPIS'='bebida'
  'LICORES'='bebida'; 'CHOPPS'='bebida'; 'VINHOS TINTOS'='bebida'; 'SUCOS'='bebida'
  'GINS'='bebida'; 'Cerveja'='bebida'; 'WHISKIES'='bebida'; 'AGUAS'='bebida'
  'DRINKS SEM ALCOOL'='bebida'; 'LATAS'='bebida'; 'REFRIGERANTES'='bebida'; 'RUMS'='bebida'
  'VODKAS'='bebida'; 'VINHOS ESPUMANTES'='bebida'
}

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  for ($tentativa = 1; $tentativa -le 5; $tentativa++) {
    try {
      Add-Content -Path $LogPath -Value $line -Encoding utf8 -ErrorAction Stop
      return
    } catch {
      if ($tentativa -eq 5) { return }
      Start-Sleep -Milliseconds 200
    }
  }
}

function Get-Credentials {
  if (-not (Test-Path $CredPath)) { throw "Arquivo de credenciais nao encontrado: $CredPath" }
  $cred = Get-Content $CredPath -Raw | ConvertFrom-Json
  foreach ($f in @($cred.zigpay.organization, $cred.zigpay.username, $cred.zigpay.password)) {
    if (-not $f -or $f -eq 'PREENCHA-AQUI') { throw "Preencha as credenciais da ZigPay em $CredPath antes de rodar o robo." }
  }
  return $cred
}

# ---------------- ZigPay via API HTTP pura (sem navegador) ----------------

function New-RandomHex([int]$len) {
  -join ((1..$len) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] })
}

# Chamada sdkgen generica. $deviceId e a "credencial" (ver nota no topo do
# arquivo) - qualquer string ate a primeira chamada de logIn, depois disso
# tem que ser sempre a MESMA que foi usada no logIn que deu certo.
function Invoke-ZigSdkgen($name, $sdkArgs, $deviceId, [int]$MaxTentativas = 3) {
  $body = @{
    args = $sdkArgs
    deviceInfo = @{ id = $deviceId; language = "pt-BR"; platform = @{ browserUserAgent = "robo-zigpay-http" }; timezone = "America/Sao_Paulo"; type = "web"; version = "" }
    extra = @{ tz = "America/Sao_Paulo"; lng = "pt-BR" }
    name = $name
    requestId = New-RandomHex 32
    version = 3
  } | ConvertTo-Json -Depth 8
  for ($tentativa = 1; $tentativa -le $MaxTentativas; $tentativa++) {
    try {
      $resp = Invoke-WebRequest -Uri "$ZigApiBase/$name" -Method POST -Body $body -ContentType "application/sdkgen" -UseBasicParsing -TimeoutSec 30
      $parsed = $resp.Content | ConvertFrom-Json
      if ($parsed.error) { throw "ZigPay API recusou '$name': $($parsed.error.message)" }
      return $parsed.result
    } catch {
      if ($tentativa -eq $MaxTentativas) { throw }
      Log ("Falha ao chamar API ZigPay '$name' (tentativa $tentativa/$MaxTentativas): $($_.Exception.Message) - tentando de novo em 3s.")
      Start-Sleep -Seconds 3
    }
  }
}

# Login por HTTP puro - CONFIRMADO funcionando sem navegador (ver nota no
# topo do arquivo). Gera um deviceId novo a cada execucao (nao precisa
# persistir entre rodadas - login de novo e barato, e evita depender de um
# deviceId antigo que a ZigPay possa ter revogado).
function Get-ZigPayDeviceId($cred) {
  $deviceId = New-RandomHex 40
  $result = Invoke-ZigSdkgen "logIn" @{ username = $cred.zigpay.username; password = $cred.zigpay.password; organizationUsername = $cred.zigpay.organization } $deviceId
  Log ("Login ZigPay (API) ok: $($result.name)")
  return $deviceId
}

# Mes inteiro (faturamento + publico por evento) numa chamada so. month e
# 1-12 aqui (convertido pro 0-indexado que a API espera dentro da funcao).
function Get-EventsForMonth($deviceId, [int]$year, [int]$month) {
  return Invoke-ZigSdkgen "getEvents" @{ placeId = $PlaceId; month = $month - 1; year = $year } $deviceId
}

# Soma income/totalPublic por data de calendario (data local = data de
# inicio do evento) - um dia pode ter mais de um evento, soma os dois.
function Group-EventsByDate($eventsResult) {
  $porData = @{}
  foreach ($ev in $eventsResult.events) {
    $data = $ev.begin.Substring(0,10)
    if (-not $porData.ContainsKey($data)) { $porData[$data] = @{ revenue = 0.0; publico = 0; servico = 0.0; eventIds = @() } }
    $porData[$data].revenue += ($ev.income / 100.0)
    $porData[$data].servico += ($ev.sales.service / 100.0)
    $porData[$data].publico += $ev.totalPublic
    $porData[$data].eventIds += $ev.id
  }
  return $porData
}

function Get-ConsumptionTimeline($deviceId, $eventId) {
  return Invoke-ZigSdkgen "getConsumptionTimeline" @{ eventId = $eventId } $deviceId
}

# ---------------- BI (Apps Script) ----------------

function Submit-Revenue($token, $date, $revenue, $servico = 0.0) {
  $res = Invoke-AppsScript @{ action = 'submitZigRevenue'; token = $token; date = $date; revenue = $revenue; servico = $servico; source = 'robo-zigpay-api' }
  if (-not $res.ok) { throw "BI recusou o envio do faturamento: $($res.error)" }
}

function Submit-Publico($token, $date, $clientes) {
  $res = Invoke-AppsScript @{ action = 'submitZigPublico'; token = $token; date = $date; publico = $clientes; source = 'robo-zigpay-api' }
  if (-not $res.ok) { throw "BI recusou o envio do publico de $date : $($res.error)" }
}

function Submit-Hourly($token, $date, $buckets) {
  $res = Invoke-AppsScript @{ action = 'submitZigHourly'; token = $token; date = $date; buckets = $buckets; source = 'robo-zigpay-api' }
  if (-not $res.ok) { throw "BI recusou o envio do horario de $date : $($res.error)" }
}

# Grava faturamento + publico de UMA data (a partir do mapa ja agregado por
# Group-EventsByDate). Data sem evento = R$0/0 clientes (dia fechado), mesmo
# valor que o Selenium sempre leu pra esses dias - mantem uma linha por dia.
function Submit-RevenueAndPublicoForDate($token, $porData, [string]$isoDate, [bool]$dryRun) {
  $info = if ($porData.ContainsKey($isoDate)) { $porData[$isoDate] } else { @{ revenue = 0.0; publico = 0; servico = 0.0 } }
  Log ("Faturamento (API) para {0}: R$ {1:N2} | servico: R$ {3:N2} | publico: {2}" -f $isoDate, $info.revenue, $info.publico, $info.servico)
  if ($dryRun) { return }
  Submit-Revenue -token $token -date $isoDate -revenue $info.revenue -servico $info.servico
  Submit-Publico -token $token -date $isoDate -clientes $info.publico
}

# Horario por bloco de 30min de TODOS os eventos de um mes (soma quando ha
# mais de um evento no mesmo dia) - mesmo formato que o BI ja espera.
function Submit-HourlyForMonth($token, $deviceId, $eventsResult, [bool]$dryRun) {
  $porData = @{}
  foreach ($ev in $eventsResult.events) {
    $data = $ev.begin.Substring(0,10)
    if (-not $porData.ContainsKey($data)) { $porData[$data] = @{} }
    try {
      $timeline = Get-ConsumptionTimeline -deviceId $deviceId -eventId $ev.id
      foreach ($b in $timeline) {
        $key = $b.start
        if (-not $porData[$data].ContainsKey($key)) { $porData[$data][$key] = @{ intervalInMinutes = $b.intervalInMinutes; value = 0 } }
        $porData[$data][$key].value += $b.value
      }
    } catch {
      Log ("AVISO: falha ao ler horario do evento $($ev.id) ($data): $($_.Exception.Message)")
    }
  }
  $diasOk = 0
  foreach ($data in $porData.Keys) {
    $bucketsList = @($porData[$data].GetEnumerator() | ForEach-Object { @{ start = $_.Key; intervalInMinutes = $_.Value.intervalInMinutes; value = $_.Value.value } })
    if (-not $bucketsList.Count) { continue }
    if ($dryRun) {
      Log ("  {0}: {1} bucket(s) de horario (dry-run, nao enviado)" -f $data, $bucketsList.Count)
    } else {
      try {
        Submit-Hourly -token $token -date $data -buckets $bucketsList
        $diasOk++
      } catch {
        Log ("AVISO: falha ao enviar horario de {0}: {1}" -f $data, $_.Exception.Message)
      }
    }
  }
  if (-not $dryRun) { Log ("Horario por bloco de 30min enviado pro BI: {0} dia(s)." -f $diasOk) }
}

# ---------------- Selenium: SO venda por item (CMV teorico), ver nota no topo ----------------

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

function Wait-Element($driver, [string]$XPath, [int]$TimeoutSec = 20) {
  $limite = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $limite) {
    $el = Find-SeElement -Driver $driver -XPath $XPath -ErrorAction SilentlyContinue
    if ($el) { return $el }
    Start-Sleep -Milliseconds 500
  }
  throw "Elemento nao apareceu em $TimeoutSec s: $XPath"
}

function Wait-VisibleElement($driver, [string]$XPath, [int]$TimeoutSec = 20) {
  $limite = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $limite) {
    $els = @(Find-SeElement -Driver $driver -XPath $XPath -ErrorAction SilentlyContinue)
    $visivel = $els | Where-Object { $_ -and $_.Displayed } | Select-Object -First 1
    if ($visivel) { return $visivel }
    Start-Sleep -Milliseconds 500
  }
  throw "Elemento visivel nao apareceu em $TimeoutSec s: $XPath"
}

$MonthAbbrevMap = @{ 'Jan'=1;'Feb'=2;'Mar'=3;'Apr'=4;'May'=5;'Jun'=6;'Jul'=7;'Aug'=8;'Sep'=9;'Oct'=10;'Nov'=11;'Dec'=12 }

function Set-CalendarMonth($driver, [datetime]$alvo) {
  for ($tentativa = 0; $tentativa -lt 40; $tentativa++) {
    $atual = $driver.ExecuteScript(@'
var m = document.querySelector(".ant-picker-month-btn");
var y = document.querySelector(".ant-picker-year-btn");
if (!m || !y) return null;
return JSON.stringify({mes: m.textContent.trim(), ano: y.textContent.trim()});
'@)
    if (-not $atual) { Start-Sleep -Milliseconds 300; continue }
    $obj = $atual | ConvertFrom-Json
    $mesAtual = $MonthAbbrevMap[$obj.mes]
    $anoAtual = [int]$obj.ano
    if (-not $mesAtual) { throw "Mes do calendario nao reconhecido: '$($obj.mes)'" }
    $diff = (($alvo.Year - $anoAtual) * 12) + ($alvo.Month - $mesAtual)
    if ($diff -eq 0) { return }
    $seletorBotao = if ($diff -lt 0) { '.ant-picker-header-prev-btn' } else { '.ant-picker-header-next-btn' }
    $driver.ExecuteScript("var b = document.querySelector('$seletorBotao'); if (b) b.click();") | Out-Null
    Start-Sleep -Milliseconds 350
  }
  throw "Nao consegui navegar o calendario ate $($alvo.ToString('yyyy-MM')) - travou apos $tentativa cliques."
}

function Connect-ZigPay($driver, $cred) {
  Enter-SeUrl -Driver $driver -Url $ZigPayLoginUrl | Out-Null
  (Wait-Element $driver "//input[@id='login-organization']").SendKeys($cred.zigpay.organization) | Out-Null
  (Wait-Element $driver "//input[@id='login-username']").SendKeys($cred.zigpay.username) | Out-Null
  (Wait-Element $driver "//input[@id='login-password']").SendKeys($cred.zigpay.password) | Out-Null
  (Wait-Element $driver "//*[@id='button-login-submit']").Click() | Out-Null
  Start-Sleep -Seconds 3
  $limite = (Get-Date).AddSeconds(20)
  while ($driver.Url -like '*login*' -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }
  if ($driver.Url -like '*login*') {
    throw "Login na ZigPay (navegador) nao saiu da tela de login - confira usuario/senha/organizacao em $CredPath."
  }
  Log ("Login ZigPay (navegador) ok. URL pos-login: " + $driver.Url)
}

function New-ZigPaySession($cred, $driverDir, $pidsAntes) {
  $novoDriver = $null
  for ($tentativa = 1; $tentativa -le 3; $tentativa++) {
    try {
      $novoDriver = Start-SeChrome -Headless -Quiet -BinaryPath "C:\Program Files\Google\Chrome\Application\chrome.exe" -WebDriverDirectory $driverDir -Arguments @('--window-size=1920,1080')
      break
    } catch {
      if ($tentativa -eq 3) { throw }
      Log ("Falha ao iniciar o Chrome (tentativa $tentativa/3): $($_.Exception.Message) - matando processo(s) orfao(s) dessa tentativa e tentando de novo em 5s.")
      Get-Process chrome, chromedriver -ErrorAction SilentlyContinue |
        Where-Object { $pidsAntes -notcontains $_.Id } |
        Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
    }
  }
  Connect-ZigPay -driver $novoDriver -cred $cred
  return $novoDriver
}

function Close-ZigPaySession($driver, $pidsAntes) {
  if ($driver) { try { Stop-SeDriver -Driver $driver } catch {} }
  $orfaos = @(Get-Process chrome, chromedriver -ErrorAction SilentlyContinue | Where-Object { $pidsAntes -notcontains $_.Id })
  if (-not $orfaos) { return }
  $orfaos | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 10; $i++) {
    $aindaVivos = @($orfaos | ForEach-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue })
    if (-not $aindaVivos) { return }
    Start-Sleep -Milliseconds 500
  }
}

$ZigPayLocationFilter = 'Madalena'

# FALLBACK — le o Faturamento Total via navegador (tela "Relatorio geral"),
# quando a API sdkgen estiver bloqueada (ver nota 10/10 no topo do arquivo:
# Cloudflare passou a barrar "logIn" da API pura desde 06/10, local e na nuvem).
# So le o numero de faturamento mesmo - publico/horario por bloco de 30min NAO
# tem equivalente nessa tela, ficam sem captura enquanto a API seguir bloqueada
# (ver Invoke-RevenueFallbackForDate, que NAO envia publico/horario fictício).
function Get-RevenueFromDate($driver, [string]$isoDate) {
  $menuRelatorios = Wait-Element $driver "//*[@aria-label='Relatórios']"
  $driver.ExecuteScript("arguments[0].click();", $menuRelatorios) | Out-Null
  Start-Sleep -Milliseconds 500
  $menuRelatorioGeral = Wait-Element $driver "//*[text()='Relatório geral']"
  $driver.ExecuteScript("arguments[0].click();", $menuRelatorioGeral) | Out-Null
  Start-Sleep -Seconds 3

  $jaSelecionado = Find-SeElement -Driver $driver -XPath "//p[contains(text(),'$ZigPayLocationFilter')]" -ErrorAction SilentlyContinue
  if (-not $jaSelecionado) {
    $seletor = Wait-Element $driver "//*[contains(text(),'Selecione local')]"
    $driver.ExecuteScript("arguments[0].click();", $seletor) | Out-Null
    $searchInput = Wait-Element $driver "//input[contains(@class,'ant-select-selection-search-input')]"
    $searchInput.SendKeys($ZigPayLocationFilter) | Out-Null
    $opt = Wait-Element $driver "//div[contains(@class,'ant-select-item-option-content')]"
    $driver.ExecuteScript("arguments[0].click();", $opt) | Out-Null
    Start-Sleep -Seconds 1
    $driver.ExecuteScript("document.body.click();") | Out-Null
  }
  Wait-Element $driver "(//p[@class='sm4Rq'])[1]" -TimeoutSec 40 | Out-Null
  Start-Sleep -Seconds 2
  $driver.ExecuteScript("document.body.click();") | Out-Null
  Start-Sleep -Milliseconds 800

  $dateInput = Wait-Element $driver "//input[@placeholder='Select date']"
  $driver.ExecuteScript("arguments[0].click();", $dateInput) | Out-Null
  Start-Sleep -Milliseconds 800
  $alvoData = [datetime]::ParseExact($isoDate, 'yyyy-MM-dd', $null)
  Set-CalendarMonth -driver $driver -alvo $alvoData
  $dia = Wait-Element $driver "//td[@title='$isoDate']"
  $driver.ExecuteScript("arguments[0].click();", $dia) | Out-Null
  Start-Sleep -Seconds 6

  # dia sem movimento (loja fechada) - faturamento real e zero, nao erro. Checa
  # .Displayed (nao so existencia no DOM) - mesmo achado 10/10 do bloco de
  # Produtos: a ZigPay pode deixar esse aviso sempre no DOM, so escondido via CSS.
  $semDados = @(Find-SeElement -Driver $driver -XPath "//*[contains(text(),'Sem dados')]" -ErrorAction SilentlyContinue) | Where-Object { $_.Displayed } | Select-Object -First 1
  if ($semDados) { return 0.0 }

  try {
    $elValor = Wait-Element $driver "(//p[@class='sm4Rq'])[1]" -TimeoutSec 45
  } catch {
    $semDados = @(Find-SeElement -Driver $driver -XPath "//*[contains(text(),'Sem dados')]" -ErrorAction SilentlyContinue) | Where-Object { $_.Displayed } | Select-Object -First 1
    if ($semDados) { return 0.0 }
    $driver.ExecuteScript("arguments[0].click();", $dia) | Out-Null
    Start-Sleep -Seconds 6
    $semDados = @(Find-SeElement -Driver $driver -XPath "//*[contains(text(),'Sem dados')]" -ErrorAction SilentlyContinue) | Where-Object { $_.Displayed } | Select-Object -First 1
    if ($semDados) { return 0.0 }
    $elValor = Wait-Element $driver "(//p[@class='sm4Rq'])[1]" -TimeoutSec 45
  }
  $textoValor = $elValor.Text
  $limpo = ($textoValor -replace '[^0-9,]', '') -replace '\.', ''
  $limpo = $limpo -replace ',', '.'
  return [double]$limpo
}

# Grava SO o faturamento (sem campo "servico" no payload - preserva o que ja
# estava gravado em vez de zerar, ja que o fallback via navegador nao le essa
# coluna separada ainda).
function Submit-RevenueDomFallback($token, $date, $revenue) {
  $res = Invoke-AppsScript @{ action = 'submitZigRevenue'; token = $token; date = $date; revenue = $revenue; source = 'robo-zigpay-dom-fallback' }
  if (-not $res.ok) { throw "BI recusou o envio do faturamento (fallback navegador): $($res.error)" }
}

# 10/10, achado do Renato: a tela "Business Intelligence (BETA)" (URL por local,
# /place/<id>/business-intelligence - diferente de "Relatorio geral") mostra
# "Publico medio" por periodo na aba Clientes. Com o periodo = 1 dia so (inicio=
# fim=isoDate), "Publico medio" vira o PUBLICO REAL daquele dia - recupera o que
# a API bloqueada deixou de cobrir. Ticket medio NAO precisa ser lido separado:
# ja e calculado sozinho no BI (revenue/publico, ver ticketMedio() em
# getRevenueOverview_) assim que publico estiver gravado.
$ZigBiBetaUrl = "https://dashboard.zigpay.com.br/place/$PlaceId/business-intelligence"
function Get-PublicoFromDate($driver, [string]$isoDate) {
  Enter-SeUrl -Driver $driver -Url $ZigBiBetaUrl | Out-Null
  Start-Sleep -Seconds 5

  $botaoPeriodo = Wait-Element $driver "//button[contains(@class,'_6YDZS')]"
  $driver.ExecuteScript("arguments[0].click();", $botaoPeriodo) | Out-Null
  Start-Sleep -Seconds 1
  $alvoData = [datetime]::ParseExact($isoDate, 'yyyy-MM-dd', $null)
  $startField = Wait-VisibleElement $driver "//input[@placeholder='Start date']"
  $driver.ExecuteScript(@"
    var el = arguments[0];
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
    el.focus();
    el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
"@, $startField) | Out-Null
  Start-Sleep -Milliseconds 800
  Set-CalendarMonth -driver $driver -alvo $alvoData
  $diaInicio = Wait-VisibleElement $driver "//td[@title='$isoDate']"
  $driver.ExecuteScript("arguments[0].click();", $diaInicio) | Out-Null
  Start-Sleep -Milliseconds 800
  Set-CalendarMonth -driver $driver -alvo $alvoData
  $diaFim = Wait-VisibleElement $driver "//td[@title='$isoDate']"
  $driver.ExecuteScript("arguments[0].click();", $diaFim) | Out-Null
  Start-Sleep -Seconds 5

  $abaClientes = Wait-Element $driver "//*[text()='Clientes']"
  $driver.ExecuteScript("arguments[0].click();", $abaClientes) | Out-Null
  Start-Sleep -Seconds 3

  $elValor = Wait-Element $driver "//h2[contains(text(),'Público médio')]/following-sibling::h3[1]" -TimeoutSec 30
  $limpo = $elValor.Text -replace '[^0-9]', ''
  if (-not $limpo) { return 0 }
  return [int]$limpo
}
function Submit-PublicoDomFallback($token, $date, $publico) {
  $res = Invoke-AppsScript @{ action = 'submitZigPublico'; token = $token; date = $date; publico = $publico; source = 'robo-zigpay-dom-fallback' }
  if (-not $res.ok) { throw "BI recusou o envio do publico (fallback navegador): $($res.error)" }
}

# 10/10, pedido do Renato: "Receita de entrada" (quadro novo em Marketing,
# comparando mes a mes + % clientes x entradas). Fonte: tela "Relatorios de
# Bilheteria" do dashboard (/place/<id>/entrance-reports#boxOfficeBilling) - SO
# por navegador, nunca teve equivalente na API sdkgen (nem a versao bloqueada
# tinha isso). Mensal de proposito (nao diario) - "Bilheteria do periodo" ja
# soma o intervalo inteiro de uma vez, nao precisa acumular dia a dia.
$ZigBilheteriaUrl = "https://dashboard.zigpay.com.br/place/$PlaceId/entrance-reports#boxOfficeBilling"
function Get-BilheteriaForMonth($driver, [int]$ano, [int]$mes) {
  Enter-SeUrl -Driver $driver -Url $ZigBilheteriaUrl | Out-Null
  Start-Sleep -Seconds 5

  $inicioMes = [datetime]::new($ano, $mes, 1)
  $hoje = Get-Date
  $fimMes = $inicioMes.AddMonths(1).AddDays(-1)
  if ($fimMes -gt $hoje) { $fimMes = $hoje.Date }
  $isoInicio = $inicioMes.ToString('yyyy-MM-dd')
  $isoFim = $fimMes.ToString('yyyy-MM-dd')

  $botaoPeriodo = Wait-Element $driver "//button[contains(@class,'_6YDZS')]"
  $driver.ExecuteScript("arguments[0].click();", $botaoPeriodo) | Out-Null
  Start-Sleep -Seconds 1
  $startField = Wait-VisibleElement $driver "//input[@placeholder='Start date']"
  $driver.ExecuteScript(@"
    var el = arguments[0];
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
    el.focus();
    el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
"@, $startField) | Out-Null
  Start-Sleep -Milliseconds 800
  Set-CalendarMonth -driver $driver -alvo $inicioMes
  $diaInicio = Wait-VisibleElement $driver "//td[@title='$isoInicio']"
  $driver.ExecuteScript("arguments[0].click();", $diaInicio) | Out-Null
  Start-Sleep -Milliseconds 800
  Set-CalendarMonth -driver $driver -alvo $fimMes
  $diaFim = Wait-VisibleElement $driver "//td[@title='$isoFim']"
  $driver.ExecuteScript("arguments[0].click();", $diaFim) | Out-Null
  Start-Sleep -Seconds 5

  # "Bilheteria do período" - linha na tabela Nome/Valor da aba padrão
  # (Faturamento de Bilheteria), formato "R$ X.XXX,XX". Confirmado via dump de
  # HTML cru (10/10): o rótulo fica dentro de um <b> aninhado no <td>
  # (<td><b>Bilheteria do período</b></td>) - contains(text(),...) só olha
  # texto DIRETO do nó, não pega texto de filho; contains(.,...) olha o
  # string-value inteiro (inclui descendentes), por isso troca aqui.
  $elReceita = Wait-Element $driver "//tr[td[1][contains(.,'Bilheteria do período')]]/td[2]" -TimeoutSec 20
  $limpoReceita = (($elReceita.Text -replace '[^0-9,]', '') -replace '\.', '') -replace ',', '.'
  $receita = if ($limpoReceita) { [double]$limpoReceita } else { 0.0 }

  # Aba "Entradas vendidas" - linha "Total" da tabela, coluna Quantidade (2ª
  # célula) - soma de TODOS os tipos de entrada do período, já na própria tela.
  # Mesmo achado acima - "Total" também fica num <b> aninhado.
  $abaEntradas = Wait-Element $driver "//button[@aria-label='Entradas vendidas']"
  $driver.ExecuteScript("arguments[0].click();", $abaEntradas) | Out-Null
  Start-Sleep -Seconds 4
  $elQtd = Wait-Element $driver "//tr[td[1][normalize-space(.)='Total']]/td[2]" -TimeoutSec 20
  $limpoQtd = $elQtd.Text -replace '[^0-9]', ''
  $entradasQtd = if ($limpoQtd) { [int]$limpoQtd } else { 0 }

  return @{ receita = $receita; entradasQtd = $entradasQtd }
}
function Submit-Bilheteria($token, $mesKey, $receita, $entradasQtd) {
  $res = Invoke-AppsScript @{ action = 'submitZigBilheteria'; token = $token; mes = $mesKey; receita = $receita; entradasQtd = $entradasQtd; source = 'robo-zigpay' }
  if (-not $res.ok) { throw "BI recusou o envio da bilheteria: $($res.error)" }
}

# Le a lista de itens vendidos (SKU, nome, categoria, quantidade, valor) num
# dia especifico - ver nota no topo do arquivo pra explicacao de por que isso
# ainda precisa de Selenium (API nao devolve SKU/categoria).
# 13/10, achado real: quando essa funcao roda DEPOIS de Get-PublicoFromDate (fallback
# de publico, que navega pra URL de "Business Intelligence" - sidebar diferente, sem
# o item @aria-label='Relatorios' esperado aqui), o clique travava 20s e falhava -
# a captura de faturamento/publico ja tinha funcionado, mas CMV e bilheteria nunca
# rodavam. Navegar pro dashboard de novo aqui garante o ponto de partida certo,
# nao importa de onde o driver estava vindo.
function Get-ProductSalesForDate($driver, [string]$isoDate) {
  Enter-SeUrl -Driver $driver -Url 'https://dashboard.zigpay.com.br/' | Out-Null
  Start-Sleep -Seconds 3
  $menuRelatorios = Wait-Element $driver "//*[@aria-label='Relatórios']"
  $driver.ExecuteScript("arguments[0].click();", $menuRelatorios) | Out-Null
  Start-Sleep -Milliseconds 500
  $menuRelatorioGeral = Wait-Element $driver "//*[text()='Relatório geral']"
  $driver.ExecuteScript("arguments[0].click();", $menuRelatorioGeral) | Out-Null
  Start-Sleep -Seconds 3

  $jaSelecionado = Find-SeElement -Driver $driver -XPath "//p[contains(text(),'$ZigPayLocationFilter')]" -ErrorAction SilentlyContinue
  if (-not $jaSelecionado) {
    $seletor = Wait-Element $driver "//*[contains(text(),'Selecione local')]"
    $driver.ExecuteScript("arguments[0].click();", $seletor) | Out-Null
    $searchInput = Wait-Element $driver "//input[contains(@class,'ant-select-selection-search-input')]"
    $searchInput.SendKeys($ZigPayLocationFilter) | Out-Null
    $opt = Wait-Element $driver "//div[contains(@class,'ant-select-item-option-content')]"
    $driver.ExecuteScript("arguments[0].click();", $opt) | Out-Null
    Start-Sleep -Seconds 1
    $driver.ExecuteScript("document.body.click();") | Out-Null
    Start-Sleep -Seconds 4
  }

  $abaProdutos = Wait-Element $driver "//*[text()='Produtos']"
  $driver.ExecuteScript("arguments[0].click();", $abaProdutos) | Out-Null
  Start-Sleep -Seconds 3

  # 19/10, REVISÃO DO CMV: em vários dias o relatório de produtos voltava com venda de VÁRIOS dias juntos
  # (ex.: qua 02/09 com R$ 107 mil de venda por item contra R$ 1,8 mil de faturamento; sex 16/10 com
  # R$ 37 mil contra R$ 1 mil) — o seletor de período (Start/End date) às vezes termina com início e fim
  # DIFERENTES (o 1o clique cai no campo "fim" e o outro limite fica com a seleção anterior). Agora o
  # robô confere os dois campos depois de escolher o dia e repete a seleção até ficar 1 dia só; se não
  # conseguir, NÃO grava (melhor um dia sem CMV do que um CMV inflado).
  $rangeOk = $false
$jsRange = @'
var a=document.querySelectorAll(".ant-picker-range input, input[placeholder='Start date'], input[placeholder='End date']");
var seen=[],out=[];
Array.prototype.forEach.call(a,function(e){ if(seen.indexOf(e)<0){seen.push(e);out.push(e.value);} });
return JSON.stringify(out);
'@
  for ($tentRange = 1; $tentRange -le 3 -and -not $rangeOk; $tentRange++) {
  $startField = Wait-Element $driver "//input[@placeholder='Start date']"
  $driver.ExecuteScript(@"
    var el = arguments[0];
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
    el.focus();
    el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
"@, $startField) | Out-Null
  Start-Sleep -Seconds 1
  $alvoData = [datetime]::ParseExact($isoDate, 'yyyy-MM-dd', $null)
  Set-CalendarMonth -driver $driver -alvo $alvoData
  $diaInicio = Wait-VisibleElement $driver "//td[@title='$isoDate']"
  $driver.ExecuteScript("arguments[0].click();", $diaInicio) | Out-Null
  Start-Sleep -Milliseconds 800
  Set-CalendarMonth -driver $driver -alvo $alvoData
  $diaFim = Wait-VisibleElement $driver "//td[@title='$isoDate']"
  $driver.ExecuteScript("arguments[0].click();", $diaFim) | Out-Null
  Start-Sleep -Seconds 4
    $valsRange = $null
    $rawRange = ''
    try {
      $rawRange = [string]$driver.ExecuteScript($jsRange)
      # ConvertFrom-Json (PS 5.1) devolve o array como 1 objeto só — extrai os valores por regex
      $valsRange = @([regex]::Matches($rawRange, '"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    } catch { $rawRange = "erro: " + $_.Exception.Message }
    Log ("Periodo do relatorio de produtos de {0} (tentativa {1}): {2}" -f $isoDate, $tentRange, $rawRange)
    if ($valsRange.Count -ge 2) {
      if ($valsRange[0] -and ($valsRange[0] -eq $valsRange[1])) { $rangeOk = $true }
      else { Log ("AVISO: periodo do relatorio de produtos ficou '{0}' ate '{1}' (esperado so {2}) - tentativa {3}/3, repetindo a selecao." -f $valsRange[0], $valsRange[1], $isoDate, $tentRange) }
    } else {
      # nao achou os 2 campos pra conferir - segue como antes, mas avisa no log
      Log ("AVISO: nao consegui conferir o periodo do relatorio de produtos de {0} (campos Start/End nao encontrados)." -f $isoDate)
      $rangeOk = $true
    }
  }
  if (-not $rangeOk) {
    Log ("AVISO: periodo do relatorio de produtos de {0} nao ficou em 1 dia depois de 3 tentativas - CMV desse dia NAO foi gravado (evita dado inflado)." -f $isoDate)
    return @()
  }

  # 10/10, achado: logo depois de escolher a data, a sub-aba que fica ativa por
  # padrao (antes de clicar em "Produtos vendidos por local") pode mostrar "Sem
  # dados" por ser a sub-aba ERRADA pro que queremos ("Produtos por hora", nao
  # "Produtos vendidos por local") - nao significa que o DIA nao teve venda.
  # Checar isso aqui e sair fora cedo demais fazia a funcao devolver @() mesmo em
  # dia com faturamento e produtos reais (confirmado: 09/10 tinha R$ 8.880,30 e 95
  # linhas de produto, mas essa checagem batia antes de clicar na sub-aba certa).
  # Removida de proposito - so a checagem de baixo (depois do clique na sub-aba
  # certa) decide se o dia realmente nao teve venda.
  $subabaLocal = Wait-Element $driver "//*[text()='Produtos vendidos por local']"
  $driver.ExecuteScript("arguments[0].click();", $subabaLocal) | Out-Null
  Start-Sleep -Seconds 4

  $semDados2 = @(Find-SeElement -Driver $driver -XPath "//*[contains(text(),'Sem dados para exibição')]" -ErrorAction SilentlyContinue) | Where-Object { $_.Displayed } | Select-Object -First 1
  if ($semDados2) { return @() }

  if ($env:SJ_DEBUG_PRODUTOS) { try { $driver.PageSource | Set-Content -Path "$DebugDir\produtos_$isoDate.html" -Encoding utf8 } catch {} }
  $html = $driver.PageSource
  $vendas = @()
  $catMatches = [regex]::Matches($html, '<h2 class="QuSKt g28mC SaKax">([^<]+)</h2>')
  for ($i = 0; $i -lt $catMatches.Count; $i++) {
    $categoria = $catMatches[$i].Groups[1].Value
    $inicio = $catMatches[$i].Index
    $fim = if ($i + 1 -lt $catMatches.Count) { $catMatches[$i+1].Index } else { $html.Length }
    $bloco = $html.Substring($inicio, $fim - $inicio)
    $linhaPattern = '<tr data-row-key="(?!total-row)[^"]+"[^>]*>.*?<td class="ant-table-cell">(\d+)</td><td class="ant-table-cell">([^<]*)</td><td class="ant-table-cell">(\d+)</td><td class="ant-table-cell">([^<]*)</td></tr>'
    $linhas = [regex]::Matches($bloco, $linhaPattern)
    foreach ($l in $linhas) {
      $valorTxt = ($l.Groups[4].Value -replace '[^0-9,]', '') -replace '\.', '' -replace ',', '.'
      $vendas += [PSCustomObject]@{
        Categoria  = $categoria
        SKU        = $l.Groups[1].Value
        Nome       = $l.Groups[2].Value
        Quantidade = [int]$l.Groups[3].Value
        ValorTotal = if ($valorTxt) { [double]$valorTxt } else { 0.0 }
      }
    }
  }
  return $vendas
}

function Get-EverestCatalog {
  if (-not (Test-Path $EverestCatalogPath)) { throw "Catalogo Everest nao encontrado em $EverestCatalogPath - rode o build do catalogo antes." }
  $catalogo = @{}
  Import-Csv $EverestCatalogPath | ForEach-Object { $catalogo[$_.Codigo] = $_ }
  return $catalogo
}

function ConvertTo-CultureDouble($texto) {
  $valor = 0.0
  if ([string]::IsNullOrWhiteSpace($texto)) { return $null }
  if ([double]::TryParse($texto, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$valor)) { return $valor }
  return $null
}

function Compute-CmvTeoricoParcial($vendas, $catalogo) {
  $agg = @{
    custoFoodTeorico = 0.0; valorCobertoFood = 0.0; valorTotalFood = 0.0
    custoBevTeorico  = 0.0; valorCobertoBev  = 0.0; valorTotalBev  = 0.0
    valorTotalMisto  = 0.0; itensComFicha = 0; itensSemFicha = 0
  }
  foreach ($v in $vendas) {
    $tipo = $CategoriaTipo[$v.Categoria]
    $ficha = $catalogo[$v.SKU]
    $custoUnit = if ($ficha) { ConvertTo-CultureDouble $ficha.Custo } else { $null }
    if ($tipo -eq 'comida') {
      $agg.valorTotalFood += $v.ValorTotal
      if ($null -ne $custoUnit) { $agg.custoFoodTeorico += $custoUnit * $v.Quantidade; $agg.valorCobertoFood += $v.ValorTotal }
    } elseif ($tipo -eq 'bebida') {
      $agg.valorTotalBev += $v.ValorTotal
      if ($null -ne $custoUnit) { $agg.custoBevTeorico += $custoUnit * $v.Quantidade; $agg.valorCobertoBev += $v.ValorTotal }
    } else {
      $agg.valorTotalMisto += $v.ValorTotal
    }
    if ($null -ne $custoUnit) { $agg.itensComFicha++ } else { $agg.itensSemFicha++ }
  }
  return $agg
}

function Submit-CmvTeoricoParcial($token, $date, $agg) {
  $payload = @{ action = 'submitCmvTeoricoParcial'; token = $token; date = $date; source = 'robo-zigpay' }
  foreach ($k in $agg.Keys) { $payload[$k] = $agg[$k] }
  $res = Invoke-AppsScript $payload
  if (-not $res.ok) { throw "BI recusou o envio do CMV teorico parcial: $($res.error)" }
}

function ConvertTo-ItemSalesPayload($vendas, $catalogo) {
  $porSku = @{}
  foreach ($v in $vendas) {
    $tipo = if ($CategoriaTipo.ContainsKey($v.Categoria)) { $CategoriaTipo[$v.Categoria] } else { 'outro' }
    if (-not $porSku.ContainsKey($v.SKU)) {
      $porSku[$v.SKU] = [PSCustomObject]@{ sku = $v.SKU; nome = $v.Nome; categoria = $v.Categoria; tipo = $tipo; quantidade = 0; valorTotal = 0.0 }
    }
    $porSku[$v.SKU].quantidade += $v.Quantidade
    $porSku[$v.SKU].valorTotal += $v.ValorTotal
  }
  $itens = @()
  foreach ($sku in $porSku.Keys) {
    $it = $porSku[$sku]
    $ficha = $catalogo[$sku]
    $custoUnit = if ($ficha) { ConvertTo-CultureDouble $ficha.Custo } else { $null }
    $itens += [PSCustomObject]@{ sku = $it.sku; nome = $it.nome; categoria = $it.categoria; tipo = $it.tipo; quantidade = $it.quantidade; valorTotal = $it.valorTotal; custoUnit = $custoUnit }
  }
  return $itens
}

function Submit-ItemSales($token, $date, $itens) {
  $payload = @{ action = 'submitZigItemSales'; token = $token; date = $date; items = $itens; source = 'robo-zigpay' }
  $res = Invoke-AppsScript $payload
  if (-not $res.ok) { throw "BI recusou o envio de venda por item: $($res.error)" }
  return $res.count
}

# Le e grava a venda por item + CMV teorico parcial de UM dia (Selenium -
# unica parte que ainda usa navegador). Faturamento/publico/horario NAO
# passam mais por aqui, ver Submit-RevenueAndPublicoForDate/Submit-HourlyForMonth.
function Invoke-DayCmvCapture($driver, $token, [string]$isoDate, [bool]$dryRun) {
  $vendas = Get-ProductSalesForDate -driver $driver -isoDate $isoDate
  if (-not $vendas -or $vendas.Count -eq 0) {
    Log ("Sem venda por item pra {0} (dia sem movimento ou sem dado)." -f $isoDate)
    return
  }
  $catalogo = Get-EverestCatalog
  $agg = Compute-CmvTeoricoParcial -vendas $vendas -catalogo $catalogo
  Log ("CMV teorico PARCIAL para {0}: comida R$ {1:N2} sobre R$ {2:N2} cobertos (de R$ {3:N2}) | bebida R$ {4:N2} sobre R$ {5:N2} cobertos (de R$ {6:N2}) | {7} itens com ficha, {8} sem." -f `
    $isoDate, $agg.custoFoodTeorico, $agg.valorCobertoFood, $agg.valorTotalFood, $agg.custoBevTeorico, $agg.valorCobertoBev, $agg.valorTotalBev, $agg.itensComFicha, $agg.itensSemFicha)
  if ($dryRun) { Log "Dry-run: CMV/venda por item nao enviados pro BI."; return }
  try {
    Submit-CmvTeoricoParcial -token $token -date $isoDate -agg $agg
    Log "CMV teorico parcial enviado pro BI com sucesso."
  } catch {
    Log ("AVISO: falha ao enviar CMV teorico parcial pro BI: " + $_.Exception.Message)
  }
  try {
    $catalogoParaItens = Get-EverestCatalog
    $itens = ConvertTo-ItemSalesPayload -vendas $vendas -catalogo $catalogoParaItens
    $count = Submit-ItemSales -token $token -date $isoDate -itens $itens
    Log ("Venda por item enviada pro BI: $count item(ns) distintos.")
  } catch {
    Log ("AVISO: falha ao enviar venda por item pro BI: " + $_.Exception.Message)
  }
}

# ---------------- Apps Script (BI) ----------------

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

function Get-ExistingZigRevenueDates($token) {
  $res = Invoke-AppsScript @{ action = 'getZigRevenue'; token = $token; limit = 2000 }
  $set = @{}
  if ($res.ok) { foreach ($doc in $res.docs) { $set[$doc.date] = $true } }
  return $set
}
# Separado de proposito de Get-ExistingZigRevenueDates - um dia pode ja ter
# faturamento gravado (ex.: via fallback de navegador) mas ainda nao ter
# publico (ex.: gravado ANTES do achado da tela Business Intelligence BETA,
# 10/10) - sem essa checagem separada, o backfill pula o dia inteiro por ja
# estar "gravado", nunca tenta o publico que ainda falta.
function Get-ExistingZigPublicoDates($token) {
  $res = Invoke-AppsScript @{ action = 'getZigRevenue'; token = $token; limit = 2000 }
  $set = @{}
  if ($res.ok) { foreach ($doc in $res.docs) { if ($null -ne $doc.publico) { $set[$doc.date] = $true } } }
  return $set
}

# ---------------- main ----------------
New-Item -ItemType Directory -Force -Path $DebugDir | Out-Null

try {
  Log "Iniciando robo ZigPay $(if($Discover){'(modo descoberta)'})$(if($DryRun){'(dry-run)'})$(if($BackfillFrom){'(backfill)'})"
  $cred = Get-Credentials

  # --- login ZigPay via API (tentado sempre, mesmo em -Discover) - NAO mata o
  # script se falhar (ver nota "ACHADO 10/10" no topo): $deviceId fica $null e o
  # resto do fluxo cai pro fallback via navegador pra faturamento. So publico e
  # horario por bloco ficam mesmo sem captura enquanto durar o bloqueio.
  $deviceId = $null
  try {
    $deviceId = Get-ZigPayDeviceId $cred
  } catch {
    Log ("AVISO: login via API da ZigPay falhou (" + $_.Exception.Message + ") - faturamento vai cair pro fallback via navegador; publico e horario por bloco ficam SEM captura nessa rodada (sem equivalente fora da API).")
  }

  if ($Discover) {
    if ($deviceId) { Log "Modo descoberta: login via API confirmado. Nada foi enviado pro BI." }
    else { Log "Modo descoberta: login via API FALHOU (ver aviso acima) - so o login via navegador seria testado numa rodada de verdade." }
  } elseif ($BackfillFrom -or $BackfillTo) {
    if (-not $BackfillFrom -or -not $BackfillTo) { throw "Backfill precisa dos dois: -BackfillFrom e -BackfillTo." }
    $d = [datetime]::ParseExact($BackfillFrom, 'yyyy-MM-dd', $null)
    $fim = [datetime]::ParseExact($BackfillTo, 'yyyy-MM-dd', $null)
    if ($d -gt $fim) { throw "-BackfillFrom precisa ser <= -BackfillTo." }
    $totalDias = ($fim - $d).Days + 1
    Log ("Backfill de {0} ate {1} ({2} dia(s)) - faturamento/publico/horario via API (rapido), CMV via Selenium (se nao -SkipCmv)." -f $BackfillFrom, $BackfillTo, $totalDias)

    $token = Get-BiToken -cred $cred
    $jaGravados = Get-ExistingZigRevenueDates -token $token
    Log ("{0} dia(s) ja gravados no BI - pulados nessa rodada." -f $jaGravados.Count)

    # Publico checado SEPARADO de faturamento - um dia pode ter faturamento
    # gravado (ex.: fallback de navegador de uma rodada anterior) sem ainda ter
    # publico (ex.: antes do achado da tela Business Intelligence BETA, 10/10).
    $jaTemPublico = Get-ExistingZigPublicoDates -token $token
    $diasFallbackPublico = @()
    $dAtualPub = $d
    while ($dAtualPub -le $fim) {
      $isoPub = $dAtualPub.ToString('yyyy-MM-dd')
      if (-not $jaTemPublico.ContainsKey($isoPub)) { $diasFallbackPublico += $isoPub }
      $dAtualPub = $dAtualPub.AddDays(1)
    }
    if ($diasFallbackPublico.Count -gt 0) {
      Log ("{0} dia(s) vao ler publico via navegador (Business Intelligence BETA): {1}" -f $diasFallbackPublico.Count, ($diasFallbackPublico -join ', '))
    }

    # --- 1) faturamento + publico + horario, via API, mes a mes (rapido) - so se
    # o login no topo deu certo. Mes cuja chamada falhar entra em
    # $diasFallbackRevenue (lido via navegador no passo 2, publico/horario
    # ficam SEM captura pra esses dias - sem equivalente fora da API). ---
    $diasFallbackRevenue = @()
    if ($deviceId) {
      $mesInicio = [datetime]::new($d.Year, $d.Month, 1)
      $mesFim = [datetime]::new($fim.Year, $fim.Month, 1)
      $mAtual = $mesInicio
      while ($mAtual -le $mesFim) {
        $chaveMes = $mAtual.ToString('yyyy-MM')
        $diaDoMes = [datetime]::new($mAtual.Year, $mAtual.Month, 1)
        $ultimoDiaMes = $diaDoMes.AddMonths(1).AddDays(-1)
        try {
          Log ("Lendo eventos de {0} via API..." -f $chaveMes)
          $eventsResult = Get-EventsForMonth -deviceId $deviceId -year $mAtual.Year -month $mAtual.Month
          $porData = Group-EventsByDate $eventsResult
          Log ("  {0} evento(s) no mes, totalIncome R$ {1:N2}." -f @($eventsResult.events).Count, ($eventsResult.totalIncome/100))
          while ($diaDoMes -le $ultimoDiaMes) {
            if ($diaDoMes -ge $d -and $diaDoMes -le $fim) {
              $iso = $diaDoMes.ToString('yyyy-MM-dd')
              if (-not $jaGravados.ContainsKey($iso)) {
                Submit-RevenueAndPublicoForDate -token $token -porData $porData -isoDate $iso -dryRun:$DryRun
              }
            }
            $diaDoMes = $diaDoMes.AddDays(1)
          }
          Submit-HourlyForMonth -token $token -deviceId $deviceId -eventsResult $eventsResult -dryRun:$DryRun
        } catch {
          Log ("AVISO: API falhou pro mes {0} ({1}) - faturamento desse mes vai cair pro fallback via navegador (publico/horario ficam sem captura)." -f $chaveMes, $_.Exception.Message)
          while ($diaDoMes -le $ultimoDiaMes) {
            if ($diaDoMes -ge $d -and $diaDoMes -le $fim) {
              $iso = $diaDoMes.ToString('yyyy-MM-dd')
              if (-not $jaGravados.ContainsKey($iso)) { $diasFallbackRevenue += $iso }
            }
            $diaDoMes = $diaDoMes.AddDays(1)
          }
        }
        $mAtual = $mAtual.AddMonths(1)
      }
    } else {
      # login via API ja tinha falhado no topo - todo o intervalo pedido cai
      # pro fallback (menos o que ja estava gravado).
      $dAtual2 = $d
      while ($dAtual2 -le $fim) {
        $iso = $dAtual2.ToString('yyyy-MM-dd')
        if (-not $jaGravados.ContainsKey($iso)) { $diasFallbackRevenue += $iso }
        $dAtual2 = $dAtual2.AddDays(1)
      }
    }
    if ($diasFallbackRevenue.Count -gt 0) {
      Log ("{0} dia(s) vao ler faturamento via navegador (fallback): {1}" -f $diasFallbackRevenue.Count, ($diasFallbackRevenue -join ', '))
    }

    # --- 2) CMV/venda por item (Selenium) + fallback de faturamento via navegador
    # pros dias de $diasFallbackRevenue, mesma sessao por dia ---
    if (-not $SkipCmv -or $diasFallbackRevenue.Count -gt 0) {
      Log "Iniciando parte via navegador (CMV e/ou fallback de faturamento) do backfill..."
      Import-Module Selenium
      $pidsChromeAntes = @((Get-Process chrome, chromedriver -ErrorAction SilentlyContinue).Id)
      $driverDir = Get-MatchingChromeDriver
      $driver = $null
      $ok = 0; $falhou = 0
      $dAtual = $d
      try {
        while ($dAtual -le $fim) {
          $iso = $dAtual.ToString('yyyy-MM-dd')
          $precisaFallbackRevenue = $diasFallbackRevenue -contains $iso
          $precisaFallbackPublico = $diasFallbackPublico -contains $iso
          if (-not $SkipCmv -or $precisaFallbackRevenue -or $precisaFallbackPublico) {
            try {
              # sessao nova a cada dia - degradacao acumulada da SPA da ZigPay
              # ja documentada, mesmo padrao de sempre pra essa parte.
              if ($driver) { Close-ZigPaySession -driver $driver -pidsAntes $pidsChromeAntes }
              $driver = New-ZigPaySession -cred $cred -driverDir $driverDir -pidsAntes $pidsChromeAntes
              if ($precisaFallbackRevenue) {
                $revenueDom = Get-RevenueFromDate -driver $driver -isoDate $iso
                Log ("Faturamento (navegador, fallback) para {0}: R$ {1:N2}" -f $iso, $revenueDom)
                if (-not $DryRun) { Submit-RevenueDomFallback -token $token -date $iso -revenue $revenueDom }
              }
              if ($precisaFallbackPublico) {
                try {
                  $publicoDom = Get-PublicoFromDate -driver $driver -isoDate $iso
                  Log ("Publico (navegador, fallback via Business Intelligence BETA) para {0}: {1} pessoas" -f $iso, $publicoDom)
                  if (-not $DryRun) { Submit-PublicoDomFallback -token $token -date $iso -publico $publicoDom }
                } catch {
                  Log ("AVISO: falha ao ler publico via Business Intelligence BETA pra {0}: {1}" -f $iso, $_.Exception.Message)
                }
              }
              if (-not $SkipCmv) { Invoke-DayCmvCapture -driver $driver -token $token -isoDate $iso -dryRun:$DryRun }
              $ok++
            } catch {
              $falhou++
              if ($_.Exception.Message -match 'invalid session id|session deleted|chrome not reachable|disconnected') {
                Log ("ERRO em {0}: sessao do Chrome morreu ({1}) - abortando o resto." -f $iso, $_.Exception.Message)
                break
              }
              Log ("ERRO em {0}: {1} - seguindo pro proximo dia." -f $iso, $_.Exception.Message)
            }
          }
          $dAtual = $dAtual.AddDays(1)
        }
      } finally {
        if ($driver) { Close-ZigPaySession -driver $driver -pidsAntes $pidsChromeAntes }
      }
      Log ("Parte via navegador concluida: {0} dia(s) ok, {1} falharam." -f $ok, $falhou)
    } else {
      Log "SkipCmv e nada de fallback pendente: pulando a parte via navegador inteiramente."
    }
    Log "Backfill concluido."
  } else {
    # roda de manha (8h) para gravar o faturamento do dia ANTERIOR, ja fechado.
    $ontem = (Get-Date).AddDays(-1)
    $ontemIso = $ontem.ToString('yyyy-MM-dd')
    $token = if (-not $DryRun) { Get-BiToken -cred $cred } else { $null }

    # --- faturamento + publico + horario do mes (API, se o login no topo deu certo) ---
    $apiDisponivel = $false
    if ($deviceId) {
      try {
        $eventsResult = Get-EventsForMonth -deviceId $deviceId -year $ontem.Year -month $ontem.Month
        $porData = Group-EventsByDate $eventsResult
        Submit-RevenueAndPublicoForDate -token $token -porData $porData -isoDate $ontemIso -dryRun:$DryRun
        Submit-HourlyForMonth -token $token -deviceId $deviceId -eventsResult $eventsResult -dryRun:$DryRun
        $apiDisponivel = $true
      } catch {
        Log ("AVISO: API da ZigPay falhou ao buscar eventos do mes (" + $_.Exception.Message + ") - faturamento vai cair pro fallback via navegador.")
      }
    }

    # --- CMV/venda por item de ontem + bilheteria do mes corrente (Selenium) +
    # fallback de faturamento/publico via navegador quando a API falhou acima
    # (mesma sessao pras 4 coisas, evita abrir Chrome varias vezes) ---
    if (-not $SkipCmv -or -not $apiDisponivel -or -not $SkipBilheteria) {
      Import-Module Selenium
      $pidsChromeAntes = @((Get-Process chrome, chromedriver -ErrorAction SilentlyContinue).Id)
      $driverDir = Get-MatchingChromeDriver
      $driver = New-ZigPaySession -cred $cred -driverDir $driverDir -pidsAntes $pidsChromeAntes
      try {
        if (-not $apiDisponivel) {
          try {
            $revenueDom = Get-RevenueFromDate -driver $driver -isoDate $ontemIso
            Log ("Faturamento (navegador, fallback) para {0}: R$ {1:N2}" -f $ontemIso, $revenueDom)
            if (-not $DryRun) { Submit-RevenueDomFallback -token $token -date $ontemIso -revenue $revenueDom }
            try {
              $publicoDom = Get-PublicoFromDate -driver $driver -isoDate $ontemIso
              Log ("Publico (navegador, fallback via Business Intelligence BETA) para {0}: {1} pessoas" -f $ontemIso, $publicoDom)
              if (-not $DryRun) { Submit-PublicoDomFallback -token $token -date $ontemIso -publico $publicoDom }
            } catch {
              Log ("AVISO: falha ao ler publico via Business Intelligence BETA pra {0}: {1}" -f $ontemIso, $_.Exception.Message)
            }
          } catch {
            Log ("ERRO: fallback de faturamento via navegador tambem falhou pra {0}: {1}" -f $ontemIso, $_.Exception.Message)
          }
        }
        if (-not $SkipCmv) {
          Invoke-DayCmvCapture -driver $driver -token $token -isoDate $ontemIso -dryRun:$DryRun
        }
        if (-not $SkipBilheteria) {
          try {
            $mesAtualBilheteria = $ontem.ToString('yyyy-MM')
            $bilheteria = Get-BilheteriaForMonth -driver $driver -ano $ontem.Year -mes $ontem.Month
            Log ("Bilheteria do mes {0}: R$ {1:N2} | {2} entrada(s) vendida(s)" -f $mesAtualBilheteria, $bilheteria.receita, $bilheteria.entradasQtd)
            if (-not $DryRun) { Submit-Bilheteria -token $token -mesKey $mesAtualBilheteria -receita $bilheteria.receita -entradasQtd $bilheteria.entradasQtd }
          } catch {
            Log ("AVISO: falha ao ler bilheteria do mes: " + $_.Exception.Message)
          }
        }
      } finally {
        Close-ZigPaySession -driver $driver -pidsAntes $pidsChromeAntes
      }
    } else {
      Log "SkipCmv+SkipBilheteria: nao abriu navegador nenhuma vez nessa execucao."
    }

    # --- detalhe por horario de ontem (comida/bebida/entradas, escala por setor) - script proprio;
    # falha aqui nao derruba o resto da rodada ---
    if (-not $DryRun) {
      try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File "$ScriptDir\robo_zigpay_detalhe.ps1" -From $ontemIso -To $ontemIso
      } catch {
        Log ("AVISO: detalhe por horario falhou: " + $_.Exception.Message)
      }
    }
  }
} catch {
  Log ("ERRO: " + $_.Exception.Message)
  exit 1
}
