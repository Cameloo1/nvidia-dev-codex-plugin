#pragma once

#define RTX_VIDEO_SDK_VERSION_MAJOR 1
struct RTXVideoSession {};
int RTXVideoCreate();
int RTXVideoSuperResolution();
int VSRConfigure();
int RTXVideoArtifactReduction();
int RTXVideoSdrToHdr();
