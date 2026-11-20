import os
import sys
from pathlib import Path
from typing import List
import logging

def setup_logging(level=logging.INFO):
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[logging.StreamHandler(sys.stdout)],
    )

def get_file_size(path: str) -> str:
    size = os.path.getsize(path)
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024.0:
            return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} TB"

def validate_file(path: str, allowed_extensions: List[str]) -> bool:
    path = Path(path)
    return path.exists() and path.suffix.lower() in allowed_extensions

def create_output_filename(input_path: str, output_format: str) -> str:
    input_path = Path(input_path)
    return f"{input_path.stem}.{output_format.lstrip('.')}"
