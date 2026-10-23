<#
  Login manual no painel do lojista da 99Food, UMA vez, para eu olhar a loja (somente leitura) com a sua sessao.
  Sua senha NAO passa por mim nem fica gravada: voce digita no proprio site, dentro de um perfil de Chrome separado.
  USO: powershell -ExecutionPolicy Bypass -File login_manual_99food.ps1
  Abre o Chrome com o perfil do robo; entre na 99Food, espere abrir a Visao geral e FECHE a janela.
#>
$ErrorActionPreference = 'Stop'
$perfil = "$env:USERPROFILE\.seujustino\chrome-profile-99food"
New-Item -ItemType Directory -Force -Path $perfil | Out-Null
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
Start-Process $chrome -ArgumentList "--user-data-dir=`"$perfil`"", "https://merchant.99app.com/pt-BR/manager/overview" -Wait
Write-Host "Perfil salvo em $perfil. Pode me avisar que eu olho a loja."
