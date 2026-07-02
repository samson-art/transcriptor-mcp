import React from 'react';
import { formatDuration, formatViews } from './format.js';
import { styles } from './styles.js';
import type { VideoMeta } from './types.js';

type VideoCarouselCardProps = {
  video: VideoMeta;
  isActive: boolean;
  onClick: () => void;
};

export function VideoCarouselCard({ video, isActive, onClick }: VideoCarouselCardProps) {
  return (
    <li style={styles.cardItem}>
      <button
        type="button"
        style={{
          ...styles.card,
          ...(isActive ? styles.cardActive : {}),
        }}
        onClick={onClick}
      >
        <div style={styles.thumbWrap}>
          {video.thumbnail ? (
            <img src={video.thumbnail} alt="" style={styles.thumb} />
          ) : (
            <div style={styles.thumbPlaceholder}>▶</div>
          )}
          {video.duration != null && (
            <span style={styles.duration}>{formatDuration(video.duration)}</span>
          )}
        </div>
        <div style={styles.cardBody}>
          <div style={styles.title}>{video.title ?? 'Untitled'}</div>
          <div style={styles.meta}>{video.uploader ?? 'Unknown channel'}</div>
          {video.viewCount != null && <div style={styles.meta}>{formatViews(video.viewCount)}</div>}
        </div>
      </button>
    </li>
  );
}
