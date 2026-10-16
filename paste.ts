// Clipboard HTML -> markdown, for pasting rendered chat output into a note.
//
// Copying a rendered message puts both text/html and text/plain on the
// clipboard. A textarea takes the plain text, and that loses the structure:
// list items arrive as bare lines with no "- " or "1. ", bold disappears, and
// the single newlines between items render as spaces — so a bulleted list
// comes back as one run-on paragraph. Rebuilding markdown from the HTML keeps
// what the note renderer needs.
//
// Deliberately small. The usual source is bb's own chat renderer, whose HTML is
// regular; anything without block structure (a phrase, a code editor's styled
// spans) is left to the browser's plain-text paste.

/** Only HTML with block structure is worth converting; the rest pastes as plain text. */
const STRUCTURAL = "ul, ol, p, h1, h2, h3, h4, h5, h6, pre, blockquote, table";

/** Interface chrome that shows up in a selection but is not content. */
const SKIPPED = new Set(["script", "style", "button", "svg", "template", "noscript"]);

/** Containers whose whitespace-only text nodes are just source formatting. */
const LAYOUT = new Set(["ul", "ol", "table", "thead", "tbody", "tfoot", "tr", "blockquote"]);

const BLOCK = (text: string) => `\n\n${text.trim()}\n\n`;

// Fenced code must come through byte-for-byte, but the cleanup that collapses
// block padding would also collapse blank lines inside it. So each fence is
// parked here during conversion and stands in the text as a one-line token.
// Reset per call; conversion is synchronous.
let fences: string[] = [];
const FENCE_TOKEN = /^(.*?)\uE000(\d+)\uE001$/gm;

/**
 * Markdown for a clipboard HTML payload, or null when it has no block
 * structure and the browser's own plain-text paste should run instead.
 */
export function htmlToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body.querySelector(STRUCTURAL)) return null;
  fences = [];
  const markdown = restoreFences(tidy(children(doc.body)));
  fences = [];
  return markdown.length > 0 ? markdown : null;
}

// A token's line prefix is the list indent or "> " it picked up on the way
// out, and every line of its fence needs it — except a list marker, which
// belongs to the first line only and becomes indent on the rest.
function restoreFences(markdown: string): string {
  return markdown.replace(FENCE_TOKEN, (_, prefix: string, index: string) => {
    const rest = prefix.replace(/(?:\d+[.)]|-)(?= )/g, (marker) => " ".repeat(marker.length));
    return fences[Number(index)]
      .split("\n")
      .map((line, i) => {
        const lead = i === 0 ? prefix : rest;
        return line ? lead + line : lead.trimEnd();
      })
      .join("\n");
  });
}

function children(node: Node): string {
  return Array.from(node.childNodes).map(convert).join("");
}

function convert(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text.trim() === "") {
      const parent = node.parentElement?.tagName.toLowerCase();
      return parent && LAYOUT.has(parent) ? "" : text.length > 0 ? " " : "";
    }
    // Whitespace collapses to spaces, so a text node's start is the only place
    // in prose where a line can begin.
    return escapeLineStart(escape(text.replace(/\s+/g, " ")));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIPPED.has(tag) || el.getAttribute("aria-hidden") === "true") return "";

  // bb renders thread ids and paths in chat as mention pills whose label is a
  // title, often truncated. The pill keeps its source text; as a code span the
  // note renderer turns it back into the same pill.
  const mention = el.getAttribute("data-prompt-mention-serialized-text");
  if (mention) return inlineCode(mention);

  switch (tag) {
    case "br":
      return "  \n";
    case "hr":
      return BLOCK("---");
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return BLOCK(`${"#".repeat(Number(tag[1]))} ${children(el).trim()}`);
    case "strong":
    case "b":
      // Google Docs wraps whole selections in <b style="font-weight:normal">.
      return /font-weight:\s*(normal|400)/.test(el.getAttribute("style") ?? "")
        ? children(el)
        : wrap(children(el), "**");
    case "em":
    case "i":
      return wrap(children(el), "*");
    case "del":
    case "s":
      return wrap(children(el), "~~");
    case "code":
      return inlineCode(el.textContent ?? "");
    case "pre":
      fences.push(fence(el));
      return BLOCK(`\uE000${fences.length - 1}\uE001`);
    case "a":
      return link(el);
    case "img":
      return escape(el.getAttribute("alt") ?? "");
    case "input":
      // Task-list items render their [ ] / [x] as a checkbox.
      if (el.getAttribute("type") !== "checkbox") return "";
      return (el as HTMLInputElement).checked || el.hasAttribute("checked") ? "[x] " : "[ ] ";
    case "blockquote":
      return BLOCK(
        tidy(children(el))
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      );
    case "ul":
    case "ol":
      return BLOCK(list(el));
    case "table":
      return BLOCK(table(el));
    case "p":
    case "div":
    case "section":
    case "article":
    case "header":
    case "footer":
    case "figure":
      return BLOCK(children(el));
    default:
      return children(el);
  }
}

/**
 * Wrap inline content in a marker, keeping the surrounding spaces outside it:
 * "** bold **" does not render as bold.
 */
function wrap(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  if (!match || match[2] === "") return content;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function inlineCode(text: string): string {
  if (text === "") return "";
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  // Markdown strips one space from each end of a code span when both ends have
  // one, so content that starts or ends with a backtick, or is space-wrapped,
  // gets an extra space of padding.
  const spaced = /^ [\s\S]* $/.test(text) && text.trim() !== "";
  const pad = text.startsWith("`") || text.endsWith("`") || spaced ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function fence(pre: Element): string {
  const code = pre.querySelector("code");
  const text = (code ?? pre).textContent?.replace(/\n$/, "") ?? "";
  const language = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(code?.className ?? "")?.[1] ?? "";
  // A closing fence may be indented up to three spaces, so those count too.
  const runs = text.match(/^ {0,3}`{3,}/gm) ?? [];
  const longest = Math.max(0, ...runs.map((run) => run.trimStart().length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${text}\n${ticks}`;
}

function link(el: Element): string {
  const text = children(el).trim();
  const href = el.getAttribute("href") ?? "";
  if (!/^(https?:|mailto:)/i.test(href)) return text;
  if (text === "" || text === href) return `<${href}>`;
  // encodeURIComponent leaves parentheses alone, and an unmatched one would end
  // the destination early.
  const destination = href.replace(/[()\s]/g, (char) =>
    char === "(" ? "%28" : char === ")" ? "%29" : encodeURIComponent(char),
  );
  return `[${text}](${destination})`;
}

function list(el: Element): string {
  const ordered = el.tagName.toLowerCase() === "ol";
  let number = Number(el.getAttribute("start") ?? "1") || 1;
  const items = Array.from(el.children).filter((child) => child.tagName.toLowerCase() === "li");
  return items
    .map((item) => {
      const marker = ordered ? `${number++}. ` : "- ";
      const content = tidy(listItem(item));
      // Continuation lines (wrapped paragraphs, nested lists, code) sit under
      // the item's text, not under its marker.
      const indent = " ".repeat(marker.length);
      return marker + content.split("\n").map((line, i) => (i === 0 || !line ? line : indent + line)).join("\n");
    })
    .join("\n");
}

// A nested list follows its parent item's text on the next line, not after a
// blank one: a blank line there turns the whole outer list "loose".
function listItem(item: Element): string {
  return Array.from(item.childNodes)
    .map((child) => {
      const tag = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName.toLowerCase() : "";
      return tag === "ul" || tag === "ol" ? `\n${list(child as Element)}\n` : convert(child);
    })
    .join("");
}

// A table row is one line, so a code block in a cell becomes inline code. Done
// here because the row's "| " prefix would keep restoreFences from seeing it.
function tableCell(content: string): string {
  return content
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) =>
      inlineCode(fences[Number(index)].split("\n").slice(1, -1).join(" ")),
    )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll("tr")).map((row) =>
    Array.from(row.children)
      .filter((cell) => /^t[hd]$/i.test(cell.tagName))
      .map((cell) => tableCell(children(cell))),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

// Characters that would otherwise turn copied prose into markup. Underscores
// only at word edges: GFM ignores intra-word ones, and ids like thr_abc are
// common in agent output.
function escape(text: string): string {
  return text
    .replace(/([\\`*[\]<])/g, "\\$1")
    .replace(/(^|\W)_|_(?=\W|$)/g, (match) => match.replace("_", "\\_"));
}

// Text that would open a block if it began a line: a heading, quote, list
// item, rule or setext underline. ("*" is already escaped above.) Escaping one
// that turns out to be mid-line is harmless; it renders the same.
function escapeLineStart(text: string): string {
  return text.replace(
    /^(\s*)(?:(\d+)(?=[.)](?:\s|$))|(#{1,6}(?=\s|$)|>|[-+=](?=[\s+=-]|$)))/,
    (_, lead: string, digits?: string, marker?: string) =>
      digits ? `${lead}${digits}\\` : `${lead}\\${marker}`,
  );
}

/** Collapse the padding blocks leave between them, and drop blank-ish lines. */
function tidy(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
