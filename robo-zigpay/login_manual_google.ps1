<#
  Login manual no Google (Perfil da Empresa), UMA vez, para o robo de avaliacoes ler as avaliacoes com a sua sessao.
  Sua senha NAO passa por mim nem fica gravada: voce digita no proprio site, dentro de um perfil de Chrome separado.
  USO: powershell -ExecutionPolicy Bypass -File login_manual_google.ps1
  Abre o Chrome com o perfil do robo; entre com a conta do Perfil da Empresa do Seu Justino, espere abrir as avaliacoes e FECHE a janela.
  Se a pagina abrir em outro endereco (ex.: business.google.com/n/NUMERO/reviews), copie o link da barra e guarde numa linha de
  $env:USERPROFILE\.seujustino\google_avaliacoes_url.txt  (o robo usa esse link no lugar do padrao).
#>
$ErrorActionPreference = 'Stop'
$perfil = "$env:USERPROFILE\.seujustino\chrome-profile-google"
New-Item -ItemType Directory -Force -Path $perfil | Out-Null
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
Start-Process $chrome -ArgumentList "--user-data-dir=`"$perfil`"", "https://business.google.com/reviews" -Wait
Write-Host "Perfil salvo em $perfil. Rode agora: powershell -File robo_google_avaliacoes.ps1 -DryRun"
