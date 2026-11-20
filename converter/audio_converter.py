import logging

from .engine import ConversionError, Options, convert

logger = logging.getLogger(__name__)


class AudioConverter:
    @staticmethod
    def extract_from_video(video_path: str, audio_path: str, bitrate: str = "192k") -> bool:
        return AudioConverter.convert_audio(video_path, audio_path, bitrate)

    @staticmethod
    def convert_audio(input_path: str, output_path: str, bitrate: str = "192k") -> bool:
        try:
            convert(input_path, output_path.rsplit(".", 1)[-1], output_path, Options(audio_bitrate=bitrate))
            return True
        except ConversionError as e:
            logger.error("Failed to convert audio: %s", e)
            return False
