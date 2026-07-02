import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCueTime } from './format.js';
import { highlightCueText } from './highlight.js';
import { SubtitleTrackPicker } from './SubtitleTrackPicker.js';
import { hasAvailableTracks } from './subtitleTracks.js';
import type { AvailableSubtitleTracks, SubtitleTrack } from './subtitleTracks.js';
import { styles } from './styles.js';
import type { Cue, CuesStatus, VideoMeta } from './types.js';

type SubtitlesPanelProps = {
  cues: Cue[];
  status: CuesStatus;
  video: VideoMeta;
  onOpenAtTime: (seconds: number) => void;
  onLoadSubtitles?: () => void;
  onLoadMore?: () => void;
  isTruncated?: boolean;
  loadingMore?: boolean;
  availableTracks?: AvailableSubtitleTracks | null;
  selectedTrack?: SubtitleTrack | null;
  onTrackSelect?: (track: SubtitleTrack) => void;
  tracksLoading?: boolean;
};

export function SubtitlesPanel({
  cues,
  status,
  video,
  onOpenAtTime,
  onLoadSubtitles,
  onLoadMore,
  isTruncated,
  loadingMore,
  availableTracks,
  selectedTrack,
  onTrackSelect,
  tracksLoading,
}: SubtitlesPanelProps) {
  const [subtitleSearch, setSubtitleSearch] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const cueItemRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  const showTrackPicker =
    hasAvailableTracks(availableTracks ?? null) &&
    (status === 'idle' ||
      status === 'loading' ||
      status === 'ready' ||
      status === 'error') &&
    onTrackSelect;

  const matchingCueIndices = useMemo(() => {
    const query = subtitleSearch.trim().toLowerCase();
    if (!query) return [];
    return cues.reduce<number[]>((indices, cue, index) => {
      if (cue.text.toLowerCase().includes(query)) indices.push(index);
      return indices;
    }, []);
  }, [cues, subtitleSearch]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [subtitleSearch, video.videoId]);

  useEffect(() => {
    if (matchingCueIndices.length === 0) return;
    const cueIndex = matchingCueIndices[activeMatchIndex % matchingCueIndices.length];
    const element = cueItemRefs.current.get(cueIndex);
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [matchingCueIndices, activeMatchIndex]);

  const handleSubtitleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter' || matchingCueIndices.length === 0) return;
      event.preventDefault();
      setActiveMatchIndex((prev) => (prev + 1) % matchingCueIndices.length);
    },
    [matchingCueIndices.length]
  );

  return (
    <div style={styles.subtitlesSection}>
      {showTrackPicker && availableTracks && (
        <SubtitleTrackPicker
          tracks={availableTracks}
          selected={selectedTrack ?? null}
          onSelect={onTrackSelect}
          disabled={tracksLoading || status === 'loading'}
        />
      )}
      {tracksLoading && !hasAvailableTracks(availableTracks ?? null) && (
        <div style={styles.subtitlesMessage}>Loading languages…</div>
      )}
      {status === 'ready' && (
        <div style={styles.subtitleSearchRow}>
          <input
            type="search"
            placeholder="Search subtitles…"
            value={subtitleSearch}
            onChange={(e) => setSubtitleSearch(e.target.value)}
            onKeyDown={handleSubtitleSearchKeyDown}
            style={styles.subtitleSearchInput}
          />
          {subtitleSearch.trim() && (
            <span style={styles.subtitleMatchCount}>
              {matchingCueIndices.length === 0
                ? '0'
                : `${(activeMatchIndex % matchingCueIndices.length) + 1}/${matchingCueIndices.length}`}
            </span>
          )}
        </div>
      )}
      <div style={styles.subtitlesPanel}>
        {status === 'loading' && <div style={styles.subtitlesMessage}>Loading subtitles…</div>}
        {status === 'idle' && onLoadSubtitles && (
          <div style={styles.loadSubtitlesRow}>
            <button type="button" style={styles.loadMoreBtn} onClick={onLoadSubtitles}>
              Load subtitles
            </button>
          </div>
        )}
        {(status === 'empty' || status === 'error') && (
          <div style={styles.loadSubtitlesRow}>
            <div style={styles.subtitlesMessage}>No subtitles available.</div>
            {onLoadSubtitles && (
              <button type="button" style={styles.loadMoreBtn} onClick={onLoadSubtitles}>
                Retry
              </button>
            )}
          </div>
        )}
        {status === 'ready' && (
          <ul style={styles.cuesList}>
            {cues.map((cue, index) => {
              const isMatch = matchingCueIndices.includes(index);
              const isActiveMatch =
                isMatch &&
                matchingCueIndices[activeMatchIndex % matchingCueIndices.length] === index;
              return (
                <li
                  key={`${cue.start}-${index}`}
                  ref={(el) => {
                    if (el) cueItemRefs.current.set(index, el);
                    else cueItemRefs.current.delete(index);
                  }}
                  style={{
                    ...styles.cueItem,
                    ...(isActiveMatch ? styles.cueItemActive : {}),
                    ...(subtitleSearch.trim() && !isMatch ? styles.cueItemDimmed : {}),
                  }}
                >
                  <button
                    type="button"
                    style={styles.cueTime}
                    onClick={() => onOpenAtTime(cue.start)}
                    title={`Open at ${formatCueTime(cue.start)}`}
                  >
                    {formatCueTime(cue.start)}
                  </button>
                  <span style={styles.cueText}>{highlightCueText(cue.text, subtitleSearch)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {isTruncated && onLoadMore && (
        <div style={styles.loadMoreRow}>
          <button
            type="button"
            style={styles.loadMoreBtn}
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
