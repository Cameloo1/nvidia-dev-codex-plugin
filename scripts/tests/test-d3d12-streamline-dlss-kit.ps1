. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$rendererRoot = Join-Path $fixtures 'custom-d3d12'
$positiveSdk = Join-Path $fixtures 'header-grounding-positive'
$fakeSdk = Join-Path $fixtures 'header-grounding-negative'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-d3d12-streamline-kit-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $kit = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create D3D12 Streamline DLSS Super Resolution and DLAA implementation kit.'
    technology = 'dlss-streamline'
    workflow = 'd3d12-streamline-dlss-sr-kit'
    project_path = $rendererRoot
    sdk_roots = @($positiveSdk)
  }
  Assert-Truthy ($kit.workflow -eq 'd3d12-streamline-dlss-sr-kit') "Unexpected workflow: $($kit.workflow)"
  Assert-Truthy ($kit.classification.graphics_apis -contains 'D3D12') 'Custom D3D12 fixture was not classified as D3D12.'
  Assert-Truthy ($kit.implementation_package.implementation_readiness.state -eq 'header_grounded_adapter_ready') "Expected header-grounded readiness, got $($kit.implementation_package.implementation_readiness.state)."
  Assert-Truthy $kit.implementation_package.implementation_readiness.real_api_implementation_allowed 'Header-grounded kit did not allow real API implementation.'
  Assert-Truthy $kit.implementation_package.build_system_detection.cmake 'CMake build system was not detected.'
  Assert-Truthy ($kit.code_output_mode -eq 'header_grounded_observed_symbols_only') "Expected header-grounded output mode, got $($kit.code_output_mode)."

  $paths = @($kit.implementation_package.files | ForEach-Object { $_.relative_path })
  foreach ($expected in @(
    'src/nvidia/streamline/DlssTypes.h',
    'src/nvidia/streamline/NvidiaStreamlineBridge.h',
    'src/nvidia/streamline/NvidiaStreamlineBridge.cpp',
    'cmake/NvidiaStreamlineDlss.cmake',
    'build/NvidiaStreamlineDlss.props',
    'docs/nvidia/d3d12-streamline-dlss-sr-dlaa-kit.md'
  )) {
    Assert-Contains -Collection $paths -Expected $expected -Message "Generated kit missing $expected."
  }

  $generatedText = ($kit.implementation_package.files | ForEach-Object { $_.content }) -join "`n"
  foreach ($required in @('NvidiaStreamlineBridge', 'DlssFrameInputs', 'DlssFeatureSupport', 'DlssQualitySettings')) {
    Assert-Truthy ($generatedText -match $required) "Generated kit missing adapter type: $required"
  }
  foreach ($boundary in @('color', 'depth', 'motion vectors', 'jitter', 'exposure', 'reset', 'command list', 'command queue')) {
    Assert-Truthy ($generatedText -match $boundary) "Generated kit missing host TODO boundary: $boundary"
  }
  Assert-Truthy ($generatedText -match 'decltype\(&slInit\)') 'Header-grounded output did not include Streamline compile probe.'
  foreach ($forbidden in @('SL_FEATURE_DLSS_G', 'slDLSSGSet', 'slDLSSGGet', 'Multi Frame')) {
    Assert-Truthy (!($generatedText -match $forbidden)) "DLSS SR/DLAA kit included out-of-scope token: $forbidden"
  }
  Assert-Truthy (($kit.implementation_package.validation_harness.compile_commands -join "`n") -match 'cmake -S') 'Validation harness missing CMake compile command.'
  Assert-Truthy (($kit.implementation_package.validation_harness.runtime_support_query_checklist -join "`n") -match 'feature requirement') 'Validation harness missing runtime support query checklist.'
  Assert-Truthy ($kit.implementation_package.validation_harness.streamline_log_path.configured_app_log_directory -eq 'logs/nvidia/streamline/') 'Validation harness missing configured Streamline log path.'
  Assert-Truthy (($kit.implementation_package.validation_harness.nsight_capture_checklist -join "`n") -match 'Nsight') 'Validation harness missing Nsight checklist.'
  Write-Host 'D3D12 Streamline DLSS SR/DLAA kit header-grounded output OK' -ForegroundColor Green

  $missingSdk = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create D3D12 Streamline DLSS Super Resolution and DLAA implementation kit.'
    technology = 'dlss-streamline'
    workflow = 'd3d12-streamline-dlss-sr-kit'
    project_path = $rendererRoot
  }
  Assert-Truthy ($missingSdk.implementation_package.implementation_readiness.state -eq 'blocked_missing_streamline_sdk') "Expected missing SDK blocker, got $($missingSdk.implementation_package.implementation_readiness.state)."
  Assert-Truthy (!$missingSdk.implementation_package.implementation_readiness.real_api_implementation_allowed) 'Missing SDK unexpectedly allowed real API implementation.'
  Assert-Truthy ($missingSdk.code_output_mode -eq 'template_only_no_real_sdk_calls') "Expected template-only mode for missing SDK, got $($missingSdk.code_output_mode)."
  Write-Host 'D3D12 Streamline missing-SDK blocker OK' -ForegroundColor Green

  $fake = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create D3D12 Streamline DLSS Super Resolution and DLAA implementation kit.'
    technology = 'dlss-streamline'
    workflow = 'd3d12-streamline-dlss-sr-kit'
    project_path = $rendererRoot
    sdk_roots = @($fakeSdk)
  }
  Assert-Truthy ($fake.implementation_package.implementation_readiness.state -eq 'limited_missing_required_symbols') "Expected fake-header limited state, got $($fake.implementation_package.implementation_readiness.state)."
  Assert-Truthy (!$fake.implementation_package.implementation_readiness.real_api_implementation_allowed) 'Fake headers unexpectedly allowed real API implementation.'
  Assert-Contains -Collection $fake.implementation_package.implementation_readiness.streamline_sdk_requirement.missing_required_symbols -Expected 'slInit' -Message 'Fake headers did not report missing slInit.'
  $fakeText = ($fake.implementation_package.files | ForEach-Object { $_.content }) -join "`n"
  Assert-Truthy (!($fakeText -match 'decltype\(&slInit\)')) 'Fake-header output included real Streamline compile probe.'
  Write-Host 'D3D12 Streamline fake-header limited output OK' -ForegroundColor Green

  $blocked = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -AllowError -Arguments @{
    goal = 'Attempt D3D12 kit write without approval.'
    technology = 'dlss-streamline'
    workflow = 'd3d12-streamline-dlss-sr-kit'
    project_path = $rendererRoot
    sdk_roots = @($positiveSdk)
    output_dir = Join-Path $tempRoot 'blocked'
    write_files = $true
  }
  Assert-Truthy ($blocked.error.message -match 'APPROVED_PHASE_3_EDITS') 'Missing Phase 3 approval token was not rejected for D3D12 kit.'
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $tempRoot 'blocked'))) 'Blocked D3D12 kit write created an output directory.'

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create approved D3D12 Streamline DLSS SR/DLAA implementation kit.'
    technology = 'dlss-streamline'
    workflow = 'd3d12-streamline-dlss-sr-kit'
    project_path = $rendererRoot
    sdk_roots = @($positiveSdk)
    output_dir = Join-Path $tempRoot 'generated'
    write_files = $true
    approval_token = 'APPROVED_PHASE_3_EDITS'
  }
  Assert-Truthy ($written.written_files.Count -ge 6) 'Approved D3D12 kit write did not create all expected files.'
  Write-Host 'D3D12 Streamline kit write gate OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
