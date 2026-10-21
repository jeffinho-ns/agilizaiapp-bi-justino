<#
  Cadastra os fornecedores homologados do Renato na aba "Contatos de Emergência"
  do BI (print mandado em 07/10/2026 - 29 fornecedores: manutenção, construção,
  segurança, limpeza etc.)

  NAO usa nenhuma credencial salva - pede seu e-mail e senha do proprio BI na
  hora, direto no console. Nada fica gravado em disco nem e visto pelo Claude.

  Evita duplicar: antes de cadastrar, busca os contatos ja existentes e pula
  qualquer um que ja bata por nome+telefone (normalizado, sem acento/maiuscula).
  Rodar de novo depois de already aplicado so confirma "ja existe", nao duplica.

  USO:
    powershell -File cadastrar_fornecedores_emergencia.ps1              # so mostra o que criaria (seguro, nao grava nada)
    powershell -File cadastrar_fornecedores_emergencia.ps1 -Aplicar      # aplica de verdade
#>
param(
  [switch]$Aplicar
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$AppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzsXAoBmnHvfocbC3JWiVtiHaSwkzrCX3hKdtRsz_YRoatP3qrksSOj3J8776S3bJXVuA/exec'

# data | nome | empresa | telefone (so digitos) | servico
$Fornecedores = @(
  [PSCustomObject]@{nome='Matheus';empresa='Justino';telefone='11916476922';servico='Manutencista geral fixo SJM/PSJ'}
  [PSCustomObject]@{nome='MGI';empresa='MGI';telefone='11981378116';servico='Manutenção gás encanado'}
  [PSCustomObject]@{nome='Andre';empresa='Asa Mak';telefone='11997049904';servico='Manutenção refrigeração / ar condicionado'}
  [PSCustomObject]@{nome='Erivaldo';empresa='Vik Fornos';telefone='11998324273';servico='Manutenção forno / fritadeira em geral'}
  [PSCustomObject]@{nome='Cleanway';empresa='Cleanway';telefone='11984864544';servico='Limpa coifa'}
  [PSCustomObject]@{nome='Erivaldo';empresa='Carroçeiro';telefone='11915950016';servico='Carroçeiro'}
  [PSCustomObject]@{nome='Sirlene';empresa='BS Maui';telefone='11997264667';servico='Comodato dispenser papel / sabonete / álcool gel'}
  [PSCustomObject]@{nome='DD Fran';empresa='DD Fran';telefone='11942005442';servico='Dedetização'}
  [PSCustomObject]@{nome='Edi Carlos';empresa='Max Gate';telefone='11916808468';servico='Instalação e manutenção câmeras segurança'}
  [PSCustomObject]@{nome='Alerta Tech';empresa='Alerta Tech';telefone='1130225412';servico='Monitoramento alarme'}
  [PSCustomObject]@{nome='Felipe';empresa='Face a Face';telefone='11932491790';servico='Depósito material construção'}
  [PSCustomObject]@{nome='Marcio';empresa='Pedreiro';telefone='11947717582';servico='Pedreiro'}
  [PSCustomObject]@{nome='Drycon';empresa='Drycon';telefone='1148831920';servico='Depósito material construção'}
  [PSCustomObject]@{nome='Nicolas';empresa='Giglio';telefone='11986281217';servico='Coleta óleo - SJM/PSJ/HLB'}
  [PSCustomObject]@{nome='Murilo Rossetti';empresa='';telefone='11976977792';servico='Manutenção sistema de som'}
  [PSCustomObject]@{nome='Amilton';empresa='Global Toltos';telefone='11999507054';servico='Manutenção e instalação toldo'}
  [PSCustomObject]@{nome='Anderson';empresa='AVB Tec';telefone='11947896715';servico='T.I'}
  [PSCustomObject]@{nome='Luan';empresa='Unifort';telefone='11915898978';servico='Máquina de lavar louça'}
  [PSCustomObject]@{nome='Michael';empresa='Carreto';telefone='11916886937';servico='Carreto'}
  [PSCustomObject]@{nome='Junior';empresa='Chaveiro';telefone='11974783342';servico='Chaveiro'}
  [PSCustomObject]@{nome='Lucas';empresa='Serralheiro';telefone='11949806699';servico='Serralheiro'}
  [PSCustomObject]@{nome='Anderson';empresa='Sheriff';telefone='11948070331';servico='Chefe segurança'}
  [PSCustomObject]@{nome='Vaztec';empresa='Vaztec';telefone='11947048282';servico='Caçamba'}
  [PSCustomObject]@{nome='Multi Tintas';empresa='Multi Tintas Sumaré';telefone='1136730842';servico='Tintas'}
  [PSCustomObject]@{nome='Made1000';empresa='Made1000';telefone='11985980836';servico='Madeireira'}
  [PSCustomObject]@{nome='Leonardo';empresa='Mercado das Balanças';telefone='11999104148';servico='Manutenção balança digital'}
  [PSCustomObject]@{nome='Imprimix';empresa='Imprimix';telefone='11998770336';servico='Gráfica'}
  [PSCustomObject]@{nome='Camila';empresa='Headchef';telefone='11975750810';servico='Empresa nutricionista'}
  [PSCustomObject]@{nome='Cook Cold';empresa='Cook Cold';telefone='11971780329';servico='Manutenção forno / fritadeira em geral'}
)

function FormatarTelefone($digitos) {
  $d = ($digitos -replace '\D', '')
  if ($d.Length -eq 11) { return '+55 ' + $d.Substring(0,2) + ' ' + $d.Substring(2,5) + '-' + $d.Substring(7,4) }
  if ($d.Length -eq 10) { return '+55 ' + $d.Substring(0,2) + ' ' + $d.Substring(2,4) + '-' + $d.Substring(6,4) }
  return $d
}
function Normalizar($s) {
  if (-not $s) { return '' }
  $s = $s.ToString().Trim().ToLower()
  $s = $s -replace '\s+', ' '
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

Write-Host "=== Cadastro de fornecedores homologados em Contatos de Emergencia ===" -ForegroundColor Cyan
if (-not $Aplicar) {
  Write-Host "MODO SIMULACAO - nada vai ser gravado. Rode com -Aplicar quando conferir que esta certo." -ForegroundColor Yellow
}
Write-Host "Total na lista: $($Fornecedores.Count)" -ForegroundColor Cyan
Write-Host ""

$email = Read-Host "E-mail do BI (sua conta)"
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

Write-Host "Buscando contatos ja cadastrados (pra nao duplicar)..."
$existentesRes = Invoke-AppsScript @{ action = 'getContatosEmergencia'; token = $token }
if (-not $existentesRes.ok) {
  Write-Host "Resposta crua: $($existentesRes | ConvertTo-Json -Compress)" -ForegroundColor Red
  throw "Nao consegui buscar os contatos existentes."
}
$existentes = $existentesRes.items
$existentesKeys = $existentes | ForEach-Object { (Normalizar $_.nome) + '|' + ($_.telefone -replace '\D','') }
Write-Host "$($existentes.Count) contato(s) ja cadastrado(s)." -ForegroundColor Green
Write-Host ""

$criados = 0
$jaExistiam = 0
$falharam = 0

foreach ($f in $Fornecedores) {
  $nomeFinal = if ($f.empresa -and (Normalizar $f.empresa) -ne (Normalizar $f.nome)) { "$($f.nome) ($($f.empresa))" } else { $f.nome }
  $telefoneDigitos = ($f.telefone -replace '\D', '')
  $chave = (Normalizar $f.nome) + '|' + $telefoneDigitos
  if ($existentesKeys -contains $chave) {
    Write-Host ("JA EXISTE   {0,-32} {1}" -f $nomeFinal, $f.servico) -ForegroundColor DarkGray
    $jaExistiam++
    continue
  }
  $telefoneFormatado = FormatarTelefone $telefoneDigitos
  Write-Host ("CADASTRAR   {0,-32} {1,-18} {2}" -f $nomeFinal, $telefoneFormatado, $f.servico) -ForegroundColor Cyan

  if ($Aplicar) {
    $payload = @{
      action      = 'saveContatoEmergencia'
      token       = $token
      nome        = $nomeFinal
      categoria   = $f.servico
      telefone    = $telefoneFormatado
      observacao  = 'Fornecedor homologado.'
      ativo       = $true
    }
    try {
      $r = Invoke-AppsScript $payload
      if ($r.ok) { Write-Host "  -> salvo." -ForegroundColor Green; $criados++ }
      else { Write-Host "  -> FALHOU: $($r.error)" -ForegroundColor Red; $falharam++ }
    } catch {
      Write-Host "  -> FALHOU: $($_.Exception.Message)" -ForegroundColor Red
      $falharam++
    }
  }
}

Write-Host ""
Write-Host "=== Resumo ===" -ForegroundColor Cyan
Write-Host "Total na lista: $($Fornecedores.Count)"
Write-Host "Ja existiam: $jaExistiam"
if ($Aplicar) {
  Write-Host "Cadastrados agora: $criados" -ForegroundColor Green
  if ($falharam -gt 0) { Write-Host "Falharam: $falharam" -ForegroundColor Red }
} else {
  Write-Host "(simulacao - rode com -Aplicar pra gravar de verdade)" -ForegroundColor Yellow
}
