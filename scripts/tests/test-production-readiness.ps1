. "$PSScriptRoot\common.ps1"

$selfTest = node $Script:Server --self-test | ConvertFrom-Json
Assert-Truthy ($selfTest.version -eq '1.0.0-rc.1') "Expected version 1.0.0-rc.1, got $($selfTest.version)."

foreach ($tool in @(
  'nvidia_header_inspector',
  'nvidia_sdk_header_grounding',
  'nvidia_implementation_contracts',
  'nvidia_implementation_readiness_report',
  'nvidia_unreal_dlss_validator',
  'nvidia_unity_hdrp_validator',
  'nvidia_registry_audit',
  'nvidia_release_readiness',
  'nvidia_submission_packager'
)) {
  Assert-Contains -Collection $selfTest.tools -Expected $tool -Message "Self-test missing $tool."
}
Write-Host 'Release-candidate tool list OK' -ForegroundColor Green

$registry = Invoke-NvidiaPluginTool -Name 'nvidia_registry_audit' -Arguments @{ staleness_days = 10000 }
Assert-Truthy ($registry.audit.technology_count -ge 8) 'Registry audit did not see expected technology entries.'
Assert-Truthy ($registry.audit.source_count -ge 8) 'Registry audit did not see expected source entries.'
Write-Host 'Registry audit OK' -ForegroundColor Green

$readiness = Invoke-NvidiaPluginTool -Name 'nvidia_release_readiness' -Arguments @{
  project_path = $Script:PluginRoot
  include_environment_probe = $false
  include_registry_audit = $true
}
Assert-Truthy ($readiness.version -eq '1.0.0-rc.1') 'Release readiness reported wrong version.'
Assert-Truthy ($readiness.readiness.items.Count -ge 5) 'Release readiness checklist too small.'
Write-Host "Release readiness gate: $($readiness.readiness.gate) score=$($readiness.readiness.score)" -ForegroundColor Green

$submission = Invoke-NvidiaPluginTool -Name 'nvidia_submission_packager' -Arguments @{
  project_path = $Script:PluginRoot
  target = 'local-review'
}
$missing = @($submission.required_files | Where-Object { -not $_.exists })
Assert-Truthy ($missing.Count -eq 0) "Submission packager missing files: $($missing.path -join ', ')"
Write-Host 'Submission package checklist OK' -ForegroundColor Green

foreach ($phaseFile in @('docs\phase-2-plan.md', 'docs\phase-3-plan.md', 'docs\phase-4-plan.md')) {
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $Script:PluginRoot $phaseFile))) "Development phase file still present: $phaseFile"
}
Write-Host 'Development phase docs cleaned OK' -ForegroundColor Green
