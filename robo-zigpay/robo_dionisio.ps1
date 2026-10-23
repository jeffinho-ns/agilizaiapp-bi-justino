<#
  Robo Dionisio CRM -> BI (reservas sem dados pessoais + funil do relatorio)
  Roda 3x ao dia (10h, 15h e 18h) pelo Agendador de Tarefas do Windows (ver agendar_robo_dionisio.ps1).

  O que faz:
    1. Abre o Dionisio CRM (https://dionisio-crm.web.app) em Chrome SEM janela, usando o perfil proprio do robo
       (~\.seujustino\chrome-profile-crm), onde o Renato entrou UMA vez a mao (login_manual_dionisio.ps1).
    2. Historico de Reservas > "Ultimo Ano" > "Exportar Excel" -> le a planilha (100% das reservas) e manda pro BI
       SO os campos sem dado pessoal (sem nome, telefone, e-mail, CPF nem observacao) -> acao submitCrmReservas.
    3. Relatorios (abas Vendas e Operacao): le o funil da IA, origem das sessoes, resolucao autonoma, handoff,
       comparecimento etc. -> acao submitCrmFunil.
    4. Se a sessao do CRM tiver vencido, cria o arquivo "DIONISIO - ROBO PRECISA DE LOGIN.txt" na Area de Trabalho.
  So LE dados do CRM: nao envia mensagem, nao altera reserva, nao clica em nada que grave.
  USO:  powershell -File robo_dionisio.ps1            (normal)
        powershell -File robo_dionisio.ps1 -DryRun    (le tudo, mostra os numeros e NAO envia pro BI)
#>
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$CredPath = "$env:USERPROFILE\.seujustino\zigpay_credentials.json"   # so o campo "bi" (login do robo no BI)
$LogPath = "$ScriptDir\robo_dionisio.log"
$DriverCacheDir = "$ScriptDir\chromedriver-cache"
$ProfileDir = "$env:USERPROFILE\.seujustino\chrome-profile-crm"
$DlDir = Join-Path $env:TEMP 'dionisio_dl'
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'
$CrmBase = 'https://dionisio-crm.web.app/home'
$AvisoLoginPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DIONISIO - ROBO PRECISA DE LOGIN.txt'

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
      $msg = "O robo do Dionisio CRM nao conseguiu entrar em " + (Get-Date -Format 'dd/MM/yyyy HH:mm') + ".`r`nA sessao do CRM venceu. O BI (aba Reservas) fica sem atualizar ate resolver.`r`n`r`nComo resolver: abra a pasta robo-zigpay, rode login_manual_dionisio.ps1 (botao direito > Executar com PowerShell), entre no CRM, espere a tela de conversas/relatorios abrir e FECHE o Chrome.`r`nEste arquivo some sozinho quando o robo voltar a entrar."
      Set-Content -Path $AvisoLoginPath -Value $msg -Encoding UTF8
    } elseif (Test-Path $AvisoLoginPath) { Remove-Item $AvisoLoginPath -Force }
  } catch {}
}

# --- funcoes copiadas do robo_zigpay.ps1 (Get-MatchingChromeDriver / Invoke-AppsScript / Get-BiToken) ---

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

function Read-ZipText($entry) {
  $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
}
function Get-ColIndex([string]$ref) {
  $letters = ($ref -replace '[^A-Z]', ''); $n = 0
  foreach ($ch in $letters.ToCharArray()) { $n = $n * 26 + ([int]$ch - 64) }
  return $n - 1
}
function Read-XlsxRows([string]$path) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  try {
    $ss = @()
    $e = $zip.GetEntry('xl/sharedStrings.xml')
    if ($e) { $x = [xml](Read-ZipText $e); foreach ($si in $x.sst.si) { $ss += [string]$si.InnerText } }
    $e = $zip.GetEntry('xl/worksheets/sheet1.xml')
    if (-not $e) { throw 'Planilha sem sheet1.xml' }
    $x = [xml](Read-ZipText $e)
    $rows = New-Object System.Collections.ArrayList
    foreach ($row in $x.worksheet.sheetData.row) {
      $vals = @{}; $max = -1
      foreach ($c in $row.c) {
        $i = Get-ColIndex ([string]$c.r)
        if ($c.t -eq 'inlineStr') { $v = [string]$c.is.InnerText }
        elseif ($c.t -eq 's') { $v = $ss[[int]$c.v] }
        else { $v = [string]$c.v }
        $vals[$i] = $v; if ($i -gt $max) { $max = $i }
      }
      if ($max -ge 0) {
        $arr = New-Object 'string[]' ($max + 1)
        foreach ($k in $vals.Keys) { $arr[$k] = $vals[$k] }
        [void]$rows.Add($arr)
      }
    }
    return ,$rows
  } finally { $zip.Dispose() }
}

function ConvertTo-IsoDate([string]$br) {   # dd/MM/yyyy -> yyyy-MM-dd
  if ($br -match '^(\d{1,2})/(\d{1,2})/(\d{4})') { return ('{0}-{1:00}-{2:00}' -f $Matches[3], [int]$Matches[2], [int]$Matches[1]) }
  return ''
}
function ConvertTo-HoraNum([string]$hhmm) {   # 19:30 -> 1930
  if ($hhmm -match '^(\d{1,2}):(\d{2})') { return ([int]$Matches[1] * 100 + [int]$Matches[2]) }
  return $null
}

# So estes campos seguem pro BI. Nome, telefone, e-mail, CPF, nascimento, descricao e mesa NAO saem do computador.
function ConvertTo-ReservasBi($rows) {
  $h = @{}; for ($i = 0; $i -lt $rows[0].Count; $i++) { $h[[string]$rows[0][$i]] = $i }
  foreach ($n in 'ID', 'Status', 'Data', 'Hora Início', 'Área', 'Total Pessoas', 'Motivo', 'Origem', 'Criado em', 'Atendido por IA', 'Criado por IA') {
    if (-not $h.ContainsKey($n)) { throw "Coluna '$n' nao existe na planilha do CRM (layout mudou?). Colunas: $($h.Keys -join ', ')" }
  }
  $get = { param($r, $n) $i = $h[$n]; if ($i -lt $r.Count -and $r[$i]) { return ([string]$r[$i]).Trim() } else { return '' } }
  $out = New-Object System.Collections.ArrayList
  for ($k = 1; $k -lt $rows.Count; $k++) {
    $r = $rows[$k]
    $id = & $get $r 'ID'; if (-not $id) { continue }
    $criado = & $get $r 'Criado em'
    $criadoHora = $null; if ($criado -match ',\s*(\d{1,2}):') { $criadoHora = [int]$Matches[1] }
    $motivo = & $get $r 'Motivo'; if ($motivo -eq 'N/A') { $motivo = '' }
    $area = & $get $r 'Área'; if ($area -eq 'N/A') { $area = '' }
    $pes = 0; [void][int]::TryParse((& $get $r 'Total Pessoas'), [ref]$pes)
    [void]$out.Add(@{
      id = $id; data = (ConvertTo-IsoDate (& $get $r 'Data')); hora = (ConvertTo-HoraNum (& $get $r 'Hora Início'))
      status = (& $get $r 'Status'); area = $area; pessoas = $pes; motivo = $motivo; origem = (& $get $r 'Origem')
      criadoData = (ConvertTo-IsoDate $criado); criadoHora = $criadoHora
      atendidoIA = $(if ((& $get $r 'Atendido por IA') -eq 'Sim') { 1 } else { 0 }); criadoIA = $(if ((& $get $r 'Criado por IA') -eq 'Sim') { 1 } else { 0 })
    })
  }
  return ,$out
}

# ---------------- funil (texto da tela de Relatorios) ----------------
function ConvertTo-Cnt([string]$s) { $d = ($s -replace '[^\d]', ''); if ($d) { return [int]$d } else { return $null } }
function ConvertTo-Pct([string]$s) {
  if (-not $s) { return $null }
  return [double]::Parse(($s -replace ',', '.' -replace '[^\d.\-]', ''), [System.Globalization.CultureInfo]::InvariantCulture)
}
function Find-Group([string]$texto, [string]$padrao) { $m = [regex]::Match($texto, $padrao); if ($m.Success) { return $m.Groups[1].Value } else { return '' } }

function Read-FunilTexto([string]$vendas, [string]$oper) {
  $v = $vendas -replace "`r", ''; $o = $oper -replace "`r", ''
  $f = [ordered]@{}
  $f.periodo = ((Find-Group $v '(\d{2}/\d{2}/\d{4}\s*-\s*\d{2}/\d{2}/\d{4})') -replace '\s', '')
  $f.conversas = ConvertTo-Cnt (Find-Group $v 'Conversas iniciadas\s*\n\s*([\d.]+)')
  $f.duvida = ConvertTo-Cnt (Find-Group $v 'Tiraram d[^\n]*\n\s*([\d.]+)')
  $f.inicio = ConvertTo-Cnt (Find-Group $v 'Começaram pedido ou reserva\s*\n\s*([\d.]+)')
  $f.finalizaram = ConvertTo-Cnt (Find-Group $v 'Finalizaram e pagaram\s*\n\s*([\d.]+)')
  $f.reservasFunil = ConvertTo-Cnt (Find-Group $v 'Reservas\s+(\d+)\s*\n')
  $f.reservasVar = ConvertTo-Pct (Find-Group $v 'Reservas\s+\d+\s*\n\s*([\-+]?[\d.,]+)\s*%')
  $f.receita = ConvertTo-Pct ((Find-Group $v 'Receita Gerada[^\n]*\n\s*R\$\s*([\d.,]+)') -replace '\.', '')
  $f.comparecimentoPct = ConvertTo-Pct (Find-Group $v '([\d.]+)\s*%\s*\n\s*comparecimento')
  $f.totalReservas = ConvertTo-Cnt (Find-Group $v 'Total de Reservas\s*\n\s*(\d+)')
  $f.noShows = ConvertTo-Cnt (Find-Group $v 'No-shows\s*\n\s*(\d+)')
  $f.canceladas = ConvertTo-Cnt (Find-Group $v 'Canceladas\s*\n\s*(\d+)')
  $f.porIAPct = ConvertTo-Pct (Find-Group $v 'Via IA\s*\n\s*([\d.]+)\s*%')
  $f.resolucaoPct = ConvertTo-Pct (Find-Group $o 'Taxa de Resolução Autônoma\s*\n\s*([\d.]+)\s*%')
  $f.atendimentosIA = ConvertTo-Cnt (Find-Group $o '(\d[\d.]*)\s+atendimentos pela IA')
  $f.handoff = ConvertTo-Cnt (Find-Group $o 'Encaminhados para Humano\s*\n\s*([\d.]+)')
  $f.handoffPct = ConvertTo-Pct (Find-Group $o '([\d.]+)\s*%\s+das conversas')
  $f.sessoes = ConvertTo-Cnt (Find-Group $o '([\d.]+)\s*\n\s*Sessões no período')
  $f.sessoesVar = ConvertTo-Pct (Find-Group $o 'Sessões no período\s*\n\s*([\-+]?[\d.,]+)\s*%')
  $f.metaAds = ConvertTo-Cnt (Find-Group $o 'Meta Ads\s*\n\s*([\d.]+)\s*\(')
  $f.whatsapp = ConvertTo-Cnt (Find-Group $o 'WhatsApp Org[^\n]*\n\s*([\d.]+)\s*\(')
  $f.instagram = ConvertTo-Cnt (Find-Group $o 'Instagram Org[^\n]*\n\s*([\d.]+)\s*\(')
  return $f
}

# ---------------- navegador ----------------
function Set-DownloadPrefs {
  $prefPath = "$ProfileDir\Default\Preferences"
  if (-not (Test-Path $prefPath)) { return }
  $pj = Get-Content $prefPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $pj.download) { $pj | Add-Member -NotePropertyName download -NotePropertyValue (@{}) -Force }
  $pj.download = @{ default_directory = $DlDir; prompt_for_download = $false; directory_upgrade = $true }
  if (-not $pj.savefile) { $pj | Add-Member -NotePropertyName savefile -NotePropertyValue (@{}) -Force }
  $pj.savefile = @{ default_directory = $DlDir }
  ($pj | ConvertTo-Json -Depth 30 -Compress) | Set-Content $prefPath -Encoding UTF8
}
function Stop-CrmChrome {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chromedriver.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*chrome-profile-crm*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Close-Overlays($drv) {
  $drv.ExecuteScript("var b=document.querySelector('.driver-popover-close-btn');if(b)b.click();document.body.classList.remove('driver-active');document.querySelectorAll('[class*=driver]').forEach(function(e){if(e!==document.body)e.remove()});return 1") | Out-Null
}
function Get-PageText($drv) { return [string]$drv.ExecuteScript("var p=document.querySelector('.q-page')||document.body;return p.innerText||''") }

function Export-ReservasExcel($drv) {
  New-Item -ItemType Directory -Force -Path $DlDir | Out-Null
  Get-ChildItem $DlDir -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Enter-SeUrl -Driver $drv -Url "$CrmBase/reservations-history" | Out-Null
  Start-Sleep -Seconds 12
  if ($drv.Url -like '*login*' -or $drv.Url -like '*auth*') { Set-AvisoLogin $true; throw 'Sessao do CRM vencida (tela de login).' }
  Set-AvisoLogin $false
  Close-Overlays $drv
  $achou = $drv.ExecuteScript("var b=[...document.querySelectorAll('button')].filter(function(x){return x.innerText.trim()==='Último Ano'})[0];if(b){b.click();return true}return false")
  if (-not $achou) { throw "Botao 'Ultimo Ano' nao encontrado (layout do CRM mudou?)." }
  Start-Sleep -Seconds 12
  $achou = $drv.ExecuteScript("var b=[...document.querySelectorAll('button')].filter(function(x){return /Exportar Excel/.test(x.innerText)})[0];if(b){b.click();return true}return false")
  if (-not $achou) { throw "Botao 'Exportar Excel' nao encontrado." }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $f = Get-ChildItem $DlDir -Filter '*.xlsx' -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 } | Select-Object -First 1
    if ($f -and -not (Get-ChildItem $DlDir -Filter '*.crdownload' -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1; return $f.FullName }
  }
  throw 'A planilha de reservas nao foi baixada em 2 minutos.'
}

function Read-RelatoriosTextos($drv) {
  Enter-SeUrl -Driver $drv -Url "$CrmBase/reports" | Out-Null
  Start-Sleep -Seconds 14
  Close-Overlays $drv
  $vendas = Get-PageText $drv
  $oper = ''
  for ($t = 1; $t -le 3 -and -not ($oper -match 'Taxa de Resolu[^
]*
\s*[\d.]+\s*%'); $t++) {
    $tab = Find-SeElement -Driver $drv -XPath "//div[contains(concat(' ',normalize-space(@class),' '),' q-tab ') and contains(normalize-space(.),'Operação')]" -ErrorAction SilentlyContinue
    if ($tab) { try { @($tab)[0].Click() } catch { Log ("AVISO: clique na aba Operacao falhou: " + $_.Exception.Message) } }
    # os numeros aparecem depois do rotulo: espera ate 45 s por "Taxa de Resolucao ... 87.6%" e "Encaminhados ... 528"
    for ($w = 0; $w -lt 9; $w++) {
      Start-Sleep -Seconds 5
      $oper = Get-PageText $drv
      if (($oper -match 'Taxa de Resolu[^
]*
\s*[\d.]+\s*%') -and ($oper -match 'Encaminhados para Humano\s*
\s*[\d.]+') -and ($oper -match 'Sess[^
]*o no per')) { break }
    }
  }
  return @{ vendas = $vendas; oper = $oper }
}

# ---------------- principal ----------------
try {
  Log "Iniciando robo Dionisio CRM $(if($DryRun){'(dry-run)'})"
  $cred = Get-Credentials
  Stop-CrmChrome
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  Set-DownloadPrefs
  Import-Module Selenium
  $pidsAntes = @((Get-Process chrome, chromedriver -ErrorAction SilentlyContinue).Id)
  $driverDir = Get-MatchingChromeDriver
  $drv = Start-SeChrome -Headless -Quiet -BinaryPath "C:\Program Files\Google\Chrome\Application\chrome.exe" -WebDriverDirectory $driverDir -Arguments @('--window-size=1500,1100', "--user-data-dir=$ProfileDir")
  $falhou = $false
  $linhas = $null; $funil = $null
  try {
    try {
      $xlsx = Export-ReservasExcel $drv
      $rows = Read-XlsxRows $xlsx
      $linhas = ConvertTo-ReservasBi $rows
      Log ("Planilha de reservas lida: {0} reservas (campos sem dado pessoal)." -f $linhas.Count)
      Remove-Item $xlsx -Force -ErrorAction SilentlyContinue
    } catch { $falhou = $true; Log ("ERRO reservas: " + $_.Exception.Message) }
    try {
      $tx = Read-RelatoriosTextos $drv
      $funil = Read-FunilTexto $tx.vendas $tx.oper
      Log ("Funil: conversas {0} | duvida {1} | inicio {2} | finalizaram {3} | sessoes {4} | resolucao {5}% | handoff {6}" -f $funil.conversas, $funil.duvida, $funil.inicio, $funil.finalizaram, $funil.sessoes, $funil.resolucaoPct, $funil.handoff)
      if (-not $funil.conversas -or -not $funil.sessoes) { throw "Funil incompleto (conversas/sessoes nao lidas) - layout do relatorio mudou?" }
    } catch { $falhou = $true; $funil = $null; Log ("ERRO funil: " + $_.Exception.Message) }
  } finally {
    try { Stop-SeDriver -Driver $drv } catch {}
    Get-Process chrome, chromedriver -ErrorAction SilentlyContinue | Where-Object { $pidsAntes -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  }

  if (-not $DryRun -and ($linhas -or $funil)) {
    $token = Get-BiToken $cred
    if ($linhas -and $linhas.Count -gt 0) {
      $tam = 150; $tot = 0
      for ($i = 0; $i -lt $linhas.Count; $i += $tam) {
        $fim = [math]::Min($i + $tam, $linhas.Count) - 1
        $res = Invoke-AppsScript @{ action = 'submitCrmReservas'; token = $token; rows = @($linhas[$i..$fim]) }
        if (-not $res.ok) { throw "BI recusou as reservas: $($res.error) $($res.code)" }
        $tot = $res.total
      }
      Log "Reservas enviadas pro BI (total na planilha do BI: $tot)."
    }
    if ($funil) {
      $res = Invoke-AppsScript @{ action = 'submitCrmFunil'; token = $token; funil = $funil }
      if (-not $res.ok) { throw "BI recusou o funil: $($res.error) $($res.code)" }
      Log "Funil enviado pro BI."
    }
  } elseif ($DryRun) { Log "Dry-run: nada foi enviado ao BI." }
  if ($falhou) { exit 1 }
  Log "Concluido."
} catch {
  Log ("ERRO: " + $_.Exception.Message)
  exit 1
}
