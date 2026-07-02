import React from 'react';
import { formatDuration, formatViews } from './format.js';
import { styles } from './styles.js';
import type { VideoMeta } from './types.js';

type VideoDetailPanelProps = {
  video: VideoMeta;
  onOpen: () => void;
  onClose?: () => void;
  children?: React.ReactNode;
};

export function VideoDetailPanel({ video, onOpen, onClose, children }: VideoDetailPanelProps) {
  return (
    <div style={styles.detailWrap}>
      <div style={styles.detailThumbWrap}>
        {video.thumbnail ? (
          <img src={video.thumbnail} alt="" style={styles.detailThumb} />
        ) : (
          <div style={styles.detailThumbPlaceholder}>▶</div>
        )}
      </div>
      <div style={styles.detailBody}>
        <div style={styles.detailTitle}>{video.title ?? 'Untitled'}</div>
        <div style={styles.detailMeta}>{video.uploader ?? 'Unknown channel'}</div>
        <div style={styles.detailMeta}>
          {[formatViews(video.viewCount), formatDuration(video.duration)]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <div style={styles.detailActions}>
        <button type="button" style={styles.actionBtn} onClick={onOpen}>
          Open
        </button>
        {onClose && (
          <button type="button" style={styles.actionBtn} onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
