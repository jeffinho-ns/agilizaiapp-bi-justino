<#
  Login manual na ZigPay, UMA vez, para o robo reaproveitar a sessao.
  A ZigPay passou a exigir o teste "Confirme que e humano" (Cloudflare), que robo nao passa.
  USO: powershell -ExecutionPolicy Bypass -File login_manual_zigpay.ps1
  Abre o Chrome com o perfil do robo; entre na ZigPay (marque o teste), espere cair no painel e FECHE a janela.
#>
$ErrorActionPreference = 'Stop'
$perfil = "$env:USERPROFILE\.seujustino\chrome-profile"
New-Item -ItemType Directory -Force -Path $perfil | Out-Null
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
Start-Process $chrome -ArgumentList "--user-data-dir=`"$perfil`"", "https://dashboard.zigpay.com.br/login" -Wait
Write-Host "Perfil salvo em $perfil. O robo ja pode usar a sessao."
