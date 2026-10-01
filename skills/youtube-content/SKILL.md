---
name: youtube-content
description: Fetch YouTube video transcripts and turn them into summaries, chapters, quotes, threads, or blog posts. Use when the user shares a YouTube URL or video ID, asks to summarize a video, wants its transcript, or wants a video's content reformatted.
license: MIT
metadata:
  category: media
  origin: Adapted from the Hermes Agent youtube-content skill (Teknium, MIT)
---

# YouTube Content

Fetch a video's transcript, then reshape it into what the user asked for.

## Setup

The helper needs the `youtube-transcript-api` package. If it reports the
package missing, install it following this session's **Python packages**
guidance (`pip install youtube-transcript-api` goes into the app's own venv)
and run the helper again. Without that guidance, ask the user before
installing. Never use `sudo`, `--user`, or `--break-system-packages`.

## Fetching the transcript

Run the bundled helper with `exec_command`. It takes any YouTube URL form
(watch, youtu.be, shorts, embed, live) or a raw 11-character video ID:

```bash
python3 skill://youtube-content/scripts/fetch_transcript.py "https://youtube.com/watch?v=VIDEO_ID" --timestamps
```

Other options: `--language en,de` (preference order), `--offset N` and
`--limit N` (characters; 40000 by default).

The first output line is a JSON header; the transcript follows. When `"more"` is
true, run it again with `--offset <previous end>` to get the next page.

## Output formats

Shape the transcript into what the user asked for; default to a **Summary**.

- **Summary** — 5–10 sentences covering the main points and conclusions, third person, present tense.
- **Chapters** — a timestamped list, one line per topic shift.
- **Chapter summaries** — chapters, each with a short paragraph.
- **Thread** — numbered posts for X/Twitter, each under 280 characters.
- **Blog post** — title, intro, H2 sections, key quotes with timestamps, takeaways.
- **Quotes** — notable lines with their timestamps.
- **Transcript** — the transcript itself. If the user wants it saved and there is a
  workspace, write it to a Markdown file with the video URL, ID, and duration at the top.

`skill://youtube-content/references/output-formats.md` has an example of each.

Example chapters:

```
0:00 Introduction — host opens with the problem statement
3:45 Background — prior work and why existing solutions fall short
12:20 Core method — walkthrough of the proposed approach
24:10 Results — benchmark comparisons and key takeaways
31:55 Q&A — audience questions on scalability and next steps
```

## Workflow

1. **Fetch** with `--timestamps` (chapters, quotes, and summaries all benefit from them).
2. **Check** the header: a non-empty transcript in the expected language. If you
   passed `--language` and got nothing, retry without it and tell the user which
   language came back.
3. **Page** through long transcripts: each page (40K characters by default) gets
   notes or a partial summary before you fetch the next, and the notes are merged
   at the end. Don't try to hold a huge transcript in a single tool result.
4. **Transform** into the requested format.
5. **Verify** before answering: timestamps come from the transcript, chapters are
   in order, and nothing important from the later pages is missing.

## Errors

- **Transcripts disabled** — tell the user; they can check whether the video page offers subtitles.
- **Private or unavailable video** — relay the error and ask the user to check the URL.
- **No transcript in the requested language** — retry without `--language`, then say which language you got.
- **Package missing** — see Setup. Don't install into a system Python.
- **Blocked or rate-limited by YouTube** (for example `RequestBlocked` or `IpBlocked`) — tell the user; retrying right away won't help.
