# File Converter

A comprehensive file conversion tool that supports:
- Image formats (JPEG ↔ PNG, WebP, etc.)
- Audio formats (MP4 → MP3, WAV, etc.)
- YouTube video downloads and conversions

## Quick Start
```bash
# Clone and install
git clone https://github.com/YOUR-USERNAME/file-converter.git
cd file-converter
pip install -r requirements.txt

# Convert image
python main.py image input.jpg output.png

# Extract audio from video
python main.py audio input.mp4 output.mp3

# Download YouTube as MP3
python main.py youtube "https://youtube.com/watch?v=VIDEO_ID" audio.mp3
