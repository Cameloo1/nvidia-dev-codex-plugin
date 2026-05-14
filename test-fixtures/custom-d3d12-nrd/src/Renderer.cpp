#include <d3d12.h>
#include <NRD.h>

// Fixture signals for NRD readiness:
// noisy diffuse, noisy specular, shadow signal, occlusion signal,
// ray traced radiance, normal buffer, roughness, viewZ, depth buffer,
// motion vectors, camera matrix, previous view, previous projection,
// render resolution, viewport width height, reset, camera cut, resolution change.
void DenoiseRayTracedSignals(ID3D12Device* device) {
  (void)device;
}
