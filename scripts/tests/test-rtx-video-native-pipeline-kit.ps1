. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$mediaRoot = Join-Path $fixtures 'rtx-video-player'
$browserRoot = Join-Path $fixtures 'browser-only'
$sdkRoot = Join-Path $fixtures 'local-sdk'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-rtx-video-kit-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $kit = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create RTX Video SDK native pipeline support for media app video enhancement.'
    technology = 'rtx-video-sdk'
    workflow = 'rtx-video-native-pipeline-kit'
    project_path = $mediaRoot
    sdk_root = $sdkRoot
  }
  Assert-Truthy ($kit.workflow -eq 'rtx-video-native-pipeline-kit') "Unexpected workflow: $($kit.workflow)"
  Assert-Truthy ($kit.implementation_package.implementation_readiness.state -eq 'rtx_video_native_pipeline_ready') "Expected RTX Video native readiness, got $($kit.implementation_package.implementation_readiness.state)."
  Assert-Truthy $kit.implementation_package.implementation_readiness.native_pipeline_generation_allowed 'Ready media fixture did not allow native pipeline generation.'
  Assert-Truthy $kit.implementation_package.implementation_readiness.real_rtx_video_api_calls_allowed 'Ready media fixture did not allow header-grounded API follow-up.'
  Assert-Truthy (!$kit.implementation_package.implementation_readiness.enhancement_working_claim_allowed) 'RTX Video kit should not claim enhancement works from static inspection.'
  Assert-Truthy ($kit.api_generation_gate.status -eq 'header_grounded') "Expected header-grounded RTX Video gate, got $($kit.api_generation_gate.status)."

  foreach ($checkName in @(
    'input_video_frames',
    'color_format',
    'bit_depth_8_10',
    'sdr_hdr_path',
    'api_route',
    'output_surface_ownership'
  )) {
    Assert-Truthy ($kit.implementation_package.contract_checks.$checkName.status -eq 'pass') "RTX Video contract check failed: $checkName"
  }

  $paths = @($kit.implementation_package.files | ForEach-Object { $_.relative_path })
  foreach ($expected in @(
    'src/nvidia_video/RtxVideoFrame.h',
    'src/nvidia_video/RtxVideoEnhancer.h',
    'src/nvidia_video/RtxVideoEnhancer.cpp',
    'cmake/NvidiaRtxVideo.cmake',
    'docs/nvidia/rtx-video-native-pipeline-kit.md'
  )) {
    Assert-Contains -Collection $paths -Expected $expected -Message "Generated RTX Video kit missing $expected."
  }

  $generatedText = ($kit.implementation_package.files | ForEach-Object { $_.content }) -join "`n"
  foreach ($required in @('RtxVideoEnhancer', 'RtxVideoFrame', 'RtxVideoEffectSettings', 'Super Resolution', 'artifact reduction', 'SDR-to-HDR')) {
    Assert-Truthy ($generatedText -match $required) "Generated RTX Video kit missing: $required"
  }
  foreach ($forbidden in @('slDLSS', 'SL_FEATURE_DLSS', 'NvOFFRUC', 'NvOFExecute')) {
    Assert-Truthy (!($generatedText -match $forbidden)) "Generated RTX Video kit contained wrong-route symbol/pattern: $forbidden"
  }
  foreach ($requiredStep in @('Super Resolution', 'artifact reduction', 'SDR-to-HDR', '8-bit', '10-bit', 'latency', 'fallback')) {
    Assert-Truthy (($kit.implementation_package.validation_harness.required_steps -join "`n") -match $requiredStep -or $generatedText -match $requiredStep) "Validation harness missing: $requiredStep"
  }
  Write-Host 'RTX Video native media fixture output OK' -ForegroundColor Green

  $missingSdk = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create RTX Video SDK native media enhancement pipeline.'
    technology = 'rtx-video-sdk'
    workflow = 'rtx-video-native-pipeline-kit'
    project_path = $mediaRoot
  }
  Assert-Truthy ($missingSdk.implementation_package.implementation_readiness.state -eq 'blocked_missing_rtx_video_sdk') "Expected missing SDK blocker, got $($missingSdk.implementation_package.implementation_readiness.state)."
  Assert-Truthy (!$missingSdk.implementation_package.implementation_readiness.real_rtx_video_api_calls_allowed) 'Missing SDK fixture unexpectedly allowed real RTX Video API calls.'
  Assert-Truthy (($missingSdk.implementation_package.implementation_readiness.blockers -join "`n") -match 'RTX Video SDK headers') 'Missing SDK blocker was not explicit.'
  Write-Host 'RTX Video missing-SDK blocker OK' -ForegroundColor Green

  $browser = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Use RTX Video SDK from this browser-only video project.'
    technology = 'rtx-video-sdk'
    workflow = 'rtx-video-native-pipeline-kit'
    project_path = $browserRoot
    sdk_root = $sdkRoot
  }
  Assert-Truthy ($browser.implementation_package.implementation_readiness.state -eq 'rejected_browser_only_requires_native_boundary') "Expected browser boundary rejection, got $($browser.implementation_package.implementation_readiness.state)."
  Assert-Truthy ($browser.implementation_package.implementation_readiness.native_boundary_recommendation.required) 'Browser-only fixture did not require a native/backend boundary.'
  Assert-Truthy (($browser.implementation_package.implementation_readiness.native_boundary_recommendation.routes -join "`n") -match 'native companion|server-side') 'Browser boundary did not include native companion/backend routes.'
  Assert-Truthy ((@($browser.implementation_package.files | ForEach-Object { $_.relative_path }) -contains 'docs/nvidia/rtx-video-native-boundary.md')) 'Browser-only output did not generate boundary doc.'
  Write-Host 'RTX Video browser boundary rejection OK' -ForegroundColor Green

  Assert-Truthy ($kit.written_files.Count -eq 0) 'Preview RTX Video kit unexpectedly wrote files.'
  Assert-Truthy $kit.implementation_package.generated_files_are_create_only 'RTX Video kit did not report create-only generated files.'

  $writeBlocked = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -AllowError -Arguments @{
    goal = 'Attempt RTX Video kit write without approval.'
    technology = 'rtx-video-sdk'
    workflow = 'rtx-video-native-pipeline-kit'
    project_path = $mediaRoot
    sdk_root = $sdkRoot
    output_dir = Join-Path $tempRoot 'blocked'
    write_files = $true
  }
  Assert-Truthy ($writeBlocked.error.message -match 'APPROVED_PHASE_3_EDITS') 'Missing Phase 3 approval token was not rejected for RTX Video kit.'
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $tempRoot 'blocked'))) 'Blocked RTX Video kit write created an output directory.'

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create approved RTX Video native media enhancement kit.'
    technology = 'rtx-video-sdk'
    workflow = 'rtx-video-native-pipeline-kit'
    project_path = $mediaRoot
    sdk_root = $sdkRoot
    output_dir = Join-Path $tempRoot 'generated'
    write_files = $true
    approval_token = 'APPROVED_PHASE_3_EDITS'
  }
  Assert-Truthy ($written.written_files.Count -ge 5) 'Approved RTX Video kit write did not create expected files.'
  Write-Host 'RTX Video native pipeline write gate OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
