<#
  Login manual no Dionisio CRM, UMA vez, para o robo (robo_dionisio.ps1) reaproveitar a sessao.
  USO: powershell -ExecutionPolicy Bypass -File login_manual_dionisio.ps1
  Abre o Chrome com o perfil do robo; entre no CRM, espere abrir o painel e FECHE a janela do Chrome.
#>
$ErrorActionPreference = 'Stop'
$perfil = "$env:USERPROFILE\.seujustino\chrome-profile-crm"
New-Item -ItemType Directory -Force -Path $perfil | Out-Null
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
Start-Process $chrome -ArgumentList "--user-data-dir=`"$perfil`"", "https://dionisio-crm.web.app/" -Wait
Write-Host "Perfil salvo em $perfil. O robo ja pode usar a sessao."
