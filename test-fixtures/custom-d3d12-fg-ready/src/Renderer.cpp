#include <d3d12.h>

// Fixture signals for DLSS Frame Generation / MFG readiness:
// swapchain present path, scene color without HUD, hudless color,
// UI color and UI alpha, depth buffer, motion vectors, jitter, exposure,
// camera matrix, previous view, previous projection, present time constants,
// frame index, Reflex low latency marker route, settings capability gate,
// pause/menu/loading/resolution change disable gates.
void RenderFrame(ID3D12Device* device) {
  (void)device;
}
