. "$PSScriptRoot\common.ps1"

$fixtures = Join-Path $Script:PluginRoot 'test-fixtures'
$dxrRoot = Join-Path $fixtures 'custom-d3d12-dxr'
$plainD3d12Root = Join-Path $fixtures 'custom-d3d12'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nvidia-d3d12-dxr-kit-" + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $kit = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create D3D12 DXR ray-tracing starter kit for basic ray-traced shadows and reflections.'
    technology = 'rtx-kit'
    workflow = 'd3d12-dxr-raytracing-starter-kit'
    project_path = $dxrRoot
  }
  Assert-Truthy ($kit.workflow -eq 'd3d12-dxr-raytracing-starter-kit') "Unexpected workflow: $($kit.workflow)"
  Assert-Truthy ($kit.classification.graphics_apis -contains 'D3D12') 'DXR fixture was not classified as D3D12.'
  Assert-Truthy ($kit.implementation_package.implementation_readiness.state -eq 'dxr_starter_kit_ready') "Expected DXR starter readiness, got $($kit.implementation_package.implementation_readiness.state)."
  Assert-Truthy $kit.implementation_package.implementation_readiness.starter_kit_generation_allowed 'Ready DXR fixture did not allow starter kit generation.'
  Assert-Truthy $kit.implementation_package.build_system_detection.cmake 'CMake build system was not detected.'

  foreach ($checkName in @(
    'd3d12_device_feature_level',
    'dxr_capable_api_usage',
    'shader_compilation_path',
    'mesh_instance_data_access',
    'render_graph_insertion_point',
    'gbuffer_material_data_access',
    'fallback_path'
  )) {
    Assert-Truthy ($kit.implementation_package.contract_checks.$checkName.status -eq 'pass') "DXR contract check failed: $checkName"
  }

  $paths = @($kit.implementation_package.files | ForEach-Object { $_.relative_path })
  foreach ($expected in @(
    'src/nvidia/dxr/RtxRayTracingContext.h',
    'src/nvidia/dxr/AccelerationStructureBuilder.h',
    'src/nvidia/dxr/ShaderBindingTableBuilder.h',
    'src/nvidia/dxr/RayTracingPass.h',
    'shaders/nvidia/dxr/RayTracingRaygen.hlsl',
    'shaders/nvidia/dxr/RayTracingMiss.hlsl',
    'shaders/nvidia/dxr/RayTracingClosestHit.hlsl',
    'docs/nvidia/d3d12-dxr-raytracing-starter-kit.md'
  )) {
    Assert-Contains -Collection $paths -Expected $expected -Message "Generated DXR kit missing $expected."
  }

  $generatedText = ($kit.implementation_package.files | ForEach-Object { $_.content }) -join "`n"
  foreach ($required in @('RtxRayTracingContext', 'AccelerationStructureBuilder', 'ShaderBindingTableBuilder', 'RayTracingPass')) {
    Assert-Truthy ($generatedText -match $required) "Generated DXR kit missing adapter type: $required"
  }
  foreach ($requiredStep in @('feature query', 'BLAS/TLAS', 'shader', 'first visible', 'Nsight', 'fallback')) {
    Assert-Truthy (($kit.implementation_package.validation_checklist.required_steps -join "`n") -match $requiredStep) "Validation checklist missing: $requiredStep"
  }

  $common = ($kit.implementation_package.files | Where-Object { $_.relative_path -eq 'shaders/nvidia/dxr/RayTracingCommon.hlsl' }).content
  $raygen = ($kit.implementation_package.files | Where-Object { $_.relative_path -eq 'shaders/nvidia/dxr/RayTracingRaygen.hlsl' }).content
  $miss = ($kit.implementation_package.files | Where-Object { $_.relative_path -eq 'shaders/nvidia/dxr/RayTracingMiss.hlsl' }).content
  $closest = ($kit.implementation_package.files | Where-Object { $_.relative_path -eq 'shaders/nvidia/dxr/RayTracingClosestHit.hlsl' }).content
  Assert-Truthy ($common -match 'RaytracingAccelerationStructure' -and $raygen -match '\[shader\("raygeneration"\)\]' -and $raygen -match 'TraceRay' -and $raygen -match '#include "RayTracingCommon.hlsl"') 'Raygen HLSL template is not coherent.'
  Assert-Truthy ($miss -match '\[shader\("miss"\)\]' -and $miss -match 'RayPayload') 'Miss HLSL template is not coherent.'
  Assert-Truthy ($closest -match '\[shader\("closesthit"\)\]' -and $closest -match 'BuiltInTriangleIntersectionAttributes') 'Closest-hit HLSL template is not coherent.'
  Write-Host 'D3D12 DXR starter kit ready output OK' -ForegroundColor Green

  $blocked = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create D3D12 DXR ray-tracing starter kit.'
    technology = 'rtx-kit'
    workflow = 'd3d12-dxr-raytracing-starter-kit'
    project_path = $plainD3d12Root
  }
  Assert-Truthy ($blocked.implementation_package.implementation_readiness.state -eq 'blocked_missing_dxr_readiness') "Expected missing DXR readiness blocker, got $($blocked.implementation_package.implementation_readiness.state)."
  Assert-Truthy (!$blocked.implementation_package.implementation_readiness.starter_kit_generation_allowed) 'Plain D3D12 fixture unexpectedly allowed DXR starter kit readiness.'
  Assert-Truthy (($blocked.implementation_package.implementation_readiness.blockers -join "`n") -match 'DXR-capable D3D12 API usage') 'Blocked fixture did not report missing DXR API usage.'
  Write-Host 'D3D12 DXR missing-readiness blocker OK' -ForegroundColor Green

  Assert-Truthy ($kit.written_files.Count -eq 0) 'Preview DXR kit unexpectedly wrote files.'
  Assert-Truthy ($kit.implementation_package.generated_files_are_create_only) 'DXR kit did not report create-only generated files.'

  $writeBlocked = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -AllowError -Arguments @{
    goal = 'Attempt DXR kit write without approval.'
    technology = 'rtx-kit'
    workflow = 'd3d12-dxr-raytracing-starter-kit'
    project_path = $dxrRoot
    output_dir = Join-Path $tempRoot 'blocked'
    write_files = $true
  }
  Assert-Truthy ($writeBlocked.error.message -match 'APPROVED_PHASE_3_EDITS') 'Missing Phase 3 approval token was not rejected for DXR kit.'
  Assert-Truthy (!(Test-Path -LiteralPath (Join-Path $tempRoot 'blocked'))) 'Blocked DXR kit write created an output directory.'

  $written = Invoke-NvidiaPluginTool -Name 'nvidia_assisted_implementation' -Arguments @{
    goal = 'Create approved D3D12 DXR ray-tracing starter kit.'
    technology = 'rtx-kit'
    workflow = 'd3d12-dxr-raytracing-starter-kit'
    project_path = $dxrRoot
    output_dir = Join-Path $tempRoot 'generated'
    write_files = $true
    approval_token = 'APPROVED_PHASE_3_EDITS'
  }
  Assert-Truthy ($written.written_files.Count -ge 12) 'Approved DXR kit write did not create expected files.'
  Write-Host 'D3D12 DXR starter kit write gate OK' -ForegroundColor Green
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
