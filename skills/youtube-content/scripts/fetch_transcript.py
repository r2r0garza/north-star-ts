#!/usr/bin/env python3
"""Fetch a YouTube transcript as a JSON header line followed by the text.

Usage: fetch_transcript.py URL_OR_ID [--timestamps] [--language en,de]
                           [--offset N] [--limit N]
"""
import argparse, json, re, sys

p = argparse.ArgumentParser()
p.add_argument("url")
p.add_argument("--language", help="comma-separated codes, in preference order")
p.add_argument("--timestamps", action="store_true")
p.add_argument("--offset", type=int, default=0, help="first character to print")
p.add_argument("--limit", type=int, default=40000, help="max characters to print")
a = p.parse_args()

m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})", a.url) \
    or re.fullmatch(r"([A-Za-z0-9_-]{11})", a.url.strip())
vid = m.group(1) if m else a.url.strip()

def ts(s):
    h, r = divmod(int(s), 3600); mi, se = divmod(r, 60)
    return f"{h}:{mi:02d}:{se:02d}" if h else f"{mi}:{se:02d}"

try:
    from youtube_transcript_api import YouTubeTranscriptApi
except ImportError:
    sys.exit("error: youtube-transcript-api is not installed (see Setup in SKILL.md)")
try:
    langs = [l.strip() for l in a.language.split(",")] if a.language else None
    t = YouTubeTranscriptApi().fetch(vid, languages=langs) if langs else YouTubeTranscriptApi().fetch(vid)
except Exception as e:
    msg = str(e)
    if "disabled" in msg.lower(): msg = "Transcripts are disabled for this video."
    elif "no transcript" in msg.lower(): msg = "No transcript found in the requested language(s)."
    print(json.dumps({"video_id": vid, "error": msg})); sys.exit(1)

segs = list(t)
text = "\n".join(f"{ts(s.start)} {s.text}" for s in segs) if a.timestamps \
    else " ".join(s.text for s in segs)
end = min(len(text), a.offset + a.limit)
print(json.dumps({
    "video_id": vid,
    "language": getattr(t, "language_code", None),
    "duration": ts(segs[-1].start + segs[-1].duration) if segs else "0:00",
    "segments": len(segs),
    "total_chars": len(text),
    "showing": [a.offset, end],
    "more": end < len(text),
}))
print(text[a.offset:end])
