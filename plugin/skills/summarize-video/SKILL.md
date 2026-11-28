---
name: summarize-video
description: Summarize a video or answer questions about what is said in it. Use when the user gives a video link (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit) or a YouTube video ID and asks for a summary, the key points, or an answer from the video.
---

# Summarize a video

1. Call `get_transcript` one time with the `url` that the user gave. If the user asked for the transcript in a specific language, also pass `lang` with that code. A language for your answer, such as "summarize in German", is not a track language: then do not pass `type` or `lang`. The server then picks the original language of the video.
2. If the answer is a list of tracks and not the text, do the steps in "If the answer is a list of tracks".
3. If the answer has `next_cursor` and the summary needs the rest of the text, call `get_transcript` again with the same arguments and that `next_cursor`.
4. Write the summary or the answer from the transcript text only. Answer in the language of the user, not of the video.

## If the answer is a list of tracks

The server could not tell which track is in the original language. The answer lists the official and the automatic tracks and names one next step. Do only that step.

1. If the step asks for `type` and `lang`, choose one listed track. Use the language that the user asked for. If the user did not ask for one, use the language of the video title or of the user's message. Choose an official track before an automatic track. Then call `get_transcript` one more time with `url`, `type` (`official` or `auto`) and `lang` exactly as the list shows them.
2. If the list is empty and the step asks for `lang`, use the language that the user asked for, or the language of the video title. Then call `get_transcript` one more time with `url` and `lang`.
3. If the step says not to repeat the call, or to retry later, do not call again. Give the user the text of the answer.

## Rules

- Each call to `get_transcript` without `next_cursor` is a caption request, and the platforms limit caption requests. Make one request for each video, plus at most one follow-up after a list of tracks.
- Do not call `get_available_subtitles`, `get_video_info` or `get_raw_subtitles` before `get_transcript`.
- Do not request a second track or a translation. If the user wants another language, translate the text yourself.
- If a call fails, do not call again, except for the one follow-up after a list of tracks. Give the user the error text, which names the next step.
- If the user asks for something else, such as a specific track or tool, do what the user asks.
