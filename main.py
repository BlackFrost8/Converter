"""Command-line interface.

    python main.py convert input.mp4 output.gif --start 5 --end 9
    python main.py convert input.mov mp3                # writes input.mp3
    python main.py convert "https://youtu.be/..." mp3   # links work too
    python main.py formats input.mkv                    # list targets
    python main.py serve                                # web interface
"""

import argparse
import logging
import sys
from pathlib import Path

from converter.engine import ConversionError, Options, convert
from converter.formats import normalize, targets_for
from converter.youtube_downloader import download, is_valid_url


def _progress(p: float) -> None:
    filled = int(p * 30)
    sys.stderr.write(f"\r  [{'#' * filled}{'.' * (30 - filled)}] {p * 100:5.1f}%")
    sys.stderr.flush()


def cmd_convert(args) -> int:
    opts = Options(
        audio_bitrate=args.bitrate, gif_fps=args.fps, gif_width=args.width,
        image_quality=args.quality, start=args.start, end=args.end,
    )
    out = Path(args.output)
    # "mp3" alone means: same name, new format. Otherwise it's a path.
    is_format_only = out.suffix == "" and len(out.parts) == 1
    target = normalize(args.output if is_format_only else out.suffix)

    if is_valid_url(args.source):
        dest_dir = Path(".") if is_format_only else (out.parent or Path("."))
        result = download(args.source, target, dest_dir, opts, _progress)
        if not is_format_only:
            result = result.replace(out)
    else:
        dst = None if is_format_only else out
        result = convert(args.source, target, dst, opts, _progress)
    sys.stderr.write("\n")
    print(result)
    return 0


def cmd_formats(args) -> int:
    targets = targets_for(args.source)
    if not targets:
        print(f"Unsupported input: {args.source}", file=sys.stderr)
        return 1
    print(" ".join(targets))
    return 0


def cmd_serve(args) -> int:
    from webapp import create_app

    create_app().run(host=args.host, port=args.port, debug=False, threaded=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="converter", description="Convert video, audio, images and links.")
    sub = p.add_subparsers(dest="command", required=True)

    c = sub.add_parser("convert", aliases=["image", "audio", "video", "youtube"],
                       help="convert a file or link")
    c.add_argument("source", help="input file path or http(s) link")
    c.add_argument("output", help="output path (e.g. out.gif) or just a format (e.g. mp3)")
    c.add_argument("--bitrate", default="192k", help="audio bitrate, e.g. 128k, 320k")
    c.add_argument("--fps", type=int, default=12, help="GIF frame rate")
    c.add_argument("--width", type=int, default=480, help="GIF width in px (0 = original)")
    c.add_argument("--quality", type=int, default=90, help="JPG/WebP quality 1-100")
    c.add_argument("--start", type=float, help="trim start, seconds")
    c.add_argument("--end", type=float, help="trim end, seconds")
    c.set_defaults(func=cmd_convert)

    f = sub.add_parser("formats", help="list output formats for an input file/extension")
    f.add_argument("source")
    f.set_defaults(func=cmd_formats)

    s = sub.add_parser("serve", help="start the web interface")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=5000)
    s.set_defaults(func=cmd_serve)
    return p


def main(argv=None) -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ConversionError as e:
        sys.stderr.write("\n")
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
