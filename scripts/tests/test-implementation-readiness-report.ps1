. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$sdkRoot = Join-Path $fixtures 'local-sdk'
$customRoot = Join-Path $fixtures 'custom-d3d12'
$incompleteRoot = Join-Path $fixtures 'custom-d3d12-incomplete'
$browserRoot = Join-Path $fixtures 'browser-only'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-implementation-readiness-" + [Guid]::NewGuid().ToString('N'))

function Invoke-ReadinessReport {
  param(
    [Parameter(Mandatory=$true)][hashtable]$Arguments
  )

  $defaults = @{
    goal = 'Create D3D12 Streamline DLSS SR/DLAA implementation.'
    technology = 'dlss-streamline'
    contract_ids = @('streamline-dlss-sr-dlaa')
    include_common_sdk_roots = $false
    include_evidence = $true
  }
  foreach ($key in $Arguments.Keys) {
    $defaults[$key] = $Arguments[$key]
  }
  return Invoke-NvidiaPluginTool -Name 'nvidia_implementation_readiness_report' -Arguments $defaults
}

function Assert-ReportState {
  param(
    [Parameter(Mandatory=$true)]$Report,
    [Parameter(Mandatory=$true)][string]$Expected
  )

  Assert-Truthy ($Report.output_state -eq $Expected) "Expected report state $Expected, got $($Report.output_state). Reason: $($Report.state_reason). Blockers: $($Report.blockers -join ' | ')"
  foreach ($section in @(
    'project_classifier',
    'sdk_locator',
    'header_inspector',
    'header_grounding',
    'implementation_contract_checker',
    'patch_plan',
    'validation_harness',
    'license_guard',
    'verification'
  )) {
    Assert-Truthy $Report.$section "Report missing required section: $section"
  }
}

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $ready = Invoke-ReadinessReport -Arguments @{
    project_path = $customRoot
    sdk_roots = @($sdkRoot)
  }
  Assert-ReportState -Report $ready -Expected 'ready_to_patch'
  Assert-Truthy ($ready.verification.implementation_verified -eq $false) 'Ready report unexpectedly claimed implementation verification.'
  Assert-Truthy ($ready.implementation_contract_checker.contracts[0].state -eq 'satisfied') 'Ready report did not include satisfied implementation contract.'
  Assert-Truthy ($ready.patch_plan.steps.Count -ge 1) 'Ready report did not include patch plan steps.'
  Write-Host 'Readiness report ready_to_patch state OK' -ForegroundColor Green

  $missingSdk = Invoke-ReadinessReport -Arguments @{
    project_path = $customRoot
  }
  Assert-ReportState -Report $missingSdk -Expected 'blocked_missing_sdk'
  Assert-Truthy (($missingSdk.blockers -join ' ') -match 'SDK|header') 'Missing-SDK report did not include SDK/header blocker.'
  Write-Host 'Readiness report blocked_missing_sdk state OK' -ForegroundColor Green

  $missingContract = Invoke-ReadinessReport -Arguments @{
    project_path = $incompleteRoot
    sdk_roots = @($sdkRoot)
  }
  Assert-ReportState -Report $missingContract -Expected 'blocked_missing_renderer_contract'
  Assert-Truthy (($missingContract.blockers -join ' ') -match 'input resource|motion|depth|jitter|exposure') 'Renderer-contract report did not include renderer/input blockers.'
  Write-Host 'Readiness report blocked_missing_renderer_contract state OK' -ForegroundColor Green

  $unsupported = Invoke-ReadinessReport -Arguments @{
    goal = 'Use native DLSS directly from this browser-only project.'
    project_path = $browserRoot
    sdk_roots = @($sdkRoot)
  }
  Assert-ReportState -Report $unsupported -Expected 'blocked_unsupported_project'
  Assert-Truthy (($unsupported.blockers -join ' ') -match 'browser') 'Unsupported-project report did not include browser/native boundary blocker.'
  Write-Host 'Readiness report blocked_unsupported_project state OK' -ForegroundColor Green

  $unsafe = Invoke-ReadinessReport -Arguments @{
    project_path = $customRoot
    sdk_roots = @($sdkRoot)
    action = 'copy NVIDIA DLLs into a redistributable package'
    files = @('sl.interposer.dll', 'nvngx_dlss.dll')
    destination = 'release-package'
  }
  Assert-ReportState -Report $unsafe -Expected 'unsafe_license_or_binary_boundary'
  Assert-Truthy ($unsafe.license_guard.required_user_approval) 'Unsafe report did not require user approval.'
  Write-Host 'Readiness report unsafe_license_or_binary_boundary state OK' -ForegroundColor Green

  $validationRequired = Invoke-ReadinessReport -Arguments @{
    project_path = $customRoot
    sdk_roots = @($sdkRoot)
    patch_approved = $true
  }
  Assert-ReportState -Report $validationRequired -Expected 'validation_required'
  Assert-Truthy ($validationRequired.verification.implementation_verified -eq $false) 'Validation-required report claimed verified without evidence.'
  Assert-Truthy (($validationRequired.verification.missing_or_failed_evidence -join ' ') -match 'compile|runtime|validation') 'Validation-required report did not explain missing proof.'
  Write-Host 'Readiness report validation_required state OK' -ForegroundColor Green

  $compileEvidence = Join-Path $tempRoot 'compile.log'
  $runtimeEvidence = Join-Path $tempRoot 'runtime.log'
  $validationArtifact = Join-Path $tempRoot 'validation-artifact.txt'
  Set-Content -LiteralPath $compileEvidence -Value 'Build succeeded. 0 errors.' -Encoding UTF8
  Set-Content -LiteralPath $runtimeEvidence -Value 'Runtime validation passed. Sample launch passed.' -Encoding UTF8
  Set-Content -LiteralPath $validationArtifact -Value 'Validation passed. Nsight capture and PSNR/SSIM throughput artifact recorded.' -Encoding UTF8

  $verified = Invoke-ReadinessReport -Arguments @{
    project_path = $customRoot
    sdk_roots = @($sdkRoot)
    patch_approved = $true
    compile_evidence_paths = @($compileEvidence)
    runtime_evidence_paths = @($runtimeEvidence)
    validation_artifact_paths = @($validationArtifact)
  }
  Assert-ReportState -Report $verified -Expected 'implementation_verified'
  Assert-Truthy $verified.verification.implementation_verified 'Verified report did not mark verification evidence as passed.'
  Assert-Truthy ($verified.verification.compile_evidence.status -eq 'pass') 'Compile evidence did not pass.'
  Assert-Truthy ($verified.verification.runtime_evidence.status -eq 'pass') 'Runtime evidence did not pass.'
  Assert-Truthy ($verified.verification.validation_artifacts.status -eq 'pass') 'Validation artifact evidence did not pass.'
  Write-Host 'Readiness report implementation_verified state OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
