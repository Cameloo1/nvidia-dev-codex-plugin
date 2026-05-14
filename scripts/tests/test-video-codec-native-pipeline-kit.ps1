. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$ffmpegRoot = Join-Path $fixtures 'ffmpeg-pipeline'
$gstreamerRoot = Join-Path $fixtures 'gstreamer-pipeline'
$pythonRoot = Join-Path $fixtures 'python-video'
$sdkRoot = Join-Path $fixtures 'local-sdk'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-video-codec-kit-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $ffmpegKit = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create Video Codec SDK NVENC/NVDEC support for FFmpeg pipeline.'
    technology = 'video-codec-sdk'
    workflow = 'video-codec-native-pipeline-kit'
    project_path = $ffmpegRoot
    sdk_root = $sdkRoot
  }
  Assert-Truthy ($ffmpegKit.workflow -eq 'video-codec-native-pipeline-kit') "Unexpected workflow: $($ffmpegKit.workflow)"
  Assert-Truthy ($ffmpegKit.implementation_package.implementation_readiness.state -eq 'video_codec_pipeline_ready') "Expected Video Codec readiness, got $($ffmpegKit.implementation_package.implementation_readiness.state)."
  Assert-Truthy $ffmpegKit.implementation_package.implementation_readiness.real_video_codec_api_calls_allowed 'Ready FFmpeg fixture did not allow header-grounded Video Codec API follow-up.'
  Assert-Truthy (!$ffmpegKit.implementation_package.implementation_readiness.acceleration_working_claim_allowed) 'Video Codec kit should not claim acceleration works from static inspection.'
  Assert-Truthy ($ffmpegKit.api_generation_gate.status -eq 'header_grounded') "Expected header-grounded Video Codec gate, got $($ffmpegKit.api_generation_gate.status)."

  foreach ($checkName in @(
    'encode_decode_goal',
    'codec',
    'pixel_format',
    'bit_depth',
    'target_platform',
    'gpu_capability',
    'zero_copy_claim_validation'
  )) {
    Assert-Truthy ($ffmpegKit.implementation_package.contract_checks.$checkName.status -eq 'pass') "Video Codec contract check failed for FFmpeg fixture: $checkName"
  }

  $paths = @($ffmpegKit.implementation_package.files | ForEach-Object { $_.relative_path })
  foreach ($expected in @(
    'src/nvidia_video/VideoCodecPipelineTypes.h',
    'src/nvidia_video/NvencPipelineAdapter.h',
    'src/nvidia_video/NvencPipelineAdapter.cpp',
    'src/nvidia_video/NvdecPipelineAdapter.h',
    'src/nvidia_video/NvdecPipelineAdapter.cpp',
    'cmake/NvidiaVideoCodec.cmake',
    'docs/nvidia/video-codec-native-pipeline-kit.md'
  )) {
    Assert-Contains -Collection $paths -Expected $expected -Message "Generated Video Codec kit missing $expected."
  }

  $generatedText = ($ffmpegKit.implementation_package.files | ForEach-Object { $_.content }) -join "`n"
  foreach ($required in @('NvencPipelineAdapter', 'NvdecPipelineAdapter', 'VideoCodecRequest', 'PSNR', 'SSIM', 'VMAF', 'ffmpeg', 'gst-launch-1.0', 'PyNvVideoCodec')) {
    Assert-Truthy ($generatedText -match $required) "Generated Video Codec kit missing: $required"
  }
  foreach ($forbidden in @('NvEncOpenEncodeSessionEx\(', 'cuvidCreateDecoder\(', 'cuvidDecodePicture\(')) {
    Assert-Truthy (!($generatedText -match $forbidden)) "Generated Video Codec kit guessed a concrete SDK call: $forbidden"
  }
  Write-Host 'Video Codec FFmpeg fixture output OK' -ForegroundColor Green

  $gstreamerKit = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create Video Codec SDK NVENC/NVDEC support for GStreamer pipeline.'
    technology = 'video-codec-sdk'
    workflow = 'video-codec-native-pipeline-kit'
    project_path = $gstreamerRoot
    sdk_root = $sdkRoot
  }
  Assert-Truthy ($gstreamerKit.implementation_package.implementation_readiness.state -eq 'video_codec_pipeline_ready') "Expected GStreamer readiness, got $($gstreamerKit.implementation_package.implementation_readiness.state)."
  Assert-Truthy (($gstreamerKit.implementation_package.implementation_readiness.pipeline_detection.frameworks -join "`n") -match 'gstreamer') 'GStreamer fixture was not classified as GStreamer.'
  Assert-Truthy ($gstreamerKit.implementation_package.command_plans.gstreamer.encode_nvenc.Count -ge 1) 'GStreamer command plans were not generated.'
  Write-Host 'Video Codec GStreamer fixture output OK' -ForegroundColor Green

  $pythonKit = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create PyNvVideoCodec route and native Video Codec SDK validation for Python pipeline.'
    technology = 'video-codec-sdk'
    workflow = 'video-codec-native-pipeline-kit'
    project_path = $pythonRoot
    sdk_root = $sdkRoot
  }
  Assert-Truthy ($pythonKit.implementation_package.implementation_readiness.state -eq 'video_codec_pipeline_ready') "Expected Python video readiness, got $($pythonKit.implementation_package.implementation_readiness.state)."
  Assert-Truthy (($pythonKit.implementation_package.implementation_readiness.pipeline_detection.frameworks -join "`n") -match 'pynvvideocodec') 'Python fixture was not classified as PyNvVideoCodec route.'
  Assert-Truthy ($pythonKit.implementation_package.command_plans.pynvvideocodec.route_note -match 'PyNvVideoCodec') 'PyNvVideoCodec route note was not generated.'
  Write-Host 'Video Codec Python fixture output OK' -ForegroundColor Green

  $missingSdk = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create Video Codec SDK NVENC/NVDEC support without SDK path.'
    technology = 'video-codec-sdk'
    workflow = 'video-codec-native-pipeline-kit'
    project_path = $ffmpegRoot
  }
  Assert-Truthy ($missingSdk.implementation_package.implementation_readiness.state -eq 'blocked_missing_video_codec_sdk') "Expected missing SDK blocker, got $($missingSdk.implementation_package.implementation_readiness.state)."
  Assert-Truthy (!$missingSdk.implementation_package.implementation_readiness.real_video_codec_api_calls_allowed) 'Missing SDK fixture unexpectedly allowed real Video Codec API calls.'
  Assert-Truthy (($missingSdk.implementation_package.implementation_readiness.blockers -join "`n") -match 'Video Codec SDK headers') 'Missing SDK blocker was not explicit.'
  Write-Host 'Video Codec missing-SDK blocker OK' -ForegroundColor Green

  Assert-Truthy $ffmpegKit.implementation_package.implementation_readiness.missing_tools_are_graceful_skips 'Missing-tool policy was not marked as graceful skip.'
  foreach ($tool in @('ffmpeg', 'gstreamer', 'python')) {
    $state = $ffmpegKit.implementation_package.implementation_readiness.tool_availability.$tool.execution_state
    Assert-Truthy (@('available', 'plan_only_missing_tool') -contains $state) "Unexpected $tool execution state: $state"
  }
  Write-Host 'Video Codec missing-tool graceful-skip policy OK' -ForegroundColor Green

  Assert-Truthy ($ffmpegKit.written_files.Count -eq 0) 'Preview Video Codec kit unexpectedly wrote files.'
  Assert-Truthy $ffmpegKit.implementation_package.generated_files_are_create_only 'Video Codec kit did not report create-only generated files.'

  $writeBlocked = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -AllowError -Arguments @{
    goal = 'Attempt Video Codec kit write without approval.'
    technology = 'video-codec-sdk'
    workflow = 'video-codec-native-pipeline-kit'
    project_path = $ffmpegRoot
    sdk_root = $sdkRoot
    output_dir = Join-Path $tempRoot 'blocked'
    write_files = $true
  }
  Assert-Truthy ($writeBlocked.error.message -match 'APPROVED_PHASE_3_EDITS') 'Missing Phase 3 approval token was not rejected for Video Codec kit.'
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $tempRoot 'blocked'))) 'Blocked Video Codec kit write created an output directory.'

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create approved Video Codec native NVENC/NVDEC kit.'
    technology = 'video-codec-sdk'
    workflow = 'video-codec-native-pipeline-kit'
    project_path = $ffmpegRoot
    sdk_root = $sdkRoot
    output_dir = Join-Path $tempRoot 'generated'
    write_files = $true
    approval_token = 'APPROVED_PHASE_3_EDITS'
  }
  Assert-Truthy ($written.written_files.Count -ge 7) 'Approved Video Codec kit write did not create expected files.'
  Write-Host 'Video Codec native pipeline write gate OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
