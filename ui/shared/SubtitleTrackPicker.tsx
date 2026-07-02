import React, { useMemo } from 'react';
import { styles } from './styles.js';
import type { AvailableSubtitleTracks, SubtitleTrack } from './subtitleTracks.js';
import { sortAutoLanguages, tracksEqual } from './subtitleTracks.js';

type SubtitleTrackPickerProps = {
  tracks: AvailableSubtitleTracks;
  selected: SubtitleTrack | null;
  onSelect: (track: SubtitleTrack) => void;
  disabled?: boolean;
};

function OfficialTrackGroup({
  langs,
  selected,
  onSelect,
  disabled,
}: {
  langs: string[];
  selected: SubtitleTrack | null;
  onSelect: (track: SubtitleTrack) => void;
  disabled?: boolean;
}) {
  if (langs.length === 0) return null;

  return (
    <div style={styles.trackGroup}>
      <span style={styles.trackGroupLabel}>Official</span>
      <div style={styles.trackPills}>
        {langs.map((lang) => {
          const track: SubtitleTrack = { type: 'official', lang };
          const isActive = tracksEqual(selected, track);
          return (
            <button
              key={`official-${lang}`}
              type="button"
              style={{
                ...styles.trackPill,
                ...(isActive ? styles.trackPillActive : {}),
              }}
              disabled={disabled}
              onClick={() => onSelect(track)}
            >
              {lang}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AutoTrackSelect({
  langs,
  selected,
  onSelect,
  disabled,
}: {
  langs: string[];
  selected: SubtitleTrack | null;
  onSelect: (track: SubtitleTrack) => void;
  disabled?: boolean;
}) {
  const sortedLangs = useMemo(() => sortAutoLanguages(langs), [langs]);
  if (sortedLangs.length === 0) return null;

  const value = selected?.type === 'auto' ? selected.lang : '';

  return (
    <div style={styles.trackGroup}>
      <span style={styles.trackGroupLabel}>Auto</span>
      <select
        value={value}
        disabled={disabled}
        style={styles.trackSelect}
        onChange={(e) => {
          const lang = e.target.value;
          if (lang) onSelect({ type: 'auto', lang });
        }}
      >
        <option value="">Select language…</option>
        {sortedLangs.map((lang) => (
          <option key={lang} value={lang}>
            {lang}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SubtitleTrackPicker({
  tracks,
  selected,
  onSelect,
  disabled,
}: SubtitleTrackPickerProps) {
  return (
    <div style={styles.trackPicker}>
      <OfficialTrackGroup
        langs={tracks.official}
        selected={selected}
        onSelect={onSelect}
        disabled={disabled}
      />
      <AutoTrackSelect
        langs={tracks.auto}
        selected={selected}
        onSelect={onSelect}
        disabled={disabled}
      />
    </div>
  );
}
