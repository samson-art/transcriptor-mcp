---
name: video-frame
description: Show a still frame of a video at a given time. Use when the user gives a video link or a YouTube video ID and asks to see the picture, the frame, the slide or the screen at a time such as 4:12.
---

# Show the frame at a time

1. Read the time from the request. Pass it as `timecode` in the form `MM:SS` or `HH:MM:SS`, for example `04:12`. If the user gave seconds, pass `seconds`. If the user gave no time, pass nothing. The tool then returns the first frame.
2. Call `get_video_frame` one time with `url` and the time.
3. Show the image. Say the time of the frame.
4. If the user asks for the moment when something is said, and not for a time, find the time first. Call `get_raw_subtitles` one time, find the cue, and use its start time in step 2.

## Rules

- `get_video_frame` makes no caption request. Do not fetch the transcript to show a frame at a time that the user gave.
- If the time is after the end of the video, the call fails. Do not try other times. Give the user the error text.
- If a call fails, do not call again. Give the user the error text, which names the next step.
- If the user asks for something else, such as several frames, do what the user asks.
