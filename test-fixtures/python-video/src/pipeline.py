import cv2


def load_video(path):
    capture = cv2.VideoCapture(path)
    return capture
