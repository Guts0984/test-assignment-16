import { type ReactNode } from 'react';

export const Table = ({
  head,
  children,
  caption,
}: {
  head: readonly string[];
  children: ReactNode;
  caption?: string;
}) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-sm">
      {caption !== undefined && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              scope="col"
              className="border-b border-[var(--line)] px-2 py-2 text-left font-medium text-[var(--muted)]"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="[&_td]:border-b [&_td]:border-[var(--line)] [&_td]:px-2 [&_td]:py-2">
        {children}
      </tbody>
    </table>
  </div>
);
