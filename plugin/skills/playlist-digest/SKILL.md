---
name: playlist-digest
description: Make one digest from the transcripts of several videos in a playlist. Use when the user gives a playlist link, or a video link with a list= parameter, and asks for a digest, a summary or the main points of the videos in it.
---

# Digest a playlist

1. Find the language of the videos. Use the language that the user named. If the user did not name one, ask the user one short question before you call a tool. The playlist tool needs a language code, such as `en` or `ru`.
2. Find the videos that the user wants. If the user named a number, such as "the first 3", pass `playlistItems` as `1:3`. If the user did not name a number, pass `maxItems` as `5` and tell the user that the digest covers the first 5 videos.
3. Call `get_playlist_transcripts` one time with `url`, `lang` and the item selection from step 2. Pass `type` only if the user asked for official or automatic captions.
4. Write one digest. The answer gives each video as its ID and its text. Give each video a short part, then the points that the videos share.
5. If fewer videos came back than you selected, say so in the digest. Do not fetch the missing videos one by one.
6. If no video came back, the answer names one next step. Give the user that text, and do not call again.

## Rules

- Each video in the playlist is a caption request, and the platforms limit caption requests. Do not select more videos than the user asked for.
- Do not call `get_transcript` for each video before or after `get_playlist_transcripts`.
- If the call fails, do not call again. Give the user the error text, which names the next step.
- If the user asks for something else, such as more videos or a single video, do what the user asks.
