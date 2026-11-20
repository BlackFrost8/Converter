import logging
from pathlib import Path

from .engine import ConversionError, Options, convert
from .formats import IMAGE_IN

logger = logging.getLogger(__name__)


class ImageConverter:
    @staticmethod
    def convert(input_path: str, output_path: str, quality: int = 90, optimize: bool = True) -> bool:
        try:
            convert(input_path, Path(output_path).suffix, output_path, Options(image_quality=quality))
            return True
        except ConversionError as e:
            logger.error("Failed to convert image: %s", e)
            return False

    @staticmethod
    def batch_convert(input_dir: str, output_dir: str, output_format: str, quality: int = 90) -> list:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        done = []
        for file in sorted(Path(input_dir).iterdir()):
            if file.suffix.lower().lstrip(".") in IMAGE_IN:
                target = out / f"{file.stem}.{output_format.lstrip('.')}"
                if ImageConverter.convert(str(file), str(target), quality):
                    done.append(str(file))
        return done
