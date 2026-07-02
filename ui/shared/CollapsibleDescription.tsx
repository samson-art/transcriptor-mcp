import React, { useMemo, useState } from 'react';
import { styles } from './styles.js';

const DESCRIPTION_CLAMP_LINES = 3;
const LONG_DESCRIPTION_THRESHOLD = 180;

type CollapsibleDescriptionProps = {
  description: string;
};

export function CollapsibleDescription({ description }: CollapsibleDescriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = description.trim();
  const isLong = useMemo(
    () => trimmed.length > LONG_DESCRIPTION_THRESHOLD || trimmed.split('\n').length > DESCRIPTION_CLAMP_LINES,
    [trimmed]
  );

  if (!trimmed) return null;

  return (
    <div style={styles.descriptionWrap}>
      <div
        style={{
          ...styles.descriptionText,
          ...(isLong && !expanded ? styles.descriptionTextClamped : {}),
        }}
      >
        {trimmed}
      </div>
      {isLong && (
        <button
          type="button"
          style={styles.descriptionToggle}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
