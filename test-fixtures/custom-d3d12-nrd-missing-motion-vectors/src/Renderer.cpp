#include <d3d12.h>
#include <NRD.h>

// Fixture signals for a blocked NRD bridge:
// noisy diffuse, noisy specular, shadow signal, occlusion signal,
// ray traced radiance, normal buffer, roughness, viewZ, depth buffer,
// camera matrix, previous view, previous projection,
// render resolution, viewport width height, reset, camera cut, resolution change.
// Intentionally no velocity or temporal motion-vector source is present.
void DenoiseRayTracedSignalsWithoutMotionVectors(ID3D12Device* device) {
  (void)device;
}
