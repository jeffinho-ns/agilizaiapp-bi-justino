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


# ---------------- configuracao e saude do atendimento (so leitura; 23/10) ----------------
# Le as telas de configuracao da IA do Dionisio e o SAC e manda pro BI so numeros/estados (nada de conversa nem dado de cliente).
function Open-CrmPage($drv, [string]$path, [int]$espera = 11) {
  Enter-SeUrl -Driver $drv -Url "$CrmBase/$path" | Out-Null
  Start-Sleep -Seconds $espera
  Close-Overlays $drv
}
function Click-CrmText($drv, [string]$texto) {
  $el = Find-SeElement -Driver $drv -XPath "//*[normalize-space(text())='$texto']" -ErrorAction SilentlyContinue
  if ($el) { try { @($el)[0].Click(); return $true } catch { return $false } }
  return $false
}
function Get-SwitchByLabel($drv, [string]$rotulo) {
  # estado (true/false/null) do interruptor que fica no mesmo bloco do rotulo
  $js = "var l=[...document.querySelectorAll('*')].filter(function(x){return x.children.length===0&&(x.innerText||'').trim()===arguments[0]})[0];if(!l)return null;var p=l;for(var i=0;i<6&&p;i++){var s=p.querySelector('[role=switch]');if(s)return s.getAttribute('aria-checked')==='true';p=p.parentElement}return null"
  return $drv.ExecuteScript($js, $rotulo)
}
function Read-HistoricoIA([string]$texto) {
  $ev = New-Object System.Collections.ArrayList
  $ms = [regex]::Matches($texto, '(\d{2})/(\d{2})/(\d{4}),\s+(\d{2}):(\d{2}):\d{2}:\d{3}\s+(.+?)\s+(editou a configuração|desativou a IA|ativou a IA)([^\n]*)')
  foreach ($m in $ms) {
    $resto = $m.Groups[8].Value
    $canal = ''; if ($resto -match 'WhatsApp') { $canal = 'WhatsApp' } elseif ($resto -match 'Instagram') { $canal = 'Instagram' }
    [void]$ev.Add(@{
      data = ('{0}-{1}-{2}' -f $m.Groups[3].Value, $m.Groups[2].Value, $m.Groups[1].Value)
      hora = ('{0}:{1}' -f $m.Groups[4].Value, $m.Groups[5].Value)
      quem = ($m.Groups[6].Value.Trim().Split(' ')[0])
      acao = $m.Groups[7].Value
      canal = $canal
    })
  }
  return ,$ev
}

function Read-SacMetricas($drv) {
  New-Item -ItemType Directory -Force -Path $DlDir | Out-Null
  Get-ChildItem $DlDir -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Open-CrmPage $drv 'sac' 13
  $achou = $drv.ExecuteScript("var b=[...document.querySelectorAll('button')].filter(function(x){return /Exportar Excel/.test(x.innerText)})[0];if(b){b.click();return true}return false")
  if (-not $achou) { throw "Botao Exportar Excel do SAC nao encontrado." }
  $xlsx = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $f = Get-ChildItem $DlDir -Filter '*.xlsx' -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 } | Select-Object -First 1
    if ($f -and -not (Get-ChildItem $DlDir -Filter '*.crdownload' -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1; $xlsx = $f.FullName; break }
  }
  if (-not $xlsx) { throw 'Planilha do SAC nao foi baixada.' }
  $rows = Read-XlsxRows $xlsx
  Remove-Item $xlsx -Force -ErrorAction SilentlyContinue
  $h = @{}; for ($i = 0; $i -lt $rows[0].Count; $i++) { $h[[string]$rows[0][$i]] = $i }
  foreach ($n in 'Conversa', 'Começo', 'Término', 'Ativo') { if (-not $h.ContainsKey($n)) { throw "Coluna '$n' nao existe na planilha do SAC." } }
  $cult = [System.Globalization.CultureInfo]::GetCultureInfo('pt-BR')
  $agora = Get-Date
  $tot = 0; $ativos = 0; $ativos24 = 0; $durs = New-Object System.Collections.ArrayList
  $fins = @{}; $porConv = @{}; $inis = New-Object System.Collections.ArrayList
  for ($k = 1; $k -lt $rows.Count; $k++) {
    $r = $rows[$k]; $tot++
    $ini = $null; $fim = $null
    [void][datetime]::TryParseExact([string]$r[$h['Começo']], 'dd/MM/yyyy, HH:mm', $cult, 'None', [ref]$ini)
    [void][datetime]::TryParseExact([string]$r[$h['Término']], 'dd/MM/yyyy, HH:mm', $cult, 'None', [ref]$fim)
    $conv = [string]$r[$h['Conversa']]
    if ($ini) { [void]$inis.Add(@{ c = $conv; t = $ini }) }
    if ($ini -and $fim) {
      [void]$durs.Add(($fim - $ini).TotalMinutes)
      $key = $fim.ToString('yyyyMMddHHmm'); if ($fins.ContainsKey($key)) { $fins[$key]++ } else { $fins[$key] = 1 }
    } else {
      $ativos++
      if ($ini -and (($agora - $ini).TotalHours -gt 24)) { $ativos24++ }
    }
    if ($porConv.ContainsKey($conv)) { $porConv[$conv]++ } else { $porConv[$conv] = 1 }
  }
  $enc = $durs.Count
  $emLote = 0; foreach ($v in $fins.Values) { if ($v -ge 5) { $emLote += $v } }
  $med = $null
  if ($enc -gt 0) { $s = @($durs | Sort-Object); $med = [math]::Round($s[[int][math]::Floor(($enc - 1) / 2)], 0) }
  # reaberturas: mesma conversa abrindo outro atendimento em menos de 24 h
  $reab = 0; $reab24 = 0
  foreach ($g in ($inis | Group-Object { $_.c })) {
    $ts = @($g.Group | ForEach-Object { $_.t } | Sort-Object)
    for ($i = 1; $i -lt $ts.Count; $i++) { $reab++; if (($ts[$i] - $ts[$i - 1]).TotalHours -lt 24) { $reab24++ } }
  }
  $mult = 0; foreach ($v in $porConv.Values) { if ($v -ge 3) { $mult++ } }
  return [ordered]@{
    atendimentos = $tot; conversas = $porConv.Count; encerrados = $enc; ativos = $ativos; ativosMais24h = $ativos24
    medianaMin = $med; emLotePct = $(if ($enc) { [math]::Round($emLote / $enc * 100, 0) } else { $null })
    reaberturas = $reab; reaberturas24h = $reab24; conversasCom3Mais = $mult
  }
}

function Read-ConfigSnapshot($drv) {
  $cfg = [ordered]@{}
  # 1) IA: canais ligados, regras, historico
  try {
    Open-CrmPage $drv 'ai-configuration' 13
    $ai = [string]$drv.ExecuteScript("var o={sw:[...document.querySelectorAll('[role=switch],.q-toggle')].map(function(e){var c=e.closest('div');return {on:e.getAttribute('aria-checked')==='true',t:(c&&c.parentElement?c.parentElement.innerText:'').replace(/\s+/g,' ').slice(0,100)}}),t:document.body.innerText.slice(0,9000)};return JSON.stringify(o)")
    $j = $ai | ConvertFrom-Json
    foreach ($s in $j.sw) {
      if ($s.t -match 'Meta|\+55') { $cfg.iaWhatsappLigada = [bool]$s.on }
      elseif ($s.t -match 'seguidores|@') { $cfg.iaInstagramLigada = [bool]$s.on }
    }
    $cfg.assistente = $(if ($j.t -match 'Assistente\s*\n?\s*·\s*\n?\s*(\w+)') { $Matches[1] } else { '' })
    $m = [regex]::Match($j.t, '(\d[\d.]*)\s*/\s*(\d[\d.]*)\s*caracteres')
    # a tela de Identidade mostra "N/1500 caracteres" em "Regras de comportamento"; pega o maior N com limite 1500
    $cfg.regrasChars = $null; $cfg.regrasLimite = 1500
    foreach ($mm in [regex]::Matches($j.t, '(\d[\d.]*)\s*/\s*1500\s*caracteres')) { $v = [int]($mm.Groups[1].Value -replace '\.', ''); if (-not $cfg.regrasChars -or $v -gt $cfg.regrasChars) { $cfg.regrasChars = $v } }
    $cfg.regrasExcedem = [bool]($j.t -match 'limite\s+é\s+1500')
    # historico de alteracoes (icone history da tela)
    $drv.ExecuteScript("var h=[...document.querySelectorAll('i,span,.q-icon')].filter(function(e){return (e.textContent||'').trim()==='history'});var b=h.length?(h[h.length-1].closest('button,.q-btn')||h[h.length-1]):null;if(b)b.click();return !!b") | Out-Null
    Start-Sleep -Seconds 9
    $hist = [string]$drv.ExecuteScript("var d=document.querySelector('.q-dialog,[role=dialog]');return d?d.innerText:''")
    $ev = Read-HistoricoIA $hist
    $onoff = @($ev | Where-Object { $_.acao -ne 'editou a configuração' })
    $edits = @($ev | Where-Object { $_.acao -eq 'editou a configuração' })
    $cfg.eventosIA = @($onoff | Select-Object -Last 10)
    $limite = (Get-Date).AddDays(-30).ToString('yyyy-MM-dd')
    $e30 = @($edits | Where-Object { $_.data -ge $limite })
    $cfg.edicoes30d = $e30.Count
    $cfg.editores30d = @($e30 | ForEach-Object { $_.quem } | Sort-Object -Unique).Count
    $ult = @($onoff | Where-Object { $_.canal -eq 'WhatsApp' } | Select-Object -Last 1)
    if ($ult.Count) { $cfg.ultimoEventoWhatsapp = $ult[0] }
  } catch { Log ("AVISO config/IA: " + $_.Exception.Message) }
  # 2) Comportamento
  try {
    Open-CrmPage $drv 'ai-configuration' 11
    [void](Click-CrmText $drv 'Comportamento'); Start-Sleep -Seconds 6
    $cfg.humanoGrupoGrande = Get-SwitchByLabel $drv 'Grupo maior que o limite'
    $cfg.humanoSemMesas = Get-SwitchByLabel $drv 'Sem mesas disponíveis'
    $cfg.humanoForaPrazo = Get-SwitchByLabel $drv 'Pedido fora do prazo'
    $cfg.msgForaHorarioHumano = Get-SwitchByLabel $drv 'Mensagem diferente fora do horário do atendimento humano'
    $ina = [string]$drv.ExecuteScript("var l=[...document.querySelectorAll('*')].filter(function(x){return (x.innerText||'').trim().indexOf('Tempo limite de inatividade')===0&&x.children.length<4})[0];if(!l)return '';var p=l;for(var i=0;i<6&&p;i++){var inp=p.querySelector('input');if(inp)return inp.value+'|'+(p.innerText||'').replace(/\s+/g,' ').slice(0,200);p=p.parentElement}return ''")
    if ($ina -match '^(\d+)\|') {
      $n = [int]$Matches[1]; $cfg.inatividadeHumano = $n
      $cfg.inatividadeUnidade = $(if ($ina -match 'Minutos') { 'min' } elseif ($ina -match 'Dias') { 'dias' } else { 'h' })
      $cfg.inatividadeHoras = $(if ($cfg.inatividadeUnidade -eq 'min') { [math]::Round($n / 60, 1) } elseif ($cfg.inatividadeUnidade -eq 'dias') { $n * 24 } else { $n })
    }
  } catch { Log ("AVISO config/comportamento: " + $_.Exception.Message) }
  # 3) Follow-up
  try {
    [void](Click-CrmText $drv 'Follow-up'); Start-Sleep -Seconds 6
    $cfg.followUpLigado = Get-SwitchByLabel $drv 'Habilitar follow-up automático'
    $vals = @($drv.ExecuteScript("return [...document.querySelectorAll('input[type=number]')].map(function(i){return i.value})"))
    $cfg.followUpIntervalos = @($vals | Where-Object { $_ -match '^\d+$' -and [int]$_ -gt 0 } | ForEach-Object { [int]$_ })
  } catch { Log ("AVISO config/follow-up: " + $_.Exception.Message) }
  # 4) Links externos
  try {
    [void](Click-CrmText $drv 'Links externos'); Start-Sleep -Seconds 6
    $lt = [string]$drv.ExecuteScript("return (document.querySelector('.q-page')||document.body).innerText")
    $cfg.linkReservasIA = [bool]($lt -notmatch 'Reservas de Mesa[\s\S]{0,80}Não configurado')
    $cfg.linkCardapioIA = [bool]($lt -notmatch 'Cardápio Digital[\s\S]{0,80}Não configurado')
  } catch { Log ("AVISO config/links: " + $_.Exception.Message) }
  # 5) Disparos Inteligentes
  try {
    Open-CrmPage $drv 'dispatch-config' 11
    $dt = [string]$drv.ExecuteScript("return (document.querySelector('.q-page')||document.body).innerText")
    $cfg.disparosPausados = [bool]($dt -match 'PAUSADO')
    $aud = [ordered]@{}
    foreach ($nome in 'Aniversariantes da semana', 'VIPs adormecidos', 'Cancelaram recentemente', 'Fiéis', 'Voltaram só uma vez') {
      $mm = [regex]::Match($dt, [regex]::Escape($nome) + '[\s\S]{0,60}?~(\d+)\s*clientes')
      if ($mm.Success) { $aud[$nome] = [int]$mm.Groups[1].Value }
    }
    $cfg.disparosAudiencias = $aud
    $cfg.disparosCustoMes = [int](Find-Group $dt 'R\$\s*(\d+)\s*\n?\s*/mês')
  } catch { Log ("AVISO config/disparos: " + $_.Exception.Message) }
  # 6) Pos-venda (SAC) sem perguntas?
  try {
    Open-CrmPage $drv 'sac' 12
    [void](Click-CrmText $drv 'Perguntas'); Start-Sleep -Seconds 6
    $pt = [string]$drv.ExecuteScript("return (document.querySelector('.q-page')||document.body).innerText")
    $cfg.posVendaSemPerguntas = [bool]($pt -match 'Nenhuma pergunta encontrada')
  } catch { Log ("AVISO config/pos-venda: " + $_.Exception.Message) }
  # 7) Base de clientes com nascimento
  try {
    Open-CrmPage $drv 'reports/clients' 13
    $ct = [string]$drv.ExecuteScript("return (document.querySelector('.q-page')||document.body).innerText")
    $cfg.clientesTotal = ConvertTo-Cnt (Find-Group $ct 'Total de Clientes\s*\n\s*\S+\s*\n\s*([\d.]+)')
    $cfg.clientesComNascimento = ConvertTo-Cnt (Find-Group $ct '\(([\d.]+)\s+clientes com ano de nascimento')
  } catch { Log ("AVISO config/clientes: " + $_.Exception.Message) }
  # 8) Atendimentos humanos (SAC, 30 dias)
  try { $cfg.sac = Read-SacMetricas $drv } catch { Log ("AVISO config/SAC: " + $_.Exception.Message) }
  return $cfg
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
  $linhas = $null; $funil = $null; $cfgSnap = $null
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
    try {
      $cfgSnap = Read-ConfigSnapshot $drv
      Log ("Configuracao lida: IA WhatsApp ligada={0} | regras={1}/1500 | follow-up ligado={2} intervalos={3} | atendimentos humanos 30d={4}" -f $cfgSnap.iaWhatsappLigada, $cfgSnap.regrasChars, $cfgSnap.followUpLigado, (@($cfgSnap.followUpIntervalos) -join ','), $cfgSnap.sac.atendimentos)
      if ($DryRun) { Log ("CONFIG JSON: " + ($cfgSnap | ConvertTo-Json -Depth 6 -Compress)) }
    } catch { $cfgSnap = $null; Log ("AVISO configuracao: " + $_.Exception.Message) }
  } finally {
    try { Stop-SeDriver -Driver $drv } catch {}
    Get-Process chrome, chromedriver -ErrorAction SilentlyContinue | Where-Object { $pidsAntes -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  }

  if (-not $DryRun -and ($linhas -or $funil -or $cfgSnap)) {
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
    if ($cfgSnap) {
      $res = Invoke-AppsScript @{ action = 'submitCrmConfig'; token = $token; config = $cfgSnap }
      if (-not $res.ok) { Log ("AVISO: BI recusou a configuracao: $($res.error) $($res.code)") } else { Log "Configuracao enviada pro BI." }
    }
  } elseif ($DryRun) { Log "Dry-run: nada foi enviado ao BI." }
  if ($falhou) { exit 1 }
  Log "Concluido."
} catch {
  Log ("ERRO: " + $_.Exception.Message)
  exit 1
}
