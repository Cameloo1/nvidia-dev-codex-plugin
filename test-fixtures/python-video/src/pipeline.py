import cv2
import PyNvVideoCodec


# Fixture signals: Python video encode, decode, transcode, dataset ingest.
# Codec path: h264, hevc, av1, profile, rate control, codec support matrix.
# Pixel path: NV12, P010, YUV420P, pixel format, 8-bit, 10-bit, bit depth.
# Target platform: Windows and Linux.
# GPU capability path: nvidia-smi, driver, NV_ENC_CAPS, CUVIDDECODECAPS.
# Zero-copy: no zero-copy claim in this fixture; validate before claiming.
# Fallback path: OpenCV/software CPU fallback remains available.


def load_video(path):
    capture = cv2.VideoCapture(path)
    return capture
