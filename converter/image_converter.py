from PIL import Image
import os
from pathlib import Path
from typing import Optional
import logging

logger = logging.getLogger(__name__)

class ImageConverter:
    @staticmethod
    def convert(
        input_path: str,
        output_path: str,
        quality: int = 95,
        optimize: bool = True
    ) -> bool:
        try:
            input_path = Path(input_path)
            output_path = Path(output_path)
            
            if not input_path.exists():
                raise FileNotFoundError(f"Input file not found: {input_path}")
            
            with Image.open(input_path) as img:
                if output_path.suffix.lower() in ['.jpg', '.jpeg']:
                    if img.mode in ('RGBA', 'LA', 'P'):
                        img = img.convert('RGB')
                
                save_kwargs = {'optimize': optimize}
                if output_path.suffix.lower() in ['.jpg', '.jpeg', '.webp']:
                    save_kwargs['quality'] = quality
                
                img.save(output_path, **save_kwargs)
                logger.info(f"Converted {input_path} to {output_path}")
                return True
                
        except Exception as e:
            logger.error(f"Failed to convert image: {e}")
            return False
    
    @staticmethod
    def batch_convert(
        input_dir: str,
        output_dir: str,
        output_format: str,
        quality: int = 95
    ) -> list:
        input_dir = Path(input_dir)
        output_dir = Path(output_dir)
        output_dir.mkdir(exist_ok=True)
        
        successful = []
        image_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'}
        
        for file in input_dir.iterdir():
            if file.suffix.lower() in image_extensions:
                output_file = output_dir / f"{file.stem}.{output_format}"
                if ImageConverter.convert(file, output_file, quality):
                    successful.append(str(file))
        
        return successful
