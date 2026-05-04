. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'

$cases = @(
  @{ Name = 'unreal'; Path = Join-Path $fixtures 'unreal'; Expected = 'unreal' },
  @{ Name = 'unity-hdrp'; Path = Join-Path $fixtures 'unity-hdrp'; Expected = 'unity_hdrp' },
  @{ Name = 'custom-d3d12'; Path = Join-Path $fixtures 'custom-d3d12'; Expected = 'custom_cpp_renderer' },
  @{ Name = 'custom-vulkan'; Path = Join-Path $fixtures 'custom-vulkan'; Expected = 'custom_cpp_renderer' },
  @{ Name = 'ffmpeg'; Path = Join-Path $fixtures 'ffmpeg-pipeline'; Expected = 'video_pipeline' },
  @{ Name = 'python-video'; Path = Join-Path $fixtures 'python-video'; Expected = 'python_video' },
  @{ Name = 'electron-native'; Path = Join-Path $fixtures 'electron-native'; Expected = 'electron' }
)

foreach ($case in $cases) {
  $result = Invoke-NvidiaPluginTool -Name 'nvidia_project_classifier' -Arguments @{ path = $case.Path }
  $names = @($result.classification.project_types | ForEach-Object { $_.name })
  Assert-Truthy ($names -contains $case.Expected -or $result.classification.primary_type -eq $case.Expected) "Classifier failed for $($case.Name). Got: $($names -join ', ')"
  Write-Host "Fixture classification OK: $($case.Name)" -ForegroundColor Green
}

$route = Invoke-NvidiaPluginTool -Name 'nvidia_tech_router' -Arguments @{
  goal = 'This is a media player, not a game. I need video super resolution and SDR-to-HDR.'
}
$routeIds = @($route.recommended_routes | ForEach-Object { $_.technology_id })
Assert-Contains -Collection $routeIds -Expected 'rtx-video-sdk' -Message 'Media route did not select RTX Video SDK.'
Write-Host 'Routing matrix OK: RTX Video SDK' -ForegroundColor Green

$headers = Invoke-NvidiaPluginTool -Name 'nvidia_header_inspector' -Arguments @{
  roots = (Join-Path $fixtures 'local-sdk')
}
Assert-Truthy $headers.summary.'dlss-streamline' 'Header inspector did not find Streamline fixture header.'
Assert-Truthy $headers.summary.'video-codec-sdk' 'Header inspector did not find Video Codec SDK fixture header.'
Write-Host 'Header inspector fixture OK' -ForegroundColor Green

$logs = Invoke-NvidiaPluginTool -Name 'nvidia_log_analyzer' -Arguments @{
  log_paths = (Join-Path $fixtures 'broken-streamline\src\log.txt')
  technology = 'dlss-streamline'
}
Assert-Truthy ($logs.findings_by_severity.error.Count -ge 1) 'Broken log fixture did not produce an error.'
Assert-Truthy ($logs.findings_by_severity.warning.Count -ge 1) 'Broken log fixture did not produce a warning.'
Write-Host 'Broken integration log fixture OK' -ForegroundColor Green
