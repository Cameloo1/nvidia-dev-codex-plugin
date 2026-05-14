. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-unreal-dlss-validation-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $missing = Invoke-NvidiaPluginTool -Name 'nvidia_unreal_dlss_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unreal'
  }
  Assert-Truthy ($missing.validation_report.state -eq 'plugin_missing') "Expected missing plugin state, got $($missing.validation_report.state)."
  Assert-Truthy (!$missing.validation_report.plugin_status.installed) 'Missing plugin fixture unexpectedly reported installed plugin.'
  Assert-Truthy ($missing.validation_report.engine_compatibility.state -eq 'known_supported') "Expected known-supported UE version for missing fixture, got $($missing.validation_report.engine_compatibility.state)."
  Assert-Truthy ($missing.written_files.Count -eq 0) 'Preview validation unexpectedly wrote files.'
  Write-Host 'Unreal missing-plugin validation OK' -ForegroundColor Green

  $present = Invoke-NvidiaPluginTool -Name 'nvidia_unreal_dlss_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unreal-dlss-present'
  }
  Assert-Truthy $present.validation_report.plugin_status.installed 'Present plugin fixture did not report installed plugin descriptors.'
  Assert-Truthy ($present.validation_report.plugin_status.state -eq 'plugin_installed_project_reference_missing') "Expected project reference missing, got $($present.validation_report.plugin_status.state)."
  Assert-Truthy ($present.validation_report.config_status.state -eq 'config_present') "Expected config_present, got $($present.validation_report.config_status.state)."
  Assert-Truthy ($present.safe_patch_plan.steps.Count -ge 3) 'Present plugin fixture did not produce patch plan steps.'
  Write-Host 'Unreal present-plugin validation OK' -ForegroundColor Green

  $mismatch = Invoke-NvidiaPluginTool -Name 'nvidia_unreal_dlss_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unreal-dlss-mismatch'
  }
  Assert-Truthy ($mismatch.validation_report.state -eq 'engine_version_mismatch') "Expected engine_version_mismatch, got $($mismatch.validation_report.state)."
  Assert-Truthy ($mismatch.validation_report.engine_compatibility.state -eq 'plugin_engine_version_mismatch') "Expected plugin_engine_version_mismatch, got $($mismatch.validation_report.engine_compatibility.state)."
  Write-Host 'Unreal engine-version mismatch validation OK' -ForegroundColor Green

  $patch = Invoke-NvidiaPluginTool -Name 'nvidia_patch_plan' -Arguments @{
    goal = 'Plan safe Unreal DLSS plugin enablement.'
    technology = 'unreal-dlss-plugin'
    project_path = Join-Path $fixtures 'unreal-dlss-present'
    target_workflow = 'unreal'
  }
  $patchSteps = @($patch.patch_plan | ForEach-Object { $_.step })
  Assert-Contains -Collection $patchSteps -Expected 'Plan .uproject plugin references' -Message 'Unreal patch plan did not include .uproject plugin reference step.'
  Assert-Truthy ($patch.unreal_validation_report.state -eq 'plugin_installed_project_reference_missing') 'Patch plan did not include Unreal validation report.'
  Write-Host 'Unreal patch plan output OK' -ForegroundColor Green

  $blocked = Invoke-NvidiaPluginTool -Name 'nvidia_unreal_dlss_validator' -AllowError -Arguments @{
    project_path = Join-Path $fixtures 'unreal-dlss-present'
    output_dir = Join-Path $tempRoot 'blocked'
    write_files = $true
  }
  Assert-Truthy ($blocked.error.message -match 'APPROVED_UNREAL_DLSS_VALIDATION') 'Missing Unreal validation approval token was not rejected.'
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $tempRoot 'blocked'))) 'Blocked write created an output directory.'
  Write-Host 'Unreal write approval gate OK' -ForegroundColor Green

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_unreal_dlss_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unreal-dlss-present'
    output_dir = Join-Path $tempRoot 'generated'
    write_files = $true
    approval_token = 'APPROVED_UNREAL_DLSS_VALIDATION'
  }
  Assert-Truthy ($written.written_files.Count -ge 2) 'Approved Unreal validation artifact write did not create files.'
  Write-Host 'Unreal approved validation artifact write OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
