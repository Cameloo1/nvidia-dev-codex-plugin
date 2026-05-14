. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-unity-hdrp-validation-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $hdrp = Invoke-NvidiaPluginTool -Name 'nvidia_unity_hdrp_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unity-hdrp'
  }
  Assert-Truthy ($hdrp.validation_report.route.state -eq 'unity_hdrp_supported_route') "Expected Unity HDRP supported route, got $($hdrp.validation_report.route.state)."
  Assert-Truthy ($hdrp.validation_report.unity_version.raw -eq '2022.3.10f1') "Expected Unity 2022.3.10f1, got $($hdrp.validation_report.unity_version.raw)."
  Assert-Truthy $hdrp.validation_report.package_status.hdrp.present 'HDRP fixture did not report HDRP package present.'
  Assert-Truthy ($hdrp.validation_report.render_pipeline_hints.state -eq 'render_pipeline_hints_present') "Expected render pipeline hints, got $($hdrp.validation_report.render_pipeline_hints.state)."
  Assert-Truthy ($hdrp.validation_report.nvidia_dlss_settings.state -eq 'settings_or_code_hints_present') "Expected NVIDIA/DLSS hints, got $($hdrp.validation_report.nvidia_dlss_settings.state)."
  Assert-Truthy ($hdrp.validation_report.reflex_readiness.state -eq 'reflex_hints_present') "Expected Reflex hints, got $($hdrp.validation_report.reflex_readiness.state)."
  Assert-Truthy ($hdrp.validation_report.no_fake_metrics_policy.Count -ge 2) 'Unity HDRP validation did not expose no-fake-metrics policy.'
  Assert-Truthy ($hdrp.written_files.Count -eq 0) 'Preview Unity validation unexpectedly wrote files.'
  Write-Host 'Unity HDRP supported-route validation OK' -ForegroundColor Green

  $urp = Invoke-NvidiaPluginTool -Name 'nvidia_unity_hdrp_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unity-urp'
  }
  Assert-Truthy ($urp.validation_report.route.state -eq 'urp_custom_srp_advanced_route') "Expected URP/custom advanced route, got $($urp.validation_report.route.state)."
  Assert-Truthy (($urp.validation_report.blockers -join "`n") -match 'URP/custom SRP') 'URP fixture did not report advanced-route blocker.'
  Write-Host 'Unity URP/custom route validation OK' -ForegroundColor Green

  $missing = Invoke-NvidiaPluginTool -Name 'nvidia_unity_hdrp_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unity-missing-hdrp'
  }
  Assert-Truthy ($missing.validation_report.route.state -eq 'unsupported_unknown_route') "Expected unsupported/unknown route, got $($missing.validation_report.route.state)."
  Assert-Truthy (($missing.validation_report.blockers -join "`n") -match 'HDRP package') 'Missing-HDRP fixture did not report missing HDRP package blocker.'
  Write-Host 'Unity missing-HDRP validation OK' -ForegroundColor Green

  $mismatch = Invoke-NvidiaPluginTool -Name 'nvidia_unity_hdrp_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unity-hdrp-version-mismatch'
  }
  Assert-Truthy ($mismatch.validation_report.route.state -eq 'version_mismatch') "Expected version_mismatch, got $($mismatch.validation_report.route.state)."
  Assert-Truthy (($mismatch.validation_report.blockers -join "`n") -match '2021\.2') 'Version mismatch fixture did not report Unity baseline blocker.'
  Write-Host 'Unity HDRP version mismatch validation OK' -ForegroundColor Green

  $patch = Invoke-NvidiaPluginTool -Name 'nvidia_patch_plan' -Arguments @{
    goal = 'Plan safe Unity HDRP DLSS readiness validation.'
    technology = 'unity-hdrp-dlss'
    project_path = Join-Path $fixtures 'unity-hdrp'
    target_workflow = 'unity-hdrp'
  }
  $patchSteps = @($patch.patch_plan | ForEach-Object { $_.step })
  Assert-Contains -Collection $patchSteps -Expected 'Inspect HDRP package and render pipeline asset' -Message 'Unity patch plan did not include HDRP render-pipeline inspection.'
  Assert-Contains -Collection $patchSteps -Expected 'Plan HDRP DLSS readiness checks' -Message 'Unity patch plan did not include HDRP DLSS readiness checks.'
  Assert-Truthy ($patch.unity_hdrp_validation_report.route.state -eq 'unity_hdrp_supported_route') 'Patch plan did not include Unity HDRP validation report.'
  Write-Host 'Unity HDRP patch plan output OK' -ForegroundColor Green

  $blocked = Invoke-NvidiaPluginTool -Name 'nvidia_unity_hdrp_validator' -AllowError -Arguments @{
    project_path = Join-Path $fixtures 'unity-hdrp'
    output_dir = Join-Path $tempRoot 'blocked'
    write_files = $true
  }
  Assert-Truthy ($blocked.error.message -match 'APPROVED_UNITY_HDRP_VALIDATION') 'Missing Unity validation approval token was not rejected.'
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $tempRoot 'blocked'))) 'Blocked Unity write created an output directory.'
  Write-Host 'Unity write approval gate OK' -ForegroundColor Green

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_unity_hdrp_validator' -Arguments @{
    project_path = Join-Path $fixtures 'unity-hdrp'
    output_dir = Join-Path $tempRoot 'generated'
    write_files = $true
    approval_token = 'APPROVED_UNITY_HDRP_VALIDATION'
  }
  Assert-Truthy ($written.written_files.Count -ge 2) 'Approved Unity validation artifact write did not create files.'
  $generatedText = (Get-ChildItem -LiteralPath (Join-Path $tempRoot 'generated') -Recurse -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
  Assert-Truthy ($generatedText -match 'Static readiness is not runtime success|reports static readiness only') 'Generated Unity artifacts did not preserve static-readiness caveat.'
  Write-Host 'Unity approved validation artifact write OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
