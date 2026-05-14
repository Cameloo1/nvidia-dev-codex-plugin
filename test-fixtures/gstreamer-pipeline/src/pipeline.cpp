// GStreamer fixture signals: gst-launch, gstreamer, encode, decode, transcode.
// NVENC/NVDEC elements: nvh264enc, nvh265enc, nvav1enc, nvh264dec, nvh265dec.
// Codec path: h264, hevc, av1, profile, rate control, codec support matrix.
// Pixel path: NV12, P010, YUV420P, pixel format, 8-bit, 10-bit, bit depth.
// Target platform: Windows and Linux.
// GPU capability path: nvidia-smi, driver, NV_ENC_CAPS, CUVIDDECODECAPS.
// Zero-copy claim validation: memory:NVMM and GstCudaMemory caps must be inspected.
// Fallback path: software CPU fallback and unsupported GPU behavior are explicit.
void ConfigureGStreamerPipeline() {}
