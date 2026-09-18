import React, { useState } from 'react';
import { formatDuration, formatViews } from './format.js';
import { styles } from './styles.js';
import type { VideoMeta } from './types.js';

type VideoDetailPanelProps = {
  video: VideoMeta;
  onOpen?: () => void;
  onClose?: () => void;
  children?: React.ReactNode;
};

export function VideoDetailPanel({ video, onOpen, onClose, children }: VideoDetailPanelProps) {
  // Platform thumbnails are signed and expire (Instagram in days, TikTok in hours),
  // and an old result is re-rendered with its old URL: fall back to the placeholder.
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);
  const thumbnail = video.thumbnail && video.thumbnail !== brokenThumb ? video.thumbnail : null;

  return (
    <div style={styles.detailWrap}>
      <div style={styles.detailThumbWrap}>
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            style={styles.detailThumb}
            // Bilibili's CDN answers 403 to a foreign Referer; none is what the CSP survey tested.
            referrerPolicy="no-referrer"
            onError={() => setBrokenThumb(thumbnail)}
          />
        ) : (
          <div style={styles.detailThumbPlaceholder}>▶</div>
        )}
      </div>
      <div style={styles.detailBody}>
        <div style={styles.detailTitle}>{video.title ?? 'Untitled'}</div>
        {video.uploader && <div style={styles.detailMeta}>{video.uploader}</div>}
        <div style={styles.detailMeta}>
          {[formatViews(video.viewCount), formatDuration(video.duration)]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {(onOpen || onClose) && (
        <div style={styles.detailActions}>
          {onOpen && (
            <button type="button" style={styles.actionBtn} onClick={onOpen}>
              Open
            </button>
          )}
          {onClose && (
            <button type="button" style={styles.actionBtn} onClick={onClose}>
              Close
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
