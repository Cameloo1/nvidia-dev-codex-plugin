. "$PSScriptRoot\common.ps1"

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-rtx-dlss-validation-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $probe = Invoke-NvidiaPluginTool -Name 'nvidia_environment_probe' -Arguments @{
    include_sdk_scan = $false
    include_process_tools = $true
  }
  Assert-Truthy $probe.report.os 'Environment probe missing OS data.'
  Assert-Truthy $probe.report.node 'Environment probe missing Node data.'
  Write-Host 'Environment probe OK' -ForegroundColor Green

  $blockedWrite = Invoke-NvidiaPluginTool -Name 'nvidia_environment_probe' -AllowError -Arguments @{
    include_sdk_scan = $false
    write_artifacts = $true
    output_dir = (Join-Path $tempRoot 'blocked')
  }
  Assert-Truthy ($blockedWrite.error.message -match 'APPROVED_PHASE_4_ARTIFACTS') 'Missing Phase 4 approval token was not rejected.'
  Write-Host 'Validation artifact gate OK' -ForegroundColor Green

  $logPath = Join-Path $tempRoot 'nvidia.log'
  @(
    'Streamline failed to load sl.interposer.dll',
    'DLSS Frame Generation feature unsupported on this driver',
    'ffmpeg hwaccel cuda failed; software fallback selected',
    'GPU crash device removed Aftermath dump available'
  ) | Set-Content -LiteralPath $logPath -Encoding UTF8

  $logs = Invoke-NvidiaPluginTool -Name 'nvidia_log_analyzer' -Arguments @{ log_paths = $logPath; technology = 'dlss-streamline' }
  Assert-Truthy ($logs.findings_by_severity.error.Count -ge 1) 'Log analyzer missing error finding.'
  Assert-Truthy ($logs.findings_by_severity.warning.Count -ge 1) 'Log analyzer missing warning finding.'
  Write-Host 'Validation log analyzer OK' -ForegroundColor Green

  foreach ($mode in @('sample-launch-check', 'frame-capture-checklist', 'codec-throughput', 'quality-compare-plan')) {
    $harness = Invoke-NvidiaPluginTool -Name 'nvidia_validation_harness' -Arguments @{
      technology = 'video-codec-sdk'
      workflow = 'production-fixture'
      mode = $mode
      command = 'echo sample'
    }
    Assert-Truthy $harness.command_plan "Harness command plan missing for $mode."
    Assert-Truthy $harness.pass_fail_criteria "Harness pass/fail criteria missing for $mode."
  }
  Write-Host 'Validation harness modes OK' -ForegroundColor Green

  $quality = Invoke-NvidiaPluginTool -Name 'nvidia_quality_compare' -Arguments @{
    reference_path = (Join-Path $tempRoot 'missing-reference.mp4')
    candidate_path = (Join-Path $tempRoot 'missing-candidate.mp4')
    metric_set = 'ffmpeg-psnr-ssim'
  }
  Assert-Truthy ($quality.execution_state -eq 'blocked_missing_requirements') 'Quality compare did not report missing files.'
  Write-Host 'Quality compare missing-file behavior OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
