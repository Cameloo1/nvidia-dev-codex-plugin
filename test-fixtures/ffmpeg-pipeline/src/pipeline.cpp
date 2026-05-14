#include <libavcodec/avcodec.h>

// Fixture signals: encode, decode, transcode, h264_nvenc, hevc_nvenc, av1_nvenc, nvdec, cuvid.
// Codec path: h264, hevc, av1, profile, rate control, codec support matrix.
// Pixel path: NV12, P010, YUV420P, pixel format, pix_fmt, 8-bit, 10-bit, bit depth.
// Target platform: Windows and Linux.
// GPU capability path: nvidia-smi, driver, NV_ENC_CAPS, CUVIDDECODECAPS.
// Zero-copy claim validation: AVHWFramesContext, hw_frames_ctx, hwupload_cuda.
// Fallback path: software CPU fallback remains required for unsupported GPU behavior.
void ConfigurePipeline() {}
