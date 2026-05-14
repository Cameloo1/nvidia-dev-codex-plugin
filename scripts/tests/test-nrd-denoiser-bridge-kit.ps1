. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$nrdRoot = Join-Path $fixtures 'custom-d3d12-nrd'
$missingMotionRoot = Join-Path $fixtures 'custom-d3d12-nrd-missing-motion-vectors'
$sdkRoot = Join-Path $fixtures 'local-sdk'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-nrd-bridge-kit-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $kit = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create NRD denoiser bridge support for noisy ray-traced diffuse/specular/shadow signals.'
    technology = 'nrd'
    workflow = 'nrd-denoiser-bridge-kit'
    project_path = $nrdRoot
    sdk_root = $sdkRoot
  }
  Assert-Truthy ($kit.workflow -eq 'nrd-denoiser-bridge-kit') "Unexpected workflow: $($kit.workflow)"
  Assert-Truthy ($kit.implementation_package.implementation_readiness.state -eq 'nrd_bridge_ready') "Expected NRD bridge readiness, got $($kit.implementation_package.implementation_readiness.state)."
  Assert-Truthy $kit.implementation_package.implementation_readiness.bridge_generation_allowed 'Ready NRD fixture did not allow bridge generation.'
  Assert-Truthy $kit.implementation_package.implementation_readiness.real_nrd_api_calls_allowed 'Ready NRD fixture did not allow header-grounded API follow-up.'
  Assert-Truthy (!$kit.implementation_package.implementation_readiness.denoising_working_claim_allowed) 'NRD kit should not claim denoising works from static inspection.'
  Assert-Truthy ($kit.api_generation_gate.status -eq 'header_grounded') "Expected header-grounded NRD gate, got $($kit.api_generation_gate.status)."

  foreach ($checkName in @(
    'noisy_signals',
    'normals',
    'roughness',
    'viewz_depth',
    'motion_vectors',
    'camera_matrices',
    'render_resolution',
    'temporal_reset_state'
  )) {
    Assert-Truthy ($kit.implementation_package.contract_checks.$checkName.status -eq 'pass') "NRD contract check failed: $checkName"
  }

  $paths = @($kit.implementation_package.files | ForEach-Object { $_.relative_path })
  foreach ($expected in @(
    'src/nvidia/nrd/NrdFrameInputs.h',
    'src/nvidia/nrd/NrdDenoiserBridge.h',
    'src/nvidia/nrd/NrdDenoiserBridge.cpp',
    'cmake/NvidiaNrdDenoiser.cmake',
    'docs/nvidia/nrd-denoiser-bridge-kit.md'
  )) {
    Assert-Contains -Collection $paths -Expected $expected -Message "Generated NRD kit missing $expected."
  }

  $generatedText = ($kit.implementation_package.files | ForEach-Object { $_.content }) -join "`n"
  foreach ($required in @('NrdDenoiserBridge', 'NrdFrameInputs', 'NrdSignalType', 'ReBLUR', 'ReLAX', 'SIGMA')) {
    Assert-Truthy ($generatedText -match $required) "Generated NRD kit missing: $required"
  }
  foreach ($forbidden in @('nrd::Create', 'nrdCreate', 'CreateDenoiser', 'DispatchDenoiser')) {
    Assert-Truthy (!($generatedText -match $forbidden)) "Generated NRD kit contained guessed SDK call: $forbidden"
  }
  foreach ($requiredStep in @('ReBLUR', 'ReLAX', 'SIGMA', 'motion vectors', 'temporal reset', 'Nsight', 'fallback')) {
    Assert-Truthy (($kit.implementation_package.validation_checklist.required_steps -join "`n") -match $requiredStep -or $generatedText -match $requiredStep) "Validation output missing: $requiredStep"
  }
  Write-Host 'NRD denoiser bridge ready output OK' -ForegroundColor Green

  $missingMotion = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create NRD denoiser bridge support.'
    technology = 'nrd'
    workflow = 'nrd-denoiser-bridge-kit'
    project_path = $missingMotionRoot
    sdk_root = $sdkRoot
  }
  Assert-Truthy ($missingMotion.implementation_package.implementation_readiness.state -eq 'blocked_missing_nrd_frame_inputs') "Expected missing frame input blocker, got $($missingMotion.implementation_package.implementation_readiness.state)."
  Assert-Truthy ($missingMotion.implementation_package.contract_checks.motion_vectors.status -eq 'fail') 'Missing motion-vector fixture did not fail the motion vector check.'
  Assert-Truthy (($missingMotion.implementation_package.implementation_readiness.blockers -join "`n") -match 'Motion vectors') 'Missing motion-vector blocker was not explicit.'
  Write-Host 'NRD missing-motion-vector blocker OK' -ForegroundColor Green

  $missingSdk = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create NRD denoiser bridge support.'
    technology = 'nrd'
    workflow = 'nrd-denoiser-bridge-kit'
    project_path = $nrdRoot
  }
  Assert-Truthy ($missingSdk.implementation_package.implementation_readiness.state -eq 'blocked_missing_nrd_sdk_template_only') "Expected missing SDK template-only blocker, got $($missingSdk.implementation_package.implementation_readiness.state)."
  Assert-Truthy ($missingSdk.implementation_package.implementation_readiness.bridge_generation_mode -eq 'official_source_backed_template_only_no_sdk_calls') 'Missing SDK fixture did not enter official-source-backed template mode.'
  Assert-Truthy (!$missingSdk.implementation_package.implementation_readiness.real_nrd_api_calls_allowed) 'Missing SDK fixture unexpectedly allowed real NRD API calls.'
  Assert-Truthy (($missingSdk.implementation_package.implementation_readiness.blockers -join "`n") -match 'NRD SDK headers') 'Missing SDK blocker was not explicit.'
  Write-Host 'NRD missing-SDK template-only blocker OK' -ForegroundColor Green

  Assert-Truthy ($kit.written_files.Count -eq 0) 'Preview NRD kit unexpectedly wrote files.'
  Assert-Truthy $kit.implementation_package.generated_files_are_create_only 'NRD kit did not report create-only generated files.'

  $writeBlocked = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -AllowError -Arguments @{
    goal = 'Attempt NRD bridge write without approval.'
    technology = 'nrd'
    workflow = 'nrd-denoiser-bridge-kit'
    project_path = $nrdRoot
    sdk_root = $sdkRoot
    output_dir = Join-Path $tempRoot 'blocked'
    write_files = $true
  }
  Assert-Truthy ($writeBlocked.error.message -match 'APPROVED_PHASE_3_EDITS') 'Missing Phase 3 approval token was not rejected for NRD kit.'
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $tempRoot 'blocked'))) 'Blocked NRD kit write created an output directory.'

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create approved NRD denoiser bridge kit.'
    technology = 'nrd'
    workflow = 'nrd-denoiser-bridge-kit'
    project_path = $nrdRoot
    sdk_root = $sdkRoot
    output_dir = Join-Path $tempRoot 'generated'
    write_files = $true
    approval_token = 'APPROVED_PHASE_3_EDITS'
  }
  Assert-Truthy ($written.written_files.Count -ge 5) 'Approved NRD bridge write did not create expected files.'
  Write-Host 'NRD denoiser bridge write gate OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
