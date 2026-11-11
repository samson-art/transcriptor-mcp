import type { App } from '@modelcontextprotocol/ext-apps';
import React from 'react';
import { humanTimes, splitLinks } from './links.js';

/**
 * A text of the server with its https addresses as links and its UTC timestamps as local
 * dates and times (#106). The link opens through
 * the host, which asks the user first; a plain `target="_blank"` does not leave the
 * sandbox of the widget on every host.
 */
export function LinkedText({ text, app }: { text: string; app: App | null }) {
  return (
    <>
      {splitLinks(text).map((part, i) =>
        part.href ? (
          <a
            key={i}
            href={part.href}
            style={{ color: 'inherit', textDecoration: 'underline', wordBreak: 'break-all' }}
            onClick={(event) => {
              event.preventDefault();
              const url = part.href as string;
              if (app) void app.openLink({ url });
              else globalThis.open(url, '_blank', 'noopener,noreferrer');
            }}
          >
            {part.text}
          </a>
        ) : (
          humanTimes(part.text)
        )
      )}
    </>
  );
}
