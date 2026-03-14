import type { ReactNode } from "react";
import { normalizeTextLines } from "@/lib/utils";

type MarkdownRendererProps = {
  content: string;
};

/* ────────────────────────────────────────────────
 * Lightweight markdown → React renderer.
 *
 * Replaces react-markdown + remark-gfm (~540KB) with a
 * ~3KB inline renderer that handles the subset of markdown
 * used in chat messages: paragraphs, headings, lists,
 * code blocks, inline formatting, links, blockquotes,
 * and GFM tables.
 * ──────────────────────────────────────────────── */

// Inline formatting: bold, italic, inline code, links
function renderInline(text: string): (string | ReactNode)[] {
  const parts: (string | ReactNode)[] = [];
  // Process inline patterns with a single regex scan
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Push text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Inline code
      const code = match[1].slice(1, -1);
      parts.push(<code key={match.index} className="chat-markdown-inline-code">{code}</code>);
    } else if (match[2]) {
      // Bold
      const bold = match[2].slice(2, -2);
      parts.push(<strong key={match.index} className="chat-markdown-strong">{bold}</strong>);
    } else if (match[3]) {
      // Italic *text*
      const em = match[3].slice(1, -1);
      parts.push(<em key={match.index} className="cme">{em}</em>);
    } else if (match[4]) {
      // Italic _text_
      const em = match[4].slice(1, -1);
      parts.push(<em key={match.index} className="cme">{em}</em>);
    } else if (match[5]) {
      // Link [text](url)
      parts.push(
        <a key={match.index} href={match[7]} target="_blank" rel="noopener noreferrer" className="chat-markdown-link">
          {match[6]}
        </a>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Push remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

// Parse a GFM table block (array of lines starting with |)
function renderTable(lines: string[], keyBase: number): ReactNode {
  const parseRow = (line: string) =>
    line.split("|").slice(1, -1).map((cell) => cell.trim());

  const headerCells = parseRow(lines[0]);
  // lines[1] is the separator (|---|---|)
  const bodyLines = lines.slice(2);

  return (
    <div key={keyBase} className="chat-table-wrap">
      <table className="chat-table">
        <thead className="chat-markdown-thead">
          <tr>
            {headerCells.map((cell, i) => (
              <th key={i}>{renderInline(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyLines.map((line, ri) => {
            const cells = parseRow(line);
            return (
              <tr key={ri}>
                {cells.map((cell, ci) => (
                  <td key={ci}>{renderInline(cell)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const normalized = normalizeTextLines(content);
  if (!normalized) {
    return <span className="chat-empty">No output.</span>;
  }

  const lines = normalized.split("\n");
  const elements: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} className="chat-markdown-code-block">
          <code className={lang ? `chat-markdown-fenced-code language-${lang}` : "chat-markdown-fenced-code"}>
            {codeLines.join("\n")}
          </code>
        </pre>
      );
      continue;
    }

    // GFM table (starts with |, next line is separator)
    if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s:]*-+/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(renderTable(tableLines, elements.length));
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4;
      const Tag = `h${level}` as const;
      elements.push(
        <Tag key={elements.length} className={`chat-markdown-heading chat-markdown-heading-${level}`}>
          {renderInline(headingMatch[2])}
        </Tag>
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <blockquote key={elements.length} className="chat-markdown-blockquote">
          {quoteLines.map((ql, qi) => (
            <p key={qi} className="cmp">{renderInline(ql)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s/, ""));
        i++;
      }
      elements.push(
        <ul key={elements.length} className="cml chat-markdown-list-unordered">
          {items.map((item, ii) => (
            <li key={ii} className="cli">{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      elements.push(
        <ol key={elements.length} className="cml chat-markdown-list-ordered">
          {items.map((item, ii) => (
            <li key={ii} className="cli">{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (default)
    elements.push(
      <p key={elements.length} className="cmp">{renderInline(line)}</p>
    );
    i++;
  }

  return <div className="chat-markdown">{elements}</div>;
}
