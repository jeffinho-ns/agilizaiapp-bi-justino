<#
  Cria a tarefa do Windows "SeuJustino - Robo Avaliacoes Google": roda robo_google_avaliacoes.ps1 todo dia as 10:00.
  USO (uma vez, SO depois de o -DryRun ter lido as avaliacoes certas): powershell -ExecutionPolicy Bypass -File agendar_robo_google_avaliacoes.ps1
  Para remover: Unregister-ScheduledTask -TaskName "SeuJustino - Robo Avaliacoes Google" -Confirm:$false
  O computador precisa estar ligado e com o usuario logado nesse horario (se estiver desligado, a tarefa roda assim que ligar).
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'robo_google_avaliacoes.ps1'
$nome = 'SeuJustino - Robo Avaliacoes Google'
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" -WorkingDirectory $PSScriptRoot
$gatilhos = @('10:00') | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilhos -Settings $config -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $nome | Select-Object TaskName, State | Format-Table -AutoSize
(Get-ScheduledTask -TaskName $nome).Triggers | ForEach-Object { "gatilho: " + $_.StartBoundary }
