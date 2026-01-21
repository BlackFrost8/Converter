from pytube import YouTube
from pytube.exceptions import PytubeError
from moviepy.editor import AudioFileClip
import re
from pathlib import Path
import logging
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

class YouTubeDownloader:
    @staticmethod
    def extract_video_id(url: str) -> Optional[str]:
        patterns = [
            r'(?:youtube\.com\/watch\?v=)([^&]+)',
            r'(?:youtu\.be\/)([^?]+)',
            r'(?:youtube\.com\/embed\/)([^\/]+)'
        ]
        
        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                return match.group(1)
        return None
    
    @staticmethod
    def is_valid_youtube_url(url: str) -> bool:
        parsed = urlparse(url)
        return ('youtube.com' in parsed.netloc or 'youtu.be' in parsed.netloc)
    
    @staticmethod
    def download_audio(
        url: str,
        output_path: str,
        bitrate: str = "192k",
        max_length: int = 7200
    ) -> bool:
        try:
            if not YouTubeDownloader.is_valid_youtube_url(url):
                raise ValueError("Invalid YouTube URL")
            
            yt = YouTube(url)
            
            if yt.length > max_length:
                raise ValueError(f"Video too long ({yt.length}s > {max_length}s max)")
            
            audio_stream = yt.streams.filter(only_audio=True).order_by('abr').last()
            
            if not audio_stream:
                raise ValueError("No audio stream found")
            
            temp_path = audio_stream.download(filename_prefix="temp_")
            temp_path = Path(temp_path)
            
            output_path = Path(output_path)
            if output_path.suffix.lower() != '.mp3':
                audio = AudioFileClip(str(temp_path))
                audio.write_audiofile(
                    str(output_path),
                    bitrate=bitrate,
                    logger=None
                )
                audio.close()
                temp_path.unlink()
            else:
                temp_path.rename(output_path)
            
            logger.info(f"Downloaded audio from {url} to {output_path}")
            return True
            
        except PytubeError as e:
            logger.error(f"YouTube download error: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to download YouTube audio: {e}")
            return False
    
    @staticmethod
    def get_video_info(url: str) -> dict:
        try:
            yt = YouTube(url)
            return {
                'title': yt.title,
                'length': yt.length,
                'author': yt.author,
                'views': yt.views,
                'publish_date': yt.publish_date,
                'video_id': YouTubeDownloader.extract_video_id(url)
            }
        except Exception as e:
            logger.error(f"Failed to get video info: {e}")
            return {}
