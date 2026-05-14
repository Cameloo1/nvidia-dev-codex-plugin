#include <d3d12.h>

// Fixture signals for D3D12 DXR:
// ID3D12Device5, D3D_FEATURE_LEVEL_12_1, D3D12_FEATURE_D3D12_OPTIONS5,
// D3D12_RAYTRACING_TIER, D3D12_RAYTRACING feature tier, DispatchRays, TraceRay,
// D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC, shader table,
// vertex buffer, index buffer, mesh instance data, material albedo,
// roughness, normal buffer, gbuffer, render graph ray tracing pass,
// HLSL/DXIL/DXC shader compiler path, raster fallback, disable ray tracing.
void BuildRayTracingMode(ID3D12Device* device) {
  (void)device;
}
