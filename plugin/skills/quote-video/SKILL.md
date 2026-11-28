---
name: quote-video
description: Find what a video says about a topic and quote it with timestamps. Use when the user gives a video link or a YouTube video ID and asks for a quote, the exact words, or the time when something is said.
---

# Quote a video with timestamps

1. Call `get_raw_subtitles` one time with the `url` that the user gave. If the user asked for the subtitles in a specific language, also pass `lang` with that code. A language for your answer, such as "summarize in German", is not a track language: then do not pass `type` or `lang`. The answer is SRT or VTT text: each cue has a start time and an end time.
2. If the answer is a list of tracks and not the subtitles, do the steps in "If the answer is a list of tracks".
3. If the answer has `next_cursor` and you did not find the quote, call `get_raw_subtitles` again with the same arguments and that `next_cursor`.
4. Find the cues that match the request. Quote the words exactly, in the language of the video. Put the start time of the first cue in front of each quote, as `MM:SS` or `HH:MM:SS`.
5. If the video is on YouTube, add a link to the moment: `https://www.youtube.com/watch?v=<video ID>&t=<seconds>s`. Take the video ID from the link or the ID that the user gave.

## If the answer is a list of tracks

The server could not tell which track is in the original language. The answer lists the official and the automatic tracks and names one next step. Do only that step.

1. If the step asks for `type` and `lang`, choose one listed track. Use the language that the user asked for. If the user did not ask for one, use the language of the video title or of the user's message. Choose an official track before an automatic track. Then call `get_raw_subtitles` one more time with `url`, `type` (`official` or `auto`) and `lang` exactly as the list shows them.
2. If the list is empty and the step asks for `lang`, use the language that the user asked for, or the language of the video title. Then call `get_raw_subtitles` one more time with `url` and `lang`.
3. If the step says not to repeat the call, or to retry later, do not call again. Give the user the text of the answer.

## Rules

- Each call to `get_raw_subtitles` without `next_cursor` is a caption request, and the platforms limit caption requests. Make one request for each video, plus at most one follow-up after a list of tracks.
- Do not call `get_transcript` for the same video as well. The raw subtitles hold the same words and the times.
- Do not call `get_available_subtitles` or `get_video_info` before `get_raw_subtitles`.
- If a call fails, do not call again, except for the one follow-up after a list of tracks. Give the user the error text, which names the next step.
- If the user asks for something else, such as a specific track or tool, do what the user asks.
