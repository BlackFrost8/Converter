from moviepy.editor import AudioFileClip
import os
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

class AudioConverter:
    @staticmethod
    def extract_from_video(
        video_path: str,
        audio_path: str,
        bitrate: str = "192k"
    ) -> bool:
        try:
            video_path = Path(video_path)
            audio_path = Path(audio_path)
            
            if not video_path.exists():
                raise FileNotFoundError(f"Video file not found: {video_path}")
            
            video = AudioFileClip(str(video_path))
            video.write_audiofile(
                str(audio_path),
                bitrate=bitrate,
                logger=None
            )
            
            video.close()
            logger.info(f"Extracted audio from {video_path} to {audio_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to extract audio: {e}")
            return False
    
    @staticmethod
    def convert_audio(
        input_path: str,
        output_path: str,
        bitrate: str = "192k"
    ) -> bool:
        try:
            input_path = Path(input_path)
            output_path = Path(output_path)
            
            if not input_path.exists():
                raise FileNotFoundError(f"Audio file not found: {input_path}")
            
            audio = AudioFileClip(str(input_path))
            audio.write_audiofile(
                str(output_path),
                bitrate=bitrate,
                logger=None
            )
            
            audio.close()
            logger.info(f"Converted {input_path} to {output_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to convert audio: {e}")
            return False
