import logging
from typing import Optional

from .engine import ConversionError, Options, convert

logger = logging.getLogger(__name__)


class VideoConverter:
    @staticmethod
    def convert(input_path: str, output_path: str) -> bool:
        try:
            convert(input_path, output_path.rsplit(".", 1)[-1], output_path)
            return True
        except ConversionError as e:
            logger.error("Failed to convert video: %s", e)
            return False

    @staticmethod
    def to_gif(
        input_path: str,
        output_path: str,
        fps: int = 12,
        width: int = 480,
        start: Optional[float] = None,
        end: Optional[float] = None,
    ) -> bool:
        try:
            convert(input_path, "gif", output_path, Options(gif_fps=fps, gif_width=width, start=start, end=end))
            return True
        except ConversionError as e:
            logger.error("Failed to create GIF: %s", e)
            return False
